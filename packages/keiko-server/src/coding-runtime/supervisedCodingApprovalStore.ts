import { randomBytes, timingSafeEqual } from "node:crypto";

import type {
  CodeTaskGrantScope,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchSupervisedActionKind,
} from "@oscharko-dev/keiko-contracts";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";

export interface SupervisedCodingApprovalClaim {
  readonly approvalId: string;
  readonly approvalToken: string;
}

interface SupervisedCodingApprovalBindingBase {
  readonly runId: string;
  readonly requestId: string;
  readonly actionKind: CodingWorkbenchSupervisedActionKind;
  readonly scopeDigest: string;
  readonly connectorScopes: readonly CodingWorkbenchConnectorScope[];
}

/** A single-use ("Run once") approval bound to one action; deleted the moment it is consumed. */
export type SupervisedCodingApprovalBindingOnce = SupervisedCodingApprovalBindingBase & {
  readonly grantScope: "once";
};

/**
 * A reusable ("Allow for this task") grant. Every dimension is load-bearing: a task grant survives
 * consumption but its full binding — command template, safe-argument classes, workspace, source,
 * and policy version — is revalidated on every reuse, so any drift on any dimension (or an expiry
 * or inactivity lapse) forces a fresh human approval rather than an implicit auto-approval.
 */
export type SupervisedCodingApprovalBindingTask = SupervisedCodingApprovalBindingBase & {
  readonly grantScope: "task";
  readonly commandTemplateId: string;
  readonly safeArgumentClasses: readonly string[];
  readonly workspaceDigest: string;
  readonly sourceDigest: string;
  readonly policyVersion: string;
};

export type SupervisedCodingApprovalBinding =
  SupervisedCodingApprovalBindingOnce | SupervisedCodingApprovalBindingTask;

/**
 * Supervised action kinds a task grant may auto-approve: only routine contained edits and vetted
 * verification commands. Dependency operations, delivery (commit/push/PR/merge), credential and
 * connector writes, external-file apply-back, and authority-widening system mutations are
 * structurally excluded — they can never be covered by a reusable task grant (Issue #2386, AC6).
 */
const SUPERVISED_TASK_GRANTABLE_ACTION_KINDS: ReadonlySet<CodingWorkbenchSupervisedActionKind> =
  new Set<CodingWorkbenchSupervisedActionKind>(["file-edit", "verification-command"]);

export function isSupervisedActionTaskGrantable(
  actionKind: CodingWorkbenchSupervisedActionKind,
): boolean {
  return SUPERVISED_TASK_GRANTABLE_ACTION_KINDS.has(actionKind);
}

export interface SupervisedCodingApprovalIssueInput {
  readonly binding: SupervisedCodingApprovalBindingOnce;
  readonly approvedByUserId: string;
  readonly nowMs?: number | undefined;
  readonly ttlMs?: number | undefined;
}

export interface SupervisedCodingTaskGrantIssueInput {
  readonly binding: SupervisedCodingApprovalBindingTask;
  readonly approvedByUserId: string;
  readonly nowMs?: number | undefined;
  readonly ttlMs?: number | undefined;
}

export interface SupervisedCodingIssuedApproval {
  readonly approval: SupervisedCodingApprovalClaim;
  readonly approvalDigest: string;
  readonly approvedByUserId: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
}

export interface SupervisedCodingApprovalConsumeInput {
  readonly approval: SupervisedCodingApprovalClaim;
  readonly binding: SupervisedCodingApprovalBinding;
  readonly nowMs: number;
}

export interface SupervisedCodingConsumedApproval {
  readonly approvalDigest: string;
  readonly approvedByUserId: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
  readonly grantScope: CodeTaskGrantScope;
}

export interface SupervisedCodingApprovalStore {
  issue(input: SupervisedCodingApprovalIssueInput): SupervisedCodingIssuedApproval;
  /** Returns undefined when the action kind is structurally excluded from task grants. */
  issueTaskGrant(
    input: SupervisedCodingTaskGrantIssueInput,
  ): SupervisedCodingIssuedApproval | undefined;
  consume(
    input: SupervisedCodingApprovalConsumeInput,
  ): SupervisedCodingConsumedApproval | undefined;
  invalidateRun(runId: string): void;
  /** Drops every task grant whose bound policy version is not the supplied current version. */
  invalidateStaleByPolicyVersion(currentPolicyVersion: string): void;
}

interface StoredApprovalRecord {
  readonly runId: string;
  readonly bindingHash: string;
  readonly tokenHash: string;
  readonly approvedByUserId: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
  readonly grantScope: CodeTaskGrantScope;
  readonly policyVersion: string | undefined;
  lastActivityMs: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
// Strictly below the absolute TTL so the sliding idle window can actually invalidate an unused
// task grant before its hard expiry; equal values would make the inactivity trigger dead.
const DEFAULT_INACTIVITY_MS = 2 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 512;
const OPAQUE_CLAIM_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/u;

export function supervisedCodingApprovalScopeDigest(input: {
  readonly runId: string;
  readonly requestId: string;
  readonly actionKind: CodingWorkbenchSupervisedActionKind;
  readonly connectorScopes: readonly CodingWorkbenchConnectorScope[];
}): string {
  return sha256Hex(canonicalise({ schema: "supervised-coding-approval-scope-v1", ...input }));
}

export function supervisedCodingApprovalBindingHash(
  binding: SupervisedCodingApprovalBinding,
): string {
  return sha256Hex(canonicalise(binding));
}

export function parseSupervisedCodingApprovalClaim(
  raw: unknown,
): SupervisedCodingApprovalClaim | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const approvalId = opaqueClaimPart(record.approvalId);
  const approvalToken = opaqueClaimPart(record.approvalToken);
  return approvalId === undefined || approvalToken === undefined
    ? undefined
    : { approvalId, approvalToken };
}

export function createInMemorySupervisedCodingApprovalStore(
  options: {
    readonly maxRecords?: number | undefined;
    readonly ttlMs?: number | undefined;
    readonly inactivityMs?: number | undefined;
  } = {},
): SupervisedCodingApprovalStore {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const inactivityMs = options.inactivityMs ?? DEFAULT_INACTIVITY_MS;
  const records = new Map<string, StoredApprovalRecord>();
  const store = (
    binding: SupervisedCodingApprovalBinding,
    input: {
      readonly approvedByUserId: string;
      readonly nowMs?: number | undefined;
      readonly ttlMs?: number | undefined;
    },
  ): SupervisedCodingIssuedApproval => persistApproval(records, maxRecords, binding, input, ttlMs);
  return {
    issue: (input): SupervisedCodingIssuedApproval => store(input.binding, input),
    issueTaskGrant: (input): SupervisedCodingIssuedApproval | undefined =>
      isSupervisedActionTaskGrantable(input.binding.actionKind)
        ? store(input.binding, input)
        : undefined,
    consume: (input): SupervisedCodingConsumedApproval | undefined =>
      consumeApprovalRecord(records, maxRecords, inactivityMs, input),
    invalidateRun: (runId): void => {
      invalidateRun(records, runId);
    },
    invalidateStaleByPolicyVersion: (version): void => {
      invalidatePolicy(records, version);
    },
  };
}

function persistApproval(
  records: Map<string, StoredApprovalRecord>,
  maxRecords: number,
  binding: SupervisedCodingApprovalBinding,
  input: {
    readonly approvedByUserId: string;
    readonly nowMs?: number | undefined;
    readonly ttlMs?: number | undefined;
  },
  ttlMs: number,
): SupervisedCodingIssuedApproval {
  const nowMs = input.nowMs ?? Date.now();
  pruneExpired(records, nowMs, maxRecords);
  const approvalId = `sca_${randomBytes(16).toString("hex")}`;
  const approvalToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(approvalToken);
  const expiresAtMs = nowMs + (input.ttlMs ?? ttlMs);
  records.set(approvalId, {
    runId: binding.runId,
    bindingHash: supervisedCodingApprovalBindingHash(binding),
    tokenHash,
    approvedByUserId: input.approvedByUserId,
    approvedAtMs: nowMs,
    expiresAtMs,
    grantScope: binding.grantScope,
    policyVersion: binding.grantScope === "task" ? binding.policyVersion : undefined,
    lastActivityMs: nowMs,
  });
  return {
    approval: { approvalId, approvalToken },
    approvalDigest: approvalDigest(binding, tokenHash),
    approvedByUserId: input.approvedByUserId,
    approvedAtMs: nowMs,
    expiresAtMs,
  };
}

function consumeApprovalRecord(
  records: Map<string, StoredApprovalRecord>,
  maxRecords: number,
  inactivityMs: number,
  input: SupervisedCodingApprovalConsumeInput,
): SupervisedCodingConsumedApproval | undefined {
  pruneExpired(records, input.nowMs, maxRecords);
  const record = records.get(input.approval.approvalId);
  if (record === undefined || !approvalRecordMatches(record, input)) return undefined;
  if (input.nowMs - record.lastActivityMs > inactivityMs) {
    records.delete(input.approval.approvalId);
    return undefined;
  }
  // A task grant may only ever cover a task-grantable action, revalidated on every reuse.
  if (record.grantScope === "task" && !isSupervisedActionTaskGrantable(input.binding.actionKind)) {
    records.delete(input.approval.approvalId);
    return undefined;
  }
  // Fail closed to single-use: only an explicit reusable task grant survives a consume; a "once"
  // grant, an absent scope, or any unexpected value is deleted on first use.
  if (record.grantScope !== "task") records.delete(input.approval.approvalId);
  else record.lastActivityMs = input.nowMs;
  return {
    approvalDigest: approvalDigest(input.binding, record.tokenHash),
    approvedByUserId: record.approvedByUserId,
    approvedAtMs: record.approvedAtMs,
    expiresAtMs: record.expiresAtMs,
    grantScope: record.grantScope,
  };
}

function approvalRecordMatches(
  record: StoredApprovalRecord,
  input: SupervisedCodingApprovalConsumeInput,
): boolean {
  return (
    record.expiresAtMs > input.nowMs &&
    record.grantScope === input.binding.grantScope &&
    record.bindingHash === supervisedCodingApprovalBindingHash(input.binding) &&
    constantTimeHexEqual(record.tokenHash, hashToken(input.approval.approvalToken))
  );
}

function invalidateRun(records: Map<string, StoredApprovalRecord>, runId: string): void {
  for (const [approvalId, record] of records) {
    if (record.runId === runId) records.delete(approvalId);
  }
}

function invalidatePolicy(
  records: Map<string, StoredApprovalRecord>,
  currentPolicyVersion: string,
): void {
  for (const [approvalId, record] of records) {
    if (record.grantScope === "task" && record.policyVersion !== currentPolicyVersion) {
      records.delete(approvalId);
    }
  }
}

function approvalDigest(binding: SupervisedCodingApprovalBinding, tokenHash: string): string {
  return sha256Hex(
    canonicalise({
      schema: "supervised-coding-consumed-approval-v1",
      bindingHash: supervisedCodingApprovalBindingHash(binding),
      tokenHash,
    }),
  );
}

function pruneExpired(
  records: Map<string, StoredApprovalRecord>,
  nowMs: number,
  maxRecords: number,
): void {
  for (const [id, record] of records) {
    if (record.expiresAtMs <= nowMs) records.delete(id);
  }
  while (records.size > maxRecords) {
    const first = records.keys().next().value;
    if (first === undefined) break;
    records.delete(first);
  }
}

function hashToken(token: string): string {
  return sha256Hex(token);
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!HEX_64_PATTERN.test(left) || !HEX_64_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function opaqueClaimPart(value: unknown): string | undefined {
  return typeof value === "string" && OPAQUE_CLAIM_PATTERN.test(value) ? value : undefined;
}
