import { describe, expect, it, vi } from "vitest";
import type { DebugSession } from "@oscharko-dev/keiko-contracts";
import {
  abandonDebugStreamResync,
  applyDebugEvent,
  beginDebugStreamResync,
  DEBUG_CONSOLE_LIMITS,
  debugSessionSnapshot,
  debugStreamSnapshotRequiresCanonicalResync,
  exhaustDebugStreamResync,
  resetDebugSessionStoreForTests,
  setDebugInstrumentation,
  setDebugScopes,
  setDebugSession,
  setDebugStack,
  setDebugVariables,
  synchronizeDebugSequence,
} from "./debugSessionStore";

function session(status: "paused" | "running", pauseGeneration: number): DebugSession {
  return {
    schemaVersion: "1",
    sessionId: "session-1",
    workspaceId: "canonical-workspace-id",
    status,
    targetKind: "file",
    activationRevision: 1,
    pauseGeneration,
    startedAtMs: 1,
    wallDeadlineMs: 2,
    inactivityDeadlineMs: 3,
    output: { acceptedBytes: 0, truncated: false },
  };
}

describe("debugSessionStore", () => {
  it("retains bounded output in deterministic arrival order and exposes cumulative eviction", () => {
    const workspaceId = "canonical-workspace-id";
    for (let index = 1; index <= DEBUG_CONSOLE_LIMITS.maxEntries + 1; index += 1) {
      applyDebugEvent(workspaceId, index, {
        kind: "output",
        sessionId: "session-1",
        category: "stdout",
        text: String(index),
        truncated: false,
        originalBytes: 1,
        omittedBytes: 0,
      });
    }

    const console = debugSessionSnapshot(workspaceId).console;
    expect(console.entries).toHaveLength(DEBUG_CONSOLE_LIMITS.maxEntries);
    expect(console.entries[0]?.text).toBe("2");
    expect(console.evictedEntries).toBe(1);
    resetDebugSessionStoreForTests();
  });

  it("encodes each retained output entry only once while appending below the limits", () => {
    const workspaceId = "canonical-workspace-id";
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      for (let sequence = 1; sequence <= 4; sequence += 1) {
        applyDebugEvent(workspaceId, sequence, {
          kind: "output",
          sessionId: "session-1",
          category: "stdout",
          text: `entry-${String(sequence)}`,
          truncated: false,
          originalBytes: 7,
          omittedBytes: 0,
        });
      }

      expect(encode).toHaveBeenCalledTimes(4);
    } finally {
      encode.mockRestore();
      resetDebugSessionStoreForTests();
    }
  });

  it("does not re-encode an existing entry when the entry bound evicts it", () => {
    const workspaceId = "canonical-workspace-id";
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      for (let sequence = 1; sequence <= DEBUG_CONSOLE_LIMITS.maxEntries + 1; sequence += 1) {
        applyDebugEvent(workspaceId, sequence, {
          kind: "output",
          sessionId: "session-1",
          category: "stdout",
          text: `entry-${String(sequence)}`,
          truncated: false,
          originalBytes: 7,
          omittedBytes: 0,
        });
      }

      expect(encode).toHaveBeenCalledTimes(DEBUG_CONSOLE_LIMITS.maxEntries + 1);
    } finally {
      encode.mockRestore();
      resetDebugSessionStoreForTests();
    }
  });

  it("tracks the UTF-8 byte boundary incrementally across eviction", () => {
    const workspaceId = "canonical-workspace-id";
    const text = "x".repeat(DEBUG_CONSOLE_LIMITS.upstreamMaxOutputBytes);
    const chunkCount = DEBUG_CONSOLE_LIMITS.maxBytes / DEBUG_CONSOLE_LIMITS.upstreamMaxOutputBytes;
    for (let sequence = 1; sequence <= chunkCount; sequence += 1) {
      applyDebugEvent(workspaceId, sequence, {
        kind: "output",
        sessionId: "session-1",
        category: "stdout",
        text,
        truncated: false,
        originalBytes: text.length,
        omittedBytes: 0,
      });
    }
    applyDebugEvent(workspaceId, chunkCount + 1, {
      kind: "output",
      sessionId: "session-1",
      category: "stdout",
      text: "é",
      truncated: false,
      originalBytes: 2,
      omittedBytes: 0,
    });

    expect(debugSessionSnapshot(workspaceId).console).toMatchObject({
      retainedBytes: DEBUG_CONSOLE_LIMITS.maxBytes - text.length + 2,
      evictedEntries: 1,
      evictedBytes: text.length,
    });
    resetDebugSessionStoreForTests();
  });

  it("ignores duplicate or stale SSE sequence numbers", () => {
    const event = {
      kind: "output" as const,
      sessionId: "session-1",
      category: "console" as const,
      text: "safe",
      truncated: false,
      originalBytes: 4,
      omittedBytes: 0,
    };
    expect(applyDebugEvent("canonical-workspace-id", 2, event)).toBe(true);
    synchronizeDebugSequence("canonical-workspace-id", 1);
    expect(debugSessionSnapshot("canonical-workspace-id").sequence).toBe(2);
    expect(applyDebugEvent("canonical-workspace-id", 2, event)).toBe(false);

    expect(debugSessionSnapshot("canonical-workspace-id").console.entries).toHaveLength(1);
    resetDebugSessionStoreForTests();
  });

  it("accepts the first event after a canonical lower-sequence epoch reset", () => {
    const workspaceId = "canonical-workspace-id";
    const event = {
      kind: "output" as const,
      sessionId: "session-1",
      category: "console" as const,
      text: "safe",
      truncated: false,
      originalBytes: 4,
      omittedBytes: 0,
    };
    expect(applyDebugEvent(workspaceId, 7, event, 1)).toBe(true);
    const resyncToken = beginDebugStreamResync(workspaceId, 2, 2);
    if (resyncToken === null) throw new Error("Expected a current stream resync token.");
    expect(synchronizeDebugSequence(workspaceId, 2, resyncToken, 2)).toBe(true);

    expect(applyDebugEvent(workspaceId, 3, event, 2)).toBe(true);
    expect(applyDebugEvent(workspaceId, 8, event, 1)).toBe(false);
    expect(beginDebugStreamResync(workspaceId, 2, 2)).toBeNull();
    expect(debugSessionSnapshot(workspaceId).sequence).toBe(3);
    expect(debugSessionSnapshot(workspaceId).console.entries).toHaveLength(1);
    resetDebugSessionStoreForTests();
  });

  it("rejects completion and events from a superseded source generation", () => {
    const workspaceId = "canonical-workspace-id";
    const event = {
      kind: "output" as const,
      sessionId: "session-1",
      category: "console" as const,
      text: "safe",
      truncated: false,
      originalBytes: 4,
      omittedBytes: 0,
    };
    expect(applyDebugEvent(workspaceId, 7, event, 1)).toBe(true);
    const staleToken = beginDebugStreamResync(workspaceId, 2, 2);
    const currentToken = beginDebugStreamResync(workspaceId, 3, 1);
    if (staleToken === null || currentToken === null) {
      throw new Error("Expected ordered stream resync tokens.");
    }

    expect(synchronizeDebugSequence(workspaceId, 2, staleToken, 2)).toBe(false);
    expect(synchronizeDebugSequence(workspaceId, 1, currentToken, 3)).toBe(true);
    expect(applyDebugEvent(workspaceId, 100, event, 2)).toBe(false);
    expect(applyDebugEvent(workspaceId, 2, event, 3)).toBe(true);
    expect(debugSessionSnapshot(workspaceId).sequence).toBe(2);
    resetDebugSessionStoreForTests();
  });

  it("keeps an exhausted snapshot terminal while admitting a newer stream generation", () => {
    const workspaceId = "canonical-workspace-id";
    const event = {
      kind: "output" as const,
      sessionId: "session-1",
      category: "console" as const,
      text: "safe",
      truncated: false,
      originalBytes: 4,
      omittedBytes: 0,
    };
    const token = beginDebugStreamResync(workspaceId, 1, 20);
    if (token === null) throw new Error("Expected a current stream resync token.");

    expect(abandonDebugStreamResync(workspaceId, 20, token, 1)).toBe(true);
    expect(exhaustDebugStreamResync(workspaceId, 1, 20)).toBe(true);
    expect(debugStreamSnapshotRequiresCanonicalResync(workspaceId, 1, 20, true)).toBe(false);
    expect(beginDebugStreamResync(workspaceId, 1, 20)).toBeNull();
    expect(applyDebugEvent(workspaceId, 21, event, 1)).toBe(false);

    expect(debugStreamSnapshotRequiresCanonicalResync(workspaceId, 2, 20, true)).toBe(true);
    expect(beginDebugStreamResync(workspaceId, 2, 20)).not.toBeNull();
    resetDebugSessionStoreForTests();
  });

  it("does not republish a structurally identical canonical session refresh", () => {
    const workspaceId = "canonical-workspace-id";
    setDebugSession(workspaceId, session("paused", 2));
    const initial = debugSessionSnapshot(workspaceId);

    setDebugSession(workspaceId, {
      ...session("paused", 2),
      output: { acceptedBytes: 0, truncated: false },
    });

    expect(debugSessionSnapshot(workspaceId)).toBe(initial);
    resetDebugSessionStoreForTests();
  });

  it("does not let an older instrumentation response replace a newer revision", () => {
    const workspaceId = "canonical-workspace-id";
    const snapshot = {
      schemaVersion: "1" as const,
      workspaceId,
      revision: 3,
      etag: "revision-3",
      breakpoints: [],
      exceptionFilters: [],
      watches: [],
    };
    expect(setDebugInstrumentation(workspaceId, snapshot)).toBe(true);
    expect(
      setDebugInstrumentation(workspaceId, {
        ...snapshot,
        revision: 2,
        etag: "revision-2",
      }),
    ).toBe(false);
    expect(debugSessionSnapshot(workspaceId).instrumentation).toMatchObject({ revision: 3 });
    resetDebugSessionStoreForTests();
  });

  it("rejects pause projections after continue and after a newer pause generation", () => {
    const workspaceId = "canonical-workspace-id";
    const pause = { sessionId: "session-1", pauseGeneration: 2 };
    setDebugSession(workspaceId, session("paused", 2));
    applyDebugEvent(workspaceId, 1, {
      kind: "continued",
      sessionId: "session-1",
      pauseGeneration: 2,
    });

    expect(
      setDebugStack(workspaceId, pause, { frames: [], truncated: false, omittedCount: 0 }),
    ).toBe(false);
    expect(debugSessionSnapshot(workspaceId).session?.status).toBe("running");

    setDebugSession(workspaceId, session("paused", 3));
    expect(
      setDebugScopes(workspaceId, pause, {
        frameRef: "frame-1",
        scopes: [],
        truncated: false,
        omittedCount: 0,
      }),
    ).toBe(false);
    expect(
      setDebugVariables(workspaceId, pause, {
        parentRef: "scope-1",
        nodes: [],
        truncated: false,
        omittedCount: 0,
      }),
    ).toBe(false);
    expect(debugSessionSnapshot(workspaceId).scopesByFrame).toHaveLength(0);
    expect(debugSessionSnapshot(workspaceId).variablesByParent).toHaveLength(0);
    resetDebugSessionStoreForTests();
  });

  it("retains a bounded exception description only for the current exception pause", () => {
    const workspaceId = "canonical-workspace-id";
    const description = {
      value: "Fixture uncaught exception",
      truncated: false,
      originalBytes: 26,
      retainedBytes: 26,
      omittedBytes: 0,
    };
    applyDebugEvent(workspaceId, 1, {
      kind: "stopped",
      sessionId: "session-1",
      pauseGeneration: 1,
      reason: "exception",
      allThreadsStopped: true,
      description,
    });
    expect(debugSessionSnapshot(workspaceId).stopDescription).toStrictEqual(description);

    applyDebugEvent(workspaceId, 2, {
      kind: "continued",
      sessionId: "session-1",
      pauseGeneration: 1,
    });
    expect(debugSessionSnapshot(workspaceId).stopDescription).toBeNull();
    resetDebugSessionStoreForTests();
  });

  it("preserves an exception pause when session-started arrives after stopped", () => {
    const workspaceId = "canonical-workspace-id";
    applyDebugEvent(workspaceId, 1, {
      kind: "stopped",
      sessionId: "session-1",
      pauseGeneration: 1,
      reason: "exception",
      allThreadsStopped: true,
      description: {
        value: "Fixture uncaught exception",
        truncated: false,
        originalBytes: 26,
        retainedBytes: 26,
        omittedBytes: 0,
      },
    });
    applyDebugEvent(workspaceId, 2, {
      kind: "session-started",
      sessionId: "session-1",
      status: "running",
    });
    setDebugSession(workspaceId, session("running", 0));
    setDebugSession(workspaceId, session("running", 1));
    setDebugSession(workspaceId, session("paused", 1));

    expect(debugSessionSnapshot(workspaceId)).toMatchObject({
      session: { status: "paused", pauseGeneration: 1 },
      stopDescription: { value: "Fixture uncaught exception" },
    });

    setDebugSession(workspaceId, session("running", 2));
    expect(debugSessionSnapshot(workspaceId)).toMatchObject({
      session: { status: "running", pauseGeneration: 2 },
      stopDescription: null,
    });
    resetDebugSessionStoreForTests();
  });

  it("clears an exception description when a new debug session starts", () => {
    const workspaceId = "canonical-workspace-id";
    applyDebugEvent(workspaceId, 1, {
      kind: "stopped",
      sessionId: "session-1",
      pauseGeneration: 1,
      reason: "exception",
      allThreadsStopped: true,
      description: {
        value: "Fixture uncaught exception",
        truncated: false,
        originalBytes: 26,
        retainedBytes: 26,
        omittedBytes: 0,
      },
    });
    applyDebugEvent(workspaceId, 2, {
      kind: "session-started",
      sessionId: "session-2",
      status: "starting",
    });

    expect(debugSessionSnapshot(workspaceId).stopDescription).toBeNull();
    resetDebugSessionStoreForTests();
  });
});
