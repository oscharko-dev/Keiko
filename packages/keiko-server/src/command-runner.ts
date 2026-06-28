// Issue #1387 — controlled test/build/run command executor. A closed catalog of vetted tasks is
// discovered from the project's package.json scripts; a run names a catalog task id (never free-form
// argv) and is executed through the SINGLE governed spawn boundary, keiko-tools `runCommand`
// (ADR-0043 D2): no shell, name-allowlisted env, ephemeral HOME, workspace-contained cwd, output
// byte cap with truncation, timeout SIGTERM→SIGKILL, and AbortController cancellation. Nothing new is
// invented here — the executor allowlist (COMMAND_TASK_RULES) and the discovery source are the only
// additions over the proven ADR-0018 terminal machinery this module mirrors.
//
// Reuse (UNCHANGED): runCommand + DEFAULT_SANDBOX_POLICY (@oscharko-dev/keiko-tools), readWorkspaceFile
// + path containment (@oscharko-dev/keiko-workspace), EvidenceStore (@oscharko-dev/keiko-evidence),
// ProjectStore (./store). New (bounded composition): CommandRunnerManager + content-free run evidence.

import { randomUUID } from "node:crypto";
import {
  CommandCancelledError,
  CommandDeniedError,
  CommandTimeoutError,
  DEFAULT_SANDBOX_POLICY,
  runCommand,
  type CommandResult,
  type RunCommandDeps,
  type SandboxPolicy,
} from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
import { readWorkspaceFile } from "@oscharko-dev/keiko-workspace";
import type { WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  COMMAND_RUNNER_SCHEMA_VERSION,
  COMMAND_TASK_RULES,
  type CommandFailureReason,
  type CommandRunnerEvent,
  type CommandRunnerEventKind,
  type CommandTask,
  type CommandTaskCatalog,
  type CommandTaskKind,
  type CommandTaskRunResult,
} from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { CommandRunnerError } from "./command-runner-errors.js";
import {
  appendCommandRunEvidence,
  buildCommandRunEvidenceEntry,
} from "./command-runner-evidence.js";
import type { Project, UiStore } from "./store/index.js";

const MAX_CONCURRENT_RUNS = 8;
const MIN_TIMEOUT_MS = 1_000;
const PACKAGE_READ_BYTES = 262_144;
const MAX_SCRIPT_NAME_LENGTH = 120;
// First char must not be `-` (flag injection) and only conservative script-name characters are
// allowed, so a discovered name can never smuggle a flag or shell metacharacter into `npm run`.
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

// ─── Public types ─────────────────────────────────────────────────────────────────

export interface CommandRunInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly timeoutMs?: number | undefined;
  readonly requestId?: string | undefined;
}

export type CommandRunnerEventEmitter = (event: CommandRunnerEvent) => void;

export interface CommandRunnerManager {
  readonly discover: (projectId: string) => CommandTaskCatalog;
  readonly execute: (input: CommandRunInput) => Promise<CommandTaskRunResult>;
  readonly abort: (runId: string) => boolean;
  readonly subscribe: (listener: CommandRunnerEventEmitter) => () => void;
  readonly inFlightCount: () => number;
}

export interface CommandRunnerManagerOptions {
  readonly store: UiStore;
  readonly evidenceStore?: EvidenceStore | undefined;
  readonly policy?: SandboxPolicy | undefined;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly redactor?: ((input: string) => string) | undefined;
  readonly runDeps?: Partial<RunCommandDeps> | undefined;
  readonly now?: (() => number) | undefined;
}

// ─── Discovery (package.json scripts → vetted task catalog) ──────────────────────

function projectFor(store: UiStore, projectId: string): Project | undefined {
  for (const project of store.listProjects()) {
    if (project.path === projectId) {
      return project;
    }
  }
  return undefined;
}

function projectRootOrThrow(project: Project): string {
  try {
    return nodeWorkspaceFs.realPath(project.path);
  } catch {
    throw new CommandRunnerError("PROJECT_NOT_FOUND", "Project root path could not be resolved.");
  }
}

function buildWorkspaceInfo(projectRoot: string): WorkspaceInfo {
  return {
    root: projectRoot,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readPackageScripts(workspace: WorkspaceInfo, fs: WorkspaceFs): readonly string[] {
  let record: Record<string, unknown> | undefined;
  try {
    record = parseJsonObject(
      readWorkspaceFile(workspace, "package.json", { maxBytes: PACKAGE_READ_BYTES }, fs).text,
    );
  } catch {
    return [];
  }
  const scripts = record?.scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    return [];
  }
  return Object.entries(scripts)
    .filter(([, value]) => typeof value === "string")
    .map(([name]) => name)
    .filter((name) => name.length > 0 && name.length <= MAX_SCRIPT_NAME_LENGTH)
    .sort();
}

function classifyScriptKind(name: string): CommandTaskKind {
  const lower = name.toLowerCase();
  if (lower === "test" || lower.startsWith("test:") || lower.startsWith("test-")) {
    return "test";
  }
  if (lower === "build" || lower.startsWith("build:") || lower.startsWith("build-")) {
    return "build";
  }
  return "run";
}

function discoverTasks(workspace: WorkspaceInfo, fs: WorkspaceFs): readonly CommandTask[] {
  const tasks: CommandTask[] = [];
  for (const name of readPackageScripts(workspace, fs)) {
    if (!SAFE_SCRIPT_NAME.test(name)) {
      continue;
    }
    tasks.push({
      id: `npm-script:${name}`,
      kind: classifyScriptKind(name),
      label: `npm run ${name}`,
      executable: "npm",
      args: ["run", name],
      source: "package-json-script",
    });
  }
  return tasks;
}

// ─── Run outcome normalization (one settle path for success and failure) ─────────

interface SettledOutcome {
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly failureReason: CommandFailureReason;
  readonly eventKind: CommandRunnerEventKind;
  readonly stdout: string;
  readonly stderr: string;
}

function outcomeFromResult(result: CommandResult): SettledOutcome {
  // runCommand resolves only on a real process exit (timeout/cancel reject); a clean exit can still
  // be truncated. exitCode null here means an output-flood kill — not a clean exit, so non-zero-exit.
  const failureReason: CommandFailureReason = result.exitCode === 0 ? "none" : "non-zero-exit";
  return {
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    truncated: result.truncated,
    timedOut: false,
    failureReason,
    eventKind: "run-completed",
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function deniedFailureReason(error: unknown): CommandFailureReason {
  if (error instanceof CommandDeniedError && !error.message.includes("not found on PATH")) {
    return "denied";
  }
  return "spawn-error";
}

function outcomeFromError(
  error: unknown,
  cancelledByUser: boolean,
  durationMs: number,
): SettledOutcome {
  const base = { exitCode: null, durationMs, truncated: false, stdout: "", stderr: "" } as const;
  if (error instanceof CommandCancelledError || cancelledByUser) {
    return { ...base, timedOut: false, failureReason: "cancelled", eventKind: "run-cancelled" };
  }
  if (error instanceof CommandTimeoutError) {
    // ADR-0018 D7 — a timeout is a "completed with timedOut=true" outcome, not an infra failure.
    return { ...base, timedOut: true, failureReason: "timed-out", eventKind: "run-completed" };
  }
  return {
    ...base,
    timedOut: false,
    failureReason: deniedFailureReason(error),
    eventKind: "run-failed",
  };
}

function clampTimeout(requested: number | undefined, ceiling: number): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return ceiling;
  }
  const rounded = Math.round(requested);
  if (rounded <= MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (rounded >= ceiling) return ceiling;
  return rounded;
}

function requestIdPayload(input: CommandRunInput): Record<string, string> {
  return input.requestId === undefined ? {} : { requestId: input.requestId };
}

// ─── Manager ─────────────────────────────────────────────────────────────────────

interface InFlightRun {
  readonly controller: AbortController;
  cancelledByUser: boolean;
}

class CommandRunnerManagerImpl implements CommandRunnerManager {
  private readonly store: UiStore;
  private readonly evidenceStore: EvidenceStore | undefined;
  private readonly policy: SandboxPolicy;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly redactor: (input: string) => string;
  private readonly runDeps: Partial<RunCommandDeps>;
  private readonly now: () => number;
  private readonly runs = new Map<string, InFlightRun>();
  private readonly subscribers = new Set<CommandRunnerEventEmitter>();

  public constructor(opts: CommandRunnerManagerOptions) {
    this.store = opts.store;
    this.evidenceStore = opts.evidenceStore;
    this.policy = opts.policy ?? DEFAULT_SANDBOX_POLICY;
    this.processEnv = opts.processEnv ?? process.env;
    this.redactor = opts.redactor ?? ((input: string): string => input);
    this.runDeps = opts.runDeps ?? {};
    this.now = opts.now ?? Date.now;
  }

  public readonly inFlightCount = (): number => this.runs.size;

  public readonly subscribe = (listener: CommandRunnerEventEmitter): (() => void) => {
    this.subscribers.add(listener);
    return (): void => {
      this.subscribers.delete(listener);
    };
  };

  public readonly abort = (runId: string): boolean => {
    const entry = this.runs.get(runId);
    if (entry === undefined) return false;
    entry.cancelledByUser = true;
    entry.controller.abort();
    return true;
  };

  public readonly discover = (projectId: string): CommandTaskCatalog => {
    const workspace = this.resolveWorkspace(projectId);
    return {
      schemaVersion: COMMAND_RUNNER_SCHEMA_VERSION,
      projectId,
      tasks: discoverTasks(workspace, this.fs()),
    };
  };

  public readonly execute = async (input: CommandRunInput): Promise<CommandTaskRunResult> => {
    const workspace = this.resolveWorkspace(input.projectId);
    // Re-discover the catalog at execute time on purpose: the requested taskId is untrusted, so the
    // server re-derives the vetted task from the CURRENT package.json rather than trusting a catalog
    // the client fetched earlier (which may be stale or forged). The extra manifest read is a
    // deliberate security re-validation on a low-frequency, user-triggered path, not a hot loop.
    const task = discoverTasks(workspace, this.fs()).find((entry) => entry.id === input.taskId);
    if (task === undefined) {
      throw new CommandRunnerError("TASK_NOT_FOUND", "Task is not in the discovered catalog.");
    }
    if (this.runs.size >= MAX_CONCURRENT_RUNS) {
      throw new CommandRunnerError("RUN_LIMIT_EXCEEDED", "Too many in-flight command runs.");
    }
    return this.runExecution(task, workspace, input);
  };

  private fs(): WorkspaceFs {
    return this.runDeps.fs ?? nodeWorkspaceFs;
  }

  private resolveWorkspace(projectId: string): WorkspaceInfo {
    const project = projectFor(this.store, projectId);
    if (project === undefined) {
      throw new CommandRunnerError("PROJECT_NOT_FOUND", "Project not found.");
    }
    return buildWorkspaceInfo(projectRootOrThrow(project));
  }

  private buildRunDeps(workspace: WorkspaceInfo): RunCommandDeps {
    return {
      workspace,
      policy: this.policy,
      commandRules: COMMAND_TASK_RULES,
      spawn: this.runDeps.spawn ?? nodeSpawnFn,
      processEnv: this.processEnv,
      now: this.runDeps.now ?? this.now,
      ...(this.runDeps.resolveExecutable === undefined
        ? {}
        : { resolveExecutable: this.runDeps.resolveExecutable }),
      ...(this.runDeps.fs === undefined ? {} : { fs: this.runDeps.fs }),
      ...(this.runDeps.home === undefined ? {} : { home: this.runDeps.home }),
    };
  }

  private async runExecution(
    task: CommandTask,
    workspace: WorkspaceInfo,
    input: CommandRunInput,
  ): Promise<CommandTaskRunResult> {
    const runId = randomUUID();
    const controller = new AbortController();
    const entry: InFlightRun = { controller, cancelledByUser: false };
    this.runs.set(runId, entry);
    const startedAt = this.now();
    this.emit({
      kind: "run-started",
      runId,
      payload: { taskId: task.id, kind: task.kind, startedAt, ...requestIdPayload(input) },
    });
    try {
      return await this.invoke(runId, task, workspace, input, entry, startedAt);
    } finally {
      this.runs.delete(runId);
    }
  }

  private async invoke(
    runId: string,
    task: CommandTask,
    workspace: WorkspaceInfo,
    input: CommandRunInput,
    entry: InFlightRun,
    startedAt: number,
  ): Promise<CommandTaskRunResult> {
    const deps = this.buildRunDeps(workspace);
    const timeoutMs = clampTimeout(input.timeoutMs, this.policy.defaultTimeoutMs);
    try {
      const result = await runCommand(
        {
          command: task.executable,
          args: task.args,
          cwd: undefined,
          timeoutMs,
          signal: entry.controller.signal,
        },
        deps,
      );
      return this.finalize(runId, task, input, outcomeFromResult(result), startedAt);
    } catch (error) {
      const outcome = outcomeFromError(error, entry.cancelledByUser, this.now() - startedAt);
      return this.finalize(runId, task, input, outcome, startedAt);
    }
  }

  private finalize(
    runId: string,
    task: CommandTask,
    input: CommandRunInput,
    outcome: SettledOutcome,
    startedAt: number,
  ): CommandTaskRunResult {
    this.persist(runId, task, input, outcome, startedAt);
    this.emit({
      kind: outcome.eventKind,
      runId,
      payload: {
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        truncated: outcome.truncated,
        timedOut: outcome.timedOut,
        failureReason: outcome.failureReason,
        ...requestIdPayload(input),
      },
    });
    return {
      schemaVersion: COMMAND_RUNNER_SCHEMA_VERSION,
      runId,
      taskId: task.id,
      kind: task.kind,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      truncated: outcome.truncated,
      timedOut: outcome.timedOut,
      failureReason: outcome.failureReason,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    };
  }

  private persist(
    runId: string,
    task: CommandTask,
    input: CommandRunInput,
    outcome: SettledOutcome,
    startedAt: number,
  ): void {
    if (this.evidenceStore === undefined) return;
    try {
      const evidence = buildCommandRunEvidenceEntry({
        runId,
        projectId: input.projectId,
        taskId: task.id,
        kind: task.kind,
        executable: task.executable,
        argCount: task.args.length,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        timedOut: outcome.timedOut,
        truncated: outcome.truncated,
        failureReason: outcome.failureReason,
        stdoutBytes: Buffer.byteLength(outcome.stdout, "utf8"),
        stderrBytes: Buffer.byteLength(outcome.stderr, "utf8"),
        startedAt,
      });
      appendCommandRunEvidence(this.evidenceStore, evidence, this.redactor);
    } catch {
      // Evidence is best-effort process-evidence; a write hiccup must not corrupt a real run result.
    }
  }

  private emit(event: CommandRunnerEvent): void {
    for (const listener of [...this.subscribers]) {
      try {
        listener(event);
      } catch {
        // A subscriber throwing must not stop fan-out (matches the terminal/browser tool pattern).
      }
    }
  }
}

export function createCommandRunnerManager(
  opts: CommandRunnerManagerOptions,
): CommandRunnerManager {
  return new CommandRunnerManagerImpl(opts);
}
