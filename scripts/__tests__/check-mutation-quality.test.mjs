import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  evaluateMutationBaseline,
  evaluateScopedMutation,
  executeMutationQualityCli,
  mutationFingerprint,
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
