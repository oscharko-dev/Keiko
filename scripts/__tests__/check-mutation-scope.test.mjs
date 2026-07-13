import { describe, expect, it, vi } from "vitest";

import {
  mutationScope,
  parseChangedFiles,
  requiresSecurityMutation,
  runMutationScope,
  runMutationScopeCli,
} from "../check-mutation-scope.mjs";

describe("mutation scope", () => {
  it("requires mutation testing for governed and security-critical production code", () => {
    expect(requiresSecurityMutation(["packages/keiko-security/src/redaction.ts"])).toBe(true);
    expect(
      requiresSecurityMutation([
        "packages/keiko-server/src/coding-runtime/supervisedCodingPolicy.ts",
      ]),
    ).toBe(true);
    expect(requiresSecurityMutation(["packages/keiko-workflows/src/authority.ts"])).toBe(true);
    expect(requiresSecurityMutation(["scripts/banking-quality-gate-core.mjs"])).toBe(true);
    expect(requiresSecurityMutation(["scripts/banking-quality-gate-worker.mjs"])).toBe(true);
  });

  it("does not spend mutation time on documentation or tests only", () => {
    expect(requiresSecurityMutation(["docs/qa/mutation-testing.md"])).toBe(false);
    expect(requiresSecurityMutation(["packages/keiko-security/src/redaction.test.ts"])).toBe(false);
    expect(requiresSecurityMutation(["packages/keiko-security/src/unsafe,name.ts"])).toBe(false);
    expect(requiresSecurityMutation(["scripts/other-quality-tool.mjs"])).toBe(false);
  });

  it("derives the exact mutation file list from the bounded git diff", () => {
    const execute = (file, args, options) => {
      expect(file).toBe("/usr/bin/git");
      expect(args).toEqual(["diff", "--name-status", "--diff-filter=ACMR", "base...head"]);
      expect(options).toEqual({ encoding: "utf8" });
      return "M\tpackages/keiko-security/src/redaction.ts\nM\tdocs/qa/mutation-testing.md\n";
    };
    expect(mutationScope("base", "head", execute)).toEqual([
      "packages/keiko-security/src/redaction.ts",
    ]);
  });

  it("uses copied and renamed destinations and excludes deleted files", () => {
    expect(
      parseChangedFiles(
        "R100\tpackages/keiko-security/src/old.ts\tpackages/keiko-security/src/new.ts\n" +
          "C100\tpackages/keiko-security/src/source.ts\tpackages/keiko-security/src/copy.ts\n" +
          "D\tpackages/keiko-security/src/deleted.ts\n" +
          "A\tpackages/keiko-security/src/added.ts\n",
      ),
    ).toEqual([
      "packages/keiko-security/src/new.ts",
      "packages/keiko-security/src/copy.ts",
      "packages/keiko-security/src/added.ts",
    ]);
  });

  it("handles empty merge-base diffs without requesting mutation", () => {
    expect(mutationScope("fork-base", "head", () => "")).toEqual([]);
  });

  it("publishes deterministic GitHub outputs for multiple critical files", () => {
    const writes = [];
    const logs = [];
    const result = runMutationScope({
      append: (path, value) => writes.push([path, value]),
      argv: ["node", "script", "--base", "base", "--head", "head"],
      execute: () =>
        "M\tpackages/keiko-security/src/redaction.ts\n" +
        "M\tpackages/keiko-workflows/src/authority.ts\n",
      log: (value) => logs.push(value),
      outputPath: "output",
    });
    expect(result).toEqual({
      mutationFiles: [
        "packages/keiko-security/src/redaction.ts",
        "packages/keiko-workflows/src/authority.ts",
      ],
      required: true,
    });
    expect(writes).toEqual([
      ["output", "required=true\n"],
      [
        "output",
        "files=packages/keiko-security/src/redaction.ts,packages/keiko-workflows/src/authority.ts\n",
      ],
    ]);
    expect(logs).toEqual(["mutation-scope: required."]);
  });

  it("rejects missing merge-base arguments", () => {
    expect(() => runMutationScope({ argv: ["node", "script"] })).toThrow(
      "--base and --head are required.",
    );
  });

  it("reports CLI failures without swallowing them", () => {
    const errors = [];
    const exitCodes = [];
    runMutationScopeCli({
      argv: ["node", "script"],
      error: (message) => errors.push(message),
      setExitCode: (value) => exitCodes.push(value),
    });
    expect(errors).toEqual(["mutation-scope: FAIL - --base and --head are required."]);
    expect(exitCodes).toEqual([1]);
  });

  it("uses the fixed git executable by default for an empty merge-base diff", () => {
    expect(mutationScope("HEAD", "HEAD")).toEqual([]);
  });

  it("uses process arguments, environment output, append, and logging defaults", () => {
    const argv = process.argv;
    const output = process.env.GITHUB_OUTPUT;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.argv = ["node", "script", "--base", "HEAD", "--head", "HEAD"];
    delete process.env.GITHUB_OUTPUT;
    try {
      expect(runMutationScope()).toEqual({ mutationFiles: [], required: false });
      expect(log).toHaveBeenCalledWith("mutation-scope: not applicable.");
    } finally {
      process.argv = argv;
      if (output === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = output;
      log.mockRestore();
    }
  });

  it("uses default CLI error reporting and handles non-Error failures", () => {
    const argv = process.argv;
    const exitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.argv = ["node", "script"];
    try {
      runMutationScopeCli();
      expect(error).toHaveBeenCalledWith("mutation-scope: FAIL - --base and --head are required.");
      expect(process.exitCode).toBe(1);
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      error.mockRestore();
    }
    const errors = [];
    runMutationScopeCli({
      argv: ["node", "script", "--base", "base", "--head", "head"],
      error: (message) => errors.push(message),
      execute: () => {
        throw "redacted";
      },
      setExitCode: () => undefined,
    });
    expect(errors).toEqual(["mutation-scope: FAIL - redacted"]);
  });
});
