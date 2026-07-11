import { describe, expect, it } from "vitest";
import {
  FEEDBACK_REVIEW_ACTIONS_V1,
  FEEDBACK_REVIEW_STATES_V1,
  feedbackReviewTransitionV1,
  isFeedbackLegalHoldPolicyAllowlistV1,
  isFeedbackReviewActionV1,
  isFeedbackReviewActorV1,
  type FeedbackReviewActionV1,
  type FeedbackReviewStateV1,
} from "./feedback-review.js";

const expected: Readonly<Record<FeedbackReviewStateV1, readonly FeedbackReviewActionV1[]>> = {
  pending: [
    "mark-duplicate",
    "reject",
    "archive",
    "route-private-security",
    "expire",
    "place-legal-hold",
  ],
  approved: ["place-legal-hold"],
  duplicate: ["place-legal-hold"],
  rejected: ["place-legal-hold"],
  archived: ["place-legal-hold"],
  "private-security": ["place-legal-hold"],
  expired: ["place-legal-hold"],
};

describe("feedback review v1 contract", () => {
  it("defines the exhaustive closed state/action matrix", () => {
    for (const state of FEEDBACK_REVIEW_STATES_V1) {
      for (const action of FEEDBACK_REVIEW_ACTIONS_V1) {
        const decision = feedbackReviewTransitionV1(state, action, false);
        expect(decision.allowed, `${state} -> ${action}`).toBe(expected[state].includes(action));
      }
    }
  });

  it("keeps legal-hold governance same-state and requires the current hold status", () => {
    expect(feedbackReviewTransitionV1("rejected", "place-legal-hold", false)).toEqual({
      allowed: true,
      state: "rejected",
    });
    expect(feedbackReviewTransitionV1("rejected", "release-legal-hold", true)).toEqual({
      allowed: true,
      state: "rejected",
    });
    expect(feedbackReviewTransitionV1("rejected", "expire-legal-hold", true)).toEqual({
      allowed: true,
      state: "rejected",
    });
    expect(feedbackReviewTransitionV1("rejected", "release-legal-hold", false).allowed).toBe(false);
  });

  it("does not admit approval or follow-up actions", () => {
    expect(isFeedbackReviewActionV1("approve")).toBe(false);
    expect(isFeedbackReviewActionV1("request-follow-up")).toBe(false);
  });

  it("accepts only a bounded unique operator policy-key allowlist", () => {
    expect(isFeedbackLegalHoldPolicyAllowlistV1(["operator-policy-1"])).toBe(true);
    expect(isFeedbackLegalHoldPolicyAllowlistV1([])).toBe(true);
    expect(isFeedbackLegalHoldPolicyAllowlistV1(["operator-policy", "operator-policy"])).toBe(
      false,
    );
    expect(isFeedbackLegalHoldPolicyAllowlistV1(["Operator Policy"])).toBe(false);
    expect(
      isFeedbackLegalHoldPolicyAllowlistV1(
        Array.from({ length: 33 }, (_, index) => `p-${String(index)}`),
      ),
    ).toBe(false);
  });

  it("bounds the three content-free actor identifiers", () => {
    const actor = {
      issuer: "https://issuer.example",
      subject: "operator-1",
      permissionPolicyVersion: "policy-v1",
    };
    expect(isFeedbackReviewActorV1(actor)).toBe(true);
    expect(isFeedbackReviewActorV1({ ...actor, issuer: "x".repeat(2_049) })).toBe(false);
    expect(isFeedbackReviewActorV1({ ...actor, subject: "x".repeat(256) })).toBe(false);
    expect(isFeedbackReviewActorV1({ ...actor, permissionPolicyVersion: "x".repeat(65) })).toBe(
      false,
    );
    expect(isFeedbackReviewActorV1({ ...actor, subject: "operator\ncontent" })).toBe(false);
  });
});
