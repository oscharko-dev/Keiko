// git-journey-freshness.ts previously had no unit test in its own package: its behaviour was only
// pinned indirectly through keiko-server's journeyOutcome.test.ts and keiko-ui's presentation
// layer, neither of which counts toward keiko-contracts coverage (#3394). This file exercises every
// exported function directly, including the merged-delivered-head rule added for #3390: once a
// pull request has merged, `journeyDescriptionApplied` stops requiring a fresh observation and
// instead asks only whether the description was recorded against exactly the head that merged
// (`descriptionDeliveredHead`). Fixtures mirror the shared BINDING/IDENTITY/FACTS shape used by
// git-journey-outcome.test.ts and git-journey-validation.test.ts in this directory.

import { describe, expect, it } from "vitest";
import {
  APPLIED_PR_DESCRIPTION_STATES,
  journeyDescriptionApplied,
  journeyEvidenceFresh,
  journeyReadinessCurrent,
  journeyReadinessMatchesTask,
  journeyRemoteMatchesTask,
} from "./git-journey-freshness.js";
import type { GitJourneyBinding, GitJourneyRemoteFacts } from "./git-journey-outcome.js";
import type { GitPullRequestIdentity } from "./git-pull-request-identity.js";
import type { ReadinessSnapshot } from "./git-ci-readiness.js";
import type { PrDescriptionApplicationStatus } from "./pr-description-application.js";

const AT = "2026-09-05T00:00:00.000Z";
const EXPIRES = "2026-09-05T00:00:30.000Z";
const NOW = Date.parse(AT);

const BINDING: GitJourneyBinding = {
  runId: "run-1",
  remoteDigest: "a".repeat(64),
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

const FACTS: GitJourneyRemoteFacts = {
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

// A closed, merged remote observation of the same accepted task (#3390 rehearsal run-24): the head
// that merged is exactly the bound head, so a durable description receipt recorded on that head
// stays valid however long ago it was last observed.
const FACTS_MERGED: GitJourneyRemoteFacts = {
  ...FACTS,
  identity: { ...IDENTITY, state: "closed" },
  mergedAt: "2026-09-05T01:00:00.000Z",
  mergeCommitSha: "1".repeat(40),
  issue: { ...FACTS.issue, state: "closed", closedAt: "2026-09-05T01:00:00.000Z" },
};

const COUNTS = { total: 1, passed: 1, failed: 0, pending: 0, blocked: 0, unknown: 0 };

const READINESS: ReadinessSnapshot = {
  schemaVersion: "1",
  runId: "run-1",
  remoteDigest: "a".repeat(64),
  repository: "owner/repo",
  prNumber: 42,
  baseRef: "main",
  baseSha: "e".repeat(40),
  headRef: "feature",
  headSha: "d".repeat(40),
  requirementsVersion: "1",
  requirementsDigest: "b".repeat(64),
  strictBaseRequired: true,
  observedAt: AT,
  expiresAt: EXPIRES,
  evidenceRef: "journey-freshness-test",
  complete: true,
  state: "technical-ready",
  reason: "required-checks-passed",
  requiredChecks: COUNTS,
  advisoryChecks: COUNTS,
  pullRequest: { status: "open", isDraft: false, conflict: "clear", baseCurrency: "current" },
  humanReview: {
    visibility: "complete",
    requiredCount: 1,
    approvedCount: 1,
    changesRequestedCount: 0,
  },
};

const DESCRIPTION: PrDescriptionApplicationStatus = {
  schemaVersion: "1",
  state: "current",
  reason: "applied",
  binding: {
    repositoryId: "repository-1",
    remoteDigest: "a".repeat(64),
    repository: "owner/repo",
    prNumber: 42,
    prExternalId: "PR_kwTest",
    baseRef: "main",
    baseSha: "e".repeat(40),
    headRepository: "owner/repo",
    headRef: "feature",
    headSha: "d".repeat(40),
    isDraft: false,
    snapshotDigest: "b".repeat(64),
    draftDigest: "c".repeat(64),
    renderingVersion: "1",
    expectedBodyDigest: "d".repeat(64),
    outsideRegionDigest: "e".repeat(64),
    finalBodyDigest: "f".repeat(64),
    providerUpdatedAt: AT,
  },
  observedAt: AT,
  expiresAt: EXPIRES,
  completeness: "complete",
  effect: "confirmed",
  concurrency: "read-check-write-verify",
};

// The same applied description, but observed and expired long before the merge -- used to prove
// that once a delivered head has merged, freshness of the receipt no longer matters (#3390).
const STALE_DESCRIPTION: PrDescriptionApplicationStatus = {
  ...DESCRIPTION,
  observedAt: "2020-01-01T00:00:00.000Z",
  expiresAt: "2020-01-01T00:01:00.000Z",
};

describe("journeyRemoteMatchesTask", () => {
  it("matches an identical remote identity, including case-insensitive repository slugs", () => {
    expect(journeyRemoteMatchesTask(BINDING, FACTS)).toBe(true);
    expect(
      journeyRemoteMatchesTask(BINDING, {
        ...FACTS,
        identity: { ...IDENTITY, repository: "OWNER/REPO", headRepository: "Owner/Repo" },
      }),
    ).toBe(true);
  });
  it.each([
    { repository: "other/repo" },
    { headRepository: "other/repo" },
    { number: 999 },
    { externalId: "PR_other" },
    { baseRef: "release" },
    { headRef: "other-branch" },
    { headSha: "9".repeat(40) },
  ])("rejects a remote identity mismatch %j", (patch) => {
    expect(
      journeyRemoteMatchesTask(BINDING, { ...FACTS, identity: { ...IDENTITY, ...patch } }),
    ).toBe(false);
  });
  it("rejects a default branch that drifted from the bound base ref", () => {
    expect(journeyRemoteMatchesTask(BINDING, { ...FACTS, defaultBranchRef: "release" })).toBe(
      false,
    );
  });
  it("rejects an observed issue number that does not match the bound issue", () => {
    expect(
      journeyRemoteMatchesTask(BINDING, { ...FACTS, issue: { ...FACTS.issue, number: 999 } }),
    ).toBe(false);
  });
});

describe("journeyReadinessMatchesTask", () => {
  it("matches an identical readiness identity, including a case-insensitive repository slug", () => {
    expect(journeyReadinessMatchesTask(BINDING, READINESS)).toBe(true);
    expect(journeyReadinessMatchesTask(BINDING, { ...READINESS, repository: "OWNER/REPO" })).toBe(
      true,
    );
  });
  it.each([
    { runId: "run-2" },
    { remoteDigest: "9".repeat(64) },
    { repository: "other/repo" },
    { prNumber: 999 },
    { baseRef: "release" },
    { headRef: "other-branch" },
    { headSha: "9".repeat(40) },
  ])("rejects a readiness identity mismatch %j", (patch) => {
    expect(journeyReadinessMatchesTask(BINDING, { ...READINESS, ...patch })).toBe(false);
  });
});

describe("journeyEvidenceFresh", () => {
  const WINDOW = { observedAt: AT, expiresAt: EXPIRES };
  it("is fresh at the start of the observation window (inclusive lower bound)", () => {
    expect(journeyEvidenceFresh(WINDOW, Date.parse(AT))).toBe(true);
  });
  it("is fresh inside the observation window", () => {
    expect(journeyEvidenceFresh(WINDOW, Date.parse(AT) + 15_000)).toBe(true);
  });
  it("is stale exactly at the expiry instant (exclusive upper bound)", () => {
    expect(journeyEvidenceFresh(WINDOW, Date.parse(EXPIRES))).toBe(false);
  });
  it("is stale beyond the maximum age", () => {
    expect(journeyEvidenceFresh(WINDOW, Date.parse(EXPIRES) + 60_000)).toBe(false);
  });
  it("is stale one millisecond before the observation window opens", () => {
    expect(journeyEvidenceFresh(WINDOW, Date.parse(AT) - 1)).toBe(false);
  });
  it("is stale when the observation window itself lies in the future relative to now", () => {
    const future = {
      observedAt: "2099-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:01:00.000Z",
    };
    expect(journeyEvidenceFresh(future, NOW)).toBe(false);
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a non-finite now (%s)",
    (now) => {
      expect(journeyEvidenceFresh(WINDOW, now)).toBe(false);
    },
  );
  it.each([
    { observedAt: "not-a-date", expiresAt: EXPIRES },
    { observedAt: AT, expiresAt: "not-a-date" },
  ])("rejects malformed timestamps that fail to parse %j", (value) => {
    expect(journeyEvidenceFresh(value, NOW)).toBe(false);
  });
});

describe("journeyReadinessCurrent", () => {
  it("is current when identity, readiness and evidence all align on an open, non-draft PR", () => {
    expect(journeyReadinessCurrent(BINDING, FACTS, READINESS, NOW)).toBe(true);
  });
  it("is never current without an observed readiness snapshot", () => {
    expect(journeyReadinessCurrent(BINDING, FACTS, null, NOW)).toBe(false);
  });
  it("is not current when the remote identity no longer matches the accepted task", () => {
    expect(
      journeyReadinessCurrent(
        BINDING,
        { ...FACTS, identity: { ...IDENTITY, repository: "other/repo" } },
        READINESS,
        NOW,
      ),
    ).toBe(false);
  });
  it("is not current when the readiness snapshot was produced for a different run", () => {
    expect(journeyReadinessCurrent(BINDING, FACTS, { ...READINESS, runId: "run-2" }, NOW)).toBe(
      false,
    );
  });
  it("is not current once the readiness evidence has expired", () => {
    expect(journeyReadinessCurrent(BINDING, FACTS, READINESS, Date.parse(EXPIRES))).toBe(false);
  });
  it("is not current when the readiness base sha drifted from the observed base", () => {
    expect(
      journeyReadinessCurrent(BINDING, FACTS, { ...READINESS, baseSha: "9".repeat(40) }, NOW),
    ).toBe(false);
  });
  it("is not current when the readiness draft flag disagrees with the observed identity", () => {
    expect(
      journeyReadinessCurrent(
        BINDING,
        FACTS,
        { ...READINESS, pullRequest: { ...READINESS.pullRequest, isDraft: true } },
        NOW,
      ),
    ).toBe(false);
  });
  it("is not current once the readiness snapshot itself reports a non-open pull request", () => {
    expect(
      journeyReadinessCurrent(
        BINDING,
        FACTS,
        { ...READINESS, pullRequest: { ...READINESS.pullRequest, status: "closed" } },
        NOW,
      ),
    ).toBe(false);
  });
  it("is not current once the observed pull request itself is closed", () => {
    expect(
      journeyReadinessCurrent(
        BINDING,
        { ...FACTS, identity: { ...IDENTITY, state: "closed" } },
        READINESS,
        NOW,
      ),
    ).toBe(false);
  });
  it("is not current once the pull request has merged", () => {
    expect(journeyReadinessCurrent(BINDING, { ...FACTS, mergedAt: AT }, READINESS, NOW)).toBe(
      false,
    );
  });
});

describe("APPLIED_PR_DESCRIPTION_STATES", () => {
  it("admits exactly the three complete application states (#3390: current, partial, fallback)", () => {
    expect(APPLIED_PR_DESCRIPTION_STATES.has("current")).toBe(true);
    expect(APPLIED_PR_DESCRIPTION_STATES.has("partial")).toBe(true);
    expect(APPLIED_PR_DESCRIPTION_STATES.has("fallback")).toBe(true);
    expect(APPLIED_PR_DESCRIPTION_STATES.has("blocked")).toBe(false);
    expect(APPLIED_PR_DESCRIPTION_STATES.has("stale")).toBe(false);
    expect(APPLIED_PR_DESCRIPTION_STATES.has("failed")).toBe(false);
    expect(APPLIED_PR_DESCRIPTION_STATES.size).toBe(3);
  });
});

describe("journeyDescriptionApplied", () => {
  it("is never applied without an observed description status (case a)", () => {
    expect(journeyDescriptionApplied(BINDING, FACTS, null, NOW)).toBe(false);
  });
  it("is not applied when the observed status never reached an applied state (case b)", () => {
    expect(
      journeyDescriptionApplied(
        BINDING,
        FACTS,
        { ...DESCRIPTION, state: "blocked", reason: "authority-denied", effect: "none" },
        NOW,
      ),
    ).toBe(false);
  });
  it("is not applied when the recorded effect was never confirmed or reconciled", () => {
    expect(
      journeyDescriptionApplied(BINDING, FACTS, { ...DESCRIPTION, effect: "uncertain" }, NOW),
    ).toBe(false);
  });
  it("also applies when the recorded effect is a reconciled write rather than a first application", () => {
    expect(
      journeyDescriptionApplied(
        BINDING,
        FACTS,
        { ...DESCRIPTION, reason: "reconciled", effect: "reconciled" },
        NOW,
      ),
    ).toBe(true);
  });
  it.each([
    { state: "partial", reason: "partial-applied", completeness: "partial" },
    { state: "fallback", reason: "fallback-applied", completeness: "fallback" },
  ] as const)(
    "also treats a %s completion as applied, the same as a current one",
    ({ state, reason, completeness }) => {
      expect(
        journeyDescriptionApplied(
          BINDING,
          FACTS,
          { ...DESCRIPTION, state, reason, completeness },
          NOW,
        ),
      ).toBe(true);
    },
  );
  it("matches description identity case-insensitively on repository slugs", () => {
    expect(
      journeyDescriptionApplied(
        BINDING,
        FACTS,
        {
          ...DESCRIPTION,
          binding: {
            ...DESCRIPTION.binding,
            repository: "OWNER/REPO",
            headRepository: "Owner/Repo",
          },
        },
        NOW,
      ),
    ).toBe(true);
  });
  it.each([
    { remoteDigest: "9".repeat(64) },
    { repository: "other/repo" },
    { headRepository: "other/repo" },
    { prNumber: 999 },
    { prExternalId: "PR_other" },
  ])("rejects a description binding identity mismatch %j", (patch) => {
    expect(
      journeyDescriptionApplied(
        BINDING,
        FACTS,
        { ...DESCRIPTION, binding: { ...DESCRIPTION.binding, ...patch } },
        NOW,
      ),
    ).toBe(false);
  });

  describe("open pull request: live-revision rule", () => {
    it("is applied for an open pull request whose remote, evidence and revision all currently match (case c)", () => {
      expect(journeyDescriptionApplied(BINDING, FACTS, DESCRIPTION, NOW)).toBe(true);
    });
    it("is not applied for an open pull request whose remote no longer matches the task", () => {
      expect(
        journeyDescriptionApplied(
          BINDING,
          { ...FACTS, defaultBranchRef: "release" },
          DESCRIPTION,
          NOW,
        ),
      ).toBe(false);
    });
    it("is not applied for an open pull request once the observation window has expired", () => {
      expect(journeyDescriptionApplied(BINDING, FACTS, DESCRIPTION, Date.parse(EXPIRES))).toBe(
        false,
      );
    });
    it("is not applied for an open pull request whose description was written for a superseded head sha (case d)", () => {
      expect(
        journeyDescriptionApplied(
          BINDING,
          FACTS,
          { ...DESCRIPTION, binding: { ...DESCRIPTION.binding, headSha: "9".repeat(40) } },
          NOW,
        ),
      ).toBe(false);
    });
    it.each([
      { baseRef: "release" },
      { baseSha: "9".repeat(40) },
      { headRef: "other-branch" },
      { isDraft: true },
    ])("rejects a description binding written for a superseded revision field %j", (patch) => {
      expect(
        journeyDescriptionApplied(
          BINDING,
          FACTS,
          { ...DESCRIPTION, binding: { ...DESCRIPTION.binding, ...patch } },
          NOW,
        ),
      ).toBe(false);
    });
  });

  describe("merged delivered head: durable-binding rule (#3390, rehearsal run-24)", () => {
    it("keeps the description applied for a merged delivered head even though its evidence window expired long ago (case e)", () => {
      expect(journeyDescriptionApplied(BINDING, FACTS_MERGED, STALE_DESCRIPTION, NOW)).toBe(true);
    });
    it("is not applied when a merged delivered head's description names a different head sha (case f)", () => {
      expect(
        journeyDescriptionApplied(
          BINDING,
          FACTS_MERGED,
          {
            ...STALE_DESCRIPTION,
            binding: { ...STALE_DESCRIPTION.binding, headSha: "9".repeat(40) },
          },
          NOW,
        ),
      ).toBe(false);
    });
    it.each([{ baseRef: "release" }, { headRef: "other-branch" }])(
      "is not applied when a merged delivered head's description names a different %j",
      (patch) => {
        expect(
          journeyDescriptionApplied(
            BINDING,
            FACTS_MERGED,
            { ...STALE_DESCRIPTION, binding: { ...STALE_DESCRIPTION.binding, ...patch } },
            NOW,
          ),
        ).toBe(false);
      },
    );
    it("requires both a merge timestamp and a closed state before treating a head as delivered", () => {
      // Hostile/malformed input: mergedAt claims a merge happened but the identity still reads
      // open. The merged-delivered-head rule must not fire on mergedAt alone, so this falls back
      // to the live-revision rule above, which still holds because nothing else about the open PR
      // has changed.
      expect(
        journeyDescriptionApplied(
          BINDING,
          { ...FACTS, mergedAt: "2026-09-05T01:00:00.000Z" },
          DESCRIPTION,
          NOW,
        ),
      ).toBe(true);
    });
    it.each([
      { repository: "other/repo" },
      { number: 999 },
      { externalId: "PR_other" },
      { headSha: "9".repeat(40) },
    ])(
      "falls back to the live-revision rule when the merged pull request's identity drifted %j",
      (patch) => {
        expect(
          journeyDescriptionApplied(
            BINDING,
            { ...FACTS_MERGED, identity: { ...FACTS_MERGED.identity, ...patch } },
            DESCRIPTION,
            NOW,
          ),
        ).toBe(false);
      },
    );
    it("falls back to the live-revision rule when the merged pull request's issue number drifted", () => {
      expect(
        journeyDescriptionApplied(
          BINDING,
          { ...FACTS_MERGED, issue: { ...FACTS_MERGED.issue, number: 999 } },
          DESCRIPTION,
          NOW,
        ),
      ).toBe(false);
    });
  });
});
