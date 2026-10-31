// Executable proofs for the review runtime's Activity Log operations (Issue #4135, AC7): every line
// passes the production formatter's identity and registration validation, and none carries a
// path, code, prompt, model output, rules text or finding prose.

import { describe, expect, it } from "vitest";
import type { ReviewFindingReport } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../../tests/support/activity-log-proof.js";
import { captureActivityLog } from "../../activityLogCapture.test-support.js";
import {
  logReviewActionRefused,
  logReviewFindingReported,
  logReviewProfileRefused,
  logReviewRulesFile,
  logReviewRuntimeStarted,
  logReviewRuntimeStopped,
} from "./activity-log.js";

const RUN_ID = "review-run-proof-1";
const CORRELATION = "review-runtime-proof";
const INSTANCE = "3b8f1d2c-5a6e-4f70-9b1a-0c2d3e4f5a6b";
const REPORT: ReviewFindingReport = {
  file: "src/secret-path.ts",
  startLine: 3,
  endLine: 4,
  title: "Leaked finding title",
  condition: "condition prose",
  mechanism: "mechanism prose",
  consequence: "consequence prose",
  remedy: "remedy prose",
  category: "security",
  severity: "high",
  evidence: [{ file: "src/secret-path.ts", startLine: 3, endLine: 4, role: "defect" }],
};

function onlyLine(emit: (sink: ReturnType<typeof captureActivityLog>["sink"]) => void): string {
  const capture = captureActivityLog();
  emit(capture.sink);
  const [event] = capture.events;
  if (event === undefined || capture.events.length !== 1) throw new TypeError("expected one event");
  const line = formatActivityLogProofLine(event);
  // Ids join the run's lines (the correlation); paths, prose and code never appear.
  for (const forbidden of ["src/", "secret-path", "prose", "Leaked"]) {
    expect(line).not.toContain(forbidden);
  }
  return line;
}

describe("review runtime Activity Log proofs", () => {
  it("proves review.run.runtime-started", () => {
    const line = onlyLine((sink) => {
      logReviewRuntimeStarted(sink, CORRELATION, INSTANCE, 42);
    });
    expect(expectActivityLogProof("review.run.runtime-started.line", line)).toMatchObject({
      runtimeInstanceId: INSTANCE,
      toolProfile: "review",
    });
  });

  // #4136: a fresh instance composed beside a quarantined one says so with a closed placement.
  it("proves review.run.runtime-started beside a quarantined instance", () => {
    const line = onlyLine((sink) => {
      logReviewRuntimeStarted(sink, CORRELATION, INSTANCE, 42, "beside-quarantined");
    });
    expect(expectActivityLogProof("review.run.runtime-started.line", line)).toMatchObject({
      runtimeInstanceId: INSTANCE,
      placement: "beside-quarantined",
    });
  });

  it("proves review.run.runtime-stopped", () => {
    const line = onlyLine((sink) => {
      logReviewRuntimeStopped(sink, CORRELATION, {
        instanceId: INSTANCE,
        trigger: "idle",
        idleDurationMs: 300_000,
        runCount: 2,
      });
    });
    expect(expectActivityLogProof("review.run.runtime-stopped.line", line)).toMatchObject({
      trigger: "idle",
      runCount: 2,
    });
  });

  it("proves review.run.profile-refused with its closed reason", () => {
    const line = onlyLine((sink) => {
      logReviewProfileRefused(sink, CORRELATION, "native-profile", "profile");
    });
    expect(expectActivityLogProof("review.run.profile-refused.line", line)).toMatchObject({
      reason: "native-profile",
      layer: "profile",
    });
  });

  it("proves review.run.rules-file with a run digest, never the run id or the rules", () => {
    const line = onlyLine((sink) => {
      logReviewRulesFile(sink, RUN_ID, "too-large", 20_000);
    });
    expect(expectActivityLogProof("review.run.rules-file.line", line)).toMatchObject({
      outcome: "too-large",
      byteCount: 20_000,
    });
  });

  it("proves review.run.action-refused", () => {
    const line = onlyLine((sink) => {
      logReviewActionRefused(sink, CORRELATION, "tool-facade", "edit");
    });
    expect(expectActivityLogProof("review.run.action-refused.line", line)).toMatchObject({
      layer: "tool-facade",
      action: "edit",
    });
  });

  it("proves review.finding.reported for an accepted report without its prose or location", () => {
    const line = onlyLine((sink) => {
      logReviewFindingReported(
        sink,
        RUN_ID,
        { status: "accepted", accepted: 1, remaining: 7 },
        { fingerprint: "f".repeat(64), report: REPORT },
      );
    });
    expect(expectActivityLogProof("review.finding.reported.line", line)).toMatchObject({
      outcome: "accepted",
      findingCategory: "security",
      severity: "high",
      evidenceCount: 1,
      acceptedCount: 1,
    });
  });

  it("records a rejection by its closed reason only", () => {
    const line = onlyLine((sink) => {
      logReviewFindingReported(sink, RUN_ID, { status: "rejected", reason: "range-invalid" });
    });
    expect(expectActivityLogProof("review.finding.reported.line", line)).toMatchObject({
      outcome: "range-invalid",
    });
  });
});
