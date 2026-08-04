import { createHash, timingSafeEqual } from "node:crypto";

import type { CodingToolActionRequest, CodingToolApprovalProof } from "./codingToolIpc.js";

const MAX_PENDING_RECORDS = 64;
const MAX_APPROVED_RECORDS = 64;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export type ApprovableToolRequest = Extract<
  CodingToolActionRequest,
  { readonly action: "command" | "verification" }
>;

interface ApprovalBinding {
  readonly runId: string;
  readonly action: ApprovableToolRequest["action"];
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly targetId: string;
  readonly proof: CodingToolApprovalProof;
}

interface PendingApproval extends ApprovalBinding {
  readonly requestId: string;
  readonly expiresAtMs: number;
}

interface ApprovedAction extends ApprovalBinding {
  readonly approvalAuthorityDigest: string;
  readonly expiresAtMs: number;
}

export interface CodingToolApprovalObservation extends ApprovalBinding {
  readonly requestId: string;
  readonly expiresAt: string;
  readonly nowMs: number;
}

export interface CodingToolApprovalActivation {
  readonly runId: string;
  readonly requestId: string;
  readonly approvalAuthorityDigest: string;
  readonly expiresAtMs: number;
  readonly nowMs: number;
}

export interface CodingToolApprovalProofVerifier {
  readonly matches: (input: {
    readonly runId: string;
    readonly request: ApprovableToolRequest;
    readonly nowMs: number;
  }) => boolean;
  readonly consume: (input: {
    readonly runId: string;
    readonly request: ApprovableToolRequest;
    readonly nowMs: number;
  }) => boolean;
}

export interface CodingToolApprovalBridge extends CodingToolApprovalProofVerifier {
  readonly observePermission: (input: CodingToolApprovalObservation) => boolean;
  readonly activatePermission: (input: CodingToolApprovalActivation) => boolean;
  readonly invalidateRun: (runId: string) => void;
}

export function codingToolApprovalBindingDigest(
  runId: string,
  request:
    | Pick<
        Extract<ApprovableToolRequest, { readonly action: "command" }>,
        "action" | "actionId" | "commandId" | "idempotencyKey"
      >
    | Pick<
        Extract<ApprovableToolRequest, { readonly action: "verification" }>,
        "action" | "actionId" | "idempotencyKey" | "verifierId"
      >,
): string {
  const targetId = request.action === "command" ? request.commandId : request.verifierId;
  const payload = JSON.stringify([
    "coding-tool-approval-v1",
    runId,
    request.action,
    request.actionId,
    request.idempotencyKey,
    targetId,
  ]);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function createCodingToolApprovalBridge(): CodingToolApprovalBridge {
  const pending = new Map<string, PendingApproval>();
  const approved = new Map<string, ApprovedAction>();
  return {
    observePermission: (input): boolean => observePermission(pending, approved, input),
    activatePermission: (input): boolean => activatePermission(pending, approved, input),
    matches: (input): boolean => matchesApprovedAction(approved, input),
    consume: (input): boolean => consumeApprovedAction(approved, input),
    invalidateRun: (runId): void => {
      invalidateRun(pending, approved, runId);
    },
  };
}

function observePermission(
  pending: Map<string, PendingApproval>,
  approved: Map<string, ApprovedAction>,
  input: CodingToolApprovalObservation,
): boolean {
  prune(pending, approved, input.nowMs);
  const expiresAtMs = Date.parse(input.expiresAt);
  if (
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= input.nowMs ||
    input.proof.approvalId !== input.actionId ||
    !validBinding(input) ||
    input.proof.approvalDigest !== bindingDigest(input)
  ) {
    return false;
  }
  const key = permissionKey(input.runId, input.requestId);
  if (pending.has(key) || pending.size >= MAX_PENDING_RECORDS) return false;
  pending.set(key, { ...input, expiresAtMs });
  return true;
}

function activatePermission(
  pending: Map<string, PendingApproval>,
  approved: Map<string, ApprovedAction>,
  input: CodingToolApprovalActivation,
): boolean {
  prune(pending, approved, input.nowMs);
  const key = permissionKey(input.runId, input.requestId);
  const requested = pending.get(key);
  if (
    requested === undefined ||
    input.expiresAtMs <= input.nowMs ||
    !DIGEST_PATTERN.test(input.approvalAuthorityDigest)
  ) {
    return false;
  }
  const approvedKey = actionKey(input.runId, requested.proof.approvalId);
  if (approved.has(approvedKey) || approved.size >= MAX_APPROVED_RECORDS) return false;
  pending.delete(key);
  approved.set(approvedKey, {
    ...requested,
    expiresAtMs: Math.min(requested.expiresAtMs, input.expiresAtMs),
    approvalAuthorityDigest: input.approvalAuthorityDigest,
  });
  return true;
}

function consumeApprovedAction(
  approved: Map<string, ApprovedAction>,
  input: {
    readonly runId: string;
    readonly request: ApprovableToolRequest;
    readonly nowMs: number;
  },
): boolean {
  if (!matchesApprovedAction(approved, input)) return false;
  const proof = input.request.approvalProof;
  if (proof === undefined) return false;
  approved.delete(actionKey(input.runId, proof.approvalId));
  return true;
}

function matchesApprovedAction(
  approved: Map<string, ApprovedAction>,
  input: {
    readonly runId: string;
    readonly request: ApprovableToolRequest;
    readonly nowMs: number;
  },
): boolean {
  pruneApproved(approved, input.nowMs);
  const proof = input.request.approvalProof;
  if (proof === undefined) return false;
  const key = actionKey(input.runId, proof.approvalId);
  const record = approved.get(key);
  const digest = codingToolApprovalBindingDigest(input.runId, input.request);
  return approvedActionMatches(record, input.request, proof, digest);
}

function approvedActionMatches(
  record: ApprovedAction | undefined,
  request: ApprovableToolRequest,
  proof: CodingToolApprovalProof,
  digest: string,
): boolean {
  if (record === undefined) return false;
  return [
    record.action === request.action,
    record.actionId === request.actionId,
    record.idempotencyKey === request.idempotencyKey,
    record.targetId === targetId(request),
    DIGEST_PATTERN.test(record.approvalAuthorityDigest),
    safeDigestEqual(record.proof.approvalDigest, proof.approvalDigest),
    safeDigestEqual(digest, proof.approvalDigest),
  ].every(Boolean);
}

function validBinding(input: CodingToolApprovalObservation): boolean {
  return (
    input.runId.length > 0 &&
    input.requestId.length > 0 &&
    input.actionId.length > 0 &&
    input.idempotencyKey.length > 0 &&
    input.targetId.length > 0 &&
    input.actionId.length <= 512 &&
    input.idempotencyKey.length <= 512 &&
    input.targetId.length <= 512 &&
    DIGEST_PATTERN.test(input.proof.approvalDigest)
  );
}

function bindingDigest(input: ApprovalBinding): string {
  return codingToolApprovalBindingDigest(
    input.runId,
    input.action === "command"
      ? { ...input, action: "command", commandId: input.targetId }
      : { ...input, action: "verification", verifierId: input.targetId },
  );
}

function targetId(request: ApprovableToolRequest): string {
  return request.action === "command" ? request.commandId : request.verifierId;
}

function permissionKey(runId: string, requestId: string): string {
  return `${runId}\u0000${requestId}`;
}

function actionKey(runId: string, approvalId: string): string {
  return `${runId}\u0000${approvalId}`;
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function prune(
  pending: Map<string, PendingApproval>,
  approved: Map<string, ApprovedAction>,
  nowMs: number,
): void {
  for (const [key, record] of pending) {
    if (record.expiresAtMs <= nowMs) pending.delete(key);
  }
  pruneApproved(approved, nowMs);
}

function pruneApproved(approved: Map<string, ApprovedAction>, nowMs: number): void {
  for (const [key, record] of approved) {
    if (record.expiresAtMs <= nowMs) approved.delete(key);
  }
}

function invalidateRun(
  pending: Map<string, PendingApproval>,
  approved: Map<string, ApprovedAction>,
  runId: string,
): void {
  const prefix = `${runId}\u0000`;
  for (const key of pending.keys()) {
    if (key.startsWith(prefix)) pending.delete(key);
  }
  for (const key of approved.keys()) {
    if (key.startsWith(prefix)) approved.delete(key);
  }
}
