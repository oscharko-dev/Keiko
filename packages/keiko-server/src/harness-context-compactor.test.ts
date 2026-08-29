// KEIKO-0726 (#3323): the production HarnessCompactionPort wired into checkModelCallLimits.
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@oscharko-dev/keiko-model-gateway";
import { resolveTaskPlan, type HarnessEvent } from "@oscharko-dev/keiko-harness";
import type { ServerLogEvent, ServerLogSink } from "./observability/server-log.js";
import {
  createServerHarnessContextCompactor,
  logHarnessContextCompactionEvents,
  serverHarnessContextCompactor,
} from "./harness-context-compactor.js";

const SYSTEM: ChatMessage = { role: "system", content: "you are a helpful agent" };
const USER: ChatMessage = { role: "user", content: "goal: investigate the failure" };

// AGENTS.md §7: derived from the executor's REAL append shape (executor.ts's assistantMessage /
// toolMessageCandidate), not an invented fixture formula — an assistant response plus the
// role:"tool" result(s) it triggered, exactly what a real harness run appends per round.
function assistantTurn(id: number, size = 50): ChatMessage[] {
  return [
    {
      role: "assistant",
      content: `call ${String(id)}: ${"a".repeat(size)}`,
      toolCalls: [{ id: `call-${String(id)}`, name: "read_file", arguments: {} }],
    },
    {
      role: "tool",
      content: `result ${String(id)}: ${"r".repeat(size)}`,
      toolCallId: `call-${String(id)}`,
    },
  ];
}

function bytesOf(messages: readonly ChatMessage[]): number {
  return new TextEncoder().encode(JSON.stringify(messages)).length;
}

describe("createServerHarnessContextCompactor", () => {
  it("returns undefined when there is nothing to evict (0 or 1 assistant turns)", () => {
    const compactor = createServerHarnessContextCompactor();
    expect(compactor({ messages: [SYSTEM, USER], maxContextBytes: 10 })).toBeUndefined();
    expect(
      compactor({ messages: [SYSTEM, USER, ...assistantTurn(1)], maxContextBytes: 10 }),
    ).toBeUndefined();
  });

  it("evicts the oldest turns first, always preserving the newest turn and the [system, user] seed", () => {
    const messages: ChatMessage[] = [
      SYSTEM,
      USER,
      ...assistantTurn(1, 500),
      ...assistantTurn(2, 500),
      ...assistantTurn(3, 500),
    ];
    const compactor = createServerHarnessContextCompactor();
    // Small enough that at least turn 1 must go, large enough that turn 3 (newest) survives.
    const budget = bytesOf(messages) - 400;
    const result = compactor({ messages, maxContextBytes: budget });
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(bytesOf(result.messages)).toBeLessThanOrEqual(budget);
    const rendered = JSON.stringify(result.messages);
    expect(rendered).not.toContain("call 1:");
    expect(rendered).toContain("call 3:");
    expect(result.messages[0]).toEqual(SYSTEM);
    expect(result.messages[1]).toEqual(USER);
    // A content-free eviction notice replaces the dropped turn(s).
    expect(rendered).toContain("keiko.compactedHistoryNotice");
  });

  it("reports the real eviction count, not net array shrinkage (Codex, #3348)", () => {
    // First eviction pass: a 2-message assistant/tool turn is evicted and exactly one
    // placeholder notice message is inserted in its place. Net array-length shrinkage
    // (messages.length before - after) would report 1, undercounting the 2 real messages
    // actually dropped -- the defect the messagesEvicted field exists to fix.
    const messages: ChatMessage[] = [
      SYSTEM,
      USER,
      ...assistantTurn(1, 500),
      ...assistantTurn(2, 500),
      ...assistantTurn(3, 500),
    ];
    const compactor = createServerHarnessContextCompactor();
    const budget = bytesOf(messages) - 400;
    const result = compactor({ messages, maxContextBytes: budget });
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.messagesEvicted).toBe(2);
    // Pin that the two values actually differ, so the naive net-shrinkage formula can never be
    // silently reinstated as the source of the reported count.
    expect(messages.length - result.messages.length).not.toBe(result.messagesEvicted);
    expect(messages.length - result.messages.length).toBe(1);
  });

  it("never rewrites tool-role message content — only evicts whole turns", () => {
    const toolMessage: ChatMessage = {
      role: "tool",
      content: "already-shaped-or-raw tool output",
      toolCallId: "call-1",
    };
    const messages: ChatMessage[] = [
      SYSTEM,
      USER,
      {
        role: "assistant",
        content: "a1",
        toolCalls: [{ id: "call-1", name: "t", arguments: {} }],
      },
      toolMessage,
      ...assistantTurn(2, 2000),
      ...assistantTurn(3, 50),
    ];
    const budget = bytesOf(messages) - 1500;
    const compactor = createServerHarnessContextCompactor();
    const result = compactor({ messages, maxContextBytes: budget });
    expect(result).toBeDefined();
    if (result === undefined) return;
    // The tool message content is byte-identical wherever it still appears, or absent entirely
    // (evicted as part of its whole turn) — never altered in place.
    const survivingTool = result.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "call-1",
    );
    if (survivingTool !== undefined) {
      expect(survivingTool.content).toBe(toolMessage.content);
    }
  });

  it("returns undefined when even dropping every evictable turn still does not fit", () => {
    const messages: ChatMessage[] = [
      SYSTEM,
      USER,
      ...assistantTurn(1, 5000),
      ...assistantTurn(2, 50),
    ];
    const compactor = createServerHarnessContextCompactor();
    const result = compactor({ messages, maxContextBytes: 10 });
    expect(result).toBeUndefined();
  });

  // 2895 audit KEIKO-0900/KEIKO-0901: the escalation used to start from the keiko-workflows
  // allocator's exclusion count for a "history-summary" lane capped at a fixed 16,000 TOKENS,
  // completely unrelated to the actual byte budget this gate enforces. A history whose estimated
  // token size clears that 16k lane cap made the allocator exclude MANY turns, and the old
  // start-from-that-count loop only ever escalated upward from there — so a history just a few
  // bytes over maxContextBytes could lose nearly all of it even though dropping the single oldest
  // turn was enough to fit. This test builds exactly that shape: comfortably over 16,000 tokens
  // (60 turns of dense 2,000-character content each, ~68,000+ tokens at the ~3.5 bytes/token
  // estimator — packages/keiko-contracts/src/context-engineering.ts), but with maxContextBytes set
  // to just ONE byte under the full, uncompacted size — the smallest possible byte overage. Fixed
  // behavior: only the single oldest turn is evicted. Unfixed (start-from-excludedTurnCount)
  // behavior: roughly half the turns would be evicted to clear the 16k lane cap, which this test's
  // assertions on turn 1..58's surviving markers would catch.
  it("evicts only the minimum oldest turn(s) when a tiny byte overage hides behind a large token estimate (near-cap regression)", () => {
    const turnCount = 60;
    const rounds = Array.from({ length: turnCount }, (_, i) => assistantTurn(i, 2000)).flat();
    const messages: ChatMessage[] = [SYSTEM, USER, ...rounds];
    const fullBytes = bytesOf(messages);
    // Comfortably clears the allocator's fixed 16,000-token "history-summary" lane cap regardless
    // of which byte/token divisor applies, so the OLD behavior would have excluded far more than
    // the byte-minimum one turn.
    expect(fullBytes).toBeGreaterThan(150_000);
    const compactor = createServerHarnessContextCompactor();
    // Exactly one byte over budget with zero turns dropped: the smallest possible byte overage.
    const result = compactor({ messages, maxContextBytes: fullBytes - 1 });
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(bytesOf(result.messages)).toBeLessThanOrEqual(fullBytes - 1);
    // Exactly one turn (2 messages: the assistant call + its tool result) was evicted.
    expect(result.messagesEvicted).toBe(2);
    const rendered = JSON.stringify(result.messages);
    // The oldest turn (call 0) is gone...
    expect(rendered).not.toContain("call 0:");
    // ...but EVERY other turn, including the second-oldest (call 1), survives verbatim. The old
    // start-from-excludedTurnCount behavior would have dropped call 1 (and many more) too, since
    // the allocator's 16k-token lane cap demands excluding roughly half of 60 dense-content turns.
    for (let i = 1; i < turnCount; i += 1) {
      expect(rendered).toContain(`call ${String(i)}:`);
    }
  });

  it("the exported default instance behaves the same as a freshly-created one", () => {
    const messages: ChatMessage[] = [
      SYSTEM,
      USER,
      ...assistantTurn(1, 500),
      ...assistantTurn(2, 500),
    ];
    const budget = bytesOf(messages) - 200;
    const fresh = createServerHarnessContextCompactor()({ messages, maxContextBytes: budget });
    const shared = serverHarnessContextCompactor({ messages, maxContextBytes: budget });
    expect(shared).toEqual(fresh);
  });

  // KEIKO-0726 review Blocker 2: the compactor must actually compact the shape a REAL harness run
  // produces. AGENTS.md §7 — the seed comes from the production entry point (resolveTaskPlan), not
  // a hand-invented multi-user-turn fixture the harness can never generate. Reproduces the
  // reviewer's own repro shape: an editor-agent-turn seed plus 12 assistant+tool rounds, well over
  // a 5000-byte ceiling. Before the fix (segmenting on role:"user") this always returned undefined
  // because the harness never produces more than one role:"user" message.
  it("compacts a real editor-agent-turn shape (resolveTaskPlan seed + repeated assistant/tool rounds)", () => {
    const plan = resolveTaskPlan({
      taskType: "editor-agent-turn",
      input: { goal: "investigate the failing suite", sessionId: "session-proof" },
    });
    const rounds = Array.from({ length: 12 }, (_, i) => assistantTurn(i, 400)).flat();
    const messages: ChatMessage[] = [...plan.messages, ...rounds];
    // Comfortably larger than the 5000-byte ceiling below, so compaction is genuinely required.
    expect(bytesOf(messages)).toBeGreaterThan(10_000);
    const compactor = createServerHarnessContextCompactor();
    const result = compactor({ messages, maxContextBytes: 5000 });
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(bytesOf(result.messages)).toBeLessThanOrEqual(5000);
    // The plan's own seed messages survive verbatim as the protected head.
    expect(result.messages.slice(0, plan.messages.length)).toEqual(plan.messages);
    // The newest round (call 11) survives; the oldest (call 0) does not.
    const rendered = JSON.stringify(result.messages);
    expect(rendered).toContain("call 11:");
    expect(rendered).not.toContain("call 0:");
  });

  // Non-blocking defect fixed alongside Blocker 2: a notice from an earlier pass must be replaced,
  // never accumulated, and must never become part of the permanently protected head.
  it("merges a prior eviction notice into one, reflecting the cumulative dropped-turn count", () => {
    const seed = resolveTaskPlan({
      taskType: "editor-agent-turn",
      input: { goal: "g", sessionId: "s" },
    }).messages;
    const compactor = createServerHarnessContextCompactor();
    const firstPass: ChatMessage[] = [
      ...seed,
      ...assistantTurn(1, 500),
      ...assistantTurn(2, 500),
      ...assistantTurn(3, 500),
    ];
    const firstResult = compactor({
      messages: firstPass,
      maxContextBytes: bytesOf(firstPass) - 400,
    });
    expect(firstResult).toBeDefined();
    if (firstResult === undefined) return;
    const notices = (msgs: readonly ChatMessage[]): number =>
      msgs.filter((m) => m.role === "system" && m.content.includes("keiko.compactedHistoryNotice"))
        .length;
    expect(notices(firstResult.messages)).toBe(1);

    // Second pass: append more rounds on top of the already-compacted (already-notice-bearing)
    // history and force another eviction.
    const secondPass: ChatMessage[] = [
      ...firstResult.messages,
      ...assistantTurn(4, 500),
      ...assistantTurn(5, 500),
    ];
    const secondResult = compactor({
      messages: secondPass,
      maxContextBytes: bytesOf(secondPass) - 400,
    });
    expect(secondResult).toBeDefined();
    if (secondResult === undefined) return;
    // Exactly one notice survives — never two side-by-side stale/fresh notices — and it is not
    // baked into the non-evictable head (it sits after the seed, still subject to replacement).
    expect(notices(secondResult.messages)).toBe(1);
    const noticeMessage = secondResult.messages.find(
      (m) => m.role === "system" && m.content.includes("keiko.compactedHistoryNotice"),
    );
    expect(noticeMessage).toBeDefined();
    const parsed: { droppedTurns?: unknown } = JSON.parse(noticeMessage?.content ?? "{}") as {
      droppedTurns?: unknown;
    };
    // The cumulative total across both passes, not merely this pass's own contribution.
    expect(typeof parsed.droppedTurns).toBe("number");
    expect(parsed.droppedTurns).toBeGreaterThan(1);
  });
});

describe("logHarnessContextCompactionEvents", () => {
  function captor(): { sink: ServerLogSink; writes: ServerLogEvent[] } {
    const writes: ServerLogEvent[] = [];
    return { sink: { write: (event) => writes.push(event) }, writes };
  }

  it("writes one body-free activity-log line per context:compacted event, correlationId = runId", () => {
    const { sink, writes } = captor();
    const events: HarnessEvent[] = [
      {
        schemaVersion: "1",
        runId: "run-123",
        fingerprint: "fp",
        seq: 1,
        ts: 0,
        type: "context:compacted",
        messagesDropped: 4,
        bytesBefore: 9000,
        bytesAfter: 3000,
      },
    ];
    logHarnessContextCompactionEvents(events, {}, sink);
    expect(writes).toHaveLength(1);
    const line = writes[0];
    expect(line?.op).toBe("harness.context.compacted");
    expect(line?.category).toBe("process");
    expect(line?.correlationId).toBe("run-123");
    expect(line?.parentCorrelationId).toBeUndefined();
    expect(line?.extra).toEqual({ messagesDropped: 4, bytesBefore: 9000, bytesAfter: 3000 });
    // Body-free: no message content anywhere in the line.
    expect(JSON.stringify(line)).not.toContain("call ");
  });

  it("threads a supplied parentCorrelationId onto the emitted line (Codex, #3348)", () => {
    // A read-only child's compaction line otherwise carries only the harness's own freshly-minted
    // runId, an orphan identity that support analysis can never join back to the governed parent
    // run that spawned the child (AGENTS.md §8 Rule 1, ADR-0173 D5).
    const { sink, writes } = captor();
    const events: HarnessEvent[] = [
      {
        schemaVersion: "1",
        runId: "run-456",
        fingerprint: "fp",
        seq: 1,
        ts: 0,
        type: "context:compacted",
        messagesDropped: 2,
        bytesBefore: 5000,
        bytesAfter: 2000,
      },
    ];
    logHarnessContextCompactionEvents(events, { parentCorrelationId: "parent-run-abc" }, sink);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.correlationId).toBe("run-456");
    expect(writes[0]?.parentCorrelationId).toBe("parent-run-abc");
  });

  it("writes nothing for a run whose events contain no context:compacted event", () => {
    const { sink, writes } = captor();
    const events: HarnessEvent[] = [
      {
        schemaVersion: "1",
        runId: "run-1",
        fingerprint: "fp",
        seq: 1,
        ts: 0,
        type: "run:started" as const,
        taskType: "editor-agent-turn",
        modelId: "m",
        limits: {
          maxIterations: 1,
          maxModelCalls: 1,
          maxToolCalls: 1,
          maxCommandExecutions: 1,
          maxContextBytes: 1,
          maxPatchBytes: 1,
          maxWallTimeMs: 1,
          maxFailureAttempts: 1,
        },
      },
    ];
    logHarnessContextCompactionEvents(events, {}, sink);
    expect(writes).toHaveLength(0);
  });
});
