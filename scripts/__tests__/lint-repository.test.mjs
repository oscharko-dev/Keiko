import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import config from "../../eslint.config.js";
import {
  PEAK_RSS_BUDGET_BYTES,
  forwardedArgs,
  globalIgnores,
  lintPartitions,
  main,
  peakBudgetFailures,
  peakSummary,
  runPartitions,
  workspacePackages,
} from "../lint-repository.mjs";
import { installPeakReporter } from "../lib/peak-rss-reporter.mjs";

const GIB = 1024 ** 3;
const REPORTER = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "peak-rss-reporter.mjs"),
).href;

// #4182 (2026-11-02): one `eslint .` over the monorepo died with "JavaScript heap out of memory" at
// the 12 GiB ceiling. The repository lint now runs one ESLint process per workspace package and one
// for the rest. These cases pin that the partitions together still cover exactly what `eslint .`
// covered, and that a failing partition fails the lint without hiding the others.

describe("lint partitions", () => {
  it("gives every package its own partition and lints the rest of the repository once", () => {
    const partitions = lintPartitions(["keiko-tools", "keiko-contracts"], []);

    expect(partitions).toStrictEqual([
      { label: "packages/keiko-contracts", args: ["packages/keiko-contracts"] },
      { label: "packages/keiko-tools", args: ["packages/keiko-tools"] },
      {
        label: "repository root",
        args: [
          ".",
          "--ignore-pattern",
          "packages/keiko-contracts/**",
          "--ignore-pattern",
          "packages/keiko-tools/**",
        ],
      },
    ]);
  });

  it("skips a package the root config ignores as a whole and does not exclude it a second time", () => {
    const partitions = lintPartitions(["keiko-ui", "keiko-server"], ["packages/keiko-ui/**"]);

    expect(partitions.map((partition) => partition.label)).toStrictEqual([
      "packages/keiko-server",
      "repository root",
    ]);
    expect(partitions.at(-1)?.args).toStrictEqual([
      ".",
      "--ignore-pattern",
      "packages/keiko-server/**",
    ]);
  });

  it("reads only the config objects that are global ignores", () => {
    expect(
      globalIgnores([
        { ignores: ["dist/**"] },
        { name: "generated", ignores: ["coverage/**"] },
        { files: ["**/*.ts"], ignores: ["**/*.d.ts"], rules: {} },
      ]),
    ).toStrictEqual(["dist/**", "coverage/**"]);
  });

  it("partitions the real repository: every linted package once, the UI left to its own lint", () => {
    const names = workspacePackages(process.cwd());
    const partitions = lintPartitions(names, globalIgnores(config));
    const labels = partitions.map((partition) => partition.label);

    expect(labels).toContain("packages/keiko-server");
    expect(labels).not.toContain("packages/keiko-ui");
    expect(labels).toHaveLength(names.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("runs every partition and names each one that failed", () => {
    const seen = [];
    const failed = runPartitions(lintPartitions(["a", "b"], []), (args) => {
      seen.push(args[0]);
      return args[0] === "packages/a" ? 1 : 0;
    });

    expect(seen).toStrictEqual(["packages/a", "packages/b", "."]);
    expect(failed).toStrictEqual(["packages/a"]);
  });
});

// Quality-gate hardening plan 2026-11-21, P1: a partition that outgrows the runner must fail with
// its name and peak while the runner can still report, not die of memory with no reason given.
describe("lint peak memory budget", () => {
  it("is three quarters of the 16 GiB hosted runner", () => {
    expect(PEAK_RSS_BUDGET_BYTES).toBe(12 * GIB);
  });

  it("accepts a peak at the budget and names one above it", () => {
    expect(
      peakBudgetFailures([
        { label: "packages/a", peakBytes: 8.7 * GIB },
        { label: "packages/b", peakBytes: PEAK_RSS_BUDGET_BYTES },
        { label: "packages/c", peakBytes: PEAK_RSS_BUDGET_BYTES + 1 },
      ]),
    ).toStrictEqual(["packages/c: peaked at 12.0 GiB, above the 12.0 GiB budget"]);
  });

  it.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY])(
    "treats an unmeasured peak (%s) as a failure",
    (peakBytes) => {
      expect(peakBudgetFailures([{ label: "repository root", peakBytes }])).toStrictEqual([
        "repository root: no peak was measured",
      ]);
    },
  );

  it("summarizes every partition for the job summary", () => {
    expect(
      peakSummary([
        { label: "packages/a", peakBytes: 2 * GIB },
        { label: "repository root", peakBytes: Number.NaN },
      ]),
    ).toBe(
      [
        "### Lint peak resident memory (budget 12.0 GiB)",
        "",
        "| Partition | Peak GiB |",
        "| --- | --- |",
        "| packages/a | 2.0 |",
        "| repository root | unmeasured |",
        "",
      ].join("\n"),
    );
  });

  it("measures a child process's real peak through the preloaded reporter", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-peak-"));
    const file = join(directory, "peak.txt");
    try {
      const allocate =
        "const kept = []; for (let i = 0; i < 16; i += 1) kept.push(Buffer.alloc(8 * 1024 * 1024, 1));";
      const result = spawnSync(process.execPath, ["--import", REPORTER, "-e", allocate], {
        env: { ...process.env, KEIKO_PEAK_RSS_FILE: file },
      });
      expect(result.status).toBe(0);
      const peak = Number(readFileSync(file, "utf8").trim());
      // 128 MiB were kept resident; the peak is reported in bytes, not kibibytes.
      expect(peak).toBeGreaterThan(128 * 1024 * 1024);
      expect(peak).toBeLessThan(4 * GIB);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // CodeRabbit on #4513: a budget read only after exit cannot stop a partition that takes the runner
  // down. The child below holds its main thread in synchronous work, as a TypeScript program build
  // does, so only a watchdog with its own event loop can stop it before it finishes.
  // Windows reports a killed process without a POSIX signal name.
  it.skipIf(process.platform === "win32")(
    "stops a process the moment it grows past the budget, even while its main thread is busy",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "keiko-peak-"));
      const file = join(directory, "peak.txt");
      try {
        const busy =
          "const kept = [Buffer.alloc(64 * 1024 * 1024, 1)]; const end = Date.now() + 10_000;" +
          " while (Date.now() < end) kept.length; console.log('survived');";
        const result = spawnSync(process.execPath, ["--import", REPORTER, "-e", busy], {
          encoding: "utf8",
          env: {
            ...process.env,
            KEIKO_PEAK_RSS_FILE: file,
            KEIKO_PEAK_RSS_BUDGET_BYTES: String(32 * 1024 * 1024),
          },
        });
        expect(result.stdout).not.toContain("survived");
        expect(result.signal).toBe("SIGKILL");
        expect(result.stderr).toContain("exceeded the budget of 33554432");
        // The size it reached is recorded, so the partition fails with a measured peak.
        expect(Number(readFileSync(file, "utf8").trim())).toBeGreaterThan(32 * 1024 * 1024);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("leaves a process inside its budget to finish and report its peak", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-peak-"));
    const file = join(directory, "peak.txt");
    try {
      const result = spawnSync(
        process.execPath,
        ["--import", REPORTER, "-e", "console.log('ok')"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            KEIKO_PEAK_RSS_FILE: file,
            KEIKO_PEAK_RSS_BUDGET_BYTES: String(4 * GIB),
          },
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("ok\n");
      expect(Number(readFileSync(file, "utf8").trim())).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes nothing without a target file", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-peak-"));
    try {
      const env = { ...process.env };
      delete env.KEIKO_PEAK_RSS_FILE;
      const result = spawnSync(process.execPath, ["--import", REPORTER, "-e", "0"], {
        cwd: directory,
        env,
      });
      expect(result.status).toBe(0);
      expect(existsSync(join(directory, "peak.txt"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("lint argument forwarding", () => {
  it("forwards pruning, once, and nothing by default", () => {
    expect(forwardedArgs([])).toEqual([]);
    expect(forwardedArgs(["--prune-suppressions", "--prune-suppressions"])).toEqual([
      "--prune-suppressions",
    ]);
  });

  // The test-determinism register may only shrink through this command.
  it.each([["--suppress-all"], ["--suppress-rule"], ["--fix"], ["packages/keiko-server"]])(
    "refuses %s",
    (arg) => {
      expect(() => forwardedArgs([arg])).toThrow(TypeError);
    },
  );
});

describe("main", () => {
  // A repository of two linted packages, one package the global ignores leave out, and a
  // directory that is no workspace package.
  function repository() {
    const root = mkdtempSync(join(tmpdir(), "keiko-lint-main-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      join(root, "eslint.config.js"),
      'export default [{ ignores: ["packages/ignored/**"] }, { files: ["**/*.js"], rules: {} }];\n',
    );
    for (const name of ["alpha", "beta", "ignored"]) {
      mkdirSync(join(root, "packages", name), { recursive: true });
      writeFileSync(join(root, "packages", name, "package.json"), "{}");
    }
    mkdirSync(join(root, "packages", "notes"));
    return root;
  }

  function run(root, { argv = [], env = {}, peak = () => String(GIB), status = () => 0 } = {}) {
    const calls = [];
    const logs = [];
    const errors = [];
    const lint = (cwd, args, peakFile) => {
      calls.push({ cwd, args });
      const bytes = peak(args[0]);
      if (bytes !== null) writeFileSync(peakFile, `${bytes}\n`);
      return status(args[0]);
    };
    const log = (line) => logs.push(line);
    const error = (line) => errors.push(line);
    return main({ root, argv, env, lint, log, error }).then((code) => ({
      code,
      calls,
      logs,
      errors,
    }));
  }

  it("lints each partition with the forwarded flags and records every peak", async () => {
    const root = repository();
    try {
      const summary = join(root, "summary.md");
      const result = await run(root, {
        argv: ["--prune-suppressions"],
        env: { GITHUB_STEP_SUMMARY: summary },
      });
      expect(result.code).toBe(0);
      expect(result.calls.map((call) => call.args[0])).toEqual([
        "packages/alpha",
        "packages/beta",
        ".",
      ]);
      expect(result.calls.every((call) => call.cwd === root)).toBe(true);
      expect(result.calls.every((call) => call.args.at(-1) === "--prune-suppressions")).toBe(true);
      expect(result.logs.at(-1)).toBe("lint-repository: PASS — 3 partitions");
      expect(readFileSync(summary, "utf8")).toContain("| packages/beta | 1.0 |");
      expect(result.errors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails on a failed partition, an unmeasured one, and one above the budget", async () => {
    const root = repository();
    try {
      const failed = await run(root, { status: (dir) => Number(dir === "packages/alpha") });
      expect(failed.code).toBe(1);
      expect(failed.errors).toEqual(["lint-repository: FAIL — packages/alpha"]);
      const unmeasured = await run(root, { peak: (dir) => (dir === "." ? null : String(GIB)) });
      expect(unmeasured.code).toBe(1);
      expect(unmeasured.errors).toEqual([
        "lint-repository: FAIL — repository root: no peak was measured",
      ]);
      const above = await run(root, { peak: () => String(PEAK_RSS_BUDGET_BYTES + GIB) });
      expect(above.code).toBe(1);
      expect(above.errors).toHaveLength(3);
      await expect(run(root, { argv: ["--fix"] })).rejects.toThrow("unsupported argument --fix");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("installPeakReporter", () => {
  function host(maxRSS) {
    const handlers = [];
    return {
      handlers,
      on: (event, handler) => handlers.push({ event, handler }),
      resourceUsage: () => ({ maxRSS }),
    };
  }

  it("does nothing without a target file", () => {
    const child = host(1);
    const startWorker = () => {
      throw new Error("no watchdog without a target");
    };
    expect(installPeakReporter({ env: {}, host: child, startWorker })).toEqual({
      exitHook: false,
      watchdog: false,
    });
    expect(installPeakReporter({ env: { KEIKO_PEAK_RSS_FILE: "" }, host: child })).toEqual({
      exitHook: false,
      watchdog: false,
    });
    expect(child.handlers).toEqual([]);
  });

  it("writes the peak in bytes on exit, and starts an unreferenced watchdog for a budget", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-peak-reporter-"));
    try {
      const target = join(directory, "peak.txt");
      const child = host(2048);
      expect(installPeakReporter({ env: { KEIKO_PEAK_RSS_FILE: target }, host: child })).toEqual({
        exitHook: true,
        watchdog: false,
      });
      expect(child.handlers.map((entry) => entry.event)).toEqual(["exit"]);
      child.handlers[0].handler();
      expect(readFileSync(target, "utf8")).toBe(`${String(2048 * 1024)}\n`);

      const started = [];
      const startWorker = (source, options) => {
        const worker = { unreferenced: false, unref: () => (worker.unreferenced = true) };
        started.push({ source, options, worker });
        return worker;
      };
      const env = { KEIKO_PEAK_RSS_FILE: target, KEIKO_PEAK_RSS_BUDGET_BYTES: "4096" };
      expect(installPeakReporter({ env, host: host(1), startWorker })).toEqual({
        exitHook: true,
        watchdog: true,
      });
      expect(started).toHaveLength(1);
      expect(started[0].options).toEqual({
        eval: true,
        workerData: { budget: 4096, target, interval: 250 },
      });
      expect(started[0].source).toContain('process.kill(process.pid, "SIGKILL")');
      expect(started[0].worker.unreferenced).toBe(true);
      const invalid = { KEIKO_PEAK_RSS_FILE: target, KEIKO_PEAK_RSS_BUDGET_BYTES: "-1" };
      expect(installPeakReporter({ env: invalid, host: host(1), startWorker })).toEqual({
        exitHook: true,
        watchdog: false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
