import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeLogText, findTimeline } from "../packages/keiko-cli/src/support-analyze.js";
import { createCodingSafeActivityProjection } from "../packages/keiko-server/src/coding-runtime/codingSafeActivityProjection.js";
import { createFileServerLogSink } from "../packages/keiko-server/src/observability/server-log.js";

describe("safe activity purge support reconstruction", () => {
  it("retains the body-free run identity and purge reason in the support timeline", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-safe-activity-purge-"));
    const activityLog = createFileServerLogSink(stateDir, { level: "debug" });
    const runId = "run-safe-activity-observability";
    const bodyCanary = "SAFE_ACTIVITY_BODY_MUST_NOT_REACH_LOG";
    try {
      const projection = createCodingSafeActivityProjection({ activityLog });
      projection.open({
        runId,
        workspaceId: "workspace-safe-activity-observability",
        authorityExpiresAt: "2099-01-01T00:00:00.000Z",
        workspaceIsCurrent: () => true,
      });
      projection.ingest(runId, {
        kind: "message",
        messageId: "msg-user-observability",
        role: "user",
        occurredAt: "2026-09-06T00:00:00.000Z",
      });
      projection.ingest(runId, {
        kind: "text",
        messageId: "msg-user-observability",
        text: bodyCanary,
        occurredAt: "2026-09-06T00:00:00.001Z",
      });

      projection.purge(runId, "stop");
      activityLog.close?.();

      const serialized = readFileSync(join(stateDir, "logs", "server.log"), "utf8");
      const timeline = findTimeline(analyzeLogText(serialized), runId);
      expect(timeline?.lines).toContainEqual(
        expect.objectContaining({
          category: "process",
          op: "coding-runtime.safe-activity",
          extra: { event: "purged", reason: "stop" },
        }),
      );
      expect(serialized).not.toContain(bodyCanary);
    } finally {
      activityLog.close?.();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
