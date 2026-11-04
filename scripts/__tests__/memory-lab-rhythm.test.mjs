// The optimization loop's judgement over synthetic runs: progress counts only on the holdout, beyond
// the noise band, on more than one model, with every hard counter at zero. Nothing here forks the
// product; runs are written as the lab writes them.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareRuns,
  judgeProgress,
  noiseBand,
  provenanceDifferences,
  readRun,
  renderComparison,
  renderJudgement,
} from "../testing/memory-lab/compare.mjs";
import { headroomReading } from "../testing/memory-lab/rhythm.mjs";
import { HARD_COUNTERS } from "../testing/memory-lab/score.mjs";
import {
  LEDGER_END,
  LEDGER_HEADER,
  LEDGER_START,
  appendLedgerRows,
  ledgerRow,
} from "../testing/memory-lab/trend.mjs";

const CORPUS = "a".repeat(64);

function counters(overrides = {}) {
  return { ...Object.fromEntries(HARD_COUNTERS.map((name) => [name, 0])), ...overrides };
}

const clamp = (value) => Math.max(0, Math.min(1, value));

function storeEntry(repetition, precision, recall, unit = 0) {
  return {
    name: `scenario-${String(unit)}:product:r${String(repetition)}:store`,
    passed: precision === 1 && recall === 1,
    evidence: "stored=1",
    metrics: [
      { name: "precision", value: precision },
      { name: "recall", value: recall },
    ],
  };
}

// One probe entry of a repetition; the evidence starts with the probe's kind, as the report writes it.
function probeEntry(repetition, passed, kind = "answer", id = "related", unit = 0) {
  return {
    name: `scenario-${String(unit)}:product:r${String(repetition)}:probe:${id}`,
    passed,
    evidence: `kind=${kind} suppliedCount=1`,
  };
}

const PROVENANCE = {
  mode: "offline",
  memoryMode: "autonomous-delivery",
  ceiling: "autonomous-delivery",
  arms: ["off", "product", "oracle"],
  answerModelId: "memory-lab-answerer",
  learnModelId: "memory-lab-learner",
};

// The group entry a sealed run writes for one repetition: the same figures as `units` per-unit
// entries, as sums and counts.
function groupEntry(repetition, { units, precision, recall, answer, abstain, unrelated }) {
  const pass = (ok) => (ok ? units : 0);
  const metricOf = (name, value) => ({ name, value });
  return {
    name: `holdout:preference:de:product:r${String(repetition)}:group`,
    passed: true,
    evidence: `units=${String(units)} failed=0`,
    metrics: [
      metricOf("units", units),
      metricOf("precisionSum", precision * units),
      metricOf("precisionCount", units),
      metricOf("recallSum", recall * units),
      metricOf("recallCount", units),
      metricOf("answerPassed", pass(answer)),
      metricOf("answerTotal", units),
      metricOf("abstainPassed", pass(abstain)),
      metricOf("abstainTotal", units),
      metricOf("noMemoryPassed", pass(unrelated)),
      metricOf("noMemoryTotal", units),
    ],
  };
}

function unitEntries(repetition, units, { precision, recall, answer, abstain, unrelated }) {
  return Array.from({ length: units }, (_, unit) => [
    storeEntry(repetition, precision, recall, unit),
    probeEntry(repetition, answer, "answer", "related", unit),
    probeEntry(repetition, abstain, "abstain", "unknown", unit),
    probeEntry(repetition, unrelated, "no-memory", "unrelated", unit),
  ]).flat();
}

// A run with the given product figures; `jitter` spreads repetitions around the mean, `repetitions`
// is how many there are (three by default: a band needs at least three), `units` how many scenarios
// each repetition has (twelve, like the curated set; one unit would make every change a one-unit
// change), `abstainPasses` and `unrelatedPasses` are the pass/fail of the abstention and the
// no-memory probe per repetition, and `grouped` writes the group entries of a sealed run instead.
const RUN_DEFAULTS = Object.freeze({
  jitter: 0,
  hard: {},
  corpus: CORPUS,
  repetitions: 3,
  units: 12,
  grouped: false,
  abstainPasses: [true, true, true],
  unrelatedPasses: [true, true, true],
  failedUnits: 0,
  sealed: false,
});
const FIGURE_KEYS = new Set(["precision", "recall", "answer", ...Object.keys(RUN_DEFAULTS)]);

// Splits a run spec into the figures the files are built from and the provenance of its manifest.
function splitSpec(spec) {
  const figures = { ...RUN_DEFAULTS };
  const provenance = {};
  for (const [key, value] of Object.entries(spec))
    if (FIGURE_KEYS.has(key)) figures[key] = value;
    else provenance[key] = value;
  return { figures, provenance };
}

function writeRun(root, name, spec) {
  const { figures: run, provenance } = splitSpec(spec);
  const {
    precision,
    recall,
    answer,
    jitter,
    hard,
    corpus,
    repetitions,
    units,
    grouped,
    abstainPasses,
    unrelatedPasses,
    failedUnits,
    sealed,
  } = run;
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  const spread = [precision - jitter, precision, precision + jitter].slice(0, repetitions);
  const figures = (value, index) => ({
    units,
    precision: clamp(value),
    recall: clamp(recall + value - precision),
    answer: answer >= 0.5,
    abstain: abstainPasses[index] ?? true,
    unrelated: unrelatedPasses[index] ?? true,
  });
  const scorecard = {
    evalSchemaVersion: "1",
    generatedAt: 0,
    totals: { scenarios: 6, passed: 0, failed: 0 },
    scenarios: spread.flatMap((value, index) =>
      grouped
        ? [groupEntry(index, figures(value, index))]
        : unitEntries(index, units, figures(value, index)),
    ),
  };
  const share = (passes) => passes.slice(0, repetitions).filter(Boolean).length / repetitions;
  const summary = {
    schemaVersion: 1,
    runs: repetitions,
    failedUnits,
    byArm: [
      {
        key: "product",
        runs: repetitions,
        precision,
        recall,
        answerAccuracy: answer,
        abstention: share(abstainPasses),
        noMemoryOnUnrelated: share(unrelatedPasses),
        counters: counters(hard),
      },
    ],
    byArmAndLanguage: [],
    byArmAndClass: [],
    hardCountersViolated: Object.values(hard).some((value) => value > 0),
    oraclePreconditionFailures: [],
    unmeasured: [],
  };
  const manifest = {
    count: 1,
    setDigest: corpus,
    metadata: {
      productHead: "0123456789abcdef",
      ...PROVENANCE,
      ...provenance,
      sealed,
    },
  };
  writeFileSync(join(directory, "scorecard.json"), JSON.stringify(scorecard));
  writeFileSync(join(directory, "summary.json"), JSON.stringify(summary));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  return readRun(directory);
}

describe("memory lab comparison", () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("computes the noise band as the half range of repetitions", () => {
    expect(noiseBand([0.6, 0.7, 0.8])).toEqual({ mean: 0.7, halfRange: 0.1, repetitions: 3 });
    expect(noiseBand([null, undefined])).toEqual({ mean: null, halfRange: null, repetitions: 0 });
  });

  it("refuses to compare runs of different corpus versions", () => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-compare-"));
    const base = writeRun(root, "base", { precision: 0.6, recall: 0.8, answer: 0.5 });
    const other = writeRun(root, "other", {
      precision: 0.9,
      recall: 0.8,
      answer: 0.5,
      corpus: "b".repeat(64),
    });
    expect(() => compareRuns(base, other)).toThrow(/different corpus/u);
  });

  it("reports a gain beyond the noise band and one within it", () => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-compare-"));
    const base = writeRun(root, "base", { precision: 0.6, recall: 0.8, answer: 0.5, jitter: 0.02 });
    const better = writeRun(root, "better", {
      precision: 0.9,
      recall: 0.81,
      answer: 1,
      jitter: 0.02,
    });
    const comparison = compareRuns(base, better);
    const precision = comparison.deltas.find((row) => row.metric === "precision");
    const recall = comparison.deltas.find((row) => row.metric === "recall");
    expect(precision.beyondNoise).toBe(true);
    expect(recall.beyondNoise).toBe(false);
    expect(comparison.improved).toEqual(["precision", "answerAccuracy"]);
    expect(renderComparison(comparison, "gemma development")).toMatch(
      /^gemma development: precision 0.6->0.9 \(beyond noise/u,
    );
  });
});

describe("memory lab comparison of every judged metric", () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });
  const base = { precision: 0.6, recall: 0.8, answer: 0.5, jitter: 0.02 };

  function pair(baseline, candidate) {
    root = mkdtempSync(join(tmpdir(), "memory-lab-compare-"));
    return [
      writeRun(root, "base", { ...base, ...baseline }),
      writeRun(root, "cand", { ...base, ...candidate }),
    ];
  }

  it("takes abstention and no-memory from the probes of each repetition, so they can worsen", () => {
    // The failure this pins: only store metrics and answer probes had per-repetition values, so the
    // band of these two stayed unknown and a collapse of either could never be called a worsening.
    const [baseline, candidate] = pair(
      {},
      { abstainPasses: [false, false, false], unrelatedPasses: [false, false, false] },
    );
    const comparison = compareRuns(baseline, candidate);
    const abstention = comparison.deltas.find((row) => row.metric === "abstention");
    const unrelated = comparison.deltas.find((row) => row.metric === "noMemoryOnUnrelated");
    expect(abstention).toMatchObject({ before: 1, after: 0, delta: -1, beyondNoise: true });
    expect(unrelated).toMatchObject({ before: 1, after: 0, delta: -1, beyondNoise: true });
    expect(comparison.worsened).toEqual(["abstention", "noMemoryOnUnrelated"]);
  });

  it("calls a small change in abstention noise when the repetitions already spread that far", () => {
    const [baseline, candidate] = pair(
      { abstainPasses: [true, false, true] },
      { abstainPasses: [true, true, false] },
    );
    const abstention = compareRuns(baseline, candidate).deltas.find(
      (row) => row.metric === "abstention",
    );
    expect(abstention.delta).toBe(0);
    expect(abstention.beyondNoise).toBe(false);
  });

  it("has no band, and says so, when a run has a single repetition", () => {
    // The failure this pins: pooling one value of each run gives half the difference as "noise", so
    // any change at all looked beyond it.
    const [baseline, candidate] = pair({ repetitions: 1 }, { repetitions: 1, precision: 0.9 });
    const comparison = compareRuns(baseline, candidate);
    const precision = comparison.deltas.find((row) => row.metric === "precision");
    expect(precision).toMatchObject({ delta: 0.3, halfRange: null, beyondNoise: null });
    expect(comparison.improved).toEqual([]);
    expect(comparison.worsened).toEqual([]);
    expect(comparison.noiseUnknown).toContain("precision");
    expect(renderComparison(comparison, "gemma development")).toContain(
      "precision 0.6->0.9 (noise unknown)",
    );
  });

  const precisionOf = (baseline, candidate) =>
    compareRuns(baseline, candidate).deltas.find((row) => row.metric === "precision");

  it("needs three repetitions in each run, not only in both together", () => {
    const [baseline, candidate] = pair({ repetitions: 3 }, { repetitions: 1, precision: 0.9 });
    expect(precisionOf(baseline, candidate).beyondNoise).toBeNull();
    // The failure this pins: two repetitions had a band, and the half range of two values is a coin
    // flip (under no true change a metric crossed it in about one comparison of seven).
    const [twoBase, twoCandidate] = pair({ repetitions: 2 }, { repetitions: 2, precision: 0.9 });
    expect(precisionOf(twoBase, twoCandidate).beyondNoise).toBeNull();
    const [threeBase, threeCandidate] = pair(
      { repetitions: 3 },
      { repetitions: 3, precision: 0.9 },
    );
    expect(precisionOf(threeBase, threeCandidate).beyondNoise).toBe(true);
  });

  it("does not call a change that one unit alone could produce progress", () => {
    // Twelve units, repetitions that agree exactly: the band pooled over both runs is half the
    // difference itself, so without a floor every difference would be beyond it; a gain smaller
    // than one unit in twelve (0.0833) is not progress.
    const [baseline, candidate] = pair({ jitter: 0 }, { jitter: 0, precision: 0.65 });
    const small = precisionOf(baseline, candidate);
    expect(small).toMatchObject({ delta: 0.05, halfRange: 0.025, minimumDetectable: 0.0833 });
    expect(small.beyondNoise).toBe(false);
    expect(renderComparison(compareRuns(baseline, candidate), "x")).toContain(
      "precision 0.6->0.65 (within noise ±0.025, one-unit floor 0.0833)",
    );
    const [base, larger] = pair({ jitter: 0 }, { jitter: 0, precision: 0.8 });
    expect(precisionOf(base, larger).beyondNoise).toBe(true);
  });

  it("reads the group entries of a sealed run as the same per-repetition values as unit entries", () => {
    const [unitBase, unitCandidate] = pair(
      {},
      { precision: 0.9, abstainPasses: [true, false, true] },
    );
    const perUnit = compareRuns(unitBase, unitCandidate);
    root = mkdtempSync(join(tmpdir(), "memory-lab-compare-"));
    const groupedBase = writeRun(root, "gbase", { ...base, grouped: true });
    const groupedCandidate = writeRun(root, "gcand", {
      ...base,
      grouped: true,
      precision: 0.9,
      abstainPasses: [true, false, true],
    });
    const grouped = compareRuns(groupedBase, groupedCandidate);
    expect(grouped.deltas).toEqual(perUnit.deltas);
    expect(grouped.deltas.find((row) => row.metric === "abstention").halfRange).toBe(0.5);
  });

  it("does not list an unchanged metric as unknown", () => {
    const [baseline, candidate] = pair({ repetitions: 1 }, { repetitions: 1 });
    expect(compareRuns(baseline, candidate).noiseUnknown).toEqual([]);
  });

  it("names the provenance fields in which two runs differ, arms in any order", () => {
    const [baseline, candidate] = pair(
      {},
      { ceiling: "governed-assist", arms: ["oracle", "product", "off"] },
    );
    expect(provenanceDifferences(baseline, candidate)).toEqual(["ceiling"]);
    expect(renderComparison(compareRuns(baseline, candidate), "x")).toContain(
      "the runs differ in ceiling",
    );
  });
});

describe("memory lab progress judgement", () => {
  let root;
  const before = { precision: 0.6, recall: 0.8, answer: 0.5, jitter: 0.02 };
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  // The holdout part is made of sealed runs; `baseline` and `candidate` override either run.
  // The models come from the manifests, so each label's runs name their own answerer and learner.
  function pairs(spec) {
    root = mkdtempSync(join(tmpdir(), "memory-lab-judge-"));
    return spec.map(({ model, part, baseline = {}, candidate = {} }) => {
      const sealed = part === "holdout";
      const models = { answerModelId: `${model}-answerer`, learnModelId: `${model}-learner` };
      return {
        model,
        part,
        baseline: writeRun(root, `${model}-${part}-base`, {
          ...before,
          sealed,
          ...models,
          ...baseline,
        }),
        candidate: writeRun(root, `${model}-${part}-cand`, {
          ...before,
          sealed,
          ...models,
          ...candidate,
        }),
      };
    });
  }

  it("refuses two holdout pairs that measured the same models, whatever their labels say", () => {
    const same = { answerModelId: "one-answerer", learnModelId: "one-learner" };
    expect(() =>
      judgeProgress(
        pairs([
          {
            model: "gemma",
            part: "holdout",
            baseline: same,
            candidate: { ...same, precision: 0.9 },
          },
          {
            model: "qwen",
            part: "holdout",
            baseline: same,
            candidate: { ...same, precision: 0.9 },
          },
        ]),
      ),
    ).toThrow(/measured the same models by their manifests/u);
  });

  it("needs the same metric to improve on both models", () => {
    const judgement = judgeProgress(
      pairs([
        { model: "gemma", part: "holdout", candidate: { precision: 0.9 } },
        { model: "qwen", part: "holdout", candidate: { recall: 0.95 } },
      ]),
    );
    expect(judgement.progress).toBe(false);
    expect(judgement.improvedOnTwoModels).toEqual([]);
    expect(judgement.reasons).toContain(
      "no metric improved on the holdout on two models by their manifests",
    );
  });

  it("accepts a gain on the holdout on two models with hard counters at zero", () => {
    const judgement = judgeProgress(
      pairs([
        { model: "gemma", part: "holdout", candidate: { precision: 0.9 } },
        { model: "qwen", part: "holdout", candidate: { precision: 0.85 } },
      ]),
    );
    expect(judgement.progress).toBe(true);
    expect(renderJudgement(judgement)).toMatch(/^PROGRESS\n/u);
  });

  it("rejects a change that improves only the development corpus", () => {
    const judgement = judgeProgress(
      pairs([
        { model: "gemma", part: "development", candidate: { precision: 0.95 } },
        { model: "qwen", part: "development", candidate: { precision: 0.95 } },
        { model: "gemma", part: "holdout", candidate: { precision: 0.61 } },
        { model: "qwen", part: "holdout", candidate: { precision: 0.6 } },
      ]),
    );
    expect(judgement.progress).toBe(false);
    expect(judgement.reasons).toContain(
      "no metric improved on the holdout on two models by their manifests",
    );
  });

  it("rejects a change that helps one model and harms another", () => {
    const judgement = judgeProgress(
      pairs([
        { model: "gemma", part: "holdout", candidate: { precision: 0.9 } },
        { model: "qwen", part: "holdout", candidate: { precision: 0.3 } },
      ]),
    );
    expect(judgement.progress).toBe(false);
    expect(judgement.reasons.join(" ")).toMatch(/worsened beyond the noise band: precision/u);
  });

  it("rejects any hard counter above zero whatever the metrics say", () => {
    const judgement = judgeProgress(
      pairs([
        { model: "gemma", part: "holdout", candidate: { precision: 1, hard: { credential: 1 } } },
        { model: "qwen", part: "holdout", candidate: { precision: 1 } },
      ]),
    );
    expect(judgement.progress).toBe(false);
    expect(judgement.reasons).toContain("a hard counter is above zero");
  });

  it("rejects a candidate below an agreed target", () => {
    const judgement = judgeProgress(
      pairs([
        { model: "gemma", part: "holdout", candidate: { precision: 0.9 } },
        { model: "qwen", part: "holdout", candidate: { precision: 0.9 } },
      ]),
      { recall: 0.95 },
    );
    expect(judgement.progress).toBe(false);
    expect(judgement.reasons).toContain("a metric is below its target");
  });
});

describe("memory lab judgement refusals", () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });
  const before = { precision: 0.6, recall: 0.8, answer: 0.5, jitter: 0.02 };

  function holdoutPairs(patch, { sealed = true, which = "candidate" } = {}) {
    root = mkdtempSync(join(tmpdir(), "memory-lab-refuse-"));
    return ["gemma", "qwen"].map((model) => ({
      model,
      part: "holdout",
      baseline: writeRun(root, `${model}-base`, {
        ...before,
        answerModelId: `${model}-answerer`,
        learnModelId: `${model}-learner`,
        sealed: which === "baseline" ? sealed : true,
      }),
      candidate: writeRun(root, `${model}-cand`, {
        ...before,
        answerModelId: `${model}-answerer`,
        learnModelId: `${model}-learner`,
        precision: 0.9,
        sealed: which === "candidate" ? sealed : true,
        ...patch,
      }),
    }));
  }

  it.each([
    ["mode", { mode: "live" }],
    ["memoryMode", { memoryMode: "governed-assist" }],
    ["ceiling", { ceiling: "governed-assist" }],
    ["arms", { arms: ["product"] }],
    ["answerModelId", { answerModelId: "another-answerer" }],
    ["learnModelId", { learnModelId: "another-learner" }],
    ["budgetTokens", { budgetTokens: 2400 }],
    ["brokenLearner", { brokenLearner: "credential" }],
    ["configDigest", { configDigest: "b".repeat(64) }],
    ["foldedKeys", { foldedKeys: ["KEIKO_MEMORY_MODE"] }],
    ["instrumentDigest", { instrumentDigest: "c".repeat(64) }],
  ])("refuses a pair whose runs differ in %s", (field, patch) => {
    expect(() => judgeProgress(holdoutPairs(patch))).toThrow(
      new RegExp(`refusing to judge gemma holdout: the runs differ in ${field}`, "u"),
    );
  });

  it("refuses a holdout pair whose candidate was not a sealed run", () => {
    expect(() => judgeProgress(holdoutPairs({}, { sealed: false }))).toThrow(
      /refusing to judge gemma holdout: the candidate run is not a sealed holdout run/u,
    );
  });

  it("refuses a holdout pair whose baseline was not a sealed run", () => {
    expect(() => judgeProgress(holdoutPairs({}, { sealed: false, which: "baseline" }))).toThrow(
      /the baseline run is not a sealed holdout run/u,
    );
  });

  it("refuses a holdout pair from runs that do not say whether they were sealed", () => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-refuse-"));
    const run = (name) => {
      const written = writeRun(root, name, { ...before, sealed: true });
      delete written.manifest.metadata.sealed;
      return written;
    };
    expect(() =>
      judgeProgress([{ model: "gemma", part: "holdout", baseline: run("a"), candidate: run("b") }]),
    ).toThrow(/not a sealed holdout run/u);
  });

  it("asks for no seal on the development part", () => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-refuse-"));
    const judgement = judgeProgress([
      {
        model: "gemma",
        part: "development",
        baseline: writeRun(root, "base", { ...before }),
        candidate: writeRun(root, "cand", { ...before, precision: 0.9 }),
      },
    ]);
    expect(judgement.progress).toBe(false);
    expect(judgement.reasons).toContain("no holdout comparison");
  });

  it("does not call a change progress while its noise band is unknown", () => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-refuse-"));
    const single = (name, model, patch) =>
      writeRun(root, name, {
        ...before,
        repetitions: 1,
        sealed: true,
        answerModelId: `${model}-answerer`,
        learnModelId: `${model}-learner`,
        ...patch,
      });
    const judgement = judgeProgress(
      ["gemma", "qwen"].map((model) => ({
        model,
        part: "holdout",
        baseline: single(`${model}-base`, model, {}),
        candidate: single(`${model}-cand`, model, { precision: 0.9 }),
      })),
    );
    expect(judgement.progress).toBe(false);
    expect(judgement.reasons).toContain("noise band unknown: precision");
    expect(judgement.reasons).toContain(
      "no metric improved on the holdout on two models by their manifests",
    );
  });

  it("does not call a change progress when a run has units that could not be measured", () => {
    const judgement = judgeProgress(holdoutPairs({ failedUnits: 1 }).map((pair) => ({ ...pair })));
    expect(judgement.progress).toBe(false);
    expect(judgement.reasons).toContain("a run has failed units");
  });

  it("rejects a collapse of abstention beyond the noise band on one model", () => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-refuse-"));
    const judgement = judgeProgress(
      ["gemma", "qwen"].map((model) => {
        const models = { answerModelId: `${model}-answerer`, learnModelId: `${model}-learner` };
        return {
          model,
          part: "holdout",
          baseline: writeRun(root, `${model}-base`, { ...before, sealed: true, ...models }),
          candidate: writeRun(root, `${model}-cand`, {
            ...before,
            precision: 0.9,
            sealed: true,
            ...models,
            ...(model === "qwen" ? { abstainPasses: [false, false, false] } : {}),
          }),
        };
      }),
    );
    expect(judgement.progress).toBe(false);
    expect(judgement.reasons.join(" ")).toMatch(/worsened beyond the noise band: abstention/u);
  });
});

describe("memory lab trend ledger", () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("renders a row and appends it inside the markers, adding the header once", () => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-ledger-"));
    const run = writeRun(root, "run", {
      precision: 0.6875,
      recall: 0.8571,
      answer: 0.7778,
      hard: { "forgotten-returned": 1 },
    });
    const row = ledgerRow(run, "2026-11-03", "gemma-4-31b-it");
    expect(row).toBe(
      "| 2026-11-03 | 012345678 | aaaaaaaaaaaa | gemma-4-31b-it | autonomous-delivery/autonomous-delivery, offline | 3 | 0.6875 | 0.8571 | 0.7778 | 1 | 1 | forgotten-returned=1 |",
    );
    const empty = `# Doc\n\n${LEDGER_START}\n${LEDGER_END}\n`;
    const once = appendLedgerRows(empty, [row]);
    expect(once).toContain(`${LEDGER_HEADER.join("\n")}\n${row}\n${LEDGER_END}`);
    const twice = appendLedgerRows(once, [row.replace("2026-11-03", "2026-11-04")]);
    expect(twice.split(LEDGER_HEADER[0])).toHaveLength(2);
    expect(twice).toContain("| 2026-11-04 |");
    expect(() => appendLedgerRows("no markers", [row])).toThrow(/markers/u);
  });
});

describe("memory lab headroom", () => {
  it("reads load and memory as percentages", () => {
    const reading = headroomReading();
    expect(reading.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(reading.memoryPercent).toBeGreaterThanOrEqual(0);
    expect(reading.memoryPercent).toBeLessThanOrEqual(100);
  });
});
