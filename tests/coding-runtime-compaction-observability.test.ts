import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeLogText, findTimeline } from "../packages/keiko-cli/src/support-analyze.js";
import { recordCompactionActivity } from "../packages/keiko-server/src/coding-runtime/opencodeRuntimeAdapter.js";
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
      recordCompactionActivity({ activityLog, correlationId: runId }, [
        { compaction: { event: "completed", compactionIdSha256 } },
        {
          compaction: {
            event: "started",
            compactionIdSha256,
            auto: true,
            overflow: true,
            retainedTail: false,
          },
        },
        {
          compaction: {
            event: "tail-retained",
            compactionIdSha256,
            tailStartIdSha256,
            auto: true,
            overflow: true,
            retainedTail: true,
          },
        },
        {
          compaction: {
            event: "started",
            compactionIdSha256: failedCompactionIdSha256,
            auto: true,
            overflow: false,
            retainedTail: false,
          },
        },
        {
          compaction: {
            event: "failed",
            compactionIdSha256: failedCompactionIdSha256,
            errorKind: "ContextOverflowError",
            finishReason: "error",
          },
        },
      ]);
      activityLog.close?.();

      const serialized = readFileSync(join(stateDir, "logs", "server.log"), "utf8");
      const analysis = analyzeLogText(serialized);
      const timeline = findTimeline(analysis, runId);
      expect(timeline?.lines.map(({ op, extra, errorKind }) => ({ op, extra, errorKind }))).toEqual(
        [
          {
            op: "coding-runtime.compaction",
            errorKind: undefined,
            extra: {
              completeness: "complete",
              loss: "none",
              event: "completed",
              compactionIdSha256,
            },
          },
          {
            op: "coding-runtime.compaction",
            errorKind: undefined,
            extra: {
              completeness: "complete",
              loss: "none",
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
              completeness: "complete",
              loss: "none",
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
              completeness: "complete",
              loss: "none",
              event: "started",
              compactionIdSha256: failedCompactionIdSha256,
              auto: true,
              overflow: false,
              retainedTail: false,
            },
          },
          {
            op: "coding-runtime.compaction",
            errorKind: "internal",
            extra: {
              completeness: "complete",
              loss: "none",
              event: "failed",
              compactionIdSha256: failedCompactionIdSha256,
              compactionErrorKind: "ContextOverflowError",
              finishReason: "error",
            },
          },
        ],
      );
      const infrastructure = findTimeline(analysis, "unknown-correlation-id");
      expect(infrastructure?.lines).toHaveLength(1);
      expect(infrastructure?.lines[0]).toMatchObject({
        op: "server-log.safe-open",
        extra: {
          artifactClass: "activity-log",
          persistenceStatus: "opened",
          completeness: "complete",
          loss: "none",
        },
      });
      expect(serialized).not.toContain(bodyCanary);
    } finally {
      activityLog.close?.();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
