// Tests for the per-turn timing profile of the Coding Workbench live lab
// (scripts/testing/coding-workbench-lab/turn-profile.mjs) and the interval algebra under it.
//
// The events are built the way the registry says the product writes them: every registered field a
// fixture carries is checked against docs/observability/op-catalog.generated.json, so a fixture can
// never keep a name the registry has dropped. Timestamps are offsets in seconds from a fixed start.

import { describe, expect, it } from "vitest";

import { clip, lengthOf, subtract, unionOf } from "../testing/coding-workbench-lab/intervals.mjs";
import {
  PROFILE_CONTRACT,
  formatProfile,
  profileRun,
} from "../testing/coding-workbench-lab/turn-profile.mjs";
import {
  RUN,
  RUN_SUFFIX as SUFFIX,
  byTime,
  isoAt as iso,
  registryLine as line,
} from "./support/coding-workbench-lab-events.mjs";

const profile = (events) => profileRun(byTime(events), SUFFIX);
const settled = (offset) =>
  line("coding-runtime.run.settled", offset, RUN, { runId: RUN, state: "succeeded" });

/**
 * One sidecar model request in registry order: request-validated, the call's started line, the
 * token-counter fetch, the attempt's admission, the model's own fetch, the adapter's read line, the
 * terminal gateway line and the sidecar outcome.
 */
function modelRequest(id, start, spec = {}) {
  const s = {
    streamed: true,
    messages: 3,
    counterMs: 300,
    headersMs: 1900,
    read: { dataEvents: 500, firstDataMs: 15_000, durationMs: 20_000 },
    end: "completed",
    length: 22.3,
    prompt: 4000,
    completion: 500,
    finishReason: "tool_calls",
    outcome: "accepted",
    outputExhausted: false,
    reasoning: undefined,
    ...spec,
  };
  const at = (offset) => start + offset;
  const rows = [
    line("coding-sidecar.gateway.request-validated", at(0), id, {
      runId: RUN,
      inputMessageCount: s.messages,
    }),
    line(s.streamed ? "gateway.stream.started" : "gateway.chat.started", at(0.005), id, {
      streaming: s.streamed,
    }),
  ];
  const counterAt = 0.01 + (s.counterMs ?? 0) / 1000;
  const admissionAt = counterAt + 0.01;
  if (s.counterMs !== undefined) {
    rows.push(
      line(
        "http.gateway.fetch.completed",
        at(counterAt),
        id,
        { endpointClass: "loopback" },
        { durationMs: s.counterMs, status: 200 },
      ),
    );
  }
  rows.push(line("gateway.prompt.admission", at(admissionAt), id, { state: "admitted" }));
  if (s.headersMs !== undefined) {
    rows.push(
      line(
        "http.gateway.fetch.completed",
        at(admissionAt + s.headersMs / 1000),
        id,
        { endpointClass: "loopback" },
        { durationMs: s.headersMs, status: 200 },
      ),
    );
  }
  if (s.read !== undefined) {
    const { durationMs, ...fields } = s.read;
    rows.push(line("chat.response.streamed", at(s.length - 0.002), id, fields, { durationMs }));
  }
  rows.push(...terminalRows(id, at(s.length), s), outcomeRow(id, at(s.length + 0.001), s));
  return rows;
}

function terminalRows(id, when, s) {
  const durationMs = Math.round(s.length * 1000);
  if (s.end === "none") return [];
  if (s.end === "abandoned") {
    return [line("gateway.stream.abandoned", when, id, {}, { durationMs })];
  }
  if (s.end === "failed") {
    const op = s.streamed ? "gateway.stream.failed" : "gateway.chat.failed";
    return [line(op, when, id, { outputExhausted: s.outputExhausted }, { durationMs })];
  }
  const usage = {
    promptTokens: s.prompt,
    completionTokens: s.completion,
    ...(s.reasoning ?? {}),
  };
  if (s.streamed) return [line("gateway.stream.completed", when, id, usage, { durationMs })];
  return [
    line(
      "gateway.chat.completed",
      when,
      id,
      { ...usage, finishReason: s.finishReason },
      { durationMs },
    ),
  ];
}

function outcomeRow(id, when, s) {
  return line("coding-sidecar.gateway.outcome", when, id, { runId: RUN, outcome: s.outcome });
}

function tool(id, name, start, seconds) {
  return [
    line("tool-catalog.invocation-started", start, RUN, {
      invocationId: id,
      toolCanonicalId: name,
    }),
    line(
      "tool-catalog.invocation-settled",
      start + seconds,
      RUN,
      { invocationId: id, toolCanonicalId: name },
      { durationMs: Math.round(seconds * 1000) },
    ),
  ];
}

const approvalWaiting = (offset, requestId, fields = {}) =>
  line("coding-runtime.approval.waiting", offset, RUN, {
    runId: RUN,
    requestId,
    permissionKind: "command-execution",
    ...fields,
  });
const approvalDecided = (offset, requestId) =>
  line("coding-runtime.approval.decided", offset, RUN, {
    runId: RUN,
    requestId,
    decision: "approved",
  });
const approvalRetired = (offset, requestId) =>
  line("coding-runtime.approval.retired", offset, RUN, {
    runId: RUN,
    requestId,
    reason: "expired",
  });
const trustWaiting = (offset) =>
  line("coding-runtime.run.operator-decision", offset, RUN, {
    runId: RUN,
    state: "waiting",
    decision: "workspace-script-trust",
  });
const trustSettled = (offset) =>
  line("coding-runtime.run.operator-decision", offset, RUN, {
    runId: RUN,
    state: "settled",
    decision: "workspace-script-trust",
  });
const toolSideDecision = (offset) =>
  line("coding-runtime.operator-decision", offset, RUN, {
    decision: "workspace-script-trust",
    state: "settled",
    reason: "granted",
  });

describe("interval algebra", () => {
  it("unions overlapping and touching pairs, sorted, and drops empty and inverted ones", () => {
    expect(
      unionOf([
        [5, 8],
        [1, 3],
        [2, 4],
        [4, 4.5],
        [9, 9],
        [12, 10],
      ]),
    ).toEqual([
      [1, 4.5],
      [5, 8],
    ]);
  });

  it("does not mutate the pairs it is given", () => {
    const input = [
      [0, 2],
      [1, 3],
    ];
    unionOf(input);
    expect(input).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });

  it("subtracts a cut from the middle, an edge, the whole and from nothing", () => {
    expect(subtract([[0, 10]], [[3, 4]])).toEqual([
      [0, 3],
      [4, 10],
    ]);
    expect(subtract([[0, 10]], [[-1, 2]])).toEqual([[2, 10]]);
    expect(subtract([[0, 10]], [[8, 11]])).toEqual([[0, 8]]);
    expect(subtract([[0, 10]], [[0, 10]])).toEqual([]);
    expect(subtract([[0, 10]], [[20, 30]])).toEqual([[0, 10]]);
    expect(subtract([[0, 10]], [])).toEqual([[0, 10]]);
  });

  it("subtracts several cuts at once", () => {
    expect(
      lengthOf(
        subtract(
          [[0, 10]],
          [
            [1, 2],
            [4, 6],
            [9, 12],
          ],
        ),
      ),
    ).toBe(6);
  });

  it("clips to a window and measures the total length", () => {
    const set = [
      [0, 4],
      [6, 10],
    ];
    expect(clip(set, 2, 8)).toEqual([
      [2, 4],
      [6, 8],
    ]);
    expect(clip(set, 4, 6)).toEqual([]);
    expect(lengthOf(set)).toBe(8);
    expect(lengthOf([])).toBe(0);
  });
});

describe("profileRun: a streamed or buffered turn", () => {
  it("pairs the model's own fetch, not the token counter, and splits prefill from decoding (the review repro)", () => {
    // Counter 300 ms, model headers 1.9 s, first data 15 s after the headers, 500 tokens in 20 s.
    const run = profile([...modelRequest("req-1", 1), settled(30)]);
    const [turn] = run.turns;
    expect(turn.headersS).toBeCloseTo(1.9, 3);
    expect(turn.firstS).toBeCloseTo(16.9, 3);
    expect(turn.genS).toBeCloseTo(5, 3);
    expect(turn.tokensPerSecond).toBeCloseTo(100, 3);
    expect(turn.completion).toBe(500);
    expect(turn.prompt).toBe(4000);
  });

  it("does not drop a model fetch that was faster than the counter's, nor take a slow counter for it", () => {
    const fast = profile([
      ...modelRequest("req-1", 1, { counterMs: 800, headersMs: 40 }),
      settled(30),
    ]).turns[0];
    expect(fast.headersS).toBeCloseTo(0.04, 3);
    const noCounter = profile([
      ...modelRequest("req-1", 1, { counterMs: undefined, headersMs: 250 }),
      settled(30),
    ]).turns[0];
    expect(noCounter.headersS).toBeCloseTo(0.25, 3);
  });

  it("takes the last attempt of a retried call, never the first, failed one", () => {
    const id = "req-1";
    const rows = [
      line("coding-sidecar.gateway.request-validated", 0, id, { runId: RUN, inputMessageCount: 3 }),
      line("gateway.stream.started", 0.005, id, { streaming: true }),
      line("http.gateway.fetch.completed", 0.13, id, {}, { durationMs: 120 }),
      line("gateway.prompt.admission", 0.14, id, { state: "admitted" }),
      line("http.gateway.fetch.completed", 5.14, id, {}, { durationMs: 5000 }),
      line("chat.response.streamed", 5.2, id, { dataEvents: 0 }, { durationMs: 50 }),
      line("gateway.retry.scheduled", 5.21, id, { attempt: 1 }),
      line("http.gateway.fetch.completed", 6.0, id, {}, { durationMs: 700 }),
      line("gateway.prompt.admission", 6.01, id, { state: "admitted" }),
      line("http.gateway.fetch.completed", 7.3, id, {}, { durationMs: 1200 }),
      line(
        "chat.response.streamed",
        9.0,
        id,
        { dataEvents: 40, firstDataMs: 300 },
        { durationMs: 1500 },
      ),
      line("gateway.stream.completed", 9.01, id, { promptTokens: 900, completionTokens: 60 }),
      settled(10),
    ];
    const [turn] = profile(rows).turns;
    expect(turn.headersS).toBeCloseTo(1.2, 3);
    expect(turn.firstS).toBeCloseTo(1.5, 3);
    expect(turn.genS).toBeCloseTo(1.2, 3);
    expect(turn.retries).toEqual(["scheduled"]);
  });

  it("does not take the next attempt's counter call for the fetch of an attempt whose own fetch failed", () => {
    const id = "req-1";
    const rows = [
      line("coding-sidecar.gateway.request-validated", 0, id, { runId: RUN, inputMessageCount: 3 }),
      line("gateway.stream.started", 0.005, id, { streaming: true }),
      line("gateway.prompt.admission", 0.14, id, { state: "admitted" }),
      line("http.gateway.fetch.failed", 0.3, id, {}, { durationMs: 150 }),
      line("http.gateway.fetch.completed", 1.2, id, {}, { durationMs: 700 }),
      line("gateway.prompt.admission", 1.21, id, { state: "admitted" }),
      line("http.gateway.fetch.completed", 3.0, id, {}, { durationMs: 1700 }),
      line(
        "chat.response.streamed",
        4.0,
        id,
        { dataEvents: 40, firstDataMs: 200 },
        { durationMs: 900 },
      ),
      line("gateway.stream.completed", 4.01, id, { promptTokens: 900, completionTokens: 60 }),
      settled(5),
    ];
    expect(profile(rows).turns[0].headersS).toBeCloseTo(1.7, 3);
  });

  it("falls back to the last fetch before the read when the log has no admission line", () => {
    const id = "req-1";
    const rows = [
      line("coding-sidecar.gateway.request-validated", 0, id, { runId: RUN, inputMessageCount: 3 }),
      line("gateway.chat.started", 0.005, id, { streaming: false }),
      line("http.gateway.fetch.completed", 0.2, id, {}, { durationMs: 190 }),
      line("http.gateway.fetch.completed", 2.5, id, {}, { durationMs: 2200 }),
      line(
        "chat.response.streamed",
        4.5,
        id,
        { dataEvents: 50, firstDataMs: 400 },
        { durationMs: 2000 },
      ),
      line("gateway.chat.completed", 4.51, id, {
        finishReason: "tool_calls",
        promptTokens: 700,
        completionTokens: 90,
      }),
      settled(5),
    ];
    const [turn] = profile(rows).turns;
    expect(turn.headersS).toBeCloseTo(2.2, 3);
    expect(turn.firstS).toBeCloseTo(2.6, 3);
    expect(turn.genS).toBeCloseTo(1.6, 3);
  });

  it("reads a buffered turn: finish reason, usage and reasoning from gateway.chat.completed", () => {
    const run = profile([
      ...modelRequest("req-1", 1, {
        streamed: false,
        reasoning: { reasoningTokens: 300, reasoningBytes: 1100 },
      }),
      settled(30),
    ]);
    const [turn] = run.turns;
    expect(turn.finish).toBe("tool_calls");
    expect(turn.kind).toBe("accepted");
    expect(turn.reasoningTokens).toBe(300);
    expect(turn.reasoningBytes).toBe(1100);
  });

  it("reads a streamed turn: usage and reasoning from gateway.stream.completed, finish from the sidecar outcome", () => {
    const run = profile([
      ...modelRequest("req-1", 1, {
        reasoning: { reasoningTokens: 120, reasoningBytes: 480 },
        outcome: "accepted",
      }),
      settled(30),
    ]);
    const [turn] = run.turns;
    expect(turn.finish).toBe("accepted");
    expect(turn.prompt).toBe(4000);
    expect(turn.completion).toBe(500);
    expect(turn.reasoningTokens).toBe(120);
    expect(turn.reasoningBytes).toBe(480);
  });

  it("takes the reasoning counts from the end line only, never from the adapter's read line", () => {
    const rows = modelRequest("req-1", 1, {
      read: { dataEvents: 500, firstDataMs: 15_000, durationMs: 20_000, reasoningBytes: 7 },
      end: "failed",
    });
    const [turn] = profile([...rows, settled(30)]).turns;
    expect(turn.reasoningBytes).toBeUndefined();
    expect(turn.reasoningTokens).toBeUndefined();
  });

  it("shows no decoding rate for a tool call that arrived as one block", () => {
    const run = profile([
      ...modelRequest("req-1", 1, {
        headersMs: 5300,
        read: { dataEvents: 3, firstDataMs: 0.07, durationMs: 1.3 },
        completion: 32,
        length: 5.8,
      }),
      settled(10),
    ]);
    const [turn] = run.turns;
    expect(turn.headersS).toBeCloseTo(5.3, 3);
    expect(turn.genS).toBeCloseTo(0.0012, 3);
    expect(turn.tokensPerSecond).toBeUndefined();
    expect(formatProfile(run)[2]).toMatch(/ 32 {6}- /u);
  });

  it("leaves time to first data and decoding out for a whole-body answer", () => {
    const run = profile([
      ...modelRequest("req-1", 1, {
        read: { dataEvents: 0, durationMs: 40 },
        headersMs: 12_000,
        length: 12.6,
      }),
      settled(15),
    ]);
    const [turn] = run.turns;
    expect(turn.headersS).toBeCloseTo(12, 3);
    expect(turn.firstS).toBeUndefined();
    expect(turn.genS).toBeUndefined();
    expect(turn.tokensPerSecond).toBeUndefined();
  });

  it("does not count the gateway readiness request, which has no started line, as a turn", () => {
    const readiness = [
      line("coding-sidecar.gateway.request-validated", 0.5, "req-readiness", {
        runId: RUN,
        inputMessageCount: 1,
      }),
    ];
    const run = profile([...readiness, ...modelRequest("req-1", 1), settled(30)]);
    expect(run.turns).toHaveLength(1);
  });

  it("ignores hostile operation names and events of unrelated correlations", () => {
    const hostile = ["__proto__", "constructor", "toString", "hasOwnProperty"].map((op) => ({
      ts: iso(2),
      op,
      correlationId: "req-1",
    }));
    const stray = { ts: iso(2), op: "gateway.stream.completed", correlationId: "req-elsewhere" };
    const run = profile([...modelRequest("req-1", 1), ...hostile, stray, settled(30)]);
    expect(run.turns).toHaveLength(1);
    expect(run.turns[0].kind).toBe("accepted");
  });
});

describe("profileRun: failed, cancelled and open turns", () => {
  it("books a failed buffered call as model time, with its finish and without '(in flight)' (the review repro)", () => {
    // One accepted turn, then an output-exhausted turn of 406 s, as in the reviewer's synthetic run.
    const run = profile([
      ...modelRequest("req-1", 1, { length: 22, completion: 400, headersMs: 900 }),
      ...modelRequest("req-2", 24, {
        streamed: false,
        end: "failed",
        outputExhausted: true,
        read: { dataEvents: 6000, firstDataMs: 100, durationMs: 405_000 },
        headersMs: 900,
        length: 406,
        outcome: "failed",
      }),
      settled(431),
    ]);
    const [accepted, failed] = run.turns;
    expect(accepted.kind).toBe("accepted");
    expect(failed.kind).toBe("failed");
    expect(failed.finish).toBe("exhausted");
    expect(failed.completion).toBeUndefined();
    expect(failed.then).not.toMatch(/in flight|open at settlement/u);
    expect(run.seconds.byKind.failed).toBeCloseTo(406, 0);
    expect(run.seconds.model).toBeCloseTo(22 + 406, 0);
    expect(run.seconds.other).toBeLessThan(5);
    expect(run.seconds.other).toBeGreaterThanOrEqual(0);
  });

  it("reads a failed streamed call and an abandoned stream as turns that ended", () => {
    const run = profile([
      ...modelRequest("req-1", 1, {
        end: "failed",
        outcome: "failed",
        length: 60,
        read: { dataEvents: 200, firstDataMs: 100, durationMs: 59_000 },
      }),
      ...modelRequest("req-2", 62, { end: "abandoned", outcome: "cancelled", length: 8 }),
      settled(71),
    ]);
    const [failed, abandoned] = run.turns;
    expect(failed).toMatchObject({ kind: "failed", finish: "failed", ended: true });
    expect(abandoned).toMatchObject({ kind: "cancelled", finish: "abandoned", ended: true });
    expect(run.seconds.byKind.failed).toBeCloseTo(60, 0);
    expect(run.seconds.byKind.cancelled).toBeCloseTo(8, 0);
  });

  it("calls a call that failed because the run was stopped cancelled, not failed", () => {
    const run = profile([
      ...modelRequest("req-1", 1, {
        streamed: false,
        end: "failed",
        outcome: "cancelled",
        length: 30,
      }),
      settled(32),
    ]);
    expect(run.turns[0]).toMatchObject({ kind: "cancelled", finish: "cancelled" });
  });

  it("calls a turn the sidecar rejected at its output limit failed although the gateway completed it", () => {
    const run = profile([...modelRequest("req-1", 1, { outcome: "output-limit" }), settled(30)]);
    expect(run.turns[0]).toMatchObject({ kind: "failed", finish: "output-limit" });
  });

  it("marks a turn with no end line open at settlement, and in flight when the run has not settled", () => {
    const rows = modelRequest("req-1", 1, { end: "none", read: undefined, outcome: undefined });
    const openAtSettlement = profile([...rows, settled(31)]);
    expect(openAtSettlement.turns[0].then).toBe("(open at settlement)");
    expect(openAtSettlement.turns[0].kind).toBe("open");
    expect(openAtSettlement.seconds.model).toBeCloseTo(30, 1);
    const inFlight = profile(rows.filter((row) => row.op !== "coding-sidecar.gateway.outcome"));
    expect(inFlight.turns[0].then).toBe("(in flight)");
    expect(inFlight.isSettled).toBe(false);
  });

  it("keeps everything after the run settled out of the wall clock, the turns' end and the tools", () => {
    const run = profile([
      ...modelRequest("req-1", 1, { length: 20 }),
      // Cancelled at settlement: its end line arrives 5 s after the run settled.
      ...modelRequest("req-2", 23, { end: "abandoned", outcome: "cancelled", length: 12 }),
      ...tool("tool-after", "keiko.verification.run", 37, 2),
      settled(30),
    ]);
    expect(run.wall).toBeCloseTo(29, 3);
    expect(run.turns).toHaveLength(2);
    expect(run.turns[1].ended).toBe(false);
    expect(run.turns[1].then).toBe("(open at settlement)");
    expect(run.tools).toHaveLength(0);
    expect(run.seconds.model).toBeCloseTo(20 + 7, 1);
    expect(run.seconds.other).toBeGreaterThanOrEqual(0);
  });

  it("lists the retries of a turn that produced nothing", () => {
    const rows = modelRequest("req-1", 1, { end: "failed", outcome: "failed", length: 20 });
    const retry = line("gateway.retry.exhausted", 20.5, "req-1", { attempt: 1 });
    const circuit = line("gateway.circuit.wait", 20.6, "req-1", {});
    const [turn] = profile([...rows, retry, circuit, settled(30)]).turns;
    expect(turn.then).toMatch(/^retries exhausted,wait/u);
  });
});

describe("profileRun: operator pauses, tools and gaps", () => {
  const twoTurns = (secondStart) => [
    ...modelRequest("req-1", 1, { length: 9, read: undefined, headersMs: 500, counterMs: 100 }),
    ...modelRequest("req-2", secondStart, {
      length: 5,
      read: undefined,
      headersMs: 500,
      counterMs: 100,
    }),
  ];

  it("counts an approval wait as its own slice, out of the gap it lies in", () => {
    const run = profile([
      ...twoTurns(14.3),
      approvalWaiting(10.1, "permission-1"),
      approvalDecided(12.1, "permission-1"),
      ...tool("tool-1", "keiko.verification.run", 12.2, 2),
      settled(20),
    ]);
    expect(run.seconds.pauses).toBeCloseTo(2, 3);
    expect(run.seconds.tools).toBeCloseTo(2, 3);
    expect(run.seconds.gaps).toBeCloseTo(0.3, 3);
    expect(run.waits).toEqual([
      { label: "approval command-execution", count: 1, seconds: expect.closeTo(2, 3) },
    ]);
    expect(run.turns[0].then).toBe("verification.run 2.0s  wait 2.0s  gap 0.3s");
  });

  it("takes a script-trust wait out of the tool that waited for the decision", () => {
    const run = profile([
      ...twoTurns(41.5),
      ...tool("tool-1", "keiko.verification.run", 10.5, 30.5),
      trustWaiting(10.6),
      toolSideDecision(40.6),
      settled(50),
    ]);
    expect(run.seconds.pauses).toBeCloseTo(30, 3);
    expect(run.seconds.tools).toBeCloseTo(0.5, 3);
    expect(run.waits[0]).toMatchObject({ label: "script-trust", count: 1 });
    expect(run.turns[0].then).toContain("wait 30.0s");
  });

  it("ends a script-trust wait at the run's settled decision as well", () => {
    const run = profile([...twoTurns(20), trustWaiting(10.2), trustSettled(15.2), settled(30)]);
    expect(run.seconds.pauses).toBeCloseTo(5, 3);
  });

  it("ends an approval wait at its retirement", () => {
    const run = profile([
      ...twoTurns(20),
      approvalWaiting(10.2, "permission-1"),
      approvalRetired(16.2, "permission-1"),
      settled(30),
    ]);
    expect(run.seconds.pauses).toBeCloseTo(6, 3);
  });

  it("does not count a queued approval until it is promoted to the run's active one", () => {
    const run = profile([
      ...twoTurns(30),
      approvalWaiting(10.1, "permission-a"),
      approvalWaiting(10.6, "permission-b", { queuePosition: 1 }),
      approvalDecided(11.1, "permission-a"),
      approvalWaiting(11.2, "permission-b"),
      approvalDecided(13.2, "permission-b"),
      settled(40),
    ]);
    expect(run.seconds.pauses).toBeCloseTo(1 + 2, 3);
    expect(run.waits[0].count).toBe(2);
  });

  it("lasts an unanswered approval until the run's last event", () => {
    const run = profile([
      ...modelRequest("req-1", 1, { length: 9, read: undefined, headersMs: 500, counterMs: 100 }),
      approvalWaiting(10.2, "permission-1"),
      settled(20),
    ]);
    expect(run.seconds.pauses).toBeCloseTo(20 - 10.2, 3);
  });

  it("never counts a decision that was not asked for, nor a wait twice", () => {
    const run = profile([
      ...twoTurns(14.3),
      approvalDecided(11, "permission-unknown"),
      approvalWaiting(10.2, "permission-1"),
      approvalDecided(12.2, "permission-1"),
      approvalDecided(12.4, "permission-1"),
      settled(20),
    ]);
    expect(run.seconds.pauses).toBeCloseTo(2, 3);
    expect(run.waits[0].count).toBe(1);
  });

  it("does not count parallel tool calls twice", () => {
    const run = profile([
      ...twoTurns(14.3),
      ...tool("tool-1", "keiko.workspace.read", 10.5, 2),
      ...tool("tool-2", "keiko.workspace.read", 10.6, 2),
      ...tool("tool-3", "keiko.workspace.read", 10.7, 2),
      settled(20),
    ]);
    expect(run.seconds.tools).toBeCloseTo(2.2, 3);
    expect(run.tools).toHaveLength(3);
    expect(run.turns[0].then).toMatch(
      /^workspace\.read 2\.0s, workspace\.read 2\.0s, workspace\.read 2\.0s/u,
    );
  });

  it("splits the wall clock into slices that add up to it, whatever the overlap", () => {
    const run = profile([
      ...twoTurns(20),
      approvalWaiting(10.2, "permission-1"),
      approvalDecided(12.2, "permission-1"),
      ...tool("tool-1", "keiko.verification.run", 11, 6),
      settled(30),
    ]);
    const { model, pauses, tools, gaps, other } = run.seconds;
    expect(model + pauses + tools + gaps + other).toBeCloseTo(run.wall, 6);
    expect(Math.min(model, pauses, tools, gaps, other)).toBeGreaterThanOrEqual(0);
  });

  it("uses the durationMs of a settled tool and the timestamps when it has none", () => {
    const withoutDuration = tool("tool-1", "keiko.workspace.read", 10.5, 3);
    delete withoutDuration[1].durationMs;
    const run = profile([...twoTurns(20), ...withoutDuration, settled(30)]);
    expect(run.tools[0].durationS).toBeCloseTo(3, 3);
    expect(run.tools[0].name).toBe("workspace.read");
  });

  it("drops a tool that started and never settled", () => {
    const [started] = tool("tool-1", "keiko.workspace.read", 10.5, 3);
    const run = profile([...twoTurns(20), started, settled(30)]);
    expect(run.tools).toHaveLength(0);
  });
});

describe("profileRun: run-level facts and output", () => {
  it("names the run from the correlation that ends with the suffix, else from the suffix", () => {
    const events = [...modelRequest("req-1", 1), settled(30)];
    expect(profile(events).runId).toBe(RUN);
    expect(profileRun(byTime(events), "9999999").runId).toBe("run-9999999");
  });

  it("refuses an empty run", () => {
    expect(() => profileRun([], SUFFIX)).toThrow(RangeError);
  });

  it("reports the repository-instructions line the run logged", () => {
    const context = line("coding-runtime.repository-instructions.context", 0.5, RUN, {
      runId: RUN,
      state: "truncated",
      byteCount: 16_348,
      totalByteCount: 30_621,
      estimatedTokens: 4087,
    });
    const run = profile([context, ...modelRequest("req-1", 1), settled(30)]);
    expect(run.instructions).toMatchObject({
      state: "truncated",
      byteCount: 16_348,
      totalByteCount: 30_621,
      estimatedTokens: 4087,
    });
    expect(formatProfile(run)).toContain(
      "repository instructions (AGENTS.md): truncated, 16348 of 30621 bytes, about 4087 tokens re-sent with every turn",
    );
  });

  it("words an attached, an absent and a refused instructions line", () => {
    const attached = line("coding-runtime.repository-instructions.context", 0.5, RUN, {
      runId: RUN,
      state: "attached",
      byteCount: 816,
      totalByteCount: 816,
    });
    const refused = line("coding-runtime.repository-instructions.context", 0.5, RUN, {
      runId: RUN,
      state: "refused",
      reason: "too-large",
    });
    const textOf = (context) =>
      formatProfile(profile([context, ...modelRequest("req-1", 1), settled(30)])).join("\n");
    expect(textOf(attached)).toContain("repository instructions (AGENTS.md): attached, 816 bytes");
    expect(textOf(refused)).toContain(
      "repository instructions (AGENTS.md): refused, reason too-large",
    );
    expect(
      formatProfile(profile([...modelRequest("req-1", 1), settled(30)])).join("\n"),
    ).not.toContain("repository instructions");
  });

  it("prints a header, one row per turn and a breakdown that names failed time", () => {
    const run = profile([
      ...modelRequest("req-1", 1, { length: 22, completion: 400, headersMs: 900 }),
      ...tool("tool-1", "keiko.workspace.read", 23.5, 0.1),
      ...modelRequest("req-2", 24, { end: "failed", outcome: "failed", length: 100 }),
      settled(130),
    ]);
    const lines = formatProfile(run);
    expect(lines[0]).toBe(
      "run-2026100710000012345: 10:00:01Z -> 10:02:10Z  wall=129s  turns=2  tools=1  settled",
    );
    expect(lines[1]).toBe(
      "turn     at msgs prompt  hdr s ttft s  gen s  compl  tok/s  reas  rbyte       finish  then",
    );
    expect(lines[2]).toMatch(/^ {3}1 {6}0 /u);
    expect(lines[2]).toMatch(/accepted/u);
    expect(lines[3]).toMatch(/failed/u);
    const breakdown = lines.find((candidate) => candidate.startsWith("breakdown:"));
    expect(breakdown).toMatch(/model \d+s \(\d+%\) \[accepted 22s, failed 100s\]/u);
    expect(breakdown).toMatch(/operator pauses 0s \(0%\) \[none\]/u);
    expect(lines.at(-1)).toBe("slowest tools: workspace.read 0.1s");
  });

  it("prints the reasoning columns and '-' where a turn has none", () => {
    const run = profile([
      ...modelRequest("req-1", 1, { reasoning: { reasoningTokens: 120, reasoningBytes: 480 } }),
      settled(30),
    ]);
    const [header, row] = formatProfile(run).slice(1, 3);
    expect(header).toMatch(/reas {2}rbyte/u);
    expect(row).toMatch(/ 120 {4}480 /u);
    const bare = profile([...modelRequest("req-1", 1), settled(30)]);
    expect(formatProfile(bare)[2]).toMatch(/ {5}- {6}- /u);
  });

  it("marks a run that has not settled as in flight", () => {
    const run = profile(
      modelRequest("req-1", 1, { end: "none", read: undefined, outcome: undefined }),
    );
    expect(formatProfile(run)[0]).toMatch(/in flight$/u);
  });
});

describe("the profile's contract with the registry", () => {
  it("reads reasoning counts only from the two registered end operations", () => {
    const readers = Object.entries(PROFILE_CONTRACT)
      .filter(
        ([, fields]) => fields.includes("reasoningTokens") || fields.includes("reasoningBytes"),
      )
      .map(([operation]) => operation)
      .toSorted();
    expect(readers).toEqual(["gateway.chat.completed", "gateway.stream.completed"]);
  });

  it("does not read the operations that were never registered", () => {
    expect(Object.keys(PROFILE_CONTRACT)).not.toContain("coding-runtime.run.resumed");
  });
});
