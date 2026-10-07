import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";

import { describe, expect, it, vi } from "vitest";
import {
  CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS,
  validateCodingSafeActivityFeed,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import { validateRegisteredActivityLogEvent } from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import {
  codingSafeActivityTtlMs,
  createCodingSafeActivityProjection,
  type CodingSafeActivityContent,
  type CodingSafeActivitySignal,
} from "./codingSafeActivityProjection.js";
import {
  DEFAULT_RUNTIME_MAX_DURATION_MINUTES,
  MAX_RUNTIME_MAX_DURATION_MINUTES,
  runtimeMaxDurationMs,
} from "./productionRuntimeWorkspaceAuthority.js";

const RUN_ID = "run-safe-activity";
const WORKSPACE_ID = "workspace-safe-activity";
const FULL_SEGMENT = "a".repeat(CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS);

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

function reasoning(messageId: string, value: string): CodingSafeActivitySignal {
  return {
    kind: "reasoning",
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
  it("owns canonical tool facts across native restatement and replay without logging paths", () => {
    const log = createBufferedServerLogSink();
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      activityLog: log,
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
      callId: "call_presented",
      tool: "keiko_workspace_read",
      state: "running",
      occurredAt: "2026-07-18T17:00:00.002Z",
    });
    const presentation = {
      relativePath: "packages/deep/RELATIVE_PATH_SENTINEL.ts",
      readByteCount: 12,
      totalFileLines: 300,
      bridgeDurationMs: 25,
    };
    const settled = {
      kind: "tool" as const,
      callId: "call_presented",
      state: "succeeded" as const,
      occurredAt: "2026-07-18T17:00:00.003Z",
      presentation,
    };
    expect(projection.ingest(RUN_ID, settled)).toBe(true);
    presentation.readByteCount = 999;
    presentation.relativePath = "CHANGED_CALLER_PATH.ts";
    projection.ingest(RUN_ID, {
      kind: "tool",
      callId: settled.callId,
      state: "succeeded",
      messageId: "msg_assistant",
      occurredAt: "2026-07-18T17:00:00.003Z",
    });
    projection.ingest(RUN_ID, {
      kind: "tool",
      callId: settled.callId,
      state: "running",
      messageId: "msg_assistant",
      occurredAt: "2026-07-18T17:00:00.004Z",
    });
    expect(projection.currentContent()).toMatchObject({
      feed: {
        turns: [
          {
            tools: [
              {
                presentation: {
                  relativePath: "packages/deep/RELATIVE_PATH_SENTINEL.ts",
                  readByteCount: 12,
                  totalFileLines: 300,
                  bridgeDurationMs: 25,
                },
              },
            ],
          },
        ],
      },
    });
    expect(log.events).toHaveLength(1);
    expect(log.events[0]?.op).toBe("coding-runtime.safe-activity");
    expect(JSON.stringify(log.events)).not.toMatch(/RELATIVE_PATH_SENTINEL|CHANGED_CALLER_PATH/u);
    const replay = projection.currentContent()?.feed;
    const replayFacts =
      replay?.availability === "available" ? replay.turns[0]?.tools[0]?.presentation : undefined;
    if (replayFacts === undefined) throw new Error("Expected replayed tool facts");
    expect(Object.isFrozen(replayFacts)).toBe(true);
    expect(Reflect.set(replayFacts, "readByteCount", 999)).toBe(false);
  });

  it("keeps presented paths inside the existing aggregate feed byte ceiling", () => {
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      limits: { maxTurnBytes: 512, maxTotalBytes: 1_024 },
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
    for (let index = 0; index < 8; index += 1) {
      const signal = {
        kind: "tool" as const,
        messageId: "msg_assistant",
        callId: `call_bound_${String(index)}`,
        tool: "keiko_workspace_read",
        state: "succeeded" as const,
        occurredAt: "2026-07-18T17:00:00.002Z",
        presentation: { relativePath: `src/${"long-path-".repeat(100)}.ts`, bridgeDurationMs: 1 },
      };
      projection.ingest(RUN_ID, signal);
    }
    const content = projection.currentContent();
    expect(content).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(content?.feed), "utf8")).toBeLessThanOrEqual(1_024);
    expect(content?.feed).toMatchObject({ turns: [{ truncated: true }] });
  });

  it.each([
    { bridgeDurationMs: Number.NaN },
    { bridgeDurationMs: Number.POSITIVE_INFINITY },
    { refusalReason: "RAW_REFUSAL_SENTINEL" },
    { bridgeDurationMs: 1, stdout: "RAW_OUTPUT_SENTINEL" },
    { relativePath: "../PATH_ESCAPE_SENTINEL.ts" },
  ])("rejects noncanonical presentation at the producer signal boundary: %s", (presentation) => {
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
    const signal: CodingSafeActivitySignal = {
      kind: "tool",
      messageId: "msg_user",
      callId: "call_invalid",
      tool: "keiko_workspace_read",
      state: "succeeded",
      occurredAt: "2026-07-18T17:00:00.002Z",
    };
    Object.defineProperty(signal, "presentation", { value: presentation, enumerable: true });
    expect(projection.ingest(RUN_ID, signal)).toBe(false);
    expect(JSON.stringify(projection.currentContent())).not.toContain("SENTINEL");
    expect(projection.currentContent()?.feed.droppedEventCount).toBe(1);
  });

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
                occurredAt: "2026-07-18T17:00:00.003Z",
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

  // #3612: Keiko settles a refused governed ask with the human's verdict. OpenCode then reports the
  // refused call as a generic failure; that report keeps the verdict and counts as no omitted update.
  // Since 1.1.10 a declined or expired ask answers with the call's own refusal result, which OpenCode
  // reports as a completed call (ADR-0124 D6) — lab 2026-09-26: that report was refused as a
  // regression, dropped, and opened a support incident on every denial.
  it.each([
    ["denied", "failed"],
    ["cancelled", "failed"],
    ["denied", "succeeded"],
    ["cancelled", "succeeded"],
  ] as const)(
    "keeps a %s verdict when OpenCode later reports the call %s, without an omitted update",
    (verdict, reported) => {
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
      const signals: readonly CodingSafeActivitySignal[] = [
        {
          kind: "tool",
          messageId: "msg_assistant",
          callId: "call_1",
          tool: "keiko_changeset_edit",
          state: "running",
          occurredAt: "2026-07-18T17:00:00.002Z",
        },
        // Keiko's own settlement carries no message id; it locates the call by id.
        { kind: "tool", callId: "call_1", state: verdict, occurredAt: "2026-07-18T17:00:00.003Z" },
        {
          kind: "tool",
          messageId: "msg_assistant",
          callId: "call_1",
          state: reported,
          occurredAt: "2026-07-18T17:00:00.004Z",
        },
      ];
      for (const signal of signals) expect(projection.ingest(RUN_ID, signal)).toBe(true);

      expect(projection.currentContent()).toMatchObject({
        feed: {
          droppedEventCount: 0,
          turns: [
            {
              tools: [
                {
                  callId: "call_1",
                  tool: "keiko_changeset_edit",
                  state: verdict,
                  occurredAt: "2026-07-18T17:00:00.003Z",
                },
              ],
            },
          ],
        },
      });
    },
  );

  // Keiko's governed settlement wins over late OpenCode part states: both an earlier running update
  // and OpenCode's HTTP-level success for a red verification are restatements, not missing activity.
  it.each([
    ["succeeded", "pending"],
    ["succeeded", "running"],
    ["failed", "running"],
    ["failed", "succeeded"],
    ["denied", "running"],
    ["cancelled", "pending"],
  ] as const)(
    "keeps a settled %s call when OpenCode's earlier %s update arrives late",
    (settled, late) => {
      const activityLog = createBufferedServerLogSink();
      const projection = createCodingSafeActivityProjection({
        now: () => 1_721_323_200_000,
        diagnostics: { record: (): void => undefined },
        activityLog,
      });
      projection.open({
        runId: RUN_ID,
        workspaceId: WORKSPACE_ID,
        authorityExpiresAt: "2026-07-18T18:00:00.000Z",
        workspaceIsCurrent: () => true,
      });
      projection.ingest(RUN_ID, message("msg_user", "user"));
      projection.ingest(RUN_ID, message("msg_assistant", "assistant", "msg_user"));
      const signals: readonly CodingSafeActivitySignal[] = [
        {
          kind: "tool",
          messageId: "msg_assistant",
          callId: "call_fast",
          tool: "keiko_workspace_read",
          state: "pending",
          occurredAt: "2026-07-18T17:00:00.002Z",
        },
        {
          kind: "tool",
          callId: "call_fast",
          state: settled,
          occurredAt: "2026-07-18T17:00:00.003Z",
        },
        {
          kind: "tool",
          messageId: "msg_assistant",
          callId: "call_fast",
          state: late,
          occurredAt: "2026-07-18T17:00:00.004Z",
        },
      ];
      const [created, settle, lateUpdate] = signals;
      if (created === undefined || settle === undefined || lateUpdate === undefined)
        throw new Error("expected three tool signals");
      expect(projection.ingest(RUN_ID, created)).toBe(true);
      expect(projection.ingest(RUN_ID, settle)).toBe(true);
      const beforeLate = projection.currentContent();
      const notified = vi.fn();
      projection.subscribeContent(notified);
      expect(projection.ingest(RUN_ID, lateUpdate)).toBe(true);
      // PR #3617 review: the late update changes neither the feed nor its timestamp, and notifies
      // no one.
      expect(projection.currentContent()).toEqual(beforeLate);
      expect(notified).not.toHaveBeenCalled();
      expect(projection.currentContent()).toMatchObject({
        feed: {
          droppedEventCount: 0,
          updatedAt: "2026-07-18T17:00:00.003Z",
          turns: [{ tools: [{ callId: "call_fast", state: settled }] }],
        },
      });
      // PR #3617 review: the late update is set aside, not silently discarded, and its line names
      // the call, as a digest, and both states.
      const superseded = activityLog.events.filter(
        (event) => event.op === "coding-runtime.safe-activity",
      );
      expect(superseded).toEqual([
        expect.objectContaining({
          correlationId: RUN_ID,
          extra: expect.objectContaining({
            event: "superseded",
            reason: "late-restatement",
            occurrenceCount: 1,
            callIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown,
            settledState: settled,
            restatedState: late,
          }) as unknown,
        }),
      ]);
      const [supersededLine] = superseded;
      if (supersededLine === undefined) throw new Error("expected one superseded line");
      expect(supersededLine.level).toBeUndefined();
      expect(validateRegisteredActivityLogEvent(supersededLine)).toMatchObject({
        op: "coding-runtime.safe-activity",
      });
    },
  );

  it("still refuses to reopen a failed or succeeded call", () => {
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
    // Only a Keiko verdict absorbs a later generic failure; a success does not turn into one.
    expect(
      projection.ingest(RUN_ID, {
        kind: "tool",
        callId: "call_1",
        state: "failed",
        occurredAt: "2026-07-18T17:00:00.003Z",
      }),
    ).toBe(false);
    expect(projection.currentContent()).toMatchObject({
      feed: {
        droppedEventCount: 1,
        turns: [{ tools: [{ callId: "call_1", state: "succeeded" }] }],
      },
    });
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

  // #3873: the Authority Envelope duration is an operator setting (KEIKO_CODING_RUNTIME_MAX_
  // DURATION_MINUTES, formerly a fixed 30 minutes), and this projection's TTL is a hard cap that
  // wins over a longer authority (the expiry tests below). A default of 30 minutes therefore evicted
  // a live run's feed at minute 30 of a 120-minute envelope. The default now follows the default
  // envelope duration and production derives a configured TTL through `codingSafeActivityTtlMs`;
  // both outlive the envelope by the retention margin, so the authority expiry — not the cap — ends
  // a live run's feed.
  it("retains a live run for the whole envelope duration by default and for a configured one", () => {
    const start = 1_721_323_200_000;
    let now = start;
    const defaultEnvelopeMs = runtimeMaxDurationMs(DEFAULT_RUNTIME_MAX_DURATION_MINUTES);
    const projection = createCodingSafeActivityProjection({ now: () => now });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: new Date(start + defaultEnvelopeMs).toISOString(),
      workspaceIsCurrent: () => true,
    });
    projection.ingest(RUN_ID, message("msg_user", "user"));
    now = start + defaultEnvelopeMs - 1;
    expect(projection.currentContent()?.feed.runId).toBe(RUN_ID);
    now = start + defaultEnvelopeMs;
    expect(projection.currentContent()).toBeNull();

    const configuredEnvelopeMs = runtimeMaxDurationMs(MAX_RUNTIME_MAX_DURATION_MINUTES);
    expect(codingSafeActivityTtlMs(configuredEnvelopeMs)).toBeGreaterThan(configuredEnvelopeMs);
    const configured = createCodingSafeActivityProjection({
      now: () => now,
      ttlMs: codingSafeActivityTtlMs(configuredEnvelopeMs),
    });
    const configuredStart = now;
    configured.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: new Date(configuredStart + configuredEnvelopeMs).toISOString(),
      workspaceIsCurrent: () => true,
    });
    now = configuredStart + configuredEnvelopeMs - 1;
    expect(configured.currentContent()?.feed.runId).toBe(RUN_ID);
    now = configuredStart + configuredEnvelopeMs;
    expect(configured.currentContent()).toBeNull();
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
    // Lab ledger F2: a text signal continues the message's last segment, so the one permitted
    // segment is filled to its character bound before a second one is needed and refused.
    projection.ingest(RUN_ID, text("msg_extra", FULL_SEGMENT));
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
        droppedEventCount: 2,
        turns: [
          {
            messages: [
              {},
              { messageId: "msg_extra", segments: [{ text: FULL_SEGMENT }], truncated: true },
            ],
            tools: [{ callId: "call_1" }],
            truncated: true,
          },
        ],
      },
    });
  });

  it("retains the user anchor and newest assistant while older in-flight tools settle", () => {
    const records: ServerDiagnosticRecord[] = [];
    const activityLog = createBufferedServerLogSink();
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      limits: { maxMessagesPerTurn: 3 },
      diagnostics: { record: (record) => void records.push(record) },
      activityLog,
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
    expect(projection.currentContent()?.feed.droppedEventCount).toBe(1);
    expect(activityLog.events).toContainEqual({
      category: "process",
      op: "coding-runtime.safe-activity",
      correlationId: RUN_ID,
      extra: {
        completeness: "complete",
        event: "dropped",
        loss: "none",
        reason: "capacity-rejected",
        occurrenceCount: 1,
        lossState: "event-dropped",
      },
    });
    expect(
      validateRegisteredActivityLogEvent(
        activityLog.events[0] as unknown as Readonly<Record<PropertyKey, unknown>>,
      ),
    ).toMatchObject({ op: "coding-runtime.safe-activity" });
    const [droppedLine] = activityLog.events;
    if (droppedLine === undefined) throw new Error("expected safe-activity dropped line");
    expect(
      expectActivityLogProof(
        "coding-runtime.safe-activity.emitted-line",
        formatActivityLogProofLine(droppedLine),
      ),
    ).toMatchObject({ event: "dropped", reason: "capacity-rejected" });
    // F49: designed truncation is recorded by that line alone, never as an error diagnostic.
    expect(
      records.filter((record) => record.code === "CODING_SAFE_ACTIVITY_EVENT_DROPPED"),
    ).toEqual([]);
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
        droppedEventCount: 3,
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
    expect(records).toContainEqual(
      expect.objectContaining({
        code: "CODING_SAFE_ACTIVITY_EVENT_DROPPED",
        occurrenceCount: 1,
        correlationId: RUN_ID,
      }),
    );
    // Only the two late signals are faults, counted on their own: the capacity drop before them
    // neither delays nor inflates the first one (F49).
    expect(records.map(({ occurrenceCount }) => occurrenceCount)).toEqual([1, 2]);
    expect(records[0]).toMatchObject({ message: "safe-activity-dropped-projection-rejected" });
    expect(JSON.stringify(activityLog.events)).not.toMatch(/Old progress|Newest progress/u);
  });

  // #3610 (W22): a projection-rejected drop named no cause, so the Workbench's "N update(s) omitted"
  // could not be traced to the signal the projection refused. Every drop line carries its closed
  // cause now; the signal's content never reaches the log.
  it.each([
    [
      "parent-message-unknown",
      (projection: ReturnType<typeof createCodingSafeActivityProjection>): boolean =>
        projection.ingest(RUN_ID, message("msg_orphan", "assistant", "msg_missing")),
    ],
    [
      "message-unknown",
      (projection: ReturnType<typeof createCodingSafeActivityProjection>): boolean =>
        projection.ingest(RUN_ID, text("msg_missing", "Private late text.")),
    ],
    [
      "tool-transition-refused",
      (projection: ReturnType<typeof createCodingSafeActivityProjection>): boolean =>
        projection.ingest(RUN_ID, {
          kind: "tool",
          callId: "call_done",
          state: "running",
          occurredAt: "2026-07-18T17:00:00.004Z",
        }),
    ],
    [
      "tool-name-missing",
      (projection: ReturnType<typeof createCodingSafeActivityProjection>): boolean =>
        projection.ingest(RUN_ID, {
          kind: "tool",
          messageId: "msg_answer",
          callId: "call_nameless",
          state: "running",
          occurredAt: "2026-07-18T17:00:00.004Z",
        }),
    ],
    [
      "reasoning-role-invalid",
      (projection: ReturnType<typeof createCodingSafeActivityProjection>): boolean =>
        projection.ingest(RUN_ID, reasoning("msg_user", "Private late text.")),
    ],
  ] as const)("names the %s cause on a projection-rejected drop", (rejection, refuse) => {
    const activityLog = createBufferedServerLogSink();
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      activityLog,
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.ingest(RUN_ID, message("msg_user", "user"));
    projection.ingest(RUN_ID, message("msg_answer", "assistant", "msg_user"));
    projection.ingest(RUN_ID, {
      kind: "tool",
      messageId: "msg_answer",
      callId: "call_done",
      tool: "keiko_workspace_read",
      state: "succeeded",
      occurredAt: "2026-07-18T17:00:00.003Z",
    });

    expect(refuse(projection)).toBe(false);

    const dropped = activityLog.events.filter(
      (event) => event.op === "coding-runtime.safe-activity" && event.extra?.event === "dropped",
    );
    expect(dropped).toEqual([
      expect.objectContaining({
        correlationId: RUN_ID,
        extra: expect.objectContaining({
          reason: "projection-rejected",
          rejection,
          occurrenceCount: 1,
        }) as unknown,
      }),
    ]);
    const [droppedLine] = dropped;
    if (droppedLine === undefined) throw new Error("expected one projection-rejected drop line");
    expect(validateRegisteredActivityLogEvent(droppedLine)).toMatchObject({
      op: "coding-runtime.safe-activity",
    });
    expect(JSON.stringify(activityLog.events)).not.toContain("Private late text");
  });

  it("reports the first fault drop at once however many capacity drops preceded it", () => {
    const records: ServerDiagnosticRecord[] = [];
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      limits: { maxMessagesPerTurn: 3 },
      diagnostics: { record: (record) => void records.push(record) },
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.ingest(RUN_ID, message("msg_user", "user"));
    for (let index = 0; index < 8; index += 1) {
      projection.ingest(RUN_ID, message(`msg_${String(index)}`, "assistant", "msg_user"));
    }
    expect(projection.currentContent()?.feed.droppedEventCount).toBe(6);
    expect(records).toEqual([]);

    expect(projection.ingest(RUN_ID, text("msg_0", "Late text."))).toBe(false);

    expect(projection.currentContent()?.feed.droppedEventCount).toBe(7);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      code: "CODING_SAFE_ACTIVITY_EVENT_DROPPED",
      message: "safe-activity-dropped-projection-rejected",
      occurrenceCount: 1,
      correlationId: RUN_ID,
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

  it.each(["stop", "takeover", "shutdown", "workspace-switch"] as const)(
    "records a routine %s purge as a purged line, never as a failure diagnostic",
    (reason) => {
      // A routine purge clears an in-memory UI projection and loses nothing. Reported as an
      // error-level server.diagnostic.failure, every server shutdown opened a false support
      // incident. The one fault reason keeps its content-free diagnostic, pinned in
      // codingSafeActivityProjection.invariantPurge.test.ts.
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

      projection.purge(RUN_ID, reason);

      expect(records).toEqual([]);
      expect(activityLog.events).toEqual([
        {
          category: "process",
          op: "coding-runtime.safe-activity",
          correlationId: RUN_ID,
          extra: { completeness: "complete", event: "purged", loss: "none", reason },
        },
      ]);
      expect(
        validateRegisteredActivityLogEvent(
          activityLog.events[0] as unknown as Readonly<Record<PropertyKey, unknown>>,
        ),
      ).toMatchObject({ op: "coding-runtime.safe-activity" });
    },
  );

  it("carries the shutdown's correlation id when no run is left to tie the purge to", () => {
    const activityLog = createBufferedServerLogSink();
    const projection = createCodingSafeActivityProjection({ activityLog });
    // A UI subscription opened while no run was active keeps the purge retained without a run id.
    projection.subscribeContent(() => undefined);

    projection.purgeAll("shutdown", "shutdown-correlation-0001");

    expect(activityLog.events).toEqual([
      expect.objectContaining({
        op: "coding-runtime.safe-activity",
        correlationId: "shutdown-correlation-0001",
        extra: expect.objectContaining({ event: "purged", reason: "shutdown" }) as unknown,
      }),
    ]);
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

type Projection = ReturnType<typeof createCodingSafeActivityProjection>;
type ProjectedMessage = CodingSafeActivityContent["feed"] extends infer Feed
  ? Feed extends { readonly turns: readonly { readonly messages: readonly (infer M)[] }[] }
    ? M
    : never
  : never;

function assistantTurn(
  options: Parameters<typeof createCodingSafeActivityProjection>[0] = {},
): Projection {
  const projection = createCodingSafeActivityProjection({
    now: () => 1_721_323_200_000,
    diagnostics: { record: (): void => undefined },
    ...options,
  });
  projection.open({
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    authorityExpiresAt: "2026-07-18T18:00:00.000Z",
    workspaceIsCurrent: () => true,
  });
  projection.ingest(RUN_ID, message("msg_user", "user"));
  projection.ingest(RUN_ID, message("msg_answer", "assistant", "msg_user"));
  return projection;
}

// The projected message, from a feed that must still satisfy the published contract.
function projected(projection: Projection, messageId = "msg_answer"): ProjectedMessage {
  const feed = projection.currentContent()?.feed;
  if (feed?.availability !== "available") throw new TypeError("expected an available feed");
  expect(validateCodingSafeActivityFeed(feed).ok).toBe(true);
  const found = feed.turns
    .flatMap((turn) => turn.messages)
    .find((candidate) => candidate.messageId === messageId);
  if (found === undefined) throw new TypeError(`missing ${messageId}`);
  return found;
}

function joinedText(message: ProjectedMessage): string {
  return message.segments.map((segment) => segment.text).join("");
}

// Lab ledger F2 (#3873): with live streaming an answer reaches the projection as one small text
// signal per history pull. Each used to open a segment of its own, so a streamed answer was cut off
// after its first 32 pulls. On the pinned OpenCode 2.0.10 the history holds a streamed part empty
// until it ends, so these small signals come from the history projection's live text overlay
// (`opencodeV2History.ts` over `opencodeV2LiveText.ts`, fed by the runtime's delta events), one per
// pull that saw new deltas.
describe("streamed answers in the live feed", () => {
  it("continues the message's last segment instead of truncating after 32 pulls", () => {
    const projection = assistantTurn();
    for (let index = 0; index < 200; index += 1) {
      expect(projection.ingest(RUN_ID, text("msg_answer", "word "))).toBe(true);
    }

    const answer = projected(projection);
    expect(answer.truncated).toBe(false);
    expect(answer.segments).toEqual([
      { kind: "text", text: "word ".repeat(200), truncated: false },
    ]);
  });

  it("splits a long streamed answer at the segment bound without losing text", () => {
    const projection = assistantTurn();
    const pieces = ["a".repeat(3_000), "b".repeat(3_000), "c".repeat(3_000)];
    for (const piece of pieces) projection.ingest(RUN_ID, text("msg_answer", piece));

    const answer = projected(projection);
    expect(answer.truncated).toBe(false);
    expect(answer.segments.map((segment) => segment.text.length)).toEqual([
      CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS,
      CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS,
      9_000 - 2 * CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS,
    ]);
    expect(joinedText(answer)).toBe(pieces.join(""));
  });

  it("never splits a surrogate pair across the segment bound", () => {
    const projection = assistantTurn();
    const almostFull = "a".repeat(CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS - 1);
    projection.ingest(RUN_ID, text("msg_answer", almostFull));
    projection.ingest(RUN_ID, text("msg_answer", "😀 done"));

    const answer = projected(projection);
    expect(answer.segments.map((segment) => segment.text)).toEqual([almostFull, "😀 done"]);
    expect(answer.truncated).toBe(false);
  });

  it("still marks the message truncated once the message byte budget is spent", () => {
    const projection = assistantTurn({ limits: { maxMessageBytes: 600 } });
    for (let index = 0; index < 1_000; index += 1) {
      projection.ingest(RUN_ID, text("msg_answer", "x"));
    }

    const answer = projected(projection);
    expect(answer.truncated).toBe(true);
    expect(answer.segments.at(-1)?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(answer), "utf8")).toBeLessThanOrEqual(600);
  });
});

// #3878: the model's reasoning reaches the live feed beside its assistant message, bounded on its
// own so the answer always keeps room, and it is the first thing to go under byte pressure.
describe("model reasoning in the live feed", () => {
  it("projects streamed reasoning beside the answer, never inside it", () => {
    const projection = assistantTurn();
    for (const piece of ["Look at ", "the parser ", "first."]) {
      projection.ingest(RUN_ID, reasoning("msg_answer", piece));
    }
    projection.ingest(RUN_ID, text("msg_answer", "Fixed."));

    const answer = projected(projection);
    expect(answer.reasoning).toEqual({ text: "Look at the parser first.", truncated: false });
    expect(answer.segments).toEqual([{ kind: "text", text: "Fixed.", truncated: false }]);
    expect(answer.truncated).toBe(false);
  });

  it("clips reasoning at its own bound and keeps it a true prefix of what the model wrote", () => {
    const projection = assistantTurn();
    const long = "r".repeat(CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES + 100);
    projection.ingest(RUN_ID, reasoning("msg_answer", long));
    projection.ingest(RUN_ID, reasoning("msg_answer", "LATER"));
    projection.ingest(RUN_ID, text("msg_answer", "y".repeat(7_000)));

    const answer = projected(projection);
    expect(answer.reasoning).toEqual({
      text: "r".repeat(CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES),
      truncated: true,
    });
    // The reasoning bound leaves the answer room of its own.
    expect(answer.truncated).toBe(false);
    expect(joinedText(answer)).toBe("y".repeat(7_000));
  });

  it("cuts the reasoning back, keeping its beginning, when the answer needs the room", () => {
    const projection = assistantTurn({ limits: { maxMessageBytes: 1_200 } });
    projection.ingest(RUN_ID, reasoning("msg_answer", "q".repeat(500)));
    projection.ingest(RUN_ID, text("msg_answer", "z".repeat(700)));

    const answer = projected(projection);
    expect(answer.truncated).toBe(false);
    expect(joinedText(answer)).toBe("z".repeat(700));
    expect(answer.reasoning?.truncated).toBe(true);
    expect(answer.reasoning?.text).toMatch(/^q+$/u);
    expect(answer.reasoning?.text.length ?? 0).toBeLessThan(500);
  });

  it("sheds older messages' reasoning before any answer text under turn pressure", () => {
    const projection = assistantTurn({ limits: { maxTurnBytes: 2_000 } });
    projection.ingest(RUN_ID, reasoning("msg_answer", "o".repeat(900)));
    projection.ingest(RUN_ID, text("msg_answer", "first answer"));
    projection.ingest(RUN_ID, message("msg_next", "assistant", "msg_user"));
    projection.ingest(RUN_ID, reasoning("msg_next", "n".repeat(900)));
    projection.ingest(RUN_ID, text("msg_next", "second answer"));

    const older = projected(projection);
    const newest = projected(projection, "msg_next");
    expect(older).not.toHaveProperty("reasoning");
    expect(joinedText(older)).toBe("first answer");
    expect(newest.reasoning?.text).toBe("n".repeat(900));
    const feed = projection.currentContent()?.feed;
    expect(feed?.availability === "available" && feed.turns[0]?.truncated).toBe(true);
  });

  it("drops reasoning that a format-character redactor empties", () => {
    const projection = assistantTurn();
    expect(projection.ingest(RUN_ID, reasoning("msg_answer", "\u202E\u2066"))).toBe(false);
    expect(projected(projection)).not.toHaveProperty("reasoning");
  });
});
