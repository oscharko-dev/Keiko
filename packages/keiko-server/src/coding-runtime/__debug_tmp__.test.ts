import { expect, it } from "vitest";
import { createBufferedServerLogSink } from "../observability/server-log.js";
import {
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { CodingRuntimeOperationCoordinator } from "./codingRuntimeOperationCoordinator.js";
import type { CodingRuntimeTaskDispatcher } from "./productionCodingRuntimeHost.js";
import type { CodingRuntimeManager } from "./codingRuntimeManager.js";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";
import { createProductionRuntimeQuestionPort } from "./productionCodingRuntimeQuestionPort.js";

function runningSnapshot(): CodingRuntimeSnapshot {
  const AT = "2026-07-13T12:00:00.000Z";
  const DIGEST = "a".repeat(64);
  return {
    schemaVersion: "1",
    runId: "run-1",
    state: "running",
    revision: 3,
    requestedMode: "supervised-coding",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    createdAt: AT,
    updatedAt: AT,
    taskDigest: DIGEST,
    workspaceDigest: DIGEST,
    operatorDigest: DIGEST,
    authorityDigest: DIGEST,
    bindingDigest: DIGEST,
    provenanceDigest: DIGEST,
    toolCallCount: 0,
    patchByteCount: 0,
    modelRequestCount: 0,
  } as CodingRuntimeSnapshot;
}

it("debug", async () => {
  const activityLog = createBufferedServerLogSink();
  const taskDispatcher: CodingRuntimeTaskDispatcher = {
    dispatch: () => Promise.reject(new Error("dispatch backend offline")),
  };
  const current = runningSnapshot();
  const coordinator = new CodingRuntimeOperationCoordinator({
    current: () => current,
    serial: (work) => work(),
    advanceRevision: () => ({ ok: true, snapshot: current as never }) as never,
    publicSnapshot: () => current as never,
    taskDispatcher,
    resumePaused: () => Promise.resolve({ ok: true, snapshot: current as never }) as never,
    settleTask: () => undefined,
    questionPort: createProductionRuntimeQuestionPort(),
    manager: {} as CodingRuntimeManager,
    activityLog,
  });
  await coordinator.submitFollowUp("run-1", {
    requestId: "req-1",
    expectedRevision: 3,
    taskIntent: "continue",
  });
  const [event] = activityLog.events;
  if (event === undefined) throw new Error("no event");
  // eslint-disable-next-line no-console
  console.log("EVENT", JSON.stringify(event, null, 2));
  try {
    const line = formatActivityLogProofLine(event);
    // eslint-disable-next-line no-console
    console.log("LINE", line);
  } catch (formatError) {
    // eslint-disable-next-line no-console
    console.log("FORMAT ERROR", formatError);
  }
  expect(true).toBe(true);
});
