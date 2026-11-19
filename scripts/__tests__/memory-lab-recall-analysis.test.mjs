// Synthetic artifact tests only. These perform no product requests or model calls.
import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzePair } from "../testing/memory-lab/analyze-recall.mjs";
import { validateScenario, scenarioSetManifest } from "../testing/memory-lab/scenario.mjs";
import { buildLabScorecard, summarizeLabRun } from "../testing/memory-lab/report.mjs";

const scenario = validateScenario({
  schemaVersion: 1,
  id: "synthetic-recall-control-en",
  language: "en",
  class: "project-decision",
  difficulty: "plain",
  description: "A benign synthetic artifact fixture; it never runs a model or product.",
  truth: [
    {
      key: "release-day",
      seed: "We release on Tuesdays.",
      must: true,
      private: false,
      terms: [["Tuesday*"]],
    },
  ],
  turns: [{ user: "We release on Tuesdays." }],
  probes: [
    {
      id: "positive-lexical",
      question: "When do we release?",
      expect: { kind: "answer", terms: [["Tuesday*"]] },
    },
    {
      id: "positive-paraphrase",
      question: "When do we ship?",
      expect: { kind: "answer", terms: [["Tuesday*"]] },
    },
    {
      id: "negative-near",
      question: "What is the next version number?",
      expect: { kind: "no-memory" },
    },
    { id: "negative-far", question: "What causes rain?", expect: { kind: "no-memory" } },
  ],
});
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const corpus = scenarioSetManifest([scenario]);
const counters = {
  credential: 0,
  identifier: 0,
  "third-party": 0,
  "forgotten-returned": 0,
  "private-in-project": 0,
};
function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value));
}
function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
function makeUnit(arm, repetition) {
  return {
    scenario: scenario.id,
    arm,
    repetition,
    language: "en",
    class: "project-decision",
    difficulty: "plain",
    store: {
      stored: 1,
      live: 1,
      parked: 0,
      forbiddenParked: 0,
      correct: 1,
      precision: 1,
      recall: 1,
      missing: [],
      counters: { ...counters },
      verdicts: [
        { id: "synthetic-record", status: "accepted", verdict: "correct", key: "release-day" },
      ],
      memories: [],
    },
    probes: scenario.probes.map((probe) => ({
      id: probe.id,
      kind: probe.expect.kind,
      passed: true,
      retrievedCount: probe.expect.kind === "answer" ? 1 : 0,
      profileCount: 0,
      suppliedCount: probe.expect.kind === "answer" ? 1 : 0,
      ...(probe.expect.kind === "answer"
        ? { relevantSupplied: true, termsPresent: true }
        : { overApplied: false }),
    })),
    probeCaptures: 0,
    turns: [],
    timing: { learnMs: 0, probeMs: 0 },
    requests: [],
  };
}
function rebuild(dir) {
  const results = readdirSync(join(dir, "runs"))
    .filter((file) => file.endsWith(".json"))
    .map((file) => readJson(join(dir, "runs", file)));
  writeJson(join(dir, "summary.json"), summarizeLabRun(results));
  writeJson(join(dir, "scorecard.json"), buildLabScorecard(results, "2026-11-18T00:00:00.000Z"));
}
function fixture({ mode = "live", arms = ["product"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "keiko-recall-analyzer-selftest-"));
  roots.push(root);
  const scenarioDir = join(root, "scenarios");
  mkdirSync(scenarioDir);
  writeJson(join(scenarioDir, "control.json"), scenario);
  const pair = ["before", "after"].map((side) => {
    const dir = join(root, side);
    mkdirSync(join(dir, "runs"), { recursive: true });
    const metadata = {
      mode,
      productHead: `synthetic-artifact-only-${side}`,
      productDistDigest: "synthetic-artifact-only",
      arms,
      repetitions: 3,
      memoryMode: "autonomous-delivery",
      ceiling: "autonomous-delivery",
      budgetTokens: 1200,
      answerModelId: mode === "live" ? "synthetic-live-answerer" : "memory-lab-answerer",
      learnModelId: mode === "live" ? "synthetic-live-learner" : "memory-lab-learner",
      configDigest: mode === "live" ? "a".repeat(64) : "offline",
      instrumentDigest: "b".repeat(64),
      brokenLearner: null,
      foldedKeys: [],
      sealed: false,
      holdout: false,
    };
    writeJson(join(dir, "manifest.json"), { ...corpus, metadata });
    for (const arm of arms)
      for (let repetition = 0; repetition < 3; repetition += 1) {
        writeJson(
          join(dir, "runs", `${scenario.id}.${arm}.r${repetition}.json`),
          makeUnit(arm, repetition),
        );
      }
    rebuild(dir);
    return dir;
  });
  return { pair, before: pair[0], after: pair[1] };
}
function editManifest(dir, callback) {
  const file = join(dir, "manifest.json");
  const value = readJson(file);
  callback(value);
  writeJson(file, value);
}
function editUnit(dir, repetition, callback, { rebuildReports = true } = {}) {
  const file = join(dir, "runs", `${scenario.id}.product.r${repetition}.json`);
  const value = readJson(file);
  callback(value);
  writeJson(file, value);
  if (rebuildReports) rebuild(dir);
}
const analyze = (pair, options = {}) =>
  analyzePair(...pair, { scenarioDir: join(dirname(pair[0]), "scenarios"), ...options });

test("live pair uses manifest mode/model/config; extra control and three repetitions work without bodies", () => {
  const { pair } = fixture();
  const result = analyze(pair);
  assert.equal(result.interpretation.measurementMode, "live");
  assert.equal(result.interpretation.answerModelId, "synthetic-live-answerer");
  assert.equal(result.source.candidate.answeringKind, "configured-model");
  assert.equal(result.source.candidate.configDigest, "a".repeat(64));
  assert.doesNotMatch(JSON.stringify(result), /scripted|echo/iu);
  assert.equal(result.after.positiveSupplyHits, 6);
  assert.equal(result.after.availableTargetProbeCount, 6);
  assert.equal(result.after.negativeProbeCount, 6);
  assert.equal(result.negativeTransitions.introducedCount, 0);
  assert.deepEqual(result.repetitionsPresent, [0, 1, 2]);
  assert.equal(result.byRepetition[0].after.negativeProbeCount, 2);
});
test("offline pair is explicitly labelled scripted echo", () => {
  const { pair } = fixture({ mode: "offline" });
  const result = analyze(pair);
  assert.equal(result.source.candidate.answeringKind, "scripted-echo");
  assert.match(result.interpretation.answerAndInjectionMetrics, /scripted echo/u);
});

test("does not retain bodies, turn text or answers from input artifacts", () => {
  const { pair } = fixture();
  const marker = "A benign private fixture phrase that must remain inside its input artifact.";
  for (const directory of pair) {
    editUnit(directory, 0, (unit) => {
      unit.store.memories = [{ id: "synthetic-record", body: marker }];
      unit.turns = [{ user: marker }];
      unit.probes[0].answer = marker;
    });
  }
  assert.ok(!JSON.stringify(analyze(pair)).includes(marker));
});

test("separates missing stored targets from conditional retrieval supply", () => {
  const { pair, after } = fixture();
  editUnit(after, 2, (unit) => {
    unit.store.correct = 0;
    unit.store.precision = 0;
    unit.store.recall = 0;
    unit.store.missing = ["release-day"];
    unit.store.verdicts = [];
    for (const probe of unit.probes.filter((entry) => entry.kind === "answer")) {
      probe.relevantSupplied = false;
      probe.retrievedCount = 0;
      probe.suppliedCount = 0;
      probe.passed = false;
    }
  });
  const result = analyze(pair);
  assert.equal(result.after.positiveSupplyHits, 4);
  assert.equal(result.after.positiveProbeCount, 6);
  assert.equal(result.after.availableTargetProbeCount, 4);
  assert.equal(result.after.conditionalSupplyHitRate, 1);
  assert.equal(result.after.positiveMissingStoredTargetCount, 2);
});
test("one introduced FP remains visible when another FP resolves and totals are unchanged", () => {
  const { pair, before, after } = fixture();
  const hit = (id) => (unit) => {
    const probe = unit.probes.find((row) => row.id === id);
    probe.retrievedCount = 1;
    probe.suppliedCount = 1;
    probe.passed = false;
  };
  editUnit(before, 1, hit("negative-near"));
  editUnit(after, 1, hit("negative-far"));
  const result = analyze(pair);
  assert.equal(result.before.negativeRetrievalHits, 1);
  assert.equal(result.after.negativeRetrievalHits, 1);
  assert.equal(result.negativeTransitions.introducedCount, 1);
  assert.equal(result.negativeTransitions.resolvedCount, 1);
  assert.deepEqual(result.negativeTransitions.introducedKeys, [
    `${scenario.id}:product:r1:probe:negative-far`,
  ]);
  assert.deepEqual(result.negativeTransitions.resolvedKeys, [
    `${scenario.id}:product:r1:probe:negative-near`,
  ]);
  assert.equal(result.byRepetition[1].negativeTransitions.introducedCount, 1);
  assert.equal(result.byRepetition[0].negativeTransitions.introducedCount, 0);
});
test("negative answer regression remains visible separately when retrieval stays empty", () => {
  const { pair, after } = fixture();
  editUnit(after, 2, (unit) => {
    const probe = unit.probes.find((row) => row.id === "negative-near");
    probe.passed = false;
    probe.overApplied = true;
  });
  const result = analyze(pair);
  assert.equal(result.negativeTransitions.introducedCount, 0);
  assert.equal(result.negativeAnswerTransitions.introducedCount, 1);
  assert.deepEqual(result.negativeAnswerTransitions.introducedKeys, [
    `${scenario.id}:product:r2:probe:negative-near`,
  ]);
  assert.equal(result.after.negativeAnswerOverApplications, 1);
});

test("keeps an introduced negative hit separate from a resolved different repetition", () => {
  const { pair, before, after } = fixture();
  const hit = (unit) => {
    const probe = unit.probes.find((row) => row.id === "negative-near");
    probe.retrievedCount = 1;
    probe.suppliedCount = 1;
    probe.passed = false;
  };
  editUnit(before, 1, hit);
  editUnit(after, 2, hit);
  const result = analyze(pair);
  assert.equal(result.before.negativeRetrievalHits, result.after.negativeRetrievalHits);
  assert.deepEqual(result.negativeTransitions.introducedKeys, [
    `${scenario.id}:product:r2:probe:negative-near`,
  ]);
  assert.deepEqual(result.negativeTransitions.resolvedKeys, [
    `${scenario.id}:product:r1:probe:negative-near`,
  ]);
});
for (const field of ["answerModelId", "learnModelId", "configDigest", "instrumentDigest"]) {
  test(`refuses mismatched ${field}`, () => {
    const { pair, after } = fixture();
    editManifest(after, (manifest) => {
      manifest.metadata[field] = field.endsWith("Digest") ? "d".repeat(64) : "different-model";
    });
    assert.throws(() => analyze(pair), /Different provenance/u);
  });
}
test("refuses mismatched arm declaration and selected arm", () => {
  const { pair, after } = fixture();
  editManifest(after, (manifest) => {
    manifest.metadata.arms = ["off"];
  });
  assert.throws(() => analyze(pair), /Selected arm product absent/u);
});
test("validates all declared arms and permits explicit off-arm analysis", () => {
  const { pair } = fixture({ arms: ["product", "off"] });
  const result = analyze(pair, { arm: "off" });
  assert.equal(result.arm, "off");
  assert.equal(result.source.candidate.validatedUnitCount, 6);
  assert.ok(result.pairedProbes.every((row) => row.key.includes(":off:")));
});
test("refuses unequal declared repetitions", () => {
  const { pair, after } = fixture();
  editManifest(after, (manifest) => {
    manifest.metadata.repetitions = 2;
  });
  assert.throws(() => analyze(pair), /Different declared repetition counts/u);
});
test("refuses missing raw units even if missing identically in both sides", () => {
  const { pair } = fixture();
  for (const dir of pair) {
    rmSync(join(dir, "runs", `${scenario.id}.product.r1.json`));
    rebuild(dir);
  }
  assert.throws(() => analyze(pair), /Missing run units/u);
});
test("refuses stale summary run count", () => {
  const { pair, after } = fixture();
  const file = join(after, "summary.json");
  const value = readJson(file);
  value.runs = 2;
  writeJson(file, value);
  assert.throws(() => analyze(pair), /Summary run count/u);
});
test("refuses corpus digest mismatch", () => {
  const { pair, after } = fixture();
  editManifest(after, (manifest) => {
    manifest.setDigest = "e".repeat(64);
  });
  assert.throws(() => analyze(pair), /corpus digest differs/u);
});
test("refuses per-scenario digest mismatch even when setDigest was left unchanged", () => {
  const { pair, after } = fixture();
  editManifest(after, (manifest) => {
    manifest.entries[0].digest = "e".repeat(64);
  });
  assert.throws(() => analyze(pair), /scenario digest differs/u);
});
test("refuses incomplete probe inventory", () => {
  const { pair, after } = fixture();
  editUnit(after, 0, (unit) => {
    unit.probes.pop();
  });
  assert.throws(() => analyze(pair), /Incomplete probe inventory/u);
});
test("refuses stale scorecard probe verdict", () => {
  const { pair, after } = fixture();
  editUnit(
    after,
    0,
    (unit) => {
      unit.probes[0].passed = false;
    },
    { rebuildReports: false },
  );
  assert.throws(() => analyze(pair), /stale probe scorecard/u);
});
test("refuses different mode and invalid live config digest", () => {
  const { pair, after } = fixture();
  editManifest(after, (manifest) => {
    manifest.metadata.mode = "offline";
  });
  assert.throws(() => analyze(pair), /Different provenance/u);
  editManifest(after, (manifest) => {
    manifest.metadata.mode = "live";
    manifest.metadata.configDigest = "offline";
  });
  assert.throws(() => analyze(pair), /Live config digest/u);
});
