// The driver against a fake product: the oracle arm's seeding by the id the capture route returns,
// its precondition, and the rule that anchor text keeps no body. The fake keeps its memories in a
// list, newest first, like the real list route, and records every call it receives.
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { askedQuestion, runScenario } from "../testing/memory-lab/driver.mjs";
import { validateScenario } from "../testing/memory-lab/scenario.mjs";

const TABLES = "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst.";
const SPACES = "Ich nutze zwei Leerzeichen zum Einruecken.";

function scenario(overrides = {}) {
  return validateScenario({
    schemaVersion: 1,
    id: "driver-fixture-de",
    language: "de",
    class: "preference",
    difficulty: "plain",
    description: "Driver fixture.",
    truth: [
      { key: "format", seed: TABLES, must: true, private: true, terms: [["Tabellen"]] },
      { key: "indent", seed: SPACES, must: true, private: true, terms: [["Leerzeichen"]] },
    ],
    turns: [{ user: TABLES }],
    probes: [
      { id: "related", question: "Wie?", expect: { kind: "answer", terms: [["Tabellen"]] } },
    ],
    ...overrides,
  });
}

/**
 * @param {object} options
 * @param {(text: string) => (object | undefined)} [options.capture] decides what the capture route
 *   does with a seed: undefined stores one candidate; `{outcomes}` is returned as is, nothing stored.
 */
function fakeProduct({ stored = [], capture, status = "accepted", scope = "project", edit } = {}) {
  const memories = stored.map((memory) => ({ scope: { kind: "user" }, ...memory }));
  const calls = [];
  let counter = 0;
  const find = (id) => memories.find((memory) => memory.id === id);
  const routes = {
    "POST /api/projects": () => ({}),
    "POST /api/chats": () => ({ chat: { id: `chat-${String(counter++)}` } }),
    "POST /api/memory/capture-from-conversation": (body) => {
      const seed = body.text.replace(/^Merke dir /u, "");
      const custom = capture?.(seed);
      if (custom !== undefined) return custom;
      const record = {
        id: `m-${String(counter++)}`,
        body: edit === undefined ? seed : edit(seed),
        status,
        scope: { kind: scope },
      };
      memories.unshift(record);
      return {
        outcomes: [
          { kind: "candidate", proposal: { proposalId: record.id, body: record.body }, status },
        ],
      };
    },
    "POST /api/desktop/chat": (body) => {
      const supplied = body.memory?.enabled
        ? memories
            .filter((memory) => memory.status === "accepted")
            .map((memory) => ({ memoryId: memory.id, bodyExcerpt: memory.body }))
        : [];
      return {
        messages: [
          { role: "assistant", content: supplied.map((entry) => entry.bodyExcerpt).join(" ") },
        ],
        memory: { actions: [], context: { memories: supplied } },
      };
    },
  };
  const request = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    const url = new URL(path, "http://127.0.0.1");
    const direct = routes[`${method} ${url.pathname}`];
    if (direct !== undefined) return { status: 200, json: direct(body) };
    const accept = /^\/api\/memory\/proposals\/([^/]+)\/accept$/u.exec(url.pathname);
    if (method === "POST" && accept !== null) {
      find(accept[1]).status = "accepted";
      return { status: 200, json: { memory: find(accept[1]) } };
    }
    const single = /^\/api\/memory\/([^/]+)$/u.exec(url.pathname);
    if (single !== null && method === "GET")
      return { status: 200, json: { memory: find(single[1]) } };
    if (single !== null && method === "PATCH") {
      find(single[1]).body = body.body.trim();
      return { status: 200, json: { memory: find(single[1]) } };
    }
    if (url.searchParams.has("since")) return { status: 200, json: { captures: [], total: 0 } };
    return { status: 200, json: { memories: [...memories], total: memories.length } };
  };
  return { memories, calls, instance: { request, project: "/project", answerModelId: "model" } };
}

function context(overrides = {}) {
  return {
    arm: "oracle",
    memoryMode: "autonomous-delivery",
    budgetTokens: 1200,
    confirmForget: true,
    retainBodies: true,
    turnTimeoutMs: 5000,
    learning: { quietMs: 5, maxMs: 2000 },
    ...overrides,
  };
}

describe("the oracle arm's seeding", () => {
  it("seeds each truth fact by the id the capture route returns and meets its precondition", async () => {
    const product = fakeProduct();
    const result = await runScenario(scenario(), product.instance, context());
    expect(result.oracle.preconditionMet).toBe(true);
    expect(result.oracle.mismatches).toEqual([]);
    expect(result.oracle.extras).toBe(0);
    expect(result.oracle.seeded.map((seed) => [seed.key, seed.seeded, seed.scope])).toEqual([
      ["format", true, "project"],
      ["indent", true, "project"],
    ]);
    expect(result.oracle.seeded.map((seed) => seed.memoryId)).toEqual(
      product.memories.map((memory) => memory.id).toReversed(),
    );
    expect(result.oracle.scopes).toEqual({ project: 2 });
    expect(result.store.live).toBe(2);
  });

  it("never falls back to another stored memory when a seeding stored nothing", async () => {
    // The failure this pins: the list is newest first, so `memories.at(-1)` was the OLDEST memory,
    // and the body edit that followed overwrote it with the seed.
    const older = { id: "older", body: "Ein anderer Eintrag.", status: "accepted" };
    const product = fakeProduct({
      stored: [older],
      capture: (seed) =>
        seed === TABLES
          ? { outcomes: [{ kind: "rejected", reason: "denied-category" }] }
          : undefined,
    });
    const result = await runScenario(scenario(), product.instance, context());
    expect(product.memories.find((memory) => memory.id === "older").body).toBe(
      "Ein anderer Eintrag.",
    );
    expect(product.calls.filter((call) => call.startsWith("PATCH"))).toEqual([]);
    expect(result.oracle.seeded[0]).toMatchObject({
      key: "format",
      seeded: false,
      outcomes: ["rejected:denied-category"],
    });
    expect(result.oracle.mismatches).toEqual(["format"]);
    expect(result.oracle.extras).toBe(1);
    expect(result.oracle.preconditionMet).toBe(false);
  });

  it("does not guess when one seeding stored two memories", async () => {
    const product = fakeProduct({
      capture: () => ({
        outcomes: [
          { kind: "candidate", proposal: { proposalId: "x1" }, status: "accepted" },
          { kind: "candidate", proposal: { proposalId: "x2" }, status: "accepted" },
        ],
      }),
    });
    const result = await runScenario(scenario(), product.instance, context());
    expect(result.oracle.seeded.every((seed) => !seed.seeded)).toBe(true);
    expect(result.oracle.seeded[0].outcomes).toEqual(["candidate:-", "candidate:-"]);
    expect(result.oracle.preconditionMet).toBe(false);
    expect(product.calls.some((call) => call.includes("/accept") || call.startsWith("PATCH"))).toBe(
      false,
    );
  });

  it("accepts a parked seed by its id and makes its body exact", async () => {
    const product = fakeProduct({
      status: "proposed",
      edit: (seed) => seed.replace(/\.$/u, ""),
    });
    const result = await runScenario(scenario(), product.instance, context());
    expect(product.calls.filter((call) => call.includes("/accept"))).toHaveLength(2);
    expect(product.calls.filter((call) => call.startsWith("PATCH"))).toHaveLength(2);
    expect(product.memories.map((memory) => memory.body).toSorted()).toEqual(
      [SPACES, TABLES].toSorted(),
    );
    expect(result.oracle.preconditionMet).toBe(true);
  });

  it("fails the precondition when another memory is accepted beside the seeds", async () => {
    const product = fakeProduct({
      stored: [{ id: "extra", body: "Etwas Fremdes.", status: "accepted" }],
    });
    const result = await runScenario(scenario(), product.instance, context());
    expect(result.oracle.mismatches).toEqual([]);
    expect(result.oracle.extras).toBe(1);
    expect(result.oracle.preconditionMet).toBe(false);
  });

  it("fails the precondition when a seed is stored twice", async () => {
    const product = fakeProduct({
      stored: [{ id: "twin", body: TABLES, status: "accepted" }],
    });
    const result = await runScenario(scenario(), product.instance, context());
    expect(result.oracle.mismatches).toEqual(["format"]);
    expect(result.oracle.preconditionMet).toBe(false);
  });

  it("reports the scope each seed landed in, whatever it is", async () => {
    const product = fakeProduct({ scope: "user" });
    const result = await runScenario(scenario(), product.instance, context());
    expect(result.oracle.scopes).toEqual({ user: 2 });
    expect(result.store.counters["private-in-project"]).toBe(0);
    const project = await runScenario(
      scenario(),
      fakeProduct({ scope: "project" }).instance,
      context(),
    );
    expect(project.store.counters["private-in-project"]).toBe(2);
  });
});

describe("anchor text keeps no body", () => {
  const real = () =>
    scenario({
      id: "driver-real-de",
      class: "anchor-real",
      truth: [],
      probes: [{ id: "unrelated", question: "Was ist Kafka?", expect: { kind: "no-memory" } }],
    });

  it("drops the stored bodies, the answers and the journal's memory bodies of an anchor run", async () => {
    const product = fakeProduct();
    product.memories.push({
      id: "kept",
      body: TABLES,
      status: "accepted",
      scope: { kind: "user" },
    });
    const fixture = {
      setPhase: () => undefined,
      setAnswerMode: () => undefined,
      queueLearner: () => undefined,
      clearLearner: () => undefined,
      pendingLearner: () => 0,
      requests: () => [{ phase: "run", model: "m", memoryCount: 1, memoryBodies: [TABLES] }],
    };
    const result = await runScenario(
      real(),
      product.instance,
      context({ arm: "off", retainBodies: true, fixture }),
    );
    expect(result.store.memories).toHaveLength(1);
    expect(result.store.memories[0]).not.toHaveProperty("body");
    expect(result.probes.every((probe) => !("answer" in probe))).toBe(true);
    expect(result.requests).toEqual([{ phase: "run", model: "m", memoryCount: 1 }]);
    expect(JSON.stringify(result)).not.toContain("Tabellen");
  });

  it("keeps them in the labelling pass, which a person asks for by name", async () => {
    const product = fakeProduct();
    product.memories.push({
      id: "kept",
      body: TABLES,
      status: "accepted",
      scope: { kind: "user" },
    });
    const result = await runScenario(
      real(),
      product.instance,
      context({ arm: "off", retainBodies: true, labelPass: true }),
    );
    expect(result.store.memories[0].body).toBe(TABLES);
    expect(result.probes[0]).toHaveProperty("answer");
  });

  it("keeps them for a synthetic scenario, so the control can fail", async () => {
    const product = fakeProduct();
    product.memories.push({
      id: "kept",
      body: TABLES,
      status: "accepted",
      scope: { kind: "user" },
    });
    const result = await runScenario(
      scenario({
        truth: [],
        probes: [{ id: "p", question: "Wie?", expect: { kind: "no-memory" } }],
      }),
      product.instance,
      context({ arm: "off", retainBodies: true }),
    );
    expect(result.store.memories[0].body).toBe(TABLES);
    expect(result.probes[0]).toHaveProperty("answer");
  });
});

describe("the text a probe sends", () => {
  const probe = { id: "q", question: "How do I write reports?" };

  it("asks for English on an English probe, because the answer's default is German", () => {
    expect(askedQuestion({ language: "en" }, probe)).toBe("How do I write reports? (in English)");
    expect(askedQuestion({ language: "mixed" }, { ...probe, language: "en" })).toBe(
      "How do I write reports? (in English)",
    );
  });

  it("sends a German probe and a mixed probe without a language of its own as written", () => {
    expect(askedQuestion({ language: "de" }, probe)).toBe(probe.question);
    expect(askedQuestion({ language: "mixed" }, probe)).toBe(probe.question);
    expect(askedQuestion({ language: "mixed" }, { ...probe, language: "de" })).toBe(probe.question);
  });
});
