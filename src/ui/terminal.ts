// ADR-0018 — bounded, permitted-command execution surface for the UI terminal. Replaces the
// previous PTY surface with a synchronous `runCommand` per HTTP request. The allowlist
// (TERMINAL_COMMAND_RULES) plus the existing ADR-0006 sandbox boundary form the trust model;
// nothing new is invented here.
//
// Reuse (UNCHANGED):
//   • runCommand from src/tools/exec.ts (sandbox env, no-shell, cwd realpath, output cap, abort)
//   • EvidenceStore from src/audit/store.ts (atomic O_EXCL + realpath-contained write)
//   • deepRedactStrings from src/audit/redaction.ts (Layer-2 redact-before-persist)
//   • ProjectStore from src/ui/store/** (projectId → workspaceRoot)
//
// New (bounded composition):
//   • TerminalExecutionManager: execute(input) / abort(executionId) / subscribe(handler).
//   • In-memory Map<executionId, InFlight> capped at MAX_CONCURRENT_EXECUTIONS = 8 (D9).
//   • SSE-source observer pattern mirroring the browser tool (no HarnessEvent envelope).
//   • Directory picker preserved from the previous PTY module, anchored at the project root.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  resolve as resolvePath,
} from "node:path";
import {
  CommandCancelledError,
  CommandDeniedError,
  CommandTimeoutError,
} from "../tools/errors.js";
import { nodeSpawnFn, runCommand, type RunCommandDeps } from "../tools/exec.js";
import {
  isTerminalCommandAllowed,
  TERMINAL_COMMAND_RULES,
} from "../tools/terminal-policy.js";
import { isWithinWorkspace, resolveWithinWorkspace } from "../workspace/paths.js";
import { PathDeniedError } from "../workspace/errors.js";
import type { WorkspaceInfo } from "../workspace/types.js";
import { DEFAULT_SANDBOX_POLICY, type SandboxPolicy } from "../tools/types.js";
import {
  appendTerminalEvidence,
  buildTerminalEvidenceEntry,
  type TerminalEvidenceEntry,
} from "./terminal-evidence.js";
import { TerminalToolError } from "./terminal-errors.js";
import type { EvidenceStore } from "../audit/store.js";
import type { Project, UiStore } from "./store/index.js";

const MAX_CONCURRENT_EXECUTIONS = 8;
const MIN_TIMEOUT_MS = 1_000;

// ─── Public types ─────────────────────────────────────────────────────────────────

export interface TerminalExecutionInput {
  readonly projectId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface TerminalExecutionResult {
  readonly executionId: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export type TerminalEventKind =
  | "execution-started"
  | "execution-completed"
  | "execution-failed"
  | "execution-cancelled";

export interface TerminalEventEnvelope {
  readonly kind: TerminalEventKind;
  readonly executionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type TerminalEventEmitter = (event: TerminalEventEnvelope) => void;

export interface TerminalExecutionManager {
  readonly execute: (input: TerminalExecutionInput) => Promise<TerminalExecutionResult>;
  readonly abort: (executionId: string) => boolean;
  readonly subscribe: (listener: TerminalEventEmitter) => () => void;
  readonly inFlightCount: () => number;
}

export interface TerminalDirectoryEntry {
  readonly name: string;
  readonly path: string;
}

export interface TerminalDirectoryRoot {
  readonly label: string;
  readonly path: string;
}

export interface TerminalDirectoryListing {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly TerminalDirectoryEntry[];
  readonly roots: readonly TerminalDirectoryRoot[];
}

export interface TerminalPolicySummary {
  readonly commands: readonly string[];
  readonly limits: {
    readonly maxOutputBytes: number;
    readonly defaultTimeoutMs: number;
  };
}

// ─── Manager ─────────────────────────────────────────────────────────────────────

interface InFlightExecution {
  readonly controller: AbortController;
  readonly projectId: string;
  cancelledByUser: boolean;
}

export interface TerminalExecutionManagerOptions {
  readonly store: UiStore;
  readonly evidenceStore?: EvidenceStore | undefined;
  readonly policy?: SandboxPolicy | undefined;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly redactor?: ((input: string) => string) | undefined;
  readonly runDeps?: Partial<RunCommandDeps> | undefined;
  readonly now?: (() => number) | undefined;
}

function defaultRedactor(input: string): string {
  return input;
}

function projectFor(store: UiStore, projectId: string): Project | undefined {
  for (const project of store.listProjects()) {
    if (project.path === projectId) {
      return project;
    }
  }
  return undefined;
}

// Tier-2 cwd containment (ADR-0018 D2 project-scoped pre-check). The requested cwd must resolve
// lexically inside the project root before we hand it to `runCommand`, which then re-checks via
// realpath/deny-list (Tier 1). A path traversal is denied here; a symlink escape is denied there.
function assertCwdInsideProject(projectRoot: string, requested: string | undefined): string {
  const candidate = requested === undefined || requested.length === 0 ? "." : requested;
  let lexical: string;
  try {
    lexical = resolveWithinWorkspace(projectRoot, candidate);
  } catch {
    throw new TerminalToolError(
      "CWD_OUTSIDE_PROJECT",
      "Working directory is outside the selected project.",
    );
  }
  if (!isWithinWorkspace(projectRoot, lexical)) {
    throw new TerminalToolError(
      "CWD_OUTSIDE_PROJECT",
      "Working directory is outside the selected project.",
    );
  }
  return lexical;
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

interface CompletionCounts {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly startedAt: number;
}

class TerminalExecutionManagerImpl implements TerminalExecutionManager {
  private readonly store: UiStore;
  private readonly evidenceStore: EvidenceStore | undefined;
  private readonly policy: SandboxPolicy;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly redactor: (input: string) => string;
  private readonly runDeps: Partial<RunCommandDeps>;
  private readonly now: () => number;
  private readonly executions = new Map<string, InFlightExecution>();
  private readonly subscribers = new Set<TerminalEventEmitter>();

  public constructor(opts: TerminalExecutionManagerOptions) {
    this.store = opts.store;
    this.evidenceStore = opts.evidenceStore;
    this.policy = opts.policy ?? DEFAULT_SANDBOX_POLICY;
    this.processEnv = opts.processEnv ?? process.env;
    this.redactor = opts.redactor ?? defaultRedactor;
    this.runDeps = opts.runDeps ?? {};
    this.now = opts.now ?? Date.now;
  }

  public readonly inFlightCount = (): number => this.executions.size;

  public readonly subscribe = (listener: TerminalEventEmitter): (() => void) => {
    this.subscribers.add(listener);
    return (): void => {
      this.subscribers.delete(listener);
    };
  };

  public readonly abort = (executionId: string): boolean => {
    const entry = this.executions.get(executionId);
    if (entry === undefined) return false;
    entry.cancelledByUser = true;
    entry.controller.abort();
    return true;
  };

  public readonly execute = async (
    input: TerminalExecutionInput,
  ): Promise<TerminalExecutionResult> => {
    const project = projectFor(this.store, input.projectId);
    if (project === undefined) {
      throw new TerminalToolError("PROJECT_NOT_FOUND", "Project not found.");
    }
    const decision = isTerminalCommandAllowed(input.command, input.args);
    if (!decision.allowed) {
      throw new TerminalToolError("COMMAND_DENIED", "Command is not in the allowlist.");
    }
    if (this.executions.size >= MAX_CONCURRENT_EXECUTIONS) {
      throw new TerminalToolError(
        "EXECUTION_LIMIT_EXCEEDED",
        "Too many in-flight terminal executions.",
      );
    }
    const cwd = assertCwdInsideProject(project.path, input.cwd);
    return this.runExecution(project.path, cwd, input);
  };

  private async runExecution(
    projectRoot: string,
    cwd: string,
    input: TerminalExecutionInput,
  ): Promise<TerminalExecutionResult> {
    const executionId = randomUUID();
    const controller = new AbortController();
    const entry: InFlightExecution = {
      controller,
      projectId: input.projectId,
      cancelledByUser: false,
    };
    this.executions.set(executionId, entry);
    const startedAt = this.now();
    this.emitStarted(executionId, input, startedAt);
    try {
      return await this.invokeRunCommand(executionId, projectRoot, cwd, input, entry, startedAt);
    } finally {
      this.executions.delete(executionId);
    }
  }

  // The Layer-1 rule inside runCommand is the *bare-executable* check. We've already proved (via
  // BFF gate + TERMINAL_COMMAND_RULES + Layer-2 isTerminalCommandAllowed) that this invocation is
  // allowed; pass a single-entry rule list with just the bare name so runCommand allows this exact
  // executable. A different command spawn here would be denied by runCommand's own allowlist —
  // the bare-name check stays in force.
  private buildRunDepsFor(projectRoot: string, command: string): RunCommandDeps {
    const workspace: WorkspaceInfo = {
      root: projectRoot,
      name: undefined,
      version: undefined,
      testFramework: "unknown",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    };
    const acceptingRule = { executable: command };
    return {
      workspace,
      policy: this.policy,
      commandRules: this.runDeps.commandRules ?? [acceptingRule],
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

  private async invokeRunCommand(
    executionId: string,
    projectRoot: string,
    cwd: string,
    input: TerminalExecutionInput,
    entry: InFlightExecution,
    startedAt: number,
  ): Promise<TerminalExecutionResult> {
    const deps = this.buildRunDepsFor(projectRoot, input.command);
    const timeoutMs = clampTimeout(input.timeoutMs, this.policy.defaultTimeoutMs);
    try {
      const result = await runCommand(
        {
          command: input.command,
          args: input.args,
          cwd,
          timeoutMs,
          signal: entry.controller.signal,
        },
        deps,
      );
      return this.handleSuccess(executionId, input, result, startedAt);
    } catch (error) {
      this.recordFailure(executionId, input, entry, error, startedAt);
      throw this.mapError(error, entry);
    }
  }

  private handleSuccess(
    executionId: string,
    input: TerminalExecutionInput,
    result: import("../tools/types.js").CommandResult,
    startedAt: number,
  ): TerminalExecutionResult {
    const stdoutBytes = Buffer.byteLength(result.stdout, "utf8");
    const stderrBytes = Buffer.byteLength(result.stderr, "utf8");
    const counts: CompletionCounts = {
      exitCode: result.exitCode,
      signal: null,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      truncated: result.truncated,
      stdoutBytes,
      stderrBytes,
      startedAt,
    };
    this.persistEntry(executionId, input, counts);
    this.emit({
      kind: "execution-completed",
      executionId,
      payload: {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        truncated: result.truncated,
        timedOut: result.timedOut,
        stdoutByteLength: stdoutBytes,
        stderrByteLength: stderrBytes,
      },
    });
    return {
      executionId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      truncated: result.truncated,
      timedOut: result.timedOut,
    };
  }

  private recordFailure(
    executionId: string,
    input: TerminalExecutionInput,
    entry: InFlightExecution,
    error: unknown,
    startedAt: number,
  ): void {
    const cancelled = error instanceof CommandCancelledError || entry.cancelledByUser;
    const counts: CompletionCounts = {
      exitCode: null,
      signal: cancelled ? "SIGTERM" : null,
      durationMs: this.now() - startedAt,
      timedOut: error instanceof CommandTimeoutError,
      truncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      startedAt,
    };
    this.persistEntry(executionId, input, counts);
    if (cancelled) {
      this.emit({ kind: "execution-cancelled", executionId, payload: {} });
      return;
    }
    const mapped = this.mapError(error, entry);
    this.emit({
      kind: "execution-failed",
      executionId,
      payload: { code: mapped.code, message: mapped.message },
    });
  }

  private persistEntry(
    executionId: string,
    input: TerminalExecutionInput,
    counts: CompletionCounts,
  ): void {
    if (this.evidenceStore === undefined) return;
    const entry: TerminalEvidenceEntry = buildTerminalEvidenceEntry({
      executionId,
      projectId: input.projectId,
      command: input.command,
      argCount: input.args.length,
      exitCode: counts.exitCode,
      signal: counts.signal,
      durationMs: counts.durationMs,
      timedOut: counts.timedOut,
      truncated: counts.truncated,
      stdoutBytes: counts.stdoutBytes,
      stderrBytes: counts.stderrBytes,
      startedAt: counts.startedAt,
    });
    try {
      appendTerminalEvidence(this.evidenceStore, entry, this.redactor);
    } catch {
      // Evidence is observability: a write failure must not break the user-visible execution.
    }
  }

  private mapError(error: unknown, entry: InFlightExecution): TerminalToolError {
    if (error instanceof TerminalToolError) return error;
    if (error instanceof CommandTimeoutError) {
      return new TerminalToolError("TIMEOUT", "Command timed out.");
    }
    if (error instanceof CommandCancelledError || entry.cancelledByUser) {
      return new TerminalToolError("CANCELLED", "Command was cancelled.");
    }
    if (error instanceof PathDeniedError) {
      return new TerminalToolError("CWD_DENIED", "Working directory is denied by policy.");
    }
    if (error instanceof CommandDeniedError) {
      return this.mapCommandDenied(error);
    }
    return new TerminalToolError("INTERNAL", "Command execution failed.");
  }

  private mapCommandDenied(error: CommandDeniedError): TerminalToolError {
    if (error.message.includes("not found on PATH")) {
      return new TerminalToolError("EXECUTABLE_NOT_FOUND", "Command executable not found on PATH.");
    }
    return new TerminalToolError("COMMAND_DENIED", "Command is not in the allowlist.");
  }

  private emitStarted(
    executionId: string,
    input: TerminalExecutionInput,
    startedAt: number,
  ): void {
    this.emit({
      kind: "execution-started",
      executionId,
      payload: {
        projectId: input.projectId,
        command: input.command,
        argCount: input.args.length,
        startedAt,
      },
    });
  }

  private emit(event: TerminalEventEnvelope): void {
    for (const listener of [...this.subscribers]) {
      try {
        listener(event);
      } catch {
        // A subscriber throwing must not stop fan-out (matches the browser tool pattern).
      }
    }
  }
}

export function createTerminalExecutionManager(
  opts: TerminalExecutionManagerOptions,
): TerminalExecutionManager {
  return new TerminalExecutionManagerImpl(opts);
}

// ─── Policy summary (GET /api/terminal/policy) ───────────────────────────────────

// A6 — Derived from TERMINAL_COMMAND_RULES so the policy and the summary stay in sync.
// Materialized once at module load so the GET handler is O(1) and the public surface is a
// frozen list — a test that compares against this exact set locks the deny-by-default invariant.
const ALLOWED_COMMAND_NAMES: readonly string[] = Object.freeze(
  [...TERMINAL_COMMAND_RULES.map((r) => r.executable)].sort(),
);

export function buildTerminalPolicySummary(
  policy: SandboxPolicy = DEFAULT_SANDBOX_POLICY,
): TerminalPolicySummary {
  return {
    commands: ALLOWED_COMMAND_NAMES,
    limits: {
      maxOutputBytes: policy.maxOutputBytes,
      defaultTimeoutMs: policy.defaultTimeoutMs,
    },
  };
}

// ─── Directory picker (anchored at the project root — A3 containment) ────────────

function defaultCwdFromProject(project: Project): string {
  if (existsSync(project.path)) return project.path;
  return process.cwd();
}

function parentPath(pathValue: string, projectRoot: string): string | null {
  // Do not let parent navigation escape the project root.
  if (pathValue === projectRoot) return null;
  const parsed = parsePath(pathValue);
  return pathValue === parsed.root ? null : dirname(pathValue);
}

// A3 — Normalise the client-supplied path to an absolute path. Relative paths are resolved
// against `projectRoot`. Absolute paths are kept as-is; realpath containment is enforced
// in `resolveDirectory` after both sides are realpath'd (handles macOS /tmp → /private/tmp).
function normalizeClientPath(pathInput: string | undefined, projectRoot: string): string {
  const raw = pathInput?.trim();
  if (raw === undefined || raw.length === 0) {
    return projectRoot;
  }
  return isAbsolute(raw) ? raw : resolvePath(projectRoot, raw);
}

async function resolveDirectory(candidate: string, projectRoot: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new TerminalToolError("BAD_REQUEST", "The working directory does not exist.");
  }
  // Realpath containment check — catches symlink escapes (Tier 2 of ADR-0018 D2).
  if (!isWithinWorkspace(projectRoot, resolved)) {
    throw new TerminalToolError(
      "CWD_OUTSIDE_PROJECT",
      "Working directory is outside the selected project.",
    );
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new TerminalToolError("BAD_REQUEST", "The working directory must be a directory.");
  }
  return resolved;
}

export async function listDirectories(
  store: UiStore,
  projectId: string,
  pathInput: string | undefined,
): Promise<TerminalDirectoryListing> {
  const project = projectFor(store, projectId);
  if (project === undefined) {
    throw new TerminalToolError("PROJECT_NOT_FOUND", "Project not found.");
  }
  const projectRootRaw = defaultCwdFromProject(project);
  // Resolve the project root to its real path first so that comparisons on macOS (where /tmp
  // is a symlink to /private/tmp) don't false-positive as escapes.
  let projectRoot: string;
  try {
    projectRoot = await realpath(projectRootRaw);
  } catch {
    throw new TerminalToolError("PROJECT_NOT_FOUND", "Project root path could not be resolved.");
  }
  const lexical = normalizeClientPath(pathInput, projectRoot);
  const pathValue = await resolveDirectory(lexical, projectRoot);
  const entries = await readdir(pathValue, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(pathValue, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // A3 — roots contains only the project root. Home and FS-root are no longer exposed because
  // they could be outside the project boundary. The UI cwd picker shows only project-scoped paths.
  const roots: readonly TerminalDirectoryRoot[] = [
    { label: "Project root", path: projectRoot },
  ];
  return {
    path: pathValue,
    parent: parentPath(pathValue, projectRoot),
    entries: dirs,
    roots,
  };
}
