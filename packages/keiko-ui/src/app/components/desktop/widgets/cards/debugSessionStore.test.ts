import { describe, expect, it, vi } from "vitest";
import type { DebugSession } from "@oscharko-dev/keiko-contracts";
import {
  applyDebugEvent,
  DEBUG_CONSOLE_LIMITS,
  debugSessionSnapshot,
  resetDebugSessionStoreForTests,
  setDebugInstrumentation,
  setDebugScopes,
  setDebugSession,
  setDebugStack,
  setDebugVariables,
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
    applyDebugEvent("canonical-workspace-id", 2, event);
    applyDebugEvent("canonical-workspace-id", 2, event);

    expect(debugSessionSnapshot("canonical-workspace-id").console.entries).toHaveLength(1);
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
