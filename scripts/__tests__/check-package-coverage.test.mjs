import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  aggregatePackageCoverage,
  buildCoverageBaseline,
  evaluatePackageCoverage,
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
    const baseline = JSON.parse(
      readFileSync("docs/qa/package-coverage-baseline.json", "utf8"),
    );

    expect(baseline.packages["keiko-editor"]).toMatchObject({
      files: 4,
      coverage: {
        lines: 100,
        branches: 100,
      },
    });
  });
});
