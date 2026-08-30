import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONSTITUTIONAL_COVERAGE_MINIMUM,
  COVERAGE_BASELINE_SCHEMA_VERSION,
  PACKAGE_COVERAGE_EXCLUDE,
  PACKAGE_COVERAGE_INCLUDE,
  UI_COVERAGE_EXCLUDE,
  UI_COVERAGE_INCLUDE,
  aggregatePackageCoverage,
  countPackageSourceFiles,
  listPackageSourceFiles,
  baselineSchemaFailures,
  buildCoverageBaseline,
  buildFileFloors,
  collectFilePercents,
  evaluateFileFloors,
  evaluatePackageCoverage,
  evaluateReleaseTargets,
  listPackages,
  parseArgs,
  runCli,
  selectedMetrics,
} from "../check-package-coverage.mjs";
import { KEIKO_REPOSITORY_GATE_CONTRACT } from "../sonar-quality-gate-contract.mjs";

const COMMITTED_BASELINE = "docs/qa/package-coverage-baseline.json";

// The eight gate scripts whose per-file floors moved out of the vitest `coverage.thresholds` block
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
// Returns a mismatch row, or undefined when the entry is consistent (or carries no comparable
// numbers). Extracted so the test body stays under the complexity bar rather than raising it.
function lineConsistencyOf(name, entry) {
  if (typeof entry !== "object" || entry === null) return undefined;
  const { totalLines, uncoveredLines, coverage } = entry;
  const recorded = coverage?.lines;
  const comparable =
    typeof totalLines === "number" &&
    totalLines > 0 &&
    typeof uncoveredLines === "number" &&
    typeof recorded === "number";
  if (!comparable) return undefined;
  const computed = Math.round(((totalLines - uncoveredLines) / totalLines) * 10_000) / 100;
  // The writer rounds to 2dp, so anything beyond half a hundredth is real drift, not rounding.
  if (Math.abs(computed - recorded) <= 0.005) return undefined;
  return { package: name, recorded, computed, totalLines, uncoveredLines };
}

// A baseline entry carries BOTH the raw counts and the rounded percentage, and the writer derives
// all of them from one measurement — so they can only disagree if the file was edited by hand or
// written in two passes. Nothing checked that, and keiko-tools drifted: it recorded 91.53% while its
// own totalLines/uncoveredLines computed 91.66%, and a reviewer had to report it TWICE across two
// rounds because there was no gate to catch it the first time.
//
// The percentage is what a human reads in a review; the counts are what the ratchet compares. When
// they disagree, one of them is lying and nothing says which.
describe("coverage baseline internal consistency", () => {
  it("records a line percentage that matches its own totalLines and uncoveredLines", () => {
    const baseline = JSON.parse(readFileSync("docs/qa/package-coverage-baseline.json", "utf8"));
    const packages = baseline.packages ?? baseline;
    const mismatches = Object.entries(packages)
      .map(([name, entry]) => lineConsistencyOf(name, entry))
      .filter((row) => row !== undefined);
    expect(mismatches).toEqual([]);
  });

  // The committed baseline is consistent today, so the assertion above passes even if
  // `lineConsistencyOf` returned `undefined` unconditionally — it would prove nothing about the
  // detector (PR #3355 review, P2). These fixtures exercise the detector directly, with literal
  // values and no re-derivation of the production formula: every expected number is written out.
  it.each([
    // 100 lines, 10 uncovered -> 90.00, recorded as 85.00: real, reviewable drift.
    [
      "a mismatched recorded percentage",
      { totalLines: 100, uncoveredLines: 10, coverage: { lines: 85 } },
    ],
    // The production shape this gate was written for: keiko-tools recorded 91.53 while its own
    // counts computed 91.66.
    [
      "the keiko-tools drift this gate exists for",
      { totalLines: 10_000, uncoveredLines: 834, coverage: { lines: 91.53 } },
    ],
  ])("rejects %s", (_label, entry) => {
    const row = lineConsistencyOf("fixture", entry);
    expect(row).not.toBeUndefined();
    expect(row?.package).toBe("fixture");
  });

  // The other direction, because a detector that flagged everything would make the suite above
  // vacuous the moment the baseline moved.
  it.each([
    [
      "an exactly consistent entry",
      { totalLines: 100, uncoveredLines: 10, coverage: { lines: 90 } },
    ],
    // 3 of 7 uncovered -> 57.142857…%, which the writer rounds to 57.14: inside the half-hundredth
    // tolerance, so NOT drift.
    [
      "a rounding-boundary entry the writer rounds the same way",
      { totalLines: 7, uncoveredLines: 3, coverage: { lines: 57.14 } },
    ],
    ["an entry carrying no counts", { coverage: { lines: 90 } }],
    ["an entry carrying no recorded percentage", { totalLines: 100, uncoveredLines: 10 }],
    ["an empty entry", {}],
    // totalLines 0 would divide by zero; the guard must decline rather than emit NaN.
    ["a zero-total entry", { totalLines: 0, uncoveredLines: 0, coverage: { lines: 100 } }],
  ])("accepts %s", (_label, entry) => {
    expect(lineConsistencyOf("fixture", entry)).toBeUndefined();
  });

  // Malformed input must not throw: a gate that crashes on a hand-edited baseline stops reporting.
  it.each([
    ["null", null],
    ["a string", "not-an-object"],
    ["a number", 42],
  ])("declines %s without throwing", (_label, entry) => {
    expect(() => lineConsistencyOf("fixture", entry)).not.toThrow();
    expect(lineConsistencyOf("fixture", entry)).toBeUndefined();
  });
});
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

  // KEIKO-0125: enrollment and a well-formed `files` number are not the same claim as "the baseline
  // measured this package". `files` comes from the v8 coverage summary, which only ever contains
  // files a test imported — a source file no test touches is invisible to it. keiko-sandbox recorded
  // files:6 against 9 real sources, so 3 files sat behind a green gate that had never seen them. The
  // three assertions above would all have passed throughout. This one compares the recorded count
  // against a live inventory taken with the coverage run's own include/exclude globs.
  it("records a file count matching a live source inventory (no partial undercount)", () => {
    const baseline = JSON.parse(readFileSync("docs/qa/package-coverage-baseline.json", "utf8"));
    // Filter BEFORE mapping: countPackageSourceFiles walks the package tree, so mapping first would
    // pay for a full walk of every intentionally-ungated package only to discard the result.
    const mismatches = Object.entries(baseline.packages)
      .filter(([name]) => !INTENTIONALLY_UNGATED.has(name))
      .map(([name, entry]) => ({
        package: name,
        recorded: entry.files,
        live: countPackageSourceFiles(process.cwd(), name),
      }))
      .filter(({ recorded, live }) => recorded !== live);

    expect(mismatches).toEqual([]);
  });
});

// AGENTS.md §7: a fixture must never restate a formula the code under test owns. The counting
// helper's include/exclude arrays are a deliberate copy of the coverage run's own globs (a plain
// `.mjs` script cannot import the TS config without pulling in vitest), so this test imports the
// real config and pins the two definitions together. If the coverage run's globs change and the
// helper's copy does not, the live inventory silently starts measuring something else — and the
// reality guard above would keep passing over a wrong answer.
describe("coverage source-glob parity", () => {
  it("counts files with the same include/exclude globs the package coverage run declares", async () => {
    const config = (await import("../../vitest.coverage.packages.config.ts")).default;

    expect(PACKAGE_COVERAGE_INCLUDE).toEqual(config.test.coverage.include);
    expect(PACKAGE_COVERAGE_EXCLUDE).toEqual(config.test.coverage.exclude);
  });

  // keiko-ui is excluded from the package run because its OWN run measures it. Its inventory must
  // therefore follow that config's globs, or the guard compares a real 248-file package against 0.
  it("counts keiko-ui with the globs its own coverage run declares", async () => {
    const config = (await import("../../packages/keiko-ui/vitest.coverage.config.ts")).default;

    expect(UI_COVERAGE_INCLUDE).toEqual(config.test.coverage.include);
    expect(UI_COVERAGE_EXCLUDE).toEqual(config.test.coverage.exclude);
  });

  // Following symlinks (so the inventory matches what the coverage run measures) makes a cycle
  // reachable: a link to an ancestor would recurse until the path or the stack is exhausted, and
  // two links to one directory would list its files twice. Both are fatal to a gate whose job is to
  // produce one honest number, so the walk tracks resolved directories.
  it("terminates on a symlink cycle and counts a repeated target once", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-coverage-symlink-"));
    try {
      const src = join(root, "packages", "keiko-probe", "src");
      mkdirSync(join(src, "nested"), { recursive: true });
      writeFileSync(join(src, "real.ts"), "export const a = 1;\n");
      writeFileSync(join(src, "nested", "deep.ts"), "export const b = 2;\n");
      // Self-link, ancestor-link, and a second link to an already-walked directory.
      symlinkSync(src, join(src, "self-link"), "dir");
      symlinkSync(src, join(src, "nested", "ancestor-link"), "dir");
      symlinkSync(join(src, "nested"), join(src, "nested-again"), "dir");

      const files = listPackageSourceFiles(root, "keiko-probe");

      expect(files).toEqual([
        "packages/keiko-probe/src/nested/deep.ts",
        "packages/keiko-probe/src/real.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes tests, __tests__, support files and configs from the live inventory", () => {
    const files = listPackageSourceFiles(process.cwd(), "keiko-sandbox");

    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => file.startsWith("packages/keiko-sandbox/src/"))).toBe(true);
    expect(files.some((file) => file.includes(".test."))).toBe(false);
    expect(files.some((file) => file.includes("/__tests__/"))).toBe(false);
    expect(files.some((file) => file.endsWith(".config.ts"))).toBe(false);
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

  // A ratchet only turns one way. Deriving from the current measurement alone meant regenerating
  // after a regression wrote a LOWER floor — the one operation the truth model forbids, reachable as
  // a side effect of the command it recommends.
  it("never lowers a ratcheted floor when regenerating after a regression", () => {
    const floors = buildFileFloors({ "a.ts": { lines: 20 } }, 50, { "a.ts": ratcheted(39.5) });
    expect(floors["a.ts"]).toEqual(ratcheted(39.5));
  });

  it("still raises a ratcheted floor when the file improved", () => {
    const floors = buildFileFloors({ "a.ts": { lines: 48 } }, 50, { "a.ts": ratcheted(39.5) });
    expect(floors["a.ts"]).toEqual(ratcheted(47.5));
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

  // The truth model tells operators to add "absolute" entries by hand, so a mistyped metric key is
  // a realistic way to end up with a file that LOOKS governed on a metric nothing evaluates.
  it("rejects an unknown key rather than silently governing less than it appears to", () => {
    expect(
      baselineSchemaFailures({
        ...valid,
        fileFloors: {
          "a.ts": { governance: "absolute", tolerance: 0, lines: 90, lnes: 90 },
        },
      }),
    ).toEqual([expect.stringContaining('unknown key "lnes"')]);
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

// ADR-0158 D2: one process now reaches every coverage verdict, so the CLI layer that composes and
// reports them is load-bearing rather than plumbing. These drive `runCli` end to end over fixture
// evidence: each failure class has to reach a nonzero exit code AND name itself on stderr, because
// a gate that fails silently and a gate that passes are the same thing to CI.
describe("runCli", () => {
  let root;
  let out;
  let err;
  let restore;

  function capture() {
    const previousExitCode = process.exitCode;
    const log = console.log;
    const error = console.error;
    out = [];
    err = [];
    console.log = (message) => out.push(String(message));
    console.error = (message) => err.push(String(message));
    restore = () => {
      console.log = log;
      console.error = error;
      process.exitCode = previousExitCode;
    };
    process.exitCode = undefined;
  }

  function fixture({ lines = 90, floors, extraFiles = {} } = {}) {
    root = makeRoot();
    writeJson(root, "packages/keiko-a/package.json", { name: "@oscharko-dev/keiko-a" });
    writeJson(root, "coverage/packages/coverage-summary.json", {
      total: file(0, 0),
      [join(root, "packages/keiko-a/src/a.ts")]: file(lines, 100),
      ...extraFiles,
    });
    writeJson(root, "packages/keiko-ui/coverage/coverage-summary.json", { total: file(0, 0) });
    writeJson(root, "baseline.json", {
      schemaVersion: COVERAGE_BASELINE_SCHEMA_VERSION,
      target: CONSTITUTIONAL_COVERAGE_MINIMUM,
      metric: "lines",
      packages: {
        "keiko-a": { coverage: { lines: 90, statements: 90, branches: 90, functions: 90 } },
      },
      ...(floors === undefined ? {} : { fileFloors: floors }),
    });
  }

  const run = (...argv) =>
    runCli(["--root", root, "--baseline", join(root, "baseline.json"), ...argv]);

  afterEach(() => {
    restore?.();
    restore = undefined;
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("passes, prints the four-metric table and leaves the exit code clean", async () => {
    fixture({
      floors: {
        "packages/keiko-a/src/a.ts": { governance: "ratcheted", tolerance: 0.5, lines: 80 },
      },
    });
    capture();
    await run("--all-metrics", "--enforce-file-floors", "--release-target", "keiko-a=88");

    expect(process.exitCode).toBeUndefined();
    expect(out.join("\n")).toContain("| Package | Lines | Statements | Branches | Functions |");
    expect(out.filter((line) => line.startsWith("coverage: PASS"))).toHaveLength(4);
    expect(out.join("\n")).toContain("release-target: PASS");
    expect(out.join("\n")).toContain("file-floors: PASS");
  });

  it("fails and names the package when a metric falls below its ratchet floor", async () => {
    fixture({ lines: 70 });
    capture();
    await run("--all-metrics");

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("coverage: FAIL — keiko-a lines is 70%");
  });

  it("fails and names the package when a strict release target is missed", async () => {
    fixture();
    capture();
    await run("--release-target", "keiko-a=95");

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("release-target: FAIL — keiko-a lines is 90%");
  });

  it("fails and names the file when a governed floor regresses", async () => {
    fixture({
      floors: { "packages/keiko-a/src/a.ts": { governance: "absolute", tolerance: 0, lines: 95 } },
    });
    capture();
    await run("--enforce-file-floors");

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("file-floors: FAIL — packages/keiko-a/src/a.ts lines is 90%");
  });

  it("writes a regenerated baseline and a machine-readable report", async () => {
    fixture({ lines: 30 });
    capture();
    await run(
      "--all-metrics",
      "--file-floor-threshold",
      "50",
      "--write-baseline",
      join(root, "written.json"),
      "--json",
      join(root, "report.json"),
    );

    const written = JSON.parse(readFileSync(join(root, "written.json"), "utf8"));
    expect(written.schemaVersion).toBe(COVERAGE_BASELINE_SCHEMA_VERSION);
    expect(written.target).toBe(CONSTITUTIONAL_COVERAGE_MINIMUM);
    expect(written.fileFloors["packages/keiko-a/src/a.ts"]).toEqual({
      governance: "ratcheted",
      tolerance: 0.5,
      lines: 29.5,
    });

    const report = JSON.parse(readFileSync(join(root, "report.json"), "utf8"));
    expect(report.metrics).toEqual(["lines", "statements", "branches", "functions"]);
    expect(report.results.lines[0].packageName).toBe("keiko-a");
    expect(report.fileFloors).toEqual([]);
  });

  // An enforcement pass that governs nothing must not read as a satisfied one: a dropped --baseline
  // in CI wiring would otherwise retire the per-file gate in silence.
  it("refuses to report file-floor PASS when the store governs nothing", async () => {
    fixture();
    capture();

    await expect(run("--enforce-file-floors")).rejects.toThrow(
      /--enforce-file-floors governs no file/u,
    );
  });

  // Judging a run against floors derived from that same run is a tautology, not a gate.
  it("refuses to enforce against a self-generated baseline", async () => {
    fixture({ lines: 30 });
    capture();

    await expect(
      runCli([
        "--root",
        root,
        "--enforce-file-floors",
        "--file-floor-threshold",
        "50",
        "--write-baseline",
        join(root, "written.json"),
      ]),
    ).rejects.toThrow(/--enforce-file-floors governs no file/u);
  });

  it("refuses to run against a baseline that is not the governed schema", async () => {
    fixture();
    writeJson(root, "baseline.json", { schemaVersion: 1, target: 85, packages: {} });
    capture();

    await expect(run()).rejects.toThrow(/coverage baseline is not the governed schema/u);
  });

  it("refuses to run when a coverage summary is missing rather than reporting on nothing", async () => {
    fixture();
    rmSync(join(root, "coverage/packages/coverage-summary.json"));
    capture();

    await expect(run()).rejects.toThrow(/Coverage summary not found/u);
  });
});
