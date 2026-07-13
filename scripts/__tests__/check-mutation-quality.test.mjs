import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  changedLineRanges,
  evaluateMutationBaseline,
  evaluateScopedMutation,
  executeMutationQualityCli,
  mutationFingerprint,
  mutantTouchesChangedLine,
  parseChangedLineRanges,
  runMutationQuality,
  summarizeMutationReport,
} from "../check-mutation-quality.mjs";

const mutant = (status, overrides = {}) => ({
  id: "1",
  location: { end: { column: 2, line: 1 }, start: { column: 1, line: 1 } },
  mutatorName: "BooleanLiteral",
  replacement: "false",
  static: false,
  status,
  ...overrides,
});
const report = (...mutants) => ({ files: { "src/security.ts": { mutants } } });

describe("mutation quality", () => {
  it("summarizes detected and undetected mutants", () => {
    expect(summarizeMutationReport(report(mutant("Killed"), mutant("Timeout")))).toMatchObject({
      score: 100,
      summary: { killed: 1, timeout: 1, total: 2 },
    });
    expect(summarizeMutationReport({})).toMatchObject({ score: 0, summary: { total: 0 } });
    expect(
      summarizeMutationReport(report(mutant("Killed"), mutant("Ignored", { static: true }))),
    ).toMatchObject({ errors: [], score: 100, summary: { killed: 1, total: 1 } });
    expect(
      summarizeMutationReport({
        files: { "src/empty.ts": {}, "src/unknown.ts": { mutants: [{}] } },
      }).errors,
    ).toEqual(["src/unknown.ts:unknown:missing"]);
  });

  it("creates stable, location-bound debt fingerprints", () => {
    const value = mutant("Survived");
    expect(mutationFingerprint("src/security.ts", value)).toBe(
      mutationFingerprint("src/security.ts", { ...value, status: "NoCoverage" }),
    );
    expect(mutationFingerprint("src/other.ts", value)).not.toBe(
      mutationFingerprint("src/security.ts", value),
    );
    expect(mutationFingerprint("src/security.ts", { ...value, static: undefined })).toEqual(
      mutationFingerprint("src/security.ts", value),
    );
  });

  it("returns mutation debt in deterministic order without mutating report data", () => {
    const first = mutant("Survived", { id: "2", replacement: "true" });
    const second = mutant("NoCoverage", { id: "1", replacement: "false" });
    const data = report(first, second);
    const originalMutants = [...data.files["src/security.ts"].mutants];
    const result = summarizeMutationReport(data);
    expect(result.debt).toEqual([...result.debt].sort((left, right) => left.localeCompare(right)));
    expect(data.files["src/security.ts"].mutants).toEqual(originalMutants);
  });

  it("accepts unchanged historical debt and improvements", () => {
    const debt = mutant("Survived");
    const baseline = {
      acceptedDebt: [mutationFingerprint("src/security.ts", debt)],
      maximumNoCoverage: 0,
      maximumSurvived: 1,
      minimumScore: 50,
    };
    expect(evaluateMutationBaseline(report(mutant("Killed"), debt), baseline).failures).toEqual([]);
    expect(evaluateMutationBaseline(report(mutant("Killed")), baseline).failures).toEqual([]);
    expect(
      evaluateMutationBaseline(report(mutant("Killed")), {
        maximumNoCoverage: 0,
        maximumSurvived: 0,
        minimumScore: 100,
      }).failures,
    ).toEqual([]);
  });

  it("rejects new debt, score regressions, count regressions, and unknown results", () => {
    const result = evaluateMutationBaseline(
      report(
        mutant("Survived"),
        mutant("Survived", { id: "2", replacement: "true" }),
        mutant("NoCoverage", { id: "3", replacement: "undefined" }),
        mutant("CompileError", { id: "4" }),
      ),
      { acceptedDebt: [], maximumNoCoverage: 0, maximumSurvived: 0, minimumScore: 60 },
    );
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("regressed below baseline"),
        expect.stringContaining("new mutation debt"),
        "Surviving mutant count regressed.",
        "No-coverage mutant count regressed.",
        expect.stringContaining("Unexpected mutant result"),
      ]),
    );
  });

  it("requires scoped critical changes to have score, mutants, and zero debt", () => {
    expect(evaluateScopedMutation(report(mutant("Killed"))).failures).toEqual([]);
    expect(evaluateScopedMutation(report()).failures).toContain(
      "Scoped mutation run produced no mutants.",
    );
    const failures = evaluateScopedMutation(
      report(mutant("Killed"), mutant("Survived"), mutant("NoCoverage")),
    ).failures;
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("below 80%"),
        "Critical changed code has surviving mutants.",
        "Critical changed code has mutants without test coverage.",
      ]),
    );
  });

  it("filters scoped mutation results to changed lines only", () => {
    const changed = mutant("Killed", {
      location: { end: { column: 4, line: 12 }, start: { column: 1, line: 12 } },
    });
    const legacy = mutant("Survived", {
      location: { end: { column: 4, line: 80 }, start: { column: 1, line: 80 } },
    });
    const changedLines = new Map([["src/security.ts", [{ end: 14, start: 10 }]]]);

    expect(evaluateScopedMutation(report(changed, legacy), { changedLines })).toMatchObject({
      current: { score: 100, summary: { killed: 1, survived: 0, total: 1 } },
      failures: [],
    });
    expect(evaluateScopedMutation(report(legacy), { changedLines })).toMatchObject({
      current: { score: 0, summary: { killed: 0, survived: 0, total: 0 } },
      failures: [],
    });
    expect(evaluateScopedMutation(report(legacy), { changedLines: new Map() }).failures).toContain(
      "Scoped mutation run produced no mutants.",
    );
  });

  it("parses changed line ranges and matches multi-line mutants", () => {
    const ranges = parseChangedLineRanges(
      [
        "diff --git a/src/security.ts b/src/security.ts",
        "@@ -3 +3,2 @@",
        "@@ -10,2 +11 @@",
        "diff --git a/src/other.ts b/src/other.ts",
        "@@ -1 +0,0 @@",
      ].join("\n"),
    );

    expect(ranges.get("src/security.ts")).toEqual([
      { end: 4, start: 3 },
      { end: 11, start: 11 },
    ]);
    expect(ranges.get("src/other.ts")).toEqual([]);
    expect(
      mutantTouchesChangedLine(
        "src/security.ts",
        mutant("Killed", { location: { end: { line: 12 }, start: { line: 10 } } }),
        ranges,
      ),
    ).toBe(true);
    expect(mutantTouchesChangedLine("src/missing.ts", mutant("Killed"), ranges)).toBe(false);
  });

  it("loads changed line ranges through the bounded git diff", async () => {
    const execute = vi.fn(() => "diff --git a/src/security.ts b/src/security.ts\n@@ -1 +1 @@\n");
    const read = vi.fn(async () => JSON.stringify(report(mutant("Killed"))));
    const log = vi.fn();

    expect(changedLineRanges("base", "head", execute)).toEqual(
      new Map([["src/security.ts", [{ end: 1, start: 1 }]]]),
    );
    await runMutationQuality({ base: "base", execute, head: "head", log, mode: "scoped", read });
    expect(execute).toHaveBeenCalledWith(
      "/usr/bin/git",
      ["diff", "--unified=0", "--diff-filter=ACMR", "base...head"],
      { encoding: "utf8" },
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("100.00%"));
  });

  it("loads reports and baselines and logs a passing result", async () => {
    const data = report(mutant("Killed"));
    const read = vi.fn(async (path) =>
      JSON.stringify(
        path.includes("baseline")
          ? { acceptedDebt: [], maximumNoCoverage: 0, maximumSurvived: 0, minimumScore: 100 }
          : data,
      ),
    );
    const log = vi.fn();
    await runMutationQuality({ log, read });
    await runMutationQuality({ mode: "scoped", read });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("100.00%"));
  });

  it("reads report files through the default adapter and defaults CLI mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keiko-mutation-quality-"));
    const reportPath = join(dir, "report.json");
    const baselinePath = join(dir, "baseline.json");
    await writeFile(reportPath, JSON.stringify(report(mutant("Killed"))));
    await writeFile(
      baselinePath,
      JSON.stringify({
        acceptedDebt: [],
        maximumNoCoverage: 0,
        maximumSurvived: 0,
        minimumScore: 100,
      }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runMutationQuality({ baselinePath, reportPath });
      const run = vi.fn(async () => undefined);
      await executeMutationQualityCli({ run });
      expect(run).toHaveBeenCalledWith({ mode: "baseline" });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("100.00%"));
    } finally {
      log.mockRestore();
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("selects scoped mode and reports CLI failures without rejecting", async () => {
    const error = vi.fn();
    const setExitCode = vi.fn();
    const run = vi.fn(async () => {
      throw new Error("fixture failure");
    });
    await executeMutationQualityCli({ args: ["--scoped"], error, run, setExitCode });
    expect(run).toHaveBeenCalledWith({ mode: "scoped" });
    expect(error).toHaveBeenCalledWith("mutation-quality: FAIL - fixture failure");
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it("passes scoped base and head arguments to the runner", async () => {
    const run = vi.fn(async () => undefined);
    await executeMutationQualityCli({
      args: ["--scoped", "--base", "base", "--head", "head"],
      run,
    });
    expect(run).toHaveBeenCalledWith({ base: "base", head: "head", mode: "scoped" });
  });

  it("uses default CLI error adapters for non-Error failures", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitCode = process.exitCode;
    try {
      await executeMutationQualityCli({
        args: [],
        run: async () => {
          throw "string failure";
        },
      });
      expect(error).toHaveBeenCalledWith("mutation-quality: FAIL - string failure");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
      error.mockRestore();
    }
  });
});
