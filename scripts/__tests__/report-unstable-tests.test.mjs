import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  classify,
  cli,
  executedTestCount,
  explainedVerdicts,
  formatReport,
  main,
  mergeVerdicts,
  playwrightSamples,
  vitestPlan,
  vitestVerdicts,
} from "../report-unstable-tests.mjs";

const ROOT = "/repo";

function vitestReport(files) {
  return {
    testResults: files.map(({ name, status = "passed", tests = [] }) => ({
      name: `${ROOT}/${name}`,
      status,
      assertionResults: tests.map(([fullName, testStatus]) => ({
        fullName,
        status: testStatus,
      })),
    })),
  };
}

describe("vitestVerdicts", () => {
  it("keys each test by its repository path and full name", () => {
    const verdicts = vitestVerdicts(
      vitestReport([{ name: "a.test.ts", tests: [["group adds", "passed"]] }]),
      ROOT,
    );
    expect([...verdicts]).toEqual([["a.test.ts > group adds", "passed"]]);
  });

  it("gives a file that failed to load a verdict of its own", () => {
    const verdicts = vitestVerdicts(
      vitestReport([{ name: "broken.test.ts", status: "failed" }, { name: "empty.test.ts" }]),
      ROOT,
    );
    expect(verdicts.get("broken.test.ts (file)")).toBe("failed");
    expect(verdicts.get("empty.test.ts (file)")).toBe("passed");
  });

  it("records a file-level failure even when the file's tests passed", () => {
    // CodeRabbit on #4513: a failed hook fails the file while its tests report passed.
    const verdicts = vitestVerdicts(
      vitestReport([
        { name: "hook.test.ts", status: "failed", tests: [["adds", "passed"]] },
        { name: "fine.test.ts", tests: [["adds", "passed"]] },
      ]),
      ROOT,
    );
    expect(verdicts.get("hook.test.ts (file)")).toBe("failed");
    expect(verdicts.get("hook.test.ts > adds")).toBe("passed");
    expect(verdicts.has("fine.test.ts (file)")).toBe(false);
    const { failing } = classify(mergeVerdicts([verdicts, verdicts]), 2);
    expect(failing.map(({ id }) => id)).toEqual(["hook.test.ts (file)"]);
  });
});

// The shape a real `playwright test --repeat-each=2 --reporter=json` run reports: every repetition
// is a separate spec entry with one test, and the file-level suite is titled with the file name.
function playwrightReport(statuses) {
  return {
    config: { projects: [{ name: "chromium", repeatEach: statuses.length }] },
    suites: [
      {
        title: "a.spec.ts",
        file: "a.spec.ts",
        specs: [],
        suites: [
          {
            title: "group",
            file: "a.spec.ts",
            specs: statuses.map((status) => ({
              title: "sends @smoke",
              file: "a.spec.ts",
              tests: [{ projectName: "chromium", status }],
            })),
          },
        ],
      },
    ],
  };
}

describe("playwrightSamples", () => {
  it("collects every repetition of a spec under one id", () => {
    const samples = playwrightSamples(playwrightReport(["expected", "unexpected", "expected"]));
    expect([...samples]).toEqual([
      ["a.spec.ts > group > sends @smoke [chromium]", ["passed", "failed", "passed"]],
    ]);
  });

  it("maps Playwright's own flaky and skipped verdicts, and anything unknown to failed", () => {
    const samples = playwrightSamples(playwrightReport(["flaky", "skipped", "interrupted"]));
    expect([...samples.values()][0]).toEqual(["flaky", "skipped", "failed"]);
  });
});

describe("classify", () => {
  const samples = (entries) => new Map(entries);

  it("finds a test that both passed and failed", () => {
    const result = classify(samples([["t", ["passed", "failed", "passed"]]]), 3);
    expect(result.unstable).toEqual([{ id: "t", statuses: ["passed", "failed", "passed"] }]);
    expect(result.failing).toEqual([]);
  });

  it("separates a test that failed every time", () => {
    const result = classify(samples([["t", ["failed", "failed", "failed"]]]), 3);
    expect(result).toEqual({
      unstable: [],
      failing: [{ id: "t", statuses: ["failed", "failed", "failed"] }],
    });
  });

  it("counts a test missing from a run and a reported flaky test as unstable", () => {
    const result = classify(
      samples([
        ["missing", ["passed", "passed"]],
        ["flaky", ["flaky", "passed", "passed"]],
      ]),
      3,
    );
    expect(result.unstable.map(({ id }) => id)).toEqual(["flaky", "missing"]);
  });

  it("lets stable and skipped tests decide nothing", () => {
    const result = classify(
      samples([
        ["stable", ["passed", "passed", "passed"]],
        ["skipped", ["skipped", "skipped", "skipped"]],
        ["todo", ["todo", "pending", "skipped"]],
        ["skip-then-pass", ["skipped", "passed", "passed"]],
      ]),
      3,
    );
    expect(result).toEqual({ unstable: [], failing: [] });
  });
});

describe("mergeVerdicts", () => {
  it("folds runs into one verdict list per test, in run order", () => {
    const merged = mergeVerdicts([
      new Map([
        ["a", "passed"],
        ["b", "passed"],
      ]),
      new Map([["a", "failed"]]),
    ]);
    expect([...merged]).toEqual([
      ["a", ["passed", "failed"]],
      ["b", ["passed"]],
    ]);
    expect(classify(merged, 2).unstable.map(({ id }) => id)).toEqual(["a", "b"]);
  });
});

describe("vitestPlan", () => {
  it("defaults to three runs with seeds distinct per shard", () => {
    expect(vitestPlan(["--shard", "2/8"])).toEqual({
      shard: "2/8",
      seeds: [2001, 2002, 2003],
      filters: [],
    });
    expect(vitestPlan(["--shard", "1/8", "--repeats", "2"]).seeds).toEqual([1001, 1002]);
  });

  it("passes the file filters after -- through, and reads no option among them", () => {
    expect(vitestPlan(["--repeats", "4", "--", "a.test.ts", "--repeats"])).toEqual({
      shard: "1/1",
      seeds: [1001, 1002, 1003, 1004],
      filters: ["a.test.ts", "--repeats"],
    });
  });

  it.each([
    [["--shard", "0/8"]],
    [["--shard", "9/8"]],
    [["--shard", "x"]],
    [["--shard", "1/8", "--repeats", "1"]],
    [["--shard", "1/8", "--repeats", "2.5"]],
  ])("refuses %j", (argv) => {
    expect(() => vitestPlan(argv)).toThrow(TypeError);
  });
});

describe("formatReport", () => {
  it("lists both groups and escapes table separators", () => {
    const report = formatReport("unit suites, shard 1/8", 4, 3, {
      unstable: [{ id: "a > b | c", statuses: ["passed", "failed", "passed"] }],
      failing: [],
    });
    expect(report).toContain("### Unstable tests: unit suites, shard 1/8");
    expect(report).toContain("4 tests, 3 runs each.");
    expect(report).toContain("| a > b \\| c | passed, failed, passed |");
    expect(report).toContain("| Consistently failing test | Verdicts |\n| --- | --- |\n| none | |");
  });
});

describe("executedTestCount", () => {
  // CodeRabbit on #4513: a report in which every test was skipped is no stability evidence.
  it("counts no executed test in skipped-only reports of both formats", () => {
    const vitest = mergeVerdicts([
      vitestVerdicts(vitestReport([{ name: "a.test.ts", tests: [["x", "skipped"]] }]), ROOT),
    ]);
    expect(executedTestCount(vitest)).toBe(0);
    expect(executedTestCount(playwrightSamples(playwrightReport(["skipped", "skipped"])))).toBe(0);
  });

  it("counts no executed test when only file-level verdicts were reported", () => {
    // CodeRabbit on #4513: a file without assertions "passes" without running a test.
    const samples = mergeVerdicts([
      vitestVerdicts(vitestReport([{ name: "empty.test.ts" }, { name: "other.test.ts" }]), ROOT),
    ]);
    expect(samples.size).toBe(2);
    expect(executedTestCount(samples)).toBe(0);
  });

  it("keeps intentionally skipped tests valid beside executed ones", () => {
    const samples = mergeVerdicts([
      vitestVerdicts(
        vitestReport([
          {
            name: "a.test.ts",
            tests: [
              ["x", "skipped"],
              ["y", "passed"],
            ],
          },
        ]),
        ROOT,
      ),
    ]);
    expect(executedTestCount(samples)).toBe(1);
    expect(executedTestCount(playwrightSamples(playwrightReport(["skipped", "flaky"])))).toBe(1);
  });

  it("fails the measurement of a skipped-only report instead of passing it", () => {
    const script = fileURLToPath(new URL("../report-unstable-tests.mjs", import.meta.url));
    const directory = mkdtempSync(join(tmpdir(), "keiko-unstable-"));
    try {
      const run = (statuses) => {
        const path = join(directory, "report.json");
        writeFileSync(path, JSON.stringify(playwrightReport(statuses)));
        const env = { ...process.env, GITHUB_STEP_SUMMARY: "" };
        return spawnSync(process.execPath, [script, "playwright", path], { encoding: "utf8", env });
      };
      const skipped = run(["skipped", "skipped"]);
      expect(skipped.status).toBe(2);
      expect(skipped.stderr).toContain("no test executed");
      expect(run(["expected", "expected"]).status).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("explainedVerdicts", () => {
  const passing = new Map([["a.test.ts > x", "passed"]]);
  const failing = new Map([["a.test.ts > x", "failed"]]);

  it("keeps a clean run and a run whose exit a failed test explains", () => {
    expect(explainedVerdicts({ status: 0, signal: null }, passing, 1)).toBe(passing);
    expect(explainedVerdicts({ status: 1, signal: null }, failing, 1)).toBe(failing);
  });

  it("refuses a nonzero exit while every reported test passed, and a killed run", () => {
    // CodeRabbit on #4513: an unhandled error or a teardown failure fails the run, not a test.
    expect(() => explainedVerdicts({ status: 1, signal: null }, passing, 7)).toThrow(
      "seed 7 ended with exit 1",
    );
    expect(() => explainedVerdicts({ status: 2, signal: null }, failing, 7)).toThrow("exit 2");
    expect(() => explainedVerdicts({ status: null, signal: "SIGKILL" }, failing, 7)).toThrow(
      "signal SIGKILL",
    );
  });
});

describe("command line", () => {
  // Stands in for vitest: each run writes the report its seed maps to and exits as given.
  function vitestRuns(reports, exit = () => ({ status: 0, signal: null })) {
    const calls = [];
    const spawn = (_node, args) => {
      calls.push(args);
      const output = args.find((arg) => arg.startsWith("--outputFile.json="));
      const report = reports[calls.length - 1];
      writeFileSync(output.slice("--outputFile.json=".length), JSON.stringify(report));
      return exit(report);
    };
    return { calls, spawn };
  }

  const absolute = (name, status) => ({
    testResults: [
      { name: `/abs/${name}`, status: "passed", assertionResults: [{ fullName: "x", status }] },
    ],
  });

  function capture() {
    const lines = [];
    return { lines, log: (line) => lines.push(line) };
  }

  it("runs one shuffled seed per repeat and passes a stable suite into the summary", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-unstable-cli-"));
    try {
      const summary = join(directory, "summary.md");
      const { calls, spawn } = vitestRuns([
        absolute("a.test.ts", "passed"),
        absolute("a.test.ts", "passed"),
      ]);
      const { lines, log } = capture();
      const argv = ["vitest", "--shard", "2/3", "--repeats", "2", "--", "scripts/a"];
      expect(main(argv, { env: { GITHUB_STEP_SUMMARY: summary }, log, spawn })).toBe(0);
      expect(calls.map((args) => args.find((arg) => arg.startsWith("--sequence.seed=")))).toEqual([
        "--sequence.seed=2001",
        "--sequence.seed=2002",
      ]);
      expect(calls[0]).toContain("--shard=2/3");
      expect(calls[0].at(-1)).toBe("scripts/a");
      expect(readFileSync(summary, "utf8")).toBe(lines[0]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports a test whose verdict changes between seeds as exit 1", () => {
    const failedExit = (report) => ({
      status: report.testResults[0].assertionResults[0].status === "failed" ? 1 : 0,
      signal: null,
    });
    const { spawn } = vitestRuns(
      [absolute("a.test.ts", "passed"), absolute("a.test.ts", "failed")],
      failedExit,
    );
    const { lines, log } = capture();
    expect(main(["vitest", "--repeats", "2"], { env: {}, log, spawn })).toBe(1);
    expect(lines[0]).toContain("a.test.ts > x");
  });

  it("measures a Playwright report and refuses an unknown mode or an empty report", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-unstable-cli-"));
    try {
      const write = (report) => {
        const path = join(directory, "report.json");
        writeFileSync(path, JSON.stringify(report));
        return path;
      };
      const { log } = capture();
      const errors = [];
      const error = (line) => errors.push(line);
      const passing = write(playwrightReport(["expected", "expected"]));
      expect(cli(["playwright", passing], { env: {}, log, error })).toBe(0);
      expect(cli(["toString"], { env: {}, log, error })).toBe(2);
      expect(cli(["playwright"], { env: {}, log, error })).toBe(2);
      expect(cli(["playwright", write({ suites: [] })], { env: {}, log, error })).toBe(2);
      expect(errors).toEqual([
        "report-unstable-tests: could not measure — mode must be vitest or playwright",
        "report-unstable-tests: could not measure — playwright mode needs the JSON report path",
        "report-unstable-tests: could not measure — no test verdict was reported",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
