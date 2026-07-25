import { describe, expect, it, vi } from "vitest";

import {
  coverageVerdict,
  newCodeCoverage,
  parseDiffAddedLines,
  parseLcov,
} from "../lib/new-code-coverage.mjs";
import {
  evaluate,
  main,
  normaliseLcovPaths,
  readReports,
  resolveBaseRef,
  resolveMergeBase,
} from "../check-new-code-coverage.mjs";

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

  it("merges hunks for a path the diff opens twice", () => {
    const diff = ["+++ b/x.ts", "@@ -0,0 +1,1 @@", "+a", "+++ b/x.ts", "@@ -8,0 +9,1 @@", "+b"];
    expect(parseDiffAddedLines(diff.join("\n"))).toEqual(new Map([["x.ts", new Set([1, 9])]]));
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
    expect(report.branches.get(2)).toEqual(
      new Map([
        ["0,0", 1],
        ["0,1", 0],
      ]),
    );
  });

  it("sums hits when a line appears in several concatenated reports", () => {
    const merged = parseLcov(
      ["SF:x.ts", "DA:1,0", "end_of_record", "SF:x.ts", "DA:1,3"].join("\n"),
    );
    expect(merged.get("x.ts").lines.get(1)).toBe(3);
  });

  // Overlapping reports are the normal case: coverage/lcov.info and coverage/ui/lcov.info can both
  // carry the same file. Appending instead of merging double-counted every condition.
  it("merges branch identities across concatenated reports instead of appending", () => {
    const merged = parseLcov(
      [
        "SF:x.ts",
        "BRDA:1,0,0,0",
        "BRDA:1,0,1,2",
        "end_of_record",
        "SF:x.ts",
        "BRDA:1,0,0,3",
        "BRDA:1,0,1,0",
      ].join("\n"),
    );
    expect(merged.get("x.ts").branches.get(1)).toEqual(
      new Map([
        ["0,0", 3],
        ["0,1", 2],
      ]),
    );
  });

  it("ignores records before any source header and malformed lines", () => {
    expect(parseLcov(["DA:1,1", "SF:y.ts", "DA:notanumber,1", "BRDA:x,0,0,1"].join("\n"))).toEqual(
      new Map([["y.ts", { branches: new Map(), lines: new Map() }]]),
    );
  });

  it("counts a DA record without a hit count as zero hits", () => {
    expect(parseLcov(["SF:x.ts", "DA:5"].join("\n")).get("x.ts").lines.get(5)).toBe(0);
  });

  it("treats a BRDA record with missing identity parts as one zero-take branch", () => {
    expect(parseLcov(["SF:x.ts", "BRDA:5"].join("\n")).get("x.ts").branches.get(5)).toEqual(
      new Map([[",", 0]]),
    );
  });

  it("records a non-numeric branch take as not taken", () => {
    expect(
      parseLcov(["SF:x.ts", "BRDA:7,0,0,junk"].join("\n")).get("x.ts").branches.get(7),
    ).toEqual(new Map([["0,0", 0]]));
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

// A file present in two reports must not have its conditions counted twice: the same diff, the same
// coverage, must yield the same percentage no matter how many reports mention the file.
describe("newCodeCoverage is idempotent across overlapping reports", () => {
  const LINES = ["SF:src/a.ts", "DA:2,1", "BRDA:2,0,0,1", "BRDA:2,0,1,-"].join("\n");

  it("counts each condition once", () => {
    const single = newCodeCoverage({
      addedLinesByFile: new Map([["src/a.ts", new Set([2])]]),
      inScope: () => true,
      lcov: parseLcov(LINES),
    });
    const duplicated = newCodeCoverage({
      addedLinesByFile: new Map([["src/a.ts", new Set([2])]]),
      inScope: () => true,
      lcov: parseLcov([LINES, "end_of_record", LINES].join("\n")),
    });
    expect(duplicated.conditions).toBe(single.conditions);
    expect(duplicated.percent).toBe(single.percent);
  });
});

describe("resolveMergeBase", () => {
  it("returns the resolved base", () => {
    expect(resolveMergeBase("origin/dev", () => "abc123\n")).toEqual({ base: "abc123" });
  });

  it("returns an actionable message instead of a git stack trace", () => {
    const resolved = resolveMergeBase("origin/nope", () => {
      throw new Error("fatal: Not a valid object name");
    });
    expect(resolved.base).toBeUndefined();
    expect(resolved.error).toContain('cannot resolve "origin/nope"');
    expect(resolved.error).toContain("--base=");
  });
});

describe("readReports", () => {
  it("merges every present report and names its sources", () => {
    const reports = readReports(
      ["a/lcov.info", "b/lcov.info", "missing/lcov.info"],
      (path) => !path.startsWith("missing"),
      (path) => (path.startsWith("a") ? "SF:src/x.ts\nDA:1,1" : "SF:src/y.ts\nDA:2,0"),
    );
    expect(reports.sources).toEqual(["a/lcov.info", "b/lcov.info"]);
    expect([...reports.lcov.keys()].sort()).toEqual(["src/x.ts", "src/y.ts"]);
  });

  it("is undefined when no report exists, so the caller can say what to run", () => {
    expect(
      readReports(
        ["a/lcov.info"],
        () => false,
        () => "",
      ),
    ).toBeUndefined();
  });

  // The default collaborators read the real filesystem. Any tracked file is a deterministic
  // fixture: text without SF: records parses to an empty report set.
  it("reads through the real filesystem when no collaborators are injected", () => {
    const reports = readReports(["scripts/check-new-code-coverage.mjs"]);
    expect(reports.sources).toEqual(["scripts/check-new-code-coverage.mjs"]);
    expect(reports.lcov.size).toBe(0);
  });

  it("is undefined through the real filesystem when the report is absent", () => {
    expect(readReports(["coverage/keiko-no-such-report.info"])).toBeUndefined();
  });
});

describe("evaluate", () => {
  const lcov = "SF:src/a.ts\nDA:2,1\nDA:3,0";
  const diff = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,0 +2,2 @@", "+one", "+two"].join("\n");
  const run = (args) => (args[0] === "merge-base" ? "base\n" : diff);
  const present = { exists: () => true, read: () => lcov };

  it("fails, with the command to run, when no coverage report exists", () => {
    const verdict = evaluate({ exists: () => false, read: () => "", run });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toContain("no LCOV report found");
    expect(verdict.failures[0]).toContain("test:coverage:scripts");
  });

  it("fails on an unresolvable base ref before it reads any diff", () => {
    const verdict = evaluate({
      ...present,
      run: (args) => {
        if (args[0] === "merge-base") throw new Error("fatal");
        throw new Error("the diff must never be reached");
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toContain("cannot resolve");
  });

  it("reports the ratio and names every uncovered position when under the bar", () => {
    const verdict = evaluate({ ...present, run });
    expect(verdict.ok).toBe(false);
    expect(verdict.summary).toContain("50.0%");
    expect(verdict.failures.join("\n")).toContain("src/a.ts:3 uncovered new line");
  });

  it("passes when the added lines are covered", () => {
    const verdict = evaluate({
      exists: () => true,
      read: () => "SF:src/a.ts\nDA:2,1\nDA:3,4",
      run,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
    expect(verdict.summary).toContain("100.0%");
  });

  it("honours an explicit --base", () => {
    const seen = [];
    evaluate({
      ...present,
      argv: ["--base=feat/x"],
      run: (args) => {
        seen.push(args.join(" "));
        return args[0] === "merge-base" ? "base\n" : diff;
      },
    });
    expect(seen[0]).toBe("merge-base feat/x HEAD");
  });
});

describe("the coverage entry point", () => {
  // Exercises the production `git` collaborator the way the documentation-only entry point does:
  // HEAD against itself is an empty diff, which is deterministic in any checkout.
  it("runs the real git path and passes on an empty change set", () => {
    const logs = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => logs.push(line));
    try {
      main(["--base=HEAD"], {}, { exists: () => true, read: () => "SF:src/a.ts\nDA:1,1" });
    } finally {
      log.mockRestore();
    }
    expect(logs.join("\n")).toContain("no measurable new code");
  });

  it("exits non-zero, naming the command to run, when no report exists", () => {
    const errors = [];
    const exitCodes = [];
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      exitCodes.push(code);
      return undefined;
    });
    const error = vi.spyOn(console, "error").mockImplementation((line) => errors.push(line));
    try {
      main(undefined, undefined, { exists: () => false });
    } finally {
      error.mockRestore();
      exit.mockRestore();
    }
    expect(exitCodes).toEqual([1]);
    expect(errors.join("\n")).toContain("no LCOV report found");
  });
});
