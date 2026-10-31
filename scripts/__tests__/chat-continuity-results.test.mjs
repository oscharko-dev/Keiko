import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  writeContinuityReport,
  continuityAnalysisIdentity,
} from "../testing/coding-workbench-lab/chat-continuity-report.mjs";
import {
  CONTINUITY_LAB_MODELS,
  summarizeContinuityRun,
  compareContinuityRuns,
} from "../testing/coding-workbench-lab/chat-continuity-results.mjs";
import { continuityCorpusManifest } from "../testing/coding-workbench-lab/chat-continuity-corpus.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function files() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-continuity-report-"));
  directories.push(directory);
  const baseline = join(directory, "baseline.json"),
    output = join(directory, "report.json");
  const run = fixture();
  run.privateContent = "SYNTHETIC_PRIVATE_ANSWER_CANARY";
  writeFileSync(baseline, JSON.stringify(run));
  return { directory, baseline, output };
}

function probes(cycles) {
  return ["control", ...Array.from({ length: cycles }, () => "cycle"), "restart"].map((phase) => ({
    phase,
    score: { validJson: true, correct: 9, total: 9 },
  }));
}

function fixture() {
  return {
    status: "completed",
    models: [...CONTINUITY_LAB_MODELS],
    configurationDigest: "a".repeat(64),
    hardware: { arch: "arm64", platform: "darwin", memoryBytes: 1024, cpus: 4 },
    policy: "Synthetic data only.",
    corpus: continuityCorpusManifest(),
    requiredCycles: 10,
    requiredDuration: 7200000,
    repetitions: 5,
    updatedAt: "1970-01-01T03:00:00.000Z",
    campaign: CONTINUITY_LAB_MODELS.flatMap((model) =>
      ["plain", "grounded"].map((kind) => ({
        model,
        kind,
        repetition: "long",
        cycles: 10,
        startedAt: 0,
        failures: 0,
        probes: probes(10),
      })),
    ),
    ledger: CONTINUITY_LAB_MODELS.flatMap((model) =>
      Array.from({ length: 5 }, (_, repetition) => ({
        id: `${model}:plain:${repetition}:repetition-result`,
        model,
        kind: "plain",
        repetition,
        cycles: 1,
        elapsedMs: 1,
        failures: 0,
        probes: probes(1),
      })),
    ),
  };
}

describe("model-separated native continuity results", () => {
  it("qualifies the declared fixture without inventing a global production quality grade", () => {
    const report = summarizeContinuityRun(fixture());
    expect(report.fixtureQualification).toBe("passed");
    expect(report.globalSystemScore).toBeNull();
    expect(report.lanes).toHaveLength(4);
    expect(report.lanes[0].postCompaction).toEqual({
      answers: 10,
      correct: 90,
      questions: 90,
      observedScore0to10: 10,
    });
  });

  it("keeps a failing Qwen visible even when every other lane is perfect", () => {
    const run = fixture();
    run.campaign[2].probes[10].score.correct = 0;
    const report = summarizeContinuityRun(run);
    expect(report.fixtureQualification).toBe("incomplete");
    expect(report.lanes[0].postCompaction.observedScore0to10).toBe(10);
    expect(report.lanes[2].postCompaction.observedScore0to10).toBe(9);
    expect(report.lanes[2].lastPostCompaction.observedScore0to10).toBe(0);
  });

  it("keeps interrupted data measurable and missing measurements unknown", () => {
    const run = fixture();
    run.status = "terminated";
    run.campaign = run.campaign.slice(0, 1);
    run.ledger = [];
    const report = summarizeContinuityRun(run);
    expect(report.fixtureQualification).toBe("incomplete");
    expect(report.lanes[0].postCompaction.observedScore0to10).toBe(10);
    expect(report.lanes[2].postCompaction.observedScore0to10).toBeNull();
    expect(report.repetitions[0]).toMatchObject({ planned: 5, observed: 0, passed: 0 });
  });

  it("does not qualify smaller smoke bounds as the full longitudinal fixture", () => {
    const run = fixture();
    run.requiredDuration = 0;
    expect(summarizeContinuityRun(run).fixtureQualification).toBe("incomplete");
  });

  it.each(["missing-restart", "execution-error", "duplicate-repeat", "bad-score", "bad-status"])(
    "handles %s without a false pass",
    (kind) => {
      const run = fixture();
      if (kind === "missing-restart") run.campaign[0].probes.pop();
      if (kind === "execution-error") run.campaign[0].failures = 1;
      if (kind === "duplicate-repeat") run.ledger[1].repetition = 0;
      if (kind === "bad-score") run.campaign[0].probes[0].score.correct = 10;
      if (kind === "bad-status") run.status = "untrusted raw content";
      if (new Set(["duplicate-repeat", "bad-score", "bad-status"]).has(kind))
        expect(() => summarizeContinuityRun(run)).toThrow(TypeError);
      else expect(summarizeContinuityRun(run).fixtureQualification).toBe("incomplete");
    },
  );
});

describe("paired before/after comparison", () => {
  it("reports the observed delta per model without averaging away regressions", () => {
    const before = fixture(),
      after = fixture();
    before.campaign[2].probes[10].score.correct = 0;
    const report = compareContinuityRuns(before, after);
    expect(report.lanes[2]).toMatchObject({
      coverage: "matched",
      before: 9,
      after: 10,
      observedScoreDelta: 1,
    });
    expect(report.globalSystemScore).toBeNull();
    expect(report.latencyCausality).toBe("not-established-by-recall-ledgers");
  });

  it("does not compare different observed coverage as a measured gain", () => {
    const before = fixture(),
      after = fixture();
    before.campaign[2].probes.pop();
    expect(compareContinuityRuns(before, after).lanes[2].observedScoreDelta).toBeNull();
  });

  it.each(["configurationDigest", "hardware", "policy", "requiredCycles", "repetitions"])(
    "rejects a changed %s",
    (key) => {
      const before = fixture(),
        after = fixture();
      after[key] = key === "configurationDigest" ? "b".repeat(64) : structuredClone(before[key]);
      if (key === "hardware") after.hardware.cpus = 8;
      if (key === "policy") after.policy = "Changed content policy.";
      if (key === "requiredCycles") after.requiredCycles = 11;
      if (key === "repetitions") after.repetitions = 6;
      expect(() => compareContinuityRuns(before, after)).toThrow(
        "lab-environment-or-schedule-mismatch",
      );
    },
  );

  it.each(["initialDigest", "correctionDigest", "questionDigest", "oracleDigest"])(
    "requires common prompts and oracle when %s differs",
    (key) => {
      const before = fixture(),
        after = fixture();
      after.corpus[key] = "b".repeat(64);
      expect(() => compareContinuityRuns(before, after)).toThrow("lab-corpus-or-oracle-mismatch");
    },
  );
});

describe("offline private laboratory reports", () => {
  it.each(["results", "campaign", "corpus", "report"])(
    "binds analysis provenance to the %s module",
    (part) => {
      const original = continuityAnalysisIdentity((url) => url.pathname);
      const changed = continuityAnalysisIdentity((url) =>
        url.pathname.endsWith(`chat-continuity-${part}.mjs`)
          ? `${url.pathname}:changed`
          : url.pathname,
      );
      expect(changed.digest).not.toBe(original.digest);
      expect(continuityAnalysisIdentity((url) => url.pathname)).toEqual(original);
    },
  );
  it("runs the actual CLI successfully without copying private content", () => {
    const paths = files();
    const script = fileURLToPath(
      new URL("../testing/coding-workbench-lab/chat-continuity-report.mjs", import.meta.url),
    );
    const stdout = execFileSync(
      process.execPath,
      [script, "--baseline", paths.baseline, "--output", paths.output],
      { encoding: "utf8" },
    );
    expect(JSON.parse(stdout)).toMatchObject({ fixtureQualification: "passed", compared: false });
    expect(readFileSync(paths.output, "utf8")).not.toContain("SYNTHETIC_PRIVATE_ANSWER_CANARY");
    if (process.platform !== "win32") expect(statSync(paths.output).mode & 0o777).toBe(0o600);
  });

  it("refuses to replace an original ledger or an existing report", () => {
    const paths = files(),
      original = readFileSync(paths.baseline, "utf8");
    expect(() =>
      writeContinuityReport({ baseline: paths.baseline, output: paths.baseline }),
    ).toThrow();
    expect(readFileSync(paths.baseline, "utf8")).toBe(original);
    writeContinuityReport(paths);
    expect(() => writeContinuityReport(paths)).toThrow();
  });

  it("refuses incompatible oracles before writing a comparison", () => {
    const paths = files(),
      candidate = join(paths.directory, "candidate.json"),
      run = fixture();
    run.corpus.oracleDigest = "b".repeat(64);
    writeFileSync(candidate, JSON.stringify(run));
    expect(() => writeContinuityReport({ ...paths, candidate })).toThrow(
      "lab-corpus-or-oracle-mismatch",
    );
    expect(existsSync(paths.output)).toBe(false);
  });

  it("reports malformed JSON without echoing its input", () => {
    const paths = files();
    writeFileSync(paths.baseline, "SYNTHETIC_INVALID_PRIVATE_CANARY");
    expect(() => writeContinuityReport(paths)).toThrow("invalid-lab-ledger-json");
  });
});
