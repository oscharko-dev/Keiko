import { describe, expect, it } from "vitest";
import {
  buildLabScorecard,
  passFailLine,
  renderLabSummary,
  serializeScorecard,
  summarizeLabRun,
} from "../testing/memory-lab/report.mjs";
import { HARD_COUNTERS } from "../testing/memory-lab/score.mjs";
import { failedUnitResult } from "../testing/memory-lab/unit-failure.mjs";

function counters(overrides = {}) {
  return { ...Object.fromEntries(HARD_COUNTERS.map((name) => [name, 0])), ...overrides };
}

function result(overrides = {}) {
  return {
    scenario: "preference-tables-de",
    language: "de",
    class: "preference",
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
      counters: counters(),
      verdicts: [],
      memories: [],
    },
    captures: [],
    probes: [
      { id: "related", kind: "answer", passed: true, termsPresent: true, suppliedCount: 1 },
      { id: "unknown", kind: "abstain", passed: false, abstained: false, suppliedCount: 0 },
    ],
    timing: { learnMs: 10, probeMs: 20 },
    requests: [],
    ...overrides,
  };
}

const SCENARIO = { language: "de", class: "preference", difficulty: "plain" };

function failedUnit(overrides = {}) {
  return failedUnitResult({
    scenario: SCENARIO,
    name: "preference-tables-de",
    arm: "product",
    repetition: 0,
    error: new RangeError("boom"),
    includeMessage: false,
    ...overrides,
  });
}

function turns(...elapsed) {
  return elapsed.map((elapsedMs, index) => ({ index, elapsedMs }));
}

const META = {
  mode: "offline",
  productHead: "head",
  arms: ["off", "product", "oracle"],
  repetitions: 1,
  memoryMode: "autonomous-delivery",
  ceiling: "autonomous-delivery",
};

describe("memory lab report", () => {
  it("builds a byte-stable scorecard that ignores timing and input order", () => {
    const first = buildLabScorecard([result({ arm: "oracle" }), result()], 0);
    const second = buildLabScorecard(
      [result({ timing: { learnMs: 99, probeMs: 1 } }), result({ arm: "oracle" })],
      0,
    );
    expect(serializeScorecard(second)).toBe(serializeScorecard(first));
    expect(first.scenarios.map((entry) => entry.name)).toEqual([
      "preference-tables-de:oracle:r0:store",
      "preference-tables-de:oracle:r0:probe:related",
      "preference-tables-de:oracle:r0:probe:unknown",
      "preference-tables-de:product:r0:store",
      "preference-tables-de:product:r0:probe:related",
      "preference-tables-de:product:r0:probe:unknown",
    ]);
  });

  it("fails a store entry on a hard counter even with perfect precision and recall", () => {
    const red = result({
      store: { ...result().store, counters: counters({ credential: 1 }) },
    });
    const card = buildLabScorecard([red], 0);
    const store = card.scenarios.find((entry) => entry.name.endsWith(":store"));
    expect(store.passed).toBe(false);
    expect(store.evidence).toContain("credential=1");
    expect(store.metrics.find((metric) => metric.name === "credential").value).toBe(1);
  });

  it("records the oracle precondition and reports its failures in the summary", () => {
    const oracle = result({
      arm: "oracle",
      oracle: { seeded: [], mismatches: ["format"], preconditionMet: false },
    });
    const card = buildLabScorecard([oracle], 0);
    const entry = card.scenarios.find((item) => item.name.endsWith(":oracle-precondition"));
    expect(entry.passed).toBe(false);
    expect(entry.evidence).toBe("mismatches=format extras=0 scopes=-");
    const summary = summarizeLabRun([oracle, result()]);
    expect(summary.oraclePreconditionFailures).toEqual(["preference-tables-de"]);
    expect(passFailLine(summary)).toBe(
      "PASS memory-lab runs=2 hard-counters=zero oracle-counters=zero oracle=precondition-failed",
    );
  });

  it("groups by arm, language and class and flags violated hard counters of learned arms", () => {
    const violated = result({
      arm: "oracle",
      store: { ...result().store, counters: counters({ "private-in-project": 1 }) },
    });
    const summary = summarizeLabRun([result(), violated, result({ arm: "off", language: "en" })]);
    expect(summary.byArm.map((row) => row.key)).toEqual(["off", "oracle", "product"]);
    expect(summary.byArmAndLanguage.map((row) => row.key)).toEqual([
      "off/en",
      "oracle/de",
      "product/de",
    ]);
    expect(summary.byArmAndClass[0].key).toBe("off/preference");
    expect(summary.hardCountersViolated).toBe(false);
    expect(summary.oracleCountersViolated).toBe(true);
    const markdown = renderLabSummary(
      summary,
      { count: 1, setDigest: "abc" },
      {
        mode: "offline",
        productHead: "head",
        arms: ["off", "product", "oracle"],
        repetitions: 1,
        memoryMode: "governed-assist",
        ceiling: "governed-assist",
      },
    );
    expect(markdown).toContain("Hard counters in the product arm: all zero. Oracle arm: VIOLATED");
    expect(markdown).toContain("| product/de |");
    expect(markdown).toContain("### Not measured in this run");
  });

  it("reports the noise band as the half range across repetitions, and n/a for one repetition", () => {
    const summary = summarizeLabRun([
      result(),
      result({ repetition: 1, store: { ...result().store, precision: 0.5 } }),
      result({ repetition: 2, store: { ...result().store, precision: 0.9 } }),
      result({ arm: "oracle" }),
    ]);
    const product = summary.noise.find((row) => row.arm === "product");
    expect(product.repetitions).toBe(3);
    expect(product.precision).toBe(0.25);
    expect(product.recall).toBe(0);
    expect(summary.noise.find((row) => row.arm === "oracle").precision).toBeNull();
    const markdown = renderLabSummary(
      summary,
      { count: 1, setDigest: "abc" },
      {
        mode: "offline",
        productHead: "head",
        arms: ["product", "oracle"],
        repetitions: 3,
        memoryMode: "m",
        ceiling: "c",
      },
    );
    expect(markdown).toContain("| product | 3 | 0.25 | 0 | 0 |");
    expect(markdown).toContain("| oracle | 1 | n/a | n/a | n/a |");
  });
});

describe("memory lab report of units that could not be measured", () => {
  it("records a failed unit as a failed store entry named after the error, with no probes", () => {
    const card = buildLabScorecard([failedUnit(), result({ arm: "oracle" })], 0);
    const entry = card.scenarios.find(
      (item) => item.name === "preference-tables-de:product:r0:store",
    );
    expect(entry).toEqual({
      name: "preference-tables-de:product:r0:store",
      passed: false,
      evidence: "unit-failed:RangeError",
    });
    expect(
      card.scenarios.some((item) => item.name.startsWith("preference-tables-de:product:r0:probe")),
    ).toBe(false);
  });

  it("counts failed units in the summary and leaves them out of every figure", () => {
    const summary = summarizeLabRun([
      result(),
      failedUnit({ repetition: 1 }),
      failedUnit({ arm: "off" }),
    ]);
    expect(summary.runs).toBe(3);
    expect(summary.failedUnits).toBe(2);
    expect(summary.failedUnitList).toEqual([
      { scenario: "preference-tables-de", arm: "product", repetition: 1, error: "RangeError" },
      { scenario: "preference-tables-de", arm: "off", repetition: 0, error: "RangeError" },
    ]);
    const product = summary.byArm.find((row) => row.key === "product");
    expect(product).toMatchObject({ runs: 1, failed: 1, precision: 1, recall: 1 });
    const off = summary.byArm.find((row) => row.key === "off");
    expect(off).toMatchObject({ runs: 0, failed: 1, precision: null, answerAccuracy: null });
    expect(summary.hardCountersViolated).toBe(false);
  });

  it("turns the last line into FAIL with the count, and names the units in the Markdown", () => {
    const summary = summarizeLabRun([result(), failedUnit({ repetition: 1 })]);
    expect(passFailLine(summary)).toBe(
      "FAIL memory-lab runs=2 hard-counters=zero oracle-counters=zero oracle=not-run failed-units=1",
    );
    const markdown = renderLabSummary(summary, { count: 1, setDigest: "abc" }, META);
    expect(markdown).toContain("**Failed units: 1.**");
    expect(markdown).toContain("preference-tables-de product r1 (RangeError)");
    expect(summarizeLabRun([result()]).failedUnits).toBe(0);
    expect(passFailLine(summarizeLabRun([result()]))).toMatch(/^PASS memory-lab runs=1 /u);
  });

  it("does not let a failed unit lift an average it has no figures for", () => {
    const lowered = result({ store: { ...result().store, precision: 0.5 } });
    const summary = summarizeLabRun([lowered, failedUnit({ repetition: 1 })]);
    expect(summary.byArm.find((row) => row.key === "product").precision).toBe(0.5);
  });
});

describe("memory lab report details", () => {
  it("shows parked forbidden memories in the store evidence and as a metric", () => {
    const parked = result({
      store: { ...result().store, forbiddenParked: 2, parked: 2, live: 0, precision: null },
    });
    const card = buildLabScorecard([parked], 0);
    const store = card.scenarios.find((entry) => entry.name.endsWith(":store"));
    expect(store.evidence).toContain("parked=2 forbiddenParked=2 correct=1");
    expect(store.metrics.find((metric) => metric.name === "forbiddenParked").value).toBe(2);
  });

  it("prints the oracle precondition only when an oracle arm ran", () => {
    const withoutOracle = summarizeLabRun([result(), result({ arm: "off" })]);
    expect(withoutOracle.oracleArmRan).toBe(false);
    const markdownWithout = renderLabSummary(withoutOracle, { count: 1, setDigest: "abc" }, META);
    expect(markdownWithout).toContain("Oracle arm: not run.");
    expect(markdownWithout).not.toContain("Oracle precondition");
    expect(passFailLine(withoutOracle)).toMatch(/ oracle=not-run$/u);

    const oracle = result({
      arm: "oracle",
      oracle: {
        seeded: [],
        mismatches: [],
        extras: 0,
        scopes: { project: 2 },
        preconditionMet: true,
      },
    });
    const withOracle = summarizeLabRun([result(), oracle]);
    const markdown = renderLabSummary(withOracle, { count: 1, setDigest: "abc" }, META);
    expect(markdown).toContain("Oracle precondition: met for every scenario that ran.");
    expect(markdown).toContain("Scope of the oracle seeds: project:2");
    expect(markdown).not.toContain("Oracle arm: not run");
    expect(passFailLine(withOracle)).toMatch(/ oracle=ok$/u);
  });

  it("does not claim a met precondition when every oracle unit failed", () => {
    const summary = summarizeLabRun([failedUnit({ arm: "oracle" })]);
    expect(summary.oracleArmRan).toBe(true);
    expect(summary.oracleRuns).toBe(0);
    const markdown = renderLabSummary(summary, { count: 1, setDigest: "abc" }, META);
    expect(markdown).toContain("Oracle precondition: not established");
    expect(markdown).not.toContain("Oracle precondition: met");
  });

  it("records the mismatches, extra accepted memories and scopes of a failed precondition", () => {
    const oracle = result({
      arm: "oracle",
      oracle: {
        seeded: [],
        mismatches: ["a", "b"],
        extras: 1,
        scopes: { user: 1, project: 2 },
        preconditionMet: false,
      },
    });
    const entry = buildLabScorecard([oracle], 0).scenarios.find((item) =>
      item.name.endsWith(":oracle-precondition"),
    );
    expect(entry.evidence).toBe("mismatches=a,b extras=1 scopes=project:2,user:1");
  });

  it("groups by difficulty as well", () => {
    const summary = summarizeLabRun([
      result(),
      result({ difficulty: "noisy", repetition: 1 }),
      result({ arm: "off", difficulty: "noisy" }),
    ]);
    expect(summary.byArmAndDifficulty.map((row) => row.key)).toEqual([
      "off/noisy",
      "product/noisy",
      "product/plain",
    ]);
    const markdown = renderLabSummary(summary, { count: 1, setDigest: "abc" }, META);
    expect(markdown).toContain("### By arm and difficulty");
    expect(markdown).toContain("| product/noisy |");
  });

  it("orders keys by code unit, not by the locale of the machine", () => {
    // localeCompare puts "alpha" before "Zulu"; the order of the evidence must not depend on it.
    const summary = summarizeLabRun([
      result({ class: "alpha" }),
      result({ class: "Zulu", repetition: 1 }),
    ]);
    expect(summary.byArmAndClass.map((row) => row.key)).toEqual(["product/Zulu", "product/alpha"]);
    const card = buildLabScorecard(
      [result({ scenario: "alpha-case" }), result({ scenario: "Zulu-case" })],
      0,
    );
    expect(card.scenarios[0].name.startsWith("Zulu-case:")).toBe(true);
  });

  it("reports turn latency and learning settle per arm and the delay memory adds", () => {
    const summary = summarizeLabRun([
      result({ arm: "off", turns: turns(100, 200), timing: { learnMs: 300, probeMs: 1 } }),
      result({ arm: "product", turns: turns(250, 350), timing: { learnMs: 900, probeMs: 1 } }),
      result({
        arm: "product",
        repetition: 1,
        turns: turns(300),
        timing: { learnMs: 700, probeMs: 1 },
      }),
      result({ arm: "oracle", turns: [], timing: { learnMs: 50, probeMs: 1 } }),
      failedUnit({ arm: "product", repetition: 2 }),
    ]);
    expect(summary.timing.byArm).toEqual([
      { arm: "off", units: 1, meanTurnMs: 150, meanLearnMs: 300 },
      { arm: "oracle", units: 1, meanTurnMs: null, meanLearnMs: 50 },
      { arm: "product", units: 2, meanTurnMs: 300, meanLearnMs: 800 },
    ]);
    expect(summary.timing.memoryDelayMs).toBe(150);
    const markdown = renderLabSummary(summary, { count: 1, setDigest: "abc" }, META);
    expect(markdown).toContain("| product | 2 | 300 | 800 |");
    expect(markdown).toContain(
      "Delay added to a turn by memory (product minus off, mean turn): 150 ms.",
    );
  });

  it("has no delay figure unless both the off and the product arm ran", () => {
    const summary = summarizeLabRun([result({ turns: turns(100) })]);
    expect(summary.timing.memoryDelayMs).toBeNull();
    expect(renderLabSummary(summary, { count: 1, setDigest: "abc" }, META)).toContain(
      "n/a (needs the off and the product arm)",
    );
  });
});
