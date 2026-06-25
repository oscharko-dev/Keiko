import { describe, expect, it } from "vitest";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  type EditorAgentAction,
  type EditorAgentEvent,
  type EditorAgentSessionSnapshot,
} from "@oscharko-dev/keiko-contracts";
import { createEditorAgentRegistry } from "./agentSessionRegistry.js";

const HASH = "a".repeat(64);

// A controllable timer seam so the queue lifecycle (timeout, cleanup, clear-on-result) is
// deterministic without global fake timers.
function fakeScheduler(): {
  setTimer: (handler: () => void) => unknown;
  clearTimer: (handle: unknown) => void;
  pending: () => number;
  fireAll: () => void;
} {
  let nextId = 0;
  const handlers = new Map<number, () => void>();
  return {
    setTimer: (handler: () => void): unknown => {
      const id = (nextId += 1);
      handlers.set(id, handler);
      return id;
    },
    clearTimer: (handle: unknown): void => {
      handlers.delete(handle as number);
    },
    pending: (): number => handlers.size,
    fireAll: (): void => {
      const snapshot = [...handlers.entries()];
      handlers.clear();
      for (const [, handler] of snapshot) handler();
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
  it("registers snapshots and reads them back", () => {
    const registry = createEditorAgentRegistry();
    registry.registerSnapshot(snapshot());
    registry.registerSnapshot(snapshot("session-2"));
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

    registry.reportResult({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: "a1",
      sessionId: "session-1",
      status: "succeeded",
    });
    const a4 = action({ actionId: "a4", idempotencyKey: "k4" });
    expect(registry.queueAction(a4, a4).kind).toBe("queued");
  });

  it("scopes event fan-out to the target session plus global observers", () => {
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
    expect(observer.filter((e) => e.type === "action")).toHaveLength(1);
    expect(bridge2.filter((e) => e.type === "action")).toHaveLength(0);
  });

  it("emits unknown results for observer visibility without touching the queue", () => {
    const registry = createEditorAgentRegistry(fakeScheduler());
    const seen: EditorAgentEvent[] = [];
    registry.connect("session-1", (event) => seen.push(event));

    registry.reportResult({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: "never-queued",
      sessionId: "session-1",
      status: "succeeded",
    });
    expect(seen.at(-1)?.type).toBe("result");
    expect(registry.pendingCount("session-1")).toBe(0);
  });

  it("reset clears state and disarms pending timers", () => {
    const scheduler = fakeScheduler();
    const registry = createEditorAgentRegistry(scheduler);
    registry.registerSnapshot(snapshot());
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
});
