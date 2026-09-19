// Activity Log scenario matrix (#3532): the editor-delivery surface.
//
// Each scenario drives a production entry point of the editor-delivery surface — the governed LSP
// process adapter (packages/keiko-server/src/editor/lsp/lspNodeAdapter.ts), the git process
// boundary's own activity-log wrapper (gitProcessActivity.ts), and the runtime Git diff reader
// (gitDelivery/runtimeGitRead.ts) — into one failure mode with the real production file writer
// under a temporary KEIKO_STATE_DIR, then reconstructs the persisted log through
// `keiko support analyze` to a complete report (tests/support/activity-log-scenario.ts).

import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitProcessResult, GitProcessRunner } from "@oscharko-dev/keiko-git";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

import {
  createDefaultLspSpawnFn,
  defaultLspSpawnFn,
  LspProcessError,
} from "../../packages/keiko-server/src/editor/lsp/lspNodeAdapter.js";
import { writeNodeExecutableFixture } from "../../packages/keiko-server/src/editor/lsp/testing/executableFixture.js";
import { observedGitRunner } from "../../packages/keiko-server/src/gitProcessActivity.js";
import { LINE_DIFF_MAX_EDIT_DISTANCE } from "../../packages/keiko-server/src/gitDelivery/lineDiff.js";
import { runtimeGitDiff } from "../../packages/keiko-server/src/gitDelivery/runtimeGitRead.js";
import type { GitDeliveryExecutionSeams } from "../../packages/keiko-server/src/gitDelivery/execution.js";
import type { VerifiedCommitRunContext } from "../../packages/keiko-server/src/gitDelivery/verifiedCommitTypes.js";
import { processServerLogSink } from "../../packages/keiko-server/src/process-log-sink.js";
import { resetServerLogger } from "../../packages/keiko-server/src/observability/index.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../support/activity-log-proof.js";
import { expectActivityLogScenario } from "../support/activity-log-scenario.js";

const cleanups: (() => void)[] = [];
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "keiko-scenario-editor-delivery-"));
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  vi.stubEnv("KEIKO_LOG_LEVEL", "debug");
  resetServerLogger();
});

afterEach(() => {
  resetServerLogger();
  vi.unstubAllEnvs();
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  rmSync(stateDir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// Isolated from the operator's own global/system git config, exactly like
// gitDelivery/verifiedCommitService.test.ts's own `git()` helper, so a signing key, alias or hook
// configured on the host machine can never change this fixture's outcome.
const GIT_ISOLATION_ENV = {
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
} as const;

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...GIT_ISOLATION_ENV },
  }).trim();
}

// A worktree with one committed file whose every line then changes in place, sized past
// LINE_DIFF_MAX_EDIT_DISTANCE so the runtime diff reader's bounded search (gitDelivery/lineDiff.ts)
// stops at its distance bound instead of finding a minimal script.
function writeBoundedDiffRepo(repoRoot: string): number {
  const lineCount = LINE_DIFF_MAX_EDIT_DISTANCE + 100;
  const lines = Array.from(
    { length: lineCount },
    (_, index) => `export const v${String(index)} = 1;`,
  );
  runGit(repoRoot, ["init", "-qb", "dev"]);
  runGit(repoRoot, ["config", "user.name", "Keiko Test"]);
  runGit(repoRoot, ["config", "user.email", "keiko@example.test"]);
  writeFileSync(join(repoRoot, "bounded.js"), `${lines.join("\n")}\n`);
  runGit(repoRoot, ["add", "bounded.js"]);
  runGit(repoRoot, ["commit", "-qm", "bounded"]);
  writeFileSync(
    join(repoRoot, "bounded.js"),
    `${lines.map((line) => line.replace("1;", "2;")).join("\n")}\n`,
  );
  return lineCount;
}

function boundedDiffContext(repoRoot: string, correlationId: string): VerifiedCommitRunContext {
  const workspace: WorkspaceInfo = {
    root: repoRoot,
    selectedRoot: repoRoot,
    name: "editor-delivery-loss",
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
  return {
    runId: "editor-delivery-loss-run",
    envelopeDigest: "a".repeat(64),
    runtimeAuthorityDigest: "a".repeat(64),
    workspaceDigest: "a".repeat(64),
    repositoryDigest: "a".repeat(64),
    workspace,
    baseRef: "dev",
    headRef: "dev",
    correlationId,
    buffersClean: () => true,
    stillAuthorized: () => true,
  };
}

// A spawn-boundary security refusal: the preflight declined the invocation before any `git`
// process ever ran (ADR-0069-style deny-by-default), so `exitCode` is the synthetic 128 keiko-git
// reports for a refusal, never a real process exit.
function refusedGitResult(): GitProcessResult {
  return {
    exitCode: 128,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    aborted: false,
    refusal: "remote-command-option",
  };
}

// An ordinary failed `git` invocation: the process ran and exited non-zero because the workspace is
// not (or is no longer) a Git repository — a real dependency of the editor-delivery surface on the
// workspace's own Git state.
function failedGitResult(): GitProcessResult {
  return {
    exitCode: 128,
    signal: null,
    stdout: "",
    stderr: "fatal: not a git repository (or any of the parent directories): .git",
    truncated: false,
    timedOut: false,
    aborted: false,
  };
}

describe("Activity Log scenario: editor-delivery", () => {
  describe("editor-delivery.crash", () => {
    it("reconstructs an LSP language-server process termination to a complete crash trace", async () => {
      const binDir = makeTempDir("keiko-scenario-editor-crash-");
      const executable = writeNodeExecutableFixture(
        binDir,
        "hanglsp",
        "setInterval(() => {}, 1000);\n",
      );
      // A custom spawn seam captures the real native child so the test can wait for its own
      // 'spawn' confirmation (lsp.spawn.completed) before killing it — otherwise `kill()` can win
      // the race against the async 'spawn' event and persist lsp.process.terminated first, which
      // is a real but uninteresting race this scenario does not exist to prove.
      let nativeChild: ChildProcessWithoutNullStreams | undefined;
      const spawnLsp = createDefaultLspSpawnFn((command, args, options) => {
        nativeChild = nodeSpawn(command, args, options);
        return nativeChild;
      });
      const startedAtMs = Date.now();

      const handle = spawnLsp(executable, [], { PATH: "/usr/bin" }, binDir);
      const child = nativeChild;
      if (child === undefined) throw new Error("native LSP child missing");
      await new Promise<void>((resolve) => {
        child.once("spawn", resolve);
      });
      const exited = new Promise<void>((resolve) => {
        handle.onExit(() => {
          resolve();
        });
      });
      handle.kill("SIGTERM");
      await exited;
      handle.releaseRuntimeResources?.();

      const trace = await expectActivityLogScenario("editor-delivery.crash", {
        stateDir,
        startedAtMs,
        expectedOps: ["lsp.spawn.completed", "lsp.process.terminated"],
      });
      expect(trace.failureClasses).toEqual(expect.arrayContaining(["lsp-process-termination"]));

      const [line] = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "lsp.process.terminated",
      );
      expect(
        expectActivityLogProof("lsp.process.terminated.emitted-line", line ?? ""),
      ).toMatchObject({ signal: "SIGTERM" });
    });
  });

  describe("editor-delivery.dependency-failure", () => {
    // Regression (#3532): lsp.spawn.failed was registered as correlation-causal although the spawn
    // boundary never has a request correlation, so every LSP spawn failure projected `degraded`
    // (correlation-unknown). It is a process-scoped event now and reconstructs to complete.
    it("reconstructs an LSP spawn failure to a complete dependency-failure trace", async () => {
      const startedAtMs = Date.now();

      expect(() => defaultLspSpawnFn("relative-language-server", [], {}, stateDir)).toThrow(
        LspProcessError,
      );

      const trace = await expectActivityLogScenario("editor-delivery.dependency-failure", {
        stateDir,
        startedAtMs,
        expectedOps: ["lsp.spawn.failed"],
      });
      expect(trace.failureClasses).toEqual(expect.arrayContaining(["lsp-process-spawn"]));
      const [line] = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "lsp.spawn.failed",
      );
      expect(expectActivityLogProof("lsp.spawn.failed.emitted-line", line ?? "")).toMatchObject({
        errorKind: "unavailable",
      });
    });

    it("reconstructs a failed git process to a complete dependency-failure trace", async () => {
      const startedAtMs = Date.now();
      const runner: GitProcessRunner = () => Promise.resolve(failedGitResult());
      const observed = observedGitRunner(
        runner,
        processServerLogSink(),
        "editor-delivery-dependency-failure-test",
      );

      await observed(["status"], { cwd: stateDir, maxBytes: 1_000_000, timeoutMs: 5_000 });

      const trace = await expectActivityLogScenario("editor-delivery.dependency-failure", {
        stateDir,
        startedAtMs,
        expectedOps: ["git.process.failed"],
      });
      expect(trace.failureClasses).toEqual(expect.arrayContaining(["git-process-failure"]));

      const [line] = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "git.process.failed",
      );
      expect(expectActivityLogProof("git.process.failed.line", line ?? "")).toMatchObject({
        subcommand: "status",
        errorKind: "unavailable",
      });
    });
  });

  describe("editor-delivery.loss", () => {
    it("reconstructs a bounded runtime diff search to a complete loss trace", async () => {
      const repoRoot = realpathSync(makeTempDir("keiko-scenario-editor-loss-repo-"));
      const lineCount = writeBoundedDiffRepo(repoRoot);
      const context = boundedDiffContext(repoRoot, "editor-delivery-loss-test");
      const execution: GitDeliveryExecutionSeams = {};
      const startedAtMs = Date.now();

      await runtimeGitDiff(context, execution, "unstaged", ["bounded.js"]);

      const trace = await expectActivityLogScenario("editor-delivery.loss", {
        stateDir,
        startedAtMs,
        expectedOps: ["git.runtime-diff.search-bounded"],
      });
      expect(trace.failureClasses).toEqual(expect.arrayContaining(["git-diff-search-bounded"]));

      const [line] = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "git.runtime-diff.search-bounded",
      );
      expect(
        expectActivityLogProof("git.runtime-diff.search-bounded.emitted-line", line ?? ""),
      ).toMatchObject({ bound: "distance", oldLines: lineCount, newLines: lineCount });
    });
  });

  describe("editor-delivery.rejection", () => {
    it("reconstructs a refused git process to a complete rejection trace", async () => {
      const startedAtMs = Date.now();
      const runner: GitProcessRunner = () => Promise.resolve(refusedGitResult());
      const observed = observedGitRunner(
        runner,
        processServerLogSink(),
        "editor-delivery-rejection-test",
      );

      await observed(["fetch", "--upload-pack=evil"], {
        cwd: stateDir,
        maxBytes: 1_000_000,
        timeoutMs: 5_000,
      });

      const trace = await expectActivityLogScenario("editor-delivery.rejection", {
        stateDir,
        startedAtMs,
        expectedOps: ["git.process.refused"],
      });
      expect(trace.failureClasses).toEqual(expect.arrayContaining(["git-process-refusal"]));

      const [line] = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "git.process.refused",
      );
      expect(expectActivityLogProof("git.process.refused.line", line ?? "")).toMatchObject({
        refusal: "remote-command-option",
        errorKind: "authority-denied",
      });
    });
  });
});
