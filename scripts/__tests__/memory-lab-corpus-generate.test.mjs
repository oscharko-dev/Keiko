// Generator of the MemoriaViva corpus (#4208): a blueprint becomes a scenario of a stated size whose
// every truth fact is proven present, deterministically for a seed. The failure-first tests show that
// a writer or a scenario that loses, alters or leaks a fact is rejected with a CorpusError.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { validateBlueprint } from "../testing/memory-lab/corpus/blueprint.mjs";
import {
  CorpusError,
  checkGeneratorLabel,
  generateScenario,
} from "../testing/memory-lab/corpus/generate.mjs";
import { anyTermVisible, deriveOracle } from "../testing/memory-lab/corpus/oracle.mjs";
import {
  HARDNESS_KINDS,
  buildUnits,
  hardnessCounts,
  placeUnits,
} from "../testing/memory-lab/corpus/plan.mjs";
import { createRandom, deriveSeed } from "../testing/memory-lab/corpus/random.mjs";
import { forgetCommand } from "../testing/memory-lab/corpus/realize.mjs";
import { createCleanTester } from "../testing/memory-lab/corpus/realize.mjs";
import { mapSequential } from "../testing/memory-lab/corpus/sequence.mjs";
import { verifyScenario } from "../testing/memory-lab/corpus/verify.mjs";
import { FACT_MARKER } from "../testing/memory-lab/corpus/writer-port.mjs";
import { createScriptedWriter } from "../testing/memory-lab/corpus/writer-scripted.mjs";
import {
  loadScenarioDirectory,
  scenarioDigest,
  validateScenario,
} from "../testing/memory-lab/scenario.mjs";
import { scoreProbe, scoreStore } from "../testing/memory-lab/score.mjs";
import { curatedBlueprints, fixtureBlueprint } from "./support/memory-lab-corpus-fixture.mjs";

const SIZE = 100;

async function generate(overrides = {}, blueprint = fixtureBlueprint()) {
  return generateScenario(validateBlueprint(blueprint), {
    size: SIZE,
    seed: 7,
    writer: createScriptedWriter(),
    ...overrides,
  });
}

function faultyWriter(overrides) {
  return { ...createScriptedWriter(), id: "faulty", ...overrides };
}

describe("seeded random source", () => {
  it("repeats for a seed, differs between seeds and stays in range", () => {
    const first = createRandom(42);
    const second = createRandom(42);
    const draws = Array.from({ length: 50 }, () => first.next());
    expect(Array.from({ length: 50 }, () => second.next())).toEqual(draws);
    expect(draws.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(createRandom(43).next()).not.toBe(draws[0]);
    const random = createRandom(5);
    const ints = Array.from({ length: 200 }, () => random.int(3, 6));
    expect(new Set(ints)).toEqual(new Set([3, 4, 5, 6]));
  });

  it("shuffles into a permutation without touching the input and picks from a list", () => {
    const random = createRandom(9);
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = random.shuffle(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(shuffled.toSorted((left, right) => left - right)).toEqual(input);
    expect(input).toContain(random.pick(input));
    expect(() => random.pick([])).toThrow(RangeError);
    expect(() => createRandom(-1)).toThrow(RangeError);
    expect(() => createRandom(1.5)).toThrow(RangeError);
  });

  it("derives a distinct 32-bit seed from every set of parts", () => {
    const seeds = new Set([
      deriveSeed(1, "a", 100),
      deriveSeed(1, "a", 1000),
      deriveSeed(1, "b", 100),
      deriveSeed(2, "a", 100),
    ]);
    expect(seeds.size).toBe(4);
    for (const seed of seeds) expect(seed).toBeLessThan(2 ** 32);
    expect(deriveSeed(1, "a", 100)).toBe(deriveSeed(1, "a", 100));
  });
});

describe("sequential mapping", () => {
  it("runs one operation after another and keeps the order of the results", async () => {
    let running = 0;
    let overlap = 0;
    const results = await mapSequential([3, 1, 2], async (item, index) => {
      running += 1;
      overlap = Math.max(overlap, running);
      await delay(item);
      running -= 1;
      return `${String(index)}:${String(item)}`;
    });
    expect(results).toEqual(["0:3", "1:1", "2:2"]);
    expect(overlap).toBe(1);
  });
});

describe("conversation plan", () => {
  const blueprint = validateBlueprint(fixtureBlueprint());

  function planFor(seed, turnCount = 50) {
    const random = createRandom(seed);
    const units = buildUnits(blueprint, random);
    return { units, ...placeUnits(units, turnCount, random) };
  }

  it("covers all four hardness kinds and keeps the taught fact out of the plan", () => {
    const { units } = planFor(1);
    const counts = hardnessCounts(units);
    for (const kind of HARDNESS_KINDS) expect(counts[kind], kind).toBeGreaterThan(0);
    expect(units.filter((unit) => unit.kind === "fact").map((unit) => unit.fact.key)).not.toContain(
      "ranking-chart",
    );
    expect(units.filter((unit) => unit.kind === "trap")).toHaveLength(4);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("places every part once, in order, for seed %i", (seed) => {
    const { units, slots, starts } = planFor(seed);
    expect(slots[0]).toBeUndefined();
    for (const unit of units) {
      const start = starts.get(unit.id);
      for (let part = 0; part < unit.length; part += 1)
        expect(slots[start + part]).toEqual({ unit, part });
    }
    expect(slots.filter((slot) => slot !== undefined)).toHaveLength(
      units.reduce((sum, unit) => sum + unit.length, 0),
    );
    expect(starts.get("fact:number-format")).toBeLessThan(starts.get("change:number-format"));
    const forgetOrder = ["fact:walking-talks", "forget:walking-talks", "paraphrase:walking-talks"];
    const [factAt, forgetAt, paraphraseAt] = forgetOrder.map((id) => starts.get(id));
    expect(factAt).toBeLessThan(forgetAt);
    expect(forgetAt + 2).toBeLessThanOrEqual(paraphraseAt);
  });

  it("places a change and a forget near the position the blueprint names", () => {
    for (const seed of [1, 2, 3]) {
      const { starts } = planFor(seed, 200);
      expect(Math.abs(starts.get("change:number-format") / 200 - 0.5)).toBeLessThan(0.05);
      expect(Math.abs(starts.get("forget:walking-talks") / 200 - 0.4)).toBeLessThan(0.05);
    }
  });

  it("refuses a conversation that is too short for the blueprint", () => {
    expect(() => planFor(1, 8)).toThrow(CorpusError);
    expect(() => planFor(1, 8)).toThrow(/too few/u);
  });

  // A statement is told over two turns only where the blueprint holds the subject and the rule apart.
  const unsplit = () => {
    const raw = fixtureBlueprint();
    for (const owner of [...raw.facts, ...raw.changes]) delete owner.split;
    return validateBlueprint(raw);
  };

  it("never draws a split for a statement whose blueprint holds no split form", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const units = buildUnits(unsplit(), createRandom(seed));
      const counts = hardnessCounts(units);
      expect(counts.split, `seed ${String(seed)}`).toBe(0);
      expect(counts.plain + counts.embedded + counts.noisy).toBeGreaterThan(0);
    }
  });

  it("refuses to tell a statement over two turns when it has no split form", () => {
    expect(() => buildUnits(unsplit(), createRandom(1), { hardnessOf: () => "split" })).toThrow(
      /no split form/u,
    );
    const units = buildUnits(blueprint, createRandom(1), {
      hardnessOf: (unit) => (unit.kind === "fact" ? "split" : "plain"),
    });
    expect(
      units.filter((unit) => unit.hardness === "split").every((unit) => unit.length === 2),
    ).toBe(true);
  });

  it("places the questions of an entrenchment scenario between the fact and its correction", () => {
    const part = validateBlueprint({
      ...fixtureBlueprint(),
      facts: [fixtureBlueprint().facts[4]],
      changes: fixtureBlueprint().changes,
      forgets: [],
      traps: [],
      relational: [],
    });
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const random = createRandom(seed);
      const units = buildUnits(part, random, {
        hardnessOf: () => "plain",
        asks: true,
        edit: true,
      });
      const { starts } = placeUnits(units, 20, random);
      const asks = units.filter((unit) => unit.kind === "ask");
      expect(asks).toHaveLength(3);
      const order = [
        starts.get("fact:number-format"),
        ...asks.map((unit) => starts.get(unit.id)),
        starts.get("change:number-format"),
      ];
      expect(order, `seed ${String(seed)}`).toEqual(order.toSorted((left, right) => left - right));
      expect(new Set(order).size).toBe(5);
      expect(units.find((unit) => unit.kind === "change").edit).toBe(true);
    }
  });
});

describe("generated scenario", () => {
  it("is deterministic for a seed and differs for another seed or size", async () => {
    const first = await generate();
    const again = await generate();
    expect(scenarioDigest(again.scenario)).toBe(scenarioDigest(first.scenario));
    expect(again.meta).toEqual(first.meta);
    expect(again.designated).toEqual(first.designated);
    const other = await generate({ seed: 8 });
    expect(scenarioDigest(other.scenario)).not.toBe(scenarioDigest(first.scenario));
    const longer = await generate({ size: 200 });
    expect(longer.scenario.id).not.toBe(first.scenario.id);
  });

  it("is a valid scenario of format version 1 that survives a round trip through files", async () => {
    const { scenario } = await generate();
    expect(validateScenario(JSON.parse(JSON.stringify(scenario)))).toBeDefined();
    const directory = mkdtempSync(join(tmpdir(), "memory-lab-generate-"));
    try {
      writeFileSync(join(directory, `${scenario.id}.json`), JSON.stringify(scenario));
      const [loaded] = loadScenarioDirectory(directory);
      expect(scenarioDigest(loaded)).toBe(scenarioDigest(scenario));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(scenario.class).toBe("multi-turn");
    expect(scenario.language).toBe("en");
    expect(scenario.description).toMatch(/Generator scripted; seed 7; 100 messages in 50 turns/u);
    expect(scenario.description).toMatch(/hardness plain=\d embedded=\d split=\d noisy=\d/u);
  });

  it.each([60, 100, 1000, 10000])(
    "honours a size of %i messages within five percent",
    async (size) => {
      const { scenario, meta } = await generate({ size });
      expect(Math.abs(scenario.turns.length * 2 - size)).toBeLessThanOrEqual(size * 0.05);
      expect(meta.messages).toBe(scenario.turns.length * 2);
      expect(
        scenario.turns.every((turn) => turn.user.length > 0 && turn.assistant.length > 0),
      ).toBe(true);
    },
    60000,
  );

  it("states the facts in all four ways", async () => {
    const { scenario, designated, meta } = await generate();
    for (const kind of HARDNESS_KINDS) expect(meta.hardness[kind], kind).toBeGreaterThan(0);
    expect(scenario.difficulty).toBe("noisy");
    const sentences = (text) => text.split(/(?<=[.!?])\s+/u).length;
    const facts = designated.filter((entry) => entry.kind === "fact" || entry.kind === "change");
    const lengths = facts.map((entry) => sentences(scenario.turns[entry.turn].user));
    expect(lengths.some((count) => count === 1)).toBe(true);
    expect(lengths.some((count) => count >= 3 && count <= 5)).toBe(true);
    expect(designated.some((entry) => entry.kind === "lead")).toBe(true);
  });

  it("tells a split statement over two turns: the subject first, the rule alone after it", async () => {
    const blueprint = validateBlueprint(fixtureBlueprint());
    const { scenario, designated } = await generate();
    const leads = designated.filter((entry) => entry.kind === "lead");
    expect(leads.length).toBeGreaterThan(0);
    for (const lead of leads) {
      const rule = designated.find((entry) => entry.turn === lead.turn + 1);
      const owner =
        blueprint.changes.find((change) => change.key === lead.key && rule.kind === "change") ??
        blueprint.facts.find((fact) => fact.key === lead.key);
      expect(lead.text, lead.key).toBe(owner.split.lead);
      expect(rule.key, lead.key).toBe(lead.key);
      expect(rule.text, lead.key).toBe(owner.split.rule);
      expect(scenario.turns[lead.turn].user).toBe(lead.text);
      expect(scenario.turns[lead.turn].learner).toBeUndefined();
      expect(scenario.turns[rule.turn].user).toBe(rule.text);
      expect(scenario.turns[rule.turn].learner.map((item) => item.body)).toEqual([rule.text]);
    }
  });

  it("leaves the subject out of the rule a split learner stores, and the scorer still finds the fact", async () => {
    const { scenario, designated } = await generate();
    const rules = designated.filter(
      (entry) =>
        scenario.turns[entry.turn - 1] !== undefined &&
        designated.some((lead) => lead.kind === "lead" && lead.turn === entry.turn - 1),
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const memory = { id: "m", status: "accepted", body: rule.text, scope: { kind: "user" } };
      const verdict = scoreStore([memory], scenario).verdicts[0];
      const truth = scenario.truth.some((fact) => fact.key === rule.key);
      expect(verdict.verdict, rule.text).toBe(truth ? "correct" : verdict.verdict);
      if (truth) expect(verdict.key).toBe(rule.key);
    }
    const subjectWords = {
      "chart-type": /anything that changes over time/u,
      "report-structure": /\ba report\b/u,
    };
    for (const rule of rules)
      if (subjectWords[rule.key] !== undefined)
        expect(rule.text, rule.key).not.toMatch(subjectWords[rule.key]);
  });

  it("lets a forget follow its restatement at once and the paraphrase come later", async () => {
    const { scenario, designated } = await generate();
    const of = (kind) =>
      designated.find((entry) => entry.kind === kind && entry.key === "walking-talks");
    expect(of("forget").turn).toBe(of("restate").turn + 1);
    expect(scenario.turns[of("forget").turn].user).toBe("Forget that.");
    expect(of("fact").turn).toBeLessThan(of("restate").turn);
    expect(of("paraphrase").turn).toBeGreaterThan(of("forget").turn + 1);
    expect(scenario.turns[of("restate").turn].learner).toBeUndefined();
    expect(scenario.turns[of("paraphrase").turn].learner).toEqual([
      { body: of("paraphrase").text, type: "preference" },
    ]);
  });

  it("writes the German forget command in a German conversation", async () => {
    const german = curatedBlueprints().find((blueprint) => blueprint.language === "de");
    const { scenario, designated } = await generate({}, german);
    const command = designated.find((entry) => entry.kind === "forget");
    expect(scenario.turns[command.turn].user).toBe("Vergiss das.");
  });

  it("gives a correct learner exactly the sentences a product could extract", async () => {
    const { scenario, designated } = await generate();
    const bodies = scenario.turns.flatMap((turn) => (turn.learner ?? []).map((item) => item.body));
    const rules = new Map(
      designated
        .filter((entry) =>
          designated.some((lead) => lead.kind === "lead" && lead.turn === entry.turn - 1),
        )
        .map((entry) => [entry.key, entry.text]),
    );
    for (const fact of scenario.truth)
      expect(bodies, fact.key).toContain(rules.get(fact.key) ?? fact.seed);
    const types = new Set(
      scenario.turns.flatMap((turn) => (turn.learner ?? []).map((item) => item.type)),
    );
    expect([...types].toSorted()).toEqual(["decision", "identity", "preference", "procedural"]);
    for (const [index, turn] of scenario.turns.entries()) {
      const taught = designated.some((entry) => entry.kind === "taught" && entry.turn === index);
      for (const item of turn.learner ?? [])
        expect(taught || turn.user.includes(item.body), `turn ${String(index)}`).toBe(true);
    }
    expect(
      designated.some(
        (entry) => entry.kind === "taught" && scenario.turns[entry.turn].learner?.length === 1,
      ),
    ).toBe(true);
  });

  it("keeps filler and assistant text free of every fact, value and memory command", async () => {
    const { scenario, designated } = await generate({ size: 1000 });
    const isClean = createCleanTester(deriveOracle(validateBlueprint(fixtureBlueprint())));
    const owned = new Map(designated.map((entry) => [entry.turn, entry.text]));
    for (const [index, turn] of scenario.turns.entries()) {
      const rest = owned.has(index) ? turn.user.replace(owned.get(index), " ") : turn.user;
      expect(isClean(rest), `turn ${String(index)}`).toBe(true);
      expect(isClean(turn.assistant), `assistant ${String(index)}`).toBe(true);
    }
  });
});

describe("derived probes", () => {
  it("derives the stated probe kinds from the facts", async () => {
    const { scenario } = await generate();
    const byId = new Map(scenario.probes.map((probe) => [probe.id, probe]));
    const fixture = fixtureBlueprint();
    const chart = fixture.facts[0];
    expect(byId.get("chart-type-related").expect).toEqual({ kind: "answer", terms: chart.terms });
    expect(byId.get("chart-type-related-no-overlap").question).toBe(chart.applyQuestion);
    expect(byId.get("chart-type-related-no-overlap").expect).toEqual({
      kind: "answer",
      terms: chart.terms,
    });
    expect(byId.get("number-format-after-change-related").expect).toEqual({
      kind: "answer",
      terms: [["two decimal"]],
      forbidden: [["one decimal"]],
    });
    expect(byId.get("number-format-after-change-related-no-overlap").expect.forbidden).toEqual([
      ["one decimal"],
    ]);
    expect(byId.get("walking-talks-forgotten").expect).toEqual({ kind: "abstain" });
    expect(byId.has("walking-talks-related")).toBe(false);
    expect(byId.get("trap-1-credential").expect.kind).toBe("abstain");
    expect(byId.get("trap-2-third-party").expect.kind).toBe("abstain");
    expect(byId.get("trap-3-third-party").expect.kind).toBe("abstain");
    expect(byId.get("trap-4-instruction").expect.kind).toBe("no-memory");
    expect(byId.get("relational-1").expect).toEqual({
      kind: "answer",
      terms: [["audits", "audit"]],
    });
    expect(byId.get("unknown").expect.kind).toBe("abstain");
    expect(byId.get("unrelated").expect.kind).toBe("no-memory");
    expect(byId.get("ranking-chart-related")).toBeDefined();
  });

  it("asks the blueprint's own recall question when it has one, and the blanked sentence otherwise", async () => {
    const own = fixtureBlueprint();
    own.facts[0].recallQuestion = "Which charts do I like for trends?";
    own.facts[4].recallQuestion = "How many places do I want after the decimal point?";
    own.facts[5].recallQuestion = "How do I like to go through findings with others?";
    const { scenario } = await generate({}, own);
    const byId = new Map(scenario.probes.map((probe) => [probe.id, probe]));
    expect(byId.get("chart-type-related").question).toBe("Which charts do I like for trends?");
    expect(byId.get("chart-type-related").expect).toEqual({
      kind: "answer",
      terms: [["line charts"]],
    });
    // A changed fact is asked the same question, with the new terms expected and the old forbidden.
    expect(byId.get("number-format-after-change-related").question).toBe(
      "How many places do I want after the decimal point?",
    );
    expect(byId.get("number-format-after-change-related").expect).toEqual({
      kind: "answer",
      terms: [["two decimal"]],
      forbidden: [["one decimal"]],
    });
    expect(byId.get("walking-talks-forgotten").question).toBe(
      "How do I like to go through findings with others?",
    );
    expect(byId.get("report-structure-related").question).toMatch(/^Fill in the gap/u);
  });

  it("never gives the answer away in a recall question", async () => {
    const { scenario } = await generate();
    const oracle = deriveOracle(validateBlueprint(fixtureBlueprint()));
    for (const fact of oracle.truth) {
      const related = scenario.probes.find(
        (probe) =>
          probe.id.endsWith(`${fact.key}-related`) ||
          probe.id.includes(`${fact.key}-after-change-related`),
      );
      expect(related, fact.key).toBeDefined();
      expect(anyTermVisible(related.question, fact.terms), fact.key).toBe(false);
    }
  });

  it("scores a perfect answer, an abstention and an empty context as passes", async () => {
    const { scenario } = await generate();
    for (const probe of scenario.probes) {
      const answer =
        probe.expect.kind === "answer"
          ? probe.expect.terms.map((group) => group[0]).join(" ")
          : "Ich weiss es nicht.";
      const supplied = probe.expect.kind === "answer" ? [{ bodyExcerpt: answer }] : [];
      expect(scoreProbe(scenario, probe, answer, supplied).passed, probe.id).toBe(true);
    }
  });
});

describe("failure-first: a conversation that lost a fact is rejected", () => {
  const base = createScriptedWriter();

  it("rejects a writer that drops the fact marker from a paragraph", async () => {
    const writer = faultyWriter({
      paragraph: async (request) => (await base.paragraph(request)).replace(FACT_MARKER, ""),
    });
    await expect(generate({ writer })).rejects.toThrow(CorpusError);
    await expect(generate({ writer })).rejects.toThrow(/fact marker 0 times/u);
  });

  it("rejects a writer that alters the marker or repeats it", async () => {
    const altering = faultyWriter({
      paragraph: async (request) =>
        (await base.paragraph(request)).replace(FACT_MARKER, "[[FAKT]]"),
    });
    await expect(generate({ writer: altering })).rejects.toThrow(/fact marker 0 times/u);
    const repeating = faultyWriter({
      paragraph: async (request) =>
        (await base.paragraph(request)).replace(FACT_MARKER, `${FACT_MARKER} ${FACT_MARKER}`),
    });
    await expect(generate({ writer: repeating })).rejects.toThrow(/fact marker 2 times/u);
  });

  it("accepts the same writer when it keeps the marker", async () => {
    const writer = faultyWriter({
      paragraph: async (request) =>
        (await base.paragraph(request)).replace(FACT_MARKER, FACT_MARKER),
    });
    await expect(generate({ writer })).resolves.toBeDefined();
  });

  it.each([
    [
      "states a fact in filler",
      { user: "I prefer line charts for my reports.", assistant: "Understood." },
      /states a fact/u,
    ],
    [
      "holds an account number",
      { user: "Please check DE89 3704 0044 0532 0130 00 today.", assistant: "Understood." },
      /states a fact, a value or a memory command/u,
    ],
    [
      "opens with a forget command",
      { user: "Forget that. Anything else?", assistant: "Understood." },
      /memory command/u,
    ],
    [
      "repeats a fact in the assistant reply",
      { user: "Can you help me today?", assistant: "Sure, as a senior analyst you can start now." },
      /states a fact/u,
    ],
  ])("rejects filler that %s", async (_name, exchange, pattern) => {
    const writer = faultyWriter({
      exchanges: async (request) => Array.from({ length: request.count }, () => exchange),
    });
    await expect(generate({ writer })).rejects.toThrow(pattern);
  });

  it("rejects a writer that returns the wrong number or the wrong shape of exchanges", async () => {
    const short = faultyWriter({
      exchanges: async (request) => (await base.exchanges(request)).slice(1),
    });
    await expect(generate({ writer: short })).rejects.toThrow(/expected \d+ exchanges/u);
    const text = faultyWriter({ sentence: async () => 42 });
    await expect(generate({ writer: text })).rejects.toThrow(/is not text/u);
  });

  describe("verification of a finished scenario", () => {
    async function finished() {
      const result = await generate({ size: 200 });
      const blueprint = validateBlueprint(fixtureBlueprint());
      return {
        blueprint,
        scenario: structuredClone(result.scenario),
        designated: structuredClone(result.designated),
        isClean: createCleanTester(deriveOracle(blueprint)),
      };
    }

    async function check(change) {
      const parts = await finished();
      change(parts);
      return () => verifyScenario({ ...parts, size: 200 });
    }

    it("passes an untouched scenario", async () => {
      const verify = await check(() => undefined);
      expect(verify).not.toThrow();
    });

    it.each([
      [
        "a dropped seed sentence",
        ({ scenario, designated }) => {
          const entry = designated.find((candidate) => candidate.kind === "fact");
          scenario.turns[entry.turn].user = "Can you explain the minutes to me once more?";
        },
        /not verbatim/u,
      ],
      [
        "a seed altered by one character",
        ({ scenario, designated }) => {
          const entry = designated.find((candidate) => candidate.kind === "fact");
          scenario.turns[entry.turn].user = scenario.turns[entry.turn].user.replace("I ", "We ");
        },
        /not verbatim/u,
      ],
      [
        "an altered trap",
        ({ scenario, designated }) => {
          const entry = designated.find((candidate) => candidate.kind === "trap");
          scenario.turns[entry.turn].user = scenario.turns[entry.turn].user.replace("Ms.", "Mrs.");
        },
        /not verbatim/u,
      ],
      [
        "a sentence the conversation never carried",
        ({ designated }) => {
          const at = designated.findIndex((candidate) => candidate.kind === "change");
          designated.splice(at, 1);
        },
        /lost the change sentence/u,
      ],
      [
        "a forget command that is missing",
        ({ designated }) => {
          const at = designated.findIndex((candidate) => candidate.kind === "forget");
          designated.splice(at, 1);
        },
        /lost the forget sentence/u,
      ],
      [
        "a change before its fact",
        ({ designated }) => {
          const fact = designated.find(
            (entry) => entry.kind === "fact" && entry.key === "number-format",
          );
          const change = designated.find((entry) => entry.kind === "change");
          [fact.turn, change.turn] = [change.turn, fact.turn];
        },
        /not verbatim|comes before the fact/u,
      ],
      [
        "a learner body that is not in its turn",
        ({ scenario }) => {
          const turn = scenario.turns.find((candidate) => candidate.learner !== undefined);
          turn.learner[0].body = "I prefer something else entirely.";
        },
        /learner item|no turn teaches/u,
      ],
      [
        "a truth fact no turn teaches",
        ({ scenario }) => {
          for (const turn of scenario.turns) delete turn.learner;
        },
        /no turn teaches/u,
      ],
      [
        "a paraphrase no learner extracts",
        ({ scenario, designated }) => {
          const entry = designated.find((candidate) => candidate.kind === "paraphrase");
          delete scenario.turns[entry.turn].learner;
        },
        /paraphrase of walking-talks carries no learner item/u,
      ],
      [
        "a split rule whose learner extracts more than the rule",
        ({ scenario, designated }) => {
          const lead = designated.find((candidate) => candidate.kind === "lead");
          const learner = scenario.turns[lead.turn + 1].learner;
          learner.push({ ...learner[0] });
        },
        /does not extract its rule alone/u,
      ],
      [
        "a split rule that no lead introduces",
        ({ designated }) => {
          const at = designated.findIndex((candidate) => candidate.kind === "lead");
          designated.splice(at, 1);
        },
        /does not follow its lead/u,
      ],
      [
        "a fact leaked into filler",
        ({ scenario, designated }) => {
          const owned = new Set(designated.map((entry) => entry.turn));
          const at = scenario.turns.findIndex((_, index) => !owned.has(index));
          scenario.turns[at].user = "As a senior analyst I have a question.";
        },
        /states a fact/u,
      ],
      [
        "a value outside the grammar in an assistant reply",
        ({ scenario }) => {
          scenario.turns[1].assistant = "Write to someone@example.com soon.";
        },
        /states a fact, a value or a memory command/u,
      ],
      [
        "a turn missing",
        ({ scenario }) => {
          scenario.turns.splice(5, 20);
        },
        /messages, not about 200/u,
      ],
    ])("rejects %s", async (_name, change, pattern) => {
      const verify = await check(change);
      expect(verify).toThrow(CorpusError);
      expect(verify).toThrow(pattern);
    });
  });
});

describe("generator settings", () => {
  it.each([
    [{ size: 4 }, RangeError, /size must be an integer of at least 10/u],
    [{ size: 100.5 }, RangeError, /size must be an integer/u],
    [{ seed: -1 }, RangeError, /seed must be an integer/u],
    [{ writer: { id: "x" } }, TypeError, /needs an id and the methods/u],
    [{ writer: undefined }, TypeError, /needs an id and the methods/u],
    [{ generatorLabel: "bad\nlabel" }, RangeError, /generator label/u],
  ])("refuses %j", async (overrides, type, pattern) => {
    await expect(generate(overrides)).rejects.toThrow(type);
    await expect(generate(overrides)).rejects.toThrow(pattern);
  });

  it("records a custom generator label and refuses an implausible one", async () => {
    const { scenario, meta } = await generate({ generatorLabel: "gemma-4-31b-it" });
    expect(scenario.description).toContain("Generator gemma-4-31b-it;");
    expect(meta.generator).toBe("gemma-4-31b-it");
    expect(checkGeneratorLabel("scripted")).toBe("scripted");
    expect(() => checkGeneratorLabel("")).toThrow(RangeError);
    expect(() => checkGeneratorLabel("x".repeat(81))).toThrow(RangeError);
  });

  it("grows a size too small for the blueprint to the smallest conversation that holds every part", async () => {
    // The failure this pins: a person with more parts than the turns could hold was refused, so a
    // blueprint with the breadth the corpus needs could not be built at the small sizes at all.
    const { scenario, meta } = await generate({ size: 20 });
    expect(meta.size).toBe(20);
    expect(meta.messages).toBeGreaterThan(20);
    expect(meta.messages).toBe(scenario.turns.length * 2);
    const again = await generate({ size: 20 });
    expect(JSON.stringify(again.scenario)).toBe(JSON.stringify(scenario));
    // A size that holds every part is kept as requested.
    expect((await generate({ size: SIZE })).meta.messages).toBe(SIZE);
  });
});

describe("curated blueprints", () => {
  const blueprints = curatedBlueprints();

  it.each(blueprints.map((blueprint) => [blueprint.id, blueprint]))(
    "%s generates at 100 messages with every hardness kind and a perfect oracle",
    async (_id, blueprint) => {
      const { scenario, meta } = await generate({ writer: createScriptedWriter() }, blueprint);
      // At least the requested 100 messages; a person with more parts than 50 turns hold grows.
      expect(scenario.turns.length).toBeGreaterThanOrEqual(50);
      for (const kind of HARDNESS_KINDS) expect(meta.hardness[kind], kind).toBeGreaterThan(0);
      expect(scenario.probes.length).toBeGreaterThanOrEqual(30);
      expect(scenario.truth).toHaveLength(blueprint.facts.length - blueprint.forgets.length);
      const thirdParty = blueprint.traps.filter((trap) => trap.class === "third-party");
      expect(thirdParty.length).toBeGreaterThan(0);
      expect(scenario.forbidden).toHaveLength(blueprint.traps.length + thirdParty.length);
      expect(scenario.superseded).toHaveLength(blueprint.changes.length);
      expect(scenario.forgotten).toHaveLength(blueprint.forgets.length);
    },
  );

  it("builds the same set again byte for byte", async () => {
    const digests = async () =>
      mapSequential(blueprints, async (blueprint) =>
        scenarioDigest((await generate({}, blueprint)).scenario),
      );
    expect(await digests()).toEqual(await digests());
  });

  it("scales to 1,000 and 10,000 messages within five percent", async () => {
    for (const size of [1000, 10000]) {
      const { scenario } = await generate({ size }, blueprints[0]);
      expect(Math.abs(scenario.turns.length * 2 - size)).toBeLessThanOrEqual(size * 0.05);
    }
  }, 60000);
});

describe("oracle derived from a blueprint", () => {
  const oracle = deriveOracle(validateBlueprint(fixtureBlueprint()));

  it("keeps the truth of the end state: a change replaces its fact and a forgotten fact leaves", () => {
    const keys = oracle.truth.map((fact) => fact.key);
    expect(keys).toEqual([
      "chart-type",
      "report-structure",
      "analyst-role",
      "data-source",
      "number-format",
      "ranking-chart",
    ]);
    const changed = oracle.truth.find((fact) => fact.key === "number-format");
    expect(changed).toMatchObject({
      seed: "Please show me two decimal places from now on.",
      terms: [["two decimal"]],
    });
    const decision = oracle.truth.find((fact) => fact.key === "data-source");
    expect(decision.seed).toBe(
      "I decided to rely on the warehouse extract rather than live queries, because the extract is reproducible for audits.",
    );
  });

  it("turns the old value into a superseded fact, the forgotten fact into a forgotten one and every trap into forbidden content", () => {
    expect(oracle.superseded).toEqual([{ terms: [["one decimal"]] }]);
    expect(oracle.forgotten).toEqual([{ terms: [["walk", "walking"]] }]);
    expect(oracle.forbidden.map((entry) => entry.class)).toEqual([
      "credential",
      "third-party",
      "third-party",
      "third-party",
      "third-party",
      "instruction",
    ]);
    expect(oracle.forbidden[2]).toEqual({
      class: "third-party",
      terms: [["manager", "starts"], ["six in the morning"]],
    });
  });

  it("speaks German and English forget commands", () => {
    expect(forgetCommand("de")).toBe("Vergiss das.");
    expect(forgetCommand("en")).toBe("Forget that.");
  });
});

describe("scripted writer", () => {
  const writer = createScriptedWriter();
  const request = (extra) => ({
    language: "en",
    role: "analyst",
    random: createRandom(1),
    isClean: () => true,
    ...extra,
  });

  it("writes paragraphs of three to five sentences with the marker exactly once", async () => {
    const random = createRandom(2);
    for (const hardness of ["embedded", "noisy"])
      for (const language of ["de", "en"])
        for (let draw = 0; draw < 40; draw += 1) {
          const text = await writer.paragraph(request({ hardness, language, random }));
          expect(text.split(FACT_MARKER)).toHaveLength(2);
          const sentences = text.replace(FACT_MARKER, "Marker.").split(/(?<=[.!?])\s+/u);
          expect(sentences.length, text).toBeGreaterThanOrEqual(3);
          expect(sentences.length, text).toBeLessThanOrEqual(5);
        }
  });

  it("writes the same text for the same random source and role-specific filler", async () => {
    const first = await writer.exchanges(request({ count: 5, random: createRandom(9) }));
    const again = await writer.exchanges(request({ count: 5, random: createRandom(9) }));
    expect(again).toEqual(first);
    const developer = await writer.exchanges(request({ count: 200, role: "developer" }));
    expect(
      developer.some((exchange) => /pull request|schema|stack trace/u.test(exchange.user)),
    ).toBe(true);
    const unknownRole = await writer.exchanges(request({ count: 3, role: "astronaut" }));
    expect(unknownRole).toHaveLength(3);
  });

  it("refuses a language without a pool, a sentence of an unknown kind and an exhausted pool", async () => {
    await expect(writer.sentence(request({ language: "fr", kind: "ack" }))).rejects.toThrow(
      /no pool for fr/u,
    );
    await expect(writer.sentence(request({ kind: "poem" }))).rejects.toThrow(/cannot write poem/u);
    // The subject of a split statement is the blueprint's own lead, never the writer's.
    await expect(writer.sentence(request({ kind: "lead" }))).rejects.toThrow(/cannot write lead/u);
    await expect(writer.exchanges(request({ count: 1, isClean: () => false }))).rejects.toThrow(
      /found no clean exchange/u,
    );
  });
});
