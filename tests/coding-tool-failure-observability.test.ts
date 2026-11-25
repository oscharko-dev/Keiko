import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeLogText, findTimeline } from "@oscharko-dev/keiko-activity-log/reader";
import { createFileServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type { CodingSafeActivitySignal } from "../packages/keiko-server/src/coding-runtime/codingSafeActivityProjection.js";
import { createCodingSafeActivityProjection } from "../packages/keiko-server/src/coding-runtime/codingSafeActivityProjection.js";
import { readPersistedActivityLog } from "./support/activity-log-proof.js";

const RUN_ID = "run-tool-failure-observability";
const AT = "2026-09-06T00:00:00.000Z";
const PRIVATE_COMMAND = "npm test -- --grep TOOL_FAILURE_BODY_MUST_NOT_REACH_LOG";
const PRIVATE_OUTPUT = "FAIL TOOL_FAILURE_OUTPUT_MUST_NOT_REACH_LOG";
const PRIVATE_ERROR = "TOOL_FAILURE_ERROR_MUST_NOT_REACH_LOG";

type ToolSignal = Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>;

function toolCall(
  callId: string,
  tool: string,
  state: "failed" | "denied" | "succeeded",
  presentation: NonNullable<ToolSignal["presentation"]>,
): ToolSignal {
  return {
    kind: "tool",
    messageId: "msg-answer",
    callId,
    tool,
    state,
    occurredAt: AT,
    presentation,
  };
}

const FAILED_TEST: ToolSignal = toolCall("call-private-1", "shell", "failed", {
  exitCode: 1,
  failureOrigin: "command-failed",
  command: { text: PRIVATE_COMMAND, truncated: false },
  output: { head: PRIVATE_OUTPUT, tail: "", lineCount: 1, hiddenLineCount: 0, truncated: false },
});

describe("failed tool call support reconstruction", () => {
  it("shows a run's failure pattern in its support timeline, body-free", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-tool-failure-"));
    const activityLog = createFileServerLogSink(stateDir, { level: "debug" });
    try {
      const projection = createCodingSafeActivityProjection({ activityLog });
      projection.open({
        runId: RUN_ID,
        workspaceId: "workspace-tool-failure-observability",
        authorityExpiresAt: "2099-01-01T00:00:00.000Z",
        workspaceIsCurrent: () => true,
      });
      projection.ingest(RUN_ID, {
        kind: "message",
        messageId: "msg-user",
        role: "user",
        occurredAt: AT,
      });
      projection.ingest(RUN_ID, {
        kind: "message",
        messageId: "msg-answer",
        role: "assistant",
        parentMessageId: "msg-user",
        occurredAt: AT,
      });
      // The same command fails twice, a tool hands the agent an error, Keiko refuses a push and
      // one command succeeds: the timeline shows two command failures, one tool error, one refusal.
      projection.ingest(RUN_ID, FAILED_TEST);
      projection.ingest(RUN_ID, { ...FAILED_TEST, callId: "call-private-2" });
      projection.ingest(
        RUN_ID,
        toolCall("call-private-3", "read", "failed", {
          failureOrigin: "tool-error",
          errorText: { text: PRIVATE_ERROR, truncated: false },
        }),
      );
      projection.ingest(
        RUN_ID,
        toolCall("call-private-4", "shell", "denied", {
          failureOrigin: "keiko-refused",
          refusalCause: "approval-declined",
        }),
      );
      projection.ingest(RUN_ID, toolCall("call-private-5", "shell", "succeeded", { exitCode: 0 }));
      activityLog.close?.();

      const serialized = readPersistedActivityLog(stateDir);
      const timeline = findTimeline(analyzeLogText(serialized), RUN_ID);
      const failures = (timeline?.lines ?? []).filter(
        (line) => line.op === "coding-runtime.tool.failed",
      );
      expect(failures.map((line) => line.extra)).toEqual([
        expect.objectContaining({
          tool: "shell",
          failureOrigin: "command-failed",
          exitCodeClass: "1",
          commandFailureCount: 1,
          failedCallCount: 1,
        }),
        expect.objectContaining({
          tool: "shell",
          failureOrigin: "command-failed",
          exitCodeClass: "1",
          commandFailureCount: 2,
          failedCallCount: 2,
          repeatedFailureCount: 1,
        }),
        expect.objectContaining({ tool: "read", failureOrigin: "tool-error", failedCallCount: 3 }),
        expect.objectContaining({
          tool: "shell",
          failureOrigin: "keiko-refused",
          failedCallCount: 4,
        }),
      ]);
      for (const body of [PRIVATE_COMMAND, PRIVATE_OUTPUT, PRIVATE_ERROR, "call-private"]) {
        expect(serialized).not.toContain(body);
      }
    } finally {
      activityLog.close?.();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
