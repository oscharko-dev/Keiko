import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { GitDeliveryApprovalRequirement } from "@oscharko-dev/keiko-contracts";
import type {
  PrDescriptionApplicationBinding,
  PrDescriptionApplicationStatus,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import type { GitPrBody, GitPrExecResult, GitPullRequestAdapter } from "@oscharko-dev/keiko-tools";
import { executeGovernedPullRequest } from "./prExecution.js";
import { applicationStatus } from "./prDescriptionProjection.js";
import { assertSafeDescriptionBody, readDescriptionBody } from "./prDescriptionPreparation.js";
import {
  PrDescriptionFailure,
  type PreparedPrDescription,
  type PrDescriptionServiceOptions,
} from "./prDescriptionTypes.js";

export function matchesDescriptionIdentity(
  binding: PrDescriptionApplicationBinding,
  body: GitPrBody,
): boolean {
  const identity = body.identity;
  return (
    identity.state === "open" &&
    identity.repository.toLowerCase() === binding.repository.toLowerCase() &&
    identity.number === binding.prNumber &&
    identity.externalId === binding.prExternalId &&
    identity.baseRef === binding.baseRef &&
    identity.baseSha === binding.baseSha &&
    identity.headRepository.toLowerCase() === binding.headRepository.toLowerCase() &&
    identity.headRef === binding.headRef &&
    identity.headSha === binding.headSha &&
    identity.isDraft === binding.isDraft
  );
}

function matchesObservedReadyTransition(
  binding: PrDescriptionApplicationBinding,
  body: GitPrBody,
): boolean {
  return (
    binding.isDraft &&
    !body.identity.isDraft &&
    matchesDescriptionIdentity({ ...binding, isDraft: false }, body)
  );
}

function reconciledBinding(
  binding: PrDescriptionApplicationBinding,
  remote: GitPrBody,
): PrDescriptionApplicationBinding | undefined {
  if (matchesDescriptionIdentity(binding, remote)) return binding;
  if (!matchesObservedReadyTransition(binding, remote)) return undefined;
  return { ...binding, isDraft: false, providerUpdatedAt: remote.updatedAt };
}
export async function assertDescriptionUnchanged(
  options: PrDescriptionServiceOptions,
  proposal: PreparedPrDescription,
  check: () => boolean,
): Promise<void> {
  if (!check()) throw new PrDescriptionFailure("authority-denied");
  const snapshot = await options.snapshots.recheck(
    proposal.snapshotReference,
    proposal.captureInput,
  );
  if (!check()) throw new PrDescriptionFailure("authority-denied");
  if (snapshot.state !== "current") throw new PrDescriptionFailure("stale-snapshot");
  const remote = await readDescriptionBody(options, proposal.context);
  if (!check()) throw new PrDescriptionFailure("authority-denied");
  const binding = proposal.review.status.binding;
  if (!matchesDescriptionIdentity(binding, remote)) throw new PrDescriptionFailure("stale-pr");
  if (
    sha256Hex(remote.body) !== binding.expectedBodyDigest ||
    remote.updatedAt !== binding.providerUpdatedAt
  )
    throw new PrDescriptionFailure("body-changed");
  assertSafeDescriptionBody(options, proposal.review.finalBody);
}
function command(
  proposal: PreparedPrDescription,
): Parameters<typeof executeGovernedPullRequest>[0] {
  const binding = proposal.review.status.binding;
  // Existing lifecycle/policy/evidence use pr-update. Only the enforced body adapter below has an effect.
  return {
    kind: "pr-update",
    ownerAndRepo: binding.repository,
    prExternalId: String(binding.prNumber),
    headBranchName: binding.headRef,
    baseBranchName: binding.baseRef,
    title: "",
    body: proposal.review.finalBody,
    convertToDraft: false,
    convertFromDraft: false,
  };
}
export async function applyDescription(
  options: PrDescriptionServiceOptions,
  proposal: PreparedPrDescription,
  approval: GitDeliveryApprovalRequirement,
  check: () => boolean,
  now: () => number,
): Promise<boolean> {
  const expected = command(proposal);
  const progress: { refusal?: Error; dispatched: boolean } = { dispatched: false };
  const adapter = bodyEffectAdapter(options, proposal, check, now, progress);
  const result = await executeGovernedPullRequest(
    expected,
    approval,
    proposal.context.workspace,
    options.mutationDeps,
    { ...options.execution, prAdapterFactory: () => adapter, beforeRemoteDispatch: check },
    proposal.context.correlationId,
  );
  if (progress.refusal !== undefined) throw progress.refusal;
  if (!progress.dispatched)
    throw new PrDescriptionFailure(
      result.lifecycle.phaseReached === "policy" ? "policy-blocked" : "authority-denied",
    );
  return result.lifecycle.outcome.status === "succeeded";
}
export function reconciledDescriptionStatus(
  previous: PrDescriptionApplicationStatus,
  remote: GitPrBody,
  confirmed: boolean,
  now: number,
): PrDescriptionApplicationStatus {
  const binding = reconciledBinding(previous.binding, remote);
  if (binding === undefined)
    return applicationStatus(previous.binding, previous.completeness, "stale-pr", "uncertain", now);
  const digest = sha256Hex(remote.body);
  if (digest === binding.finalBodyDigest) {
    const reason =
      previous.completeness === "complete"
        ? successReason(confirmed)
        : (`${previous.completeness}-applied` as const);
    return applicationStatus(
      binding,
      previous.completeness,
      reason,
      confirmed ? "confirmed" : "reconciled",
      now,
    );
  }
  const unchanged = digest === binding.expectedBodyDigest;
  return applicationStatus(
    binding,
    previous.completeness,
    unchanged ? "unchanged-after-write" : "recovery-required",
    unchanged ? "none" : "uncertain",
    now,
  );
}
function successReason(confirmed: boolean): "applied" | "reconciled" {
  return confirmed ? "applied" : "reconciled";
}

function bodyEffectAdapter(
  options: PrDescriptionServiceOptions,
  proposal: PreparedPrDescription,
  check: () => boolean,
  now: () => number,
  progress: { refusal?: Error; dispatched: boolean },
): GitPullRequestAdapter {
  const expected = command(proposal);
  return {
    createPullRequest: (): Promise<GitPrExecResult> => {
      throw new PrDescriptionFailure("invalid-request");
    },
    updatePullRequest: async (request): Promise<GitPrExecResult> => {
      if (
        canonicalise({ kind: "pr-update", headBranchName: expected.headBranchName, ...request }) !==
        canonicalise(expected)
      )
        throw new PrDescriptionFailure("invalid-request");
      try {
        await assertDescriptionUnchanged(options, proposal, check);
      } catch (error) {
        progress.refusal =
          error instanceof Error ? error : new PrDescriptionFailure("provider-failed");
        throw progress.refusal;
      }
      const remote = options.adapter(proposal.context);
      if (remote === undefined) throw new PrDescriptionFailure("provider-failed");
      const journal = applicationStatus(
        proposal.review.status.binding,
        proposal.review.status.completeness,
        "recovery-required",
        "uncertain",
        now(),
      );
      if (!check() || !options.recordStatus(proposal.context, journal))
        throw new PrDescriptionFailure("authority-denied");
      progress.dispatched = true;
      return remote.updatePullRequestBody({
        ownerAndRepo: expected.ownerAndRepo,
        prExternalId: String(proposal.review.status.binding.prNumber),
        body: proposal.review.finalBody,
      });
    },
  };
}
