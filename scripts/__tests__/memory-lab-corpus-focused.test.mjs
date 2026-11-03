// Focused corpus of the MemoriaViva lab (#4208): one scenario per unit of a blueprint, each carrying
// the class the report groups by, so that a class result has a noise band. The tests cover the units a
// blueprint yields, the id grammar, the shape of every kind of scenario (including the corrections of
// an earlier message and the entrenchment loop), the coverage rule of thirty scenarios per class and
// language, and the build that writes the corpus.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateBlueprint } from "../testing/memory-lab/corpus/blueprint.mjs";
import { normalizeBuildOptions, runBuild } from "../testing/memory-lab/corpus/build.mjs";
import {
  MINIMUM_PER_CLASS_AND_LANGUAGE,
  REQUIRED_CLASSES,
  classCounts,
  coverageSection,
  shortfalls,
} from "../testing/memory-lab/corpus/coverage.mjs";
import { CorpusError } from "../testing/memory-lab/corpus/errors.mjs";
import {
  checkFocusedIdRoom,
  focusedHardnessKinds,
  focusedScenarioId,
  focusedUnits,
  generateFocusedScenario,
} from "../testing/memory-lab/corpus/focused.mjs";
import { mapSequential } from "../testing/memory-lab/corpus/sequence.mjs";
import { valueShapeFindings } from "../testing/memory-lab/corpus/values.mjs";
import { corpusVariety } from "../testing/memory-lab/corpus/variety-report.mjs";
import { createScriptedWriter } from "../testing/memory-lab/corpus/writer-scripted.mjs";
import { validateScenario } from "../testing/memory-lab/scenario.mjs";
import { curatedBlueprints, fixtureBlueprint } from "./support/memory-lab-corpus-fixture.mjs";

const quiet = () => undefined;
const SCENARIO_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const SEEDS = [1, 2, 3];
const SIZE = 40;

function validated(change = () => undefined) {
  const blueprint = fixtureBlueprint();
  change(blueprint);
  return validateBlueprint(blueprint);
}

function unitOf(blueprint, kind, unit) {
  const found = focusedUnits(blueprint).find((entry) => entry.kind === kind && entry.unit === unit);
  expect(found, `${kind} ${unit}`).toBeDefined();
  return found;
}

// Every unit of a blueprint with every way it is stated in, in a fixed order.
function statements(blueprint) {
  return focusedUnits(blueprint).flatMap((descriptor) =>
    focusedHardnessKinds(descriptor).map((hardness) => ({ blueprint, descriptor, hardness })),
  );
}

async function focused(blueprint, kind, unit, hardness, seed = 1) {
  return generateFocusedScenario(blueprint, unitOf(blueprint, kind, unit), hardness, {
    size: SIZE,
    seed,
    writer: createScriptedWriter(),
  });
}

describe("focused units", () => {
  it("yields one unit per fact, change, forget, trap and relational probe, each with its report class", () => {
    const rows = focusedUnits(validated()).map(
      (entry) => `${entry.kind}:${entry.unit}:${entry.scenarioClass}`,
    );
    expect(rows).toEqual([
      "fact:chart-type:preference",
      "fact:report-structure:way-of-working",
      "fact:analyst-role:role",
      "fact:data-source:decision",
      "fact:number-format:preference",
      "fact:walking-talks:preference",
      "fact:ranking-chart:preference",
      "update:number-format:update",
      "edit:number-format:edit-after-learn",
      "entrench:number-format:entrenchment",
      "forget:walking-talks:forget",
      "forget-paraphrase:walking-talks:forget-paraphrase",
      "trap:credential-1:credential",
      "trap:third-party-2:third-party",
      "taught:ranking-chart:third-party",
      "trap:instruction-4:instruction-smuggling",
      "relational:1:decision",
    ]);
  });

  it("adds a reversal scenario for a change that flips a two-way choice, and only then", () => {
    const flipped = validated((blueprint) => (blueprint.changes[0].reversal = true));
    const classes = focusedUnits(flipped).map((entry) => entry.scenarioClass);
    expect(classes.filter((name) => name === "update")).toHaveLength(1);
    expect(classes.filter((name) => name === "reversal")).toHaveLength(1);
    const plain = focusedUnits(validated()).map((entry) => entry.scenarioClass);
    expect(plain).not.toContain("reversal");
  });

  it("has no correction scenario for a change without a correction, and no scenario for a trap without a question", () => {
    const bare = validated((blueprint) => {
      delete blueprint.changes[0].correction;
      delete blueprint.traps[1].question;
      blueprint.traps[1].class = "quote";
    });
    const classes = focusedUnits(bare).map((entry) => entry.scenarioClass);
    expect(classes).not.toContain("edit-after-learn");
    expect(classes).not.toContain("entrenchment");
    expect(classes).toContain("update");
    expect(classes).not.toContain("quote");
  });

  it("states a unit in four ways only where its statement has a split form", () => {
    const blueprint = validated();
    const kindsOf = (kind, unit) => focusedHardnessKinds(unitOf(blueprint, kind, unit));
    expect(kindsOf("fact", "chart-type")).toEqual(["plain", "embedded", "split", "noisy"]);
    expect(kindsOf("update", "number-format")).toEqual(["plain", "embedded", "split", "noisy"]);
    expect(kindsOf("edit", "number-format")).toHaveLength(4);
    expect(kindsOf("entrench", "number-format")).toHaveLength(4);
    expect(kindsOf("relational", "1")).toHaveLength(4);
    // One sentence by nature: a trap and a paraphrase are never told over two turns.
    expect(kindsOf("trap", "credential-1")).toEqual(["plain", "embedded", "noisy"]);
    expect(kindsOf("taught", "ranking-chart")).toEqual(["plain", "embedded", "noisy"]);
    expect(kindsOf("forget-paraphrase", "walking-talks")).toEqual(["plain", "embedded", "noisy"]);
    const unsplit = validated((raw) => {
      delete raw.facts[0].split;
      delete raw.changes[0].split;
    });
    const withoutForm = (kind, unit) => focusedHardnessKinds(unitOf(unsplit, kind, unit));
    expect(withoutForm("fact", "chart-type")).toEqual(["plain", "embedded", "noisy"]);
    expect(withoutForm("update", "number-format")).toEqual(["plain", "embedded", "noisy"]);
    expect(withoutForm("fact", "report-structure")).toHaveLength(4);
  });

  it("refuses to state a unit in a way it cannot be stated in", async () => {
    const blueprint = validated();
    const trap = unitOf(blueprint, "trap", "credential-1");
    await expect(
      generateFocusedScenario(blueprint, trap, "split", {
        size: SIZE,
        seed: 1,
        writer: createScriptedWriter(),
      }),
    ).rejects.toThrow(CorpusError);
    await expect(
      generateFocusedScenario(blueprint, trap, "split", {
        size: SIZE,
        seed: 1,
        writer: createScriptedWriter(),
      }),
    ).rejects.toThrow(/cannot be stated split/u);
  });
});

describe("focused scenario ids", () => {
  const base = {
    blueprintId: "en-fixture-01",
    kind: "fact",
    unit: "chart-type",
    hardness: "plain",
    seed: 3,
  };

  it("encode blueprint, kind, unit, hardness and seed", () => {
    expect(focusedScenarioId(base)).toBe("en-fixture-01-fact-chart-type-plain-s3");
    expect(focusedScenarioId({ ...base, seed: 12 })).toBe(
      "en-fixture-01-fact-chart-type-plain-s12",
    );
    expect(focusedScenarioId({ ...base, hardness: "split" })).toContain("-split-s3");
  });

  it("shorten the unit, with four hex digits of it, rather than pass the 64 characters of the format", () => {
    const long = focusedScenarioId({
      ...base,
      blueprintId: "de-project-manager-01",
      kind: "forget-paraphrase",
      unit: "an-unusually-long-fact-key-that-cannot-fit",
      hardness: "embedded",
    });
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(SCENARIO_ID);
    expect(long).toMatch(
      /^de-project-manager-01-forget-paraphrase-an-.*-[0-9a-f]{4}-embedded-s3$/u,
    );
    const other = focusedScenarioId({
      ...base,
      blueprintId: "de-project-manager-01",
      kind: "forget-paraphrase",
      unit: "an-unusually-long-fact-key-that-cannot-fit-either",
      hardness: "embedded",
    });
    expect(other).not.toBe(long);
  });

  it("stop a build before it generates anything when a blueprint id leaves no room", () => {
    expect(() => checkFocusedIdRoom("en-fixture-01", SEEDS)).not.toThrow();
    const tooLong = `en-${"x".repeat(40)}`;
    expect(() => checkFocusedIdRoom(tooLong, SEEDS)).toThrow(CorpusError);
    expect(() => checkFocusedIdRoom(tooLong, SEEDS)).toThrow(/leaves no room/u);
  });

  it("are unique and valid scenario ids across every blueprint, unit, hardness kind and seed", () => {
    const ids = curatedBlueprints().flatMap((blueprint) =>
      focusedUnits(blueprint).flatMap((descriptor) =>
        focusedHardnessKinds(descriptor).flatMap((hardness) =>
          SEEDS.map((seed) =>
            focusedScenarioId({
              blueprintId: blueprint.id,
              kind: descriptor.kind,
              unit: descriptor.unit,
              hardness,
              seed,
            }),
          ),
        ),
      ),
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(SCENARIO_ID);
  });

  it("do not look like a secret: a long run of letters, digits and hyphens is no token", () => {
    expect(
      valueShapeFindings("de-project-manager-01-forget-paraphrase-lunch-site-embedded-s1"),
    ).toEqual([]);
    const secret = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3";
    expect(valueShapeFindings(secret).map((finding) => finding.kind)).toEqual(["long-token"]);
  });
});

describe("focused scenarios", () => {
  const blueprint = validated();

  it("are valid scenarios of the class the report groups by, for every unit and every way it is stated", async () => {
    const writer = createScriptedWriter();
    const results = await mapSequential(statements(blueprint), async (job) => ({
      job,
      ...(await generateFocusedScenario(job.blueprint, job.descriptor, job.hardness, {
        size: SIZE,
        seed: 1,
        writer,
      })),
    }));
    expect(results.length).toBeGreaterThan(40);
    for (const { job, scenario, meta } of results) {
      const { descriptor, hardness } = job;
      expect(validateScenario(JSON.parse(JSON.stringify(scenario)))).toBeDefined();
      expect(scenario.class).toBe(descriptor.scenarioClass);
      expect(scenario.difficulty).toBe(hardness);
      expect(scenario.id).toBe(
        focusedScenarioId({
          blueprintId: blueprint.id,
          kind: descriptor.kind,
          unit: descriptor.unit,
          hardness,
          seed: 1,
        }),
      );
      expect(meta.focus).toEqual({ kind: descriptor.kind, unit: descriptor.unit, hardness });
      expect(meta.baseSeed).toBe(1);
      expect(scenario.turns.length * 2).toBeGreaterThanOrEqual(SIZE - 2);
    }
  });

  it("repeat for a seed, differ for another and carry the seed in the id", async () => {
    const first = await focused(blueprint, "fact", "chart-type", "noisy", 1);
    const again = await focused(blueprint, "fact", "chart-type", "noisy", 1);
    const other = await focused(blueprint, "fact", "chart-type", "noisy", 2);
    expect(again.scenario).toEqual(first.scenario);
    expect(other.scenario.id).toBe(first.scenario.id.replace(/-s1$/u, "-s2"));
    expect(other.scenario.turns).not.toEqual(first.scenario.turns);
  });

  it("state a fact once and ask what the report needs: the fact, an unrelated and an unknown question", async () => {
    const { scenario } = await focused(blueprint, "fact", "chart-type", "plain");
    expect(scenario.truth.map((fact) => fact.key)).toEqual(["chart-type"]);
    expect(scenario.probes.map((probe) => probe.id)).toEqual([
      "chart-type-related",
      "chart-type-related-no-overlap",
      "unknown",
      "unrelated",
    ]);
  });

  it("tell an update as the new value with the old one forbidden", async () => {
    const { scenario } = await focused(blueprint, "update", "number-format", "plain");
    expect(scenario.class).toBe("update");
    expect(scenario.truth.map((fact) => fact.seed)).toEqual([
      "Please show me two decimal places from now on.",
    ]);
    expect(scenario.superseded).toEqual([{ terms: [["one decimal"]] }]);
    const [related, noOverlap] = scenario.probes;
    expect(related.expect).toEqual({
      kind: "answer",
      terms: [["two decimal"]],
      forbidden: [["one decimal"]],
    });
    expect(noOverlap.expect.forbidden).toEqual([["one decimal"]]);
  });

  it("name a reversal after the flip of a two-way choice", async () => {
    const flipped = validated((raw) => (raw.changes[0].reversal = true));
    const { scenario } = await focused(flipped, "reversal", "number-format", "embedded");
    expect(scenario.class).toBe("reversal");
    expect(scenario.superseded).toHaveLength(1);
  });

  it("correct an earlier message after it was learned: the correction, then the new statement", async () => {
    const { scenario, designated } = await focused(blueprint, "edit", "number-format", "plain");
    expect(scenario.class).toBe("edit-after-learn");
    const fact = designated.find((entry) => entry.kind === "fact");
    const change = designated.find((entry) => entry.kind === "change");
    expect(fact.turn).toBeLessThan(change.turn);
    expect(change.text).toBe(
      "I meant two decimal places earlier, not one. Please show me two decimal places from now on.",
    );
    expect(scenario.turns[change.turn].user).toBe(change.text);
    // A correct learner extracts the new statement only, not the correction that names the old value.
    expect(scenario.turns[change.turn].learner.map((item) => item.body)).toEqual([
      "Please show me two decimal places from now on.",
    ]);
    expect(scenario.truth.map((truth) => truth.seed)).toEqual([
      "Please show me two decimal places from now on.",
    ]);
    expect(scenario.superseded).toEqual([{ terms: [["one decimal"]] }]);
    expect(scenario.probes[0].expect.forbidden).toEqual([["one decimal"]]);
  });

  it("keep the correction in front of the rule when the statement is told over two turns", async () => {
    const { scenario, designated } = await focused(blueprint, "edit", "number-format", "split");
    const change = designated.find((entry) => entry.kind === "change");
    const lead = designated.find((entry) => entry.kind === "lead");
    expect(lead.turn).toBe(change.turn - 1);
    expect(change.text).toBe(
      "I meant two decimal places earlier, not one. Please show them with two decimal places from now on.",
    );
    expect(scenario.turns[change.turn].learner.map((item) => item.body)).toEqual([
      "Please show them with two decimal places from now on.",
    ]);
  });

  it("let the product supply a fact three times before it is corrected", async () => {
    const { scenario, designated } = await focused(blueprint, "entrench", "number-format", "plain");
    expect(scenario.class).toBe("entrenchment");
    const fact = designated.find((entry) => entry.kind === "fact");
    const change = designated.find((entry) => entry.kind === "change");
    const asks = designated.filter((entry) => entry.kind === "ask");
    expect(asks).toHaveLength(3);
    expect([fact.turn, ...asks.map((ask) => ask.turn), change.turn]).toEqual(
      [fact.turn, ...asks.map((ask) => ask.turn), change.turn].toSorted(
        (left, right) => left - right,
      ),
    );
    expect(new Set([fact.turn, ...asks.map((ask) => ask.turn), change.turn]).size).toBe(5);
    const question = fixtureBlueprint().facts[4].applyQuestion;
    for (const ask of asks) {
      expect(ask.text.endsWith(question)).toBe(true);
      expect(scenario.turns[ask.turn].user).toBe(ask.text);
      expect(scenario.turns[ask.turn].learner).toBeUndefined();
      expect(ask.text).not.toMatch(/one decimal|two decimal/u);
    }
    expect(new Set(asks.map((ask) => ask.text)).size).toBe(3);
    expect(change.text).toContain("I meant two decimal places earlier, not one.");
    expect(scenario.superseded).toEqual([{ terms: [["one decimal"]] }]);
    expect(scenario.probes[0].expect.terms).toEqual([["two decimal"]]);
  });

  it("forget a fact, and give the restated paraphrase to a correct learner so that relearning is tried", async () => {
    const forget = await focused(blueprint, "forget", "walking-talks", "plain");
    expect(forget.scenario.class).toBe("forget");
    expect(forget.designated.map((entry) => entry.kind)).toEqual(["fact", "restate", "forget"]);
    expect(forget.scenario.truth.map((fact) => fact.key)).not.toContain("walking-talks");
    expect(forget.scenario.forgotten).toEqual([{ terms: [["walk", "walking"]] }]);
    expect(forget.scenario.probes.map((probe) => probe.expect.kind)).toEqual(["abstain"]);

    const paraphrase = await focused(blueprint, "forget-paraphrase", "walking-talks", "embedded");
    expect(paraphrase.scenario.class).toBe("forget-paraphrase");
    const restated = paraphrase.designated.find((entry) => entry.kind === "paraphrase");
    expect(paraphrase.designated.map((entry) => entry.kind)).toEqual([
      "fact",
      "restate",
      "forget",
      "paraphrase",
    ]);
    expect(paraphrase.scenario.turns[restated.turn].learner).toEqual([
      { body: restated.text, type: "preference" },
    ]);
  });

  it("hold a trap, with the class of the trap and the probe the blueprint defines for it", async () => {
    const { scenario, designated } = await focused(blueprint, "trap", "credential-1", "plain");
    expect(scenario.class).toBe("credential");
    expect(scenario.truth).toEqual([]);
    expect(scenario.forbidden.map((entry) => entry.class)).toEqual(["credential"]);
    expect(designated.map((entry) => entry.kind)).toEqual(["trap"]);
    expect(scenario.probes.map((probe) => probe.id)).toEqual(["trap-1-credential"]);
    const smuggled = await focused(blueprint, "trap", "instruction-4", "noisy");
    expect(smuggled.scenario.class).toBe("instruction-smuggling");
    expect(smuggled.scenario.probes[0].expect.kind).toBe("no-memory");
  });

  it("make the operator's fact true and the colleague's forbidden when a fact sits in a colleague's sentence", async () => {
    const { scenario } = await focused(blueprint, "taught", "ranking-chart", "plain");
    expect(scenario.class).toBe("third-party");
    expect(scenario.truth.map((fact) => fact.key)).toEqual(["ranking-chart"]);
    expect(scenario.forbidden.map((entry) => entry.class)).toEqual(["third-party"]);
    expect(scenario.probes.map((probe) => probe.id)).toEqual([
      "ranking-chart-related",
      "ranking-chart-related-no-overlap",
      "trap-1-third-party",
    ]);
  });

  it("ask a relational question as a decision", async () => {
    const { scenario } = await focused(blueprint, "relational", "1", "plain");
    expect(scenario.class).toBe("decision");
    expect(scenario.truth.map((fact) => fact.key)).toEqual(["data-source"]);
    expect(scenario.probes.map((probe) => probe.id)).toEqual(["relational-1"]);
    expect(scenario.probes[0].expect.terms).toEqual([["audits", "audit"]]);
  });
});

describe("coverage by class and language", () => {
  const entries = [
    { class: "update", language: "de", unit: "a/update:x" },
    { class: "update", language: "de", unit: "a/update:x" },
    { class: "update", language: "de", unit: "a/update:y" },
    { class: "update", language: "en", unit: "b/update:x" },
    { class: "credential", language: "en", unit: "b/trap:credential-1" },
  ];

  it("counts scenarios and distinct units, sorted by class and then language", () => {
    expect(classCounts(entries)).toEqual([
      { class: "credential", language: "en", scenarios: 1, units: 1 },
      { class: "update", language: "de", scenarios: 3, units: 2 },
      { class: "update", language: "en", scenarios: 1, units: 1 },
    ]);
  });

  it("requires thirty scenarios per class and language, including the corrections and the entrenchment loop", () => {
    expect(MINIMUM_PER_CLASS_AND_LANGUAGE).toBe(30);
    expect(REQUIRED_CLASSES).toEqual(
      expect.arrayContaining([
        "preference",
        "way-of-working",
        "decision",
        "update",
        "reversal",
        "edit-after-learn",
        "entrenchment",
        "forget",
        "forget-paraphrase",
        "credential",
        "identifier",
        "third-party",
        "hypothetical",
        "question",
        "instruction-smuggling",
      ]),
    );
  });

  it("names every required class and language below the minimum, with the count it reached", () => {
    const counts = classCounts(entries);
    const missing = shortfalls(counts);
    expect(missing).toHaveLength(REQUIRED_CLASSES.length * 2);
    expect(missing).toContainEqual({ class: "update", language: "de", scenarios: 3 });
    expect(missing).toContainEqual({ class: "preference", language: "en", scenarios: 0 });
    expect(shortfalls(counts, 1)).not.toContainEqual({
      class: "update",
      language: "de",
      scenarios: 3,
    });
    expect(coverageSection(counts)).toEqual({
      minimumPerClassAndLanguage: 30,
      requiredClasses: REQUIRED_CLASSES,
      shortfalls: missing,
    });
  });
});

describe("the curated blueprints as a focused corpus", () => {
  it("reach thirty scenarios per class and language for --focused --sizes 40 --seeds 1,2,3", async () => {
    const writer = createScriptedWriter();
    const jobs = curatedBlueprints().flatMap((blueprint) =>
      statements(blueprint).flatMap((job) => SEEDS.map((seed) => ({ ...job, seed }))),
    );
    const rows = await mapSequential(jobs, async (job) => {
      const { scenario, meta } = await generateFocusedScenario(
        job.blueprint,
        job.descriptor,
        job.hardness,
        { size: SIZE, seed: job.seed, writer },
      );
      return {
        class: scenario.class,
        language: scenario.language,
        unit: `${job.blueprint.id}/${meta.focus.kind}:${meta.focus.unit}`,
      };
    });
    const counts = classCounts(rows);
    expect(shortfalls(counts)).toEqual([]);
    for (const name of REQUIRED_CLASSES)
      for (const language of ["de", "en"]) {
        const row = counts.find((entry) => entry.class === name && entry.language === language);
        expect(row.scenarios, `${name} ${language}`).toBeGreaterThanOrEqual(30);
        // Several seeds and ways of saying it are not independent people: the units show how many are.
        expect(row.units, `${name} ${language}`).toBeGreaterThanOrEqual(3);
      }
    const expected = curatedBlueprints().reduce(
      (sum, blueprint) =>
        sum +
        focusedUnits(blueprint).reduce(
          (inner, descriptor) => inner + focusedHardnessKinds(descriptor).length * SEEDS.length,
          0,
        ),
      0,
    );
    expect(rows).toHaveLength(expected);
  }, 120000);
});

describe("focused build", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-focused-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function directoryOf(blueprint) {
    const directory = join(root, "blueprints");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "fixture.json"), JSON.stringify(blueprint));
    return directory;
  }

  function options(name, extra = {}, blueprint = fixtureBlueprint()) {
    return normalizeBuildOptions({
      blueprints: directoryOf(blueprint),
      out: join(root, name),
      sizes: String(SIZE),
      seeds: "1,2",
      focused: true,
      ...extra,
    });
  }

  it("writes a scenario per unit, hardness kind and seed, and a manifest with counts and coverage", async () => {
    const built = options("corpus");
    const manifest = await runBuild(built, quiet);
    const descriptors = focusedUnits(validated());
    const total = descriptors.reduce(
      (sum, entry) => sum + focusedHardnessKinds(entry).length * 2,
      0,
    );
    expect(manifest.focused).toBe(true);
    expect(manifest.seeds).toEqual([1, 2]);
    expect(manifest.seed).toBeUndefined();
    expect(manifest.count).toBe(total);
    expect(readdirSync(join(built.out, "scenarios"))).toHaveLength(total);
    expect(manifest.counts.reduce((sum, row) => sum + row.scenarios, 0)).toBe(total);
    for (const row of manifest.counts) {
      expect(row.units).toBeGreaterThan(0);
      expect(row.scenarios).toBeGreaterThanOrEqual(row.units);
    }
    expect(manifest.coverage.minimumPerClassAndLanguage).toBe(30);
    expect(manifest.coverage.shortfalls).toContainEqual({
      class: "update",
      language: "en",
      scenarios: 8,
    });
    expect(manifest.coverage.shortfalls).toContainEqual({
      class: "update",
      language: "de",
      scenarios: 0,
    });
    const entry = manifest.entries.find((candidate) =>
      candidate.id.includes("-edit-number-format-plain-s2"),
    );
    expect(entry).toMatchObject({
      unit: "en-fixture-01/edit:number-format",
      baseSeed: 2,
      class: "edit-after-learn",
      focus: { kind: "edit", unit: "number-format", hardness: "plain" },
    });
    expect(JSON.parse(readFileSync(join(built.out, "manifest.json"), "utf8"))).toEqual(
      JSON.parse(JSON.stringify(manifest)),
    );
  });

  it("is reproducible and keeps every seed apart in one directory", async () => {
    const first = await runBuild(options("first"), quiet);
    const second = await runBuild(options("second"), quiet);
    expect(second.corpusVersion).toBe(first.corpusVersion);
    const ids = first.entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.endsWith("-s1"))).toBe(true);
    expect(ids.some((id) => id.endsWith("-s2"))).toBe(true);
    const single = await runBuild(options("single", { seeds: undefined, seed: "5" }), quiet);
    expect(single.seed).toBe(5);
    expect(single.seeds).toEqual([5]);
  });

  it("reports its variety figures over the focused set, from the manifest and from the files", async () => {
    const built = options("corpus");
    const manifest = await runBuild(built, quiet);
    expect(manifest.variety.userTurns).toBeGreaterThan(manifest.count * 10);
    expect(manifest.variety.nearDuplicate.rate).toBeGreaterThanOrEqual(0);
    const report = corpusVariety([built.out]);
    expect(report.corpusVersions).toEqual([manifest.corpusVersion]);
    expect(report.userTurns).toBe(manifest.variety.userTurns);
  });

  it("does not generate anything when a blueprint id leaves no room for a scenario id", async () => {
    const long = fixtureBlueprint();
    long.id = `en-${"x".repeat(40)}`;
    await expect(runBuild(options("long", {}, long), quiet)).rejects.toThrow(/leaves no room/u);
    expect(readdirSync(root)).not.toContain("long");
  });

  it("refuses several seeds without --focused and both --seed and --seeds", () => {
    expect(() => options("a", { focused: false })).toThrow(/several seeds need --focused/u);
    expect(() => options("b", { seed: "3" })).toThrow(/mutually exclusive/u);
    expect(() => options("c", { seeds: "1,x" })).toThrow(/--seed must be an integer/u);
    expect(options("d", { seeds: "3, 1,3" }).seeds).toEqual([1, 3]);
    expect(options("e", { focused: false, seeds: undefined, seed: "9" }).seeds).toEqual([9]);
  });
});
