// #4491 A-1: OpenCode opens one assistant message per agent step, so a fixed 16-message turn cap
// evicted the earliest model output of every ordinary run of more than 16 steps ("Activity
// truncated."). The count caps now sit far above what the byte bounds admit; the byte bounds are
// the memory guard, and a bound that is really reached still shows the truncation notice.
import { describe, expect, it } from "vitest";
import {
  CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN,
  CODING_SAFE_ACTIVITY_MAX_TOOLS_PER_TURN,
  CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES,
  validateCodingSafeActivityFeed,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  createCodingSafeActivityProjection,
  type CodingSafeActivitySignal,
} from "./codingSafeActivityProjection.js";

const RUN_ID = "run-safe-activity-long";
const WORKSPACE_ID = "workspace-safe-activity-long";

type Limits = NonNullable<Parameters<typeof createCodingSafeActivityProjection>[0]>["limits"];

function message(messageId: string, role: "user" | "assistant"): CodingSafeActivitySignal {
  return {
    kind: "message",
    messageId,
    role,
    occurredAt: "2026-07-18T17:00:00.000Z",
    ...(role === "assistant" ? { parentMessageId: "msg_user" } : {}),
  };
}

function open(limits?: Limits): {
  readonly projection: ReturnType<typeof createCodingSafeActivityProjection>;
  readonly activityLog: ReturnType<typeof createBufferedServerLogSink>;
} {
  const activityLog = createBufferedServerLogSink();
  const projection = createCodingSafeActivityProjection({
    now: () => 1_721_323_200_000,
    activityLog,
    ...(limits === undefined ? {} : { limits }),
  });
  projection.open({
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    authorityExpiresAt: "2026-07-18T18:00:00.000Z",
    workspaceIsCurrent: () => true,
  });
  projection.ingest(RUN_ID, message("msg_user", "user"));
  return { projection, activityLog };
}

function feedOf(
  projection: ReturnType<typeof createCodingSafeActivityProjection>,
): Extract<
  NonNullable<ReturnType<typeof projection.currentContent>>["feed"],
  { readonly availability: "available" }
> {
  const feed = projection.currentContent()?.feed;
  if (feed?.availability !== "available") throw new Error("expected an available feed");
  return feed;
}

function runSteps(
  projection: ReturnType<typeof createCodingSafeActivityProjection>,
  n: number,
): void {
  for (let step = 0; step < n; step += 1) {
    const id = `msg_step_${String(step)}`;
    projection.ingest(RUN_ID, message(id, "assistant"));
    projection.ingest(RUN_ID, {
      kind: "text",
      messageId: id,
      text: `Step ${String(step)} done.`,
      occurredAt: "2026-07-18T17:00:00.001Z",
    });
  }
}

// Every step answers with 3 KB of text and makes two calls; the very last call is still running.
function runStepsWithCalls(
  projection: ReturnType<typeof createCodingSafeActivityProjection>,
  steps: number,
): void {
  for (let step = 0; step < steps; step += 1) {
    const id = `msg_step_${String(step)}`;
    projection.ingest(RUN_ID, message(id, "assistant"));
    projection.ingest(RUN_ID, {
      kind: "text",
      messageId: id,
      text: "x".repeat(3_000),
      occurredAt: "2026-07-18T17:00:00.001Z",
    });
    for (const call of [0, 1]) {
      projection.ingest(RUN_ID, {
        kind: "tool",
        messageId: id,
        callId: `call_${String(step)}_${String(call)}`,
        tool: "keiko_workspace_read",
        state: step === steps - 1 && call === 1 ? "running" : "succeeded",
        occurredAt: "2026-07-18T17:00:01.000Z",
      });
    }
  }
}

describe("a long run's activity within the byte bounds", () => {
  it("keeps every step of a 60-step turn with no drop and no truncation", () => {
    const { projection, activityLog } = open();
    runSteps(projection, 60);
    const feed = feedOf(projection);
    const assistants = feed.turns[0]?.messages.filter(({ role }) => role === "assistant");
    expect(assistants).toHaveLength(60);
    expect(assistants?.[0]?.messageId).toBe("msg_step_0");
    expect(feed.turns[0]?.truncated).toBe(false);
    expect(feed.truncated).toBe(false);
    expect(feed.droppedEventCount).toBe(0);
    expect(activityLog.events).toEqual([]);
  });

  it("keeps the calls of a 150-call turn instead of evicting the oldest at 64", () => {
    const { projection } = open();
    projection.ingest(RUN_ID, message("msg_a", "assistant"));
    for (let call = 0; call < 150; call += 1) {
      projection.ingest(RUN_ID, {
        kind: "tool",
        messageId: "msg_a",
        callId: `call_${String(call)}`,
        tool: "keiko_workspace_read",
        state: "succeeded",
        occurredAt: "2026-07-18T17:00:01.000Z",
      });
    }
    const feed = feedOf(projection);
    expect(feed.turns[0]?.tools).toHaveLength(150);
    expect(feed.turns[0]?.truncated).toBe(false);
    expect(feed.droppedEventCount).toBe(0);
  });

  it("still shows the notice when a byte bound is really reached, and the feed stays valid", () => {
    const { projection, activityLog } = open({ maxTurnBytes: 2_048 });
    runSteps(projection, 60);
    const feed = feedOf(projection);
    const turn = feed.turns[0];
    expect(turn?.truncated).toBe(true);
    expect(turn?.messages[0]?.role).toBe("user");
    expect(turn?.messages.at(-1)?.messageId).toBe("msg_step_59");
    expect(Buffer.byteLength(JSON.stringify(turn), "utf8")).toBeLessThanOrEqual(2_048);
    expect(validateCodingSafeActivityFeed(feed).ok).toBe(true);
    // Every message the byte bound removed is a counted, logged loss (AGENTS.md section 8).
    const kept = (turn?.messages.length ?? 0) - 1;
    expect(feed.droppedEventCount).toBe(60 - kept);
    expect(feed.droppedEventCount).toBeGreaterThan(0);
    const dropLines = activityLog.events.filter(
      (event) => (event.extra as { readonly event?: string } | undefined)?.event === "dropped",
    );
    expect(dropLines.at(-1)).toMatchObject({
      op: "coding-runtime.safe-activity",
      correlationId: RUN_ID,
      extra: {
        event: "dropped",
        reason: "capacity-rejected",
        occurrenceCount: feed.droppedEventCount,
        lossState: "event-dropped",
      },
    });
  });

  it("counts the tool rows a byte bound removes", () => {
    const { projection } = open({ maxTurnBytes: 4_096 });
    projection.ingest(RUN_ID, message("msg_a", "assistant"));
    for (let call = 0; call < 100; call += 1) {
      projection.ingest(RUN_ID, {
        kind: "tool",
        messageId: "msg_a",
        callId: `call_${String(call)}`,
        tool: "keiko_workspace_read",
        state: "succeeded",
        occurredAt: "2026-07-18T17:00:01.000Z",
      });
    }
    const feed = feedOf(projection);
    expect(feed.turns[0]?.truncated).toBe(true);
    expect(feed.droppedEventCount).toBe(100 - (feed.turns[0]?.tools.length ?? 0));
  });

  it("evicts the oldest step with its own calls and keeps the newest running call", () => {
    const { projection } = open();
    runStepsWithCalls(projection, 400);
    const feed = feedOf(projection);
    const turn = feed.turns[0];
    const assistants = (turn?.messages ?? []).filter(({ role }) => role === "assistant");
    const tools = turn?.tools ?? [];
    expect(turn?.truncated).toBe(true);
    expect(assistants.length).toBeGreaterThan(1);
    expect(assistants.at(-1)?.messageId).toBe("msg_step_399");
    expect(tools.at(-1)).toMatchObject({ callId: "call_399_1", state: "running" });
    // The kept messages and calls are the newest ones, contiguous, and each call's step is kept.
    const firstKept = 400 - assistants.length;
    expect(assistants.map(({ messageId }) => messageId)).toEqual(
      Array.from({ length: assistants.length }, (_, i) => `msg_step_${String(firstKept + i)}`),
    );
    expect(tools).toHaveLength(assistants.length * 2);
    expect(tools[0]?.callId).toBe(`call_${String(firstKept)}_0`);
    expect(feed.droppedEventCount).toBe(400 - assistants.length + (800 - tools.length));
    expect(validateCodingSafeActivityFeed(feed).ok).toBe(true);
  });

  it("clamps the lost-event count to maxDroppedEventCount and logs the clamped total", () => {
    const activityLog = createBufferedServerLogSink();
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      activityLog,
      limits: { maxTurnBytes: 2_048 },
      maxDroppedEventCount: 5,
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.ingest(RUN_ID, message("msg_user", "user"));
    runSteps(projection, 60);
    const feed = feedOf(projection);
    expect(feed.droppedEventCount).toBe(5);
    const counts = activityLog.events
      .map((event) => event.extra as { event?: string; occurrenceCount?: number })
      .filter(({ event }) => event === "dropped")
      .map(({ occurrenceCount }) => occurrenceCount ?? 0);
    expect(counts.length).toBeGreaterThan(0);
    expect(Math.max(...counts)).toBe(5);
  });

  it("merges a signal's own capacity drop with the bytes' loss into one logged change", () => {
    // At the per-turn count cap the signal itself displaces one message (capacity drop); the same
    // pass's byte bound then removes more. One line carries the combined total.
    const { projection, activityLog } = open({ maxMessagesPerTurn: 4, maxTurnBytes: 700 });
    runSteps(projection, 30);
    const feed = feedOf(projection);
    const counts = activityLog.events
      .map((event) => event.extra as { event?: string; occurrenceCount?: number })
      .filter(({ event }) => event === "dropped")
      .map(({ occurrenceCount }) => occurrenceCount ?? 0);
    expect(counts.at(-1)).toBe(feed.droppedEventCount);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(feed.droppedEventCount).toBeGreaterThanOrEqual(30 - 4);
  });

  it("pins that the count caps are unreachable inside the turn byte bound", () => {
    // The smallest message and call the projection can hold (a one-character id) still costs more
    // than 64 bytes, so the byte bound decides before either 512 count can be reached.
    const { projection } = open();
    projection.ingest(RUN_ID, message("a", "assistant"));
    projection.ingest(RUN_ID, {
      kind: "tool",
      messageId: "a",
      callId: "b",
      tool: "x",
      state: "succeeded",
      occurredAt: "2026-07-18T17:00:01.000Z",
    });
    const turn = feedOf(projection).turns[0];
    const shell = Buffer.byteLength(JSON.stringify(turn?.messages[1]), "utf8");
    const call = Buffer.byteLength(JSON.stringify(turn?.tools[0]), "utf8");
    expect(shell * CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN).toBeGreaterThan(
      CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES,
    );
    expect(call * CODING_SAFE_ACTIVITY_MAX_TOOLS_PER_TURN).toBeGreaterThan(
      CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES,
    );
  });
});
