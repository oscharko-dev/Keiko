import type { DraftDeliveryService } from "../gitDelivery/draftDeliveryTypes.js";
import { isDraftToolRequest } from "./codingRuntimeDeliveryIpc.js";
import type { RuntimeGitService } from "../gitDelivery/runtimeGitService.js";
import type { GitDeliveryApprovalClaim } from "@oscharko-dev/keiko-contracts";
import type { VerifiedCommitService } from "../gitDelivery/verifiedCommitTypes.js";
import type { GitDeliveryIssuedApproval } from "../gitDelivery/approvalStore.js";
import { createHash, timingSafeEqual } from "node:crypto";

import type { CodingToolActionRequest, CodingToolApprovalProof } from "./codingToolIpc.js";

const MAX_PENDING_RECORDS = 64;
const MAX_APPROVED_RECORDS = 64;
const MAX_BINDING_RECORDS = 64;
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

export type CommitToolRequest = Extract<CodingToolActionRequest, { readonly action: "delivery" }>;
export interface CodingToolApprovalProofVerifier {
  readonly matchesDelivery?: (runId: string, request: CommitToolRequest) => boolean;
  readonly consumeDelivery?: (runId: string, request: CommitToolRequest) => object | undefined;
  readonly matchesStage?: (runId: string, proposalId: string) => boolean;
  readonly consumeStage?: (runId: string, proposalId: string) => object | undefined;
  readonly matchesCommit?: (runId: string, request: CommitToolRequest) => boolean;
  readonly consumeCommit?: (runId: string, request: CommitToolRequest) => object | undefined;
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
  readonly deliveryService?: DraftDeliveryService;
  readonly issueDelivery?: (
    runId: string,
    proposalId: string,
  ) => GitDeliveryIssuedApproval | undefined;
  readonly gitService?: RuntimeGitService;
  readonly issueStage?: (
    runId: string,
    proposalId: string,
  ) => GitDeliveryIssuedApproval | undefined;
  readonly issueCommit?: (
    runId: string,
    proposalId: string,
  ) => GitDeliveryIssuedApproval | undefined;
  readonly commitService?: VerifiedCommitService;
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

export function createCodingToolApprovalBridge(
  commitService?: VerifiedCommitService,
  gitService?: RuntimeGitService,
  deliveryService?: DraftDeliveryService,
): CodingToolApprovalBridge {
  const pending = new Map<string, PendingApproval>();
  const approved = new Map<string, ApprovedAction>();
  const bindings = new Map<string, number>();
  return {
    ...(commitService === undefined ? {} : commitApprovalMethods(commitService)),
    ...(gitService === undefined ? {} : stageApprovalMethods(gitService)),
    ...(deliveryService === undefined ? {} : deliveryApprovalMethods(deliveryService)),
    observePermission: (input): boolean => observePermission(pending, approved, bindings, input),
    activatePermission: (input): boolean => activatePermission(pending, approved, bindings, input),
    matches: (input): boolean => matchesApprovedAction(approved, input),
    consume: (input): boolean => consumeApprovedAction(approved, input),
    invalidateRun: (runId): void => {
      invalidateRun(pending, approved, bindings, runId);
      commitService?.invalidate();
      gitService?.invalidate();
      deliveryService?.invalidate();
    },
  };
}

function stageApprovalMethods(
  service: RuntimeGitService,
): Pick<CodingToolApprovalBridge, "gitService" | "matchesStage" | "consumeStage" | "issueStage"> {
  return {
    gitService: service,
    matchesStage: (runId, id) => service.review(id)?.runId === runId && service.matchesApproval(id),
    consumeStage: (runId, id) =>
      service.review(id)?.runId === runId ? service.consumeApproval(id) : undefined,
    issueStage: (runId, id) =>
      service.review(id)?.runId === runId ? service.issueApproval(id) : undefined,
  };
}

function commitApprovalMethods(
  service: VerifiedCommitService,
): Pick<
  CodingToolApprovalBridge,
  "matchesCommit" | "consumeCommit" | "issueCommit" | "commitService"
> {
  return {
    commitService: service,
    matchesCommit: (runId, request): boolean =>
      matchingCommit(service, runId, request) &&
      service.matchesApproval(request.proposalId ?? "", commitClaim(request)),
    consumeCommit: (runId, request): object | undefined =>
      matchingCommit(service, runId, request)
        ? service.consumeApproval(request.proposalId ?? "", commitClaim(request))
        : undefined,
    issueCommit: (runId, proposalId): GitDeliveryIssuedApproval | undefined =>
      service.review(proposalId)?.binding.runId === runId
        ? service.issueApproval(proposalId)
        : undefined,
  };
}
function matchingCommit(
  service: VerifiedCommitService,
  runId: string,
  request: CommitToolRequest,
): boolean {
  return (
    request.intent === "commit" &&
    request.phase === "execute" &&
    service.review(request.proposalId ?? "")?.binding.runId === runId
  );
}
function commitClaim(request: CommitToolRequest): GitDeliveryApprovalClaim | undefined {
  const proof = request.approvalProof;
  return proof === undefined
    ? undefined
    : { schemaVersion: "1", approvalId: proof.approvalId, approvalToken: proof.approvalDigest };
}

function observePermission(
  pending: Map<string, PendingApproval>,
  approved: Map<string, ApprovedAction>,
  bindings: Map<string, number>,
  input: CodingToolApprovalObservation,
): boolean {
  prune(pending, approved, bindings, input.nowMs);
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
  const exactBindingKey = bindingKey(input);
  if (
    pending.has(key) ||
    bindings.has(exactBindingKey) ||
    pending.size >= MAX_PENDING_RECORDS ||
    bindings.size >= MAX_BINDING_RECORDS
  ) {
    return false;
  }
  pending.set(key, { ...input, expiresAtMs });
  bindings.set(exactBindingKey, expiresAtMs);
  return true;
}

function activatePermission(
  pending: Map<string, PendingApproval>,
  approved: Map<string, ApprovedAction>,
  bindings: Map<string, number>,
  input: CodingToolApprovalActivation,
): boolean {
  prune(pending, approved, bindings, input.nowMs);
  const key = permissionKey(input.runId, input.requestId);
  const requested = pending.get(key);
  if (
    requested === undefined ||
    input.expiresAtMs <= input.nowMs ||
    !DIGEST_PATTERN.test(input.approvalAuthorityDigest)
  ) {
    return false;
  }
  const approvedKey = bindingKey(requested);
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
  approved.delete(requestBindingKey(input.runId, input.request));
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
  const key = requestBindingKey(input.runId, input.request);
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
    record.proof.approvalId === proof.approvalId,
    proof.approvalId === request.actionId,
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

function bindingKey(input: ApprovalBinding): string {
  return `${input.runId}\u0000${bindingDigest(input)}`;
}

function requestBindingKey(runId: string, request: ApprovableToolRequest): string {
  return `${runId}\u0000${codingToolApprovalBindingDigest(runId, request)}`;
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function prune(
  pending: Map<string, PendingApproval>,
  approved: Map<string, ApprovedAction>,
  bindings: Map<string, number>,
  nowMs: number,
): void {
  for (const [key, record] of pending) {
    if (record.expiresAtMs <= nowMs) pending.delete(key);
  }
  pruneApproved(approved, nowMs);
  for (const [key, expiresAtMs] of bindings) {
    if (expiresAtMs <= nowMs) bindings.delete(key);
  }
}

function pruneApproved(approved: Map<string, ApprovedAction>, nowMs: number): void {
  for (const [key, record] of approved) {
    if (record.expiresAtMs <= nowMs) approved.delete(key);
  }
}

function invalidateRun(
  pending: Map<string, PendingApproval>,
  approved: Map<string, ApprovedAction>,
  bindings: Map<string, number>,
  runId: string,
): void {
  const prefix = `${runId}\u0000`;
  for (const key of pending.keys()) {
    if (key.startsWith(prefix)) pending.delete(key);
  }
  for (const key of approved.keys()) {
    if (key.startsWith(prefix)) approved.delete(key);
  }
  for (const key of bindings.keys()) {
    if (key.startsWith(prefix)) bindings.delete(key);
  }
}

function matchingDelivery(
  service: DraftDeliveryService,
  runId: string,
  request: CommitToolRequest,
): boolean {
  if (!isDraftToolRequest(request) || request.phase !== "execute") return false;
  const review = service.review(request.proposalId ?? "");
  return (
    review?.record.binding.runId === runId &&
    (review.record.phase === "push-proposed"
      ? request.intent === "push"
      : request.intent === "pull-request")
  );
}
function deliveryApprovalMethods(
  service: DraftDeliveryService,
): Pick<
  CodingToolApprovalBridge,
  "deliveryService" | "issueDelivery" | "matchesDelivery" | "consumeDelivery"
> {
  return {
    deliveryService: service,
    issueDelivery: (runId, id) =>
      service.review(id)?.record.binding.runId === runId ? service.issueApproval(id) : undefined,
    matchesDelivery: (runId, request) =>
      matchingDelivery(service, runId, request) &&
      service.matchesApproval(request.proposalId ?? ""),
    consumeDelivery: (runId, request) =>
      matchingDelivery(service, runId, request)
        ? service.consumeApproval(request.proposalId ?? "")
        : undefined,
  };
}
