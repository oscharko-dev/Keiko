import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  executeSonarLogCli,
  fullAnalysisEvidenceFailures,
  runSonarLogCheck,
  sonarLogFailures,
} from "../check-sonar-analysis-log.mjs";

const scriptPath = resolve(import.meta.dirname, "..", "check-sonar-analysis-log.mjs");

describe("Sonar scanner warning gate", () => {
  it("accepts warning-free scanner output", () => {
    expect(sonarLogFailures("INFO Analysis successful\nDEBUG cache hit\n")).toEqual([]);
  });

  it("rejects known and unknown warning classes without a wildcard allowlist", () => {
    expect(
      sonarLogFailures(
        "WARN Invalid character in source\n[WARN] C# cannot be analyzed\nWARNING future warning\n",
      ),
    ).toEqual([
      "scanner warning: WARN Invalid character in source",
      "scanner warning: [WARN] C# cannot be analyzed",
      "scanner warning: WARNING future warning",
    ]);
  });

  it("exempts only the benign SCM 'changed but without having changed lines' metadata warning", () => {
    const benign =
      "12:00:00.000 WARN  File '/w/packages/keiko-server/src/task-workspace/naming.ts' " +
      "was detected as changed but without having changed lines";
    expect(sonarLogFailures(`INFO Analysis successful\n${benign}\n`)).toEqual([]);
  });

  it("still fails on other warnings emitted alongside the exempt SCM metadata warning", () => {
    const benign =
      "12:00:00.000 WARN  File '/w/a.ts' was detected as changed but without having changed lines";
    const real = "12:00:01.000 WARN Invalid character in source";
    expect(sonarLogFailures(`${benign}\n${real}\n`)).toEqual([
      "scanner warning: 12:00:01.000 WARN Invalid character in source",
    ]);
  });

  it("does not let the SCM exemption swallow a real SCM revision warning", () => {
    expect(sonarLogFailures("WARN SCM revision is missing\n")).not.toEqual([]);
  });

  it("rejects the incremental PR analysis that missed the dev-only architecture failure", () => {
    const incremental = [
      "INFO 5525 files indexed (done)",
      "INFO Sensor cache enabled",
      "INFO Architecture JS/TS UDG cache: 2276 source file(s) without a UDG",
      "INFO 91/91 source files have been analyzed",
      "INFO Hit the cache for 4753 out of 4788",
      'INFO * Files successfully loaded: "8" out of "8"',
      'INFO * Files successfully loaded: "6" out of "6"',
    ].join("\n");

    expect(fullAnalysisEvidenceFailures(incremental)).toEqual([
      "sensor cache remained enabled",
      "largest analyzed source set 91/5525 is not a full-project analysis",
      "architecture UDG receipts 14/14 for 2276 source files do not prove a full-project graph",
    ]);
  });

  it("accepts the full-project source breadth emitted by a dev-equivalent analysis", () => {
    const full = [
      "INFO 5525 files indexed (done)",
      "INFO Architecture JS/TS UDG cache: 2276 source file(s) without a UDG",
      "INFO 16/16 source files have been analyzed",
      "INFO 4844/4844 source files have been analyzed",
      'INFO * Files successfully loaded: "189" out of "189"',
      'INFO * Files successfully loaded: "2083" out of "2083"',
    ].join("\n");

    expect(fullAnalysisEvidenceFailures(full)).toEqual([]);
  });

  it("uses the completed snapshot when Sonar reports progress for one source set", () => {
    const full = [
      "INFO 100 files indexed (done)",
      "INFO Architecture JS/TS UDG cache: 100 source file(s) without a UDG",
      "INFO 10/100 source files have been analyzed",
      "INFO 100/100 source files have been analyzed",
      'INFO * Files successfully loaded: "100" out of "100"',
    ].join("\n");

    expect(fullAnalysisEvidenceFailures(full)).toEqual([]);
  });

  it.each([
    ["an empty log", ""],
    [
      "malformed source progress",
      [
        "INFO 100 files indexed (done)",
        "INFO Architecture JS/TS UDG cache: 100 source file(s) without a UDG",
        "INFO 100//100 source files have been analyzed",
        'INFO * Files successfully loaded: "100" out of "100"',
      ].join("\n"),
    ],
    [
      "a malformed architecture receipt",
      [
        "INFO 100 files indexed (done)",
        "INFO Architecture JS/TS UDG cache: 100 source file(s) without a UDG",
        "INFO 100/100 source files have been analyzed",
        'INFO * Files successfully loaded: "100" of "100"',
      ].join("\n"),
    ],
    [
      "hostile numeric values",
      [
        "INFO 9007199254740992 files indexed (done)",
        "INFO Architecture JS/TS UDG cache: 9007199254740992 source file(s) without a UDG",
        "INFO 9007199254740992/9007199254740992 source files have been analyzed",
        'INFO * Files successfully loaded: "9007199254740992" out of "9007199254740992"',
      ].join("\n"),
    ],
  ])("rejects %s as full-analysis evidence", (_name, contents) => {
    expect(fullAnalysisEvidenceFailures(contents)).not.toEqual([]);
  });

  it("accepts Sonar's singular analyzed-source progress without an ambiguous parser", () => {
    expect(
      fullAnalysisEvidenceFailures(
        [
          "INFO 1 files indexed (done)",
          "INFO Architecture JS/TS UDG cache: 1 source file(s) without a UDG",
          "INFO 1/1 source file has been analyzed",
          'INFO * Files successfully loaded: "1" out of "1"',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("rejects a broad unrelated sensor when the architecture graph remains incremental", () => {
    const narrowArchitecture = [
      "INFO 5525 files indexed (done)",
      "INFO 5044/5044 source files have been analyzed for the text and secrets analysis",
      "INFO Architecture JS/TS UDG cache: 2276 source file(s) without a UDG",
      'INFO * Files successfully loaded: "8" out of "8"',
      'INFO * Files successfully loaded: "6" out of "6"',
    ].join("\n");

    expect(fullAnalysisEvidenceFailures(narrowArchitecture)).toEqual([
      "architecture UDG receipts 14/14 for 2276 source files do not prove a full-project graph",
    ]);
  });

  it("rejects an incomplete architecture receipt even at full breadth", () => {
    const incompleteArchitecture = [
      "INFO 5525 files indexed (done)",
      "INFO 4844/4844 source files have been analyzed",
      "INFO Architecture JS/TS UDG cache: 2276 source file(s) without a UDG",
      'INFO * Files successfully loaded: "189" out of "189"',
      'INFO * Files successfully loaded: "2082" out of "2083"',
    ].join("\n");

    expect(fullAnalysisEvidenceFailures(incompleteArchitecture)).toEqual([
      "architecture UDG receipts 2271/2272 for 2276 source files do not prove a full-project graph",
    ]);
  });

  it("rejects dangerous analyzer states even when the scanner logs them as INFO", () => {
    expect(
      sonarLogFailures(
        "INFO CFamily analysis configuration mode: AutoConfig\n" +
          "INFO Your project contains C# files which cannot be analyzed\n",
      ),
    ).toEqual([
      "forbidden scanner diagnostic: INFO CFamily analysis configuration mode: AutoConfig",
      "forbidden scanner diagnostic: INFO Your project contains C# files which cannot be analyzed",
    ]);
  });

  it.each([
    "WARN Invalid character encountered for encoding UTF-8",
    "WARN File sonar-scanner-cli.zip is bigger than 20MB and removed from analysis scope",
    "WARN The LCOV coverage report does not exist",
    "WARN A file is indexed as both source and test",
    "WARN SCM revision is missing",
    "WARN Could not resolve coverage source path packages/a/src/a.ts",
  ])("rejects governed warning category: %s", (diagnostic) => {
    expect(sonarLogFailures(diagnostic)).not.toEqual([]);
  });

  it("reads the configured log and emits a bounded pass receipt", () => {
    const logs = [];
    expect(
      runSonarLogCheck({
        log: (message) => logs.push(message),
        path: "/tmp/sonar.log",
        read: () => "INFO done\n",
      }),
    ).toEqual([]);
    expect(logs).toEqual(["sonar-analysis-log: PASS - no scanner warnings."]);
    expect(() =>
      runSonarLogCheck({ path: "/tmp/sonar.log", read: () => "WARN missing LCOV\n" }),
    ).toThrow("scanner warning");
    expect(() =>
      runSonarLogCheck({
        path: "/tmp/sonar.log",
        read: () => "INFO 12 files indexed\nINFO 1/1 source files have been analyzed\n",
        requireFullAnalysis: true,
      }),
    ).toThrow("not a full-project analysis");
    expect(() => runSonarLogCheck({})).toThrow("--log is required");
  });

  it("adapts CLI input and reports non-Error failures", () => {
    const runs = [];
    executeSonarLogCli({
      argv: ["--log", "/tmp/sonar.log"],
      run: (input) => runs.push(input),
    });
    expect(runs).toEqual([{ path: "/tmp/sonar.log" }]);
    executeSonarLogCli({
      argv: ["--log", "/tmp/sonar.log", "--require-full-analysis"],
      run: (input) => runs.push(input),
    });
    expect(runs.at(-1)).toEqual({ path: "/tmp/sonar.log", requireFullAnalysis: true });
    const errors = [];
    const exitCodes = [];
    executeSonarLogCli({
      argv: [],
      error: (message) => errors.push(message),
      run: () => {
        throw "redacted";
      },
      setExitCode: (value) => exitCodes.push(value),
    });
    expect(errors).toEqual(["sonar-analysis-log: FAIL - redacted"]);
    expect(exitCodes).toEqual([1]);
  });

  it("executes the real CLI for warning-free and missing-log inputs", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-sonar-log-"));
    const logPath = join(directory, "sonar.log");
    writeFileSync(logPath, "INFO Analysis successful\n", "utf8");
    try {
      const success = spawnSync(process.execPath, [scriptPath, "--log", logPath], {
        encoding: "utf8",
      });
      const failure = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
      expect(success.status).toBe(0);
      expect(success.stdout).toContain("PASS - no scanner warnings");
      expect(failure.status).toBe(1);
      expect(failure.stderr).toContain("--log is required");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("uses process arguments and default runtime adapters", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-sonar-log-"));
    const logPath = join(directory, "sonar.log");
    const argv = process.argv;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    writeFileSync(logPath, "INFO Analysis successful\n", "utf8");
    process.argv = [process.execPath, scriptPath, "--log", logPath];
    try {
      executeSonarLogCli();
      expect(log).toHaveBeenCalledWith("sonar-analysis-log: PASS - no scanner warnings.");
    } finally {
      process.argv = argv;
      log.mockRestore();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("adapts an absent option and Error failures", () => {
    const runs = [];
    executeSonarLogCli({ argv: [], run: (input) => runs.push(input) });
    executeSonarLogCli({ argv: ["--log", "--verbose"], run: (input) => runs.push(input) });
    expect(runs).toEqual([{ path: undefined }, { path: undefined }]);
    const errors = [];
    executeSonarLogCli({
      argv: [],
      error: (message) => errors.push(message),
      run: () => {
        throw new Error("bounded");
      },
      setExitCode: () => undefined,
    });
    expect(errors).toEqual(["sonar-analysis-log: FAIL - bounded"]);
  });

  it("uses default CLI error adapters when the log option is missing", () => {
    const exitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.exitCode = undefined;
    try {
      executeSonarLogCli({ argv: [] });
      expect(error).toHaveBeenCalledWith("sonar-analysis-log: FAIL - --log is required");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
      error.mockRestore();
    }
  });
});
