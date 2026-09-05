import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { JourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-outcome";
import {
  journeyDescriptionApplied,
  journeyEvidenceFresh,
  journeyReadinessCurrent,
} from "@oscharko-dev/keiko-contracts/runtime/git-journey-freshness";
import { isJourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-validation";
import { validateCodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

const ACTIVE = new Set(["ready", "running", "awaiting-approval"]);
export function matchesJourneySnapshot(
  outcome: unknown,
  snapshot: CodingWorkbenchRuntimeSnapshot | undefined,
): outcome is JourneyOutcome {
  if (!isJourneyOutcome(outcome)) return false;
  const parsed = validateCodingWorkbenchRuntimeSnapshot(snapshot);
  const draft = parsed.ok ? parsed.value.draftDelivery : undefined;
  const issue = parsed.ok ? parsed.value.issueBinding : undefined;
  if (draft?.pullRequest === undefined || issue === undefined) return false;
  const binding = outcome.binding;
  return (
    binding.issueBindingDigest === issue.bindingDigest &&
    binding.issueIdDigest === issue.issueIdDigest &&
    binding.issueNumber === issue.issueNumber &&
    matchesDelivery(binding, draft)
  );
}
function matchesDelivery(binding: JourneyOutcome["binding"], draft: DraftDeliveryRecord): boolean {
  const target = draft.binding;
  return (
    binding.runId === target.runId &&
    binding.remoteDigest === target.remoteDigest &&
    binding.repository.toLowerCase() === target.repository.toLowerCase() &&
    binding.prNumber === draft.pullRequest?.number &&
    binding.prExternalId === draft.pullRequest.externalId &&
    binding.headRef === target.headRef &&
    binding.headSha === target.headSha &&
    binding.baseRef === target.baseRef
  );
}

export function journeyDescriptionCurrent(outcome: JourneyOutcome, now: number): boolean {
  return (
    outcome.remote !== null &&
    outcome.keikoDescriptionApplied &&
    journeyDescriptionApplied(outcome.binding, outcome.remote, outcome.description, now)
  );
}
export function journeyCiCurrent(outcome: JourneyOutcome, now: number): boolean {
  return (
    outcome.remote !== null &&
    journeyReadinessCurrent(outcome.binding, outcome.remote, outcome.readiness, now)
  );
}
export function canProposeJourneyReady(
  outcome: JourneyOutcome,
  runtimeState: CodingWorkbenchRuntimeSnapshot["state"] | undefined,
  now: number,
): boolean {
  return (
    runtimeState !== undefined &&
    ACTIVE.has(runtimeState) &&
    outcome.state === "awaiting-ready-approval" &&
    journeyEvidenceFresh(outcome, now) &&
    outcome.remote?.identity.isDraft === true &&
    journeyCiCurrent(outcome, now) &&
    journeyDescriptionCurrent(outcome, now)
  );
}

const READY_STATES = new Set([
  "awaiting-ready-approval",
  "keiko-technical-ready",
  "ready-for-human-review",
  "awaiting-human-requirements",
]);
export function journeyDisplayState(
  outcome: JourneyOutcome,
  now: number,
): JourneyOutcome["state"] | "stale" {
  if (!journeyEvidenceFresh(outcome, now)) return "stale";
  if (
    READY_STATES.has(outcome.state) &&
    (!journeyCiCurrent(outcome, now) || !journeyDescriptionCurrent(outcome, now))
  )
    return "stale";
  return outcome.state;
}
