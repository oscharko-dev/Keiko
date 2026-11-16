// #4068 W8: real Windows shell behaviour, nothing mocked and no container involved. `npm`/`npx`
// resolve to their real `.cmd` shims, the wrapper is the real cmd.exe invocation, the tests are run by
// the project's own Vitest through its own `node_modules\.bin\vitest.cmd`, and the root carries a
// space, a non-ASCII letter and shell metacharacters.
//
// Two different things are proved, and they must not be read as one. The governed verifier always
// requests the execution-root boundary, which Windows offers only through a container runtime
// (ADR-0043); without one it refuses, which the first group proves with no backend attested, so this
// suite can never start a container. The red, green and red loop runs below that boundary through
// `runCommand`, so it qualifies the shell path, not the Workbench's governed verification. That
// remains an open blocker in docs/qa/opencode-windows-qualification.md.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_SANDBOX_POLICY, runCommand, type CommandResult } from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectScripts } from "./detect.js";
import { runVerification, VERIFICATION_COMMAND_RULES } from "./orchestrator.js";
import { buildVerificationPlan } from "./plan.js";
import type { VerificationStep } from "./types.js";
import { DEFAULT_VERIFICATION_LIMITS } from "./types.js";

const REAL_RUN_TIMEOUT_MS = 180_000;
const NO_BACKEND = {
  bubblewrap: false,
  unshare: false,
  seatbelt: false,
  docker: false,
  podman: false,
};

const BROKEN_SOURCE = "export const add = (left, right) => left - right;\n";
const REPAIRED_SOURCE = "export const add = (left, right) => left + right;\n";
const TEST_SOURCE = `import { expect, it } from "vitest";
import { add } from "./add.js";
it("adds", () => {
  expect(add(2, 3)).toBe(5);
});
`;
const ARGV_RECORDER = `import { writeFileSync } from "node:fs";
writeFileSync("argv.json", JSON.stringify(process.argv.slice(2)), "utf8");
`;
// The shape npm itself generates for a package binary, so the real double-parse of `%*` is exercised.
const VITEST_SHIM = `@ECHO off\r\nSETLOCAL\r\n"node" "%~dp0\\..\\vitest\\vitest.mjs" %*\r\n`;

function workspaceAt(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: "w8-project",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["src"],
    languages: ["javascript"],
    ignoreLines: [],
  };
}

function plannedStep(command: string, args: readonly string[]): VerificationStep {
  return { kind: "test", scriptName: "test", command, args, limits: DEFAULT_VERIFICATION_LIMITS };
}

describe.runIf(process.platform === "win32")("real Windows shell behaviour (#4068 W8)", () => {
  let root: string;

  const write = (relative: string, content: string): void => {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  };

  const run = (command: string, args: readonly string[]): Promise<CommandResult> =>
    runCommand(
      {
        command,
        args,
        cwd: undefined,
        timeoutMs: REAL_RUN_TIMEOUT_MS,
        signal: new AbortController().signal,
      },
      {
        workspace: workspaceAt(root),
        policy: DEFAULT_SANDBOX_POLICY,
        commandRules: VERIFICATION_COMMAND_RULES,
        spawn: nodeSpawnFn,
        processEnv: process.env,
        now: Date.now,
      },
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "keiko W8 ü (x) & "));
    write(
      "package.json",
      JSON.stringify({
        name: "w8-project",
        type: "module",
        scripts: { test: "vitest run", argv: "node record-argv.mjs" },
      }),
    );
    write("src/add.js", BROKEN_SOURCE);
    write("src/add.test.js", TEST_SOURCE);
    write("record-argv.mjs", ARGV_RECORDER);
    write("node_modules/.bin/vitest.cmd", VITEST_SHIM);
    const vitestPackage = createRequire(import.meta.url).resolve("vitest/package.json");
    symlinkSync(dirname(vitestPackage), join(root, "node_modules", "vitest"), "junction");
  });

  afterEach(() => {
    // The junction goes first: a recursive removal must never walk into the repository's Vitest.
    rmSync(join(root, "node_modules", "vitest"), { recursive: false, force: true });
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  });

  describe("the governed verifier without a container runtime", () => {
    const verifierDeps = (): Parameters<typeof runVerification>[1] => ({
      workspace: workspaceAt(root),
      networkEnforcement: "enforce-or-fail-closed",
      enforcedNetworkAvailable: false,
      sandboxAvailability: NO_BACKEND,
    });

    it("refuses the project's own test step, runs nothing and reports no pass", async () => {
      const workspace = workspaceAt(root);
      const plan = buildVerificationPlan(workspace, detectScripts(workspace), { only: ["test"] });
      write("src/add.js", REPAIRED_SOURCE);

      const report = await runVerification(plan, verifierDeps());

      expect(report.results.map((result) => result.status)).toEqual(["denied"]);
      expect(report.overallStatus).not.toBe("passed");
      expect(report.counts.passed).toBe(0);
    });

    it.each([
      ["cmd", ["/c", "echo canary>canary.txt"]],
      ["cmd.exe", ["/c", "echo canary>canary.txt"]],
      ["powershell", ["-Command", "Set-Content canary.txt canary"]],
      ["powershell.exe", ["-Command", "Set-Content canary.txt canary"]],
      ["npm.cmd", ["run", "argv", "--", "canary"]],
    ])("refuses the interpreter %s and leaves no effect", async (command, args) => {
      const report = await runVerification(
        { workspaceRoot: root, steps: [plannedStep(command, args)] },
        verifierDeps(),
      );
      expect(report.overallStatus).not.toBe("passed");
      expect(existsSync(join(root, "canary.txt"))).toBe(false);
      expect(existsSync(join(root, "argv.json"))).toBe(false);
    });
  });

  describe("the shell path below the execution-root boundary", () => {
    it.each([
      ["npm.cmd", "npm", ["test"]],
      ["npx.cmd", "npx", ["vitest", "run"]],
    ])(
      "runs the project's Vitest red, green after the repair, red on a regression through %s",
      async (_shim, command, args) => {
        const failing = await run(command, args);
        expect(failing.exitCode).not.toBe(0);
        expect(`${failing.stdout}${failing.stderr}`).toContain("add.test.js");

        write("src/add.js", REPAIRED_SOURCE);
        const repaired = await run(command, args);
        expect(repaired.exitCode).toBe(0);

        // A pass is bound to the tree it ran on: reverting the repair cannot keep the green result.
        write("src/add.js", BROKEN_SOURCE);
        const regressed = await run(command, args);
        expect(regressed.exitCode).not.toBe(0);
      },
      REAL_RUN_TIMEOUT_MS,
    );

    it(
      "carries spaces, quotes and cmd metacharacters to the script byte for byte through npm.cmd",
      async () => {
        const hostile = [
          "a b",
          "x&y",
          "^caret",
          "(paren)",
          "pipe|gt>",
          "ünï",
          'quo"te',
          "semi;colon",
        ];
        const result = await run("npm", ["run", "argv", "--", ...hostile]);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(readFileSync(join(root, "argv.json"), "utf8"))).toEqual(hostile);
      },
      REAL_RUN_TIMEOUT_MS,
    );

    it("refuses a percent argument instead of letting cmd.exe expand it, and runs nothing", async () => {
      await expect(run("npm", ["run", "argv", "--", "%USERNAME%"])).rejects.toThrow(/%/u);
      expect(existsSync(join(root, "argv.json"))).toBe(false);
    });
  });
});
