import type { ReadinessSnapshot } from "./git-ci-readiness.js";
import type { PrDescriptionApplicationStatus } from "./pr-description-application.js";
import type { GitJourneyBinding, GitJourneyRemoteFacts } from "./git-journey-outcome.js";

export function journeyRemoteMatchesTask(
  binding: GitJourneyBinding,
  facts: GitJourneyRemoteFacts,
): boolean {
  const pr = facts.identity;
  return (
    pr.repository.toLowerCase() === binding.repository.toLowerCase() &&
    pr.headRepository.toLowerCase() === binding.repository.toLowerCase() &&
    pr.number === binding.prNumber &&
    pr.externalId === binding.prExternalId &&
    pr.baseRef === binding.baseRef &&
    facts.defaultBranchRef === binding.baseRef &&
    pr.headRef === binding.headRef &&
    pr.headSha === binding.headSha &&
    facts.issue.number === binding.issueNumber
  );
}
export function journeyReadinessMatchesTask(
  binding: GitJourneyBinding,
  value: ReadinessSnapshot,
): boolean {
  return (
    value.runId === binding.runId &&
    value.remoteDigest === binding.remoteDigest &&
    value.repository.toLowerCase() === binding.repository.toLowerCase() &&
    value.prNumber === binding.prNumber &&
    value.baseRef === binding.baseRef &&
    value.headRef === binding.headRef &&
    value.headSha === binding.headSha
  );
}
export function journeyEvidenceFresh(
  value: { readonly observedAt: string; readonly expiresAt: string },
  now: number,
): boolean {
  return (
    Number.isFinite(now) && now >= Date.parse(value.observedAt) && now < Date.parse(value.expiresAt)
  );
}
export function journeyReadinessCurrent(
  binding: GitJourneyBinding,
  facts: GitJourneyRemoteFacts,
  value: ReadinessSnapshot | null,
  now: number,
): boolean {
  return (
    value !== null &&
    journeyRemoteMatchesTask(binding, facts) &&
    journeyReadinessMatchesTask(binding, value) &&
    journeyEvidenceFresh(value, now) &&
    value.baseSha === facts.identity.baseSha &&
    value.pullRequest.isDraft === facts.identity.isDraft &&
    value.pullRequest.status === "open" &&
    facts.identity.state === "open" &&
    facts.mergedAt === null
  );
}
/**
 * The states in which a Keiko description counts as APPLIED to the pull request: the exact model
 * text, a partially admitted one, or the deterministic fallback the renderer substitutes when the
 * model's text asserts what the snapshot cannot back (#3390). All three are complete applications
 * -- the fallback is correct behaviour, not a degraded one -- and every consumer that asks "is the
 * description applied" reads this set rather than restating it.
 */
export const APPLIED_PR_DESCRIPTION_STATES: ReadonlySet<PrDescriptionApplicationStatus["state"]> =
  new Set<PrDescriptionApplicationStatus["state"]>(["current", "partial", "fallback"]);

export function journeyDescriptionApplied(
  binding: GitJourneyBinding,
  facts: GitJourneyRemoteFacts,
  value: PrDescriptionApplicationStatus | null,
  now: number,
): boolean {
  if (
    value === null ||
    !journeyRemoteMatchesTask(binding, facts) ||
    !journeyEvidenceFresh(value, now)
  )
    return false;
  return (
    APPLIED_PR_DESCRIPTION_STATES.has(value.state) &&
    (value.effect === "confirmed" || value.effect === "reconciled") &&
    descriptionIdentity(binding, value.binding) &&
    descriptionRevision(binding, facts, value.binding)
  );
}
function descriptionIdentity(
  binding: GitJourneyBinding,
  pr: PrDescriptionApplicationStatus["binding"],
): boolean {
  return (
    pr.remoteDigest === binding.remoteDigest &&
    pr.repository.toLowerCase() === binding.repository.toLowerCase() &&
    pr.headRepository.toLowerCase() === binding.repository.toLowerCase() &&
    pr.prNumber === binding.prNumber &&
    pr.prExternalId === binding.prExternalId
  );
}
function descriptionRevision(
  binding: GitJourneyBinding,
  facts: GitJourneyRemoteFacts,
  pr: PrDescriptionApplicationStatus["binding"],
): boolean {
  return (
    pr.baseRef === binding.baseRef &&
    pr.baseSha === facts.identity.baseSha &&
    pr.headRef === binding.headRef &&
    pr.headSha === binding.headSha &&
    pr.isDraft === facts.identity.isDraft
  );
}
