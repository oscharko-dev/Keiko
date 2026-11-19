// The recall trace (#4205): where a needed memory was lost, per answer probe. The stage derivation is
// one pure function over the route's order, what the chat actually supplied and the chat's limit; the
// trace is recorded against a fake product that answers `POST /api/memory/context` like the real
// route, only after the chat answer, and a route that fails never fails the probe.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { runScenario } from "../testing/memory-lab/driver.mjs";
import {
  RECALL_STAGES,
  UNAVAILABLE_REASONS,
  neededStage,
  neededVerdict,
} from "../testing/memory-lab/recall-stage.mjs";
import {
  LIMIT_UNREADABLE,
  TRACE_BUDGET_TOKENS,
  buildRecallTrace,
  limitFromSource,
  readChatRetrievalLimit,
  recallTraceCoverage,
  traceWanted,
} from "../testing/memory-lab/recall-trace.mjs";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";
import { validateScenario } from "../testing/memory-lab/scenario.mjs";

const LIMIT = 6;
const base = {
  traceAvailable: true,
  limit: LIMIT,
  suppliedByChat: false,
  id: "m1",
  position: null,
  scoreRank: null,
  omittedReason: null,
  // A full chat block whose memories the route ranks first.
  supplied: { count: LIMIT, positions: [1, 2, 3, 4, 5, 6] },
};

describe("the stage of a needed memory", () => {
  it.each([
    ["supplied", { suppliedByChat: true, position: 9, scoreRank: 1 }],
    ["not-stored", { id: null }],
    ["trace-unavailable", { traceAvailable: false }],
    ["trace-unavailable", { storeKnown: false, id: null }],
    ["trace-unavailable", { position: 8, scoreRank: 8, limit: null }],
    ["not-a-candidate", {}],
    ["not-admitted", { omittedReason: "suppressed-by-status" }],
    ["not-admitted", { omittedReason: "below-threshold" }],
    ["not-admitted", { omittedReason: "out-of-scope" }],
    ["not-admitted", { omittedReason: "type-filtered" }],
    ["not-admitted", { omittedReason: "budget-exceeded" }],
    ["not-admitted", { omittedReason: "unknown" }],
  ])("is %s", (stage, fields) => {
    expect(neededStage({ ...base, ...fields })).toBe(stage);
    expect(RECALL_STAGES).toContain(stage);
  });

  it.each([
    // Position 7 to 12 behind a full chat block: beyond the chat's limit, never close.
    ["beyond-limit", { position: 7, scoreRank: 7 }],
    ["beyond-limit", { position: 9, scoreRank: 9 }],
    ["beyond-limit", { position: 12, scoreRank: 12 }],
    // The route omitted it by its own limit: it ranks behind everything listed.
    ["beyond-limit", { omittedReason: "max-included-exceeded" }],
    // Its score rank was inside the limit; the reorder put it outside.
    ["moved-down", { position: 8, scoreRank: 3 }],
    // The chat kept a memory the route ranks behind it.
    [
      "refused-by-chat",
      { position: 3, scoreRank: 3, supplied: { count: 6, positions: [1, 2, 4, 5, 6, 7] } },
    ],
    // The chat kept fewer than its limit although the memory ranked high enough.
    [
      "refused-by-chat",
      { position: 8, scoreRank: 8, supplied: { count: 3, positions: [1, 2, 3] } },
    ],
    ["refused-by-chat", { position: 2, scoreRank: 2, supplied: { count: 0, positions: [] } }],
    [
      "refused-by-chat",
      { omittedReason: "max-included-exceeded", supplied: { count: 2, positions: [1, 2] } },
    ],
    // A supplied memory the route omitted by its limit ranks behind a listed one.
    [
      "refused-by-chat",
      { position: 9, supplied: { count: 6, positions: [1, 2, 3, 4, 5, Infinity] } },
    ],
    // Two memories both omitted by the route's limit have no known order: not "below".
    [
      "beyond-limit",
      {
        omittedReason: "max-included-exceeded",
        supplied: { count: 6, positions: [1, 2, 3, 4, 5, Infinity] },
      },
    ],
    // A supplied memory the route did not rank at all says nothing about the order.
    [
      "beyond-limit",
      { position: 9, scoreRank: 9, supplied: { count: 6, positions: [1, 2, 3, 4, 5, null] } },
    ],
  ])("is %s for a memory the route admitted", (stage, fields) => {
    expect(neededStage({ ...base, ...fields })).toBe(stage);
    expect(RECALL_STAGES).toContain(stage);
  });

  it("has no basis to compare when a full chat block holds nothing the route ranked against the memory", () => {
    // The chat's block is full of memories the route did not rank; the needed memory is listed
    // inside the limit. Beyond-limit would be a wrong cause: the stage says it cannot tell.
    const unrankedBlock = { count: LIMIT, positions: Array(LIMIT).fill(null) };
    const inside = { position: 3, scoreRank: 3, supplied: unrankedBlock };
    expect(neededVerdict({ ...base, ...inside })).toEqual({
      stage: "trace-unavailable",
      reason: "chat-block-unplaceable",
    });
    // Both omitted by the route's limit: no known order between them.
    expect(
      neededVerdict({
        ...base,
        omittedReason: "max-included-exceeded",
        supplied: { count: LIMIT, positions: Array(LIMIT).fill(Infinity) },
      }),
    ).toEqual({ stage: "trace-unavailable", reason: "chat-block-unplaceable" });
    // A fewer-than-limit block, or one holding a memory ranked behind it, is still a refusal.
    expect(
      neededStage({ ...base, ...inside, supplied: { count: 2, positions: [null, null] } }),
    ).toBe("refused-by-chat");
    expect(
      neededStage({
        ...base,
        ...inside,
        supplied: { count: LIMIT, positions: [null, 9, null, null, null, null] },
      }),
    ).toBe("refused-by-chat");
    // One placed memory above it gives the comparison its basis.
    expect(
      neededStage({
        ...base,
        position: 9,
        scoreRank: 9,
        supplied: { count: LIMIT, positions: [1, null, null, null, null, null] },
      }),
    ).toBe("beyond-limit");
  });

  it("gives every unavailable stage a closed reason", () => {
    const reasons = [
      neededVerdict({ ...base, storeKnown: false }).reason,
      neededVerdict({ ...base, traceAvailable: false }).reason,
      neededVerdict({ ...base, position: 8, scoreRank: 8, limit: null }).reason,
      neededVerdict({
        ...base,
        position: 3,
        scoreRank: 3,
        supplied: { count: LIMIT, positions: [] },
      }).reason,
    ];
    expect(reasons.toSorted()).toEqual([...UNAVAILABLE_REASONS].toSorted());
    expect(neededVerdict({ ...base, position: 9, scoreRank: 9 })).toEqual({
      stage: "beyond-limit",
    });
  });

  it("names one stage for an admitted but not supplied memory when the run has an embedder", () => {
    // The auditor's case: the route's set holds a neighbour X that the chat's set does not (the
    // relaxed floor admits it), and the diversity reorder, which depends on the set, can put the
    // route's order against the chat's. The detailed stages rest on that order, so with an embedder
    // none of them is claimed.
    const routeOnlyNeighbour = { position: 1, scoreRank: 1 };
    const needed = { position: 2, scoreRank: 2 };
    const block = { count: 1, positions: [3] };
    // Without an embedder the route's order is the chat's: the chat kept a memory ranked behind it.
    expect(neededStage({ ...base, ...needed, supplied: block })).toBe("refused-by-chat");
    // With one, the same facts name only what is known.
    for (const fields of [
      { ...needed, supplied: block },
      { ...routeOnlyNeighbour, supplied: { count: LIMIT, positions: [1, 2, 3, 4, 5, 6] } },
      { position: 9, scoreRank: 9, supplied: { count: LIMIT, positions: [1, 2, 3, 4, 5, 6] } },
      { position: 8, scoreRank: 3, supplied: { count: LIMIT, positions: [1, 2, 3, 4, 5, 6] } },
      { omittedReason: "max-included-exceeded", supplied: block },
    ])
      expect(neededVerdict({ ...base, ...fields, orderPremise: false })).toEqual({
        stage: "admitted-not-supplied",
      });
    // It needs no limit, and it says nothing about what was never admitted or stored.
    expect(neededStage({ ...base, ...needed, limit: null, orderPremise: false })).toBe(
      "admitted-not-supplied",
    );
    expect(neededStage({ ...base, omittedReason: "out-of-scope", orderPremise: false })).toBe(
      "not-admitted",
    );
    expect(neededStage({ ...base, orderPremise: false })).toBe("not-a-candidate");
    expect(neededStage({ ...base, id: null, orderPremise: false })).toBe("not-stored");
    expect(neededStage({ ...base, suppliedByChat: true, orderPremise: false })).toBe("supplied");
  });

  it("names no stage that suggests a near miss or a budget cut", () => {
    expect(RECALL_STAGES).toEqual([
      "supplied",
      "not-stored",
      "not-a-candidate",
      "not-admitted",
      "refused-by-chat",
      "beyond-limit",
      "moved-down",
      "admitted-not-supplied",
      "trace-unavailable",
    ]);
  });

  it("lets what the chat supplied win, and what the store cannot say beat a guess", () => {
    expect(neededStage({ ...base, suppliedByChat: true, id: null, traceAvailable: false })).toBe(
      "supplied",
    );
    expect(neededStage({ ...base, id: null, traceAvailable: false })).toBe("not-stored");
    expect(neededStage({ ...base, storeKnown: false, id: null })).toBe("trace-unavailable");
  });

  it("does not need the chat's limit to say a memory was not admitted", () => {
    expect(neededStage({ ...base, limit: null, omittedReason: "out-of-scope" })).toBe(
      "not-admitted",
    );
    expect(neededStage({ ...base, limit: null })).toBe("not-a-candidate");
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
  const input = {
    response,
    wanted,
    carriers: new Map([
      ["room", ["m-room"]],
      ["day", ["m-day"]],
    ]),
    suppliedLabels: new Set(),
    suppliedIds: new Set(),
    retrievedIds: [],
    limit: 2,
    memories: [
      { id: "m-room", status: "accepted" },
      { id: "m-day", status: "accepted" },
    ],
  };
  const trace = buildRecallTrace(input);

  it("records the final order, the place by score, the counts per closed reason and the limit", () => {
    expect(trace).toMatchObject({
      source: "memory-context-route",
      strictFloor: false,
      chatLimit: 2,
      chatRetrievedCount: 0,
      includedCount: 3,
      omittedByReason: { "max-included-exceeded": 1, "out-of-scope": 2, unknown: 1 },
    });
    expect(trace.included.map((row) => [row.id, row.position])).toEqual([
      ["a", 1],
      ["m-room", 2],
      ["b", 3],
    ]);
    expect(trace.included[1]).toEqual({ id: "m-room", position: 2, score: 0.9, subscores: sub });
  });

  it("says per needed fact where it stands from the route's order, the chat's block and its limit", () => {
    // The chat supplied nothing although it could have: it refused both.
    expect(trace.needed.map((entry) => [entry.key, entry.stage])).toEqual([
      ["room", "refused-by-chat"],
      ["day", "refused-by-chat"],
    ]);
    const full = buildRecallTrace({
      ...input,
      retrievedIds: ["a", "b"],
      suppliedIds: new Set(["a", "b"]),
    });
    expect(full.needed).toEqual([
      {
        key: "room",
        id: "m-room",
        suppliedByChat: false,
        position: 2,
        scoreRank: 1,
        omittedReason: null,
        carrierCount: 1,
        stage: "refused-by-chat",
      },
      {
        key: "day",
        id: "m-day",
        suppliedByChat: false,
        position: null,
        scoreRank: null,
        omittedReason: "max-included-exceeded",
        carrierCount: 1,
        stage: "beyond-limit",
      },
    ]);
  });

  it("reads a score rank inside the limit and a position outside it as moved down", () => {
    const moved = buildRecallTrace({
      ...input,
      limit: 1,
      carriers: new Map([["room", ["m-room"]]]),
      wanted: [wanted[0]],
      retrievedIds: ["a"],
      suppliedIds: new Set(["a"]),
    });
    expect(moved.needed[0]).toMatchObject({ position: 2, scoreRank: 1, stage: "moved-down" });
  });

  it("never reads equal scores as a reorder, and carries no text", () => {
    const tied = buildRecallTrace({
      ...input,
      response: {
        included: [
          { memoryId: "a", score: 0.7, subscores: sub },
          { memoryId: "m-room", score: 0.7, subscores: sub },
        ],
        omitted: [],
      },
      wanted: [wanted[0]],
      limit: 1,
      retrievedIds: ["a"],
      suppliedIds: new Set(["a"]),
    });
    expect(tied.needed[0]).toMatchObject({ position: 2, scoreRank: 2, stage: "beyond-limit" });
    expect(JSON.stringify(trace)).not.toContain("free text");
  });

  it("reports a fact no stored memory carries as not stored, and a failed call as unavailable", () => {
    const failed = buildRecallTrace({
      ...input,
      response: undefined,
      failure: { kind: "http-error", status: 500 },
      memories: [{ id: "m-room", status: "accepted" }],
    });
    expect(failed).toMatchObject({ failure: "http-error", status: 500, strictFloor: false });
    expect(failed.needed.map((entry) => [entry.key, entry.id, entry.stage])).toEqual([
      ["room", "m-room", "trace-unavailable"],
      ["day", "m-day", "trace-unavailable"],
    ]);
  });

  it("says when the chat's limit could not be read, and stages only what needs it as unavailable", () => {
    const unread = buildRecallTrace({ ...input, limit: null, limitFailure: LIMIT_UNREADABLE });
    expect(unread).toMatchObject({ chatLimit: null, limitFailure: "chat-limit-unreadable" });
    expect(unread.needed.map((entry) => entry.stage)).toEqual([
      "trace-unavailable",
      "trace-unavailable",
    ]);
  });
});

describe("the trace of a run with an embedder", () => {
  const response = {
    included: [
      { memoryId: "x", score: 0.9, subscores: sub },
      { memoryId: "m-room", score: 0.8, subscores: sub },
      { memoryId: "a", score: 0.5, subscores: sub },
    ],
    omitted: [],
  };
  const input = {
    response,
    wanted: [wanted[0]],
    carriers: new Map([["room", ["m-room"]]]),
    suppliedLabels: new Set(),
    suppliedIds: new Set(["a"]),
    retrievedIds: ["a"],
    limit: 6,
    memories: [{ id: "m-room", status: "accepted" }],
  };

  it("records that the order premise was not assumed, and names the single stage", () => {
    const without = buildRecallTrace(input);
    expect(without.orderPremise).toBe(true);
    expect(without.needed[0].stage).toBe("refused-by-chat");
    const withEmbedder = buildRecallTrace({ ...input, orderPremise: false });
    expect(withEmbedder.orderPremise).toBe(false);
    expect(withEmbedder.needed[0]).toMatchObject({ key: "room", stage: "admitted-not-supplied" });
  });

  it("reaches the stage through the driver: the run's embedder decides", async () => {
    const run = async (embedder) => {
      const product = fakeProduct({
        memories: [ROOM, { id: "a", body: "Something else.", status: "accepted" }],
        supply: (memory) => memory.id === "a",
        route: answered(
          [
            { memoryId: "m-room", score: 0.9, subscores: {} },
            { memoryId: "a", score: 0.4, subscores: {} },
          ],
          [],
        ),
      });
      const result = await runScenario(scenario([NEEDS]), product.instance, context({ embedder }));
      return result.probes[0].recallTrace;
    };
    expect((await run("none")).needed[0].stage).toBe("refused-by-chat");
    for (const kind of ["scripted", "configured"]) {
      const trace = await run(kind);
      expect(trace.orderPremise).toBe(false);
      expect(trace.needed[0].stage).toBe("admitted-not-supplied");
    }
  });
});

describe("the chat's limit", () => {
  it("is read from the subject's built server, never assumed", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-lab-limit-"));
    try {
      const dist = join(root, "packages", "keiko-server", "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(
        join(dist, "chat-handlers.js"),
        "export const OTHER = 1;\nexport const CHAT_MAX_RETRIEVED_MEMORIES = 9;\n",
      );
      expect(readChatRetrievalLimit(root)).toEqual({ limit: 9 });
      writeFileSync(
        join(dist, "chat-handlers.js"),
        "export const CHAT_MAX_RETRIEVED_MEMORIES = x;\n",
      );
      expect(readChatRetrievalLimit(root)).toEqual({ failure: "chat-limit-unreadable" });
      expect(readChatRetrievalLimit(join(root, "missing"))).toEqual({
        failure: "chat-limit-unreadable",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["a plain declaration", "export const CHAT_MAX_RETRIEVED_MEMORIES = 6;\n", { limit: 6 }],
    ["a changed number", "export const CHAT_MAX_RETRIEVED_MEMORIES = 24;\n", { limit: 24 }],
    [
      "a trailing comment",
      "export const CHAT_MAX_RETRIEVED_MEMORIES = 8; // budget cap\n",
      { limit: 8 },
    ],
    [
      "a commented-out declaration before a literal one",
      "// export const CHAT_MAX_RETRIEVED_MEMORIES = 6;\nexport const CHAT_MAX_RETRIEVED_MEMORIES = 9;\n",
      { limit: 9 },
    ],
    [
      "a commented-out declaration before a computed one",
      "// export const CHAT_MAX_RETRIEVED_MEMORIES = 6;\nexport const CHAT_MAX_RETRIEVED_MEMORIES = readEnv(9);\n",
      { failure: "chat-limit-unreadable" },
    ],
    [
      "two declarations",
      "export const CHAT_MAX_RETRIEVED_MEMORIES = 6;\nexport const CHAT_MAX_RETRIEVED_MEMORIES = 9;\n",
      { failure: "chat-limit-unreadable" },
    ],
    [
      "a non-literal value",
      "export const CHAT_MAX_RETRIEVED_MEMORIES = Math.max(6, 9);\n",
      { failure: "chat-limit-unreadable" },
    ],
    [
      "an indented line inside a block",
      "function f() {\n  export const CHAT_MAX_RETRIEVED_MEMORIES = 6;\n}\n",
      { failure: "chat-limit-unreadable" },
    ],
    [
      "a zero",
      "export const CHAT_MAX_RETRIEVED_MEMORIES = 0;\n",
      { failure: "chat-limit-unreadable" },
    ],
    ["a constant that has gone", "export const OTHER = 6;\n", { failure: "chat-limit-unreadable" }],
  ])("reads %s from the source of the build", (_name, source, expected) => {
    expect(limitFromSource(source)).toEqual(expected);
  });

  it("is unreadable for a probe whose chat supplied more retrieved memories than the limit read", async () => {
    const product = fakeProduct({
      memories: [
        ROOM,
        { id: "x1", body: "One.", status: "accepted" },
        { id: "x2", body: "Two.", status: "accepted" },
      ],
      supply: () => true,
      route: answered([{ memoryId: "m-room", score: 0.4, subscores: {} }], []),
    });
    const result = await runScenario(
      scenario([NEEDS]),
      product.instance,
      context({ chatLimit: { limit: 2 } }),
    );
    const trace = result.probes[0].recallTrace;
    expect(trace).toMatchObject({
      chatLimit: null,
      chatRetrievedCount: 3,
      limitFailure: "chat-limit-unreadable",
    });
    expect(trace.needed.find((entry) => entry.key === "day").stage).toBe("not-stored");
    const unplaced = scenario([NEEDS]);
    expect(unplaced.probes).toHaveLength(1);
  });

  it("equals the product's own export in this checkout", () => {
    const source = readFileSync(
      join(REPO_ROOT, "packages", "keiko-server", "src", "chat-handlers.ts"),
      "utf8",
    );
    const declared = /export const CHAT_MAX_RETRIEVED_MEMORIES = (\d+);/u.exec(source);
    expect(readChatRetrievalLimit(REPO_ROOT)).toEqual({ limit: Number(declared[1]) });
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
    chatLimit: { limit: LIMIT },
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
      memories: [ROOM, DAY, { id: "other", body: "Something else.", status: "accepted" }],
      supply: (memory) => memory.id === "other",
      route: answered(
        [
          { memoryId: "other", score: 0.5, subscores: { relevance: 0.1 } },
          { memoryId: "m-room", score: 0.9, subscores: { relevance: 0.8 } },
        ],
        [{ memoryId: "m-day", reason: "suppressed-by-status" }],
      ),
    });
    const result = await runScenario(
      scenario([NEEDS, UNRELATED]),
      product.instance,
      context({ chatLimit: { limit: 1 } }),
    );
    const [probe, unrelated] = result.probes;
    expect(probe.recallTrace.needed.map((entry) => [entry.key, entry.id, entry.stage])).toEqual([
      ["room", "m-room", "moved-down"],
      ["day", "m-day", "not-admitted"],
      ["desk", null, "not-stored"],
    ]);
    expect(probe.recallTrace).toMatchObject({
      source: "memory-context-route",
      strictFloor: false,
      chatLimit: 1,
      includedCount: 2,
      omittedByReason: { "suppressed-by-status": 1 },
    });
    expect(probe.recallTrace.durationMs).toBeGreaterThanOrEqual(0);
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

  it("calls the route only after the probe's own chat turn, and times it apart from the probes", async () => {
    const product = fakeProduct({ memories: [ROOM], route: answered([], []) });
    const result = await runScenario(scenario([NEEDS]), product.instance, context());
    expect(product.calls.indexOf("POST /api/memory/context")).toBeGreaterThan(
      product.calls.lastIndexOf("POST /api/desktop/chat"),
    );
    expect(result.timing.traceMs).toBeGreaterThanOrEqual(0);
    expect(result.timing.probeMs).toBeGreaterThanOrEqual(0);
    const plain = await runScenario(
      scenario([NEEDS]),
      fakeProduct({ memories: [ROOM], route: answered([], []) }).instance,
      context({ recallTrace: false }),
    );
    expect(plain.timing).not.toHaveProperty("traceMs");
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

  it("is off by default, for the off arm, and for real conversations", async () => {
    const product = fakeProduct({ memories: [ROOM], route: answered([], []) });
    const unset = await runScenario(
      scenario([NEEDS]),
      product.instance,
      context({ recallTrace: undefined }),
    );
    const off = await runScenario(scenario([NEEDS]), product.instance, context({ arm: "off" }));
    const anchor = await runScenario(
      { ...scenario([NEEDS]), class: "anchor-lab" },
      product.instance,
      context(),
    );
    expect(unset.probes[0].recallTrace).toBeUndefined();
    expect(off.probes[0].recallTrace).toBeUndefined();
    expect(anchor.probes[0].recallTrace).toBeUndefined();
    expect(product.calls).not.toContain("POST /api/memory/context");
  });

  it("says the limit could not be read when the run passes none", async () => {
    const product = fakeProduct({
      memories: [ROOM],
      supply: () => false,
      route: answered([{ memoryId: "m-room", score: 0.4, subscores: {} }], []),
    });
    const result = await runScenario(
      scenario([NEEDS]),
      product.instance,
      context({ chatLimit: undefined }),
    );
    expect(result.probes[0].recallTrace).toMatchObject({
      chatLimit: null,
      limitFailure: "chat-limit-unreadable",
    });
    expect(result.probes[0].recallTrace.needed[0].stage).toBe("trace-unavailable");
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

describe("a probe that expects answer terms", () => {
  const termProbe = {
    id: "plain",
    question: "Room?",
    expect: { kind: "answer", terms: [["Birch"]] },
  };

  it("follows the truth whose terms are exactly its terms, for the trace only", async () => {
    const s = scenario([termProbe]);
    expect(traceWanted(s, termProbe).map((item) => item.label)).toEqual(["room"]);
    const product = fakeProduct({
      memories: [ROOM],
      supply: () => false,
      route: answered([{ memoryId: "m-room", score: 0.3, subscores: {} }], []),
    });
    const result = await runScenario(s, product.instance, context());
    expect(result.probes[0].recallTrace.needed).toMatchObject([
      { key: "room", id: "m-room", suppliedByChat: false, stage: "refused-by-chat" },
    ]);
    // The score never sees it.
    expect(result.probes[0]).not.toHaveProperty("neededMissing");
    expect(result.probes[0]).not.toHaveProperty("neededNotSupplied");
  });

  it("follows the truth whose terms the probe's terms cover, even when the probe accepts more", () => {
    const wider = { ...termProbe, expect: { kind: "answer", terms: [["Birch", "birches"]] } };
    expect(traceWanted(scenario([wider]), wider).map((item) => item.label)).toEqual(["room"]);
  });

  it("follows nothing when no truth has those terms", () => {
    const other = { ...termProbe, expect: { kind: "answer", terms: [["Nothing"]] } };
    expect(traceWanted(scenario([other]), other)).toEqual([]);
  });
});

describe("what the manifest says the run recorded", () => {
  const traced = { kind: "answer", recallTrace: {} };
  const untraced = { kind: "answer" };
  it.each([
    ["on", [{ arm: "product", probes: [traced, { kind: "abstain" }] }]],
    ["off", [{ arm: "product", probes: [untraced] }]],
    ["partial", [{ arm: "product", probes: [traced, untraced] }]],
    [
      "off",
      [
        { arm: "off", probes: [untraced] },
        { arm: "product", probes: [] },
      ],
    ],
    ["off", [{ arm: "product", error: {} }]],
  ])("is %s", (value, results) => {
    expect(recallTraceCoverage(results)).toBe(value);
  });
});
