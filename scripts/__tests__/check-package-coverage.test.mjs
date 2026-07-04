import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  aggregatePackageCoverage,
  buildCoverageBaseline,
  buildFileFloors,
  collectFileLinePercents,
  evaluateFileFloors,
  evaluatePackageCoverage,
  listPackages,
} from "../check-package-coverage.mjs";

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
    const baseline = buildCoverageBaseline({ target: 85, metric: "lines", packages: current });

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
      target: 85,
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
      target: 85,
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
      target: 85,
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
    const baseline = buildCoverageBaseline({ target: 85, metric: "lines", packages: current });

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
      target: 85,
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
  it("collects normalized per-file line percentages from raw v8 summaries", () => {
    const root = "/repo";
    const percents = collectFileLinePercents(root, [
      {
        total: file(0, 0),
        [join(root, "packages/keiko-a/src/hot.ts")]: file(3, 100),
        [join(root, "packages/keiko-a/src/covered.ts")]: file(95, 100),
      },
    ]);
    expect(percents["packages/keiko-a/src/hot.ts"]).toBe(3);
    expect(percents["packages/keiko-a/src/covered.ts"]).toBe(95);
    expect(percents.total).toBeUndefined();
  });

  it("records floors only for files at or below the threshold, with headroom", () => {
    const floors = buildFileFloors(
      {
        "packages/keiko-a/src/hot.ts": 40,
        "packages/keiko-a/src/ok.ts": 90,
        "packages/keiko-a/src/zero.ts": 0,
      },
      50,
    );
    expect(floors).toEqual({
      "packages/keiko-a/src/hot.ts": 39.5,
      "packages/keiko-a/src/zero.ts": 0,
    });
    expect(floors["packages/keiko-a/src/ok.ts"]).toBeUndefined();
  });

  it("passes when a floored file holds or improves and tolerates platform noise", () => {
    const evaluations = evaluateFileFloors({
      fileLinePercents: { "packages/keiko-a/src/hot.ts": 40.1 },
      fileFloors: { "packages/keiko-a/src/hot.ts": 40 },
    });
    expect(evaluations).toEqual([
      { file: "packages/keiko-a/src/hot.ts", floor: 40, current: 40.1, passes: true, reason: "ok" },
    ]);
  });

  it("fails a floored file that regresses beyond the epsilon", () => {
    const evaluations = evaluateFileFloors({
      fileLinePercents: { "packages/keiko-a/src/hot.ts": 30 },
      fileFloors: { "packages/keiko-a/src/hot.ts": 40 },
    });
    expect(evaluations[0]).toMatchObject({ passes: false, reason: "regressed", current: 30 });
  });

  it("fails a floored file that vanished from the summary (rename/delete without floor update)", () => {
    const evaluations = evaluateFileFloors({
      fileLinePercents: {},
      fileFloors: { "packages/keiko-a/src/gone.ts": 40 },
    });
    expect(evaluations[0]).toMatchObject({ passes: false, reason: "missing", current: null });
  });

  it("embeds recorded file floors in a regenerated baseline", () => {
    const baseline = buildCoverageBaseline({
      target: 85,
      metric: "lines",
      packages: [],
      fileFloors: { "packages/keiko-a/src/hot.ts": 39.5 },
    });
    expect(baseline.fileFloors).toEqual({ "packages/keiko-a/src/hot.ts": 39.5 });
  });
});
