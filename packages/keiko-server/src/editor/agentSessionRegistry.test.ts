import { describe, expect, it } from "vitest";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  type EditorAgentAction,
  type EditorAgentEvent,
  type EditorAgentSessionSnapshot,
} from "@oscharko-dev/keiko-contracts";
import {
  EDITOR_AGENT_ACTION_TIMEOUT_MS,
  EDITOR_AGENT_REVIEW_TIMEOUT_MS,
  createEditorAgentRegistry,
} from "./agentSessionRegistry.js";

const HASH = "a".repeat(64);
const CAPABILITY_DIGEST = "b".repeat(64);
const WRONG_CAPABILITY_DIGEST = "c".repeat(64);

// A controllable timer seam so the queue lifecycle (timeout, cleanup, clear-on-result) is
// deterministic without global fake timers.
function fakeScheduler(): {
  setTimer: (handler: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  pending: () => number;
  delays: () => readonly number[];
  fireAll: () => void;
} {
  let nextId = 0;
  const handlers = new Map<number, { readonly handler: () => void; readonly ms: number }>();
  return {
    setTimer: (handler: () => void, ms: number): unknown => {
      const id = (nextId += 1);
      handlers.set(id, { handler, ms });
      return id;
    },
    clearTimer: (handle: unknown): void => {
      handlers.delete(handle as number);
    },
    pending: (): number => handlers.size,
    delays: (): readonly number[] => [...handlers.values()].map((entry) => entry.ms),
    fireAll: (): void => {
      const snapshot = [...handlers.entries()];
      handlers.clear();
      for (const [, entry] of snapshot) entry.handler();
    },
  };
}

function snapshot(sessionId = "session-1"): EditorAgentSessionSnapshot {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId,
    windowId: "window-1",
    workspaceRoot: "/repo",
    activePaneId: "pane-1",
    panes: [{ paneId: "pane-1", activeFile: "src/a.ts", openFiles: ["src/a.ts"] }],
    dirtyFiles: [],
    activeFile: "src/a.ts",
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    documentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
    activeFileContentHash: HASH,
    textMode: "none",
    updatedAt: 1,
  };
}

function action(overrides: Partial<EditorAgentAction> = {}): EditorAgentAction {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: "action-1",
    idempotencyKey: "idempotency-1",
    sessionId: "session-1",
    type: "setSelection",
    ...overrides,
  };
}

describe("editor agent session registry", () => {
  it("binds the first snapshot to one digest and rejects session takeover", () => {
    const registry = createEditorAgentRegistry();
    expect(registry.registerSnapshot(snapshot(), CAPABILITY_DIGEST)).toBe(true);
    expect(
      registry.registerSnapshot(
        { ...snapshot(), workspaceRoot: "/forged", updatedAt: 2 },
        WRONG_CAPABILITY_DIGEST,
      ),
    ).toBe(false);
    expect(registry.snapshotFor("session-1")?.workspaceRoot).toBe("/repo");
    expect(
      registry.refreshSnapshot(
        { ...snapshot(), activeFile: "src/b.ts", updatedAt: 3 },
        WRONG_CAPABILITY_DIGEST,
      ),
    ).toBe(false);
    expect(
      registry.refreshSnapshot(
        { ...snapshot(), activeFile: "src/b.ts", updatedAt: 4 },
        CAPABILITY_DIGEST,
      ),
    ).toBe(true);
    expect(registry.snapshotFor("session-1")?.activeFile).toBe("src/b.ts");
  });

  it("rotates a stale capability only while the session is idle", () => {
    const registry = createEditorAgentRegistry(fakeScheduler());
    expect(registry.registerSnapshot(snapshot(), CAPABILITY_DIGEST)).toBe(true);
    expect(
      registry.rotateSnapshotCapability(
        { ...snapshot(), workspaceRoot: "/rotated", updatedAt: 2 },
        WRONG_CAPABILITY_DIGEST,
      ),
    ).toBe(true);
    expect(registry.matchesBridgeDecisionCapabilityDigest("session-1", CAPABILITY_DIGEST)).toBe(
      false,
    );
    expect(registry.snapshotFor("session-1")?.workspaceRoot).toBe("/rotated");

    const disconnect = registry.connectAuthenticated(
      "session-1",
      WRONG_CAPABILITY_DIGEST,
      () => undefined,
    );
    expect(disconnect).toBeDefined();
    expect(registry.rotateSnapshotCapability(snapshot(), CAPABILITY_DIGEST)).toBe(false);
    disconnect?.();
    registry.queueAction(action(), action());
    expect(registry.rotateSnapshotCapability(snapshot(), CAPABILITY_DIGEST)).toBe(false);
  });

  it("authenticates bridge connections against the exact session capability", () => {
    const registry = createEditorAgentRegistry();
    registry.registerSnapshot(snapshot("session-1"), CAPABILITY_DIGEST);
    registry.registerSnapshot(snapshot("session-2"), WRONG_CAPABILITY_DIGEST);
    expect(
      registry.connectAuthenticated("session-1", WRONG_CAPABILITY_DIGEST, () => undefined),
    ).toBeUndefined();
    expect(registry.hasLiveBridge("session-1")).toBe(false);
    const disconnect = registry.connectAuthenticated(
      "session-1",
      CAPABILITY_DIGEST,
      () => undefined,
    );
    expect(disconnect).toBeDefined();
    expect(registry.hasLiveBridge("session-1")).toBe(true);
    disconnect?.();
  });

  it("keeps capability-less internal snapshots read-only", () => {
    const registry = createEditorAgentRegistry();
    expect(registry.registerSnapshot(snapshot())).toBe(true);
    const disconnect = registry.connect("session-1", () => undefined);
    expect(registry.queueAction(action(), action()).kind).toBe("queued");

    expect(registry.matchesBridgeDecisionCapabilityDigest("session-1", CAPABILITY_DIGEST)).toBe(
      false,
    );
    expect(registry.hasValidBridgeLease("session-1", CAPABILITY_DIGEST)).toBe(false);
    expect(registry.takePendingAction("session-1", "action-1", CAPABILITY_DIGEST)).toBeUndefined();
    expect(registry.refreshSnapshot({ ...snapshot(), updatedAt: 2 }, CAPABILITY_DIGEST)).toBe(
      false,
    );
    expect(registry.pendingCount("session-1")).toBe(1);
    disconnect();
  });

  it("registers snapshots and reads them back", () => {
    const registry = createEditorAgentRegistry();
    registry.registerSnapshot(snapshot(), CAPABILITY_DIGEST);
    registry.registerSnapshot(snapshot("session-2"), CAPABILITY_DIGEST);
    expect(registry.listSessions().map((s) => s.sessionId)).toEqual(["session-1", "session-2"]);
    expect(registry.snapshotFor("session-2")?.sessionId).toBe("session-2");
    expect(registry.selectSnapshot()?.sessionId).toBe("session-1");
    expect(registry.selectSnapshot("session-2")?.sessionId).toBe("session-2");
    expect(registry.snapshotFor("missing")).toBeUndefined();
  });

  it("tracks bridge liveness only for sessionId-scoped connections", () => {
    const registry = createEditorAgentRegistry();
    expect(registry.hasLiveBridge("session-1")).toBe(false);

    const disposeObserver = registry.connect(undefined, () => undefined);
    expect(registry.hasLiveBridge("session-1")).toBe(false);
    expect(registry.liveBridgeCount("session-1")).toBe(0);

    const disposeBridge = registry.connect("session-1", () => undefined);
    expect(registry.hasLiveBridge("session-1")).toBe(true);
    expect(registry.liveBridgeCount("session-1")).toBe(1);

    const disposeBridge2 = registry.connect("session-1", () => undefined);
    expect(registry.liveBridgeCount("session-1")).toBe(2);

    disposeBridge();
    expect(registry.liveBridgeCount("session-1")).toBe(1);
    disposeBridge2();
    expect(registry.hasLiveBridge("session-1")).toBe(false);
    disposeObserver();
  });

  it("queues an action, broadcasts the supplied envelope, and frees the slot on result", () => {
    const scheduler = fakeScheduler();
    const registry = createEditorAgentRegistry(scheduler);
    const events: EditorAgentEvent[] = [];
    registry.registerSnapshot(snapshot(), CAPABILITY_DIGEST);
    registry.connect("session-1", (event) => events.push(event));

    const emitEnvelope = action({
      type: "applyTextEdits",
      textEdits: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "x",
        },
      ],
    });
    const outcome = registry.queueAction(action({ type: "applyTextEdits" }), emitEnvelope);
    expect(outcome.kind).toBe("queued");
    expect(outcome.result.status).toBe("queued");
    expect(registry.pendingCount("session-1")).toBe(1);
    expect(scheduler.pending()).toBe(1);
    const last = events.at(-1);
    expect(last?.type).toBe("action");
    // The broadcast carries the supplied envelope (derived textEdits), not just the raw action.
    if (last?.type === "action") expect(last.action.textEdits).toBeDefined();

    expect(registry.takePendingAction("session-1", "action-1", CAPABILITY_DIGEST)).toBeDefined();
    registry.reportResult({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: "action-1",
      sessionId: "session-1",
      status: "succeeded",
    });
    expect(registry.pendingCount("session-1")).toBe(0);
    expect(scheduler.pending()).toBe(0);
    expect(events.at(-1)?.type).toBe("result");
  });

  it("takes the exact original pending action once and only within its session", () => {
    const scheduler = fakeScheduler();
    const registry = createEditorAgentRegistry(scheduler);
    const original = action({
      sessionId: "session-A",
      actionId: "shared-id",
      idempotencyKey: "original-key",
    });
    const emitted = { ...original, idempotencyKey: "derived-envelope" };
    registry.registerSnapshot(snapshot("session-A"), CAPABILITY_DIGEST);
    registry.connect("session-A", () => undefined);
    registry.queueAction(original, emitted);

    expect(registry.takePendingAction("session-B", "shared-id", CAPABILITY_DIGEST)).toBeUndefined();
    expect(registry.pendingCount("session-A")).toBe(1);
    expect(registry.takePendingAction("session-A", "shared-id", CAPABILITY_DIGEST)).toEqual(
      original,
    );
    expect(registry.takePendingAction("session-A", "shared-id", CAPABILITY_DIGEST)).toBeUndefined();
    expect(registry.pendingCount("session-A")).toBe(0);
    expect(scheduler.pending()).toBe(0);
  });

  it("requires the lease digest before a pending action can be claimed", () => {
    const scheduler = fakeScheduler();
    const registry = createEditorAgentRegistry(scheduler);
    registry.registerSnapshot(snapshot(), CAPABILITY_DIGEST);
    registry.connect("session-1", () => undefined);
    const pending = action();
    registry.queueAction(pending, pending);

    expect(
      registry.takePendingAction("session-1", "action-1", WRONG_CAPABILITY_DIGEST),
    ).toBeUndefined();
    expect(registry.pendingCount("session-1")).toBe(1);
    expect(registry.takePendingAction("session-1", "action-1", CAPABILITY_DIGEST)).toEqual(pending);
    expect(registry.takePendingAction("session-1", "action-1", CAPABILITY_DIGEST)).toBeUndefined();
  });

  it("times out an unacknowledged action and cleans up the queue (AC2)", () => {
    const scheduler = fakeScheduler();
    const registry = createEditorAgentRegistry(scheduler);
    const events: EditorAgentEvent[] = [];
    registry.connect("session-1", (event) => events.push(event));

    registry.queueAction(action(), action());
    expect(registry.pendingCount("session-1")).toBe(1);

    scheduler.fireAll();

    expect(registry.pendingCount("session-1")).toBe(0);
    const last = events.at(-1);
    expect(last?.type).toBe("result");
    if (last?.type === "result") {
      expect(last.result.status).toBe("failed");
      expect(last.result.failure?.code).toBe("TIMED_OUT");
    }
  });

  it("bounds the per-session queue and recovers after a slot frees (QUEUE_FULL)", () => {
    const scheduler = fakeScheduler();
    const registry = createEditorAgentRegistry({ ...scheduler, maxQueuedPerSession: 2 });
    registry.registerSnapshot(snapshot(), CAPABILITY_DIGEST);
    registry.connect("session-1", () => undefined);

    const a1 = action({ actionId: "a1", idempotencyKey: "k1" });
    const a2 = action({ actionId: "a2", idempotencyKey: "k2" });
    const a3 = action({ actionId: "a3", idempotencyKey: "k3" });
    expect(registry.queueAction(a1, a1).kind).toBe("queued");
    expect(registry.queueAction(a2, a2).kind).toBe("queued");

    const rejected = registry.queueAction(a3, a3);
    expect(rejected.kind).toBe("rejected");
    expect(rejected.result.status).toBe("failed");
    expect(rejected.result.failure?.code).toBe("QUEUE_FULL");
    expect(registry.pendingCount("session-1")).toBe(2);

    expect(registry.takePendingAction("session-1", "a1", CAPABILITY_DIGEST)).toBeDefined();
    registry.reportResult({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: "a1",
      sessionId: "session-1",
      status: "succeeded",
    });
    const a4 = action({ actionId: "a4", idempotencyKey: "k4" });
    expect(registry.queueAction(a4, a4).kind).toBe("queued");
  });

  it("serializes mutating actions while retaining bounded nonmutating queueing", () => {
    const registry = createEditorAgentRegistry(fakeScheduler());
    registry.registerSnapshot(snapshot(), CAPABILITY_DIGEST);
    registry.connect("session-1", () => undefined);
    const review = action({ type: "applyPatch", actionId: "review", idempotencyKey: "review-key" });
    const navigation = action({ actionId: "navigate", idempotencyKey: "navigate-key" });
    const secondMutation = action({ type: "save", actionId: "save", idempotencyKey: "save-key" });

    expect(registry.queueAction(review, review).kind).toBe("queued");
    expect(registry.queueAction(navigation, navigation).kind).toBe("queued");
    expect(registry.queueAction(secondMutation, secondMutation)).toMatchObject({
      kind: "rejected",
      result: { status: "failed" },
    });
    expect(registry.pendingCount("session-1")).toBe(2);
    expect(registry.takePendingAction("session-1", "review", CAPABILITY_DIGEST)).toBeDefined();
    expect(registry.queueAction(secondMutation, secondMutation).kind).toBe("queued");
  });

  it("uses the long deadline only for patch and changeset review", () => {
    const scheduler = fakeScheduler();
    const registry = createEditorAgentRegistry(scheduler);
    const immediate = action({ sessionId: "session-1" });
    const review = action({
      sessionId: "session-2",
      actionId: "review",
      idempotencyKey: "review-key",
      type: "applyPatch",
    });
    registry.queueAction(immediate, immediate);
    registry.queueAction(review, review);

    expect(scheduler.delays()).toEqual([
      EDITOR_AGENT_ACTION_TIMEOUT_MS,
      EDITOR_AGENT_REVIEW_TIMEOUT_MS,
    ]);
  });

  it("scopes action fan-out to the target session bridge", () => {
    const registry = createEditorAgentRegistry(fakeScheduler());
    const bridge1: EditorAgentEvent[] = [];
    const bridge2: EditorAgentEvent[] = [];
    const observer: EditorAgentEvent[] = [];
    registry.connect("session-1", (event) => bridge1.push(event));
    registry.connect("session-2", (event) => bridge2.push(event));
    registry.connect(undefined, (event) => observer.push(event));

    const a = action({ sessionId: "session-1" });
    registry.queueAction(a, a);

    expect(bridge1.filter((e) => e.type === "action")).toHaveLength(1);
    expect(observer.filter((e) => e.type === "action")).toHaveLength(0);
    expect(bridge2.filter((e) => e.type === "action")).toHaveLength(0);
  });

  it("never sends content-bearing session or action events to global observers", () => {
    const registry = createEditorAgentRegistry(fakeScheduler());
    const bridge: EditorAgentEvent[] = [];
    const observer: EditorAgentEvent[] = [];
    registry.connect("session-1", (event) => bridge.push(event));
    registry.connect(undefined, (event) => observer.push(event));
    registry.registerSnapshot(
      { ...snapshot(), textMode: "activeFile", text: "PRIVATE_BUFFER" },
      CAPABILITY_DIGEST,
    );
    const contentAction = action({
      type: "applyPatch",
      patch: "PRIVATE_PATCH",
      textEdits: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "PRIVATE_POST_IMAGE",
        },
      ],
    });
    registry.queueAction(contentAction, contentAction);

    expect(bridge.some((event) => event.type === "session")).toBe(true);
    expect(bridge.some((event) => event.type === "action")).toBe(true);
    expect(observer.some((event) => event.type === "session")).toBe(false);
    expect(observer.some((event) => event.type === "action")).toBe(false);
    expect(JSON.stringify(observer)).not.toContain("PRIVATE_");
  });

  it("emits body-free unknown results to bridges and global observers without touching the queue", () => {
    const registry = createEditorAgentRegistry(fakeScheduler());
    const seen: EditorAgentEvent[] = [];
    const observed: EditorAgentEvent[] = [];
    registry.connect("session-1", (event) => seen.push(event));
    registry.connect(undefined, (event) => observed.push(event));

    registry.reportResult({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: "never-queued",
      sessionId: "session-1",
      status: "succeeded",
    });
    expect(seen.at(-1)?.type).toBe("result");
    expect(observed.at(-1)?.type).toBe("result");
    expect(registry.pendingCount("session-1")).toBe(0);
  });

  it("reset clears state and disarms pending timers", () => {
    const scheduler = fakeScheduler();
    const registry = createEditorAgentRegistry(scheduler);
    registry.registerSnapshot(snapshot(), CAPABILITY_DIGEST);
    registry.connect("session-1", () => undefined);
    registry.queueAction(action(), action());
    expect(scheduler.pending()).toBe(1);

    registry.reset();

    expect(registry.listSessions()).toHaveLength(0);
    expect(registry.hasLiveBridge("session-1")).toBe(false);
    expect(registry.pendingCount("session-1")).toBe(0);
    expect(scheduler.pending()).toBe(0);
    scheduler.fireAll();
  });

  it("correlates results per session: a cross-session result cannot clear another session's slot", () => {
    const scheduler = fakeScheduler();
    const registry = createEditorAgentRegistry(scheduler);
    const a = action({ sessionId: "session-A", actionId: "shared-id", idempotencyKey: "kA" });
    registry.queueAction(a, a);
    expect(registry.pendingCount("session-A")).toBe(1);
    expect(scheduler.pending()).toBe(1);

    // A result reusing the SAME actionId but a DIFFERENT sessionId must not touch session A's slot.
    registry.reportResult({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: "shared-id",
      sessionId: "session-B",
      status: "succeeded",
    });
    expect(registry.pendingCount("session-A")).toBe(1);
    expect(scheduler.pending()).toBe(1);

    // Session A still self-heals on its own timeout.
    scheduler.fireAll();
    expect(registry.pendingCount("session-A")).toBe(0);
  });

  it("rejects a second action that reuses an in-flight actionId, preserving the first's deadline", () => {
    const scheduler = fakeScheduler();
    const registry = createEditorAgentRegistry(scheduler);
    const first = action({ actionId: "dup", idempotencyKey: "k1" });
    const second = action({ actionId: "dup", idempotencyKey: "k2", type: "format" });
    expect(registry.queueAction(first, first).kind).toBe("queued");

    const rejected = registry.queueAction(second, second);
    expect(rejected.kind).toBe("rejected");
    expect(rejected.result.status).toBe("failed");
    // No QUEUE_FULL code — it is a duplicate, not backpressure.
    expect(rejected.result.failure).toBeUndefined();
    // The first action keeps exactly one armed timer; it is not superseded.
    expect(registry.pendingCount("session-1")).toBe(1);
    expect(scheduler.pending()).toBe(1);
  });

  it("bounds the session registry, evicting the oldest idle session", () => {
    const registry = createEditorAgentRegistry({ ...fakeScheduler(), maxSessions: 2 });
    registry.registerSnapshot(snapshot("session-1"), CAPABILITY_DIGEST);
    registry.registerSnapshot(snapshot("session-2"), CAPABILITY_DIGEST);
    // session-2 is kept live by a bridge, so the oldest IDLE session (session-1) is evicted on overflow.
    registry.connect("session-2", () => undefined);
    registry.registerSnapshot(snapshot("session-3"), CAPABILITY_DIGEST);

    expect(registry.snapshotFor("session-1")).toBeUndefined();
    expect(registry.snapshotFor("session-2")?.sessionId).toBe("session-2");
    expect(registry.snapshotFor("session-3")?.sessionId).toBe("session-3");
  });
});
