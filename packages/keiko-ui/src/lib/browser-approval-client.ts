"use client";

import {
  BROWSER_APPROVAL_VERSION,
  type BrowserApprovalChallenge,
  type BrowserApprovalDescriptor,
  type BrowserApprovalRequestDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import {
  inspectBrowserApprovals,
  proveBrowserApproval,
  requestBrowserApproval,
  requestBrowserChallenge,
} from "./browser-approval-api";
import {
  createBrowserApprovalKey,
  signBrowserApprovalChallenge,
  type BrowserApprovalKey,
} from "./browser-approval-crypto";
import {
  createBrowserApprovalKeyStore,
  type BrowserApprovalKeyStore,
  type RememberedBrowserApproval,
} from "./browser-approval-key-store";
import { observeBrowserApproval } from "./browser-approval-evidence";
import { newClientCorrelationId } from "./bff-correlation";
import { reportClientDiagnostic } from "./client-diagnostics";
import { clientErrorEvidence } from "./client-error-evidence";
import { bffRequestErrorKind } from "./http";
import {
  notifyCodingAppSessionChanged,
  waitForSharedSessionWork,
} from "./coding-app-session-client";

const API = {
  inspect: inspectBrowserApprovals,
  request: requestBrowserApproval,
  challenge: requestBrowserChallenge,
  prove: proveBrowserApproval,
};

export interface BrowserApprovalAttempt {
  readonly key: BrowserApprovalKey;
  readonly request: BrowserApprovalRequestDescriptor;
  readonly correlationId: string;
  readonly persistenceIntent?: string;
}

export type BrowserApprovalCompletion =
  | { readonly state: "pending" | "unavailable" }
  | { readonly state: "active"; readonly persistence: "session" | "stored" | "unconfirmed" };

export interface BrowserApprovalClientOptions {
  readonly origin: string;
  readonly keyStore: BrowserApprovalKeyStore;
  readonly api?: typeof API;
  readonly sessionChanged?: () => void;
  readonly withRenewalLock?: (task: () => Promise<boolean>) => Promise<boolean>;
}

interface ClientState {
  readonly origin: string;
  readonly keyStore: BrowserApprovalKeyStore;
  readonly api: typeof API;
  readonly sessionChanged: () => void;
  readonly withRenewalLock: (task: () => Promise<boolean>) => Promise<boolean>;
}

export interface BrowserApprovalClient {
  readonly begin: (
    remember: boolean,
    signal?: AbortSignal,
  ) => Promise<BrowserApprovalAttempt | undefined>;
  readonly complete: (
    attempt: BrowserApprovalAttempt,
    signal?: AbortSignal,
  ) => Promise<BrowserApprovalCompletion>;
  readonly restore: (signal?: AbortSignal) => Promise<boolean>;
}

function withRenewalLock(task: () => Promise<boolean>): Promise<boolean> {
  if (typeof navigator === "undefined" || navigator.locks === undefined) return task();
  return navigator.locks.request(
    "keiko-browser-approval-renewal",
    { signal: AbortSignal.timeout(15_000) },
    task,
  );
}

function refuseResponseBinding(correlationId: string): never {
  reportClientDiagnostic("Browser approval response binding refused.", {
    correlationId,
    errorKind: "invalid-request",
  });
  throw new TypeError("Browser approval response binding changed.");
}

function assertRenewedApproval(
  approval: BrowserApprovalDescriptor | undefined,
  expectedId: string,
  correlationId: string,
): void {
  if (approval !== undefined && approval.approvalId !== expectedId)
    refuseResponseBinding(correlationId);
}

async function beginApproval(
  state: ClientState,
  remember: boolean,
  signal?: AbortSignal,
): Promise<BrowserApprovalAttempt | undefined> {
  signal?.throwIfAborted();
  const correlationId = newClientCorrelationId();
  const persistenceIntent = remember
    ? await prepareRememberedPersistence(state, correlationId, signal)
    : undefined;
  signal?.throwIfAborted();
  const key = await createBrowserApprovalKey(correlationId);
  signal?.throwIfAborted();
  const response = await state.api.request(
    { publicKey: key.publicKey, remember },
    signal,
    correlationId,
  );
  signal?.throwIfAborted();
  if (response.state === "pending" && response.request.rememberRequested !== remember)
    refuseResponseBinding(correlationId);
  return response.state === "pending"
    ? {
        key,
        request: response.request,
        correlationId,
        ...(persistenceIntent === undefined ? {} : { persistenceIntent }),
      }
    : undefined;
}

async function prepareRememberedPersistence(
  state: ClientState,
  correlationId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return await waitForSharedSessionWork(state.keyStore.prepare(correlationId), signal);
  } catch (error) {
    if (signal?.aborted === true) throw error;
    reportClientDiagnostic("Browser approval persistence could not be prepared.", {
      correlationId,
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
    return undefined;
  }
}

async function confirmedSession(
  state: ClientState,
  signal: AbortSignal | undefined,
  correlationId: string,
): Promise<boolean> {
  signal?.throwIfAborted();
  const result = await state.api.inspect(signal, correlationId);
  signal?.throwIfAborted();
  return result.state === "active";
}

async function rememberApprovedKey(
  state: ClientState,
  record: RememberedBrowserApproval,
  intent: string,
  correlationId: string,
): Promise<"stored" | "unconfirmed"> {
  try {
    await state.keyStore.save(record, intent, correlationId);
    return "stored";
  } catch (error) {
    // The key-store operation recorded the actual failure; never claim durable success or use raw-key fallback.
    reportClientDiagnostic("Browser approval persistence remains unconfirmed.", {
      correlationId,
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
    return "unconfirmed";
  }
}

type CompletedProof =
  | { readonly state: "pending" | "unavailable" }
  | {
      readonly state: "proved";
      readonly challenge: BrowserApprovalChallenge;
      readonly approval: BrowserApprovalDescriptor | undefined;
    };

async function proveAttempt(
  state: ClientState,
  attempt: BrowserApprovalAttempt,
  signal?: AbortSignal,
): Promise<CompletedProof> {
  const { correlationId } = attempt;
  signal?.throwIfAborted();
  const challenged = await state.api.challenge(
    { purpose: "complete", subjectId: attempt.request.requestId },
    signal,
    correlationId,
  );
  if (challenged.state !== "challenge") return { state: challenged.state };
  signal?.throwIfAborted();
  const challenge = challenged.challenge;
  const proof = await signBrowserApprovalChallenge(
    attempt.key.privateKey,
    challenge,
    {
      purpose: "complete",
      subjectId: attempt.request.requestId,
      origin: state.origin,
    },
    correlationId,
  );
  signal?.throwIfAborted();
  const result = await state.api.prove(proof, signal, correlationId);
  if (result.state !== "active" || !(await confirmedSession(state, signal, correlationId)))
    return { state: "unavailable" };
  return { state: "proved", challenge, approval: result.approval };
}

async function rememberAttempt(
  state: ClientState,
  attempt: BrowserApprovalAttempt,
  proof: Extract<CompletedProof, { state: "proved" }>,
): Promise<"session" | "stored" | "unconfirmed"> {
  const approval = proof.approval;
  if (approval === undefined) return "session";
  if (approval.publicKeyFingerprint !== attempt.request.publicKeyFingerprint)
    refuseResponseBinding(attempt.correlationId);
  if (!approval.remembered) return "session";
  if (!attempt.request.rememberRequested) refuseResponseBinding(attempt.correlationId);
  if (attempt.persistenceIntent === undefined) return "unconfirmed";
  return rememberApprovedKey(
    state,
    {
      schemaVersion: BROWSER_APPROVAL_VERSION,
      privateKey: attempt.key.privateKey,
      approval,
      origin: state.origin,
      installationId: proof.challenge.installationId,
    },
    attempt.persistenceIntent,
    attempt.correlationId,
  );
}

async function completeApproval(
  state: ClientState,
  attempt: BrowserApprovalAttempt,
  signal?: AbortSignal,
): Promise<BrowserApprovalCompletion> {
  if (await confirmedSession(state, signal, attempt.correlationId)) {
    signal?.throwIfAborted();
    state.sessionChanged();
    return {
      state: "active",
      persistence: attempt.request.rememberRequested ? "unconfirmed" : "session",
    };
  }
  const proof = await proveAttempt(state, attempt, signal);
  if (proof.state !== "proved") return { state: proof.state };
  const persistence = await rememberAttempt(state, attempt, proof);
  if (persistence !== "session" && !(await confirmedSession(state, signal, attempt.correlationId)))
    return { state: "unavailable" };
  signal?.throwIfAborted();
  state.sessionChanged();
  return { state: "active", persistence };
}

async function restoreUnderLock(
  state: ClientState,
  correlationId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (await confirmedSession(state, signal, correlationId)) return true;
  const record = await waitForSharedSessionWork(state.keyStore.load(correlationId), signal);
  signal?.throwIfAborted();
  if (record === undefined) return false;
  const challenged = await state.api.challenge(
    { purpose: "renew", subjectId: record.approval.approvalId },
    signal,
    correlationId,
  );
  if (challenged.state !== "challenge") return false;
  signal?.throwIfAborted();
  const proof = await signBrowserApprovalChallenge(
    record.privateKey,
    challenged.challenge,
    {
      purpose: "renew",
      subjectId: record.approval.approvalId,
      origin: state.origin,
      installationId: record.installationId,
    },
    correlationId,
  );
  signal?.throwIfAborted();
  const result = await state.api.prove(proof, signal, correlationId);
  if (result.state !== "active" || !(await confirmedSession(state, signal, correlationId)))
    return false;
  assertRenewedApproval(result.approval, record.approval.approvalId, correlationId);
  state.sessionChanged();
  return true;
}

async function restoreApproval(state: ClientState, signal?: AbortSignal): Promise<boolean> {
  try {
    return await observeBrowserApproval("session-restore", async (correlationId) => {
      const active = await waitForSharedSessionWork(
        state.withRenewalLock(() => restoreUnderLock(state, correlationId, signal)),
        signal,
      );
      return { value: active, outcome: active ? "active" : "unavailable" };
    });
  } catch (error) {
    // The operation owner records the failure. An unavailable key must leave one-session approval usable.
    reportClientDiagnostic("Browser session restoration unavailable.", {
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
    return false;
  }
}

/** Orchestrates the existing server authority; local state or an acknowledgement never grants access. */
export function createBrowserApprovalClient(
  options: BrowserApprovalClientOptions,
): BrowserApprovalClient {
  const state: ClientState = {
    ...options,
    api: options.api ?? API,
    sessionChanged: options.sessionChanged ?? notifyCodingAppSessionChanged,
    withRenewalLock: options.withRenewalLock ?? withRenewalLock,
  };
  return {
    begin: (remember, signal) => beginApproval(state, remember, signal),
    complete: (attempt, signal) => completeApproval(state, attempt, signal),
    restore: (signal) => restoreApproval(state, signal),
  };
}

export function createLocalBrowserApprovalClient(): BrowserApprovalClient {
  const origin = window.location.origin;
  return createBrowserApprovalClient({ origin, keyStore: createBrowserApprovalKeyStore(origin) });
}
