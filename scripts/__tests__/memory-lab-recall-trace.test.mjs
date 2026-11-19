// The recall trace (#4205): where a needed memory was lost, per answer probe. The stage derivation is
// one pure function over what the route reported and what the chat actually supplied; the route's
// position is a recorded fact, never a source of a chat stage. The trace is recorded against a fake
// product that answers `POST /api/memory/context` like the real route, only after the chat answer, and
// a route that fails never fails the probe.
import { describe, expect, it } from "vitest";
import { URL, fileURLToPath } from "node:url";
import { runScenario } from "../testing/memory-lab/driver.mjs";
import {
  LEGACY_RECALL_STAGES,
  RECALL_STAGES,
  UNAVAILABLE_REASONS,
  neededStage,
  neededVerdict,
} from "../testing/memory-lab/recall-stage.mjs";
import {
  TRACE_BUDGET_TOKENS,
  buildRecallTrace,
  factlessProbes,
  recallTraceCoverage,
  traceWanted,
} from "../testing/memory-lab/recall-trace.mjs";
import { loadScenarioDirectory, validateScenario } from "../testing/memory-lab/scenario.mjs";
import { join } from "node:path";

const labRoot = () => fileURLToPath(new URL("../testing/memory-lab/", import.meta.url));
const base = {
  traceAvailable: true,
  suppliedByChat: false,
  id: "m1",
  position: null,
  omittedReason: null,
};

describe("the stage of a needed memory", () => {
  it.each([
    ["supplied", { suppliedByChat: true, position: 9 }],
    ["not-stored", { id: null }],
    ["trace-unavailable", { traceAvailable: false }],
    ["trace-unavailable", { storeKnown: false, id: null }],
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

  it("is admitted-not-supplied for every memory the route admitted and the chat did not supply", () => {
    // Listed at any position, or omitted only by the route's own limit: the same single stage, because
    // the route's order says nothing certain about the chat's (the chat ranks its admitted memories
    // among themselves under the strict floor, the route ranks one window under the lenient floor).
    for (const fields of [
      { position: 1 },
      { position: 3 },
      { position: 7 },
      { position: 12 },
      { omittedReason: "max-included-exceeded" },
    ])
      expect(neededVerdict({ ...base, ...fields })).toEqual({ stage: "admitted-not-supplied" });
  });

  it("derives nothing from the route's position or score rank beyond whether it was admitted", () => {
    const near = neededVerdict({ ...base, position: 2, scoreRank: 2 });
    const far = neededVerdict({ ...base, position: 12, scoreRank: 1 });
    expect(near).toEqual(far);
  });

  it("names exactly the closed stage set, and no stage that reads a chat cut out of the route's order", () => {
    expect(RECALL_STAGES).toEqual([
      "supplied",
      "not-stored",
      "not-a-candidate",
      "not-admitted",
      "admitted-not-supplied",
      "trace-unavailable",
    ]);
    for (const old of ["refused-by-chat", "beyond-limit", "moved-down"])
      expect(RECALL_STAGES).not.toContain(old);
    // They survive only as names an old run may carry.
    expect(LEGACY_RECALL_STAGES).toEqual(["refused-by-chat", "beyond-limit", "moved-down"]);
  });

  it("gives every unavailable stage a closed reason", () => {
    const reasons = [
      neededVerdict({ ...base, storeKnown: false }).reason,
      neededVerdict({ ...base, traceAvailable: false }).reason,
    ];
    expect(reasons.toSorted()).toEqual([...UNAVAILABLE_REASONS].toSorted());
    expect(neededVerdict({ ...base, position: 9 })).toEqual({ stage: "admitted-not-supplied" });
  });

  it("lets what the chat supplied win, and what the store cannot say beat a guess", () => {
    expect(neededStage({ ...base, suppliedByChat: true, id: null, traceAvailable: false })).toBe(
      "supplied",
    );
    expect(neededStage({ ...base, id: null, traceAvailable: false })).toBe("not-stored");
    expect(neededStage({ ...base, storeKnown: false, id: null })).toBe("trace-unavailable");
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
    memories: [
      { id: "m-room", status: "accepted" },
      { id: "m-day", status: "accepted" },
    ],
  };
  const trace = buildRecallTrace(input);

  it("records the final order, the place by score and the counts per closed reason, and no chat limit", () => {
    expect(trace).toMatchObject({
      source: "memory-context-route",
      strictFloor: false,
      chatRetrievedCount: 0,
      includedCount: 3,
      omittedByReason: { "max-included-exceeded": 1, "out-of-scope": 2, unknown: 1 },
    });
    for (const gone of ["orderPremise", "chatLimit", "limitFailure"])
      expect(trace).not.toHaveProperty(gone);
    expect(trace.included.map((row) => [row.id, row.position])).toEqual([
      ["a", 1],
      ["m-room", 2],
      ["b", 3],
    ]);
    expect(trace.included[1]).toEqual({ id: "m-room", position: 2, score: 0.9, subscores: sub });
  });

  it("records position and score rank as facts and derives one stage from them", () => {
    expect(trace.needed).toEqual([
      {
        key: "room",
        id: "m-room",
        suppliedByChat: false,
        position: 2,
        scoreRank: 1,
        omittedReason: null,
        carrierCount: 1,
        stage: "admitted-not-supplied",
      },
      {
        key: "day",
        id: "m-day",
        suppliedByChat: false,
        position: null,
        scoreRank: null,
        omittedReason: "max-included-exceeded",
        carrierCount: 1,
        stage: "admitted-not-supplied",
      },
    ]);
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
    });
    expect(tied.needed[0]).toMatchObject({ position: 2, scoreRank: 2 });
    expect(JSON.stringify(trace)).not.toContain("free text");
  });

  it("reports a failed call as unavailable with its closed reason", () => {
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
    expect(failed.needed[0].unavailableReason).toBe("route-failed");
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
    const result = await runScenario(scenario([NEEDS, UNRELATED]), product.instance, context());
    const [probe, unrelated] = result.probes;
    expect(probe.recallTrace.needed.map((entry) => [entry.key, entry.id, entry.stage])).toEqual([
      ["room", "m-room", "admitted-not-supplied"],
      ["day", "m-day", "not-admitted"],
      ["desk", null, "not-stored"],
    ]);
    expect(probe.recallTrace).toMatchObject({
      source: "memory-context-route",
      strictFloor: false,
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
      { key: "room", id: "m-room", suppliedByChat: false, stage: "admitted-not-supplied" },
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
  const traced = { kind: "answer", recallTrace: { needed: [{ key: "k" }] } };
  const factless = { kind: "answer", recallTrace: { needed: [] } };
  const untraced = { kind: "answer" };
  it.each([
    ["on", [{ arm: "product", probes: [traced, { kind: "abstain" }] }]],
    ["off", [{ arm: "product", probes: [untraced] }]],
    ["partial", [{ arm: "product", probes: [traced, untraced] }]],
    // The failure this pins: a probe traced with no fact to follow counted as traced, so the manifest
    // said `on` while no stage class could be counted for it.
    ["partial", [{ arm: "product", probes: [traced, factless] }]],
    ["partial", [{ arm: "product", probes: [factless] }]],
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

  it("names the answer probes that were traced with no fact, and only those", () => {
    const results = [
      {
        scenario: "s",
        arm: "product",
        repetition: 1,
        probes: [
          { id: "a", ...factless },
          { id: "b", ...traced },
          { id: "c", ...untraced },
        ],
      },
      { scenario: "s", arm: "off", repetition: 0, probes: [{ id: "d", ...factless }] },
    ];
    expect(factlessProbes(results)).toEqual(["s:product:r1:a"]);
  });
});

describe("the fact a probe's trace follows", () => {
  const fact = (key, seed, terms) => ({ key, seed, must: false, terms });
  const twoFacts = validateScenario({
    schemaVersion: 1,
    id: "follow-fixture-en",
    language: "en",
    class: "preference",
    difficulty: "plain",
    description: "Follow fixture.",
    truth: [
      fact("spaces", "I prefer spaces over tabs.", [["spaces over tabs"]]),
      fact("theme", "I use the dark theme.", [["dark theme"]]),
      fact("evening", "I read reports abends.", [["abends"]]),
      // Unrelated to every probe below, but its body shares the common word "dark" with `theme`.
      fact("font", "I keep a dark terminal font.", [["terminal font"]]),
    ],
    turns: [{ user: "Hello." }],
    probes: [
      { id: "p1", question: "?", expect: { kind: "answer", terms: [["spaces"]] } },
      { id: "p2", question: "?", expect: { kind: "answer", terms: [["dark"]] } },
      { id: "p3", question: "?", expect: { kind: "answer", terms: [["abend*"]] } },
      { id: "p4", question: "?", expect: { kind: "answer", terms: [["spaces", "Leerzeichen"]] } },
      { id: "p5", question: "?", expect: { kind: "answer", terms: [["nothing here"]] } },
    ],
  });
  const keysOf = (probe) => traceWanted(twoFacts, probe).map((item) => item.label);

  it("links a term probe to a truth by the scorer's own matcher: its wording, its prefix mark", () => {
    // The failure this pins: raw `includes` linked none of these, so each got `needed: []`.
    expect(keysOf(twoFacts.probes[0])).toEqual(["spaces"]);
    // The failure this pins: the body of the unrelated `font` truth also contains "dark", so it was
    // linked too and a stage class was counted for a fact the probe never needed.
    expect(keysOf(twoFacts.probes[1])).toEqual(["theme"]);
    expect(keysOf(twoFacts.probes[2])).toEqual(["evening"]);
    expect(keysOf(twoFacts.probes[3])).toEqual(["spaces"]);
    expect(keysOf(twoFacts.probes[4])).toEqual([]);
  });

  it("links a truth only when its terms carry every group of the probe's requirement", () => {
    const two = { id: "g", question: "?", expect: { kind: "answer", terms: [["dark"], ["font"]] } };
    // `theme` carries "dark" but not "font", `font` carries "font" but not "dark": neither carries both.
    expect(keysOf(two)).toEqual([]);
    const both = validateScenario({
      ...twoFacts,
      truth: [fact("pair", "Dark terminal font.", [["dark terminal font"]])],
      probes: [two],
    });
    expect(traceWanted(both, two).map((item) => item.label)).toEqual(["pair"]);
  });

  it("finds a fact for every answer probe of the shipped corpora", () => {
    const root = labRoot();
    const without = [];
    for (const name of ["scenarios", "scenarios-next", "scenarios-explicit"])
      for (const scenario of loadScenarioDirectory(join(root, name)))
        for (const probe of scenario.probes)
          if (probe.expect.kind === "answer" && traceWanted(scenario, probe).length === 0)
            without.push(`${name}/${scenario.id}:${probe.id}`);
    expect(without).toEqual([]);
  });
});
