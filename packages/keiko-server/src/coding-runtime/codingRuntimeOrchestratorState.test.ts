import { describe, expect, it } from "vitest";
import type { CodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";
import { CodingRuntimeEventHub } from "./codingRuntimeEventHub.js";
import {
  auxiliaryEventFacts,
  CodingRuntimeOrchestratorState,
} from "./codingRuntimeOrchestratorState.js";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";

const AT = "2026-10-07T12:00:00.000Z";
const SNAPSHOT: CodingRuntimeSnapshot = {
  schemaVersion: "1",
  runId: "run-native",
  state: "running",
  revision: 3,
  requestedMode: "autonomous-delivery",
  runtimeSource: "keiko-sidecar",
  modelSource: "keiko-model-gateway",
  createdAt: AT,
  updatedAt: AT,
  taskDigest: "a".repeat(64),
  workspaceDigest: "b".repeat(64),
  operatorDigest: "c".repeat(64),
  authorityDigest: "d".repeat(64),
  bindingDigest: "e".repeat(64),
  provenanceDigest: "f".repeat(64),
  toolCallCount: 0,
  patchByteCount: 0,
  modelRequestCount: 0,
};

describe("native retry runtime-to-SSE projection", () => {
  it("forwards physical facts and explicit clear into the existing bounded replay", () => {
    const eventHub = new CodingRuntimeEventHub({ now: (): Date => new Date(AT) });
    const projection = new CodingRuntimeOrchestratorState({
      eventHub,
      now: (): Date => new Date(AT),
      pendingPermission: (): undefined => undefined,
      effectiveMode: (): "autonomous-delivery" => "autonomous-delivery",
    });
    for (const nativeRetry of [{ attempt: 2, scheduledAt: "2026-10-07T12:00:02.000Z" }, null]) {
      const event: CodingWorkbenchRuntimeEvent = {
        schemaVersion: "1",
        eventId: "event-runtime-status-2",
        runId: SNAPSHOT.runId,
        occurredAt: AT,
        kind: "native-retry-changed",
        nativeRetry,
      };
      expect(projection.publish(SNAPSHOT, event.kind, auxiliaryEventFacts(event))).toBe(true);
    }
    expect(eventHub.replay(SNAPSHOT.runId)).toMatchObject({
      ok: true,
      events: [
        {
          eventKind: "native-retry-changed",
          nativeRetry: { attempt: 2, scheduledAt: "2026-10-07T12:00:02.000Z" },
        },
        { eventKind: "native-retry-changed", nativeRetry: null },
      ],
    });
  });
});
