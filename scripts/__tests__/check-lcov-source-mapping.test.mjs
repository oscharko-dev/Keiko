import { describe, expect, it, vi } from "vitest";

import {
  isExecutableSource,
  missingCoverageMappings,
  parseLcovSources,
  runLcovSourceMapping,
  runLcovSourceMappingCli,
} from "../check-lcov-source-mapping.mjs";

describe("LCOV source mapping", () => {
  it("normalizes absolute and relative LCOV source entries", () => {
    expect([
      ...parseLcovSources(["SF:/repo/scripts/gate.mjs\n", "SF:packages/a/src/a.ts\n"], "/repo"),
    ]).toEqual(["scripts/gate.mjs", "packages/a/src/a.ts"]);
  });

  it("classifies executable source without counting tests, fixtures, declarations, or configs", () => {
    expect(isExecutableSource("scripts/gate.mjs")).toBe(false);
    expect(isExecutableSource("scripts/check-lcov-source-mapping.mjs")).toBe(true);
    expect(isExecutableSource("packages/a/src/a.tsx")).toBe(true);
    expect(isExecutableSource("packages/a/public/sw.js")).toBe(false);
    expect(isExecutableSource("packages/a/src/a.test.ts")).toBe(false);
    expect(isExecutableSource("packages/a/src/a.d.ts")).toBe(false);
    expect(isExecutableSource("tests/fixtures/a.ts")).toBe(false);
    expect(isExecutableSource("tests/e2e/support/editorWorkspace.ts")).toBe(false);
    expect(isExecutableSource("docs/design-system/evidence/1300/browser/capture.mjs")).toBe(false);
    expect(isExecutableSource("vitest.config.ts")).toBe(false);
    expect(isExecutableSource("docs/qa/gate.md")).toBe(false);
  });

  it("fails closed when changed production source is absent from LCOV", () => {
    expect(
      missingCoverageMappings(
        ["scripts/check-lcov-source-mapping.mjs", "scripts/gate.mjs", "scripts/gate.test.mjs"],
        new Set(["scripts/other.mjs"]),
      ),
    ).toEqual(["scripts/check-lcov-source-mapping.mjs"]);
  });

  it("validates renamed and added sources against both coverage reports", () => {
    const calls = [];
    const logs = [];
    const result = runLcovSourceMapping({
      base: "base",
      execute: (file, args, options) => {
        calls.push([file, args, options]);
        return "R100\tscripts/old.mjs\tscripts/check-lcov-source-mapping.mjs\nA\tpackages/ui/src/view.tsx\n";
      },
      head: "head",
      log: (message) => logs.push(message),
      read: (path) =>
        path.includes("keiko-ui")
          ? "SF:packages/ui/src/view.tsx\n"
          : "SF:scripts/check-lcov-source-mapping.mjs\n",
      root: "/repo",
    });
    expect(result).toEqual({
      changed: ["scripts/check-lcov-source-mapping.mjs", "packages/ui/src/view.tsx"],
      missing: [],
    });
    expect(calls).toEqual([
      [
        "/usr/bin/git",
        ["diff", "--name-status", "--diff-filter=ACMR", "base...head"],
        { cwd: "/repo", encoding: "utf8" },
      ],
    ]);
    expect(logs).toEqual(["lcov-source-mapping: PASS - 2 changed files."]);
  });

  it("throws with every missing source path", () => {
    expect(() =>
      runLcovSourceMapping({
        base: "base",
        execute: () =>
          "A\tscripts/check-lcov-source-mapping.mjs\nA\tpackages/keiko-server/src/routes.ts\n",
        head: "head",
        read: () => "",
        root: "/repo",
      }),
    ).toThrow(
      "LCOV mapping missing for: scripts/check-lcov-source-mapping.mjs, packages/keiko-server/src/routes.ts",
    );
  });

  it("adapts CLI arguments and reports missing base input", () => {
    const runs = [];
    runLcovSourceMappingCli({
      argv: ["node", "script", "--base", "origin/dev"],
      run: (input) => runs.push(input),
    });
    expect(runs).toEqual([{ base: "origin/dev", head: "HEAD" }]);

    const errors = [];
    const exitCodes = [];
    runLcovSourceMappingCli({
      argv: ["node", "script"],
      error: (message) => errors.push(message),
      setExitCode: (value) => exitCodes.push(value),
    });
    expect(errors).toEqual(["lcov-source-mapping: FAIL - --base is required."]);
    expect(exitCodes).toEqual([1]);
  });

  it("uses repository-safe defaults for git, file reads, root, reports, and logging", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(
        runLcovSourceMapping({
          base: "HEAD",
          head: "HEAD",
          reports: ["package-lock.json"],
        }),
      ).toEqual({ changed: [], missing: [] });
      expect(log).toHaveBeenCalledWith("lcov-source-mapping: PASS - 0 changed files.");
    } finally {
      log.mockRestore();
    }
  });

  it("uses process arguments and default error reporting when no CLI adapters are injected", () => {
    const argv = process.argv;
    const exitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.argv = ["node", "script"];
    try {
      runLcovSourceMappingCli();
      expect(error).toHaveBeenCalledWith("lcov-source-mapping: FAIL - --base is required.");
      expect(process.exitCode).toBe(1);
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      error.mockRestore();
    }
  });

  it("formats non-Error CLI failures without leaking values", () => {
    const errors = [];
    runLcovSourceMappingCli({
      argv: ["node", "script", "--base", "base", "--head", "head"],
      error: (message) => errors.push(message),
      run: () => {
        throw "redacted";
      },
      setExitCode: () => undefined,
    });
    expect(errors).toEqual(["lcov-source-mapping: FAIL - redacted"]);
  });
});
