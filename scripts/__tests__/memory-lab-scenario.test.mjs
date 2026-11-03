import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCENARIO_CLASSES,
  loadScenarioDirectory,
  scenarioDigest,
  scenarioSetManifest,
  validateScenario,
} from "../testing/memory-lab/scenario.mjs";
import { DEFAULT_SCENARIO_DIR } from "../testing/memory-lab/run.mjs";

function valid() {
  return {
    schemaVersion: 1,
    id: "fixture-preference-de",
    language: "de",
    class: "preference",
    difficulty: "plain",
    description: "A valid fixture.",
    truth: [{ key: "k", seed: "Ich mag Tabellen.", must: true, terms: [["Tabellen"]] }],
    turns: [
      { user: "Ich mag Tabellen.", learner: [{ body: "Ich mag Tabellen.", type: "preference" }] },
    ],
    probes: [{ id: "p", question: "Wie?", expect: { kind: "answer", terms: [["Tabellen"]] } }],
  };
}

describe("memory lab scenario format", () => {
  let directory;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("accepts a valid scenario and defaults the optional lists", () => {
    const scenario = validateScenario(valid());
    expect(scenario.superseded).toEqual([]);
    expect(scenario.forgotten).toEqual([]);
    expect(scenario.forbidden).toEqual([]);
    expect(Object.isFrozen(scenario)).toBe(true);
  });

  it.each([
    ["schemaVersion", { schemaVersion: 2 }, /schemaVersion/u],
    ["id", { id: "Bad Id" }, /slug/u],
    ["language", { language: "fr" }, /language/u],
    ["class", { class: "unknown" }, /class/u],
    ["difficulty", { difficulty: "hard" }, /difficulty/u],
    ["truth seed", { truth: [{ key: "k", must: true, terms: [["x"]] }] }, /seed/u],
    ["truth terms", { truth: [{ key: "k", seed: "s", must: true, terms: [] }] }, /terms/u],
    ["forbidden class", { forbidden: [{ class: "nope", terms: [["x"]] }] }, /class/u],
    ["turn user", { turns: [{ learner: [] }] }, /user/u],
    ["learner item", { turns: [{ user: "u", learner: [{ body: "" }] }] }, /learner/u],
    ["probe kind", { probes: [{ id: "p", question: "q", expect: { kind: "guess" } }] }, /kind/u],
    [
      "answer terms",
      { probes: [{ id: "p", question: "q", expect: { kind: "answer" } }] },
      /terms/u,
    ],
    [
      "duplicate probe id",
      {
        probes: [
          { id: "p", question: "q", expect: { kind: "abstain" } },
          { id: "p", question: "q", expect: { kind: "abstain" } },
        ],
      },
      /duplicates/u,
    ],
  ])("rejects a defect in %s", (_name, patch, pattern) => {
    expect(() => validateScenario({ ...valid(), ...patch })).toThrow(pattern);
  });

  it("digests independently of key order", () => {
    const base = valid();
    const reordered = Object.fromEntries(Object.entries(base).toReversed());
    expect(scenarioDigest(validateScenario(reordered))).toBe(
      scenarioDigest(validateScenario(base)),
    );
  });

  it("loads a directory, sorts by id and refuses duplicate ids", () => {
    directory = mkdtempSync(join(tmpdir(), "memory-lab-scenarios-"));
    writeFileSync(join(directory, "b.json"), JSON.stringify({ ...valid(), id: "zeta-scenario" }));
    writeFileSync(join(directory, "a.json"), JSON.stringify({ ...valid(), id: "alpha-scenario" }));
    expect(loadScenarioDirectory(directory).map((scenario) => scenario.id)).toEqual([
      "alpha-scenario",
      "zeta-scenario",
    ]);
    writeFileSync(join(directory, "c.json"), JSON.stringify({ ...valid(), id: "alpha-scenario" }));
    expect(() => loadScenarioDirectory(directory)).toThrow(/duplicate scenario id/u);
  });

  it("refuses a file that is not JSON", () => {
    directory = mkdtempSync(join(tmpdir(), "memory-lab-scenarios-"));
    writeFileSync(join(directory, "broken.json"), "{ not json");
    expect(() => loadScenarioDirectory(directory)).toThrow(/not valid JSON/u);
  });

  it("ships a curated set whose classes are all known and whose manifest is stable", () => {
    const scenarios = loadScenarioDirectory(DEFAULT_SCENARIO_DIR);
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
    for (const scenario of scenarios) expect(SCENARIO_CLASSES).toContain(scenario.class);
    expect(new Set(scenarios.map((scenario) => scenario.language))).toEqual(new Set(["de", "en"]));
    const first = scenarioSetManifest(scenarios);
    const second = scenarioSetManifest(loadScenarioDirectory(DEFAULT_SCENARIO_DIR));
    expect(second).toEqual(first);
    expect(first.setDigest).toMatch(/^[0-9a-f]{64}$/u);
  });
});
