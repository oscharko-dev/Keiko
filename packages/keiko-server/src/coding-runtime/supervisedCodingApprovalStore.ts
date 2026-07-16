import { randomBytes, timingSafeEqual } from "node:crypto";

import type {
  CodingWorkbenchConnectorScope,
  CodingWorkbenchSupervisedActionKind,
} from "@oscharko-dev/keiko-contracts";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";

export interface SupervisedCodingApprovalClaim {
  readonly approvalId: string;
  readonly approvalToken: string;
}

export interface SupervisedCodingApprovalBinding {
  readonly runId: string;
  readonly requestId: string;
  readonly actionKind: CodingWorkbenchSupervisedActionKind;
  readonly scopeDigest: string;
  readonly connectorScopes: readonly CodingWorkbenchConnectorScope[];
}

export interface SupervisedCodingApprovalIssueInput {
  readonly binding: SupervisedCodingApprovalBinding;
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
}

export interface SupervisedCodingApprovalStore {
  issue(input: SupervisedCodingApprovalIssueInput): SupervisedCodingIssuedApproval;
  consume(
    input: SupervisedCodingApprovalConsumeInput,
  ): SupervisedCodingConsumedApproval | undefined;
  invalidateRun(runId: string): void;
}

interface StoredApprovalRecord {
  readonly runId: string;
  readonly bindingHash: string;
  readonly tokenHash: string;
  readonly approvedByUserId: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
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
  } = {},
): SupervisedCodingApprovalStore {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const records = new Map<string, StoredApprovalRecord>();
  return {
    issue(input): SupervisedCodingIssuedApproval {
      const nowMs = input.nowMs ?? Date.now();
      pruneExpired(records, nowMs, maxRecords);
      const approvalId = `sca_${randomBytes(16).toString("hex")}`;
      const approvalToken = randomBytes(32).toString("hex");
      const tokenHash = hashToken(approvalToken);
      const expiresAtMs = nowMs + (input.ttlMs ?? ttlMs);
      records.set(approvalId, {
        runId: input.binding.runId,
        bindingHash: supervisedCodingApprovalBindingHash(input.binding),
        tokenHash,
        approvedByUserId: input.approvedByUserId,
        approvedAtMs: nowMs,
        expiresAtMs,
      });
      return {
        approval: { approvalId, approvalToken },
        approvalDigest: approvalDigest(input.binding, tokenHash),
        approvedByUserId: input.approvedByUserId,
        approvedAtMs: nowMs,
        expiresAtMs,
      };
    },
    consume(input): SupervisedCodingConsumedApproval | undefined {
      pruneExpired(records, input.nowMs, maxRecords);
      return consumeApprovalRecord(records, input);
    },
    invalidateRun(runId: string): void {
      for (const [approvalId, record] of records) {
        if (record.runId === runId) records.delete(approvalId);
      }
    },
  };
}

function consumeApprovalRecord(
  records: Map<string, StoredApprovalRecord>,
  input: SupervisedCodingApprovalConsumeInput,
): SupervisedCodingConsumedApproval | undefined {
  const record = records.get(input.approval.approvalId);
  if (record === undefined) return undefined;
  if (!approvalRecordMatches(record, input)) return undefined;
  records.delete(input.approval.approvalId);
  return {
    approvalDigest: approvalDigest(input.binding, record.tokenHash),
    approvedByUserId: record.approvedByUserId,
    approvedAtMs: record.approvedAtMs,
    expiresAtMs: record.expiresAtMs,
  };
}

function approvalRecordMatches(
  record: StoredApprovalRecord,
  input: SupervisedCodingApprovalConsumeInput,
): boolean {
  return (
    record.expiresAtMs > input.nowMs &&
    record.bindingHash === supervisedCodingApprovalBindingHash(input.binding) &&
    constantTimeHexEqual(record.tokenHash, hashToken(input.approval.approvalToken))
  );
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
