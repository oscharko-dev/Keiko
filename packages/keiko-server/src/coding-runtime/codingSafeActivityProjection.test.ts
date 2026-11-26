import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";

import { describe, expect, it, vi } from "vitest";
import {
  CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES,
  validateCodingSafeActivityAnswerPage,
  validateCodingSafeActivityFeed,
  validateCodingSafeActivityTextDeltas,
  type CodingSafeActivityTextPart,
  type CodingSafeActivityTool,
  type CodingSafeActivityToolPresentation,
  type CodingSafeActivityTurn,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import { CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
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
  NATIVE_TOOL_DENIED_TOOLS,
} from "./codingSafeActivityProjection.js";
import { OPENCODE_NATIVE_TOOL_NAMES } from "./opencodeNativeTools.js";
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
  origin?: "keiko",
): CodingSafeActivitySignal {
  return {
    kind: "message",
    messageId,
    role,
    occurredAt: "2026-07-18T17:00:00.000Z",
    ...(parentMessageId === undefined ? {} : { parentMessageId }),
    ...(origin === undefined ? {} : { origin }),
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

function firstTurnToolStates(
  projection: ReturnType<typeof createCodingSafeActivityProjection>,
): (readonly [string, string])[] {
  const feed = projection.currentContent()?.feed;
  if (feed?.availability !== "available") return [];
  return (feed.turns[0]?.tools ?? []).map(({ callId, state }) => [callId, state] as const);
}
// #4491: a user message Keiko dispatched itself keeps its closed origin in the feed; the person's
// own message never carries one, and an origin on an assistant message is refused.
describe("coding safe-activity projection: the origin of a user message", () => {
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

  it("projects a Keiko turn with its origin, the person's without one, and validates the feed", () => {
    const projection = openProjection();
    projection.ingest(RUN_ID, message("msg_person", "user"));
    projection.ingest(RUN_ID, text("msg_person", "Fix it."));
    projection.ingest(RUN_ID, message("msg_keiko", "user", undefined, "keiko"));
    projection.ingest(RUN_ID, text("msg_keiko", "Rerun the failed check."));

    const feed = projection.currentContent()?.feed;
    if (feed?.availability !== "available") throw new Error("expected a feed");
    const [person, keiko] = feed.turns.flatMap((turn) => turn.messages);
    expect(person).not.toHaveProperty("origin");
    expect(keiko).toMatchObject({ messageId: "msg_keiko", origin: "keiko" });
    expect(validateCodingSafeActivityFeed(feed).ok).toBe(true);
  });

  it("refuses an origin on an assistant message and an origin outside the closed word", () => {
    const projection = openProjection();
    projection.ingest(RUN_ID, message("msg_user", "user"));
    expect(
      projection.ingest(RUN_ID, message("msg_assistant", "assistant", "msg_user", "keiko")),
    ).toBe(false);
    expect(
      projection.ingest(RUN_ID, {
        kind: "message",
        messageId: "msg_other",
        role: "user",
        origin: "scheduler",
        occurredAt: "2026-07-18T17:00:00.000Z",
      } as unknown as CodingSafeActivitySignal),
    ).toBe(false);
  });
});

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
    // #4271 T40 audit: OpenCode's permission rejection of a call Keiko already settled (a Stop or a
    // failed facade round trip) is a late restatement, never a refused transition.
    ["cancelled", "denied"],
    ["failed", "denied"],
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

    // The refused second call to an unsettled first one counts toward the loss counter as well.
    expect(projection.currentContent()).toMatchObject({
      feed: {
        droppedEventCount: 3,
        turns: [
          {
            messages: [
              {},
              // The segment bound holds; the answer beyond it is retained and named, never cut.
              {
                messageId: "msg_extra",
                segments: [{ text: FULL_SEGMENT, truncated: false }],
                truncated: false,
                fullAnswer: { length: FULL_SEGMENT.length + "second".length, truncated: false },
              },
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

  // #4130 review lab: four refused transitions could not be told apart in the log, so neither a lost
  // update nor a genuine regression could be reconstructed. The drop line now names both states and
  // who sent the update; the call itself appears only as a digest.
  it.each([
    [
      "an OpenCode update that steps a running call back to pending",
      { messageId: "msg_answer", state: "pending" },
      { refusedFromState: "running", refusedToState: "pending", refusedSignalSource: "opencode" },
    ],
    [
      "a Keiko settlement that reopens a settled call",
      { state: "running", settle: true },
      { refusedFromState: "succeeded", refusedToState: "running", refusedSignalSource: "keiko" },
    ],
  ] as const)("names the refused transition of %s", (_case, refused, expected) => {
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
      callId: "call_private_id",
      tool: "keiko_workspace_read",
      state: "settle" in refused ? "succeeded" : "running",
      occurredAt: "2026-07-18T17:00:00.003Z",
    });

    expect(
      projection.ingest(RUN_ID, {
        kind: "tool",
        ...("messageId" in refused ? { messageId: refused.messageId } : {}),
        callId: "call_private_id",
        state: refused.state,
        occurredAt: "2026-07-18T17:00:00.004Z",
      }),
    ).toBe(false);

    const dropped = activityLog.events.filter(
      (event) => event.op === "coding-runtime.safe-activity" && event.extra?.event === "dropped",
    );
    expect(dropped).toEqual([
      expect.objectContaining({
        correlationId: RUN_ID,
        extra: expect.objectContaining({
          reason: "projection-rejected",
          rejection: "tool-transition-refused",
          ...expected,
          callIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown,
        }) as unknown,
      }),
    ]);
    const [droppedLine] = dropped;
    if (droppedLine === undefined) throw new Error("expected one refused-transition drop line");
    expect(validateRegisteredActivityLogEvent(droppedLine)).toMatchObject({
      op: "coding-runtime.safe-activity",
    });
    expect(JSON.stringify(activityLog.events)).not.toContain("call_private_id");
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

  // A subscriber may deliver the same signal again while it is being notified. The identity is
  // remembered before subscribers hear of the signal, so the re-delivery is a duplicate, not a
  // second application of the same text.
  it("treats a signal a subscriber re-delivers during notification as already applied", () => {
    const projection = createCodingSafeActivityProjection({ now: () => 1_721_323_200_000 });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.ingest(RUN_ID, message("msg_user_1", "user"));
    const signal = { ...text("msg_user_1", "once-only"), signalId: "evt_text_1" } as const;
    const redelivered: boolean[] = [];
    projection.subscribeContent(() => {
      if (redelivered.length === 0) redelivered.push(projection.ingest(RUN_ID, signal));
    });

    expect(projection.ingest(RUN_ID, signal)).toBe(true);

    expect(redelivered).toEqual([true]);
    const serialized = JSON.stringify(projection.currentContent());
    expect(serialized).toContain("once-only");
    expect(serialized).not.toContain("once-onlyonce-only");
  });

  // #4546 (real-model lab F1): two answers of one turn ran into the output limit, so the turn went
  // over its byte bound. Shedding the oldest content must not shed the turn's messages themselves:
  // the turn's user message is the parent every later answer names, and a message whose text was
  // shed still streams. Both kept arriving and were dropped as unknown, an internal failure each.
  it("keeps a turn's messages when its byte bound sheds content, so later answers still arrive", () => {
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      limits: { maxTurnBytes: 600, maxTotalBytes: 100_000 },
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    const accepted = [
      message("msg_user", "user"),
      text("msg_user", "Add the dependency."),
      message("msg_loop", "assistant", "msg_user"),
      text("msg_loop", "x".repeat(700)),
      text("msg_loop", "y".repeat(700)),
      message("msg_final", "assistant", "msg_user"),
      text("msg_final", "FINAL answer"),
    ].map((signal) => projection.ingest(RUN_ID, signal));

    expect(accepted).toEqual(accepted.map(() => true));
    const content = projection.currentContent();
    expect(content?.feed).toMatchObject({ availability: "available", droppedEventCount: 0 });
    if (content?.feed.availability !== "available") return;
    expect(content.feed.turns).toHaveLength(1);
    expect(content.feed.turns[0]?.messages.map(({ messageId }) => messageId)).toEqual([
      "msg_user",
      "msg_loop",
      "msg_final",
    ]);
    // The shed answer lost nothing: the feed names it whole and its pages carry it, so the turn
    // reports no cut (#4491 whole model answers).
    expect(content.feed.turns[0]?.messages[1]).toMatchObject({
      fullAnswer: { length: 1400, truncated: false },
    });
    expect(content.feed.turns[0]).toMatchObject({ truncated: false });
    expect(JSON.stringify(content)).toContain("FINAL answer");
    expect(JSON.stringify(content)).not.toContain("x".repeat(700));
    expect(Buffer.byteLength(JSON.stringify(content.feed.turns[0]), "utf8")).toBeLessThan(600);
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

  // Owner decision 2026-10-30 (#3907 F3): Stop and takeover used to purge the feed, so a stopped
  // run lost every tool row while standalone OpenCode keeps an aborted session's steps. The feed now
  // stays; only the calls still open settle as cancelled, as OpenCode marks them aborted.
  it.each(["stop", "takeover"] as const)(
    "keeps the tool rows on %s and settles only the open calls as cancelled",
    (reason) => {
      const activityLog = createBufferedServerLogSink();
      const projection = createCodingSafeActivityProjection({
        now: () => Date.parse("2026-07-18T17:00:01.000Z"),
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
      const tool = (
        callId: string,
        state: "pending" | "running" | "succeeded",
      ): CodingSafeActivitySignal => ({
        kind: "tool",
        messageId: "msg_assistant",
        callId,
        tool: "read",
        state,
        occurredAt: "2026-07-18T17:00:00.002Z",
      });
      projection.ingest(RUN_ID, tool("call_done", "succeeded"));
      projection.ingest(RUN_ID, tool("call_open", "running"));
      projection.ingest(RUN_ID, tool("call_queued", "pending"));
      const listener = vi.fn();
      projection.subscribeContent(listener);

      projection.interrupt(RUN_ID, reason);
      projection.interrupt("another-run", reason);

      const content = projection.currentContent();
      expect(content?.feed.availability).toBe("available");
      if (content?.feed.availability !== "available") return;
      expect(content.feed.turns[0]?.tools.map(({ callId, state }) => [callId, state])).toEqual([
        ["call_done", "succeeded"],
        ["call_open", "cancelled"],
        ["call_queued", "cancelled"],
      ]);
      expect(listener).toHaveBeenCalledOnce();
      expect(activityLog.events).toEqual([
        {
          category: "process",
          op: "coding-runtime.safe-activity",
          correlationId: RUN_ID,
          extra: {
            completeness: "complete",
            event: "interrupted",
            loss: "none",
            occurrenceCount: 2,
            reason,
          },
        },
      ]);
      expect(
        validateRegisteredActivityLogEvent(
          activityLog.events[0] as unknown as Readonly<Record<PropertyKey, unknown>>,
        ),
      ).toMatchObject({ op: "coding-runtime.safe-activity" });
      // A late OpenCode restatement of the aborted call keeps Keiko's cancelled verdict.
      projection.ingest(RUN_ID, {
        kind: "tool",
        messageId: "msg_assistant",
        callId: "call_open",
        state: "failed",
        occurredAt: "2026-07-18T17:00:02.000Z",
      });
      const after = projection.currentContent()?.feed;
      expect(after?.availability === "available" ? after.turns[0]?.tools[1]?.state : "none").toBe(
        "cancelled",
      );
      // A delayed signal of a call the feed never saw cannot reopen the interrupted run; a call
      // that already settled is still recorded.
      expect(projection.ingest(RUN_ID, tool("call_late", "running"))).toBe(false);
      expect(projection.ingest(RUN_ID, tool("call_late_done", "succeeded"))).toBe(true);
      expect(firstTurnToolStates(projection)).toEqual([
        ["call_done", "succeeded"],
        ["call_open", "cancelled"],
        ["call_queued", "cancelled"],
        ["call_late_done", "succeeded"],
      ]);
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

  it("still marks a prompt truncated once the message byte budget is spent", () => {
    const projection = assistantTurn({ limits: { maxMessageBytes: 600 } });
    for (let index = 0; index < 1_000; index += 1) {
      projection.ingest(RUN_ID, text("msg_user", "x"));
    }

    const prompt = projected(projection, "msg_user");
    expect(prompt.truncated).toBe(true);
    expect(prompt.segments.at(-1)?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(prompt), "utf8")).toBeLessThanOrEqual(600);
  });

  it("keeps a streamed answer inside the message byte budget and complete in its pages", () => {
    const projection = assistantTurn({ limits: { maxMessageBytes: 600 } });
    for (let index = 0; index < 1_000; index += 1) {
      projection.ingest(RUN_ID, text("msg_answer", "x"));
    }

    const answer = projected(projection);
    expect(answer.truncated).toBe(false);
    expect(answer.fullAnswer).toEqual({ length: 1_000, truncated: false });
    expect(Buffer.byteLength(JSON.stringify(answer), "utf8")).toBeLessThanOrEqual(600);
    expect(readWholeAnswer(projection)).toBe("x".repeat(1_000));
  });
});

// #4068 W12: Windows-shaped text through the live feed. Shell and tool output never reaches it (a
// tool carries a label, a state and a shell's exit code only), so CRLF endings, bare-CR progress
// rewrites and long lines arrive here only as text the model wrote or reasoned. The feed keeps that
// text as written within its bounds and discloses every cut; it never rewrites a line ending.
describe("Windows-shaped text in the live feed", () => {
  const progress = "added 1 package\r\n[##   ] 40%\r[#### ] 80%\r[#####] 100%\r\n";

  it("keeps CRLF and bare-CR rewrites byte for byte across streamed pieces", () => {
    const projection = assistantTurn();
    // One streamed piece per character, so every CR and LF arrives on its own.
    for (let index = 0; index < progress.length; index += 1) {
      projection.ingest(RUN_ID, text("msg_answer", progress.charAt(index)));
    }

    const answer = projected(projection);
    expect(joinedText(answer)).toBe(progress);
    expect(answer.segments).toHaveLength(1);
    expect(answer.truncated).toBe(false);
  });

  it("keeps a CRLF pair whole when the segment bound falls between CR and LF", () => {
    const projection = assistantTurn();
    const head = `${"a".repeat(CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS - 1)}\r`;
    projection.ingest(RUN_ID, text("msg_answer", head));
    projection.ingest(RUN_ID, text("msg_answer", "\nnext line\r\n"));

    const answer = projected(projection);
    expect(answer.segments.map((segment) => segment.text)).toEqual([head, "\nnext line\r\n"]);
    // Consumers join segments; the joined text has the original line ending.
    expect(joinedText(answer)).toBe(`${head}\nnext line\r\n`);
    expect(answer.truncated).toBe(false);
  });

  it("removes backspace and escape controls but keeps tab, LF and CR", () => {
    const projection = assistantTurn();
    projection.ingest(RUN_ID, text("msg_answer", "\u001b[32mok\u001b[0m\t|\b/\b-\r\n"));

    expect(joinedText(projected(projection))).toBe("[32mok[0m\t|/-\r\n");
  });

  it("bounds a single line far above the message budget and keeps it whole in its pages", () => {
    const projection = assistantTurn();
    const line = "x".repeat(200_000);
    for (let index = 0; index < 20; index += 1) {
      projection.ingest(
        RUN_ID,
        text("msg_answer", line.slice(index * 10_000, (index + 1) * 10_000)),
      );
    }

    const answer = projected(projection);
    expect(answer.truncated).toBe(false);
    expect(answer.fullAnswer).toEqual({ length: line.length, truncated: false });
    expect(line.startsWith(joinedText(answer))).toBe(true);
    expect(joinedText(answer).length).toBeGreaterThan(CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS);
    expect(Buffer.byteLength(JSON.stringify(answer), "utf8")).toBeLessThanOrEqual(
      CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES,
    );
    expect(readWholeAnswer(projection)).toBe(line);
  });

  it("bounds replacement characters and a lone surrogate on their UTF-8 cost", () => {
    const projection = assistantTurn({ limits: { maxMessageBytes: 600 } });
    // What a UTF-8 decoder makes of invalid bytes (U+FFFD), plus a lone surrogate that a JSON
    // escape can still deliver; each costs three bytes once serialized.
    const mixed = `café \uFFFD\uFFFD \ud800 ${"ü".repeat(400)}`;
    projection.ingest(RUN_ID, text("msg_answer", mixed));

    const answer = projected(projection);
    expect(answer.truncated).toBe(false);
    expect(answer.fullAnswer).toEqual({ length: mixed.length, truncated: false });
    expect(mixed.startsWith(joinedText(answer))).toBe(true);
    expect(joinedText(answer)).toContain("\uFFFD\uFFFD \ud800");
    expect(Buffer.byteLength(JSON.stringify(answer), "utf8")).toBeLessThanOrEqual(600);
    expect(readWholeAnswer(projection)).toBe(mixed);
  });

  it("settles a shell call cut by Stop as cancelled and keeps the streamed text it had", () => {
    const projection = assistantTurn();
    projection.ingest(RUN_ID, text("msg_answer", "Running npm test\r\n"));
    const shell = (state: "running" | "succeeded"): CodingSafeActivitySignal => ({
      kind: "tool",
      messageId: "msg_answer",
      callId: "call_shell",
      tool: "shell",
      state,
      occurredAt: "2026-07-18T17:00:00.003Z",
    });
    projection.ingest(RUN_ID, shell("running"));

    projection.interrupt(RUN_ID, "stop");
    projection.ingest(RUN_ID, text("msg_answer", "[##  ] 50%\r"));

    const answer = projected(projection);
    expect(joinedText(answer)).toBe("Running npm test\r\n[##  ] 50%\r");
    expect(answer.truncated).toBe(false);
    expect(firstTurnToolStates(projection)).toEqual([["call_shell", "cancelled"]]);
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

  // The feed carries reasoning only up to its own bound, as a true prefix; the reasoning itself is
  // never cut: the feed names its whole length and its pages carry every character, the part the
  // model wrote after the bound included.
  it("bounds reasoning in the feed as a true prefix and keeps it whole in its pages", () => {
    const projection = assistantTurn();
    const long = "r".repeat(CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES + 100);
    projection.ingest(RUN_ID, reasoning("msg_answer", long));
    projection.ingest(RUN_ID, reasoning("msg_answer", "LATER"));
    projection.ingest(RUN_ID, text("msg_answer", "y".repeat(7_000)));

    const answer = projected(projection);
    expect(answer.reasoning).toEqual({
      text: "r".repeat(CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES),
      truncated: false,
    });
    expect(answer.fullReasoning).toEqual({ length: long.length + 5, truncated: false });
    expect(readWholeAnswer(projection, "msg_answer", "reasoning")).toBe(`${long}LATER`);
    // The reasoning bound leaves the answer room of its own.
    expect(answer.truncated).toBe(false);
    expect(joinedText(answer)).toBe("y".repeat(7_000));
  });

  // #3878's priority of the answer over the reasoning holds without cutting either: the answer the
  // message has no room for is retained whole and named, and the reasoning keeps its room.
  it("keeps the answer whole and the reasoning uncut when the answer outgrows the message", () => {
    const projection = assistantTurn({ limits: { maxMessageBytes: 1_200 } });
    projection.ingest(RUN_ID, reasoning("msg_answer", "q".repeat(500)));
    projection.ingest(RUN_ID, text("msg_answer", "z".repeat(700)));

    const answer = projected(projection);
    expect(answer.truncated).toBe(false);
    expect(answer.reasoning).toEqual({ text: "q".repeat(500), truncated: false });
    expect(answer.fullAnswer).toEqual({ length: 700, truncated: false });
    expect("z".repeat(700).startsWith(joinedText(answer))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(answer), "utf8")).toBeLessThanOrEqual(1_200);
    expect(readWholeAnswer(projection)).toBe("z".repeat(700));
  });

  it("sheds older answers' and older reasoning's feed text losslessly under turn pressure", () => {
    const projection = assistantTurn({ limits: { maxTurnBytes: 2_000 } });
    projection.ingest(RUN_ID, reasoning("msg_answer", "o".repeat(900)));
    projection.ingest(RUN_ID, text("msg_answer", "first answer"));
    projection.ingest(RUN_ID, message("msg_next", "assistant", "msg_user"));
    projection.ingest(RUN_ID, reasoning("msg_next", "n".repeat(900)));
    projection.ingest(RUN_ID, text("msg_next", "second answer"));

    const older = projected(projection);
    const newest = projected(projection, "msg_next");
    expect(older).not.toHaveProperty("reasoning");
    expect(older.segments).toEqual([]);
    expect(older.fullAnswer).toEqual({ length: "first answer".length, truncated: false });
    expect(older.fullReasoning).toEqual({ length: 900, truncated: false });
    expect(readWholeAnswer(projection)).toBe("first answer");
    expect(readWholeAnswer(projection, "msg_answer", "reasoning")).toBe("o".repeat(900));
    expect(newest.reasoning?.text).toBe("n".repeat(900));
    // Nothing was lost, so the turn is not marked as cut.
    const feed = projection.currentContent()?.feed;
    expect(feed?.availability === "available" && feed.turns[0]?.truncated).toBe(false);
  });

  it("drops reasoning that a format-character redactor empties", () => {
    const projection = assistantTurn();
    expect(projection.ingest(RUN_ID, reasoning("msg_answer", "\u202E\u2066"))).toBe(false);
    expect(projected(projection)).not.toHaveProperty("reasoning");
  });
});

describe("committed native retry signal metadata", () => {
  it("admits only canonical assistant facts while retaining no retry or provider error body", () => {
    let current = true;
    const projection = createCodingSafeActivityProjection({
      now: () => Date.parse("2026-07-18T17:00:00.000Z"),
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => current,
    });
    projection.ingest(RUN_ID, message("msg_user", "user"));
    const retry = {
      ...message("msg_assistant", "assistant", "msg_user"),
      nativeRetry: { attempt: 2, scheduledAt: "2026-07-18T17:00:02.000Z" },
    };
    expect(projection.ingest(RUN_ID, retry)).toBe(true);
    const shown = JSON.stringify(projection.currentContent());
    expect(shown).not.toContain("nativeRetry");
    for (const invalid of [
      { ...retry, nativeRetry: { ...retry.nativeRetry, error: "PRIVATE" } },
      { ...retry, nativeRetry: { ...retry.nativeRetry, scheduledAt: "2026-02-30T17:00:02.000Z" } },
      { ...retry, role: "user" as const },
    ])
      expect(projection.ingest(RUN_ID, invalid)).toBe(false);
    expect(JSON.stringify(projection.currentContent())).not.toContain("PRIVATE");
    current = false;
    expect(projection.ingest(RUN_ID, retry)).toBe(false);
    expect(projection.currentContent()).toBeNull();
  });
});

// Stability audit item 4: past the per-turn tool bound the newest call used to be dropped silently,
// so the Changes refresh signal and the run phase (both derived from the feed) stopped following
// the run. The newest call now replaces the oldest settled one and every displacement counts
// toward `droppedEventCount`, the feed's monotonic, bounded loss counter the UI can follow.
describe("saturated per-turn tool capacity", () => {
  function openSaturated(maxToolsPerTurn: number): {
    readonly projection: ReturnType<typeof createCodingSafeActivityProjection>;
    readonly call: (callId: string, state: "pending" | "running" | "succeeded") => boolean;
  } {
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      limits: { maxToolsPerTurn },
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.ingest(RUN_ID, message("msg_user", "user"));
    projection.ingest(RUN_ID, message("msg_assistant", "assistant", "msg_user"));
    let tick = 0;
    return {
      projection,
      call: (callId, state): boolean => {
        tick += 1;
        return projection.ingest(RUN_ID, {
          kind: "tool",
          messageId: "msg_assistant",
          callId,
          tool: "edit",
          state,
          occurredAt: `2026-07-18T17:00:01.${String(tick).padStart(3, "0")}Z`,
        });
      },
    };
  }

  function toolIds(projection: ReturnType<typeof createCodingSafeActivityProjection>): string[] {
    const turn = projection.currentContent()?.feed;
    return turn?.availability === "available"
      ? (turn.turns[0]?.tools.map(({ callId }) => callId) ?? [])
      : [];
  }

  it("keeps the newest call by displacing the oldest settled one and counts each displacement", () => {
    const { projection, call } = openSaturated(3);
    for (const id of ["c1", "c2", "c3", "c4", "c5"]) call(id, "succeeded");

    expect(toolIds(projection)).toEqual(["c3", "c4", "c5"]);
    expect(projection.currentContent()?.feed).toMatchObject({
      droppedEventCount: 2,
      turns: [{ truncated: true }],
    });
  });

  it("shows a newly started call at the bound so the run phase can name the running tool", () => {
    const { projection, call } = openSaturated(2);
    call("c1", "succeeded");
    call("c2", "succeeded");
    call("c3", "running");

    expect(toolIds(projection)).toEqual(["c2", "c3"]);
    expect(projection.currentContent()?.feed).toMatchObject({
      turns: [{ tools: [{}, { callId: "c3", state: "running" }] }],
    });
  });

  it("never displaces an unsettled call; the newest one is dropped and still counted", () => {
    const { projection, call } = openSaturated(2);
    call("c1", "pending");
    call("c2", "running");
    expect(call("c3", "pending")).toBe(true);

    expect(toolIds(projection)).toEqual(["c1", "c2"]);
    expect(projection.currentContent()?.feed).toMatchObject({ droppedEventCount: 1 });
  });
});

describe("OpenCode permission rejection evidence (#4271)", () => {
  function denial(
    callId: string,
    state: "running" | "denied" | "failed",
    withMessage = true,
    tool = "shell",
  ): CodingSafeActivitySignal {
    return {
      kind: "tool",
      ...(withMessage ? { messageId: "msg_assistant" } : {}),
      callId,
      tool,
      state,
      occurredAt: "2026-07-18T17:00:00.002Z",
    };
  }

  function projectionWithLog(): {
    readonly projection: Projection;
    readonly log: ReturnType<typeof createBufferedServerLogSink>;
  } {
    const log = createBufferedServerLogSink();
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      diagnostics: { record: (): void => undefined },
      activityLog: log,
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.ingest(RUN_ID, message("msg_user", "user"));
    projection.ingest(RUN_ID, message("msg_assistant", "assistant", "msg_user"));
    return { projection, log };
  }

  const deniedLines = (
    log: ReturnType<typeof createBufferedServerLogSink>,
  ): ReturnType<typeof createBufferedServerLogSink>["events"] =>
    log.events.filter((event) => event.op === "coding-runtime.native-tool.denied");

  it("records one body-free line per denied call, not per repeated part update", () => {
    const { projection, log } = projectionWithLog();
    projection.ingest(RUN_ID, denial("call_a", "running"));
    projection.ingest(RUN_ID, denial("call_a", "denied"));
    projection.ingest(RUN_ID, denial("call_a", "denied"));
    projection.ingest(RUN_ID, denial("call_b", "denied", true, "mcp_private_tool"));
    const lines = deniedLines(log);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      correlationId: RUN_ID,
      extra: { tool: "shell", occurrenceCount: 1 },
    });
    expect(lines[1]).toMatchObject({ extra: { tool: "other", occurrenceCount: 2 } });
    const first = lines[0];
    if (first === undefined) throw new Error("expected a native-tool.denied line");
    const line = formatActivityLogProofLine(first);
    expect(
      expectActivityLogProof("coding-runtime.native-tool.denied.emitted-line", line),
    ).toMatchObject({ correlationId: RUN_ID, tool: "shell", occurrenceCount: 1 });
    expect(line).not.toContain("call_a");
    expect(line).not.toContain("mcp_private_tool");
  });

  it("records exactly one line when OpenCode reports a rejection Keiko's policy or a person already settled", () => {
    const { projection, log } = projectionWithLog();
    projection.ingest(RUN_ID, denial("call_k", "running"));
    projection.ingest(RUN_ID, denial("call_k", "denied", false));
    projection.ingest(RUN_ID, denial("call_k", "denied"));
    projection.ingest(RUN_ID, denial("call_k", "denied"));
    expect(deniedLines(log)).toHaveLength(1);
    expect(deniedLines(log)[0]).toMatchObject({ extra: { tool: "shell", occurrenceCount: 1 } });
    expect(firstTurnToolStates(projection)).toContainEqual(["call_k", "denied"]);
  });

  it("names exactly the native tools outside Code Mode and Code Mode's own execute entry", () => {
    expect(NATIVE_TOOL_DENIED_TOOLS).toEqual([...OPENCODE_NATIVE_TOOL_NAMES, "execute"]);
  });

  it("records a rejection OpenCode reports after Keiko stopped the call, keeping it cancelled", () => {
    const { projection, log } = projectionWithLog();
    projection.ingest(RUN_ID, denial("call_s", "running"));
    projection.ingest(RUN_ID, {
      kind: "tool",
      callId: "call_s",
      state: "cancelled",
      occurredAt: "2026-07-18T17:00:00.003Z",
    });
    expect(projection.ingest(RUN_ID, denial("call_s", "denied"))).toBe(true);
    expect(firstTurnToolStates(projection)).toContainEqual(["call_s", "cancelled"]);
    expect(deniedLines(log)).toHaveLength(1);
    expect(log.events.filter((event) => event.op === "coding-runtime.safe-activity")).toEqual([
      expect.objectContaining({
        extra: expect.objectContaining({
          event: "superseded",
          reason: "late-restatement",
          settledState: "cancelled",
          restatedState: "denied",
        }) as unknown,
      }),
    ]);
  });

  it("refuses a rejection OpenCode reports after the call succeeded, recording no denial", () => {
    const { projection, log } = projectionWithLog();
    projection.ingest(RUN_ID, denial("call_ok", "running"));
    projection.ingest(RUN_ID, {
      kind: "tool",
      callId: "call_ok",
      state: "succeeded",
      occurredAt: "2026-07-18T17:00:00.003Z",
    });
    expect(projection.ingest(RUN_ID, denial("call_ok", "denied"))).toBe(false);
    expect(firstTurnToolStates(projection)).toContainEqual(["call_ok", "succeeded"]);
    expect(deniedLines(log)).toEqual([]);
  });

  it("records nothing for a failure or a Keiko-only settlement", () => {
    const { projection, log } = projectionWithLog();
    projection.ingest(RUN_ID, denial("call_k", "running"));
    projection.ingest(RUN_ID, denial("call_k", "denied", false));
    projection.ingest(RUN_ID, denial("call_f", "running"));
    projection.ingest(RUN_ID, denial("call_f", "failed"));
    expect(deniedLines(log)).toEqual([]);
  });
});

// A model's answer is never cut to fit the bounded feed (owner decision "Work-ending limits"): the
// projection keeps its complete text, the feed names it, and pages carry it whole.
function readWholeAnswer(
  projection: Projection,
  messageId = "msg_answer",
  part: CodingSafeActivityTextPart = "answer",
): string {
  let whole = "";
  for (;;) {
    const page = projection.answerPage(RUN_ID, { messageId, part, offset: whole.length });
    if (page === null) throw new TypeError(`no page for ${messageId} at ${String(whole.length)}`);
    expect(validateCodingSafeActivityAnswerPage(page).ok).toBe(true);
    expect(page).toMatchObject({ offset: whole.length, part });
    whole += page.text;
    if (whole.length >= page.length) return whole;
    expect(page.text.length).toBeGreaterThan(0);
  }
}

function longMarkdownAnswer(chars: number): string {
  const paragraphs: string[] = [];
  let length = 0;
  for (let index = 0; length < chars; index += 1) {
    const paragraph = `## Finding ${String(index)}\n\nThe review found **issue ${String(index)}** in \`src/file-${String(index)}.ts\` — äöü 😀.\n\n`;
    paragraphs.push(paragraph);
    length += paragraph.length;
  }
  return paragraphs.join("").slice(0, chars);
}

describe("complete answers beyond the feed budget", () => {
  it("keeps a 120 KiB streamed answer complete, bounded in the feed and whole in its pages", () => {
    const projection = assistantTurn();
    const answer = longMarkdownAnswer(120 * 1_024);
    for (let offset = 0; offset < answer.length; offset += 997) {
      expect(
        projection.ingest(RUN_ID, text("msg_answer", answer.slice(offset, offset + 997))),
      ).toBe(true);
    }

    const shown = projected(projection);
    expect(shown.truncated).toBe(false);
    expect(shown.segments.every((segment) => !segment.truncated)).toBe(true);
    expect(shown.fullAnswer).toEqual({ length: answer.length, truncated: false });
    expect(answer.startsWith(joinedText(shown))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(shown), "utf8")).toBeLessThanOrEqual(
      CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES,
    );
    expect(readWholeAnswer(projection)).toBe(answer);
  });

  it("names no full answer while the segments carry the whole answer", () => {
    const projection = assistantTurn();
    projection.ingest(RUN_ID, text("msg_answer", "A short answer."));
    expect(projected(projection).fullAnswer).toBeUndefined();
    expect(readWholeAnswer(projection)).toBe("A short answer.");
  });

  it("sheds an earlier answer's segments without loss when the turn budget needs room", () => {
    const projection = assistantTurn();
    const first = longMarkdownAnswer(14_000);
    const second = longMarkdownAnswer(15_000).replaceAll("Finding", "Second");
    projection.ingest(RUN_ID, text("msg_answer", first));
    projection.ingest(RUN_ID, message("msg_answer_2", "assistant", "msg_user"));
    projection.ingest(RUN_ID, text("msg_answer_2", second));
    projection.ingest(RUN_ID, message("msg_answer_3", "assistant", "msg_user"));
    projection.ingest(RUN_ID, text("msg_answer_3", second));

    const feed = projection.currentContent()?.feed;
    if (feed?.availability !== "available") throw new TypeError("expected an available feed");
    expect(validateCodingSafeActivityFeed(feed).ok).toBe(true);
    expect(feed.turns[0]?.truncated).toBe(false);
    expect(projected(projection).fullAnswer).toEqual({ length: first.length, truncated: false });
    expect(readWholeAnswer(projection)).toBe(first);
    expect(readWholeAnswer(projection, "msg_answer_2")).toBe(second);
    expect(readWholeAnswer(projection, "msg_answer_3")).toBe(second);
  });

  it("cuts only at the memory bound, shows the cut and records it body-free", () => {
    const log = createBufferedServerLogSink();
    const projection = assistantTurn({
      activityLog: log,
      limits: { maxRetainedAnswerChars: 1_000 },
    });
    for (let index = 0; index < 30; index += 1) {
      projection.ingest(RUN_ID, text("msg_answer", "y".repeat(100)));
    }

    const shown = projected(projection);
    expect(shown.truncated).toBe(true);
    expect(shown.fullAnswer).toEqual({ length: 1_000, truncated: true });
    expect(readWholeAnswer(projection)).toBe("y".repeat(1_000));
    const clipped = log.events.filter(
      (event) =>
        event.op === "coding-runtime.safe-activity" && event.extra?.event === "answer-clipped",
    );
    expect(clipped).toHaveLength(1);
    expect(clipped[0]).toMatchObject({
      correlationId: RUN_ID,
      extra: { event: "answer-clipped", reason: "retention-bound", occurrenceCount: 1 },
    });
    expect(JSON.stringify(log.events)).not.toContain("y".repeat(50));
  });

  it("serves no page for an unknown run, an unknown or user message, or past the end", () => {
    const projection = assistantTurn();
    projection.ingest(RUN_ID, text("msg_user", "Review the module."));
    projection.ingest(RUN_ID, text("msg_answer", "Answer."));
    expect(
      projection.answerPage("run-other", { messageId: "msg_answer", part: "answer", offset: 0 }),
    ).toBeNull();
    expect(
      projection.answerPage(RUN_ID, { messageId: "msg_missing", part: "answer", offset: 0 }),
    ).toBeNull();
    expect(
      projection.answerPage(RUN_ID, { messageId: "msg_user", part: "answer", offset: 0 }),
    ).toBeNull();
    expect(
      projection.answerPage(RUN_ID, { messageId: "msg_answer", part: "answer", offset: 8 }),
    ).toBeNull();
    expect(
      projection.answerPage(RUN_ID, { messageId: "msg_answer", part: "answer", offset: -1 }),
    ).toBeNull();
    expect(
      projection.answerPage(RUN_ID, { messageId: "msg_answer", part: "answer", offset: 7 }),
    ).toMatchObject({ text: "", length: 7 });
  });

  it("releases a retained answer with its turn and with a purge", () => {
    const projection = assistantTurn({ limits: { maxTurns: 1 } });
    projection.ingest(RUN_ID, text("msg_answer", "First answer."));
    projection.ingest(RUN_ID, message("msg_user_2", "user"));
    expect(
      projection.answerPage(RUN_ID, { messageId: "msg_answer", part: "answer", offset: 0 }),
    ).toBeNull();
    projection.ingest(RUN_ID, message("msg_answer_2", "assistant", "msg_user_2"));
    projection.ingest(RUN_ID, text("msg_answer_2", "Second answer."));
    expect(
      projection.answerPage(RUN_ID, { messageId: "msg_answer_2", part: "answer", offset: 0 })?.text,
    ).toBe("Second answer.");
    projection.purge(RUN_ID, "stop");
    expect(
      projection.answerPage(RUN_ID, { messageId: "msg_answer_2", part: "answer", offset: 0 }),
    ).toBeNull();
  });

  it("keeps the answer's complete text in the page while a Keiko note stays bounded text", () => {
    const projection = assistantTurn();
    projection.ingest(RUN_ID, message("msg_note", "user", undefined, "keiko"));
    projection.ingest(RUN_ID, text("msg_note", "Continue."));
    expect(
      projection.answerPage(RUN_ID, { messageId: "msg_note", part: "answer", offset: 0 }),
    ).toBeNull();
  });
});

// A live update carries what each model text gained as an append-only delta beside the bounded
// feed, so a reader keeps up without a page read per update; a gain past the feed's own bound still
// reaches it whole.
describe("live model-text deltas", () => {
  it("streams a long answer and its reasoning as contiguous deltas inside the snapshot budget", () => {
    const projection = assistantTurn();
    const updates: NonNullable<ReturnType<Projection["currentContent"]>>[] = [];
    projection.subscribeContent((content) => {
      if (content !== null) updates.push(content);
    });
    const thought = "t".repeat(CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES + 3_000);
    projection.ingest(RUN_ID, reasoning("msg_answer", thought));
    const answer = longMarkdownAnswer(110 * 1024);
    for (let at = 0; at < answer.length; at += 3_000) {
      projection.ingest(RUN_ID, text("msg_answer", answer.slice(at, at + 3_000)));
    }

    const rebuilt: Record<CodingSafeActivityTextPart, string> = { answer: "", reasoning: "" };
    for (const update of updates) {
      expect(Buffer.byteLength(JSON.stringify(update), "utf8")).toBeLessThanOrEqual(
        CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES,
      );
      const errors: string[] = [];
      validateCodingSafeActivityTextDeltas(update.textDeltas ?? [], "textDeltas", errors);
      expect(errors).toEqual([]);
      for (const delta of update.textDeltas ?? []) {
        expect(delta.offset).toBe(rebuilt[delta.part].length);
        rebuilt[delta.part] += delta.text;
      }
    }
    expect(rebuilt).toEqual({ answer, reasoning: thought });
    expect(JSON.stringify(projection.currentContent())).not.toContain("textDeltas");
  });

  it("records reasoning the feed names and reasoning the memory bound cuts, body-free", () => {
    const log = createBufferedServerLogSink();
    const projection = assistantTurn({
      activityLog: log,
      limits: { maxRetainedAnswerChars: 9_000 },
    });
    projection.ingest(
      RUN_ID,
      reasoning("msg_answer", "s".repeat(CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES + 10)),
    );
    projection.ingest(RUN_ID, reasoning("msg_answer", "s".repeat(2_000)));

    const events = log.events
      .filter((event) => event.op === "coding-runtime.safe-activity")
      .map((event) => [event.extra?.event, event.extra?.reason, event.level]);
    expect(events).toEqual([
      ["reasoning-retained", "feed-bound", undefined],
      ["reasoning-clipped", "retention-bound", "warn"],
    ]);
    // Reasoning may fill at most half the run's bound; the other half stays for answers.
    expect(projected(projection).fullReasoning).toEqual({ length: 4_500, truncated: true });
    // The cut is shown on the reasoning; the answer itself is whole.
    expect(projected(projection).reasoning?.truncated).toBe(true);
    expect(projected(projection).truncated).toBe(false);
    for (const event of log.events) {
      expect(validateRegisteredActivityLogEvent(event as never)).toMatchObject({
        op: "coding-runtime.safe-activity",
      });
    }
    expect(JSON.stringify(log.events)).not.toContain("s".repeat(50));
  });
});

describe("a text the memory bound left no room for", () => {
  const cut = (
    part: CodingSafeActivityTextPart,
    messageId = "msg_answer",
  ): CodingSafeActivitySignal => ({
    kind: "text-cut",
    messageId,
    part,
    occurredAt: "2026-07-18T17:00:00.003Z",
  });

  it("marks an answer its source showed only a prefix of, once, and logs it body-free", () => {
    const log = createBufferedServerLogSink();
    const projection = assistantTurn({ activityLog: log });
    projection.ingest(RUN_ID, text("msg_answer", "PRIVATE_PREFIX"));
    expect(projection.ingest(RUN_ID, cut("answer"))).toBe(true);
    expect(projection.ingest(RUN_ID, cut("answer"))).toBe(true);
    const message = projected(projection);
    expect(message.truncated).toBe(true);
    expect(message.fullAnswer).toEqual({ length: 14, truncated: true });
    const clipped = log.events
      .filter((event) => event.extra?.event === "answer-clipped")
      .map((event) => [event.extra?.reason, event.extra?.occurrenceCount, event.level]);
    expect(clipped).toEqual([["source-bound", 1, "warn"]]);
    for (const event of log.events) {
      expect(validateRegisteredActivityLogEvent(event as never)).toBeDefined();
    }
    expect(JSON.stringify(log.events)).not.toContain("PRIVATE_PREFIX");
  });

  it("marks reasoning its source cut, and refuses a cut for a message it does not know", () => {
    const projection = assistantTurn();
    projection.ingest(RUN_ID, reasoning("msg_answer", "thinking"));
    projection.ingest(RUN_ID, cut("reasoning"));
    expect(projected(projection).reasoning).toEqual({ text: "thinking", truncated: true });
    expect(projected(projection).fullReasoning).toEqual({ length: 8, truncated: true });
    expect(projection.ingest(RUN_ID, cut("answer", "msg_unknown"))).toBe(false);
    expect(projection.ingest(RUN_ID, cut("answer", "msg_user"))).toBe(false);
  });

  it("names a reasoning the bound cut to nothing, so the cut stays visible", () => {
    const projection = assistantTurn({ limits: { maxRetainedAnswerChars: 1_000 } });
    projection.ingest(RUN_ID, reasoning("msg_answer", "s".repeat(600)));
    projection.ingest(RUN_ID, text("msg_answer", "first answer"));
    projection.ingest(RUN_ID, message("msg_user_2", "user"));
    projection.ingest(RUN_ID, message("msg_answer_2", "assistant", "msg_user_2"));
    projection.ingest(RUN_ID, reasoning("msg_answer_2", "t".repeat(40)));
    const cut = projected(projection, "msg_answer_2");
    expect(cut.reasoning).toBeUndefined();
    expect(cut.fullReasoning).toEqual({ length: 0, truncated: true });
    // A message whose reasoning was never cut names nothing.
    projection.ingest(RUN_ID, text("msg_answer_2", "second answer"));
    expect(projected(projection, "msg_answer_2").fullAnswer).toBeUndefined();
  });
});

// A failed row says what failed and who caused it; the Activity Log keeps the closed facts alone.
describe("failed tool rows", () => {
  const PRIVATE_COMMAND = "npm test -- --grep private-case";

  function shellCall(
    callId: string,
    state: "running" | "failed" | "succeeded" | "denied" | "cancelled",
    presentation?: CodingSafeActivityToolPresentation,
    messageId = "msg_answer",
  ): CodingSafeActivitySignal {
    return {
      kind: "tool",
      messageId,
      callId,
      tool: "shell",
      state,
      occurredAt: "2026-07-18T17:00:00.002Z",
      ...(presentation === undefined ? {} : { presentation }),
    };
  }

  const failedShell = (callId: string): CodingSafeActivitySignal =>
    shellCall(callId, "failed", {
      exitCode: 1,
      failureOrigin: "command-failed",
      durationMs: 2_400,
      command: { text: PRIVATE_COMMAND, truncated: false },
      output: {
        head: "FAIL private-case",
        tail: "",
        lineCount: 1,
        hiddenLineCount: 0,
        truncated: false,
      },
    });

  function toolOf(projection: Projection, callId: string): CodingSafeActivityTool {
    const feed = projection.currentContent()?.feed;
    if (feed?.availability !== "available") throw new TypeError("expected an available feed");
    expect(validateCodingSafeActivityFeed(feed).ok).toBe(true);
    const found = feed.turns.flatMap((turn) => turn.tools).find((tool) => tool.callId === callId);
    if (found === undefined) throw new TypeError(`missing ${callId}`);
    return found;
  }

  const failedLines = (
    log: ReturnType<typeof createBufferedServerLogSink>,
  ): ReturnType<typeof createBufferedServerLogSink>["events"] =>
    log.events.filter((event) => event.op === "coding-runtime.tool.failed");

  it("keeps a running call's command when its failure settles it, and counts a repeat", () => {
    const projection = assistantTurn();
    projection.ingest(
      RUN_ID,
      shellCall("call_a", "running", { command: { text: PRIVATE_COMMAND, truncated: false } }),
    );
    projection.ingest(RUN_ID, shellCall("call_a", "failed", { exitCode: 1 }));
    expect(toolOf(projection, "call_a").presentation).toMatchObject({
      exitCode: 1,
      failureOrigin: "command-failed",
      failureCount: 1,
      command: { text: PRIVATE_COMMAND },
    });

    projection.ingest(RUN_ID, failedShell("call_b"));
    projection.ingest(RUN_ID, failedShell("call_b"));
    expect(toolOf(projection, "call_b").presentation?.failureCount).toBe(2);
  });

  it("names no origin on a call that succeeded after all", () => {
    const projection = assistantTurn();
    projection.ingest(RUN_ID, shellCall("call_a", "running", { failureOrigin: "tool-error" }));
    projection.ingest(RUN_ID, shellCall("call_a", "succeeded", { exitCode: 0 }));
    expect(toolOf(projection, "call_a").presentation).toEqual({ exitCode: 0 });
  });

  it("names a stopped call's origin when Stop settles it, and counts no failure for it", () => {
    const log = createBufferedServerLogSink();
    const projection = assistantTurn({ activityLog: log });
    projection.ingest(RUN_ID, shellCall("call_a", "running"));
    projection.interrupt(RUN_ID, "stop");
    expect(toolOf(projection, "call_a")).toMatchObject({
      state: "cancelled",
      presentation: { failureOrigin: "cancelled" },
    });
    expect(toolOf(projection, "call_a").presentation).not.toHaveProperty("failureCount");
    projection.ingest(RUN_ID, shellCall("call_b", "cancelled", { failureOrigin: "cancelled" }));
    expect(toolOf(projection, "call_b").presentation).not.toHaveProperty("failureCount");
    // A stop is recorded once per run as the interruption, never as a failed call.
    expect(failedLines(log)).toEqual([]);
  });

  it("writes the line of a failed call the full turn had no room for", () => {
    const log = createBufferedServerLogSink();
    const projection = assistantTurn({ activityLog: log, limits: { maxToolsPerTurn: 1 } });
    projection.ingest(RUN_ID, shellCall("call_open", "running"));
    projection.ingest(RUN_ID, failedShell("call_dropped"));
    const feed = projection.currentContent()?.feed;
    const listed =
      feed?.availability === "available" ? feed.turns.flatMap((turn) => turn.tools) : [];
    expect(listed.map((tool) => tool.callId)).toEqual(["call_open"]);
    expect(failedLines(log).map((line) => line.extra)).toEqual([
      expect.objectContaining({ failureOrigin: "command-failed", failedCallCount: 1 }),
    ]);
  });

  it("writes one body-free line per failed call with the run's failure counts", () => {
    const log = createBufferedServerLogSink();
    const projection = assistantTurn({ activityLog: log });
    projection.ingest(RUN_ID, failedShell("call_a"));
    projection.ingest(RUN_ID, failedShell("call_a"));
    projection.ingest(RUN_ID, failedShell("call_b"));
    projection.ingest(RUN_ID, shellCall("call_c", "succeeded", { exitCode: 0 }));
    const lines = failedLines(log);
    expect(lines.map((line) => line.extra)).toEqual([
      {
        tool: "shell",
        failureOrigin: "command-failed",
        exitCodeClass: "1",
        commandFailureCount: 1,
        failedCallCount: 1,
        repeatedFailureCount: 0,
        completeness: "complete",
        loss: "none",
      },
      {
        tool: "shell",
        failureOrigin: "command-failed",
        exitCodeClass: "1",
        commandFailureCount: 2,
        failedCallCount: 2,
        repeatedFailureCount: 1,
        completeness: "complete",
        loss: "none",
      },
    ]);
    const second = lines[1];
    if (second === undefined) throw new Error("expected a tool.failed line");
    const line = formatActivityLogProofLine(second);
    expect(expectActivityLogProof("coding-runtime.tool.failed.emitted-line", line)).toMatchObject({
      correlationId: RUN_ID,
      failureOrigin: "command-failed",
    });
    // Neither the command, its output, an error text nor the call's id reach the log.
    projection.ingest(
      RUN_ID,
      shellCall("call_err", "failed", {
        failureOrigin: "tool-error",
        errorText: { text: "private-error-text", truncated: false },
      }),
    );
    expect(failedLines(log)).toHaveLength(3);
    const logged = JSON.stringify(log.events);
    for (const body of [
      "private-case",
      "FAIL private",
      "private-error-text",
      "call_a",
      "call_err",
    ]) {
      expect(logged).not.toContain(body);
    }
  });

  it("lets a later update bring back a row's shed detail once the feed has room", () => {
    const projection = assistantTurn({
      limits: { maxTurns: 2, maxTurnBytes: 3_000, maxTotalBytes: 3_400 },
    });
    const bulky = (
      messageId: string,
      callId: string,
      state: "succeeded" | "failed",
    ): CodingSafeActivitySignal =>
      shellCall(
        callId,
        state,
        {
          exitCode: state === "failed" ? 1 : 0,
          command: { text: `${callId} ${"c".repeat(700)}`, truncated: false },
          output: {
            head: "o".repeat(700),
            tail: "",
            lineCount: 1,
            hiddenLineCount: 0,
            truncated: false,
          },
        },
        messageId,
      );
    projection.ingest(RUN_ID, bulky("msg_answer", "call_bad", "failed"));
    projection.ingest(RUN_ID, message("msg_user_2", "user"));
    projection.ingest(RUN_ID, message("msg_answer_2", "assistant", "msg_user_2"));
    projection.ingest(RUN_ID, bulky("msg_answer_2", "call_ok", "succeeded"));
    expect(toolOf(projection, "call_ok").presentation).toMatchObject({ detailOmitted: true });
    // An update without detail leaves the omission in place.
    projection.ingest(
      RUN_ID,
      shellCall("call_ok", "succeeded", { exitCode: 0, durationMs: 1_200 }, "msg_answer_2"),
    );
    expect(toolOf(projection, "call_ok").presentation).toMatchObject({ detailOmitted: true });
    // A new turn displaces the oldest one, so the feed has room again.
    projection.ingest(RUN_ID, message("msg_user_3", "user"));
    projection.ingest(RUN_ID, bulky("msg_answer_2", "call_ok", "succeeded"));
    const presentation = toolOf(projection, "call_ok").presentation;
    expect(presentation).not.toHaveProperty("detailOmitted");
    expect(presentation?.command?.text).toContain("call_ok");
    // An update that carries no detail keeps the detail the row has.
    projection.ingest(RUN_ID, shellCall("call_ok", "succeeded", { exitCode: 0 }, "msg_answer_2"));
    expect(toolOf(projection, "call_ok").presentation?.command?.text).toContain("call_ok");
  });

  it("keeps a full message inside its bound while its named texts keep growing", () => {
    const projection = assistantTurn();
    const answer = (chars: number): CodingSafeActivitySignal =>
      text("msg_answer", "a".repeat(chars));
    const thought = (chars: number): CodingSafeActivitySignal =>
      reasoning("msg_answer", "r".repeat(chars));
    // The reasoning closes and is named at four digits, the answer then fills the message.
    projection.ingest(RUN_ID, thought(8_200));
    projection.ingest(RUN_ID, answer(20_000));
    // Both named texts grow by several digits after the message was filled.
    projection.ingest(RUN_ID, answer(10_000_000));
    projection.ingest(RUN_ID, thought(1_000_000));
    const named = projected(projection);
    expect(named.fullAnswer).toEqual({ length: 10_020_000, truncated: false });
    expect(named.fullReasoning).toEqual({ length: 1_008_200, truncated: false });
    expect(Buffer.byteLength(JSON.stringify(named), "utf8")).toBeLessThanOrEqual(
      CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES,
    );
  });

  it("keeps a feed at its byte bound valid when Stop settles its open calls", () => {
    const projection = assistantTurn();
    const lastTurn = (): CodingSafeActivityTurn | undefined => {
      const feed = projection.currentContent()?.feed;
      if (feed?.availability !== "available") throw new TypeError("expected an available feed");
      return feed.turns.at(-1);
    };
    const turnBytes = (): number => Buffer.byteLength(JSON.stringify(lastTurn()), "utf8");
    const running = (index: number, commandChars: number): CodingSafeActivitySignal =>
      shellCall(`call_${String(index)}`, "running", {
        command: { text: "c".repeat(commandChars), truncated: false },
      });
    let index = 0;
    while (turnBytes() + 1_200 < CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES) {
      projection.ingest(RUN_ID, running(index, 900));
      index += 1;
    }
    while (turnBytes() + 220 < CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES) {
      projection.ingest(RUN_ID, running(index, 40));
      index += 1;
    }
    // Each settled call gains its origin, together more than the slack the turn had left.
    expect(index * 30).toBeGreaterThan(CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES - turnBytes());
    const updates: (CodingSafeActivityContent | null)[] = [];
    projection.subscribeContent((content) => updates.push(content));
    projection.interrupt(RUN_ID, "stop");
    const feed = projection.currentContent()?.feed;
    expect(feed).toBeDefined();
    expect(validateCodingSafeActivityFeed(feed).ok).toBe(true);
    expect(updates.at(-1)).not.toBeNull();
    expect(lastTurn()?.tools.every(({ state }) => state === "cancelled")).toBe(true);
  });

  it("sheds a success's text before a failure's under byte pressure and says so", () => {
    const projection = assistantTurn({ limits: { maxTurnBytes: 2_200, maxTotalBytes: 4_096 } });
    const bulky = (callId: string, state: "succeeded" | "failed"): CodingSafeActivitySignal =>
      shellCall(callId, state, {
        exitCode: state === "failed" ? 1 : 0,
        command: { text: `${callId} ${"c".repeat(400)}`, truncated: false },
        output: {
          head: "o".repeat(500),
          tail: "",
          lineCount: 1,
          hiddenLineCount: 0,
          truncated: false,
        },
      });
    projection.ingest(RUN_ID, bulky("call_ok", "succeeded"));
    projection.ingest(RUN_ID, bulky("call_bad", "failed"));
    projection.ingest(RUN_ID, bulky("call_ok2", "succeeded"));
    expect(toolOf(projection, "call_ok").presentation).toMatchObject({ detailOmitted: true });
    expect(toolOf(projection, "call_ok").presentation).not.toHaveProperty("command");
    expect(toolOf(projection, "call_bad").presentation?.command?.text).toContain("call_bad");
  });
});
