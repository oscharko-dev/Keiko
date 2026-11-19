// Failed checks as counts per failure class (#4207): derived from what a run already records, listed
// in the summary, and compared per class between two runs with the checks that newly fail. A class
// is proven by a result that fails for exactly that reason and by one that does not.
import { describe, expect, it } from "vitest";
import { compareFailureClasses, renderFailureClasses } from "../testing/memory-lab/compare.mjs";
import {
  FAILURE_CLASSES,
  summarizeFailureClasses,
  unitFailures,
} from "../testing/memory-lab/failure-classes.mjs";
import { renderLabSummary, summarizeLabRun } from "../testing/memory-lab/report.mjs";
import { failedUnitResult } from "../testing/memory-lab/unit-failure.mjs";

function store(overrides = {}) {
  return {
    stored: 0,
    live: 0,
    parked: 0,
    forbiddenParked: 0,
    correct: 0,
    precision: null,
    recall: null,
    missing: [],
    counters: {
      credential: 0,
      identifier: 0,
      "third-party": 0,
      "forgotten-returned": 0,
      "private-in-project": 0,
    },
    verdicts: [],
    memories: [],
    ...overrides,
  };
}

function unit(overrides = {}) {
  return {
    scenario: "s1",
    language: "en",
    class: "preference",
    difficulty: "plain",
    arm: "product",
    repetition: 0,
    turns: [],
    store: store(),
    probes: [],
    probeCaptures: 0,
    timing: { learnMs: 0, probeMs: 0 },
    ...overrides,
  };
}

const answer = (fields) => ({
  id: "a",
  kind: "answer",
  passed: false,
  termsPresent: false,
  forbiddenPresent: false,
  relevantSupplied: true,
  ...fields,
});

function classesOf(result) {
  return unitFailures(result).map((failure) => failure.class);
}

describe("the failure class of a failed check", () => {
  it("names a fact the learner never stored", () => {
    expect(classesOf(unit({ store: store({ missing: ["k1", "k2"] }) }))).toEqual([
      "fact-not-stored",
      "fact-not-stored",
    ]);
  });

  it("names a stored record that is wrong: unnecessary, stale, forgotten, forbidden", () => {
    const verdicts = [
      { id: "1", status: "accepted", verdict: "unnecessary" },
      { id: "2", status: "accepted", verdict: "stale" },
      { id: "3", status: "accepted", verdict: "forgotten-returned" },
      { id: "4", status: "proposed", verdict: "forbidden", class: "credential" },
      { id: "5", status: "accepted", verdict: "correct", key: "k" },
    ];
    expect(classesOf(unit({ store: store({ verdicts }) }))).toEqual([
      "unnecessary-fact-stored",
      "stale-fact-live",
      "forgotten-fact-returned",
      "forbidden-fact-stored",
    ]);
  });

  it("does not count a stale or unnecessary record that is parked or archived: it cannot be recalled", () => {
    const verdicts = [
      { id: "1", status: "proposed", verdict: "unnecessary" },
      { id: "2", status: "archived", verdict: "stale" },
    ];
    expect(classesOf(unit({ store: store({ verdicts }) }))).toEqual([]);
  });

  it("splits a failed answer into not retrieved, retrieved but wrong, and a forbidden term", () => {
    const probes = [
      answer({ id: "not-supplied", relevantSupplied: false }),
      answer({ id: "wrong", relevantSupplied: true }),
      answer({ id: "forbidden", forbiddenPresent: true }),
      answer({ id: "needed", relevantSupplied: false, neededNotSupplied: ["day"] }),
      answer({ id: "needed-unused", relevantSupplied: true, neededNotSupplied: [] }),
      answer({ id: "fine", passed: true }),
    ];
    expect(classesOf(unit({ probes }))).toEqual([
      "relevant-memory-not-supplied",
      "supplied-answer-wrong",
      "forbidden-term-in-answer",
      "needed-memory-missing",
      "supplied-answer-wrong",
    ]);
  });

  it("names the failures of the other probe kinds", () => {
    const probes = [
      { id: "1", kind: "abstain", passed: false, abstained: false, leaked: false },
      { id: "2", kind: "abstain", passed: false, abstained: true, leaked: true },
      { id: "3", kind: "no-memory", passed: false, overApplied: true },
      { id: "4", kind: "not-obeyed", passed: false, obeyed: true },
      { id: "5", kind: "no-memory", passed: true },
    ];
    expect(classesOf(unit({ probes }))).toEqual([
      "no-abstention",
      "fact-leaked",
      "memory-on-unrelated-question",
      "injected-instruction-obeyed",
    ]);
  });

  it("counts a unit that could not be measured once", () => {
    const failed = failedUnitResult({
      scenario: { language: "en", class: "preference", difficulty: "plain" },
      name: "s1",
      arm: "product",
      repetition: 0,
      error: new Error("boom"),
      includeMessage: false,
    });
    expect(classesOf(failed)).toEqual(["unit-not-measured"]);
  });

  it("is a closed list that every derived class belongs to", () => {
    const results = [
      unit({
        store: store({
          missing: ["k"],
          verdicts: [{ id: "1", status: "accepted", verdict: "stale" }],
        }),
        probes: [answer({ relevantSupplied: false })],
      }),
    ];
    for (const result of results)
      for (const failure of unitFailures(result)) expect(FAILURE_CLASSES).toContain(failure.class);
  });
});

describe("the summary of failure classes", () => {
  const results = [
    unit({ scenario: "b", store: store({ missing: ["k"] }) }),
    unit({ scenario: "a", probes: [answer({ id: "p1" }), answer({ id: "p2" })] }),
    unit({
      scenario: "a",
      arm: "off",
      repetition: 1,
      probes: [answer({ id: "p1", relevantSupplied: false })],
    }),
  ];

  it("lists counts per arm, per class and per scenario, with the checks that failed", () => {
    const summary = summarizeFailureClasses(results);
    expect(summary.byArm.product.total).toEqual({
      "fact-not-stored": 1,
      "supplied-answer-wrong": 2,
    });
    expect(summary.byArm.product.byScenario).toEqual({
      a: { "supplied-answer-wrong": 2 },
      b: { "fact-not-stored": 1 },
    });
    expect(summary.byArm.product.keys["supplied-answer-wrong"]).toEqual([
      "a:product:r0:probe:p1",
      "a:product:r0:probe:p2",
    ]);
    expect(summary.byArm.off.keys["relevant-memory-not-supplied"]).toEqual(["a:off:r1:probe:p1"]);
  });

  it("holds only whole numbers", () => {
    const text = JSON.stringify(summarizeFailureClasses(results));
    expect(text).not.toMatch(/\d\.\d/u);
  });

  it("serializes the same results the same way whatever order they arrive in", () => {
    expect(JSON.stringify(summarizeFailureClasses([...results].reverse()))).toBe(
      JSON.stringify(summarizeFailureClasses(results)),
    );
  });

  it("reports per-arm totals only for a sealed run, so no hidden scenario can be followed", () => {
    const sealed = summarizeFailureClasses(results, { sealed: true });
    expect(sealed.byArm.product.total["supplied-answer-wrong"]).toBe(2);
    expect(sealed.byArm.product.byScenario).toEqual({});
    expect(sealed.byArm.product.keys).toEqual({});
  });

  it("appears in the run summary and in its Markdown as a section of counts", () => {
    const summary = summarizeLabRun(results);
    expect(summary.failureClasses.byArm.product.total["fact-not-stored"]).toBe(1);
    const markdown = renderLabSummary(
      summary,
      { count: 2, setDigest: "d" },
      {
        mode: "offline",
        productHead: "h",
        arms: ["product", "off"],
        repetitions: 2,
        memoryMode: "m",
        ceiling: "c",
        embedder: "none",
        embeddingModelIds: [],
      },
    );
    expect(markdown).toContain("### Failure classes (counts of failed checks)");
    expect(markdown).toContain("| fact-not-stored | 0 | 1 |");
    expect(markdown).toContain("- product a: supplied-answer-wrong=2");
    expect(markdown).toContain("Embedding model: none.");
  });

  it("says so when nothing failed", () => {
    const clean = summarizeLabRun([unit({ probes: [answer({ passed: true })] })]);
    expect(
      renderLabSummary(clean, { count: 1, setDigest: "d" }, { mode: "offline", arms: [] }),
    ).toContain("No failed check.");
  });
});

describe("comparing failure classes between two runs", () => {
  const run = (results) => ({ summary: summarizeLabRun(results) });
  const baseline = run([
    unit({ scenario: "a", probes: [answer({ id: "p1" })] }),
    unit({ scenario: "b", store: store({ missing: ["k"] }) }),
  ]);
  const candidate = run([
    unit({
      scenario: "a",
      probes: [answer({ id: "p1" }), answer({ id: "p2", relevantSupplied: false })],
    }),
    unit({ scenario: "b", store: store({ missing: [] }) }),
  ]);

  it("lists per class the count in each run and the checks that newly fail", () => {
    expect(compareFailureClasses(baseline, candidate)).toEqual([
      { class: "fact-not-stored", baseline: 1, candidate: 0, newlyFailing: [] },
      {
        class: "relevant-memory-not-supplied",
        baseline: 0,
        candidate: 1,
        newlyFailing: ["a:product:r0:probe:p2"],
      },
      { class: "supplied-answer-wrong", baseline: 1, candidate: 1, newlyFailing: [] },
    ]);
  });

  it("renders whole numbers and the new keys, and nothing for runs that recorded no classes", () => {
    const lines = renderFailureClasses(
      { arm: "product", failureClasses: compareFailureClasses(baseline, candidate) },
      "m",
    );
    expect(lines[0]).toBe("m failure classes (product arm, failed checks):");
    expect(lines).toContain(
      "  relevant-memory-not-supplied: 0 -> 1; newly failing: a:product:r0:probe:p2",
    );
    expect(lines.join("\n")).not.toMatch(/\d\.\d/u);
    expect(compareFailureClasses({ summary: {} }, { summary: {} })).toBeNull();
    expect(renderFailureClasses({ arm: "product", failureClasses: null }, "m")).toEqual([]);
    const same = compareFailureClasses(baseline, baseline);
    expect(same.every((row) => row.newlyFailing.length === 0)).toBe(true);
  });

  it("says so when neither run has a failed check", () => {
    const clean = run([unit({ probes: [answer({ passed: true })] })]);
    expect(
      renderFailureClasses(
        { arm: "product", failureClasses: compareFailureClasses(clean, clean) },
        "m",
      ),
    ).toEqual(["m failure classes: no failed check in either run"]);
  });
});
