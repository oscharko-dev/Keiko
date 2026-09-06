import { describe, expect, it, vi } from "vitest";

import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import { createBufferedServerLogSink } from "../observability/server-log.js";
import {
  createCodingSafeActivityProjection,
  type CodingSafeActivityContent,
  type CodingSafeActivitySignal,
} from "./codingSafeActivityProjection.js";

const RUN_ID = "run-safe-activity";
const WORKSPACE_ID = "workspace-safe-activity";

function message(
  messageId: string,
  role: "user" | "assistant",
  parentMessageId?: string,
): CodingSafeActivitySignal {
  return {
    kind: "message",
    messageId,
    role,
    occurredAt: "2026-07-18T17:00:00.000Z",
    ...(parentMessageId === undefined ? {} : { parentMessageId }),
  };
}

function text(messageId: string, value: string): CodingSafeActivitySignal {
  return {
    kind: "text",
    messageId,
    text: value,
    occurredAt: "2026-07-18T17:00:00.001Z",
  };
}

function populateBoundedTurns(
  projection: ReturnType<typeof createCodingSafeActivityProjection>,
): void {
  for (let index = 0; index < 3; index += 1) {
    const id = `msg_user_${String(index)}`;
    projection.ingest(RUN_ID, message(id, "user"));
    projection.ingest(RUN_ID, text(id, `message-${String(index)}-${"x".repeat(64)}`));
  }
}

describe("bounded coding safe-activity projection", () => {
  it("projects typed conversation and monotonic tool-state transitions without raw tool payloads", () => {
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      diagnostics: { record: (): void => undefined },
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    expect(projection.ingest(RUN_ID, message("msg_user", "user"))).toBe(true);
    expect(projection.ingest(RUN_ID, text("msg_user", "Build the feed."))).toBe(true);
    expect(projection.ingest(RUN_ID, message("msg_assistant", "assistant", "msg_user"))).toBe(true);
    expect(projection.ingest(RUN_ID, text("msg_assistant", "Working."))).toBe(true);
    expect(
      projection.ingest(RUN_ID, {
        kind: "tool",
        messageId: "msg_assistant",
        callId: "call_1",
        tool: "keiko_workspace_read",
        state: "pending",
        occurredAt: "2026-07-18T17:00:00.002Z",
      }),
    ).toBe(true);
    expect(
      projection.ingest(RUN_ID, {
        kind: "tool",
        messageId: "msg_assistant",
        callId: "call_1",
        state: "running",
        occurredAt: "2026-07-18T17:00:00.003Z",
      }),
    ).toBe(true);
    expect(
      projection.ingest(RUN_ID, {
        kind: "tool",
        messageId: "msg_assistant",
        callId: "call_1",
        state: "succeeded",
        occurredAt: "2026-07-18T17:00:00.004Z",
      }),
    ).toBe(true);

    expect(projection.currentContent()).toMatchObject({
      kind: "safe-activity",
      feed: {
        availability: "available",
        runId: RUN_ID,
        turns: [
          {
            messages: [
              { role: "user", segments: [{ text: "Build the feed." }] },
              { role: "assistant", segments: [{ text: "Working." }] },
            ],
            tools: [{ callId: "call_1", tool: "keiko_workspace_read", state: "succeeded" }],
          },
        ],
      },
    });
    expect(JSON.stringify(projection.currentContent())).not.toMatch(
      /arguments|result|output|path/u,
    );
  });

  it("accepts running-to-failed as a monotonic tool transition and settles idempotently on a repeat (#3390)", () => {
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      diagnostics: { record: (): void => undefined },
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.ingest(RUN_ID, message("msg_user", "user"));
    projection.ingest(RUN_ID, message("msg_assistant", "assistant", "msg_user"));
    const running: CodingSafeActivitySignal = {
      kind: "tool",
      messageId: "msg_assistant",
      callId: "call_1",
      tool: "keiko_workspace_discover",
      state: "running",
      occurredAt: "2026-07-18T17:00:00.002Z",
    };
    const failed: CodingSafeActivitySignal = {
      kind: "tool",
      messageId: "msg_assistant",
      callId: "call_1",
      state: "failed",
      occurredAt: "2026-07-18T17:00:00.003Z",
    };
    // Same failed state observed a second time (e.g. the part-level projection and a later
    // facade settlement both resolving to "failed") is idempotent, never a duplicate tool entry.
    const repeatedFailed: CodingSafeActivitySignal = {
      ...failed,
      occurredAt: "2026-07-18T17:00:00.004Z",
    };

    expect(projection.ingest(RUN_ID, running)).toBe(true);
    expect(projection.ingest(RUN_ID, failed)).toBe(true);
    expect(projection.ingest(RUN_ID, repeatedFailed)).toBe(true);

    const content = projection.currentContent();
    expect(content).toMatchObject({
      kind: "safe-activity",
      feed: {
        turns: [
          {
            tools: [
              {
                callId: "call_1",
                tool: "keiko_workspace_discover",
                state: "failed",
                occurredAt: "2026-07-18T17:00:00.004Z",
              },
            ],
          },
        ],
      },
    });
    const feed =
      content?.kind === "safe-activity" && content.feed.availability === "available"
        ? content.feed
        : undefined;
    expect(feed?.turns.flatMap((turn) => turn.tools)).toHaveLength(1);
    // Body-free: no upstream error text ever reaches the projected feed.
    expect(JSON.stringify(content)).not.toMatch(/typo|url or port/u);
  });

  it("marks over-limit text and evicted turns explicitly instead of silently clipping", () => {
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      limits: { maxTurns: 2, maxMessageBytes: 180, maxTurnBytes: 512, maxTotalBytes: 1_024 },
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    populateBoundedTurns(projection);
    const content = projection.currentContent();
    expect(content?.feed).toMatchObject({ availability: "available", truncated: true });
    if (content?.feed.availability !== "available") return;
    expect(content.feed.turns).toHaveLength(2);
    expect(content.feed.turns[0]?.messages[0]?.segments[0]?.truncated).toBe(true);
    expect(content.feed.turns[0]?.messages[0]?.truncated).toBe(true);
    expect(content.feed.turns[0]?.truncated).toBe(true);
  });

  it("rejects hostile shapes and terminal-state regressions without changing retained content", () => {
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      diagnostics: { record: (): void => undefined },
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.ingest(RUN_ID, message("msg_user", "user"));
    projection.ingest(RUN_ID, message("msg_assistant", "assistant", "msg_user"));
    projection.ingest(RUN_ID, {
      kind: "tool",
      messageId: "msg_assistant",
      callId: "call_1",
      tool: "keiko_workspace_read",
      state: "succeeded",
      occurredAt: "2026-07-18T17:00:00.002Z",
    });
    const before = projection.currentContent();
    const beforeTurns =
      before?.feed.availability === "available" ? JSON.stringify(before.feed.turns) : "";
    expect(
      projection.ingest(RUN_ID, {
        ...message("msg_hostile", "user"),
        arguments: "RAW_TOOL_ARGUMENT_2479",
      } as unknown as CodingSafeActivitySignal),
    ).toBe(false);
    expect(
      projection.ingest(RUN_ID, {
        kind: "tool",
        callId: "call_1",
        state: "running",
        occurredAt: "2026-07-18T17:00:00.003Z",
      }),
    ).toBe(false);
    const after = projection.currentContent();
    expect(after?.feed.availability === "available" ? JSON.stringify(after.feed.turns) : "").toBe(
      beforeTurns,
    );
  });

  it("counts text that collapses under the shared Unicode display-safety redactor", () => {
    const records: ServerDiagnosticRecord[] = [];
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      diagnostics: { record: (record) => void records.push(record) },
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.ingest(RUN_ID, message("msg_user", "user"));
    expect(projection.ingest(RUN_ID, text("msg_user", "\u202e\u200b"))).toBe(false);
    expect(records[0]?.message).toContain("redactor-collapsed");
    expect(projection.currentContent()).toMatchObject({ feed: { droppedEventCount: 1 } });
  });

  it("purges on stop, takeover, expiry, workspace switch, shutdown, and crash recovery", () => {
    let now = 1_721_323_200_000;
    let currentWorkspace = true;
    const projection = createCodingSafeActivityProjection({ now: () => now, ttlMs: 100 });
    const open = (): void => {
      projection.open({
        runId: RUN_ID,
        workspaceId: WORKSPACE_ID,
        authorityExpiresAt: "2026-07-18T18:00:00.000Z",
        workspaceIsCurrent: () => currentWorkspace,
      });
      projection.ingest(RUN_ID, message("msg_user", "user"));
      projection.ingest(RUN_ID, text("msg_user", "canary"));
    };

    for (const reason of ["stop", "takeover", "shutdown"] as const) {
      open();
      projection.purge(RUN_ID, reason);
      expect(projection.currentContent()).toBeNull();
    }

    open();
    currentWorkspace = false;
    const priorWorkspaceListener = vi.fn();
    projection.subscribeContent(priorWorkspaceListener);
    expect(projection.currentContent()).toBeNull();
    currentWorkspace = true;
    expect(projection.currentContent()).toBeNull();
    open();
    expect(priorWorkspaceListener).toHaveBeenCalledOnce();

    open();
    now += 101;
    expect(projection.currentContent()).toBeNull();

    open();
    projection.markUnavailable(RUN_ID);
    expect(projection.currentContent()).toMatchObject({
      feed: { availability: "unavailable", runId: RUN_ID },
    });
    expect(JSON.stringify(projection.currentContent())).not.toContain("canary");
  });

  it("counts validation drops saturatingly and emits content-free operator diagnostics", () => {
    const records: ServerDiagnosticRecord[] = [];
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      diagnostics: { record: (record) => void records.push(record) },
      maxDroppedEventCount: 2,
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.recordDrop(RUN_ID, "validation-rejected");
    projection.recordDrop(RUN_ID, "projection-rejected");
    projection.recordDrop(RUN_ID, "validation-rejected");

    expect(projection.currentContent()).toMatchObject({ feed: { droppedEventCount: 2 } });
    expect(records).toHaveLength(2);
    expect(records.at(-1)).toMatchObject({
      operation: "coding-runtime.safe-activity",
      source: "opencode.safe-activity",
      code: "CODING_SAFE_ACTIVITY_EVENT_DROPPED",
      occurrenceCount: 2,
    });
    projection.open({
      runId: "run-safe-activity-2",
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.recordDrop("run-safe-activity-2", "validation-rejected");
    expect(records).toHaveLength(3);
    expect(records.at(-1)).toMatchObject({ occurrenceCount: 1 });
    expect(JSON.stringify(records)).not.toMatch(/raw|arguments|results|canary/u);
  });

  it("keeps a hostile raw canary out of the default operator log", () => {
    const rawCanary = "RAW_DIAGNOSTIC_CANARY_2479";
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const projection = createCodingSafeActivityProjection({ now: () => 1_721_323_200_000 });
      projection.open({
        runId: RUN_ID,
        workspaceId: WORKSPACE_ID,
        authorityExpiresAt: "2026-07-18T18:00:00.000Z",
        workspaceIsCurrent: () => true,
      });
      projection.ingest(RUN_ID, {
        ...message("msg_hostile", "user"),
        rawArguments: rawCanary,
      } as unknown as CodingSafeActivitySignal);

      expect(logged).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logged.mock.calls)).not.toContain(rawCanary);
    } finally {
      logged.mockRestore();
    }
  });

  it("aggregates hostile-page drops into one feed update and bounded milestone diagnostics", () => {
    const records: ServerDiagnosticRecord[] = [];
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      diagnostics: { record: (record) => void records.push(record) },
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    const listener = vi.fn();
    projection.subscribeContent(listener);

    projection.recordDrops(RUN_ID, "validation-rejected", 1_000);

    expect(listener).toHaveBeenCalledOnce();
    expect(projection.currentContent()).toMatchObject({ feed: { droppedEventCount: 1_000 } });
    expect(records.map(({ occurrenceCount }) => occurrenceCount)).toEqual([
      1, 2, 4, 8, 16, 32, 64, 128, 256, 512,
    ]);
  });

  it("notifies and detaches bounded live subscribers", () => {
    const projection = createCodingSafeActivityProjection({ now: () => 1_721_323_200_000 });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    const listener = vi.fn();
    const subscribed = projection.subscribeContent(listener);
    expect(subscribed.admitted).toBe(true);
    projection.ingest(RUN_ID, message("msg_user", "user"));
    expect(listener).toHaveBeenCalledTimes(1);
    subscribed.detach();
    projection.ingest(RUN_ID, text("msg_user", "after detach"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("retains live subscribers across unavailable recovery and removes throwing subscribers", () => {
    const projection = createCodingSafeActivityProjection({ now: () => 1_721_323_200_000 });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    const recoveryListener = vi.fn((_content: CodingSafeActivityContent | null): void => undefined);
    projection.subscribeContent(recoveryListener);

    projection.markUnavailable(RUN_ID);
    projection.open({
      runId: "run-safe-activity-2",
      workspaceId: "workspace-safe-activity-2",
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });

    expect(recoveryListener.mock.calls[0]?.[0]?.feed.availability).toBe("unavailable");
    expect(recoveryListener.mock.calls[1]?.[0]?.feed.availability).toBe("available");

    const throwing = vi.fn(() => {
      throw new Error("subscriber-canary");
    });
    projection.subscribeContent(throwing);
    expect(() => {
      projection.purge("run-safe-activity-2", "workspace-switch");
    }).not.toThrow();
    projection.open({
      runId: "run-safe-activity-3",
      workspaceId: "workspace-safe-activity-3",
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    expect(throwing).toHaveBeenCalledOnce();
  });

  it("physically expires retained activity without requiring a reader", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T17:00:00.000Z"));
    try {
      const projection = createCodingSafeActivityProjection({ ttlMs: 100 });
      projection.open({
        runId: RUN_ID,
        workspaceId: WORKSPACE_ID,
        authorityExpiresAt: "2026-07-18T18:00:00.000Z",
        workspaceIsCurrent: () => true,
      });
      const listener = vi.fn<(content: CodingSafeActivityContent | null) => void>();
      projection.subscribeContent(listener);

      await vi.advanceTimersByTimeAsync(101);

      expect(projection.currentContent()).toBeNull();
      expect(listener).toHaveBeenCalledWith(null);
      projection.open({
        runId: "run-safe-activity-after-expiry",
        workspaceId: WORKSPACE_ID,
        authorityExpiresAt: "2026-07-18T18:00:00.000Z",
        workspaceIsCurrent: () => true,
      });
      const republished = listener.mock.calls.at(-1)?.[0];
      expect(republished?.feed.runId).toBe("run-safe-activity-after-expiry");
    } finally {
      vi.useRealTimers();
    }
  });

  it("purges instead of republishing retained content when a bulk drop races expiry", () => {
    let now = 1_721_323_200_000;
    const projection = createCodingSafeActivityProjection({ now: () => now, ttlMs: 100 });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.ingest(RUN_ID, message("msg_user", "user"));
    projection.ingest(RUN_ID, text("msg_user", "EXPIRY_RAW_CANARY_2479"));
    const listener = vi.fn((_content: CodingSafeActivityContent | null): void => undefined);
    projection.subscribeContent(listener);

    now += 101;
    projection.recordDrops(RUN_ID, "validation-rejected", 1_000);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(null);
    expect(JSON.stringify(listener.mock.calls)).not.toContain("EXPIRY_RAW_CANARY_2479");
    expect(projection.currentContent()).toBeNull();
  });

  it("enforces per-turn message, segment, tool, and subscriber capacities explicitly", () => {
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      limits: { maxMessagesPerTurn: 2, maxSegmentsPerMessage: 1, maxToolsPerTurn: 1 },
      maxSubscribers: 1,
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.ingest(RUN_ID, message("msg_user", "user"));
    projection.ingest(RUN_ID, message("msg_assistant", "assistant", "msg_user"));
    expect(projection.ingest(RUN_ID, message("msg_extra", "assistant", "msg_user"))).toBe(true);
    projection.ingest(RUN_ID, text("msg_extra", "first"));
    expect(projection.ingest(RUN_ID, text("msg_extra", "second"))).toBe(true);
    projection.ingest(RUN_ID, {
      kind: "tool",
      messageId: "msg_extra",
      callId: "call_1",
      tool: "keiko_workspace_read",
      state: "pending",
      occurredAt: "2026-07-18T17:00:00.002Z",
    });
    expect(
      projection.ingest(RUN_ID, {
        kind: "tool",
        messageId: "msg_extra",
        callId: "call_2",
        tool: "keiko_workspace_read",
        state: "pending",
        occurredAt: "2026-07-18T17:00:00.003Z",
      }),
    ).toBe(true);
    projection.subscribeContent(vi.fn());
    const rejectedSubscriber = projection.subscribeContent(vi.fn());
    rejectedSubscriber.detach();

    expect(projection.currentContent()).toMatchObject({
      feed: {
        droppedEventCount: 1,
        turns: [
          {
            messages: [
              {},
              { messageId: "msg_extra", segments: [{ text: "first" }], truncated: true },
            ],
            tools: [{ callId: "call_1" }],
            truncated: true,
          },
        ],
      },
    });
  });

  it("retains the user anchor and newest assistant while older in-flight tools settle", () => {
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      limits: { maxMessagesPerTurn: 3 },
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.ingest(RUN_ID, message("msg_user", "user"));
    projection.ingest(RUN_ID, message("msg_old", "assistant", "msg_user"));
    projection.ingest(RUN_ID, text("msg_old", "Old progress."));
    projection.ingest(RUN_ID, {
      kind: "tool",
      messageId: "msg_old",
      callId: "call_old",
      tool: "keiko_git_push",
      state: "running",
      occurredAt: "2026-07-18T17:00:00.002Z",
    });
    projection.ingest(RUN_ID, message("msg_middle", "assistant", "msg_user"));

    expect(projection.ingest(RUN_ID, message("msg_new", "assistant", "msg_user"))).toBe(true);
    expect(projection.ingest(RUN_ID, text("msg_new", "Newest progress."))).toBe(true);
    expect(projection.ingest(RUN_ID, text("msg_old", "Late old text."))).toBe(false);
    expect(
      projection.ingest(RUN_ID, {
        kind: "tool",
        callId: "call_old",
        state: "succeeded",
        occurredAt: "2026-07-18T17:00:00.003Z",
      }),
    ).toBe(true);
    expect(
      projection.ingest(RUN_ID, {
        kind: "tool",
        messageId: "msg_new",
        callId: "call_new",
        tool: "keiko_pull_request",
        state: "running",
        occurredAt: "2026-07-18T17:00:00.004Z",
      }),
    ).toBe(true);
    expect(
      projection.ingest(RUN_ID, {
        kind: "tool",
        callId: "call_unknown",
        state: "succeeded",
        occurredAt: "2026-07-18T17:00:00.005Z",
      }),
    ).toBe(false);

    expect(projection.currentContent()).toMatchObject({
      feed: {
        droppedEventCount: 2,
        turns: [
          {
            messages: [
              { messageId: "msg_user", role: "user" },
              { messageId: "msg_middle", role: "assistant" },
              {
                messageId: "msg_new",
                role: "assistant",
                segments: [{ text: "Newest progress." }],
              },
            ],
            tools: [
              { callId: "call_old", state: "succeeded" },
              { callId: "call_new", state: "running" },
            ],
            truncated: true,
          },
        ],
      },
    });
  });

  it("fails closed for invalid opening authority, unmatched signals, and throwing workspace checks", () => {
    const projection = createCodingSafeActivityProjection({ now: () => 1_721_323_200_000 });
    projection.open({
      runId: "unsafe run id",
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    expect(projection.currentContent()).toBeNull();

    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    expect(projection.ingest("other-run", message("msg_user", "user"))).toBe(false);
    expect(projection.ingest(RUN_ID, message("msg_assistant", "assistant", "missing"))).toBe(false);
    expect(projection.ingest(RUN_ID, text("missing", "orphan"))).toBe(false);
    expect(
      projection.ingest(RUN_ID, {
        kind: "tool",
        callId: "call_orphan",
        state: "running",
        occurredAt: "2026-07-18T17:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      projection.ingest(RUN_ID, {
        ...message("msg_invalid_time", "user"),
        occurredAt: "invalid",
      }),
    ).toBe(false);

    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => {
        throw new Error("private workspace failure");
      },
    });
    expect(projection.currentContent()).toBeNull();
  });

  it("deduplicates upstream signals and marks turn and feed byte eviction", () => {
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      limits: { maxTurnBytes: 260, maxTotalBytes: 520 },
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    const first = { ...message("msg_user_1", "user"), signalId: "evt_1" } as const;
    expect(projection.ingest(RUN_ID, first)).toBe(true);
    expect(projection.ingest(RUN_ID, first)).toBe(true);
    projection.ingest(RUN_ID, text("msg_user_1", `${"😀".repeat(100)}tail`));
    for (let index = 2; index <= 4; index += 1) {
      const id = `msg_user_${String(index)}`;
      projection.ingest(RUN_ID, message(id, "user"));
      projection.ingest(RUN_ID, text(id, "x".repeat(200)));
    }

    const content = projection.currentContent();
    expect(content?.feed).toMatchObject({ availability: "available", truncated: true });
    if (content?.feed.availability !== "available") return;
    expect(content.feed.turns.length).toBeLessThan(4);
    expect(JSON.stringify(content)).not.toContain("tail");
  });

  it("ignores mismatched purge requests and can purge an existing feed process-wide", () => {
    const projection = createCodingSafeActivityProjection({ now: () => 1_721_323_200_000 });
    projection.purgeAll("shutdown");
    projection.markUnavailable("other-run");
    expect(projection.currentContent()).toMatchObject({ feed: { droppedEventCount: 0 } });
    projection.purge(RUN_ID, "stop");
    expect(projection.currentContent()).not.toBeNull();
    projection.purgeAll("shutdown");
    expect(projection.currentContent()).toBeNull();
  });

  it("clears expired subscribers on a later workspace-wide purge", () => {
    let now = 1_721_323_200_000;
    const projection = createCodingSafeActivityProjection({ now: () => now, ttlMs: 100 });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    const priorWorkspaceListener = vi.fn();
    projection.subscribeContent(priorWorkspaceListener);
    now += 100;
    expect(projection.currentContent()).toBeNull();

    projection.purgeAll("workspace-switch");
    projection.open({
      runId: "run-safe-activity-next",
      workspaceId: "workspace-safe-activity-next",
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });

    expect(priorWorkspaceListener).toHaveBeenCalledOnce();
  });

  it("records a content-free diagnostic for explicit purge reasons", () => {
    const records: ServerDiagnosticRecord[] = [];
    const activityLog = createBufferedServerLogSink();
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      diagnostics: { record: (record) => void records.push(record) },
      activityLog,
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });

    projection.purge(RUN_ID, "takeover");

    expect(records).toContainEqual(
      expect.objectContaining({
        code: "CODING_SAFE_ACTIVITY_PURGED",
        correlationId: RUN_ID,
        errorClass: "SafeActivityProjectionPurge",
      }),
    );
    expect(JSON.stringify(records)).toContain("takeover");
    expect(activityLog.events).toContainEqual({
      category: "process",
      op: "coding-runtime.safe-activity",
      correlationId: RUN_ID,
      extra: { event: "purged", reason: "takeover" },
    });
  });

  it("replaces the plan snapshot with monotonic revisions and purges it with the feed", () => {
    const projection = openProjection();
    expect(
      projection.ingest(
        RUN_ID,
        planSignal([
          { text: "Read the entry point", state: "active" },
          { text: "Apply the bounded edit", state: "pending" },
        ]),
      ),
    ).toBe(true);
    expect(projection.currentContent()?.feed).toMatchObject({
      plan: {
        revision: 1,
        anchorMessageId: "msg_assistant_plan",
        steps: [
          { text: "Read the entry point", state: "active", truncated: false },
          { text: "Apply the bounded edit", state: "pending", truncated: false },
        ],
        truncated: false,
      },
    });
    expect(
      projection.ingest(RUN_ID, planSignal([{ text: "Verify the change", state: "active" }])),
    ).toBe(true);
    const replaced = projection.currentContent()?.feed;
    expect(replaced).toMatchObject({
      plan: { revision: 2, steps: [{ text: "Verify the change", state: "active" }] },
    });
    expect(JSON.stringify(replaced)).not.toContain("Read the entry point");
    projection.purge(RUN_ID, "stop");
    expect(projection.currentContent()).toBeNull();
  });

  it("bounds plan steps, clips step text, strips unsafe characters, and stays idempotent", () => {
    const projection = openProjection();
    const oversized = Array.from({ length: 70 }, (_, index) => ({
      text: `step-${String(index)}-${"x".repeat(300)}`,
      state: "pending" as const,
    }));
    expect(projection.ingest(RUN_ID, { ...planSignal(oversized), signalId: "plan-signal-1" })).toBe(
      true,
    );
    const first = projection.currentContent()?.feed;
    if (first?.availability !== "available" || first.plan === undefined) {
      throw new Error("expected an available feed with a plan");
    }
    expect(first.plan.steps.length).toBeLessThanOrEqual(64);
    expect(first.plan.truncated).toBe(true);
    expect(first.plan.steps[0]?.truncated).toBe(true);
    expect(first.plan.steps[0]?.text.length).toBeLessThanOrEqual(256);
    expect(projection.ingest(RUN_ID, { ...planSignal(oversized), signalId: "plan-signal-1" })).toBe(
      true,
    );
    expect(projection.currentContent()?.feed).toMatchObject({ plan: { revision: 1 } });
    expect(projection.ingest(RUN_ID, planSignal([{ text: "\u200b", state: "pending" }]))).toBe(
      false,
    );
    expect(projection.currentContent()?.feed).toMatchObject({
      plan: { revision: 1 },
      droppedEventCount: 1,
    });
  });

  it("publishes a clipped over-long step instead of dropping the whole plan update", () => {
    const projection = openProjection();
    expect(
      projection.ingest(RUN_ID, planSignal([{ text: "y".repeat(300), state: "pending" }])),
    ).toBe(true);
    const feed = projection.currentContent()?.feed;
    if (feed?.availability !== "available" || feed.plan === undefined) {
      throw new Error("expected an available feed with a plan");
    }
    expect(feed.plan.steps).toHaveLength(1);
    expect(feed.plan.steps[0]?.text.length).toBeLessThanOrEqual(256);
    expect(feed.plan.steps[0]?.truncated).toBe(true);
    expect(feed.plan.truncated).toBe(true);
    expect(feed.droppedEventCount).toBe(0);
  });

  it("rejects malformed plan signals without mutating the published plan", () => {
    const projection = openProjection();
    expect(projection.ingest(RUN_ID, planSignal([{ text: "Keep", state: "completed" }]))).toBe(
      true,
    );
    const malformed: CodingSafeActivitySignal[] = [
      { ...planSignal([{ text: "x", state: "pending" }]), anchorMessageId: "not safe!" },
      planSignal([{ text: "x", state: "in_progress" as never }]),
      planSignal([{ text: 7 as never, state: "pending" }]),
      planSignal([{ text: "x", state: "pending", extra: true } as never]),
      { ...planSignal([]), steps: "none" as never },
    ];
    for (const signal of malformed) {
      expect(projection.ingest(RUN_ID, signal)).toBe(false);
    }
    expect(projection.currentContent()?.feed).toMatchObject({
      plan: { revision: 1, steps: [{ text: "Keep" }] },
      droppedEventCount: malformed.length,
    });
    expect(projection.ingest(RUN_ID, planSignal([]))).toBe(true);
    expect(projection.currentContent()?.feed).toMatchObject({
      plan: { revision: 2, steps: [] },
    });
  });
});

function openProjection(): ReturnType<typeof createCodingSafeActivityProjection> {
  const projection = createCodingSafeActivityProjection({
    now: () => 1_721_323_200_000,
    diagnostics: { record: (): void => undefined },
  });
  projection.open({
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    authorityExpiresAt: "2026-07-18T18:00:00.000Z",
    workspaceIsCurrent: () => true,
  });
  return projection;
}

function planSignal(
  steps: readonly { text: string; state: "pending" | "active" | "completed" | "cancelled" }[],
): Extract<CodingSafeActivitySignal, { readonly kind: "plan" }> {
  return {
    kind: "plan",
    anchorMessageId: "msg_assistant_plan",
    steps,
    occurredAt: "2026-07-18T17:00:00.005Z",
  };
}
