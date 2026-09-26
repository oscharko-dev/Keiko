import { describe, expect, it } from "vitest";
import {
  GIT_JOURNEY_REASON_STATES,
  type GitJourneyBinding,
  type GitJourneyReason,
  type GitJourneyRemoteFacts,
  type JourneyOutcome,
} from "./git-journey-outcome.js";
import {
  isGitJourneyBinding,
  isGitJourneyRemoteFacts,
  isJourneyOutcome,
} from "./git-journey-validation.js";
import type { GitPullRequestIdentity } from "./git-pull-request-identity.js";

const AT = "2026-09-05T00:00:00.000Z";
const EXPIRES = "2026-09-05T00:00:30.000Z";
const DIGEST = "a".repeat(64);

const BINDING: GitJourneyBinding = {
  runId: "run-1",
  remoteDigest: DIGEST,
  issueBindingDigest: "b".repeat(64),
  issueIdDigest: "c".repeat(64),
  issueNumber: 7,
  repository: "owner/repo",
  prNumber: 42,
  prExternalId: "PR_kwTest",
  baseRef: "main",
  headRef: "feature",
  headSha: "d".repeat(40),
};

const IDENTITY: GitPullRequestIdentity = {
  number: 42,
  externalId: "PR_kwTest",
  url: "https://github.com/owner/repo/pull/42",
  repository: "owner/repo",
  headRepository: "owner/repo",
  headRef: "feature",
  headSha: "d".repeat(40),
  baseRef: "main",
  baseSha: "e".repeat(40),
  state: "open",
  isDraft: false,
};

const REMOTE: GitJourneyRemoteFacts = {
  status: "observed",
  identity: IDENTITY,
  repositoryId: 41,
  defaultBranchRef: "main",
  mergedAt: null,
  mergeCommitSha: null,
  reviewDecision: "unknown",
  issue: { number: 7, state: "open", closedAt: null },
  reviewConversations: { total: 0, unresolved: 0, resolved: 0 },
  factsDigest: "f".repeat(64),
};

const REMOTE_MERGED: GitJourneyRemoteFacts = {
  ...REMOTE,
  identity: { ...IDENTITY, state: "closed" },
  mergedAt: AT,
  mergeCommitSha: "1".repeat(40),
  issue: { number: 7, state: "closed", closedAt: AT },
};

// Owner audit finding b1-25: the closed vocabulary of reasons a remote-absent outcome may declare
// is a REASON allowlist, not a STATE allowlist — most "blocked"-state reasons (closed-unmerged,
// issue-closed-without-merge, retargeted, head-changed, every readiness-/description-* reason)
// describe a specific fact that can only come from an actually observed remote
// (`journeyOutcome.ts`'s `reason()`: those are reached only once `facts.status === "observed"`).
// Only these five reasons are ever produced WITHOUT an observed remote.
const REMOTE_ABSENT_REASONS = new Set([
  "provider-unavailable",
  "authority-denied",
  "observation-superseded",
  "cancelled",
  "ready-effect-uncertain",
]);

function outcomeBase(reason: GitJourneyReason): JourneyOutcome {
  return {
    schemaVersion: "1",
    binding: BINDING,
    state: GIT_JOURNEY_REASON_STATES[reason],
    reason,
    observedAt: AT,
    expiresAt: EXPIRES,
    evidenceRef: "journey-test",
    remote: null,
    observationFailure: null,
    readiness: null,
    description: null,
    keikoDescriptionApplied: false,
  };
}

const OUTCOME_COMPLETED: JourneyOutcome = {
  schemaVersion: "1",
  binding: BINDING,
  state: "completed",
  reason: "merge-and-closure-observed",
  observedAt: AT,
  expiresAt: EXPIRES,
  evidenceRef: "journey-test-completed",
  remote: REMOTE_MERGED,
  observationFailure: null,
  readiness: null,
  description: null,
  keikoDescriptionApplied: false,
};

describe("accepted task identity binding", () => {
  it("admits the bounded identity and rejects prototype-inherited padding", () => {
    expect(isGitJourneyBinding(BINDING)).toBe(true);
    const padded = Object.assign(Object.create(BINDING) as object, { body: "leak" });
    expect(isGitJourneyBinding(padded)).toBe(false);
  });
  it.each([
    { runId: "" },
    { remoteDigest: "not-hex" },
    { issueBindingDigest: "a".repeat(63) },
    { issueIdDigest: "A".repeat(64) },
    { issueNumber: 0 },
    { issueNumber: 1.5 },
    { prNumber: -1 },
    { repository: "not/a/valid/repo" },
    { prExternalId: "" },
    { baseRef: BINDING.headRef },
    { baseRef: "refs/heads/main" },
    { headSha: "z".repeat(40) },
    { extra: "leak" },
  ])("rejects malformed, self-referential or padded binding %j", (patch) => {
    expect(isGitJourneyBinding({ ...BINDING, ...patch })).toBe(false);
  });
});

describe("bounded canonical provider facts", () => {
  it("admits the canonical facts and rejects prototype-inherited padding", () => {
    expect(isGitJourneyRemoteFacts(REMOTE)).toBe(true);
    const padded = Object.assign(Object.create(REMOTE) as object, { body: "leak" });
    expect(isGitJourneyRemoteFacts(padded)).toBe(false);
  });
  it.each([
    { status: "unavailable" },
    { reviewDecision: "bogus" },
    { reviewConversations: { total: 2, unresolved: 1, resolved: 2 } },
    { issue: { number: 7, state: "open", closedAt: AT } },
    { issue: { number: 7, state: "closed", closedAt: null } },
    { mergedAt: AT, mergeCommitSha: null },
    { mergedAt: AT, mergeCommitSha: "1".repeat(40) },
    { factsDigest: "not-hex" },
    { repositoryId: 0 },
    { defaultBranchRef: "refs/heads/main" },
    { extra: "leak" },
  ])("rejects contradictory or malformed remote facts %j", (patch) => {
    expect(isGitJourneyRemoteFacts({ ...REMOTE, ...patch })).toBe(false);
  });
});

describe("closed reason/state vocabulary consumed at the wire boundary", () => {
  it.each(Object.keys(GIT_JOURNEY_REASON_STATES) as GitJourneyReason[])(
    "admits a remote-absent outcome for %s only when the reason itself never requires an observed remote",
    (reason) => {
      const expected = REMOTE_ABSENT_REASONS.has(reason);
      expect(isJourneyOutcome(outcomeBase(reason))).toBe(expected);
    },
  );
  // The precise regression this vocabulary test now pins: three "blocked"-state reasons that DO
  // require an observed remote, each rejected with `remote: null` even though every one of them
  // shares its collapsed state with a genuinely remote-absent reason.
  it.each(["closed-unmerged", "retargeted", "head-changed"] as GitJourneyReason[])(
    "rejects %s with remote: null even though it shares the blocked state with provider-unavailable",
    (reason) => {
      expect(GIT_JOURNEY_REASON_STATES[reason]).toBe("blocked");
      expect(isJourneyOutcome(outcomeBase(reason))).toBe(false);
    },
  );
  it("rejects a reason whose declared state contradicts the closed vocabulary", () => {
    const outcome = outcomeBase("readiness-unavailable");
    expect(isJourneyOutcome({ ...outcome, state: "cancelled" })).toBe(false);
    expect(isJourneyOutcome({ ...outcome, reason: "not-a-real-reason" })).toBe(false);
  });
  it("rejects a remote-absent outcome that still claims the description was applied", () => {
    const outcome = outcomeBase("readiness-unavailable");
    expect(isJourneyOutcome({ ...outcome, keikoDescriptionApplied: true })).toBe(false);
  });
});

describe("observed completion outcome", () => {
  it("admits the merged-and-closed observation", () => {
    expect(isJourneyOutcome(OUTCOME_COMPLETED)).toBe(true);
  });
  it.each([
    { observationFailure: { reason: "cancelled", state: "blocked" } },
    { remote: { ...REMOTE_MERGED, body: "leak" } },
    { body: "leak" },
    { readiness: { bogus: true } },
    { keikoDescriptionApplied: true },
  ])("rejects a completion outcome that leaks or contradicts a bound field %j", (patch) => {
    expect(isJourneyOutcome({ ...OUTCOME_COMPLETED, ...patch })).toBe(false);
  });
});
