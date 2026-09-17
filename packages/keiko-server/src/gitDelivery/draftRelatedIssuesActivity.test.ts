import { describe, expect, it } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "../observability/server-log.js";
import { logDraftRelatedIssues } from "./draftRelatedIssuesActivity.js";

function recordingSink(events: ServerLogEvent[]): ServerLogSink {
  return {
    write(event): void {
      events.push(event);
    },
  };
}

describe("draft related-issues activity", () => {
  it("records resolved and unavailable outcomes through one canonical operation", () => {
    const events: ServerLogEvent[] = [];
    const log = recordingSink(events);

    logDraftRelatedIssues(log, {
      correlationId: "corr-related-resolved",
      runId: "run-related-resolved",
      state: "resolved",
      count: 2,
    });
    logDraftRelatedIssues(log, {
      correlationId: "corr-related-unavailable",
      runId: "run-related-unavailable",
      state: "unavailable",
      count: 0,
      errorKind: "internal",
      failureKind: "unknown",
      errorClass: "Error",
      code: "EUNKNOWN",
      frames: ["draftRelatedIssuesActivity.test.ts:1:1"],
      causeChain: ["Error"],
    });

    expect(events).toEqual([
      expect.objectContaining({
        op: "git.draft-related-issues",
        correlationId: "corr-related-resolved",
        extra: {
          runId: "run-related-resolved",
          state: "resolved",
          count: 2,
        },
      }),
      expect.objectContaining({
        op: "git.draft-related-issues",
        correlationId: "corr-related-unavailable",
        level: "warn",
        errorKind: "internal",
        extra: {
          runId: "run-related-unavailable",
          state: "unavailable",
          count: 0,
          failureKind: "unknown",
          errorClass: "Error",
          code: "EUNKNOWN",
          frames: ["draftRelatedIssuesActivity.test.ts:1:1"],
          causeChain: ["Error"],
        },
      }),
    ]);
  });
});
