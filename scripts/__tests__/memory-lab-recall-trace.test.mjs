// The recall trace (#4205): where a needed memory was lost, per answer probe. The stage derivation is
// one pure function proven for every closed value; the trace is recorded against a fake product
// that answers `POST /api/memory/context` like the real route, only after the chat answer, and a
// route that fails never fails the probe.
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { runScenario } from "../testing/memory-lab/driver.mjs";
import { RECALL_STAGES, neededStage } from "../testing/memory-lab/recall-stage.mjs";
import { TRACE_BUDGET_TOKENS, buildRecallTrace } from "../testing/memory-lab/recall-trace.mjs";
import { validateScenario } from "../testing/memory-lab/scenario.mjs";

const base = {
  traceAvailable: true,
  suppliedByChat: false,
  id: "m1",
  position: null,
  scoreRank: null,
  omittedReason: null,
};

describe("the stage of a needed memory", () => {
  it.each([
    ["supplied", { suppliedByChat: true, position: 2, scoreRank: 1 }],
    ["not-stored", { id: null }],
    ["trace-unavailable", { traceAvailable: false }],
    ["trace-unavailable", { storeKnown: false, id: null }],
    ["not-a-candidate", {}],
    ["not-admitted", { omittedReason: "suppressed-by-status" }],
    ["not-admitted", { omittedReason: "below-threshold" }],
    ["not-admitted", { omittedReason: "out-of-scope" }],
    ["not-admitted", { omittedReason: "type-filtered" }],
    ["not-admitted", { omittedReason: "unknown" }],
    ["ranked-out", { omittedReason: "max-included-exceeded" }],
    ["cut-by-budget", { omittedReason: "budget-exceeded" }],
    ["moved-down", { position: 3, scoreRank: 1 }],
    ["ranked-low", { position: 2, scoreRank: 2 }],
    ["ranked-low", { position: 1, scoreRank: 1 }],
  ])("is %s", (stage, fields) => {
    expect(neededStage({ ...base, ...fields })).toBe(stage);
    expect(RECALL_STAGES).toContain(stage);
  });

  it("lets what the chat supplied win, and what the store cannot say beat a guess", () => {
    expect(neededStage({ ...base, suppliedByChat: true, id: null, traceAvailable: false })).toBe(
      "supplied",
    );
    expect(neededStage({ ...base, id: null, traceAvailable: false })).toBe("not-stored");
    expect(
      neededStage({ ...base, position: 2, scoreRank: 1, omittedReason: "budget-exceeded" }),
    ).toBe("moved-down");
  });

  it("names every closed stage, each reachable", () => {
    const reached = new Set(
      [
        { suppliedByChat: true },
        { id: null },
        { traceAvailable: false },
        {},
        { omittedReason: "out-of-scope" },
        { omittedReason: "max-included-exceeded" },
        { omittedReason: "budget-exceeded" },
        { position: 2, scoreRank: 1 },
        { position: 1, scoreRank: 1 },
      ].map((fields) => neededStage({ ...base, ...fields })),
    );
    expect([...reached].toSorted()).toEqual([...RECALL_STAGES].toSorted());
  });
});

const wanted = [
  { label: "room", link: { truth: "room" }, terms: [["Birch"]] },
  { label: "day", link: { truth: "day" }, terms: [["Tuesday"]] },
];
const sub = { relevance: 0.4, recency: 0.1 };

describe("the trace built from the route's answer", () => {
  const response = {
    included: [
      { memoryId: "a", score: 0.5, subscores: sub, inclusionReason: "free text" },
      { memoryId: "m-room", score: 0.9, subscores: sub, inclusionReason: "free text" },
      { memoryId: "b", score: 0.9, subscores: sub, inclusionReason: "free text" },
    ],
    omitted: [
      { memoryId: "m-day", reason: "max-included-exceeded" },
      { memoryId: "x", reason: "out-of-scope" },
      { memoryId: "y", reason: "out-of-scope" },
      { memoryId: "z", reason: "something-new" },
    ],
  };
  const trace = buildRecallTrace({
    response,
    wanted,
    carriers: new Map([
      ["room", ["m-room"]],
      ["day", ["m-day"]],
    ]),
    notSupplied: ["room", "day"],
    suppliedIds: new Set(),
    memories: [
      { id: "m-room", status: "accepted" },
      { id: "m-day", status: "accepted" },
    ],
  });

  it("records the final order, the place by score and the counts per closed reason", () => {
    expect(trace).toMatchObject({
      source: "memory-context-route",
      strictFloor: false,
      includedCount: 3,
      omittedByReason: { "max-included-exceeded": 1, "out-of-scope": 2, unknown: 1 },
    });
    expect(trace.included.map((row) => [row.id, row.position])).toEqual([
      ["a", 1],
      ["m-room", 2],
      ["b", 3],
    ]);
    expect(trace.included[1]).toEqual({
      id: "m-room",
      position: 2,
      score: 0.9,
      subscores: sub,
    });
  });

  it("says per needed fact where it stands: moved down by the reorder, or ranked out", () => {
    expect(trace.needed).toEqual([
      {
        key: "room",
        id: "m-room",
        suppliedByChat: false,
        position: 2,
        scoreRank: 1,
        omittedReason: null,
        carrierCount: 1,
        stage: "moved-down",
      },
      {
        key: "day",
        id: "m-day",
        suppliedByChat: false,
        position: null,
        scoreRank: null,
        omittedReason: "max-included-exceeded",
        carrierCount: 1,
        stage: "ranked-out",
      },
    ]);
  });

  it("never reads equal scores as a reorder, and carries no text", () => {
    const tied = buildRecallTrace({
      response: {
        included: [
          { memoryId: "a", score: 0.7, subscores: sub },
          { memoryId: "m-room", score: 0.7, subscores: sub },
        ],
        omitted: [],
      },
      wanted: [wanted[0]],
      carriers: new Map([["room", ["m-room"]]]),
      notSupplied: ["room"],
      suppliedIds: new Set(),
      memories: [],
    });
    expect(tied.needed[0]).toMatchObject({ position: 2, scoreRank: 2, stage: "ranked-low" });
    expect(JSON.stringify(trace)).not.toContain("free text");
  });

  it("reports a fact no stored memory carries as not stored, and a failed call as unavailable", () => {
    const failed = buildRecallTrace({
      failure: { kind: "http-error", status: 500 },
      wanted,
      carriers: new Map([["room", ["m-room"]]]),
      notSupplied: ["room", "day"],
      suppliedIds: new Set(),
      memories: [{ id: "m-room", status: "accepted" }],
    });
    expect(failed).toMatchObject({ failure: "http-error", status: 500, strictFloor: false });
    expect(failed.needed.map((entry) => [entry.key, entry.id, entry.stage])).toEqual([
      ["room", "m-room", "trace-unavailable"],
      ["day", null, "not-stored"],
    ]);
  });
});

const TRUTH = [
  { key: "room", seed: "Room Birch.", must: false, terms: [["Birch"]] },
  { key: "day", seed: "Every Tuesday.", must: false, terms: [["Tuesday"]] },
  { key: "desk", seed: "Desk seven.", must: false, terms: [["seven"]] },
];

function scenario(probes) {
  return validateScenario({
    schemaVersion: 1,
    id: "trace-fixture-en",
    language: "en",
    class: "update",
    difficulty: "plain",
    description: "Trace fixture.",
    truth: TRUTH,
    turns: [{ user: "Hello." }],
    probes,
  });
}

const NEEDS = {
  id: "all",
  question: "Where, when and at which desk?",
  expect: { kind: "answer", needs: ["room", "day", "desk"] },
};
const UNRELATED = { id: "other", question: "What causes rain?", expect: { kind: "no-memory" } };

// A fake product: a stored list, a chat that supplies what `supply` lets through, and a retrieval
// route whose answer the test decides. Every call is recorded in order.
function fakeProduct({ memories, supply = () => true, route }) {
  const calls = [];
  const bodies = [];
  let counter = 0;
  const request = async (method, path, body) => {
    const url = new URL(path, "http://127.0.0.1");
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === "/api/projects") return { status: 200, json: {} };
    if (url.pathname === "/api/chats")
      return { status: 200, json: { chat: { id: `c${String(counter++)}` } } };
    if (url.pathname === "/api/memory/context") {
      bodies.push(body);
      return route(body);
    }
    if (url.pathname === "/api/desktop/chat") {
      const supplied = memories
        .filter(supply)
        .map((memory) => ({ memoryId: memory.id, bodyExcerpt: memory.body }));
      return {
        status: 200,
        json: {
          messages: [{ role: "assistant", content: "I do not know." }],
          memory: { actions: [], context: { memories: supplied } },
        },
      };
    }
    if (url.searchParams.has("since")) return { status: 200, json: { captures: [], total: 0 } };
    return { status: 200, json: { memories: [...memories], total: memories.length } };
  };
  return { calls, bodies, instance: { request, project: "/project", answerModelId: "model" } };
}

function context(overrides = {}) {
  return {
    arm: "product",
    memoryMode: "autonomous-delivery",
    budgetTokens: 1200,
    confirmForget: true,
    retainBodies: true,
    recallTrace: true,
    turnTimeoutMs: 5000,
    learning: { quietMs: 0, maxMs: 2000 },
    ...overrides,
  };
}

const ROOM = { id: "m-room", body: "Room Birch.", status: "accepted" };
const DAY = { id: "m-day", body: "Every Tuesday.", status: "proposed" };
const answered = (included, omitted) => async () => ({
  status: 200,
  json: { contextBlock: { text: "SECRET TEXT", memories: [] }, included, omitted, budget: {} },
});

describe("the trace on an answer probe", () => {
  it("is recorded after the answer, for the same chat and question, with a budget that cuts nothing", async () => {
    const product = fakeProduct({
      memories: [ROOM, DAY],
      supply: (memory) => memory.id !== "m-room" && memory.status === "accepted",
      route: answered(
        [
          { memoryId: "other", score: 0.5, subscores: { relevance: 0.1 } },
          { memoryId: "m-room", score: 0.9, subscores: { relevance: 0.8 } },
        ],
        [{ memoryId: "m-day", reason: "suppressed-by-status" }],
      ),
    });
    const result = await runScenario(scenario([NEEDS, UNRELATED]), product.instance, context());
    const [probe, unrelated] = result.probes;
    expect(probe.recallTrace.needed.map((entry) => [entry.key, entry.id, entry.stage])).toEqual([
      ["room", "m-room", "moved-down"],
      ["day", "m-day", "not-admitted"],
      ["desk", null, "not-stored"],
    ]);
    expect(probe.recallTrace).toMatchObject({
      source: "memory-context-route",
      strictFloor: false,
      includedCount: 2,
      omittedByReason: { "suppressed-by-status": 1 },
    });
    expect(unrelated.recallTrace).toBeUndefined();
    expect(product.bodies).toHaveLength(1);
    expect(product.bodies[0]).toEqual({
      projectPath: "/project",
      chatId: "c1",
      queryText: "Where, when and at which desk? (in English)",
      budgetTokens: TRACE_BUDGET_TOKENS,
    });
    // No text of the product's answer reaches the record.
    expect(JSON.stringify(probe.recallTrace)).not.toMatch(/SECRET|Birch|Tuesday|Where/u);
  });

  it("calls the route only after the probe's own chat turn", async () => {
    const product = fakeProduct({
      memories: [ROOM],
      route: answered([], []),
    });
    await runScenario(scenario([NEEDS]), product.instance, context());
    const probeChat = product.calls.lastIndexOf("POST /api/desktop/chat");
    const route = product.calls.indexOf("POST /api/memory/context");
    expect(route).toBeGreaterThan(probeChat);
  });

  it("names the facts a chat did supply as supplied, and leaves the score untouched", async () => {
    const withTrace = fakeProduct({ memories: [ROOM], route: answered([], []) });
    const without = fakeProduct({ memories: [ROOM], route: answered([], []) });
    const traced = await runScenario(scenario([NEEDS]), withTrace.instance, context());
    const plain = await runScenario(
      scenario([NEEDS]),
      without.instance,
      context({ recallTrace: false }),
    );
    expect(traced.probes[0].recallTrace.needed[0]).toMatchObject({
      key: "room",
      suppliedByChat: true,
      stage: "supplied",
    });
    const { recallTrace: _trace, elapsedMs: _a, ...tracedRow } = traced.probes[0];
    const { elapsedMs: _b, ...plainRow } = plain.probes[0];
    expect(tracedRow).toEqual(plainRow);
    expect(without.calls).not.toContain("POST /api/memory/context");
  });

  it("is off by default and never recorded for the off arm", async () => {
    const product = fakeProduct({ memories: [ROOM], route: answered([], []) });
    const unset = await runScenario(
      scenario([NEEDS]),
      product.instance,
      context({ recallTrace: undefined }),
    );
    const off = await runScenario(scenario([NEEDS]), product.instance, context({ arm: "off" }));
    expect(unset.probes[0].recallTrace).toBeUndefined();
    expect(off.probes[0].recallTrace).toBeUndefined();
    expect(product.calls).not.toContain("POST /api/memory/context");
  });

  it.each([
    ["an HTTP error", async () => ({ status: 500, json: {} }), "http-error", 500],
    [
      "a malformed answer",
      async () => ({ status: 200, json: { memories: [] } }),
      "malformed-response",
    ],
    [
      "a request that throws",
      async () => {
        throw new Error("socket closed");
      },
      "request-failed",
    ],
  ])(
    "records %s as a closed failure and lets the probe stand",
    async (_name, route, failure, status) => {
      const product = fakeProduct({ memories: [ROOM], supply: () => false, route });
      const result = await runScenario(scenario([NEEDS]), product.instance, context());
      const [probe] = result.probes;
      expect(probe.recallTrace).toMatchObject({ failure, strictFloor: false });
      expect(probe.recallTrace.status).toBe(status);
      expect(probe.recallTrace.needed.map((entry) => entry.stage)).toEqual([
        "trace-unavailable",
        "not-stored",
        "not-stored",
      ]);
      expect(probe.kind).toBe("answer");
      expect(probe.passed).toBe(false);
      expect(probe.neededNotSupplied).toEqual(["room", "day", "desk"]);
    },
  );
});

describe("a trace on a probe without needs", () => {
  it("records the route's order and counts and no needed entries", async () => {
    const product = fakeProduct({
      memories: [ROOM],
      route: answered([{ memoryId: "m-room", score: 0.3, subscores: {} }], []),
    });
    const probe = {
      id: "plain",
      question: "Room?",
      expect: { kind: "answer", terms: [["Birch"]] },
    };
    const result = await runScenario(scenario([probe]), product.instance, context());
    expect(result.probes[0].recallTrace).toMatchObject({ includedCount: 1, needed: [] });
  });
});
