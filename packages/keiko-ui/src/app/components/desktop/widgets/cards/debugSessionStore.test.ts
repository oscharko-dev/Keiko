import { describe, expect, it } from "vitest";
import type { DebugSession } from "@oscharko-dev/keiko-contracts";
import {
  applyDebugEvent,
  DEBUG_CONSOLE_LIMITS,
  debugSessionSnapshot,
  resetDebugSessionStoreForTests,
  setDebugSession,
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

  it("does not let a late session refresh erase an exception description", () => {
    const workspaceId = "canonical-workspace-id";
    setDebugSession(workspaceId, session("running", 0));
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
    setDebugSession(workspaceId, session("paused", 1));
    setDebugSession(workspaceId, session("running", 1));
    setDebugSession(workspaceId, session("paused", 1));

    expect(debugSessionSnapshot(workspaceId)).toMatchObject({
      session: { status: "paused", pauseGeneration: 1 },
      stopDescription: { value: "Fixture uncaught exception" },
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
