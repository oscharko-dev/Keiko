import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import {
  changedPaths,
  executeSonarNewCodeCli,
  gitPaths,
  lintSonarNewCode,
  runSonarNewCodePreflight,
  selectSonarFiles,
  sonarNewCodeRules,
} from "../check-sonar-new-code.mjs";

describe("Sonar new-code preflight", () => {
  it("pins the Sonar rules that escaped the ordinary local lint gate", () => {
    expect(sonarNewCodeRules).toEqual({
      "sonarjs/cognitive-complexity": ["error", 15],
      "sonarjs/no-identical-functions": "error",
      "sonarjs/use-type-alias": "error",
    });
  });

  it("selects only existing changed source files and deduplicates them", () => {
    expect(
      selectSonarFiles(["src/a.ts", "src/a.ts", "src/b.tsx", "docs/readme.md", "src/deleted.ts"], {
        cwd: "/repo",
        exists: (path) => !path.endsWith("deleted.ts"),
      }),
    ).toEqual(["src/a.ts", "src/b.tsx"]);
    expect(selectSonarFiles(["scripts/check-sonar-new-code.mjs"])).toEqual([
      "scripts/check-sonar-new-code.mjs",
    ]);
  });

  it("reads committed, working-tree, and untracked changes with NUL-safe paths", () => {
    const calls = [];
    const execute = (_command, args) => {
      calls.push(args);
      return Buffer.from(calls.length === 1 ? "src/a.ts\0" : `src/${String(calls.length)}.ts\0`);
    };

    expect(gitPaths(["status"], "/repo", execute)).toEqual(["src/a.ts"]);
    calls.length = 0;
    expect(changedPaths("/repo", "origin/dev", execute)).toEqual([
      "src/a.ts",
      "src/2.ts",
      "src/3.ts",
    ]);
    expect(calls).toHaveLength(3);

    calls.length = 0;
    expect(changedPaths(undefined, undefined, execute)).toHaveLength(3);
  });

  it("passes without invoking ESLint when no changed source exists", async () => {
    const messages = [];
    await expect(
      runSonarNewCodePreflight({
        cwd: process.cwd(),
        log: (message) => messages.push(message),
        paths: [],
      }),
    ).resolves.toBeUndefined();
    expect(messages).toEqual(["sonar-new-code-preflight: PASS - no changed source files."]);
  });

  it("lints changed root and UI sources with the Sonar parity configuration", async () => {
    const results = await lintSonarNewCode(
      ["scripts/check-sonar-new-code.mjs", "packages/keiko-ui/eslint.config.mjs"],
      process.cwd(),
    );

    expect(results).toHaveLength(2);
    expect(results.flatMap((result) => result.messages)).toEqual([]);

    await expect(
      lintSonarNewCode(["scripts/check-sonar-new-code.mjs"], process.cwd()),
    ).resolves.toHaveLength(1);
    await expect(
      lintSonarNewCode(["packages/keiko-ui/eslint.config.mjs"], process.cwd()),
    ).resolves.toHaveLength(1);
  }, 45_000);

  it("reports a bounded pass and a formatted failure from injected lint evidence", async () => {
    const path = "scripts/check-sonar-new-code.mjs";
    const messages = [];
    await expect(
      runSonarNewCodePreflight({
        cwd: process.cwd(),
        lint: async () => [{ errorCount: 0, fatalErrorCount: 0, messages: [] }],
        log: (message) => messages.push(message),
        paths: [path],
      }),
    ).resolves.toBeUndefined();
    expect(messages[0]).toContain("PASS - 1 changed source file");

    const defaultLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runSonarNewCodePreflight({
      lint: async () => [{ errorCount: 0, fatalErrorCount: 0, messages: [] }],
      paths: [path],
    });
    expect(defaultLog).toHaveBeenCalledWith(expect.stringContaining("PASS - 1 changed"));
    await runSonarNewCodePreflight({
      lint: async () => [{ errorCount: 0, fatalErrorCount: 0, messages: [] }],
      log: () => undefined,
    });
    await runSonarNewCodePreflight({
      log: () => undefined,
      paths: [path],
    });

    await expect(
      runSonarNewCodePreflight({
        cwd: process.cwd(),
        format: async () => "bounded diagnostic",
        lint: async () => [
          {
            errorCount: 1,
            fatalErrorCount: 0,
            filePath: path,
            messages: [{ fatal: false, ruleId: "sonarjs/use-type-alias", severity: 2 }],
          },
        ],
        paths: [path],
      }),
    ).rejects.toThrow("Local Sonar parity failed.\nbounded diagnostic");

    await expect(
      runSonarNewCodePreflight({
        cwd: process.cwd(),
        lint: async () => [
          {
            errorCount: 0,
            fatalErrorCount: 1,
            filePath: path,
            fixableErrorCount: 0,
            fixableWarningCount: 0,
            messages: [
              {
                column: 1,
                fatal: true,
                line: 1,
                message: "fatal parity error",
                ruleId: null,
                severity: 2,
              },
            ],
            suppressedMessages: [],
            usedDeprecatedRules: [],
            warningCount: 0,
          },
        ],
        paths: [path],
      }),
    ).rejects.toThrow("Local Sonar parity failed.");
  });

  it("maps CLI failures to a redacted nonzero exit without terminating tests", async () => {
    const errors = [];
    const exitCodes = [];
    await executeSonarNewCodeCli({
      error: (message) => errors.push(message),
      run: async () => {
        throw new Error("bounded failure");
      },
      setExitCode: (value) => exitCodes.push(value),
    });
    await executeSonarNewCodeCli({ run: async () => undefined });
    await executeSonarNewCodeCli({
      error: (message) => errors.push(message),
      run: () => Promise.reject("unknown failure"),
      setExitCode: (value) => exitCodes.push(value),
    });

    expect(errors).toEqual(["bounded failure", "unknown failure"]);
    expect(exitCodes).toEqual([1, 1]);
  });
});
