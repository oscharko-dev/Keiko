import { createHash, randomBytes } from "node:crypto";
import type {
  CodingWorkbenchRuntimeEvent,
  CodingWorkbenchRuntimePendingApprovalReview,
} from "@oscharko-dev/keiko-contracts";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import { DraftDeliveryController } from "../gitDelivery/draftDeliveryService.js";
import type {
  DraftDeliveryDependencies,
  DraftDeliveryService,
  DraftDeliveryRunContext,
} from "../gitDelivery/draftDeliveryTypes.js";
import {
  resolveVerifiedCommitContext,
  type VerifiedCommitRuntimeBinding,
  type VerifiedCommitRuntimeDependencies,
} from "./productionVerifiedCommitRuntime.js";
import type { ProductionManagedWorktreeToolInput } from "./productionManagedWorktreeTools.js";
import type { GovernedCodingToolResult } from "./codingToolGovernedDelegate.js";
import type { CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import type { DraftToolRequest } from "./codingRuntimeDeliveryIpc.js";

export function createProductionDraftDeliveryService(
  deps: DraftDeliveryDependencies | undefined,
  verified: VerifiedCommitRuntimeDependencies | undefined,
  binding: VerifiedCommitRuntimeBinding,
  onEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): DraftDeliveryService | undefined {
  if (deps === undefined || verified === undefined) return undefined;
  return new DraftDeliveryController({
    ...deps,
    context: (): DraftDeliveryRunContext | undefined =>
      resolveDraftDeliveryContext(verified, binding),
    onChanged: (record): void => {
      publishDraftDeliveryRecord(record, onEvent);
    },
  });
}
export function resolveDraftDeliveryContext(
  verified: VerifiedCommitRuntimeDependencies,
  binding: VerifiedCommitRuntimeBinding,
): DraftDeliveryRunContext | undefined {
  const context = resolveVerifiedCommitContext(verified, binding);
  const issueBinding = binding.context.issueBinding;
  return context === undefined || issueBinding === undefined
    ? undefined
    : {
        ...context,
        taskId: binding.context.taskId,
        workspaceId: binding.context.workspaceId,
        issueBinding,
      };
}
function emit(
  event: CodingWorkbenchRuntimeEvent,
  onEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): void {
  if (!validateCodingWorkbenchRuntimeEvent(event).ok)
    throw new Error("draft-delivery-event-invalid");
  onEvent(event);
}
export function publishDraftDeliveryRecord(
  record: DraftDeliveryRecord,
  onEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): void {
  const encoded = JSON.stringify(record);
  emit(
    {
      schemaVersion: "1",
      eventId: `event-${BigInt(`0x${randomBytes(16).toString("hex")}`).toString(10)}`,
      runId: record.binding.runId,
      occurredAt: record.recordedAt,
      kind: "artifact-produced",
      artifactKind: "delivery",
      artifactLabel: "record",
      artifactDigest: createHash("sha256").update(encoded).digest("hex"),
      artifactBytes: Buffer.byteLength(encoded, "utf8"),
    },
    onEvent,
  );
}
export function draftPendingApprovalReview(
  service: DraftDeliveryService | undefined,
  runId: string,
  id: string,
): CodingWorkbenchRuntimePendingApprovalReview | undefined {
  const proposal = service?.review(id);
  return proposal?.record.binding.runId !== runId
    ? undefined
    : {
        requestId: id,
        paths: [],
        pathsTruncated: false,
        fileCount: 0,
        addedLines: 0,
        deletedLines: 0,
        draftDelivery: proposal.review,
      };
}
export function requestDraftDeliveryApproval(
  service: DraftDeliveryService | undefined,
  proposalId: string,
  onEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): void {
  const proposal = service?.review(proposalId);
  if (proposal === undefined) return;
  const actionKind = proposal.record.phase === "push-proposed" ? "push" : "pull-request";
  emit(
    {
      schemaVersion: "1",
      eventId: `event-${proposalId}`,
      runId: proposal.record.binding.runId,
      occurredAt: proposal.record.recordedAt,
      kind: "permission-requested",
      permissionRequest: {
        requestId: proposalId,
        kind: "delivery-substrate",
        actionClass: "delivery-substrate",
        actionKind,
        reasonCode: `${actionKind}-approval-required`,
        risk: "high",
        expiresAt: new Date(proposal.expiresAtMs).toISOString(),
      },
    },
    onEvent,
  );
}
export async function runDraftDeliveryRequest(
  input: ProductionManagedWorktreeToolInput,
  request: DraftToolRequest,
  guard: CodingToolMutationGuard,
  signal: AbortSignal | undefined,
): Promise<GovernedCodingToolResult> {
  const service = input.draftDeliveryService;
  if (service === undefined)
    return { status: "failed", reasonCode: "capability-backend-unavailable" };
  const result = await dispatchDraft(service, request, guard, signal);
  if (
    result.status === "recorded" &&
    (result.record.phase === "push-proposed" || result.record.phase === "pr-proposed")
  )
    input.requestDraftDeliveryApproval?.(result.record.proposalId);
  return { status: "completed", draftDelivery: result };
}
function dispatchDraft(
  service: DraftDeliveryService,
  request: DraftToolRequest,
  guard: CodingToolMutationGuard,
  signal: AbortSignal | undefined,
): ReturnType<DraftDeliveryService["proposePush"]> {
  if (request.phase === "reconcile") return service.reconcile();
  if (request.phase === "propose")
    return request.intent === "push"
      ? service.proposePush()
      : service.proposePullRequest(request.title ?? "");
  return guard.deliveryApproval === undefined
    ? Promise.resolve({ status: "unavailable", reason: "proposal-unavailable" })
    : service.executeApproved(request.proposalId ?? "", guard.deliveryApproval, {
        check: guard.check,
        signal,
      });
}
