import { describe, expect, it } from "vitest";
import {
  buildLabScorecard,
  passFailLine,
  renderLabSummary,
  serializeScorecard,
  summarizeLabRun,
} from "../testing/memory-lab/report.mjs";
import { HARD_COUNTERS } from "../testing/memory-lab/score.mjs";

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
    expect(entry.evidence).toBe("mismatches=format");
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
