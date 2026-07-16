import type { EditorAgentGovernedAuthorityReference } from "@oscharko-dev/keiko-contracts";

import type { CodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";

const MAX_LIVE_LEASES = 64;

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
  readonly claim: (request: CodingRuntimeEditorMutationLeaseRequest) => boolean;
}

export interface CodingRuntimeEditorMutationLeaseRegistration {
  readonly authorityRef: EditorAgentGovernedAuthorityReference;
  readonly workspaceId: string;
  readonly workspaceRootDigest: string;
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly mutationGuard: () => boolean;
}

export interface CodingRuntimeEditorMutationLeaseCoordinator {
  readonly lease: CodingRuntimeEditorMutationLeasePort;
  readonly register: (registration: CodingRuntimeEditorMutationLeaseRegistration) => boolean;
  readonly discard: (request: CodingRuntimeEditorMutationLeaseRequest) => boolean;
  readonly revokeRun: (runId: string) => boolean;
  readonly dispose: () => void;
}

export interface CodingRuntimeEditorMutationLeaseCoordinatorDeps {
  readonly invocationRegistry: Pick<CodingToolInvocationRegistry, "revokeRun">;
  readonly cancelPendingByAuthorityRun: (runId: string) => number;
}

interface LeaseRecord extends CodingRuntimeEditorMutationLeaseRegistration {
  readonly key: string;
}

export function createCodingRuntimeEditorMutationLeaseCoordinator(
  deps: CodingRuntimeEditorMutationLeaseCoordinatorDeps,
): CodingRuntimeEditorMutationLeaseCoordinator {
  const records = new Map<string, LeaseRecord>();
  const revokedRuns = new Set<string>();
  let disposed = false;
  const lease: CodingRuntimeEditorMutationLeasePort = {
    matches: (request): boolean => findRecord(records, request, disposed) !== undefined,
    claim: (request): boolean => claimRecord(records, request, disposed),
  };
  return {
    lease,
    register: (registration): boolean =>
      registerRecord(records, revokedRuns, registration, disposed),
    discard: (request): boolean => discardRecord(records, request, disposed),
    revokeRun: (runId): boolean => revokeRun(deps, records, revokedRuns, runId, disposed),
    dispose: (): void => {
      disposed = true;
      records.clear();
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
    mutationGuard: registration.mutationGuard,
  });
  return true;
}

function claimRecord(
  records: Map<string, LeaseRecord>,
  request: CodingRuntimeEditorMutationLeaseRequest,
  disposed: boolean,
): boolean {
  const record = findRecord(records, request, disposed);
  if (record === undefined) return false;
  records.delete(record.key);
  try {
    return record.mutationGuard();
  } catch {
    return false;
  }
}

function discardRecord(
  records: Map<string, LeaseRecord>,
  request: CodingRuntimeEditorMutationLeaseRequest,
  disposed: boolean,
): boolean {
  const record = findRecord(records, request, disposed);
  return record === undefined ? false : records.delete(record.key);
}

function revokeRun(
  deps: CodingRuntimeEditorMutationLeaseCoordinatorDeps,
  records: Map<string, LeaseRecord>,
  revokedRuns: Set<string>,
  runId: string,
  disposed: boolean,
): boolean {
  if (disposed || revokedRuns.has(runId)) return false;
  revokedRuns.add(runId);
  deps.invocationRegistry.revokeRun(runId);
  for (const [key, record] of records) {
    if (record.authorityRef.runId === runId) records.delete(key);
  }
  deps.cancelPendingByAuthorityRun(runId);
  return true;
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
