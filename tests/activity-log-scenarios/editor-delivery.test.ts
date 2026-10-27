import { resetServerLogger } from "../support/activity-log-test-support.js";
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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitProcessResult, GitProcessRunner } from "@oscharko-dev/keiko-git";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

import {
  createDefaultLspSpawnFn,
  defaultLspSpawnFn,
  LspProcessError,
} from "../../packages/keiko-server/src/editor/lsp/lspNodeAdapter.js";
import {
  writeExecutableFixture,
  writeNodeExecutableFixture,
} from "../../packages/keiko-server/src/editor/lsp/testing/executableFixture.js";
import { observedGitRunner } from "../../packages/keiko-server/src/gitProcessActivity.js";
import { LINE_DIFF_MAX_EDIT_DISTANCE } from "../../packages/keiko-server/src/gitDelivery/lineDiff.js";
import { runtimeGitDiff } from "../../packages/keiko-server/src/gitDelivery/runtimeGitRead.js";
import type { GitDeliveryExecutionSeams } from "../../packages/keiko-server/src/gitDelivery/execution.js";
import type { VerifiedCommitRunContext } from "../../packages/keiko-server/src/gitDelivery/verifiedCommitTypes.js";
import { processServerLogSink } from "../../packages/keiko-server/src/process-log-sink.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../support/activity-log-proof.js";
import { expectActivityLogScenario } from "../support/activity-log-scenario.js";

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS } from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-capabilities";
import {
  DEFAULT_SUPPORT_QUERY_LIMITS,
  type SupportQueryResult,
} from "@oscharko-dev/keiko-activity-log/reader";
import { buildRedactor, createInMemoryUiStore } from "../../packages/keiko-server/src/index.js";
import type { RouteContext, UiHandlerDeps } from "../../packages/keiko-server/src/index.js";
import type { RouteResult } from "../../packages/keiko-server/src/routes.js";
import { handleEditorLanguageSemanticTokens } from "../../packages/keiko-server/src/editor/languageRoutes.js";
import { shutdownHostLspPool } from "../../packages/keiko-server/src/editor/lsp/hostLanguageOperation.js";
import { createFakeLspProcess } from "../../packages/keiko-server/src/editor/lsp/testing/fakeLspProcess.js";
import { createManagedLspActivationStore } from "../../packages/keiko-server/src/editor/lsp/managedLspActivationStore.js";
import { createManagedLspControlService } from "../../packages/keiko-server/src/editor/lsp/managedLspControl.js";
import { createWorkspaceMutexRegistry } from "../../packages/keiko-server/src/task-workspace/mutex.js";
import type { WorkspaceScriptTrustService } from "../../packages/keiko-server/src/workspace-script-trust.js";
import {
  executeSupportQuery,
  resolveSupportSelection,
} from "../../packages/keiko-cli/src/support-query-cli.js";

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
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw error;
    }
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
    }, 60_000);
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
    }, 60_000);

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

// The semantic-token route must reconstruct from persisted evidence with no optional context.
// This uses the existing real activation/store boundary and framed in-memory provider, not events
// supplied directly to the writer. No server listens and the HTTP socket never connects.
interface TokenReconstructionSample {
  readonly name: string;
  readonly data: readonly number[];
  readonly text: string;
  readonly mode: "refusal" | "technical" | "served" | "unavailable";
}

interface TokenReconstructionResources {
  readonly rawRoot: string;
  readonly socket: Socket;
  readonly providers: ReturnType<typeof createFakeLspProcess>[];
  readonly store: ReturnType<typeof createInMemoryUiStore>;
}

const tokenReconstructionCorrelation = "semantic-reconstruction-request";
const tokenPayloadCanary = "PRIVATE_SEMANTIC_DOCUMENT_CANARY";

function writeTokenWorkspace(base: string): { readonly bin: string; readonly workspace: string } {
  const bin = join(base, "executables");
  const workspace = join(base, "project");
  mkdirSync(bin);
  mkdirSync(workspace);
  for (const name of ["cargo", "rustc", "rustfmt", "rust-analyzer", "bwrap", "sandbox-exec"]) {
    writeExecutableFixture(bin, name);
  }
  writeFileSync(
    join(workspace, "Cargo.toml"),
    "[package]\nname='reconstruction'\nversion='0.1.0'\n",
  );
  writeFileSync(join(workspace, "lib.rs"), "struct Value;\n");
  return { bin, workspace };
}

async function activateTokenWorkspace(
  workspace: string,
  base: string,
): Promise<ReturnType<typeof createManagedLspControlService>> {
  const service = createManagedLspControlService({
    store: createManagedLspActivationStore({ stateDir: join(base, "activation") }),
    mutex: createWorkspaceMutexRegistry(),
    workspaceTrust: (): "trusted" => "trusted",
    runtimeApproved: (): boolean => true,
    configurationSafe: (): boolean => true,
    projectEvidence: (): "projected" => "projected",
    provisioning: (): boolean => true,
    processEnv: {},
    disposePoolEntry: (): Promise<void> => Promise.resolve(),
  });
  const activation = await service.mutate({
    root: workspace,
    language: "rust",
    actorClass: "localHuman",
    action: "activate",
    expectedRevision: 0,
    idempotencyKey: "reconstruction-activation",
  });
  if (activation.kind !== "ok") throw new TypeError("Expected real semantic-token activation");
  return service;
}

function tokenRouteContext(socket: Socket, workspace: string, text: string): RouteContext {
  const req = new IncomingMessage(socket);
  req.method = "POST";
  req.complete = true;
  req.push(
    Buffer.from(
      JSON.stringify({
        schemaVersion: "1",
        root: workspace,
        document: { path: "lib.rs", languageId: "rust", text, version: 1 },
      }),
      "utf8",
    ),
  );
  req.push(null);
  return {
    req,
    res: new ServerResponse(req),
    correlationId: tokenReconstructionCorrelation,
    params: {},
    url: new URL("http://localhost/api/editor/language/semantic-tokens"),
  };
}

function unexpectedTokenTrustOperation(): never {
  throw new TypeError("Unexpected semantic reconstruction trust operation");
}

function tokenTrustPort(): WorkspaceScriptTrustService {
  return {
    grant: unexpectedTokenTrustOperation,
    deriveFromTrustedRoot: unexpectedTokenTrustOperation,
    revoke: unexpectedTokenTrustOperation,
    status: unexpectedTokenTrustOperation,
    isTrusted: unexpectedTokenTrustOperation,
    trustLevelForRoot: (): "trusted" => "trusted",
    holdsHumanGrantForRoot: unexpectedTokenTrustOperation,
    admitRunManifest: unexpectedTokenTrustOperation,
    holdsRunAdmissionForRoot: unexpectedTokenTrustOperation,
    revokeRunAdmissions: unexpectedTokenTrustOperation,
  };
}

function tokenRouteDependencies(
  resources: TokenReconstructionResources,
  bin: string,
  service: ReturnType<typeof createManagedLspControlService>,
  active: boolean,
): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    get evidenceStore(): never {
      throw new TypeError("Unexpected semantic evidence-store use");
    },
    get registry(): never {
      throw new TypeError("Unexpected semantic run-registry use");
    },
    modelPortFactory(): never {
      throw new TypeError("Unexpected semantic model-port use");
    },
    store: resources.store,
    redactor: buildRedactor({}),
    env: { PATH: bin },
    workspaceScriptTrust: tokenTrustPort(),
    ...(active ? { managedLspControl: service } : {}),
    activityLog: processServerLogSink(),
  };
}

function tokenProvider(sample: TokenReconstructionSample): ReturnType<typeof createFakeLspProcess> {
  const provider = createFakeLspProcess({
    behavior: sample.mode === "technical" ? "unresponsive-request" : "normal",
    initializeResult: {
      capabilities: {
        textDocumentSync: 2,
        semanticTokensProvider: {
          full: true,
          legend: { tokenTypes: ["struct"], tokenModifiers: ["declaration"] },
        },
      },
    },
    results: {
      "textDocument/semanticTokens/full": {
        data: sample.data,
        ...(sample.mode === "refusal" ? { note: tokenPayloadCanary } : {}),
      },
    },
    onMessage(method): void {
      if (method === "textDocument/semanticTokens/full" && sample.mode === "technical") {
        provider.emitError(new TypeError("PRIVATE_SEMANTIC_TRANSPORT_CANARY"));
      }
    },
  });
  return provider;
}

async function runTokenRoute(
  resources: TokenReconstructionResources,
  sample: TokenReconstructionSample,
): Promise<void> {
  const base = realpathSync(resources.rawRoot);
  const files = writeTokenWorkspace(base);
  resources.store.createProject(files.workspace, "semantic reconstruction");
  const control = await activateTokenWorkspace(files.workspace, base);
  const ctx = tokenRouteContext(resources.socket, files.workspace, sample.text);
  const provider = tokenProvider(sample);
  resources.providers.push(provider);
  const dependencies = tokenRouteDependencies(
    resources,
    files.bin,
    control,
    sample.mode !== "unavailable",
  );
  const startedAtMs = Date.now();
  const result = await handleEditorLanguageSemanticTokens(ctx, dependencies, {
    hostLanguageSpawn: () => provider.handle,
    hostLanguageCommandRules: ["cargo", "rust-analyzer", "rustc", "rustfmt"].map((executable) => ({
      executable,
    })),
    hostLanguageProcessConfig: { maxRestartsInWindow: 0 },
  });
  expectTokenRouteResult(sample, result);
  const reached = provider.receivedMethods().includes("textDocument/semanticTokens/full");
  expect(reached).toBe(sample.mode !== "unavailable");
  await proveTokenReconstruction(sample, startedAtMs);
}

async function closeTokenResources(resources: TokenReconstructionResources): Promise<void> {
  const errors: unknown[] = [];
  try {
    await shutdownHostLspPool();
  } catch (error) {
    errors.push(error);
  }
  try {
    for (const provider of resources.providers) {
      if (!provider.exitEmitted()) provider.handle.kill("SIGKILL");
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    resources.store.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    resources.socket.destroy();
  } catch (error) {
    errors.push(error);
  }
  try {
    rmSync(resources.rawRoot, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Semantic reconstruction resource cleanup failed", {
      cause: errors[0],
    });
  }
}

function createTokenResources(rawRoot: string): TokenReconstructionResources {
  const socket = new Socket();
  try {
    return { rawRoot, socket, providers: [], store: createInMemoryUiStore() };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function withTokenReconstruction(sample: TokenReconstructionSample): Promise<void> {
  const rawRoot = mkdtempSync(join(homedir(), ".keiko-token-reconstruction-"));
  let resources: TokenReconstructionResources | undefined;
  let failed = false;
  let failure: unknown;
  try {
    resources = createTokenResources(rawRoot);
    await runTokenRoute(resources, sample);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    if (resources === undefined) rmSync(rawRoot, { recursive: true, force: true });
    else await closeTokenResources(resources);
  } catch (cleanupError) {
    if (failed)
      throw new AggregateError([failure, cleanupError], "Token reconstruction cleanup failed", {
        cause: cleanupError,
      });
    throw cleanupError;
  }
  if (failed) throw failure;
}

function expectTokenRouteResult(sample: TokenReconstructionSample, result: RouteResult): void {
  expect(result.status).toBe(200);
  if (sample.mode === "served") {
    expect(result.body).toMatchObject({ schemaVersion: "1", supported: true });
  } else {
    expect(result.body).toEqual({ schemaVersion: "1", supported: false });
  }
}

async function tokenQuery(
  selector: Parameters<typeof resolveSupportSelection>[0],
): Promise<SupportQueryResult> {
  const selection = await resolveSupportSelection(selector, stateDir);
  const query = executeSupportQuery(
    stateDir,
    selection,
    {
      ...DEFAULT_SUPPORT_QUERY_LIMITS,
      contextMs: 0,
      maxContextEvents: 0,
    },
    { trigger: "query" },
  ).result;
  expect(query.metrics.contextEventCount).toBe(0);
  return query;
}

function tokenEvidenceLine(op: string): string {
  const lines = persistedActivityLogLines(readPersistedActivityLog(stateDir), op);
  expect(lines).toHaveLength(1);
  const line = lines[0];
  if (line === undefined) throw new TypeError("Missing semantic-token persisted evidence");
  return line;
}

async function proveTokenRefusal(startedAtMs: number): Promise<void> {
  const log = readPersistedActivityLog(stateDir);
  const record = expectActivityLogProof(
    "editor.semantic-tokens.refused.line",
    tokenEvidenceLine("editor.semantic-tokens.refused"),
  );
  expect(record).toMatchObject({
    correlationId: tokenReconstructionCorrelation,
    reason: "sanitizer-refused",
    errorKind: "validation-failed",
  });
  expect(record).not.toHaveProperty("frames");
  expect(record).not.toHaveProperty("causeChain");
  expect(persistedActivityLogLines(log, "editor.semantic-tokens.settled")).toHaveLength(0);
  expect(persistedActivityLogLines(log, "server.diagnostic.failure")).toHaveLength(0);
  const trace = await expectActivityLogScenario("editor-delivery.rejection", {
    stateDir,
    startedAtMs,
    expectedOps: ["editor.semantic-tokens.refused"],
    queryLimits: { ...DEFAULT_SUPPORT_QUERY_LIMITS, contextMs: 0, maxContextEvents: 0 },
  });
  expect(trace.failureClasses).toContain("editor-semantic-token-refusal");
}

async function proveTokenRequestFailure(startedAtMs: number): Promise<void> {
  const record = expectActivityLogProof(
    "editor.semantic-tokens.settled.line",
    tokenEvidenceLine("editor.semantic-tokens.settled"),
  );
  expect(record).toMatchObject({
    correlationId: tokenReconstructionCorrelation,
    outcome: "failed",
    reason: "request-failed",
    errorKind: "unknown",
  });
  const trace = await expectActivityLogScenario("editor-delivery.dependency-failure", {
    stateDir,
    startedAtMs,
    expectedOps: ["server.diagnostic.failure", "editor.semantic-tokens.settled"],
    queryLimits: { ...DEFAULT_SUPPORT_QUERY_LIMITS, contextMs: 0, maxContextEvents: 0 },
  });
  expect(trace.failureClasses).toContain("editor-semantic-token-settlement");
  expect(
    persistedActivityLogLines(readPersistedActivityLog(stateDir), "editor.semantic-tokens.refused"),
  ).toHaveLength(0);
}

async function proveTokenHealthy(sample: TokenReconstructionSample): Promise<void> {
  const record = expectActivityLogProof(
    "editor.semantic-tokens.settled.line",
    tokenEvidenceLine("editor.semantic-tokens.settled"),
  );
  expect(record).toMatchObject({
    correlationId: tokenReconstructionCorrelation,
    outcome: sample.mode === "served" ? "served" : "unavailable",
    reason: sample.mode === "served" ? "available" : "activation-unavailable",
  });
  if (sample.mode === "served") expect(record.returnedTokenCount).toBe(1);
  else expect(record).not.toHaveProperty("returnedTokenCount");
  const query = await tokenQuery({ correlationId: tokenReconstructionCorrelation, filter: {} });
  expect(query.events.map((event) => event.parsed.view.op)).toContain(
    "editor.semantic-tokens.settled",
  );
  const log = readPersistedActivityLog(stateDir);
  expect(persistedActivityLogLines(log, "editor.semantic-tokens.refused")).toHaveLength(0);
  expect(persistedActivityLogLines(log, "server.diagnostic.failure")).toHaveLength(0);
}

async function proveTokenReconstruction(
  sample: TokenReconstructionSample,
  startedAtMs: number,
): Promise<void> {
  const log = readPersistedActivityLog(stateDir);
  expect(log).not.toContain(tokenPayloadCanary);
  expect(log).not.toContain("PRIVATE_SEMANTIC_TRANSPORT_CANARY");
  if (sample.mode === "refusal") await proveTokenRefusal(startedAtMs);
  else if (sample.mode === "technical") await proveTokenRequestFailure(startedAtMs);
  else await proveTokenHealthy(sample);
}

const tokenReconstructionSamples: readonly TokenReconstructionSample[] = [
  {
    name: "malformed provider JSON",
    mode: "refusal",
    data: [0, 0, 6, 8, 0],
    text: `struct Value; // ${tokenPayloadCanary}\n`,
  },
  {
    name: "over-cap provider JSON",
    mode: "refusal",
    data: Array.from(
      { length: MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS + 1 },
      (_entry, index): number[] => [0, index === 0 ? 0 : 1, 1, 0, 0],
    ).flat(),
    text: "x".repeat(MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS + 2),
  },
  { name: "technical request failure", mode: "technical", data: [], text: "struct Value;\n" },
  {
    name: "healthy served response",
    mode: "served",
    data: [0, 0, 6, 0, 1],
    text: "struct Value;\n",
  },
  { name: "unavailable activation", mode: "unavailable", data: [], text: "struct Value;\n" },
];

describe("semantic-token registered reconstruction (#3918)", (): void => {
  for (const sample of tokenReconstructionSamples) {
    it(`reconstructs ${sample.name} without optional context`, async (): Promise<void> => {
      await withTokenReconstruction(sample);
    });
  }
});
