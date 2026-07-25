import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONSTITUTIONAL_COVERAGE_MINIMUM,
  COVERAGE_BASELINE_SCHEMA_VERSION,
  aggregatePackageCoverage,
  baselineSchemaFailures,
  buildCoverageBaseline,
  buildFileFloors,
  collectFilePercents,
  evaluateFileFloors,
  evaluatePackageCoverage,
  evaluateReleaseTargets,
  listPackages,
  parseArgs,
  selectedMetrics,
} from "../check-package-coverage.mjs";
import { KEIKO_REPOSITORY_GATE_CONTRACT } from "../sonar-quality-gate-contract.mjs";

const COMMITTED_BASELINE = "docs/qa/package-coverage-baseline.json";

// The ten gate scripts whose per-file floors moved out of the vitest `coverage.thresholds` block
// (retired by ADR-0158 D1) into the single floor store. Values are verbatim from the retired block.
const MIGRATED_GATE_SCRIPT_FLOORS = {
  branches: 85,
  functions: 90,
  lines: 90,
  statements: 90,
};
const MIGRATED_GATE_SCRIPTS = [
  "scripts/check-lcov-source-mapping.mjs",
  "scripts/check-mutation-quality.mjs",
  "scripts/check-mutation-scope.mjs",
  "scripts/check-sonar-analysis-log.mjs",
  "scripts/check-sonar-main-quality-gate.mjs",
  "scripts/check-sonar-pr-quality-gate.mjs",
  "scripts/keiko-for-quality-core.mjs",
  "scripts/keiko-for-quality-worker.mjs",
  "scripts/sonar-analysis-scope.mjs",
  "scripts/sonar-quality-gate-contract.mjs",
];

function readCommittedBaseline() {
  return JSON.parse(readFileSync(COMMITTED_BASELINE, "utf8"));
}

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "keiko-coverage-"));
}

function writeJson(root, relative, value) {
  const absolute = join(root, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function metric(covered, total) {
  return { covered, total, pct: total === 0 ? 100 : (covered / total) * 100 };
}

function file(linesCovered, linesTotal) {
  return {
    lines: metric(linesCovered, linesTotal),
    statements: metric(linesCovered, linesTotal),
    branches: metric(linesCovered, linesTotal),
    functions: metric(linesCovered, linesTotal),
  };
}

describe("check-package-coverage", () => {
  let root;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("aggregates coverage by workspace package", () => {
    root = makeRoot();
    writeJson(root, "packages/keiko-a/package.json", { name: "@oscharko-dev/keiko-a" });
    writeJson(root, "packages/keiko-b/package.json", { name: "@oscharko-dev/keiko-b" });
    const summary = {
      total: file(0, 0),
      [join(root, "packages/keiko-a/src/a.ts")]: file(9, 10),
      [join(root, "packages/keiko-a/src/b.ts")]: file(1, 10),
      [join(root, "packages/keiko-b/src/index.ts")]: file(20, 20),
    };

    const records = aggregatePackageCoverage({
      root,
      coverageSummaries: [summary],
      packages: ["keiko-a", "keiko-b"],
    });

    expect(records.map((record) => [record.packageName, record.coverage.lines])).toEqual([
      ["keiko-a", 50],
      ["keiko-b", 100],
    ]);
    expect(records[0].lowFiles[0].file).toBe("packages/keiko-a/src/b.ts");
  });

  it("treats selected packages without loaded source files as uncovered", () => {
    root = makeRoot();
    writeJson(root, "packages/keiko-a/package.json", { name: "@oscharko-dev/keiko-a" });

    const records = aggregatePackageCoverage({
      root,
      coverageSummaries: [{ total: file(0, 0) }],
      packages: ["keiko-a"],
    });

    expect(records[0]).toMatchObject({
      packageName: "keiko-a",
      files: 0,
      coverage: { lines: 0, statements: 0, branches: 0, functions: 0 },
    });
  });

  it("ratchets packages below target at their recorded baseline", () => {
    const current = [
      {
        packageName: "keiko-ui",
        files: 1,
        uncoveredFiles: 0,
        coverage: { lines: 72.72, statements: 70, branches: 60, functions: 70 },
        uncoveredLines: 10,
        totalLines: 100,
        lowFiles: [],
      },
    ];
    const baseline = buildCoverageBaseline({ metric: "lines", packages: current });

    expect(
      evaluatePackageCoverage({
        packages: current,
        baseline,
        target: 85,
        metric: "lines",
        strict: false,
      })[0],
    ).toMatchObject({ status: "ratcheted", passes: true, floor: 72.72 });
  });

  it("fails when a package falls below its ratchet floor", () => {
    const baselinePackage = {
      packageName: "keiko-ui",
      files: 1,
      uncoveredFiles: 0,
      coverage: { lines: 72.72, statements: 70, branches: 60, functions: 70 },
      uncoveredLines: 10,
      totalLines: 100,
      lowFiles: [],
    };
    const baseline = buildCoverageBaseline({
      metric: "lines",
      packages: [baselinePackage],
    });
    const current = [
      { ...baselinePackage, coverage: { ...baselinePackage.coverage, lines: 72.1 } },
    ];

    expect(
      evaluatePackageCoverage({
        packages: current,
        baseline,
        target: 85,
        metric: "lines",
        strict: false,
      })[0],
    ).toMatchObject({ status: "failed", passes: false, floor: 72.72 });
  });

  it("allows tiny non-strict ratchet drift from platform coverage noise", () => {
    const baselinePackage = {
      packageName: "keiko-server",
      files: 1,
      uncoveredFiles: 0,
      coverage: { lines: 87.5, statements: 85.6, branches: 75.75, functions: 92.5 },
      uncoveredLines: 10,
      totalLines: 100,
      lowFiles: [],
    };
    const baseline = buildCoverageBaseline({
      metric: "branches",
      packages: [baselinePackage],
    });
    const current = [
      { ...baselinePackage, coverage: { ...baselinePackage.coverage, branches: 75.71 } },
    ];

    expect(
      evaluatePackageCoverage({
        packages: current,
        baseline,
        target: 85,
        metric: "branches",
        strict: false,
      })[0],
    ).toMatchObject({ status: "ratcheted", passes: true, floor: 75.75 });
  });

  it("still fails substantive regressions below ratchet tolerance", () => {
    const baselinePackage = {
      packageName: "keiko-server",
      files: 1,
      uncoveredFiles: 0,
      coverage: { lines: 87.5, statements: 85.6, branches: 75.75, functions: 92.5 },
      uncoveredLines: 10,
      totalLines: 100,
      lowFiles: [],
    };
    const baseline = buildCoverageBaseline({
      metric: "branches",
      packages: [baselinePackage],
    });
    const current = [
      { ...baselinePackage, coverage: { ...baselinePackage.coverage, branches: 75.5 } },
    ];

    expect(
      evaluatePackageCoverage({
        packages: current,
        baseline,
        target: 85,
        metric: "branches",
        strict: false,
      })[0],
    ).toMatchObject({ status: "failed", passes: false, floor: 75.75 });
  });

  it("strict mode fails below the absolute target even with a lower baseline", () => {
    const current = [
      {
        packageName: "keiko-cli",
        files: 1,
        uncoveredFiles: 0,
        coverage: { lines: 84.5, statements: 84, branches: 75, functions: 90 },
        uncoveredLines: 10,
        totalLines: 100,
        lowFiles: [],
      },
    ];
    const baseline = buildCoverageBaseline({ metric: "lines", packages: current });

    expect(
      evaluatePackageCoverage({
        packages: current,
        baseline,
        target: 85,
        metric: "lines",
        strict: true,
      })[0],
    ).toMatchObject({ status: "failed", passes: false, floor: 85 });
  });

  it("ratchets branch coverage independently from the line gate", () => {
    const baselinePackage = {
      packageName: "keiko-ui",
      files: 1,
      uncoveredFiles: 0,
      coverage: { lines: 88, statements: 84, branches: 72.25, functions: 85 },
      uncoveredLines: 12,
      totalLines: 100,
      lowFiles: [],
    };
    const baseline = buildCoverageBaseline({
      metric: "branches",
      packages: [baselinePackage],
    });
    const current = [
      { ...baselinePackage, coverage: { ...baselinePackage.coverage, branches: 72.3 } },
    ];

    expect(
      evaluatePackageCoverage({
        packages: current,
        baseline,
        target: 85,
        metric: "branches",
        strict: false,
      })[0],
    ).toMatchObject({ status: "ratcheted", passes: true, floor: 72.25 });
  });

  it("enrolls keiko-editor in the committed coverage baseline", () => {
    // GEN-TEST-COVERAGE-002: assert ENROLLMENT + well-formed metrics rather than a hardcoded
    // files/percent snapshot. The old pin (files:4, lines:100) went stale the moment the package grew
    // — pinning exact regenerated numbers is exactly the staleness this step is closing. The reality
    // guard below proves no package is silently dropped; this proves keiko-editor carries real floors.
    const baseline = JSON.parse(readFileSync("docs/qa/package-coverage-baseline.json", "utf8"));
    const editor = baseline.packages["keiko-editor"];

    expect(editor).toBeDefined();
    expect(editor.files).toBeGreaterThan(0);
    expect(typeof editor.coverage.lines).toBe("number");
    expect(typeof editor.coverage.branches).toBe("number");
  });
});

// GEN-TEST-COVERAGE-002 / GEN-SYNTH-COVERAGE-003: the committed baseline was frozen since v0.2.0 and
// silently dropped keiko-sandbox — a measured package protected by no floor. This reality guard fails
// the instant the baseline and the real workspace drift, so exclusions must be explicit and reviewed
// rather than accreting silently behind a green gate.
describe("coverage baseline reality guard", () => {
  // Packages intentionally NOT gated by the package-coverage baseline, each with a recorded reason.
  // A package may be added here ONLY with a justification — never to hide a coverage gap.
  const INTENTIONALLY_UNGATED = new Map([
    // (empty) — keiko-sandbox is now enrolled in the baseline; add future exclusions here WITH a reason.
  ]);

  it("has no stale entries (every baseline package still exists in packages/)", () => {
    const baseline = JSON.parse(readFileSync("docs/qa/package-coverage-baseline.json", "utf8"));
    const realPackages = new Set(listPackages(process.cwd()));
    const stale = Object.keys(baseline.packages).filter((name) => !realPackages.has(name));
    expect(stale).toEqual([]);
  });

  it("covers every workspace package (no silent omissions)", () => {
    const baseline = JSON.parse(readFileSync("docs/qa/package-coverage-baseline.json", "utf8"));
    const baselineNames = new Set(Object.keys(baseline.packages));
    const missing = listPackages(process.cwd()).filter(
      (name) => !baselineNames.has(name) && !INTENTIONALLY_UNGATED.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("enrolls keiko-sandbox (regression guard for the historically-dropped package)", () => {
    const baseline = JSON.parse(readFileSync("docs/qa/package-coverage-baseline.json", "utf8"));
    expect(baseline.packages["keiko-sandbox"]).toBeDefined();
    expect(typeof baseline.packages["keiko-sandbox"].coverage.lines).toBe("number");
  });
});

// GEN-TEST-COVERAGE-003: per-file line floors surface critical files (0-8% requirements-ingestion,
// verification monitor, workspace fs, governed-handoff, memory-handlers) that hide behind green
// PACKAGE averages. The floors ratchet those files so they cannot regress further.
describe("per-file coverage floors", () => {
  const ratcheted = (lines) => ({ governance: "ratcheted", tolerance: 0.5, lines });
  const absolute = (metrics) => ({ governance: "absolute", tolerance: 0, ...metrics });

  it("collects all four per-file metrics from raw v8 summaries", () => {
    const root = "/repo";
    const percents = collectFilePercents(root, [
      {
        total: file(0, 0),
        [join(root, "packages/keiko-a/src/hot.ts")]: file(3, 100),
        [join(root, "packages/keiko-a/src/covered.ts")]: file(95, 100),
      },
    ]);
    expect(percents["packages/keiko-a/src/hot.ts"]).toEqual({
      lines: 3,
      statements: 3,
      branches: 3,
      functions: 3,
    });
    expect(percents["packages/keiko-a/src/covered.ts"].lines).toBe(95);
    expect(percents.total).toBeUndefined();
  });

  // ADR-0158 D1: the comparison basis is the UNROUNDED percentage. A zero-tolerance floor must not
  // be satisfiable by a rounding step — 89.996% is below a 90 floor and has to stay below it.
  it("keeps percentages unrounded so a zero-tolerance floor cannot be rounded into compliance", () => {
    const root = "/repo";
    const percents = collectFilePercents(root, [
      { [join(root, "packages/keiko-a/src/edge.ts")]: file(89_996, 100_000) },
    ]);
    expect(percents["packages/keiko-a/src/edge.ts"].lines).toBeCloseTo(89.996, 5);
    const evaluations = evaluateFileFloors({
      filePercents: percents,
      fileFloors: { "packages/keiko-a/src/edge.ts": absolute({ lines: 90 }) },
    });
    expect(evaluations[0]).toMatchObject({ passes: false, reason: "regressed" });
  });

  it("records ratcheted floors only for files at or below the threshold, with headroom", () => {
    const floors = buildFileFloors(
      {
        "packages/keiko-a/src/hot.ts": { lines: 40 },
        "packages/keiko-a/src/ok.ts": { lines: 90 },
        "packages/keiko-a/src/zero.ts": { lines: 0 },
      },
      50,
    );
    expect(floors).toEqual({
      "packages/keiko-a/src/hot.ts": ratcheted(39.5),
      "packages/keiko-a/src/zero.ts": ratcheted(0),
    });
    expect(floors["packages/keiko-a/src/ok.ts"]).toBeUndefined();
  });

  // The regeneration path is how a floor could silently disappear: the ten gate scripts sit far
  // above the ratchet threshold, so re-deriving the store from measurement alone would drop every
  // one of them. Absolute entries encode policy, not measurement, and survive regeneration.
  it("carries absolute floors through a regeneration that would otherwise drop them", () => {
    const floors = buildFileFloors(
      {
        "scripts/sonar-analysis-scope.mjs": { lines: 97 },
        "packages/keiko-a/src/hot.ts": { lines: 40 },
      },
      50,
      { "scripts/sonar-analysis-scope.mjs": absolute(MIGRATED_GATE_SCRIPT_FLOORS) },
    );
    expect(floors["scripts/sonar-analysis-scope.mjs"]).toEqual(
      absolute(MIGRATED_GATE_SCRIPT_FLOORS),
    );
    expect(floors["packages/keiko-a/src/hot.ts"]).toEqual(ratcheted(39.5));
  });

  it("passes when a floored file holds or improves and tolerates platform noise", () => {
    const evaluations = evaluateFileFloors({
      filePercents: { "packages/keiko-a/src/hot.ts": { lines: 40.1 } },
      fileFloors: { "packages/keiko-a/src/hot.ts": ratcheted(40) },
    });
    expect(evaluations).toEqual([
      {
        file: "packages/keiko-a/src/hot.ts",
        metric: "lines",
        floor: 40,
        tolerance: 0.5,
        current: 40.1,
        passes: true,
        reason: "ok",
      },
    ]);
  });

  it("fails a floored file that regresses beyond the tolerance", () => {
    const evaluations = evaluateFileFloors({
      filePercents: { "packages/keiko-a/src/hot.ts": { lines: 30 } },
      fileFloors: { "packages/keiko-a/src/hot.ts": ratcheted(40) },
    });
    expect(evaluations[0]).toMatchObject({ passes: false, reason: "regressed", current: 30 });
  });

  it("fails a floored file that vanished from the summary (rename/delete without floor update)", () => {
    const evaluations = evaluateFileFloors({
      filePercents: {},
      fileFloors: { "packages/keiko-a/src/gone.ts": ratcheted(40) },
    });
    expect(evaluations[0]).toMatchObject({ passes: false, reason: "missing", current: null });
  });

  // The reason the vitest `thresholds` block could be retired: the surviving engine expresses all
  // four metrics per file, and each one is judged independently.
  it("enforces every governed metric of an absolute entry independently", () => {
    const evaluations = evaluateFileFloors({
      filePercents: {
        "scripts/gate.mjs": { lines: 99, statements: 99, branches: 84.9, functions: 99 },
      },
      fileFloors: { "scripts/gate.mjs": absolute(MIGRATED_GATE_SCRIPT_FLOORS) },
    });
    expect(evaluations).toHaveLength(4);
    expect(evaluations.filter((entry) => !entry.passes)).toMatchObject([
      { metric: "branches", floor: 85, tolerance: 0, passes: false },
    ]);
  });

  it("embeds recorded file floors in a regenerated baseline", () => {
    const baseline = buildCoverageBaseline({
      metric: "lines",
      packages: [],
      fileFloors: { "packages/keiko-a/src/hot.ts": ratcheted(39.5) },
    });
    expect(baseline.fileFloors).toEqual({ "packages/keiko-a/src/hot.ts": ratcheted(39.5) });
    expect(baseline.schemaVersion).toBe(COVERAGE_BASELINE_SCHEMA_VERSION);
    expect(baseline.target).toBe(CONSTITUTIONAL_COVERAGE_MINIMUM);
  });

  it("parses a boolean flag, an inline `--flag=value` assignment, and space-separated value flags in one pass", () => {
    // Exercises all three token widths the argv loop advances by: a bare boolean flag
    // (--strict, 1 token), an inline assignment (--target=90, 1 token), and
    // space-separated value flags (--metric branches / --package keiko-a, 2 tokens each).
    // A off-by-one in the index advancement would either re-read a flag as its own value
    // or skip the following flag entirely.
    const parsed = parseArgs([
      "--strict",
      "--target=90",
      "--metric",
      "branches",
      "--package",
      "keiko-a",
    ]);

    expect(parsed).toMatchObject({
      strict: true,
      target: 90,
      metric: "branches",
      package: ["keiko-a"],
    });
  });

  it("parses consecutive list-value flags without dropping or duplicating tokens", () => {
    const parsed = parseArgs([
      "--package",
      "keiko-a",
      "--exclude-package",
      "keiko-b",
      "--enforce-file-floors",
      "--coverage",
      "coverage-a.json",
      "--coverage",
      "coverage-b.json",
    ]);

    expect(parsed).toMatchObject({
      package: ["keiko-a"],
      excludePackage: ["keiko-b"],
      enforceFileFloors: true,
      coverage: ["coverage-a.json", "coverage-b.json"],
    });
  });

  it("parses the consolidated evaluation's own flags", () => {
    const parsed = parseArgs([
      "--all-metrics",
      "--enforce-file-floors",
      "--release-target",
      "keiko-ui=88",
      "--release-target=keiko-cli=87",
    ]);

    expect(parsed).toMatchObject({
      allMetrics: true,
      enforceFileFloors: true,
      releaseTargets: [
        { packageName: "keiko-ui", target: 88 },
        { packageName: "keiko-cli", target: 87 },
      ],
    });
    expect(selectedMetrics(parsed)).toEqual(["lines", "statements", "branches", "functions"]);
    expect(selectedMetrics({ allMetrics: false, metric: "branches" })).toEqual(["branches"]);
  });

  it("rejects a malformed release target instead of silently governing nothing", () => {
    expect(() => parseArgs(["--release-target", "keiko-ui"])).toThrow(/Invalid --release-target/u);
    expect(() => parseArgs(["--release-target", "keiko-ui=120"])).toThrow(
      /Invalid --release-target/u,
    );
    expect(() => parseArgs(["--release-target", "=88"])).toThrow(/Invalid --release-target/u);
  });
});

// ADR-0158 D2: the 85-lines ratchet evaluations for keiko-ui and keiko-cli were removed because the
// strict 88/87 release targets dominate them on the same metric. That argument holds only while the
// strict targets actually execute AND actually fail below their number — which is what these pin.
describe("strict release lines targets", () => {
  const packages = [
    { packageName: "keiko-ui", coverage: { lines: 88.91 } },
    { packageName: "keiko-cli", coverage: { lines: 89.74 } },
  ];

  it("passes when both packages hold their release targets", () => {
    expect(
      evaluateReleaseTargets({
        packages,
        releaseTargets: [
          { packageName: "keiko-ui", target: 88 },
          { packageName: "keiko-cli", target: 87 },
        ],
      }),
    ).toMatchObject([
      { packageName: "keiko-ui", passes: true, reason: "ok" },
      { packageName: "keiko-cli", passes: true, reason: "ok" },
    ]);
  });

  // The negative probe the consolidation's dominance argument rests on.
  it("fails keiko-ui below 88 and keiko-cli below 87", () => {
    const evaluations = evaluateReleaseTargets({
      packages: [
        { packageName: "keiko-ui", coverage: { lines: 87.99 } },
        { packageName: "keiko-cli", coverage: { lines: 86.99 } },
      ],
      releaseTargets: [
        { packageName: "keiko-ui", target: 88 },
        { packageName: "keiko-cli", target: 87 },
      ],
    });
    expect(evaluations.every((entry) => entry.passes)).toBe(false);
    expect(evaluations).toMatchObject([
      { packageName: "keiko-ui", passes: false, reason: "below-target", current: 87.99 },
      { packageName: "keiko-cli", passes: false, reason: "below-target", current: 86.99 },
    ]);
  });

  // A summary that never arrived must not read as "target met". The keiko-ui summary now reaches the
  // judging job as a downloaded artifact, so "not measured" is a real, reachable state.
  it("fails closed when the targeted package was not measured at all", () => {
    expect(
      evaluateReleaseTargets({
        packages: [],
        releaseTargets: [{ packageName: "keiko-ui", target: 88 }],
      }),
    ).toMatchObject([{ passes: false, reason: "not-measured", current: null }]);
  });
});

// ADR-0158 D1: the schemaVersion bump exists so a mixed old/new state fails closed rather than
// enforcing half the floors. Every rejection below is a state that would otherwise pass silently.
describe("coverage baseline schema (fail-closed)", () => {
  const valid = {
    schemaVersion: COVERAGE_BASELINE_SCHEMA_VERSION,
    target: CONSTITUTIONAL_COVERAGE_MINIMUM,
    fileFloors: { "a.ts": { governance: "ratcheted", tolerance: 0.5, lines: 40 } },
  };

  it("accepts the governed shape and an absent baseline", () => {
    expect(baselineSchemaFailures(valid)).toEqual([]);
    expect(baselineSchemaFailures(undefined)).toEqual([]);
  });

  it("rejects the retired schema-1 bare-number file floor", () => {
    expect(baselineSchemaFailures({ ...valid, fileFloors: { "a.ts": 40 } })).toEqual([
      expect.stringContaining("retired schema-1 shape"),
    ]);
  });

  it("rejects a stale schemaVersion", () => {
    expect(baselineSchemaFailures({ ...valid, schemaVersion: 1 })).toEqual([
      expect.stringContaining("schemaVersion 1 is not the governed 2"),
    ]);
  });

  it("rejects a target that drifted from the one constitutional minimum", () => {
    expect(baselineSchemaFailures({ ...valid, target: 80 })).toEqual([
      expect.stringContaining("drifted from the one governed minimum"),
    ]);
  });

  it("rejects an entry with no governance, no tolerance, no metric or an out-of-range floor", () => {
    const reject = (entry) => baselineSchemaFailures({ ...valid, fileFloors: { "a.ts": entry } });
    expect(reject({ tolerance: 0.5, lines: 40 })).toEqual([expect.stringContaining("governance")]);
    expect(reject({ governance: "ratcheted", lines: 40 })).toEqual([
      expect.stringContaining("tolerance"),
    ]);
    expect(reject({ governance: "ratcheted", tolerance: 0.5 })).toEqual([
      expect.stringContaining("governs no metric"),
    ]);
    expect(reject({ governance: "absolute", tolerance: 0, lines: 140 })).toEqual([
      expect.stringContaining("invalid lines floor"),
    ]);
  });
});

// Issue #2705: these pins are RELOCATED from `scripts/__tests__/vitest-config-parity.test.mjs`,
// which pinned the same ten floors while they lived in the vitest `coverage.thresholds` block. The
// store moved; the numbers did not, and this is the layer that now owns them.
describe("committed coverage baseline governs the migrated floors", () => {
  it("is exactly the governed schema", () => {
    expect(baselineSchemaFailures(readCommittedBaseline())).toEqual([]);
  });

  it("keeps the constitutional minimum in ONE place", () => {
    expect(readCommittedBaseline().target).toBe(CONSTITUTIONAL_COVERAGE_MINIMUM);
    expect(CONSTITUTIONAL_COVERAGE_MINIMUM).toBe(
      KEIKO_REPOSITORY_GATE_CONTRACT.newCodeCoverageMinimum,
    );
  });

  it("keeps every migrated gate-script floor at its governed value with zero tolerance", () => {
    const { fileFloors } = readCommittedBaseline();
    for (const script of MIGRATED_GATE_SCRIPTS) {
      expect(fileFloors[script], `${script} lost its per-file floor`).toEqual({
        governance: "absolute",
        tolerance: 0,
        ...MIGRATED_GATE_SCRIPT_FLOORS,
      });
    }
  });

  // "No tolerance widens anywhere" is the charter of this consolidation, so it is asserted over the
  // whole store rather than only over the entries a diff happens to touch.
  it("holds every entry at or below its governance's tolerance ceiling", () => {
    const ceilings = { ratcheted: 0.5, absolute: 0 };
    const widened = Object.entries(readCommittedBaseline().fileFloors).filter(
      ([, entry]) => entry.tolerance > ceilings[entry.governance],
    );
    expect(widened).toEqual([]);
  });
});
