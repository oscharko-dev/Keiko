import type { EditorAgentGovernedAuthorityReference } from "@oscharko-dev/keiko-contracts";

import type { CodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";

const MAX_LIVE_LEASES = 64;
const MAX_ACTIVE_LEASE_PORTS = 64;

export interface CodingRuntimeEditorMutationLeaseRequest {
  readonly authorityRef: EditorAgentGovernedAuthorityReference;
  readonly runId?: string | undefined;
  readonly envelopeDigest?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly workspaceRootDigest: string;
  readonly actionId: string;
  readonly idempotencyKey: string;
}

export interface CodingRuntimeEditorMutationLeasePort {
  readonly matches: (request: CodingRuntimeEditorMutationLeaseRequest) => boolean;
  readonly requiresReview: (
    request: CodingRuntimeEditorMutationLeaseRequest,
  ) => boolean | undefined;
  readonly claim: (request: CodingRuntimeEditorMutationLeaseRequest) => boolean;
  readonly complete: (
    request: CodingRuntimeEditorMutationLeaseRequest,
    succeeded: boolean,
  ) => boolean;
  readonly discard: (request: CodingRuntimeEditorMutationLeaseRequest) => boolean;
}

export interface CodingRuntimeEditorMutationLeaseBroker extends CodingRuntimeEditorMutationLeasePort {
  readonly attach: (port: CodingRuntimeEditorMutationLeasePort) => (() => void) | undefined;
  readonly dispose: () => void;
}

export interface CodingRuntimeEditorMutationLeaseRegistration {
  readonly authorityRef: EditorAgentGovernedAuthorityReference;
  readonly workspaceId: string;
  readonly workspaceRootDigest: string;
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly requiresReview: boolean;
  readonly mutationGuard: () => boolean;
}

export interface CodingRuntimeEditorMutationLeaseCoordinator {
  readonly lease: CodingRuntimeEditorMutationLeasePort;
  readonly register: (registration: CodingRuntimeEditorMutationLeaseRegistration) => boolean;
  readonly discard: (request: CodingRuntimeEditorMutationLeaseRequest) => boolean;
  readonly revokeRun: (runId: string) => boolean;
  readonly waitForIdle: (signal: AbortSignal) => Promise<boolean>;
  readonly dispose: () => void;
}

export interface CodingRuntimeEditorMutationLeaseCoordinatorDeps {
  readonly invocationRegistry: Pick<CodingToolInvocationRegistry, "revokeRun">;
  readonly cancelPendingByAuthorityRun: (runId: string) => number;
}

export function createCodingRuntimeEditorMutationLeaseBroker(): CodingRuntimeEditorMutationLeaseBroker {
  const ports = new Set<CodingRuntimeEditorMutationLeasePort>();
  let disposed = false;
  return {
    matches: (request): boolean => uniqueMatchingPort(ports, request, disposed) !== undefined,
    requiresReview: (request): boolean | undefined => reviewRequirement(ports, request, disposed),
    claim: (request): boolean => claimMatchingPort(ports, request, disposed),
    complete: (request, succeeded): boolean =>
      completeMatchingPort(ports, request, succeeded, disposed),
    discard: (request): boolean => discardMatchingPort(ports, request, disposed),
    attach: (port): (() => void) | undefined => {
      if (disposed || ports.size >= MAX_ACTIVE_LEASE_PORTS || ports.has(port)) return undefined;
      ports.add(port);
      let attached = true;
      return (): void => {
        if (!attached) return;
        attached = false;
        ports.delete(port);
      };
    },
    dispose: (): void => {
      disposed = true;
      ports.clear();
    },
  };
}

interface LeaseRecord extends CodingRuntimeEditorMutationLeaseRegistration {
  readonly key: string;
  claimed: boolean;
}

interface IdleWaiter {
  readonly resolve: (idle: boolean) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

interface MutationOutcome {
  latestSucceeded: boolean | undefined;
}

function reviewRequirement(
  ports: ReadonlySet<CodingRuntimeEditorMutationLeasePort>,
  request: CodingRuntimeEditorMutationLeaseRequest,
  disposed: boolean,
): boolean | undefined {
  const port = uniqueMatchingPort(ports, request, disposed);
  if (port === undefined) return undefined;
  try {
    return port.requiresReview(request);
  } catch {
    return undefined;
  }
}

function claimMatchingPort(
  ports: ReadonlySet<CodingRuntimeEditorMutationLeasePort>,
  request: CodingRuntimeEditorMutationLeaseRequest,
  disposed: boolean,
): boolean {
  const port = uniqueMatchingPort(ports, request, disposed);
  if (port === undefined) return false;
  try {
    return port.claim(request);
  } catch {
    return false;
  }
}

function completeMatchingPort(
  ports: ReadonlySet<CodingRuntimeEditorMutationLeasePort>,
  request: CodingRuntimeEditorMutationLeaseRequest,
  succeeded: boolean,
  disposed: boolean,
): boolean {
  const port = uniqueMatchingPort(ports, request, disposed);
  if (port === undefined) return false;
  try {
    return port.complete(request, succeeded);
  } catch {
    return false;
  }
}

function discardMatchingPort(
  ports: ReadonlySet<CodingRuntimeEditorMutationLeasePort>,
  request: CodingRuntimeEditorMutationLeaseRequest,
  disposed: boolean,
): boolean {
  const port = uniqueMatchingPort(ports, request, disposed);
  if (port === undefined) return false;
  try {
    return port.discard(request);
  } catch {
    return false;
  }
}

function uniqueMatchingPort(
  ports: ReadonlySet<CodingRuntimeEditorMutationLeasePort>,
  request: CodingRuntimeEditorMutationLeaseRequest,
  disposed: boolean,
): CodingRuntimeEditorMutationLeasePort | undefined {
  if (disposed) return undefined;
  let matched: CodingRuntimeEditorMutationLeasePort | undefined;
  try {
    for (const port of ports) {
      if (!port.matches(request)) continue;
      if (matched !== undefined) return undefined;
      matched = port;
    }
  } catch {
    return undefined;
  }
  return matched;
}

export function createCodingRuntimeEditorMutationLeaseCoordinator(
  deps: CodingRuntimeEditorMutationLeaseCoordinatorDeps,
): CodingRuntimeEditorMutationLeaseCoordinator {
  const records = new Map<string, LeaseRecord>();
  const revokedRuns = new Set<string>();
  const idleWaiters = new Set<IdleWaiter>();
  const outcome: MutationOutcome = { latestSucceeded: undefined };
  let disposed = false;
  const lease: CodingRuntimeEditorMutationLeasePort = {
    matches: (request): boolean => findRecord(records, request, disposed) !== undefined,
    requiresReview: (request): boolean | undefined =>
      findRecord(records, request, disposed)?.requiresReview,
    claim: (request): boolean => claimRecord(records, idleWaiters, outcome, request, disposed),
    complete: (request, succeeded): boolean =>
      completeRecord(records, idleWaiters, outcome, request, succeeded, disposed),
    discard: (request): boolean =>
      completeRecord(records, idleWaiters, outcome, request, false, disposed),
  };
  return {
    lease,
    register: (registration): boolean =>
      registerRecord(records, revokedRuns, registration, disposed),
    discard: (request): boolean =>
      completeRecord(records, idleWaiters, outcome, request, false, disposed),
    revokeRun: (runId): boolean =>
      revokeRun(deps, records, revokedRuns, idleWaiters, outcome, runId, disposed),
    waitForIdle: (signal): Promise<boolean> =>
      waitForIdle(records, idleWaiters, outcome, signal, disposed),
    dispose: (): void => {
      disposed = true;
      records.clear();
      settleIdleWaiters(idleWaiters, false);
    },
  };
}

function registerRecord(
  records: Map<string, LeaseRecord>,
  revokedRuns: ReadonlySet<string>,
  registration: CodingRuntimeEditorMutationLeaseRegistration,
  disposed: boolean,
): boolean {
  const key = recordKey(registration);
  if (
    disposed ||
    revokedRuns.has(registration.authorityRef.runId) ||
    records.size >= MAX_LIVE_LEASES ||
    records.has(key) ||
    !validRegistration(registration)
  ) {
    return false;
  }
  records.set(key, {
    key,
    authorityRef: registration.authorityRef,
    workspaceId: registration.workspaceId,
    workspaceRootDigest: registration.workspaceRootDigest,
    actionId: registration.actionId,
    idempotencyKey: registration.idempotencyKey,
    requiresReview: registration.requiresReview,
    mutationGuard: registration.mutationGuard,
    claimed: false,
  });
  return true;
}

function claimRecord(
  records: Map<string, LeaseRecord>,
  idleWaiters: Set<IdleWaiter>,
  outcome: MutationOutcome,
  request: CodingRuntimeEditorMutationLeaseRequest,
  disposed: boolean,
): boolean {
  const record = findRecord(records, request, disposed);
  if (record === undefined || record.claimed) return false;
  let allowed: boolean;
  try {
    allowed = record.mutationGuard();
  } catch {
    allowed = false;
  }
  if (allowed) {
    record.claimed = true;
    return true;
  }
  records.delete(record.key);
  outcome.latestSucceeded = false;
  settleIfIdle(records, idleWaiters, outcome);
  return false;
}

function completeRecord(
  records: Map<string, LeaseRecord>,
  idleWaiters: Set<IdleWaiter>,
  outcome: MutationOutcome,
  request: CodingRuntimeEditorMutationLeaseRequest,
  succeeded: boolean,
  disposed: boolean,
): boolean {
  const record = findRecord(records, request, disposed);
  if (record === undefined || !records.delete(record.key)) return false;
  outcome.latestSucceeded = succeeded && record.claimed;
  settleIfIdle(records, idleWaiters, outcome);
  return true;
}

function revokeRun(
  deps: CodingRuntimeEditorMutationLeaseCoordinatorDeps,
  records: Map<string, LeaseRecord>,
  revokedRuns: Set<string>,
  idleWaiters: Set<IdleWaiter>,
  outcome: MutationOutcome,
  runId: string,
  disposed: boolean,
): boolean {
  if (disposed || revokedRuns.has(runId)) return false;
  revokedRuns.add(runId);
  deps.invocationRegistry.revokeRun(runId);
  for (const [key, record] of records) {
    if (record.authorityRef.runId === runId) records.delete(key);
  }
  outcome.latestSucceeded = false;
  settleIfIdle(records, idleWaiters, outcome);
  deps.cancelPendingByAuthorityRun(runId);
  return true;
}

function waitForIdle(
  records: ReadonlyMap<string, LeaseRecord>,
  waiters: Set<IdleWaiter>,
  outcome: MutationOutcome,
  signal: AbortSignal,
  disposed: boolean,
): Promise<boolean> {
  if (disposed || signal.aborted) return Promise.resolve(false);
  if (records.size === 0) return Promise.resolve(outcome.latestSucceeded !== false);
  return new Promise((resolve) => {
    const waiter: IdleWaiter = {
      resolve,
      signal,
      onAbort: (): void => {
        settleIdleWaiter(waiters, waiter, false);
      },
    };
    waiters.add(waiter);
    signal.addEventListener("abort", waiter.onAbort, { once: true });
  });
}

function settleIfIdle(
  records: ReadonlyMap<string, LeaseRecord>,
  waiters: Set<IdleWaiter>,
  outcome: MutationOutcome,
): void {
  if (records.size === 0) settleIdleWaiters(waiters, outcome.latestSucceeded !== false);
}

function settleIdleWaiters(waiters: Set<IdleWaiter>, idle: boolean): void {
  // Snapshot before iterating: settling a waiter may synchronously register a NEW waiter, which
  // must wait for the next settle pass instead of running inside this one.
  const snapshot = Array.from(waiters);
  for (const waiter of snapshot) settleIdleWaiter(waiters, waiter, idle);
}

function settleIdleWaiter(waiters: Set<IdleWaiter>, waiter: IdleWaiter, idle: boolean): void {
  if (!waiters.delete(waiter)) return;
  waiter.signal.removeEventListener("abort", waiter.onAbort);
  waiter.resolve(idle);
}

function findRecord(
  records: ReadonlyMap<string, LeaseRecord>,
  request: CodingRuntimeEditorMutationLeaseRequest,
  disposed: boolean,
): LeaseRecord | undefined {
  if (disposed) return undefined;
  const record = records.get(recordKey(request));
  return record !== undefined && exactMatch(record, request) ? record : undefined;
}

function exactMatch(
  record: LeaseRecord,
  request: CodingRuntimeEditorMutationLeaseRequest,
): boolean {
  return (
    (request.runId === undefined || record.authorityRef.runId === request.runId) &&
    (request.envelopeDigest === undefined ||
      record.authorityRef.envelopeDigest === request.envelopeDigest) &&
    record.authorityRef.envelopeDigest === request.authorityRef.envelopeDigest &&
    record.workspaceRootDigest === request.workspaceRootDigest &&
    (request.workspaceId === undefined || record.workspaceId === request.workspaceId)
  );
}

function recordKey(request: {
  readonly authorityRef: EditorAgentGovernedAuthorityReference;
  readonly actionId: string;
  readonly idempotencyKey: string;
}): string {
  return `${request.authorityRef.runId}\u0000${request.actionId}\u0000${request.idempotencyKey}`;
}

function validRegistration(registration: CodingRuntimeEditorMutationLeaseRegistration): boolean {
  return (
    registration.authorityRef.runId.length > 0 &&
    /^[a-f0-9]{64}$/u.test(registration.authorityRef.envelopeDigest) &&
    registration.workspaceId.length > 0 &&
    /^[a-f0-9]{64}$/u.test(registration.workspaceRootDigest) &&
    registration.actionId.length > 0 &&
    registration.idempotencyKey.length > 0
  );
}
