import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeLogText, findTimeline } from "../packages/keiko-cli/src/support-analyze.js";
import { createFileServerLogSink } from "../packages/keiko-server/src/observability/server-log.js";

describe("native coding-runtime compaction support reconstruction", () => {
  it("retains the correlated body-free lifecycle in the support timeline", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-native-compaction-"));
    const activityLog = createFileServerLogSink(stateDir, { level: "debug" });
    const runId = "run-native-compaction-observability";
    const compactionIdSha256 = "b".repeat(64);
    const failedCompactionIdSha256 = "d".repeat(64);
    const tailStartIdSha256 = "c".repeat(64);
    const bodyCanary = "SENTINEL_NATIVE_COMPACTION_BODY";
    try {
      activityLog.write({
        category: "process",
        op: "coding-runtime.compaction",
        correlationId: runId,
        extra: { event: "completed", compactionIdSha256 },
      });
      activityLog.write({
        category: "process",
        op: "coding-runtime.compaction",
        correlationId: runId,
        extra: {
          event: "started",
          compactionIdSha256,
          auto: true,
          overflow: true,
          retainedTail: false,
        },
      });
      activityLog.write({
        category: "process",
        op: "coding-runtime.compaction",
        correlationId: runId,
        extra: {
          event: "tail-retained",
          compactionIdSha256,
          tailStartIdSha256,
          auto: true,
          overflow: true,
          retainedTail: true,
        },
      });
      activityLog.write({
        category: "process",
        op: "coding-runtime.compaction",
        correlationId: runId,
        extra: {
          event: "started",
          compactionIdSha256: failedCompactionIdSha256,
          auto: true,
          overflow: false,
          retainedTail: false,
        },
      });
      activityLog.write({
        category: "process",
        level: "error",
        op: "coding-runtime.compaction",
        correlationId: runId,
        errorKind: "ContextOverflowError",
        extra: {
          event: "failed",
          compactionIdSha256: failedCompactionIdSha256,
          finishReason: "error",
        },
      });
      activityLog.close?.();

      const serialized = readFileSync(join(stateDir, "logs", "server.log"), "utf8");
      const timeline = findTimeline(analyzeLogText(serialized), runId);
      expect(timeline?.lines.map(({ op, extra, errorKind }) => ({ op, extra, errorKind }))).toEqual(
        [
          {
            op: "coding-runtime.compaction",
            errorKind: undefined,
            extra: { event: "completed", compactionIdSha256 },
          },
          {
            op: "coding-runtime.compaction",
            errorKind: undefined,
            extra: {
              event: "started",
              compactionIdSha256,
              auto: true,
              overflow: true,
              retainedTail: false,
            },
          },
          {
            op: "coding-runtime.compaction",
            errorKind: undefined,
            extra: {
              event: "tail-retained",
              compactionIdSha256,
              tailStartIdSha256,
              auto: true,
              overflow: true,
              retainedTail: true,
            },
          },
          {
            op: "coding-runtime.compaction",
            errorKind: undefined,
            extra: {
              event: "started",
              compactionIdSha256: failedCompactionIdSha256,
              auto: true,
              overflow: false,
              retainedTail: false,
            },
          },
          {
            op: "coding-runtime.compaction",
            errorKind: "ContextOverflowError",
            extra: {
              event: "failed",
              compactionIdSha256: failedCompactionIdSha256,
              finishReason: "error",
            },
          },
        ],
      );
      expect(serialized).not.toContain(bodyCanary);
    } finally {
      activityLog.close?.();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
