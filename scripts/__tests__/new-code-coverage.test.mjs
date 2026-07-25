import { describe, expect, it } from "vitest";

import {
  coverageVerdict,
  newCodeCoverage,
  parseDiffAddedLines,
  parseLcov,
} from "../lib/new-code-coverage.mjs";
import { normaliseLcovPaths, resolveBaseRef } from "../check-new-code-coverage.mjs";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,0 +2,3 @@",
  "+const one = 1;",
  "+const two = 2;",
  "+const three = 3;",
  "@@ -10,1 +20,1 @@",
  "-const old = 0;",
  "+const nine = 9;",
].join("\n");

describe("parseDiffAddedLines", () => {
  it("reads added line numbers from the new side of each hunk", () => {
    expect(parseDiffAddedLines(DIFF)).toEqual(new Map([["src/a.ts", new Set([2, 3, 4, 20])]]));
  });

  it("ignores removed lines and counts only the new side", () => {
    const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +1,1 @@", "-gone", "-also gone", "+kept"];
    expect(parseDiffAddedLines(diff.join("\n"))).toEqual(new Map([["x.ts", new Set([1])]]));
  });

  it("skips a deleted file, which has no new side to cover", () => {
    const diff = ["--- a/gone.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-was here"];
    expect(parseDiffAddedLines(diff.join("\n")).size).toBe(0);
  });

  it("returns an empty map for an empty diff", () => {
    expect(parseDiffAddedLines("")).toEqual(new Map());
  });
});

const LCOV = [
  "SF:src/a.ts",
  "DA:2,1",
  "DA:3,0",
  "DA:4,5",
  "BRDA:2,0,0,1",
  "BRDA:2,0,1,-",
  "DA:20,0",
  "end_of_record",
].join("\n");

describe("parseLcov", () => {
  it("reads line hits and branch takes", () => {
    const report = parseLcov(LCOV).get("src/a.ts");
    expect(report.lines.get(3)).toBe(0);
    expect(report.lines.get(4)).toBe(5);
    expect(report.branches.get(2)).toEqual([1, 0]);
  });

  it("sums hits when a line appears in several concatenated reports", () => {
    const merged = parseLcov(
      ["SF:x.ts", "DA:1,0", "end_of_record", "SF:x.ts", "DA:1,3"].join("\n"),
    );
    expect(merged.get("x.ts").lines.get(1)).toBe(3);
  });

  it("ignores records before any source header and malformed lines", () => {
    expect(parseLcov(["DA:1,1", "SF:y.ts", "DA:notanumber,1", "BRDA:x,0,0,1"].join("\n"))).toEqual(
      new Map([["y.ts", { branches: new Map(), lines: new Map() }]]),
    );
  });
});

describe("newCodeCoverage", () => {
  const all = () => true;

  it("replicates Sonar's ratio over new lines and new conditions", () => {
    const result = newCodeCoverage({
      addedLinesByFile: parseDiffAddedLines(DIFF),
      inScope: all,
      lcov: parseLcov(LCOV),
    });
    // Lines 2,3,4,20 are reported: 2 and 4 covered, 3 and 20 not. Line 2 has two conditions, one
    // taken. So (2 + 1) / (4 + 2) = 50%.
    expect(result.linesToCover).toBe(4);
    expect(result.coveredLines).toBe(2);
    expect(result.conditions).toBe(2);
    expect(result.coveredConditions).toBe(1);
    expect(result.percent).toBe(50);
  });

  it("names every uncovered new line and condition", () => {
    const result = newCodeCoverage({
      addedLinesByFile: parseDiffAddedLines(DIFF),
      inScope: all,
      lcov: parseLcov(LCOV),
    });
    // Ascending by line, and a line's conditions immediately after the line itself.
    expect(result.uncovered).toEqual([
      { kind: "condition", line: 2, path: "src/a.ts" },
      { kind: "line", line: 3, path: "src/a.ts" },
      { kind: "line", line: 20, path: "src/a.ts" },
    ]);
  });

  it("counts nothing for a file outside Sonar's main scope", () => {
    const result = newCodeCoverage({
      addedLinesByFile: parseDiffAddedLines(DIFF),
      inScope: () => false,
      lcov: parseLcov(LCOV),
    });
    expect(result.percent).toBeUndefined();
  });

  it("counts nothing for a changed file the coverage report never mentions", () => {
    const result = newCodeCoverage({
      addedLinesByFile: new Map([["src/untested.ts", new Set([1, 2])]]),
      inScope: all,
      lcov: parseLcov(LCOV),
    });
    expect(result.total).toBe(0);
  });

  it("ignores an added line the report does not consider coverable", () => {
    const result = newCodeCoverage({
      addedLinesByFile: new Map([["src/a.ts", new Set([999])]]),
      inScope: all,
      lcov: parseLcov(LCOV),
    });
    expect(result.total).toBe(0);
  });
});

describe("coverageVerdict", () => {
  it("passes at exactly the minimum", () => {
    expect(coverageVerdict({ percent: 85, total: 10, uncovered: [] }, 85).failures).toEqual([]);
  });

  it("fails below the minimum and names the uncovered positions", () => {
    const verdict = coverageVerdict(
      { percent: 75.6, total: 100, uncovered: [{ kind: "line", line: 7, path: "a.ts" }] },
      85,
    );
    expect(verdict.summary).toContain("75.6%");
    expect(verdict.failures).toEqual(["a.ts:7 uncovered new line"]);
  });

  // A documentation-only change must not read as 0% covered.
  it("passes when there is no measurable new code", () => {
    const verdict = coverageVerdict({ percent: undefined, total: 0, uncovered: [] }, 85);
    expect(verdict.failures).toEqual([]);
    expect(verdict.summary).toContain("no measurable new code");
  });
});

describe("resolveBaseRef", () => {
  it("prefers an explicit --base argument", () => {
    expect(resolveBaseRef(["--base=feat/x"], {})).toBe("feat/x");
  });

  it("falls back to the environment, then to origin/dev", () => {
    expect(resolveBaseRef([], { KEIKO_NEW_CODE_BASE_REF: "origin/main" })).toBe("origin/main");
    expect(resolveBaseRef([], {})).toBe("origin/dev");
  });
});

describe("normaliseLcovPaths", () => {
  it("rewrites absolute report paths to repo-relative ones", () => {
    const entry = { branches: new Map(), lines: new Map() };
    const normalised = normaliseLcovPaths(new Map([["/repo/src/a.ts", entry]]), "/repo");
    expect([...normalised.keys()]).toEqual(["src/a.ts"]);
  });

  it("leaves already-relative paths untouched", () => {
    const entry = { branches: new Map(), lines: new Map() };
    expect([...normaliseLcovPaths(new Map([["src/b.ts", entry]]), "/repo").keys()]).toEqual([
      "src/b.ts",
    ]);
  });
});
