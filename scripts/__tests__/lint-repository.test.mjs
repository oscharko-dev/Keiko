import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import config from "../../eslint.config.js";
import {
  PEAK_RSS_BUDGET_BYTES,
  globalIgnores,
  lintPartitions,
  peakBudgetFailures,
  peakSummary,
  runPartitions,
  workspacePackages,
} from "../lint-repository.mjs";

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
