// Executable proofs of the review model-policy operations (Issue #4137, AC6): every line passes the
// production formatter's registration validation, carries its correlation, and none carries a
// model name, a path or other free text.

import { describe, expect, it } from "vitest";

import {
  REVIEW_MODEL_POLICY_REFUSAL_REASONS,
  REVIEW_MODEL_POLICY_SOURCES,
  REVIEW_OPERATOR_CONFIG_KEYS,
  REVIEW_PAIR_STATUSES,
  type ReviewResolvedRole,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../../tests/support/activity-log-proof.js";
import { captureActivityLog } from "../../activityLogCapture.test-support.js";
import {
  MODEL_POLICY_LOG_OPERATOR_KEYS,
  MODEL_POLICY_LOG_PAIR_STATUSES,
  MODEL_POLICY_LOG_REFUSAL_REASONS,
  MODEL_POLICY_LOG_SOURCES,
  logReviewModelPolicyRefused,
  logReviewModelPolicyResolved,
  logReviewModelPolicyUpdated,
} from "./activity-log.js";

const CORRELATION = "review-model-policy-proof";
const FORBIDDEN = ["secret-reviewer-model", "secret-checker-model", "docs/", "rules.md"];

function onlyLine(emit: (sink: ReturnType<typeof captureActivityLog>["sink"]) => void): string {
  const capture = captureActivityLog();
  emit(capture.sink);
  const [event] = capture.events;
  if (event === undefined || capture.events.length !== 1) throw new TypeError("expected one event");
  const line = formatActivityLogProofLine(event);
  for (const forbidden of FORBIDDEN) expect(line).not.toContain(forbidden);
  expect(line).toContain(CORRELATION);
  return line;
}

const REVIEWER: ReviewResolvedRole = {
  modelId: "secret-reviewer-model",
  source: "user",
  state: { status: "eligible", hint: "busy" },
};
const CHECKER: ReviewResolvedRole = {
  modelId: "secret-checker-model",
  source: "operator",
  state: { status: "refused", reason: "window-too-small" },
};

describe("review model-policy Activity Log proofs", () => {
  it("logs exactly the contract vocabularies", () => {
    expect(MODEL_POLICY_LOG_REFUSAL_REASONS).toEqual(REVIEW_MODEL_POLICY_REFUSAL_REASONS);
    expect(MODEL_POLICY_LOG_SOURCES).toEqual(REVIEW_MODEL_POLICY_SOURCES);
    expect(MODEL_POLICY_LOG_PAIR_STATUSES).toEqual(REVIEW_PAIR_STATUSES);
    expect(MODEL_POLICY_LOG_OPERATOR_KEYS).toEqual(REVIEW_OPERATOR_CONFIG_KEYS);
  });

  it("proves review.model-policy.resolved with role states and digests", () => {
    const line = onlyLine((sink) => {
      logReviewModelPolicyResolved(sink, CORRELATION, {
        reviewer: REVIEWER,
        counterChecker: CHECKER,
        locked: false,
        allowlistActive: true,
        singleModel: false,
        pairStatus: "seed-qualified",
        optionCount: 4,
        eligibleReviewerCount: 2,
        eligibleCounterCheckerCount: 1,
        invalidOperatorKeyCount: 0,
      });
    });
    expect(expectActivityLogProof("review.model-policy.resolved.line", line)).toMatchObject({
      enabled: true,
      reviewerState: "busy",
      counterCheckerState: "refused",
      counterCheckerReason: "window-too-small",
      pairStatus: "seed-qualified",
    });
    const off = onlyLine((sink) => {
      logReviewModelPolicyResolved(sink, CORRELATION, undefined);
    });
    expect(expectActivityLogProof("review.model-policy.resolved.line", off)).toMatchObject({
      enabled: false,
    });
  });

  it("proves review.model-policy.updated", () => {
    const line = onlyLine((sink) => {
      logReviewModelPolicyUpdated(sink, CORRELATION, {
        reviewer: REVIEWER,
        counterChecker: {
          modelId: null,
          source: "none",
          state: { status: "refused", reason: "not-configured" },
        },
        revision: 3,
        modelsChanged: true,
        rulesPathChanged: false,
        rulesPathSet: true,
      });
    });
    expect(expectActivityLogProof("review.model-policy.updated.line", line)).toMatchObject({
      revision: 3,
      reviewerSource: "user",
      counterCheckerSource: "none",
      rulesPathSet: true,
    });
  });

  it("proves review.model-policy.refused with an operator key and source", () => {
    const line = onlyLine((sink) => {
      logReviewModelPolicyRefused(sink, CORRELATION, {
        reason: "invalid-operator-value",
        role: "none",
        stage: "startup",
        operatorIssue: { key: "allowedReviewModelIds", source: "environment" },
      });
    });
    expect(expectActivityLogProof("review.model-policy.refused.line", line)).toMatchObject({
      reason: "invalid-operator-value",
      stage: "startup",
      operatorKey: "allowedReviewModelIds",
      operatorKeySource: "environment",
    });
  });
});
