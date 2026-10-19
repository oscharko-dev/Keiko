import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserApprovalKey } from "./browser-approval-crypto";
import {
  createBrowserApprovalKeyStore,
  type RememberedBrowserApproval,
} from "./browser-approval-key-store";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";

const INTENT = "12345678-1234-1234-1234-123456789abc";

interface EventPort {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
  onupgradeneeded: (() => void) | null;
  readonly error: DOMException;
}

interface StoragePorts {
  readonly open: EventPort;
  readonly read: { result: unknown; onsuccess: (() => void) | null };
  readonly tx: {
    oncomplete: (() => void) | null;
    onabort: (() => void) | null;
    onerror: (() => void) | null;
  };
  readonly put: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
  readonly upgradeAbort: ReturnType<typeof vi.fn>;
}

function storagePorts(): StoragePorts {
  const read: { result: unknown; onsuccess: (() => void) | null } = {
    result: INTENT,
    onsuccess: null,
  };
  const put = vi.fn();
  const abort = vi.fn();
  const close = vi.fn();
  const upgradeAbort = vi.fn();
  const tx: StoragePorts["tx"] = {
    oncomplete: null,
    onabort: null,
    onerror: null,
  };
  const transaction = {
    ...tx,
    abort,
    error: new DOMException("Aborted", "AbortError"),
    objectStore: vi.fn(() => ({ get: vi.fn(() => read), put, delete: vi.fn() })),
  };
  abort.mockImplementation((): void => {
    queueMicrotask((): void => transaction.onabort?.());
  });
  const database = {
    transaction: vi.fn(() => transaction),
    close,
    objectStoreNames: { contains: (): boolean => true },
    createObjectStore: vi.fn(),
    onversionchange: null,
  };
  const open = {
    onsuccess: null,
    onerror: null,
    onblocked: null,
    onupgradeneeded: null,
    error: new DOMException("Open failed", "UnknownError"),
    result: database,
    transaction: { abort: upgradeAbort },
  };
  vi.stubGlobal("indexedDB", { open: vi.fn(() => open) });
  return { open, read, tx: transaction, put, close, abort, upgradeAbort };
}

async function remembered(): Promise<RememberedBrowserApproval> {
  const key = await createBrowserApprovalKey();
  const now = Date.now();
  return {
    schemaVersion: 1,
    privateKey: key.privateKey,
    installationId: "a".repeat(32),
    origin: location.origin,
    approval: {
      approvalId: `bra_${"b".repeat(32)}`,
      remembered: true,
      approvedAtMs: now,
      lastUsedAtMs: now,
      expiresAtMs: now + 60_000,
      publicKeyFingerprint: "c".repeat(64),
    },
  };
}

async function opened(h: ReturnType<typeof storagePorts>): Promise<void> {
  h.open.onsuccess?.();
  await Promise.resolve();
}

describe("browser key storage transaction owner", () => {
  beforeEach(async () => {
    const key = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("CryptoKey", key.privateKey.constructor);
    setClientDiagnosticWriter(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetClientDiagnosticWriter();
  });

  it("waits for transaction commit before reporting a saved key", async () => {
    const h = storagePorts();
    const record = await remembered();
    let settled = false;
    const operation = createBrowserApprovalKeyStore(location.origin)
      .save(record, INTENT)
      .then(() => {
        settled = true;
      });
    await opened(h);
    h.read.onsuccess?.();
    expect(h.put).toHaveBeenCalledWith(record, "active");
    await Promise.resolve();
    expect(settled).toBe(false);
    h.tx.oncomplete?.();
    await operation;
    expect(settled).toBe(true);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it.each(["onabort", "onerror"] as const)(
    "refuses %s after the put and never emits a stored outcome",
    async (event) => {
      const h = storagePorts();
      const records: unknown[] = [];
      setClientDiagnosticWriter((message, meta) => records.push({ message, meta }));
      const operation = createBrowserApprovalKeyStore(location.origin).save(
        await remembered(),
        INTENT,
      );
      const observed = operation.then(
        () => "saved",
        () => "rejected",
      );
      await opened(h);
      h.read.onsuccess?.();
      expect(h.put).toHaveBeenCalledOnce();
      h.tx[event]?.();
      expect(await observed).toBe("rejected");
      expect(h.close).toHaveBeenCalledOnce();
      expect(JSON.stringify(records)).not.toContain('"outcome":"stored"');
    },
  );

  it("loads only after the read transaction commits", async () => {
    const h = storagePorts();
    const record = await remembered();
    h.read.result = record;
    const operation = createBrowserApprovalKeyStore(location.origin).load();
    await opened(h);
    h.read.onsuccess?.();
    h.tx.oncomplete?.();
    await expect(operation).resolves.toEqual(record);
  });

  it.each(["origin", "version", "privateKey", "remembered", "extra", "expired"])(
    "refuses a stored record with invalid %s",
    async (invalid) => {
      const h = storagePorts();
      const record = await remembered();
      const changed: Record<string, unknown> = { ...record };
      if (invalid === "origin") changed.origin = "http://127.0.0.1:1984";
      if (invalid === "version") changed.schemaVersion = 2;
      if (invalid === "privateKey") changed.privateKey = { type: "private", extractable: false };
      if (invalid === "remembered") changed.approval = { ...record.approval, remembered: false };
      if (invalid === "extra") changed.rawKey = "PRIVATE_KEY_CANARY";
      if (invalid === "expired")
        changed.approval = {
          ...record.approval,
          approvedAtMs: Date.now() - 2_000,
          lastUsedAtMs: Date.now() - 2_000,
          expiresAtMs: Date.now() - 1_000,
        };
      h.read.result = changed;
      const operation = createBrowserApprovalKeyStore(location.origin).load();
      await opened(h);
      h.read.onsuccess?.();
      h.tx.oncomplete?.();
      await expect(operation).resolves.toBeUndefined();
    },
  );

  it("rejects invalid records before opening storage and keeps origin validation explicit", async () => {
    const h = storagePorts();
    const record = await remembered();
    await expect(
      createBrowserApprovalKeyStore(location.origin).save(
        {
          ...record,
          origin: "http://127.0.0.1:1984",
        },
        INTENT,
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(h.put).not.toHaveBeenCalled();
    expect(() => createBrowserApprovalKeyStore("https://remote.invalid")).toThrow(TypeError);
  });

  it("closes a late opened database after a blocked request already refused", async () => {
    const h = storagePorts();
    const operation = createBrowserApprovalKeyStore(location.origin).load();
    const observed = operation.then(
      () => "loaded",
      () => "rejected",
    );
    h.open.onblocked?.();
    expect(await observed).toBe("rejected");
    h.open.onupgradeneeded?.();
    expect(h.upgradeAbort).toHaveBeenCalledOnce();
    h.open.onsuccess?.();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("bounds opening and closes a database arriving after the deadline", async () => {
    vi.useFakeTimers();
    const h = storagePorts();
    const operation = createBrowserApprovalKeyStore(location.origin).load();
    const observed = operation.then(
      () => "loaded",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await observed).toMatchObject({ name: "TimeoutError" });
    h.open.onsuccess?.();
    expect(h.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a stalled transaction at its deadline without claiming a saved record", async () => {
    const record = await remembered();
    vi.useFakeTimers();
    const h = storagePorts();
    const operation = createBrowserApprovalKeyStore(location.origin).save(record, INTENT);
    const observed = operation.then(
      () => "saved",
      (error: unknown) => error,
    );
    await opened(h);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await observed).toMatchObject({ name: "TimeoutError" });
    expect(h.abort).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("requires committed deletion before forgetting and tolerates a missing local record", async () => {
    const h = storagePorts();
    const operation = createBrowserApprovalKeyStore(location.origin).forget();
    await opened(h);
    h.tx.oncomplete?.();
    await expect(operation).resolves.toBeUndefined();
    h.read.result = undefined;
    const load = createBrowserApprovalKeyStore(location.origin).load();
    await opened(h);
    h.read.onsuccess?.();
    h.tx.oncomplete?.();
    await expect(load).resolves.toBeUndefined();
  });

  it("prepares an opaque persistence intent only after its transaction commits", async () => {
    const h = storagePorts();
    const records: unknown[] = [];
    setClientDiagnosticWriter((message, meta) => records.push({ message, meta }));
    const operation = createBrowserApprovalKeyStore(location.origin).prepare();
    await opened(h);
    expect(h.put).toHaveBeenCalledWith(expect.any(String), "persistence-intent");
    h.tx.oncomplete?.();
    const intent = await operation;
    expect(intent).toMatch(/^[a-f0-9-]{36}$/u);
    expect(JSON.stringify(records)).not.toContain(intent);
  });

  it.each([undefined, "87654321-1234-1234-1234-123456789abc"])(
    "refuses an absent or superseded intent %s without writing a key",
    async (intent) => {
      const h = storagePorts();
      h.read.result = intent;
      const operation = createBrowserApprovalKeyStore(location.origin).save(
        await remembered(),
        INTENT,
      );
      const observed = operation.then(
        () => "stored",
        (error: unknown) => error,
      );
      await opened(h);
      h.read.onsuccess?.();
      expect(await observed).toMatchObject({ name: "AbortError" });
      expect(h.abort).toHaveBeenCalledOnce();
      expect(h.put).not.toHaveBeenCalled();
    },
  );

  it("contains a synchronous structured-clone failure inside the IDB request callback", async () => {
    const h = storagePorts();
    h.put.mockImplementation((): never => {
      throw new DOMException("Cannot clone", "DataCloneError");
    });
    const operation = createBrowserApprovalKeyStore(location.origin).save(
      await remembered(),
      INTENT,
    );
    const observed = operation.then(
      () => "stored",
      (error: unknown) => error,
    );
    await opened(h);
    let escaped: unknown;
    try {
      h.read.onsuccess?.();
    } catch (error) {
      escaped = error;
      h.tx.onabort?.();
    }
    const outcome = await observed;
    expect(escaped).toBeUndefined();
    expect(outcome).toMatchObject({ name: "DataCloneError" });
    expect(h.abort).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
  });
});
