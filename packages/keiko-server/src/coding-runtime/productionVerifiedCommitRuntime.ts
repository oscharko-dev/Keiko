import { RuntimeGitService } from "../gitDelivery/runtimeGitService.js";
import type {
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts";
import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { correlationIdOrUnknown } from "../correlation.js";
import { createVerifiedCommitService } from "../gitDelivery/verifiedCommitService.js";
import type {
  VerifiedCommitRunContext,
  VerifiedCommitService,
  VerifiedCommitServiceOptions,
} from "../gitDelivery/verifiedCommitTypes.js";
import type { CodingRuntimeTrustedContext } from "./runtimeAuthorityService.js";

export interface VerifiedCommitRuntimeDependencies extends Omit<
  VerifiedCommitServiceOptions,
  "context" | "policyAllowsWithoutApproval"
> {
  readonly resolveWorkspace: (root: string) => WorkspaceInfo | undefined;
  readonly buffersClean: (root: string, runId: string) => boolean;
}
export interface VerifiedCommitRuntimeBinding {
  readonly runId: string;
  readonly envelopeDigest: string;
  readonly context: CodingRuntimeTrustedContext;
  readonly stillAuthorized: () => boolean;
  readonly policyAllowsWithoutApproval?: (() => boolean) | undefined;
  readonly signal: AbortSignal;
}
export function createProductionVerifiedCommitService(
  deps: VerifiedCommitRuntimeDependencies | undefined,
  binding: VerifiedCommitRuntimeBinding,
): VerifiedCommitService | undefined {
  return deps === undefined
    ? undefined
    : createVerifiedCommitService({
        ...deps,
        context: () => resolveVerifiedCommitContext(deps, binding),
        policyAllowsWithoutApproval: binding.policyAllowsWithoutApproval ?? (() => false),
      });
}
export function resolveVerifiedCommitContext(
  deps: VerifiedCommitRuntimeDependencies,
  binding: VerifiedCommitRuntimeBinding,
): VerifiedCommitRunContext | undefined {
  const context = binding.context;
  const snapshot = deps.snapshots.get(binding.runId);
  const workspace = deps.resolveWorkspace(context.workspaceRoot);
  const repositoryDigest = context.repositoryIdentity?.digest;
  if (
    snapshot === undefined ||
    workspace?.root !== context.workspaceRoot ||
    repositoryDigest === undefined
  )
    return undefined;
  return {
    runId: binding.runId,
    envelopeDigest: binding.envelopeDigest,
    runtimeAuthorityDigest: snapshot.authorityDigest,
    workspaceDigest: snapshot.workspaceDigest,
    repositoryDigest,
    workspace,
    baseRef: context.branch.baseRef,
    headRef: context.branch.headRef,
    correlationId: correlationIdOrUnknown(binding.runId),
    signal: binding.signal,
    stillAuthorized: binding.stillAuthorized,
    buffersClean: () => deps.buffersClean(context.workspaceRoot, binding.runId),
    ...(context.issueBinding === undefined
      ? {}
      : { issueBindingDigest: context.issueBinding.bindingDigest }),
  };
}
export function requestVerifiedCommitApproval(
  service: VerifiedCommitService | undefined,
  proposalId: string,
  onEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): void {
  const proposal = service?.review(proposalId);
  if (proposal === undefined) return;
  const event: CodingWorkbenchRuntimeEvent = {
    schemaVersion: "1",
    eventId: `event-${proposalId}`,
    runId: proposal.binding.runId,
    occurredAt: proposal.review.verifiedCommit?.result.recordedAt ?? new Date().toISOString(),
    kind: "permission-requested",
    permissionRequest: {
      requestId: proposalId,
      kind: "delivery-substrate",
      actionClass: "delivery-substrate",
      reasonCode: "commit-approval-required",
      actionKind: "commit",
      risk: "high",
      expiresAt: new Date(proposal.expiresAtMs).toISOString(),
    },
  };
  if (!validateCodingWorkbenchRuntimeEvent(event).ok)
    throw new Error("verified-commit-permission-invalid");
  onEvent(event);
}

export function createProductionRuntimeGitService(
  deps: VerifiedCommitRuntimeDependencies | undefined,
  binding: VerifiedCommitRuntimeBinding,
  mode: () => CodingWorkbenchMode | undefined,
  invalidateVerification: () => void,
): RuntimeGitService | undefined {
  return deps === undefined
    ? undefined
    : new RuntimeGitService({
        ...deps,
        context: () => resolveVerifiedCommitContext(deps, binding),
        mode,
        invalidateVerification,
      });
}
export function requestRuntimeStageApproval(
  service: RuntimeGitService | undefined,
  proposalId: string,
  onEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): void {
  const proposal = service?.review(proposalId);
  if (proposal === undefined) return;
  const event: CodingWorkbenchRuntimeEvent = {
    schemaVersion: "1",
    eventId: `event-${proposalId}`,
    runId: proposal.runId,
    occurredAt: new Date().toISOString(),
    kind: "permission-requested",
    permissionRequest: {
      requestId: proposalId,
      kind: "workspace-write",
      actionClass: "workspace-write",
      reasonCode: "stage-approval-required",
      actionKind: "git-stage",
      risk: "medium",
      expiresAt: new Date(proposal.expiresAtMs).toISOString(),
    },
  };
  if (!validateCodingWorkbenchRuntimeEvent(event).ok)
    throw new Error("git-stage-permission-invalid");
  onEvent(event);
}
