// Focused coverage for git-journey-validation.ts's own outcome-remote invariant (owner audit
// finding b1-25). The exhaustive reason x isJourneyOutcome matrix lives in
// git-journey-outcome.test.ts (it drives the same isJourneyOutcome through every GitJourneyReason);
// this file pins the specific defect directly against the function that owns the check.

import { describe, expect, it } from "vitest";
import {
  GIT_JOURNEY_REASON_STATES,
  type GitJourneyBinding,
  type GitJourneyReason,
  type JourneyOutcome,
} from "./git-journey-outcome.js";
import { isJourneyOutcome } from "./git-journey-validation.js";

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

function remoteAbsentOutcome(reason: GitJourneyReason): JourneyOutcome {
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

describe("isJourneyOutcome — remote:null is gated by reason, not by the collapsed state (b1-25)", () => {
  // The state these three reasons collapse to ("blocked") is shared with genuinely remote-absent
  // reasons like "provider-unavailable" — the field a fail-closed check must actually gate on is
  // the reason itself, which is the only field that says whether a remote was ever observed.
  it.each<GitJourneyReason>(["closed-unmerged", "retargeted", "head-changed"])(
    "refuses remote: null for %s even though its state ('blocked') is shared with provider-unavailable",
    (reason) => {
      expect(GIT_JOURNEY_REASON_STATES[reason]).toBe("blocked");
      expect(GIT_JOURNEY_REASON_STATES["provider-unavailable"]).toBe("blocked");
      expect(isJourneyOutcome(remoteAbsentOutcome(reason))).toBe(false);
    },
  );

  it("still accepts remote: null for the reasons that genuinely never observe a remote", () => {
    for (const reason of [
      "provider-unavailable",
      "authority-denied",
      "observation-superseded",
      "cancelled",
      "ready-effect-uncertain",
    ] as const) {
      expect(isJourneyOutcome(remoteAbsentOutcome(reason))).toBe(true);
    }
  });

  it("refuses every readiness/description blocked reason with remote: null", () => {
    for (const reason of [
      "readiness-unavailable",
      "readiness-stale",
      "checks-not-ready",
      "description-unavailable",
      "description-stale",
      "description-not-applied",
      "issue-closed-without-merge",
    ] as const) {
      expect(isJourneyOutcome(remoteAbsentOutcome(reason))).toBe(false);
    }
  });
});
