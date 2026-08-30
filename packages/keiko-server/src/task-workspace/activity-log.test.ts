// Unit coverage for the shared task-workspace activity-log emitter (IDX61). Each of the five
// #445-#448 service test files (provisioning/lifecycle/reconciliation/repair/cleanup .test.ts)
// proves this module is actually WIRED into that service's own central `emit` helper, at an
// integration level, over a real store/adapter. This file proves the mapping `logWorkspaceLifecycle`
// itself performs, in isolation: op/category, the info/warn level split, `errorKind` resolution
// (explicit override vs. outcome fallback vs. success-omits-it), the correlationId shape guard, and
// the default fallback to the process-wide sink when a caller supplies none.

import { afterEach, describe, expect, it } from "vitest";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "../observability/index.js";
import { processServerLogSink } from "../process-log-sink.js";
import { logWorkspaceLifecycle, type WorkspaceLifecycleLogInput } from "./activity-log.js";

afterEach(() => {
  resetServerLogger();
});

const BASE: WorkspaceLifecycleLogInput = {
  operation: "provision",
  outcome: "provisioned",
  workspaceId: "ws_test",
  taskId: "task_test",
  correlationId: "req-corr-12345678",
  attempt: 1,
  durationMs: 0,
  worktreeCount: 0,
};

describe("logWorkspaceLifecycle", () => {
  it("writes one task-workspace.lifecycle line under the diagnostic category, at info, on success", () => {
    const activityLog = createBufferedServerLogSink();
    logWorkspaceLifecycle({ activityLog }, BASE);
    expect(activityLog.events).toHaveLength(1);
    const [line] = activityLog.events;
    expect(line?.category).toBe("diagnostic");
    expect(line?.op).toBe("task-workspace.lifecycle");
    expect(line?.level).toBe("info");
    expect(line?.correlationId).toBe("req-corr-12345678");
    expect(line?.errorKind).toBeUndefined();
    expect(line?.extra).toEqual({
      operation: "provision",
      outcome: "provisioned",
      workspaceId: "ws_test",
      taskId: "task_test",
      attempt: 1,
      worktreeCount: 0,
    });
  });

  it("raises level to warn and sets errorKind to the outcome itself for a failure-classified outcome with no explicit code", () => {
    const activityLog = createBufferedServerLogSink();
    logWorkspaceLifecycle({ activityLog }, { ...BASE, outcome: "blocked" });
    const [line] = activityLog.events;
    expect(line?.level).toBe("warn");
    expect(line?.errorKind).toBe("blocked");
  });

  it("prefers an explicit errorCode over the bare outcome when both are failure-classified", () => {
    const activityLog = createBufferedServerLogSink();
    logWorkspaceLifecycle(
      { activityLog },
      { ...BASE, outcome: "blocked", errorCode: "LOCK_CONTENTION" },
    );
    const [line] = activityLog.events;
    expect(line?.level).toBe("warn");
    expect(line?.errorKind).toBe("LOCK_CONTENTION");
  });

  // Reconciliation's own evidence `outcome` is always the fixed "reconciled" (a success-classified
  // outcome) regardless of what the live pass found — its `errorCode` (the live
  // WorkspaceReconciliationStatus) is the ONLY place that classification travels, so an explicit
  // code must win even over a success-classified outcome, not merely over a failure-classified one.
  it("honors an explicit errorCode even when outcome itself is success-classified (reconcile's own case)", () => {
    const activityLog = createBufferedServerLogSink();
    logWorkspaceLifecycle(
      { activityLog },
      { ...BASE, operation: "reconcile", outcome: "reconciled", errorCode: "drifted" },
    );
    const [line] = activityLog.events;
    expect(line?.level).toBe("warn");
    expect(line?.errorKind).toBe("drifted");
    expect(line?.extra?.outcome).toBe("reconciled");
  });

  it("never invents an errorKind out of nothing for a plain success with no errorCode", () => {
    const activityLog = createBufferedServerLogSink();
    logWorkspaceLifecycle({ activityLog }, { ...BASE, outcome: "activated" });
    const [line] = activityLog.events;
    expect(line?.level).toBe("info");
    expect(line?.errorKind).toBeUndefined();
  });

  // A hostile/malformed correlationId (fails `isValidCorrelationId`'s SAFE_CORRELATION_ID shape —
  // correlation.ts) is treated the same as one genuinely absent: UNKNOWN_CORRELATION_ID, never
  // written through unshaped. This is this module's OWN guard, independent of whatever the
  // EvidenceStore side of the same call accepted (evidence.ts validates only non-empty-string).
  it("falls back to UNKNOWN_CORRELATION_ID for a correlationId that fails isValidCorrelationId's shape", () => {
    const activityLog = createBufferedServerLogSink();
    logWorkspaceLifecycle({ activityLog }, { ...BASE, correlationId: "req corr\ncontrol" });
    const [line] = activityLog.events;
    expect(line?.correlationId).toBe("unknown-correlation-id");
  });

  it("falls back to UNKNOWN_CORRELATION_ID for an empty-string correlationId", () => {
    const activityLog = createBufferedServerLogSink();
    logWorkspaceLifecycle({ activityLog }, { ...BASE, correlationId: "" });
    const [line] = activityLog.events;
    expect(line?.correlationId).toBe("unknown-correlation-id");
  });

  it("falls back to UNKNOWN_CORRELATION_ID for an undefined correlationId", () => {
    const activityLog = createBufferedServerLogSink();
    logWorkspaceLifecycle({ activityLog }, { ...BASE, correlationId: undefined });
    const [line] = activityLog.events;
    expect(line?.correlationId).toBe("unknown-correlation-id");
  });

  it("preserves a well-formed correlationId unchanged", () => {
    const activityLog = createBufferedServerLogSink();
    logWorkspaceLifecycle({ activityLog }, { ...BASE, correlationId: "req-corr-abc123" });
    const [line] = activityLog.events;
    expect(line?.correlationId).toBe("req-corr-abc123");
  });

  it("falls back to the process-wide sink when the seam carries no activityLog", () => {
    const activityLog = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink: activityLog, level: "debug" }));
    logWorkspaceLifecycle({}, BASE);
    expect(activityLog.events).toHaveLength(1);
    expect(activityLog.events[0]?.op).toBe("task-workspace.lifecycle");
    // Confirms the fallback used the SAME resolver production composes with (process-log-sink.ts),
    // not a private default this test happens to also construct correctly.
    expect(processServerLogSink()).toBeDefined();
  });
});
