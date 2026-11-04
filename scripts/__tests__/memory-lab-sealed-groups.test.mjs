import { describe, expect, it } from "vitest";
import { buildLabScorecard, summarizeLabRun } from "../testing/memory-lab/report.mjs";
import { DEFAULT_SCENARIO_DIR } from "../testing/memory-lab/run.mjs";
import { loadScenarioDirectory, scenarioSetManifest } from "../testing/memory-lab/scenario.mjs";

const COUNTERS = {
  credential: 0,
  identifier: 0,
  "third-party": 0,
  "forgotten-returned": 0,
  "private-in-project": 0,
};

function unit(scenario, scenarioClass, language = "de") {
  return {
    scenario,
    language,
    class: scenarioClass,
    difficulty: "plain",
    arm: "product",
    repetition: 0,
    turns: [],
    store: {
      stored: 1,
      live: 1,
      parked: 0,
      forbiddenParked: 0,
      correct: 1,
      precision: 1,
      recall: 1,
      missing: [],
      counters: COUNTERS,
      verdicts: [],
      memories: [],
    },
    captures: [],
    probes: [],
    probeCaptures: 0,
    timing: { learnMs: 1, probeMs: 1 },
    requests: [],
    foldedKeys: [],
    instanceStartMs: 1,
  };
}

function many(prefix, count, scenarioClass) {
  return Array.from({ length: count }, (_, index) =>
    unit(`${prefix}-${String(index)}`, scenarioClass),
  );
}

function classKeys(results) {
  return summarizeLabRun(results, { sealed: true }).byArmAndClass.map((row) => row.key);
}

function groupNames(results) {
  return buildLabScorecard(results, 0, true).scenarios.map((entry) => entry.name);
}

describe("the groups a sealed run reports", () => {
  it("keeps a class that five distinct scenarios share and folds a smaller one", () => {
    const results = [...many("p", 6, "preference"), ...many("f", 5, "forget")];
    expect(classKeys(results)).toEqual(["product/forget", "product/preference"]);
  });

  it("lets the largest group absorb a folded remainder that stays below five, and says so", () => {
    // The failure this pins: one forget scenario folded into `other`, and `other` then held exactly
    // that one scenario, a unit in all but name.
    const results = [...many("p", 6, "preference"), unit("f-0", "forget")];
    expect(classKeys(results)).toEqual(["product/preference+other"]);
    expect(groupNames(results)).toEqual(["holdout:preference+other:de:product:r0:group"]);
    const card = buildLabScorecard(results, 0, true).scenarios[0];
    expect(card.metrics.find((metric) => metric.name === "units").value).toBe(7);
  });

  it("reports other on its own once the folded remainder reaches five", () => {
    const results = [
      ...many("p", 6, "preference"),
      ...many("f", 2, "forget"),
      ...many("u", 3, "update"),
    ];
    expect(classKeys(results)).toEqual(["product/other", "product/preference"]);
  });

  it("names everything other when no group reaches five", () => {
    expect(classKeys(many("p", 2, "preference"))).toEqual(["product/other"]);
    expect(groupNames(many("p", 2, "preference"))).toEqual(["holdout:other:de:product:r0:group"]);
  });

  it("folds per language in the scorecard and ties the largest group by name", () => {
    const results = [
      ...many("p", 5, "preference"),
      ...many("w", 5, "way-of-working"),
      unit("f-0", "forget"),
      unit("en-f", "forget", "en"),
    ];
    expect(groupNames(results)).toEqual([
      "holdout:other:en:product:r0:group",
      "holdout:preference+other:de:product:r0:group",
      "holdout:way-of-working:de:product:r0:group",
    ]);
  });
});

describe("the set digest", () => {
  it("does not depend on the order the scenarios arrived in", () => {
    const scenarios = loadScenarioDirectory(DEFAULT_SCENARIO_DIR);
    expect(scenarios.length).toBeGreaterThan(2);
    const forward = scenarioSetManifest(scenarios);
    const backward = scenarioSetManifest([...scenarios].reverse());
    expect(backward.setDigest).toBe(forward.setDigest);
    expect(backward.entries.map((entry) => entry.id)).toEqual(
      forward.entries.map((entry) => entry.id),
    );
  });
});
