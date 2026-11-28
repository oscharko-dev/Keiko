import { describe, expect, it } from "vitest";
import { GIT_COMMIT_REFUSAL_CAUSES } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { captureActivityLog } from "../activityLogCapture.test-support.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { GIT_COMMIT_REFUSAL_CAUSE_VALUES, logGitCommitRefused } from "./commitRefusalLog.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

describe("git commit refusal line", () => {
  it("records a refusal as one closed cause on the mutation's correlation", () => {
    const activity = captureActivityLog();
    logGitCommitRefused(activity.sink, { cause: "ref-moved" }, "mutation-correlation-2");
    expect(activity.events).toHaveLength(1);
    expect(activity.events[0]).toMatchObject({
      level: "warn",
      category: "diagnostic",
      op: "git.delivery.commit-refused",
      correlationId: "mutation-correlation-2",
      errorKind: "conflict",
      extra: { refusal: "ref-moved" },
    });
    const persisted = expectActivityLogProof(
      "git.delivery.commit-refused.emitted-line",
      formatActivityLogProofLine(activity.events[0] ?? {}),
    );
    expect(persisted).toMatchObject({ refusal: "ref-moved" });
  });

  it("records the structured error class of a throw without any message text", () => {
    const activity = captureActivityLog();
    const error = new Error("secret /Users/someone/repo path", { cause: new TypeError("inner") });
    logGitCommitRefused(activity.sink, { cause: "unexpected-error", error }, undefined);
    expect(activity.events[0]).toMatchObject({
      level: "error",
      correlationId: UNKNOWN_CORRELATION_ID,
      extra: { refusal: "unexpected-error" },
    });
    expect(JSON.stringify(activity.events)).not.toContain("secret");
    expect(JSON.stringify(activity.events)).not.toContain("someone");
  });

  it("registers exactly the causes the commit lane can report", () => {
    expect([...GIT_COMMIT_REFUSAL_CAUSE_VALUES]).toEqual([...GIT_COMMIT_REFUSAL_CAUSES]);
  });

  it("has a kind for every closed cause", () => {
    for (const cause of GIT_COMMIT_REFUSAL_CAUSES) {
      const activity = captureActivityLog();
      logGitCommitRefused(activity.sink, { cause }, "c");
      expect(activity.events[0]).toMatchObject({ extra: { refusal: cause } });
      // The persisted line keeps the value: the sink's over-redaction never hides a closed cause.
      expect(formatActivityLogProofLine(activity.events[0] ?? {})).not.toContain("[redacted");
    }
  });
});
