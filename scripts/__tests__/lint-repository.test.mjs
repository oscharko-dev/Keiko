import { describe, expect, it } from "vitest";

import config from "../../eslint.config.js";
import {
  eslintArguments,
  globalIgnores,
  lintPartitions,
  runPartitions,
  workspacePackages,
} from "../lint-repository.mjs";

// #4182 (2026-11-02): one `eslint .` over the monorepo died with "JavaScript heap out of memory" at
// the 12 GiB ceiling. The repository lint now runs one ESLint process per workspace package and one
// for the rest. These cases pin that the partitions together still cover exactly what `eslint .`
// covered, and that a failing partition fails the lint without hiding the others.

describe("lint partitions", () => {
  // The zero-warning policy moved with the per-package lint (#3991, owner decision 2026-11-07).
  it("runs every real partition with --max-warnings=0 ahead of its own paths", () => {
    const partitions = lintPartitions(workspacePackages(process.cwd()), globalIgnores(config));
    expect(partitions.length).toBeGreaterThan(1);
    for (const partition of partitions) {
      const args = eslintArguments(partition.args);
      expect(args[0]).toBe("--max-warnings=0");
      expect(args.slice(1)).toStrictEqual(partition.args);
    }
  });

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
      // The spawn callback receives the complete argument list, zero-warning flag first.
      expect(args[0]).toBe("--max-warnings=0");
      seen.push(args[1]);
      return args[1] === "packages/a" ? 1 : 0;
    });

    expect(seen).toStrictEqual(["packages/a", "packages/b", "."]);
    expect(failed).toStrictEqual(["packages/a"]);
  });
});
