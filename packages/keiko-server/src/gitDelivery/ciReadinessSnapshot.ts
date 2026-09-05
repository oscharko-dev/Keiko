import {
  GIT_CI_READINESS_REASON_STATES,
  isReadinessSnapshot,
  type GitDeliveryObservationFailure,
  type ReadinessSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import {
  isDraftDeliveryRecord,
  type DraftDeliveryRecord,
} from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import { isGitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  assessGitCiFacts,
  gitCiCheckCounts,
  type GitCiAssessment,
  type GitCiFactsResult,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";

export interface CiSnapshotResult {
  readonly snapshot: ReadinessSnapshot;
  readonly assessment?: GitCiAssessment;
}
function fallback(
  draft: DraftDeliveryRecord,
  failure: GitDeliveryObservationFailure,
): Omit<GitCiAssessment, "checks"> {
  return {
    reason: failure.reason,
    complete: false,
    requirementsDigest: null,
    strictBaseRequired: false,
    requiredChecks: gitCiCheckCounts(),
    advisoryChecks: gitCiCheckCounts(),
    pullRequest: {
      status: draft.pullRequest?.state ?? "open",
      isDraft: draft.pullRequest?.isDraft ?? true,
      conflict: "unknown",
      baseCurrency: "unknown",
    },
    humanReview: {
      visibility: "unknown",
      requiredCount: null,
      approvedCount: null,
      changesRequestedCount: null,
    },
  };
}
function boundFacts(draft: DraftDeliveryRecord, result: GitCiFactsResult): boolean {
  if (result.status === "unavailable") return true;
  const identity = result.identity;
  return (
    isGitPullRequestIdentity(identity) &&
    [
      identity.repository.toLowerCase() === draft.binding.repository.toLowerCase(),
      identity.headRepository.toLowerCase() === draft.binding.repository.toLowerCase(),
      identity.number === draft.pullRequest?.number,
      identity.externalId === draft.pullRequest?.externalId,
      identity.baseRef === draft.binding.baseRef,
      identity.headRef === draft.binding.headRef,
      identity.headSha === draft.binding.headSha,
    ].every(Boolean)
  );
}
function snapshotFields(
  draft: DraftDeliveryRecord,
  result: GitCiFactsResult,
  observedAtMs: number,
  summary: Omit<GitCiAssessment, "checks">,
): Omit<ReadinessSnapshot, "evidenceRef"> {
  const binding = draft.binding;
  if (draft.pullRequest === undefined)
    throw new TypeError("CI snapshot requires a confirmed pull request");
  return {
    schemaVersion: "1",
    runId: binding.runId,
    remoteDigest: binding.remoteDigest,
    repository: binding.repository,
    prNumber: draft.pullRequest.number,
    baseRef: binding.baseRef,
    baseSha: result.status === "observed" ? result.identity.baseSha : binding.baseSha,
    headRef: binding.headRef,
    headSha: binding.headSha,
    requirementsVersion: "1",
    requirementsDigest: summary.requirementsDigest,
    strictBaseRequired: summary.strictBaseRequired,
    observedAt: new Date(observedAtMs).toISOString(),
    expiresAt: new Date(observedAtMs + 60_000).toISOString(),
    complete: summary.complete,
    state: GIT_CI_READINESS_REASON_STATES[summary.reason],
    reason: summary.reason,
    requiredChecks: summary.requiredChecks,
    advisoryChecks: summary.advisoryChecks,
    pullRequest: summary.pullRequest,
    humanReview: summary.humanReview,
  };
}
/** Only body-free counts and exact identity enter durable runtime evidence; transient source IDs remain outside. */
export function produceCiReadinessSnapshot(
  draft: DraftDeliveryRecord,
  result: GitCiFactsResult,
  observedAtMs: number,
): CiSnapshotResult {
  if (!isDraftDeliveryRecord(draft) || !Number.isSafeInteger(observedAtMs) || observedAtMs < 0)
    throw new TypeError("Invalid CI observation binding or time");
  if (!boundFacts(draft, result))
    throw new TypeError("CI observation does not match accepted draft");
  const assessment = result.status === "observed" ? assessGitCiFacts(result) : undefined;
  const summary =
    assessment ??
    fallback(
      draft,
      result.status === "unavailable"
        ? result.failure
        : { state: "unknown", reason: "malformed-response" },
    );
  const fields = {
    ...snapshotFields(draft, result, observedAtMs, summary),
    ...failureIdentity(assessment),
  };
  const snapshot = Object.freeze({
    ...fields,
    evidenceRef: `ci-${sha256Hex(canonicalise(fields))}`,
  });
  if (!isReadinessSnapshot(snapshot))
    throw new TypeError("Invalid generated CI readiness evidence");
  return { snapshot, ...(assessment === undefined ? {} : { assessment }) };
}
function failureIdentity(assessment: GitCiAssessment | undefined): {
  readonly failureSignatureDigest?: string;
} {
  if (assessment?.checks.status !== "observed") return {};
  const failures = assessment.checks.required
    .filter((check) => check.classification === "failed")
    .map((check) => canonicalise(check.requirement))
    .sort();
  return failures.length === 0
    ? {}
    : {
        failureSignatureDigest: sha256Hex(
          canonicalise({
            requirementsDigest: assessment.requirementsDigest,
            failures,
          }),
        ),
      };
}
type ReadinessRevision = Pick<
  ReadinessSnapshot,
  | "runId"
  | "remoteDigest"
  | "repository"
  | "prNumber"
  | "baseRef"
  | "baseSha"
  | "headRef"
  | "headSha"
  | "requirementsDigest"
>;
/** Fresh evidence still needs separate current authority and action-specific approval at its consumer. */
export function ciReadinessIsCurrent(
  snapshot: ReadinessSnapshot,
  current: ReadinessRevision,
  nowMs: number,
): boolean {
  if (!isReadinessSnapshot(snapshot) || !Number.isSafeInteger(nowMs)) return false;
  if (Date.parse(snapshot.observedAt) > nowMs || Date.parse(snapshot.expiresAt) <= nowMs)
    return false;
  const keys: readonly (keyof ReadinessRevision)[] = [
    "runId",
    "remoteDigest",
    "repository",
    "prNumber",
    "baseRef",
    "baseSha",
    "headRef",
    "headSha",
    "requirementsDigest",
  ];
  if (
    Object.keys(current).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(current, key))
  )
    return false;
  return keys.every((key) => current[key] === snapshot[key]);
}
