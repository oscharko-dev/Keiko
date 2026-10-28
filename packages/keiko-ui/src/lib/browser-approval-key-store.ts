"use client";

import {
  BROWSER_APPROVAL_VERSION,
  isBrowserApprovalDescriptor,
  isBrowserApprovalOrigin,
  type BrowserApprovalDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { isBrowserApprovalPrivateKey } from "./browser-approval-crypto";
import { observeBrowserApproval } from "./browser-approval-evidence";
import { reportClientDiagnostic } from "./client-diagnostics";
import { clientErrorEvidence } from "./client-error-evidence";
import { bffRequestErrorKind } from "./http";

const DATABASE = "keiko-browser-approval";
const STORE = "keys";
const ACTIVE = "active";
const INTENT = "persistence-intent";
const TIMEOUT_MS = 15_000;
const RECORD_FIELDS = new Set([
  "schemaVersion",
  "privateKey",
  "approval",
  "installationId",
  "origin",
]);

export interface RememberedBrowserApproval {
  readonly schemaVersion: typeof BROWSER_APPROVAL_VERSION;
  readonly privateKey: CryptoKey;
  readonly approval: BrowserApprovalDescriptor;
  readonly installationId: string;
  readonly origin: string;
}

export interface BrowserApprovalKeyStore {
  readonly prepare: (parentCorrelationId?: string) => Promise<string>;
  readonly load: (parentCorrelationId?: string) => Promise<RememberedBrowserApproval | undefined>;
  readonly save: (
    record: RememberedBrowserApproval,
    intent: string,
    parentCorrelationId?: string,
  ) => Promise<void>;
  readonly forget: (parentCorrelationId?: string) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRecord(value: unknown, origin: string): value is RememberedBrowserApproval {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !RECORD_FIELDS.has(key))) return false;
  return (
    value.schemaVersion === BROWSER_APPROVAL_VERSION &&
    isBrowserApprovalPrivateKey(value.privateKey) &&
    isBrowserApprovalDescriptor(value.approval) &&
    value.approval.remembered &&
    value.origin === origin &&
    typeof value.installationId === "string" &&
    /^[a-f0-9]{32}$/u.test(value.installationId)
  );
}

function openDatabase(factory: IDBFactory | undefined): Promise<IDBDatabase> {
  const available = factory ?? globalThis.indexedDB;
  if (available === undefined)
    return Promise.reject(
      new DOMException("Browser key storage is unavailable.", "NotSupportedError"),
    );
  return new Promise((resolve, reject): void => {
    const request = available.open(DATABASE, 1);
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(
      (): void => fail(new DOMException("Browser key storage timed out.", "TimeoutError")),
      TIMEOUT_MS,
    );
    request.onblocked = (): void =>
      fail(new DOMException("Browser key storage is blocked.", "InvalidStateError"));
    request.onerror = (): void =>
      fail(request.error ?? new DOMException("Browser key storage failed.", "UnknownError"));
    request.onupgradeneeded = (): void => {
      if (settled) {
        request.transaction?.abort();
        return;
      }
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = (): void => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      const database = request.result;
      database.onversionchange = (): void => database.close();
      resolve(database);
    };
  });
}

function rejectTransaction(
  transaction: IDBTransaction,
  reject: (error: unknown) => void,
  reason: unknown,
): void {
  try {
    transaction.abort();
  } catch (error) {
    reportClientDiagnostic("Browser key transaction abort failed.", {
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
  }
  reject(reason);
}

async function transact(
  factory: IDBFactory | undefined,
  mode: IDBTransactionMode,
  apply: (
    store: IDBObjectStore,
    capture: (value: unknown) => void,
    fail: (error: unknown) => void,
  ) => void,
): Promise<unknown> {
  const database = await openDatabase(factory);
  try {
    return await new Promise((resolve, reject): void => {
      const transaction = database.transaction(STORE, mode);
      let value: unknown;
      const timer = setTimeout(
        (): void =>
          rejectTransaction(
            transaction,
            reject,
            new DOMException("Browser key transaction timed out.", "TimeoutError"),
          ),
        TIMEOUT_MS,
      );
      transaction.oncomplete = (): void => {
        clearTimeout(timer);
        resolve(value);
      };
      transaction.onabort = transaction.onerror = (): void => {
        clearTimeout(timer);
        reject(
          transaction.error ?? new DOMException("Browser key transaction aborted.", "AbortError"),
        );
      };
      apply(
        transaction.objectStore(STORE),
        (result): void => {
          value = result;
        },
        (error): void => {
          clearTimeout(timer);
          rejectTransaction(transaction, reject, error);
        },
      );
    });
  } finally {
    database.close();
  }
}

function loadKey(
  factory: IDBFactory | undefined,
  origin: string,
  parentCorrelationId?: string,
): Promise<RememberedBrowserApproval | undefined> {
  return observeBrowserApproval(
    "key-load",
    async () => {
      const record = await transact(factory, "readonly", (store, capture): void => {
        const request = store.get(ACTIVE);
        request.onsuccess = (): void => capture(request.result);
      });
      if (record === undefined) return { value: undefined, outcome: "missing" };
      if (!validRecord(record, origin) || record.approval.expiresAtMs <= Date.now())
        return { value: undefined, outcome: "unavailable" };
      return { value: record, outcome: "available" };
    },
    parentCorrelationId,
  );
}

function preparePersistence(
  factory: IDBFactory | undefined,
  parentCorrelationId?: string,
): Promise<string> {
  return observeBrowserApproval(
    "key-prepare",
    async () => {
      const intent = crypto.randomUUID();
      await transact(factory, "readwrite", (store): void => {
        store.put(intent, INTENT);
      });
      return { value: intent, outcome: "created" };
    },
    parentCorrelationId,
  );
}

function putCurrentKey(
  store: IDBObjectStore,
  fail: (error: unknown) => void,
  record: RememberedBrowserApproval,
  intent: string,
): void {
  const request = store.get(INTENT);
  request.onsuccess = (): void => {
    try {
      if (request.result !== intent)
        fail(new DOMException("Browser persistence intent changed.", "AbortError"));
      else store.put(record, ACTIVE);
    } catch (error) {
      reportClientDiagnostic("Browser key serialization failed.", {
        errorKind: bffRequestErrorKind(error),
        errorEvidence: clientErrorEvidence(error),
      });
      fail(error);
    }
  };
}

function saveKey(
  factory: IDBFactory | undefined,
  origin: string,
  record: RememberedBrowserApproval,
  intent: string,
  parentCorrelationId?: string,
): Promise<void> {
  return observeBrowserApproval(
    "key-store",
    async () => {
      if (
        !validRecord(record, origin) ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(intent)
      )
        throw new TypeError("Remembered browser approval is invalid.");
      await transact(factory, "readwrite", (store, _capture, abort): void =>
        putCurrentKey(store, abort, record, intent),
      );
      return { value: undefined, outcome: "stored" };
    },
    parentCorrelationId,
  );
}

function forgetKey(factory: IDBFactory | undefined, parentCorrelationId?: string): Promise<void> {
  return observeBrowserApproval(
    "key-forget",
    async () => {
      await transact(factory, "readwrite", (store): void => {
        store.delete(ACTIVE);
        store.delete(INTENT);
      });
      return { value: undefined, outcome: "forgotten" };
    },
    parentCorrelationId,
  );
}

/** One origin-local nonextractable key, stored only after an explicit remembered approval. */
export function createBrowserApprovalKeyStore(
  origin: string,
  factory?: IDBFactory,
): BrowserApprovalKeyStore {
  if (!isBrowserApprovalOrigin(origin)) throw new TypeError("Browser approval origin is invalid.");
  return {
    prepare: (parent) => preparePersistence(factory, parent),
    load: (parent) => loadKey(factory, origin, parent),
    save: (record, intent, parent) => saveKey(factory, origin, record, intent, parent),
    forget: (parent) => forgetKey(factory, parent),
  };
}
