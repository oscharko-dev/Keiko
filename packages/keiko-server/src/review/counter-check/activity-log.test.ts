// Executable proofs of the counter-check's Activity Log operations (Issue #4136, AC7): each line has
// its own correlation and points at its run through `parentCorrelationId`; the fingerprint is only
// a digest.

import { describe, expect, it } from "vitest";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../../tests/support/activity-log-proof.js";
import { captureActivityLog } from "../../activityLogCapture.test-support.js";
import {
  COUNTER_CHECK_REASON_CODES,
  COUNTER_CHECK_VERDICTS,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import {
  COUNTER_CHECK_LOG_REASON_CODES,
  COUNTER_CHECK_LOG_VERDICTS,
  logCounterCheckCompleted,
  logCounterCheckFailed,
} from "./activity-log.js";

const FINGERPRINT = "f".repeat(64);
const FACTS = {
  correlationId: "review-counter-check-proof",
  runCorrelationId: "review-run-proof",
  fingerprint: FINGERPRINT,
  toolCallCount: 5,
  durationMs: 2_500,
};

function onlyLine(emit: (sink: ReturnType<typeof captureActivityLog>["sink"]) => void): string {
  const capture = captureActivityLog();
  emit(capture.sink);
  const [event] = capture.events;
  if (event === undefined || capture.events.length !== 1) throw new TypeError("expected one event");
  const line = formatActivityLogProofLine(event);
  expect(line).not.toContain(FINGERPRINT);
  expect(line).toContain("review-run-proof");
  return line;
}

describe("counter-check Activity Log proofs", () => {
  it("logs exactly the contract vocabularies", () => {
    expect(COUNTER_CHECK_LOG_VERDICTS).toEqual(COUNTER_CHECK_VERDICTS);
    expect(COUNTER_CHECK_LOG_REASON_CODES).toEqual(COUNTER_CHECK_REASON_CODES);
  });

  it("proves review.counter-check.completed", () => {
    const line = onlyLine((sink) => {
      logCounterCheckCompleted(sink, FACTS, {
        verdict: {
          findingFingerprint: FINGERPRINT,
          verdict: "confirmed",
          reasonCode: "defect-reproduced-in-code",
          evidence: [{ file: "src/secret.ts", startLine: 1, endLine: 2, role: "defect" }],
        },
        effect: "none",
        evidenceInHead: true,
        promptTokens: 900,
        completionTokens: 40,
      });
    });
    expect(line).not.toContain("src/secret.ts");
    expect(expectActivityLogProof("review.counter-check.completed.line", line)).toMatchObject({
      verdict: "confirmed",
      reasonCode: "defect-reproduced-in-code",
      toolCallCount: 5,
    });
  });

  it("proves review.counter-check.failed with frames and cause chain", () => {
    const line = onlyLine((sink) => {
      logCounterCheckFailed(
        sink,
        FACTS,
        "model-failed",
        new Error("provider said no", { cause: new TypeError("inner") }),
      );
    });
    expect(line).not.toContain("provider said no");
    expect(expectActivityLogProof("review.counter-check.failed.line", line)).toMatchObject({
      failureClass: "model-failed",
    });
  });
});
