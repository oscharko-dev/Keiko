import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  executeSonarLogCli,
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
    expect(() => runSonarLogCheck({})).toThrow("--log is required");
  });

  it("adapts CLI input and reports non-Error failures", () => {
    const runs = [];
    executeSonarLogCli({
      argv: ["--log", "/tmp/sonar.log"],
      run: (input) => runs.push(input),
    });
    expect(runs).toEqual([{ path: "/tmp/sonar.log" }]);
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
