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

function storeEntry(repetition, precision, recall) {
  return {
    name: `scenario-one:product:r${String(repetition)}:store`,
    passed: precision === 1 && recall === 1,
    evidence: "stored=1",
    metrics: [
      { name: "precision", value: precision },
      { name: "recall", value: recall },
    ],
  };
}

function probeEntry(repetition, passed) {
  return {
    name: `scenario-one:product:r${String(repetition)}:probe:related`,
    passed,
    evidence: "kind=answer termsPresent=true",
  };
}

// A run with the given product figures; `jitter` spreads repetitions around the mean.
function writeRun(
  root,
  name,
  { precision, recall, answer, jitter = 0, hard = {}, corpus = CORPUS },
) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  const repetitions = [precision - jitter, precision, precision + jitter];
  const scorecard = {
    evalSchemaVersion: "1",
    generatedAt: 0,
    totals: { scenarios: 6, passed: 0, failed: 0 },
    scenarios: repetitions.flatMap((value, index) => [
      storeEntry(index, clamp(value), clamp(recall + value - precision)),
      probeEntry(index, answer >= 0.5),
    ]),
  };
  const summary = {
    schemaVersion: 1,
    runs: 3,
    byArm: [
      {
        key: "product",
        runs: 3,
        precision,
        recall,
        answerAccuracy: answer,
        abstention: 1,
        noMemoryOnUnrelated: 1,
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
      memoryMode: "autonomous-delivery",
      ceiling: "autonomous-delivery",
      mode: "offline",
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

describe("memory lab progress judgement", () => {
  let root;
  const before = { precision: 0.6, recall: 0.8, answer: 0.5, jitter: 0.02 };
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function pairs(spec) {
    root = mkdtempSync(join(tmpdir(), "memory-lab-judge-"));
    return spec.map(({ model, part, candidate }) => ({
      model,
      part,
      baseline: writeRun(root, `${model}-${part}-base`, before),
      candidate: writeRun(root, `${model}-${part}-cand`, { ...before, ...candidate }),
    }));
  }

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
    expect(judgement.reasons).toContain("improvement on the holdout on fewer than two models");
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
