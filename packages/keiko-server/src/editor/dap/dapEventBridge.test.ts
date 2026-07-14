import { describe, expect, it, vi } from "vitest";
import { buildDebugOutputEvent, type DebugEvent } from "@oscharko-dev/keiko-contracts";
import {
  createDapEventBridge,
  DEBUG_EVENT_CHANNEL_CAP,
  DEBUG_EVENT_REPLAY_BYTE_CAP,
  DEBUG_EVENT_SUBSCRIBER_CAP,
  type DebugEventEnvelope,
} from "./dapEventBridge.js";

const channel = { workspacePartitionKey: "workspace_a", browserSessionBinding: "browser_a" };

function started(sessionId: string): DebugEvent {
  return { kind: "session-started", sessionId, status: "running" };
}

describe("bounded DAP live-event bridge", () => {
  it("replays in sequence, then streams to subscribers without exposing channel bindings", () => {
    const bridge = createDapEventBridge();
    expect(bridge.publish(channel, started("session_a"))).toBe(true);
    const received: DebugEventEnvelope[] = [];
    const onEvent = (event: DebugEventEnvelope): void => {
      received.push(event);
    };
    const result = bridge.subscribe({ channel, onEvent });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("invalid test fixture");
    expect(result.replay.map((entry) => entry.sequence)).toEqual([1]);
    expect(JSON.stringify(result.replay)).not.toContain("workspace_a");
    expect(JSON.stringify(result.replay)).not.toContain("browser_a");

    bridge.publish(channel, { kind: "continued", sessionId: "session_a", pauseGeneration: 2 });
    expect(received).toHaveLength(1);
    expect(received[0]?.sequence).toBe(2);
    expect(received[0]?.event.kind).toBe("continued");
    result.unsubscribe();
    bridge.publish(channel, { kind: "exited", sessionId: "session_a", exitCode: 0 });
    expect(received).toHaveLength(1);
  });

  it("isolates replay and subscribers by both workspace and browser binding", () => {
    const bridge = createDapEventBridge();
    bridge.publish(channel, started("session_a"));
    for (const foreign of [
      { ...channel, workspacePartitionKey: "workspace_b" },
      { ...channel, browserSessionBinding: "browser_b" },
    ]) {
      const result = bridge.subscribe({ channel: foreign, onEvent: vi.fn() });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("invalid test fixture");
      expect(result.replay).toEqual([]);
    }
  });

  it("bounds retained output by aggregate UTF-8 bytes and reports cumulative eviction", () => {
    const bridge = createDapEventBridge();
    for (let index = 0; index < 80; index += 1) {
      expect(
        bridge.publish(channel, buildDebugOutputEvent("session_a", "stdout", "x".repeat(16_000))),
      ).toBe(true);
    }
    const snapshot = bridge.snapshot(channel);
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(DEBUG_EVENT_REPLAY_BYTE_CAP);
    expect(snapshot.evictedCount).toBeGreaterThan(0);
    expect(snapshot.evictedBytes).toBeGreaterThan(0);
    expect(snapshot.sequence).toBe(80);
  });

  it("replaces an oversized hostile event with a fixed content-free truncation marker", () => {
    const bridge = createDapEventBridge();
    const hostile = {
      kind: "output",
      sessionId: "session_a",
      category: "stdout",
      text: "secret".repeat(20_000),
      truncated: false,
      originalBytes: 120_000,
      omittedBytes: 0,
    } as DebugEvent;

    expect(bridge.publish(channel, hostile)).toBe(true);
    const result = bridge.subscribe({ channel, onEvent: vi.fn() });
    if (result.kind !== "ok") throw new Error("invalid test fixture");
    expect(result.replay).toHaveLength(1);
    const projection = result.replay[0];
    expect(projection?.schemaVersion).toBe("1");
    expect(projection?.sequence).toBe(1);
    if (projection?.event.kind !== "projection-truncated") {
      throw new Error("expected a projection truncation marker");
    }
    expect(projection.event.reason).toBe("sse-event-size");
    expect(projection.event.originalBytes).toBeGreaterThan(0);
    expect(JSON.stringify(result.replay)).not.toContain("secret");
  });

  it("requires a fresh snapshot when the resume cursor predates retained replay", () => {
    const bridge = createDapEventBridge();
    for (let index = 0; index < 80; index += 1) {
      bridge.publish(channel, buildDebugOutputEvent("session_a", "stdout", "x".repeat(16_000)));
    }
    const stale = bridge.subscribe({ channel, lastSequence: 0, onEvent: vi.fn() });
    expect(stale).toMatchObject({ kind: "ok", snapshotRequired: true, replay: [] });
    const current = bridge.subscribe({ channel, lastSequence: 79, onEvent: vi.fn() });
    expect(current).toMatchObject({ kind: "ok", snapshotRequired: false });
    if (current.kind !== "ok") throw new Error("invalid test fixture");
    expect(current.replay.map((entry) => entry.sequence)).toEqual([80]);
  });

  it("requires a fresh snapshot when the resume cursor is ahead of the channel", () => {
    const bridge = createDapEventBridge();
    bridge.publish(channel, started("session_a"));

    const result = bridge.subscribe({ channel, lastSequence: 2, onEvent: vi.fn() });

    expect(result).toMatchObject({
      kind: "ok",
      replay: [],
      snapshot: { sequence: 1 },
      snapshotRequired: true,
    });
  });

  it("retains only the terminal session event for replay", () => {
    const bridge = createDapEventBridge();
    bridge.publish(channel, buildDebugOutputEvent("session_a", "stdout", "prior output"));
    bridge.publish(channel, { kind: "continued", sessionId: "session_a", pauseGeneration: 2 });
    bridge.publish(channel, {
      kind: "session-stopped",
      sessionId: "session_a",
      status: "stopped",
      reason: "requested",
    });

    const result = bridge.subscribe({ channel, onEvent: vi.fn() });
    if (result.kind !== "ok") throw new Error("invalid test fixture");
    expect(result.replay).toEqual([
      {
        schemaVersion: "1",
        sequence: 3,
        event: {
          kind: "session-stopped",
          sessionId: "session_a",
          status: "stopped",
          reason: "requested",
        },
      },
    ]);
    expect(result.snapshot).toMatchObject({ retainedCount: 1, evictedCount: 2 });
    expect(JSON.stringify(result.replay)).not.toContain("prior output");
  });

  it("rejects a new channel at the global cap and reuses an idle channel slot", () => {
    const bridge = createDapEventBridge();
    const unsubscribers: (() => void)[] = [];
    for (let index = 0; index < DEBUG_EVENT_CHANNEL_CAP; index += 1) {
      const activeChannel = { ...channel, browserSessionBinding: `browser_${String(index)}` };
      expect(bridge.publish(activeChannel, started(`session_${String(index)}`))).toBe(true);
      const subscription = bridge.subscribe({ channel: activeChannel, onEvent: vi.fn() });
      if (subscription.kind !== "ok") throw new Error("invalid test fixture");
      unsubscribers.push(subscription.unsubscribe);
    }
    const overflow = { ...channel, browserSessionBinding: "browser_overflow" };
    expect(bridge.publish(overflow, started("session_overflow"))).toBe(false);
    expect(bridge.snapshot(overflow).sequence).toBe(0);

    unsubscribers[0]?.();
    expect(bridge.publish(overflow, started("session_overflow"))).toBe(true);
    expect(bridge.snapshot(overflow).sequence).toBe(1);
    expect(bridge.snapshot(channel).sequence).toBe(0);
  });

  it("caps subscribers and disposes channel and global projections deterministically", () => {
    const bridge = createDapEventBridge();
    for (let index = 0; index < DEBUG_EVENT_SUBSCRIBER_CAP; index += 1) {
      expect(bridge.subscribe({ channel, onEvent: vi.fn() }).kind).toBe("ok");
    }
    expect(bridge.subscribe({ channel, onEvent: vi.fn() }).kind).toBe("subscriberLimit");
    bridge.disposeChannel(channel);
    expect(bridge.snapshot(channel).retainedCount).toBe(0);
    bridge.publish(channel, started("session_b"));
    bridge.disposeAll();
    expect(bridge.snapshot(channel).sequence).toBe(0);
  });
});
