import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  activityLogOperationSchema,
  attachActivityLogEventRegistration,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { analyzeLogText, findTimeline } from "@oscharko-dev/keiko-activity-log/reader";
import { createCodingSafeActivityProjection } from "../packages/keiko-server/src/coding-runtime/codingSafeActivityProjection.js";
import {
  closeFileServerLogSinks,
  createFileServerLogSink,
  listSupportIncidents,
  type ServerLogEvent,
} from "@oscharko-dev/keiko-activity-log";
import { readPersistedActivityLog } from "./support/activity-log-proof.js";
// The drain, trigger, sink and listing must share one module graph: the candidate queue is
// module-local, so a drain from another graph leaves the queued candidate unevaluated.
import {
  drainSupportIncidentCandidates,
  setSupportIncidentTriggerForTests,
} from "./support/activity-log-test-support.js";

// A registered failure the incident trigger admits: error level, a supported failure class, and
// the Keiko frames its defect fingerprint is built from.
function eligibleFailureEvent(): ServerLogEvent {
  const registration = activityLogOperationSchema("coding-runtime.readiness.failed");
  if (registration === undefined) throw new Error("fixture operation is not registered");
  return attachActivityLogEventRegistration(
    {
      level: "error",
      category: registration.category,
      op: registration.op,
      correlationId: "safe-activity-control-failure",
      errorKind: "unavailable",
      extra: {
        phase: "endpoint",
        frames: ["packages/keiko-server/dist/coding-runtime/opencodeRuntimeAdapter.js:710:9"],
        causeChain: ["Error"],
        completeness: "complete",
        loss: "none",
      },
    },
    registration,
  );
}

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

      const serialized = readPersistedActivityLog(stateDir);
      const timeline = findTimeline(analyzeLogText(serialized), runId);
      expect(timeline?.lines).toContainEqual(
        expect.objectContaining({
          category: "process",
          op: "coding-runtime.safe-activity",
          extra: {
            completeness: "complete",
            event: "purged",
            loss: "none",
            reason: "stop",
          },
        }),
      );
      expect(serialized).not.toContain(bodyCanary);
    } finally {
      activityLog.close?.();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  // Control for the shutdown pin below: the same trigger, sink, drain and listing turn a queued
  // eligible failure into an incident, so the pin's empty listing is evidence, not a vacuous pass.
  it("opens a support incident for a queued eligible failure through the same controls", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-safe-activity-control-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    setSupportIncidentTriggerForTests(true);
    const activityLog = createFileServerLogSink(stateDir, { level: "debug" });
    try {
      activityLog.write(eligibleFailureEvent());
      drainSupportIncidentCandidates();
      closeFileServerLogSinks();

      expect(listSupportIncidents(stateDir)).toHaveLength(1);
    } finally {
      setSupportIncidentTriggerForTests(undefined);
      closeFileServerLogSinks();
      vi.unstubAllEnvs();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("opens no support incident when a server shutdown purges the projection", () => {
    // Every BFF shutdown used to write an error-level server.diagnostic.failure for this routine
    // purge, and the incident trigger turned each one into a pinned support incident.
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-safe-activity-shutdown-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    setSupportIncidentTriggerForTests(true);
    const activityLog = createFileServerLogSink(stateDir, { level: "debug" });
    try {
      const projection = createCodingSafeActivityProjection({ activityLog });
      projection.open({
        runId: "run-safe-activity-shutdown",
        workspaceId: "workspace-safe-activity-shutdown",
        authorityExpiresAt: "2099-01-01T00:00:00.000Z",
        workspaceIsCurrent: () => true,
      });

      projection.purgeAll("shutdown", "shutdown-correlation-0002");
      drainSupportIncidentCandidates();
      closeFileServerLogSinks();

      const serialized = readPersistedActivityLog(stateDir);
      expect(serialized).toContain('"reason":"shutdown"');
      expect(serialized).not.toContain('"op":"server.diagnostic.failure"');
      expect(listSupportIncidents(stateDir)).toEqual([]);
    } finally {
      setSupportIncidentTriggerForTests(undefined);
      closeFileServerLogSinks();
      vi.unstubAllEnvs();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
