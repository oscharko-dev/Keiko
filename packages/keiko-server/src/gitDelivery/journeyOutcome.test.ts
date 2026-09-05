import { describe, expect, it } from "vitest";
import { isJourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-validation";
import { gitDeliveryObservationFailure } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { produceJourneyOutcome } from "./journeyOutcome.js";
import { journeyFixture } from "./journeyOutcomeTest/_support.js";

describe("observed exact-revision issue-to-PR handoff", () => {
  it("requires the separate ready approval for a technical-ready draft with an applied body", () => {
    const value = produceJourneyOutcome(journeyFixture());
    expect(value).toMatchObject({
      state: "awaiting-ready-approval",
      reason: "ready-approval-required",
      keikoDescriptionApplied: true,
    });
    expect(isJourneyOutcome(value)).toBe(true);
  });
  it("separates ready-for-human-review from completed", () => {
    expect(produceJourneyOutcome(journeyFixture(false))).toMatchObject({
      state: "ready-for-human-review",
    });
  });
  it.each(["partial", "fallback"] as const)(
    "keeps applied %s description disclosure while allowing handoff",
    (state) => {
      const f = journeyFixture();
      if (f.description === null) throw new TypeError("Description missing");
      expect(
        produceJourneyOutcome({
          ...f,
          description: { ...f.description, state, reason: `${state}-applied`, completeness: state },
        }),
      ).toMatchObject({
        state: "awaiting-ready-approval",
        keikoDescriptionApplied: true,
        description: { state, completeness: state },
      });
    },
  );
  it.each([
    ["unresolved-conversations", { reviewConversations: { total: 2, unresolved: 1, resolved: 1 } }],
    ["changes-requested", { reviewDecision: "changes-requested" }],
    ["required-reviews-missing", { reviewDecision: "review-required" }],
  ] as const)("keeps human blocker %s separate from technical checks", (reason, facts) => {
    const f = journeyFixture(false);
    expect(produceJourneyOutcome({ ...f, facts: { ...f.facts, ...facts } })).toMatchObject({
      state: "awaiting-human-requirements",
      reason,
      readiness: { state: "technical-ready" },
    });
  });
  it("never calls unknown required approval visibility human-ready", () => {
    const f = journeyFixture(false);
    if (f.readiness === null) throw new TypeError("Readiness missing");
    const readiness = {
      ...f.readiness,
      humanReview: {
        visibility: "unknown",
        requiredCount: null,
        approvedCount: null,
        changesRequestedCount: null,
      },
    } as const;
    expect(produceJourneyOutcome({ ...f, readiness })).toMatchObject({
      reason: "review-visibility-unknown",
    });
  });
  it.each(["open", "closed"] as const)(
    "observes human merge and independently keeps issue %s",
    (state) => {
      const f = journeyFixture(false);
      const facts = {
        ...f.facts,
        identity: { ...f.facts.identity, state: "closed" as const },
        mergedAt: "2026-09-05T00:00:00Z",
        mergeCommitSha: "f".repeat(40),
        issue: {
          ...f.facts.issue,
          state,
          closedAt: state === "closed" ? "2026-09-05T00:00:00Z" : null,
        },
      };
      expect(
        produceJourneyOutcome({ ...f, facts, readiness: null, description: null }),
      ).toMatchObject({
        state: state === "closed" ? "completed" : "merged-awaiting-issue-closure",
        keikoDescriptionApplied: false,
      });
    },
  );
  it.each(["open", "closed"] as const)(
    "does not attribute manually closed issue to an unmerged %s PR",
    (state) => {
      const f = journeyFixture(false);
      const facts = {
        ...f.facts,
        identity: { ...f.facts.identity, state },
        issue: { ...f.facts.issue, state: "closed" as const, closedAt: "2026-09-05T00:00:00Z" },
      };
      expect(produceJourneyOutcome({ ...f, facts })).toMatchObject({
        state: "blocked",
        reason: "issue-closed-without-merge",
      });
    },
  );
  it("distinguishes a closed unmerged PR from issue closure", () => {
    const f = journeyFixture(false);
    expect(
      produceJourneyOutcome({
        ...f,
        facts: { ...f.facts, identity: { ...f.facts.identity, state: "closed" } },
      }),
    ).toMatchObject({ reason: "closed-unmerged" });
  });
  it.each(["base", "default", "head"] as const)("denies %s drift", (change) => {
    const f = journeyFixture();
    const facts = {
      ...f.facts,
      defaultBranchRef: change === "default" ? "main" : "dev",
      identity: {
        ...f.facts.identity,
        baseRef: change === "base" ? "main" : "dev",
        headSha: change === "head" ? "e".repeat(40) : f.facts.identity.headSha,
      },
    };
    expect(produceJourneyOutcome({ ...f, facts })).toMatchObject({
      state: "blocked",
      reason: change === "head" ? "head-changed" : "retargeted",
    });
  });
  it.each([
    "provider-forbidden",
    "provider-not-found",
    "rate-limited",
    "pagination-exhausted",
    "revision-changed",
  ] as const)("preserves %s observation failure without green fallback", (reason) => {
    const f = journeyFixture();
    expect(
      produceJourneyOutcome({
        ...f,
        facts: { status: "unavailable", failure: gitDeliveryObservationFailure(reason) },
      }),
    ).toMatchObject({
      state: "blocked",
      remote: null,
      keikoDescriptionApplied: false,
      observationFailure: { reason },
    });
  });
  it("rejects expired readiness and stale or unapplied description", () => {
    const f = journeyFixture();
    expect(produceJourneyOutcome({ ...f, observedAtMs: f.observedAtMs + 60_000 })).toMatchObject({
      reason: "readiness-stale",
    });
    expect(produceJourneyOutcome({ ...f, description: null })).toMatchObject({
      reason: "description-unavailable",
    });
    if (f.description === null) throw new TypeError("Description missing");
    expect(
      produceJourneyOutcome({
        ...f,
        description: {
          ...f.description,
          state: "blocked",
          reason: "approval-required",
          effect: "none",
        },
      }),
    ).toMatchObject({ reason: "description-not-applied" });
    expect(
      produceJourneyOutcome({
        ...f,
        description: {
          ...f.description,
          binding: { ...f.description.binding, headSha: "f".repeat(40) },
        },
      }),
    ).toMatchObject({ reason: "description-not-applied" });
  });
  it("refuses fabricated completion, foreign readiness, bodies and false applied claims at the wire boundary", () => {
    const ready = produceJourneyOutcome(journeyFixture());
    expect(
      isJourneyOutcome({ ...ready, state: "completed", reason: "merge-and-closure-observed" }),
    ).toBe(false);
    expect(isJourneyOutcome({ ...ready, body: "untrusted" })).toBe(false);
    expect(
      isJourneyOutcome({ ...ready, readiness: { ...ready.readiness, headSha: "e".repeat(40) } }),
    ).toBe(false);
    expect(isJourneyOutcome({ ...ready, description: null, keikoDescriptionApplied: true })).toBe(
      false,
    );
    expect(
      isJourneyOutcome({
        ...ready,
        remote: {
          ...ready.remote,
          issue: { number: 999, state: "closed", closedAt: ready.observedAt },
        },
      }),
    ).toBe(false);
  });
});
