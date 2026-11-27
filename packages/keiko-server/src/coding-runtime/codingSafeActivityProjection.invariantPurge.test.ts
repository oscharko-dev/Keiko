// #2906 round 3 regression: finalizeIngest's KEIKO-0878 invariant-violation branch (validate
// rejected a post-mutation feed that isFeedNearProjectionLimit's pre-mutation check believed could
// not fail) used to purge with the "expiry" reason -- a code that otherwise means TTL/authority
// expiry (which purges silently via expireCurrent(), with no diagnostic at all) and is completely
// unrelated to a validation/invariant failure. Isolated into its own file because it mocks
// @oscharko-dev/keiko-contracts/runtime/coding-safe-activity's validateCodingSafeActivityFeed to
// force the branch that is, by
// design, unreachable through any legitimate signal (every projection limit is already enforced at
// signal-apply time, so validate never legitimately disagrees with the pre-mutation heuristic) --
// the mock must not leak into the rest of the (real-validator) suite in codingSafeActivityProjection.test.ts.
import { describe, expect, it, vi } from "vitest";

import type { ServerDiagnosticRecord } from "../diagnostics-log.js";

const { validateMock } = vi.hoisted(() => ({
  validateMock: vi.fn(),
}));

vi.mock("@oscharko-dev/keiko-contracts/runtime/coding-safe-activity", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@oscharko-dev/keiko-contracts/runtime/coding-safe-activity")
    >();
  return { ...actual, validateCodingSafeActivityFeed: validateMock };
});

function stepSignals(index: number): readonly [object, object] {
  return [
    {
      kind: "message",
      messageId: `msg_${String(index)}`,
      role: "assistant",
      parentMessageId: "msg_user_0",
      occurredAt: "2026-07-18T17:00:00.001Z",
    },
    {
      kind: "tool",
      messageId: `msg_${String(index)}`,
      callId: `call_${String(index)}`,
      tool: "keiko_workspace_read",
      state: "succeeded",
      occurredAt: "2026-07-18T17:00:00.002Z",
    },
  ];
}

function orphanedCalls(
  turn:
    | {
        readonly messages: readonly { readonly messageId: string }[];
        readonly tools: readonly { readonly callId: string }[];
      }
    | undefined,
): string[] {
  const kept = new Set((turn?.messages ?? []).map(({ messageId }) => messageId));
  return (turn?.tools ?? [])
    .map(({ callId }) => callId)
    .filter((callId) => !kept.has(`msg_${callId.slice("call_".length)}`));
}

const RUN_ID = "run-safe-activity-invariant";
const WORKSPACE_ID = "workspace-safe-activity-invariant";

describe("codingSafeActivityProjection finalizeIngest invariant-violation purge (#2906 round 3)", () => {
  it("purges with a distinct invariant-violation reason, never the unrelated expiry code", async () => {
    // Forces finalizeIngest's post-mutation validate call to fail unconditionally. The freshly
    // opened entry has zero turns, so isFeedNearProjectionLimit's pre-mutation check is false (not
    // near any count-based limit) and no rollback snapshot is taken -- exactly the KEIKO-0878
    // "the threshold heuristic disagreed with validate" scenario this branch defends against.
    validateMock.mockReturnValue({ ok: false, value: undefined, errors: ["forced for test"] });
    const { createCodingSafeActivityProjection } =
      await import("./codingSafeActivityProjection.js");
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

    const accepted = projection.ingest(RUN_ID, {
      kind: "message",
      messageId: "msg_user_0",
      role: "user",
      occurredAt: "2026-07-18T17:00:00.000Z",
    });

    expect(accepted).toBe(false);
    expect(projection.currentContent()).toBeNull();
    expect(records).toHaveLength(1);
    expect(records[0]?.message).toBe("safe-activity-purged-invariant-violation");
    expect(records[0]?.message).not.toBe("safe-activity-purged-expiry");
    expect(records[0]?.operation).toBe("coding-runtime.safe-activity");
    // The only purge that is a fault keeps its content-free diagnostic: a closed code, class and
    // summary under the run's correlation id, and nothing from the feed it purged.
    expect(records[0]).toMatchObject({
      code: "CODING_SAFE_ACTIVITY_PURGED",
      errorClass: "SafeActivityProjectionPurge",
      correlationId: RUN_ID,
      source: "opencode.safe-activity",
    });
    expect(JSON.stringify(records)).not.toContain("msg_user_0");
  });

  it("applies a signal again after a capacity rollback refused it", async () => {
    validateMock.mockReset();
    const { validateCodingSafeActivityFeed: realValidate } = await vi.importActual<
      typeof import("@oscharko-dev/keiko-contracts/runtime/coding-safe-activity")
    >("@oscharko-dev/keiko-contracts/runtime/coding-safe-activity");
    validateMock.mockImplementation(realValidate);
    const { createCodingSafeActivityProjection } =
      await import("./codingSafeActivityProjection.js");
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      // One turn is already near the turn limit, so the next signal takes a rollback snapshot.
      limits: { maxTurns: 1 },
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.ingest(RUN_ID, {
      kind: "message",
      messageId: "msg_user_0",
      role: "user",
      occurredAt: "2026-07-18T17:00:00.000Z",
    });
    const answer = {
      kind: "message",
      signalId: "signal-answer",
      messageId: "msg_answer",
      role: "assistant",
      parentMessageId: "msg_user_0",
      occurredAt: "2026-07-18T17:00:00.001Z",
    } as const;
    validateMock.mockReturnValueOnce({ ok: false, value: undefined, errors: ["forced for test"] });

    expect(projection.ingest(RUN_ID, answer)).toBe(false);
    expect(JSON.stringify(projection.currentContent())).not.toContain("msg_answer");
    // The rolled-back signal was never applied, so its redelivery is applied, not deduplicated.
    expect(projection.ingest(RUN_ID, answer)).toBe(true);
    expect(JSON.stringify(projection.currentContent())).toContain("msg_answer");
  });

  it("restores each call's owning message with a rolled-back eviction (#4491)", async () => {
    validateMock.mockReset();
    const { validateCodingSafeActivityFeed: realValidate } = await vi.importActual<
      typeof import("@oscharko-dev/keiko-contracts/runtime/coding-safe-activity")
    >("@oscharko-dev/keiko-contracts/runtime/coding-safe-activity");
    validateMock.mockImplementation(realValidate);
    const { createCodingSafeActivityProjection } =
      await import("./codingSafeActivityProjection.js");
    const projection = createCodingSafeActivityProjection({
      now: () => 1_721_323_200_000,
      // One turn is near the turn limit, so every signal takes a rollback snapshot; the small turn
      // bound makes the pass after enough steps evict the oldest step with its call.
      limits: { maxTurns: 1, maxTurnBytes: 1_200 },
    });
    projection.open({
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      authorityExpiresAt: "2026-07-18T18:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.ingest(RUN_ID, {
      kind: "message",
      messageId: "msg_user_0",
      role: "user",
      occurredAt: "2026-07-18T17:00:00.000Z",
    });
    const ingestSteps = (from: number, to: number): void => {
      for (let index = from; index < to; index += 1) {
        for (const signal of stepSignals(index)) projection.ingest(RUN_ID, signal as never);
      }
    };
    // Enough steps that the small turn bound already evicts the oldest ones.
    ingestSteps(0, 25);
    const index = 25;
    // The next step's call is the signal whose pass evicts; that pass is rolled back once.
    const [message, tool] = stepSignals(index);
    projection.ingest(RUN_ID, message as never);
    validateMock.mockReturnValueOnce({ ok: false, value: undefined, errors: ["forced for test"] });
    expect(projection.ingest(RUN_ID, tool as never)).toBe(false);
    expect(projection.ingest(RUN_ID, tool as never)).toBe(true);
    ingestSteps(index + 1, index + 7);
    const feed = projection.currentContent()?.feed;
    if (feed?.availability !== "available") throw new Error("expected an available feed");
    expect(feed.turns[0]?.tools.length).toBeGreaterThan(0);
    expect(feed.turns[0]?.messages.length).toBeLessThan(25);
    // Every kept call still belongs to a kept message: none was orphaned by the rollback.
    expect(orphanedCalls(feed.turns[0])).toEqual([]);
  });
});
