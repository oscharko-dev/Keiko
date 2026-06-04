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
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse as parsePath, resolve as resolvePath } from "node:path";
import {
  CommandCancelledError,
  CommandDeniedError,
  CommandTimeoutError,
} from "@oscharko-dev/keiko-tools";
import { runCommand, type RunCommandDeps } from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
import { isTerminalCommandAllowed, TERMINAL_COMMAND_RULES } from "@oscharko-dev/keiko-tools";
import { isWithinWorkspace, resolveWithinWorkspace } from "@oscharko-dev/keiko-workspace";
import { PathDeniedError } from "@oscharko-dev/keiko-workspace";
import { isDenied } from "@oscharko-dev/keiko-workspace";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { containedRealPathInfo } from "@oscharko-dev/keiko-workspace";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { DEFAULT_SANDBOX_POLICY, type SandboxPolicy } from "@oscharko-dev/keiko-tools";
import {
  appendTerminalEvidence,
  buildTerminalEvidenceEntry,
  type TerminalEvidenceEntry,
} from "./terminal-evidence.js";
import { TerminalToolError } from "./terminal-errors.js";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
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
  readonly requestId?: string | undefined;
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

interface OperandValidationContext {
  readonly fs: WorkspaceFs;
  readonly projectRoot: string;
  readonly cwd: string;
}

interface GrepValidationState {
  afterTerminator: boolean;
  expectPattern: boolean;
  nextPattern: boolean;
  nextPath: boolean;
  nextPathProvidesPattern: boolean;
  nextScalar: boolean;
}

interface OperandValueState {
  afterTerminator: boolean;
  pending: "path" | "scalar" | undefined;
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

function projectRootOrThrow(project: Project): string {
  try {
    return realpathSyncCompat(project.path);
  } catch {
    throw new TerminalToolError("PROJECT_NOT_FOUND", "Project root path could not be resolved.");
  }
}

function realpathSyncCompat(pathValue: string): string {
  return nodeWorkspaceFs.realPath(pathValue);
}

function requestIdPayload(input: TerminalExecutionInput): Record<string, string> {
  return input.requestId === undefined ? {} : { requestId: input.requestId };
}

function assertOperandInsideProject(ctx: OperandValidationContext, operand: string): void {
  if (operand.length === 0 || operand === "-") {
    throw new TerminalToolError(
      "COMMAND_DENIED",
      "Command operands must stay inside the selected project.",
    );
  }
  let lexical: string;
  try {
    const candidate = isAbsolute(operand) ? resolvePath(operand) : resolvePath(ctx.cwd, operand);
    lexical = resolveWithinWorkspace(ctx.projectRoot, candidate);
  } catch {
    throw new TerminalToolError(
      "CWD_OUTSIDE_PROJECT",
      "Command operand is outside the selected project.",
    );
  }
  const lexicalRelative = lexical.slice(ctx.projectRoot.length).replace(/^[/\\]/, "");
  if (isDenied(lexicalRelative)) {
    throw new TerminalToolError("CWD_DENIED", "Command operand is denied by policy.");
  }
  try {
    const info = containedRealPathInfo(ctx.fs, ctx.projectRoot, lexical);
    if (isDenied(info.realRelative)) {
      throw new TerminalToolError("CWD_DENIED", "Command operand is denied by policy.");
    }
  } catch (error) {
    if (error instanceof TerminalToolError) throw error;
    throw new TerminalToolError(
      "CWD_OUTSIDE_PROJECT",
      "Command operand is outside the selected project.",
    );
  }
}

function isOptionTerminator(arg: string): boolean {
  return arg === "--";
}

function isFlag(arg: string, afterTerminator: boolean): boolean {
  return !afterTerminator && arg.startsWith("-") && arg !== "-";
}

function flagName(arg: string): string {
  const equalsIndex = arg.indexOf("=");
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
}

function equalsValueFor(arg: string, flags: ReadonlySet<string>): string | undefined {
  const equalsIndex = arg.indexOf("=");
  if (equalsIndex === -1) return undefined;
  const flag = arg.slice(0, equalsIndex);
  return flags.has(flag) ? arg.slice(equalsIndex + 1) : undefined;
}

function shortInlineValueFor(arg: string, flags: ReadonlySet<string>): string | undefined {
  for (const flag of flags) {
    if (flag.startsWith("--") || flag.length !== 2) continue;
    if (arg.startsWith(flag) && arg.length > flag.length) return arg.slice(flag.length);
  }
  return undefined;
}

function inlineValueFor(arg: string, flags: ReadonlySet<string>): string | undefined {
  return equalsValueFor(arg, flags) ?? shortInlineValueFor(arg, flags);
}

function isSeparatedValueFlag(arg: string, flags: ReadonlySet<string>): boolean {
  return !arg.includes("=") && flags.has(arg);
}

function consumePendingOperandValue(
  ctx: OperandValidationContext,
  state: OperandValueState,
  arg: string,
): boolean {
  if (state.pending === undefined) return false;
  const pending = state.pending;
  state.pending = undefined;
  if (pending === "path") assertOperandInsideProject(ctx, arg);
  return true;
}

function consumeValueFlag(
  ctx: OperandValidationContext,
  state: OperandValueState,
  arg: string,
  pathFlags: ReadonlySet<string>,
  scalarFlags: ReadonlySet<string>,
): boolean {
  const pathValue = inlineValueFor(arg, pathFlags);
  if (pathValue !== undefined) {
    assertOperandInsideProject(ctx, pathValue);
    return true;
  }
  if (isSeparatedValueFlag(arg, pathFlags)) {
    state.pending = "path";
    return true;
  }
  if (inlineValueFor(arg, scalarFlags) !== undefined) return true;
  if (isSeparatedValueFlag(arg, scalarFlags)) {
    state.pending = "scalar";
    return true;
  }
  return false;
}

function validatePathOperands(
  ctx: OperandValidationContext,
  args: readonly string[],
  scalarFlags: ReadonlySet<string>,
  pathFlags: ReadonlySet<string> = FROZEN_EMPTY_SET,
): void {
  const state: OperandValueState = { afterTerminator: false, pending: undefined };
  for (const arg of args) {
    if (consumePendingOperandValue(ctx, state, arg)) continue;
    if (!state.afterTerminator && isOptionTerminator(arg)) {
      state.afterTerminator = true;
      continue;
    }
    if (!state.afterTerminator && consumeValueFlag(ctx, state, arg, pathFlags, scalarFlags)) {
      continue;
    }
    if (isFlag(arg, state.afterTerminator)) continue;
    assertOperandInsideProject(ctx, arg);
  }
}

const FROZEN_EMPTY_SET: ReadonlySet<string> = new Set();
const HEAD_TAIL_SCALAR_FLAGS: ReadonlySet<string> = new Set(["-n", "-c", "--lines", "--bytes"]);
const LS_SCALAR_FLAGS: ReadonlySet<string> = new Set([
  "-w",
  "--width",
  "--block-size",
  "--color",
  "--format",
  "--time",
  "--sort",
  "--ignore",
  "--hide",
  "--indicator-style",
  "--quoting-style",
  "--tabsize",
]);
const TREE_SCALAR_FLAGS: ReadonlySet<string> = new Set([
  "-L",
  "-I",
  "-P",
  "--charset",
  "--filelimit",
  "--timefmt",
  "--sort",
]);
const GREP_PATTERN_FILE_FLAGS: ReadonlySet<string> = new Set(["-f", "--file"]);
const GREP_PATH_VALUE_FLAGS: ReadonlySet<string> = new Set(["--exclude-from"]);
const GREP_SCALAR_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-A",
  "-B",
  "-C",
  "-D",
  "-d",
  "-m",
  "--after-context",
  "--before-context",
  "--binary-files",
  "--color",
  "--context",
  "--devices",
  "--directories",
  "--label",
  "--max-count",
]);

function shortClusterEndsWithFlag(arg: string, flag: string): boolean {
  return (
    arg.startsWith("-") && !arg.startsWith("--") && arg.length > 2 && arg.endsWith(flag.slice(1))
  );
}

function consumePendingGrepOperand(
  ctx: OperandValidationContext,
  state: GrepValidationState,
  arg: string,
): boolean {
  if (state.nextPattern) {
    state.nextPattern = false;
    state.expectPattern = false;
    return true;
  }
  if (state.nextPath) {
    state.nextPath = false;
    assertOperandInsideProject(ctx, arg);
    if (state.nextPathProvidesPattern) state.expectPattern = false;
    state.nextPathProvidesPattern = false;
    return true;
  }
  if (state.nextScalar) {
    state.nextScalar = false;
    return true;
  }
  return false;
}

function consumeGrepPatternFlag(state: GrepValidationState, arg: string): boolean {
  if (arg === "-e" || arg === "--regexp") {
    state.nextPattern = true;
    return true;
  }
  if (arg.startsWith("--regexp=") || (arg.startsWith("-e") && arg.length > 2)) {
    state.expectPattern = false;
    return true;
  }
  return false;
}

function consumeGrepFileFlag(
  ctx: OperandValidationContext,
  state: GrepValidationState,
  arg: string,
): boolean {
  if (arg === "-f" || arg === "--file") {
    state.nextPath = true;
    state.nextPathProvidesPattern = true;
    return true;
  }
  if (isSeparatedValueFlag(arg, GREP_PATTERN_FILE_FLAGS) || shortClusterEndsWithFlag(arg, "-f")) {
    state.nextPath = true;
    state.nextPathProvidesPattern = true;
    return true;
  }
  const patternFile = inlineValueFor(arg, GREP_PATTERN_FILE_FLAGS);
  if (patternFile !== undefined) {
    assertOperandInsideProject(ctx, patternFile);
    state.expectPattern = false;
    return true;
  }
  if (isSeparatedValueFlag(arg, GREP_PATH_VALUE_FLAGS)) {
    state.nextPath = true;
    state.nextPathProvidesPattern = false;
    return true;
  }
  const value = inlineValueFor(arg, GREP_PATH_VALUE_FLAGS);
  if (value !== undefined) {
    assertOperandInsideProject(ctx, value);
    return true;
  }
  return false;
}

function consumeGrepScalarFlag(state: GrepValidationState, arg: string): boolean {
  if (inlineValueFor(arg, GREP_SCALAR_VALUE_FLAGS) !== undefined) return true;
  if (isSeparatedValueFlag(arg, GREP_SCALAR_VALUE_FLAGS)) {
    state.nextScalar = true;
    return true;
  }
  return false;
}

function consumeGrepFlag(
  ctx: OperandValidationContext,
  state: GrepValidationState,
  arg: string,
): boolean {
  if (state.afterTerminator) return false;
  if (isOptionTerminator(arg)) {
    state.afterTerminator = true;
    return true;
  }
  if (consumeGrepPatternFlag(state, arg)) return true;
  if (consumeGrepFileFlag(ctx, state, arg)) return true;
  if (consumeGrepScalarFlag(state, arg)) return true;
  return isFlag(arg, false);
}

function consumeGrepPositional(
  ctx: OperandValidationContext,
  state: GrepValidationState,
  arg: string,
): void {
  if (state.expectPattern) {
    state.expectPattern = false;
    return;
  }
  assertOperandInsideProject(ctx, arg);
}

function validateGrepOperands(ctx: OperandValidationContext, args: readonly string[]): void {
  const state: GrepValidationState = {
    afterTerminator: false,
    expectPattern: true,
    nextPattern: false,
    nextPath: false,
    nextPathProvidesPattern: false,
    nextScalar: false,
  };
  for (const arg of args) {
    if (consumePendingGrepOperand(ctx, state, arg)) continue;
    if (consumeGrepFlag(ctx, state, arg)) continue;
    consumeGrepPositional(ctx, state, arg);
  }
}

const FIND_ROOT_OPTIONS: ReadonlySet<string> = new Set([
  "-H",
  "-L",
  "-P",
  "-E",
  "-X",
  "-d",
  "-s",
  "-x",
]);
const FIND_PATH_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-anewer",
  "-cnewer",
  "-f",
  "-newer",
  "-samefile",
]);
const FIND_SCALAR_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-amin",
  "-atime",
  "-cmin",
  "-context",
  "-ctime",
  "-flags",
  "-fstype",
  "-gid",
  "-group",
  "-ilname",
  "-iname",
  "-inum",
  "-ipath",
  "-iregex",
  "-links",
  "-lname",
  "-maxdepth",
  "-mindepth",
  "-mmin",
  "-mtime",
  "-name",
  "-path",
  "-perm",
  "-printf",
  "-regex",
  "-regextype",
  "-size",
  "-type",
  "-uid",
  "-used",
  "-user",
  "-xtype",
]);
const FIND_EXPRESSION_OPERATORS: ReadonlySet<string> = new Set(["!", "(", ")", ",", "-and", "-or"]);

function newerFlagValueKind(flag: string): "path" | "scalar" | undefined {
  if (!flag.startsWith("-newer")) return undefined;
  if (flag === "-newer") return "path";
  if (flag.length !== "-newerXY".length) return undefined;
  return flag.endsWith("t") ? "scalar" : "path";
}

function findValueKind(arg: string): "path" | "scalar" | undefined {
  const flag = flagName(arg);
  if (FIND_PATH_VALUE_FLAGS.has(flag)) return "path";
  if (FIND_SCALAR_VALUE_FLAGS.has(flag)) return "scalar";
  return newerFlagValueKind(flag);
}

function consumeFindValueFlag(state: OperandValueState, arg: string): boolean {
  const kind = findValueKind(arg);
  if (kind === undefined) return false;
  state.pending = kind;
  return true;
}

function startsFindExpression(arg: string): boolean {
  return arg.startsWith("-") || FIND_EXPRESSION_OPERATORS.has(arg);
}

function validateFindOperands(ctx: OperandValidationContext, args: readonly string[]): void {
  const state: OperandValueState = { afterTerminator: false, pending: undefined };
  let expressionStarted = false;
  for (const arg of args) {
    if (consumePendingOperandValue(ctx, state, arg)) continue;
    if (!expressionStarted && arg === "-f") {
      state.pending = "path";
      continue;
    }
    if (!expressionStarted && !startsFindExpression(arg)) {
      assertOperandInsideProject(ctx, arg);
      continue;
    }
    if (!expressionStarted && FIND_ROOT_OPTIONS.has(arg)) continue;
    expressionStarted = true;
    if (consumeFindValueFlag(state, arg)) continue;
  }
}

function validateCommandOperands(
  projectRoot: string,
  cwd: string,
  input: TerminalExecutionInput,
  fs: WorkspaceFs,
): void {
  const ctx: OperandValidationContext = { fs, projectRoot, cwd };
  switch (input.command) {
    case "cat":
    case "wc":
      validatePathOperands(ctx, input.args, FROZEN_EMPTY_SET);
      break;
    case "head":
    case "tail":
      validatePathOperands(ctx, input.args, HEAD_TAIL_SCALAR_FLAGS);
      break;
    case "ls":
      validatePathOperands(ctx, input.args, LS_SCALAR_FLAGS);
      break;
    case "tree":
      validatePathOperands(ctx, input.args, TREE_SCALAR_FLAGS);
      break;
    case "grep":
      validateGrepOperands(ctx, input.args);
      break;
    case "find":
      validateFindOperands(ctx, input.args);
      break;
    default:
      break;
  }
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
    const projectRoot = projectRootOrThrow(project);
    const cwd = assertCwdInsideProject(projectRoot, input.cwd);
    validateCommandOperands(projectRoot, cwd, input, this.runDeps.fs ?? nodeWorkspaceFs);
    return this.runExecution(projectRoot, cwd, input);
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

  // Keep runCommand on the same terminal policy table used by the BFF pre-check. Layer 2 above
  // covers operand containment, while runCommand still owns the spawn boundary, cwd realpath check,
  // executable resolution, sandbox env, timeout, and output cap.
  private buildRunDepsFor(projectRoot: string): RunCommandDeps {
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
    return {
      workspace,
      policy: this.policy,
      commandRules: this.runDeps.commandRules ?? TERMINAL_COMMAND_RULES,
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
    const deps = this.buildRunDepsFor(projectRoot);
    const timeoutMs = clampTimeout(input.timeoutMs, this.policy.defaultTimeoutMs);
    let result: import("@oscharko-dev/keiko-tools").CommandResult;
    try {
      result = await runCommand(
        {
          command: input.command,
          args: input.args,
          cwd,
          timeoutMs,
          signal: entry.controller.signal,
        },
        deps,
      );
    } catch (error) {
      this.recordFailure(executionId, input, entry, error, startedAt);
      throw this.mapError(error, entry);
    }
    return this.handleSuccess(executionId, input, result, startedAt);
  }

  private handleSuccess(
    executionId: string,
    input: TerminalExecutionInput,
    result: import("@oscharko-dev/keiko-tools").CommandResult,
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
    this.persistEntryOrEmitFailure(executionId, input, counts);
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
        ...requestIdPayload(input),
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
    this.persistEntryOrEmitFailure(executionId, input, counts);
    if (cancelled) {
      this.emit({
        kind: "execution-cancelled",
        executionId,
        payload: requestIdPayload(input),
      });
      return;
    }
    // ADR-0018 D7: timeout is a "completed with timedOut=true" outcome, not a failure.
    if (error instanceof CommandTimeoutError) {
      this.emit({
        kind: "execution-completed",
        executionId,
        payload: {
          exitCode: null,
          durationMs: counts.durationMs,
          truncated: false,
          timedOut: true,
          stdoutByteLength: 0,
          stderrByteLength: 0,
          ...requestIdPayload(input),
        },
      });
      return;
    }
    const mapped = this.mapError(error, entry);
    this.emit({
      kind: "execution-failed",
      executionId,
      payload: { code: mapped.code, message: mapped.message, ...requestIdPayload(input) },
    });
  }

  private persistEntry(
    executionId: string,
    input: TerminalExecutionInput,
    counts: CompletionCounts,
  ): void {
    if (this.evidenceStore === undefined) {
      throw new TerminalToolError(
        "EVIDENCE_WRITE_FAILED",
        "Terminal evidence store is unavailable.",
      );
    }
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
      throw new TerminalToolError(
        "EVIDENCE_WRITE_FAILED",
        "Terminal evidence could not be written.",
      );
    }
  }

  private persistEntryOrEmitFailure(
    executionId: string,
    input: TerminalExecutionInput,
    counts: CompletionCounts,
  ): void {
    try {
      this.persistEntry(executionId, input, counts);
    } catch (error) {
      const mapped =
        error instanceof TerminalToolError
          ? error
          : new TerminalToolError(
              "EVIDENCE_WRITE_FAILED",
              "Terminal evidence could not be written.",
            );
      this.emit({
        kind: "execution-failed",
        executionId,
        payload: { code: mapped.code, message: mapped.message, ...requestIdPayload(input) },
      });
      throw mapped;
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

  private emitStarted(executionId: string, input: TerminalExecutionInput, startedAt: number): void {
    this.emit({
      kind: "execution-started",
      executionId,
      payload: {
        projectId: input.projectId,
        command: input.command,
        argCount: input.args.length,
        startedAt,
        ...requestIdPayload(input),
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
  const projectRootRaw = project.path;
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
  const roots: readonly TerminalDirectoryRoot[] = [{ label: "Project root", path: projectRoot }];
  return {
    path: pathValue,
    parent: parentPath(pathValue, projectRoot),
    entries: dirs,
    roots,
  };
}
