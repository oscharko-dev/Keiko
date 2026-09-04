import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const scanner81PrFullLog = readFileSync(
  resolve(import.meta.dirname, "fixtures", "sonar-analysis", "scanner-8.1-pr-full.txt"),
  "utf8",
);

function freshJavascriptAnalysis(eligible) {
  return [
    "INFO Sensor JavaScript/TypeScript/CSS analysis [javascript]",
    `INFO Hit the cache for 0 out of ${String(eligible)}`,
    `INFO Miss the cache for ${String(eligible)} out of ${String(eligible)}: FILE_CHANGED`,
    "INFO Sensor JavaScript/TypeScript/CSS analysis [javascript] (done)",
  ];
}

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
      "INFO Sensor JavaScript/TypeScript/CSS analysis [javascript]",
      "INFO Hit the cache for 4753 out of 4788",
      "INFO Miss the cache for 35 out of 4788: FILE_CHANGED",
      "INFO Sensor JavaScript/TypeScript/CSS analysis [javascript] (done)",
      'INFO * Files successfully loaded: "8" out of "8"',
      'INFO * Files successfully loaded: "6" out of "6"',
    ].join("\n");

    expect(fullAnalysisEvidenceFailures(incremental)).toEqual([
      "JavaScript/TypeScript cache evidence 4753/4788 hit and 35/4788 missed does not prove an exact fresh analysis",
      "fresh JavaScript/TypeScript breadth 0 eligible and 91 analyzed against 5525 indexed files is below the 80% floor",
      "architecture UDG receipts 14/14 for 2276 source files do not prove a full-project graph",
    ]);
  });

  it("accepts the full-project source breadth emitted by a dev-equivalent analysis", () => {
    const full = [
      "INFO 5525 files indexed (done)",
      ...freshJavascriptAnalysis(4788),
      "INFO 2272 file(s) will be analysed by SonarJasmin.",
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
      ...freshJavascriptAnalysis(100),
      "INFO 100 file(s) will be analysed by SonarJasmin.",
      "INFO 10/100 source files have been analyzed",
      "INFO 100/100 source files have been analyzed",
      'INFO * Files successfully loaded: "100" out of "100"',
    ].join("\n");

    expect(fullAnalysisEvidenceFailures(full)).toEqual([]);
  });

  it("rejects an analyzed source total larger than the indexed source inventory", () => {
    const overcounted = [
      "INFO 100 files indexed (done)",
      ...freshJavascriptAnalysis(100),
      "INFO 100 file(s) will be analysed by SonarJasmin.",
      "INFO 101/101 source files have been analyzed",
      'INFO * Files successfully loaded: "100" out of "100"',
    ].join("\n");

    expect(fullAnalysisEvidenceFailures(overcounted)).not.toEqual([]);
  });

  it("accepts a completed source set below the indexed inventory", () => {
    const exclusionAware = [
      "INFO 100 files indexed (done)",
      ...freshJavascriptAnalysis(90),
      "INFO 90/90 source files have been analyzed",
      "INFO 90 file(s) will be analysed by SonarJasmin.",
      'INFO * Files successfully loaded: "90" out of "90"',
    ].join("\n");

    expect(fullAnalysisEvidenceFailures(exclusionAware)).toEqual([]);
  });

  it("rejects a narrow analysis even when its cache and progress receipts are self-consistent", () => {
    const narrow = [
      "INFO 5531 files indexed (done)",
      ...freshJavascriptAnalysis(3),
      "INFO 3/3 source files have been analyzed",
      "INFO 3 file(s) will be analysed by SonarJasmin.",
      'INFO * Files successfully loaded: "3" out of "3"',
    ].join("\n");

    expect(fullAnalysisEvidenceFailures(narrow)).toEqual([
      "fresh JavaScript/TypeScript breadth 3 eligible and 3 analyzed against 5531 indexed files is below the 80% floor",
    ]);
  });

  it("accepts GitHub-prefixed full-analysis receipts from the hosted scanner", () => {
    const hosted = [
      "2026-09-03T06:21:01Z 06:21:01 INFO 5527 files indexed (done)",
      "2026-09-03T06:21:11Z 06:21:11 INFO Sensor JavaScript/TypeScript/CSS analysis [javascript]",
      "2026-09-03T06:24:27Z 06:24:27 INFO Hit the cache for 0 out of 4790",
      "2026-09-03T06:24:27Z 06:24:27 INFO Miss the cache for 4790 out of 4790: FILE_CHANGED [4790/4790]",
      "2026-09-03T06:24:27Z 06:24:27 INFO Sensor JavaScript/TypeScript/CSS analysis [javascript] (done)",
      "2026-09-03T06:24:27Z 06:24:27 INFO 4846/4846 source files have been analyzed",
      "2026-09-03T06:24:27Z 06:24:27 INFO Architecture JS/TS UDG cache: 2277 source file(s) without a UDG",
      "2026-09-03T06:24:27Z 06:24:27 INFO 2273 file(s) will be analysed by SonarJasmin.",
      '2026-09-03T06:27:07Z 06:27:07 INFO Files successfully loaded: "190" out of "190"',
      '2026-09-03T06:27:11Z 06:27:11 INFO Files successfully loaded: "2083" out of "2083"',
    ].join("\n");

    expect(fullAnalysisEvidenceFailures(hosted)).toEqual([]);
  });

  it("accepts Scanner 8.1 PR architecture receipts when the legacy plan is omitted", () => {
    expect(fullAnalysisEvidenceFailures(scanner81PrFullLog)).toEqual([]);
  });

  it.each([
    [
      "a large partial fresh-source inventory",
      scanner81PrFullLog.replaceAll("4799", "4400").replaceAll("4855", "4400"),
    ],
    [
      "zero-source sensor receipts",
      scanner81PrFullLog.replaceAll('"191"', '"0"').replaceAll('"2087"', '"0"'),
    ],
    [
      "a truncated sensor lifecycle",
      scanner81PrFullLog.replace("Sensor TsArchitectureSensor [architecture] (done)\n", ""),
    ],
    [
      "a receipt without its language-specific producer location",
      scanner81PrFullLog.replace(
        'Found 1 potential Udg file location(s) for "js"',
        'Found 1 potential Udg file location(s) for "ts"',
      ),
    ],
    [
      "a receipt without its producer read",
      scanner81PrFullLog.replace(
        "* Reading SonarArchitecture UDG data from directory <redacted>/architecture/js\n",
        "",
      ),
    ],
    [
      "a malformed sensor receipt",
      scanner81PrFullLog.replace(
        'Files successfully loaded: "2087" out of "2087"',
        "Files successfully loaded: malformed",
      ),
    ],
    [
      "a mismatched sensor receipt",
      scanner81PrFullLog.replace(
        'Files successfully loaded: "2087" out of "2087"',
        'Files successfully loaded: "2086" out of "2087"',
      ),
    ],
    [
      "receipts outside the architecture sensors",
      scanner81PrFullLog
        .replaceAll("JsArchitectureSensor", "UnrelatedJsSensor")
        .replaceAll("TsArchitectureSensor", "UnrelatedTsSensor"),
    ],
    [
      "duplicate sensor receipts",
      scanner81PrFullLog.replace(
        'Files successfully loaded: "191" out of "191"',
        'Files successfully loaded: "191" out of "191"\n' +
          'Files successfully loaded: "191" out of "191"',
      ),
    ],
    [
      "stale JavaScript cache evidence",
      scanner81PrFullLog
        .replace("Hit the cache for 0 out of 4799", "Hit the cache for 1 out of 4799")
        .replace(
          "Miss the cache for 4799 out of 4799: FILE_CHANGED [4799/4799]",
          "Miss the cache for 4798 out of 4799: FILE_CHANGED [4798/4799]",
        ),
    ],
    [
      "a missing architecture upload receipt",
      scanner81PrFullLog.replace("Successfully sent architecture data\n", ""),
    ],
  ])("rejects Scanner 8.1 PR evidence with %s", (_name, contents) => {
    expect(fullAnalysisEvidenceFailures(contents)).not.toEqual([]);
  });

  it.each([
    ["an empty log", ""],
    [
      "malformed source progress",
      [
        "INFO 100 files indexed (done)",
        ...freshJavascriptAnalysis(100),
        "INFO Architecture JS/TS UDG cache: 100 source file(s) without a UDG",
        "INFO 100//100 source files have been analyzed",
        'INFO * Files successfully loaded: "100" out of "100"',
      ].join("\n"),
    ],
    [
      "a malformed architecture receipt",
      [
        "INFO 100 files indexed (done)",
        ...freshJavascriptAnalysis(100),
        "INFO Architecture JS/TS UDG cache: 100 source file(s) without a UDG",
        "INFO 100/100 source files have been analyzed",
        'INFO * Files successfully loaded: "100" of "100"',
      ].join("\n"),
    ],
    [
      "hostile numeric values",
      [
        "INFO 9007199254740992 files indexed (done)",
        ...freshJavascriptAnalysis("9007199254740992"),
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
          ...freshJavascriptAnalysis(1),
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
      ...freshJavascriptAnalysis(4788),
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
      ...freshJavascriptAnalysis(4788),
      "INFO 4844/4844 source files have been analyzed",
      "INFO 2272 file(s) will be analysed by SonarJasmin.",
      'INFO * Files successfully loaded: "189" out of "189"',
      'INFO * Files successfully loaded: "2082" out of "2083"',
    ].join("\n");

    expect(fullAnalysisEvidenceFailures(incompleteArchitecture)).toEqual([
      "architecture UDG receipts 2271/2272 for 2272 source files do not prove a full-project graph",
    ]);
  });

  it("requires every architecture receipt to be complete before summing the inventory", () => {
    const offsettingReceipts = [
      "INFO 100 files indexed (done)",
      ...freshJavascriptAnalysis(100),
      "INFO 100/100 source files have been analyzed",
      "INFO 100 file(s) will be analysed by SonarJasmin.",
      'INFO * Files successfully loaded: "51" out of "50"',
      'INFO * Files successfully loaded: "49" out of "50"',
    ].join("\n");

    expect(fullAnalysisEvidenceFailures(offsettingReceipts)).toEqual([
      "architecture UDG receipts 100/100 for 100 source files do not prove a full-project graph",
    ]);
  });

  it("does not replace an explicit zero SonarJasmin plan with the legacy UDG inventory", () => {
    const emptyArchitecturePlan = [
      "INFO 5525 files indexed (done)",
      ...freshJavascriptAnalysis(4788),
      "INFO 4844/4844 source files have been analyzed",
      "INFO Architecture JS/TS UDG cache: 2272 source file(s) without a UDG",
      "INFO 0 file(s) will be analysed by SonarJasmin.",
      'INFO * Files successfully loaded: "189" out of "189"',
      'INFO * Files successfully loaded: "2083" out of "2083"',
    ].join("\n");

    expect(fullAnalysisEvidenceFailures(emptyArchitecturePlan)).toEqual([
      "architecture UDG receipts 2272/2272 for 0 source files do not prove a full-project graph",
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
    ).toThrow("does not prove an exact fresh analysis");
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
