// All harness interfaces, states, events, limits, and task types. No runtime code
// other than the frozen constant tables (DEFAULT_LIMITS, HARNESS_CODES, TERMINAL_STATES)
// that the type layer needs to expose as values. Mirrors the ADR-0003 types.ts precedent.

// ─── State machine ────────────────────────────────────────────────────────────

export type HarnessStateName =
  | "intake"
  | "planning"
  | "context-selection"
  | "model-call"
  | "tool-call"
  | "patch-proposal"
  | "verification"
  | "reporting"
  | "completed"
  | "cancelled"
  | "failed"
  | "limit-exceeded";

export type TerminalState = "completed" | "cancelled" | "failed" | "limit-exceeded";

export const TERMINAL_STATES: ReadonlySet<HarnessStateName> = new Set<HarnessStateName>([
  "completed",
  "cancelled",
  "failed",
  "limit-exceeded",
]);

export interface StateTransition {
  readonly from: HarnessStateName;
  readonly to: HarnessStateName;
  readonly reason: string;
}

// ─── Safety limits ────────────────────────────────────────────────────────────

export interface HarnessLimits {
  readonly maxIterations: number;
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  readonly maxCommandExecutions: number;
  readonly maxContextBytes: number;
  readonly maxPatchBytes: number;
  readonly maxWallTimeMs: number;
  readonly maxFailureAttempts: number;
}

export const DEFAULT_LIMITS: HarnessLimits = {
  maxIterations: 10,
  maxModelCalls: 20,
  maxToolCalls: 30,
  maxCommandExecutions: 10,
  maxContextBytes: 512_000,
  maxPatchBytes: 65_536,
  maxWallTimeMs: 300_000,
  maxFailureAttempts: 3,
} as const;

// ─── Task types ───────────────────────────────────────────────────────────────

export type TaskType = "generate-unit-tests" | "investigate-bug" | "explain-plan";

export interface GenerateUnitTestsInput {
  readonly filePath: string;
  readonly targetFunction?: string | undefined;
  readonly context?: string | undefined;
}

export interface InvestigateBugInput {
  readonly description: string;
  readonly filePaths?: readonly string[] | undefined;
  readonly context?: string | undefined;
}

export interface ExplainPlanInput {
  readonly filePath: string;
  readonly question?: string | undefined;
}

export type TaskInput =
  | { readonly taskType: "generate-unit-tests"; readonly input: GenerateUnitTestsInput }
  | { readonly taskType: "investigate-bug"; readonly input: InvestigateBugInput }
  | { readonly taskType: "explain-plan"; readonly input: ExplainPlanInput };

// ─── Runtime counters (harness-internal mutable state) ────────────────────────

export interface RunCounters {
  iterations: number;
  modelCalls: number;
  toolCalls: number;
  commandExecutions: number;
  failureAttempts: number;
}

// ─── Run result ───────────────────────────────────────────────────────────────

export type RunOutcome = "completed" | "cancelled" | "failed" | "limit-exceeded";

export interface RunResult {
  readonly runId: string;
  readonly fingerprint: string;
  readonly outcome: RunOutcome;
  readonly taskType: TaskType;
  readonly report?: string | undefined;
  readonly patchDiff?: string | undefined;
  readonly failure?: HarnessFailure | undefined;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly events: readonly HarnessEvent[];
}

// ─── Replay manifest (consumed by audit ledger, issue #10) ────────────────────

export interface RunManifest {
  readonly runId: string;
  readonly fingerprint: string;
  readonly harnessVersion: string;
  readonly taskType: TaskType;
  readonly taskInput: TaskInput;
  readonly limits: HarnessLimits;
  readonly modelId: string;
  readonly startedAt: string;
  readonly events: readonly HarnessEvent[];
}

// ─── Failure taxonomy ─────────────────────────────────────────────────────────

export const HARNESS_CODES = {
  LIMIT_ITERATIONS: "HARNESS_LIMIT_ITERATIONS",
  LIMIT_MODEL_CALLS: "HARNESS_LIMIT_MODEL_CALLS",
  LIMIT_TOOL_CALLS: "HARNESS_LIMIT_TOOL_CALLS",
  LIMIT_COMMAND_EXEC: "HARNESS_LIMIT_COMMAND_EXECUTIONS",
  LIMIT_CONTEXT_SIZE: "HARNESS_LIMIT_CONTEXT_SIZE",
  LIMIT_PATCH_SIZE: "HARNESS_LIMIT_PATCH_SIZE",
  LIMIT_WALL_TIME: "HARNESS_LIMIT_WALL_TIME",
  LIMIT_FAILURE_ATTEMPTS: "HARNESS_LIMIT_FAILURE_ATTEMPTS",
  MODEL_ERROR: "HARNESS_MODEL_ERROR",
  TOOL_ERROR: "HARNESS_TOOL_ERROR",
  INTERNAL: "HARNESS_INTERNAL",
} as const;

export type HarnessCode = (typeof HARNESS_CODES)[keyof typeof HARNESS_CODES];

export interface HarnessFailure {
  readonly category: HarnessCode;
  readonly message: string;
  // SENSITIVE: detail may carry task context — pass through redact() before persisting.
  readonly detail?: string | undefined;
}

// ─── Structured event stream (versioned discriminated union) ──────────────────

// schemaVersion is a literal '1'. A breaking schema change produces schemaVersion '2'
// as a new union member; consumers narrow on schemaVersion before narrowing on type.

interface BaseEvent {
  readonly schemaVersion: "1";
  readonly runId: string;
  readonly fingerprint: string;
  readonly seq: number;
  readonly ts: number;
}

export interface RunStartedEvent extends BaseEvent {
  readonly type: "run:started";
  readonly taskType: TaskType;
  readonly modelId: string;
  readonly limits: HarnessLimits;
}

export interface StateTransitionEvent extends BaseEvent {
  readonly type: "state:transition";
  readonly from: HarnessStateName;
  readonly to: HarnessStateName;
  readonly reason: string;
}

export interface ModelCallStartedEvent extends BaseEvent {
  readonly type: "model:call:started";
  readonly modelId: string;
  readonly messageCount: number;
  // SENSITIVE: the underlying messages[*].content may carry task context — never
  // serialised here; only the byte count and message count are exposed.
  readonly contextBytes: number;
}

export interface ModelCallCompletedEvent extends BaseEvent {
  readonly type: "model:call:completed";
  readonly modelId: string;
  readonly finishReason: string;
  readonly toolCallCount: number;
  readonly usage: {
    readonly requestId: string;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly latencyMs: number;
  };
}

export interface ModelCallFailedEvent extends BaseEvent {
  readonly type: "model:call:failed";
  readonly modelId: string;
  readonly errorCode: string;
  readonly message: string;
}

export interface ToolCallStartedEvent extends BaseEvent {
  readonly type: "tool:call:started";
  readonly toolName: string;
  readonly toolCallId: string;
}

export interface ToolCallCompletedEvent extends BaseEvent {
  readonly type: "tool:call:completed";
  readonly toolName: string;
  readonly toolCallId: string;
  readonly durationMs: number;
}

export interface ToolCallFailedEvent extends BaseEvent {
  readonly type: "tool:call:failed";
  readonly toolName: string;
  readonly toolCallId: string;
  readonly errorCode: string;
  readonly message: string;
}

// S-M1: redacted audit record that a subprocess RAN (issue #10 ledger). Counts/flags ONLY — never
// argument values, never stdout/stderr. `executable` is the bare command name (e.g. "node"), which
// the deny-by-default allowlist already constrains to a small, non-sensitive set.
export interface CommandExecutedEvent extends BaseEvent {
  readonly type: "command:executed";
  readonly executable: string;
  readonly argCount: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

// S-M1: redacted audit record that a patch was APPLIED (issue #10 ledger). File COUNTS only —
// never file paths, never file contents.
export interface PatchAppliedEvent extends BaseEvent {
  readonly type: "patch:applied";
  readonly changedFiles: number;
  readonly created: number;
  readonly deleted: number;
}

export interface ReasoningTraceEvent extends BaseEvent {
  readonly type: "reasoning:trace";
  readonly phase: HarnessStateName;
  // SENSITIVE: rationale and modelResponse carry model output — redact() before persisting.
  readonly rationale: string;
  readonly modelResponse?: string | undefined;
}

export interface PatchProposedEvent extends BaseEvent {
  readonly type: "patch:proposed";
  readonly targetFile: string;
  readonly patchBytes: number;
  // SENSITIVE: diff carries source code — redact() before persisting.
  readonly diff: string;
}

export interface VerificationResultEvent extends BaseEvent {
  readonly type: "verification:result";
  readonly passed: boolean;
  readonly detail: string;
}

export interface RunCompletedEvent extends BaseEvent {
  readonly type: "run:completed";
  readonly report: string;
  readonly patchDiff?: string | undefined;
}

export interface RunCancelledEvent extends BaseEvent {
  readonly type: "run:cancelled";
  readonly reason?: string | undefined;
  readonly atState: HarnessStateName;
}

export interface RunFailedEvent extends BaseEvent {
  readonly type: "run:failed";
  readonly failure: HarnessFailure;
  readonly atState: HarnessStateName;
}

export type HarnessEvent =
  | RunStartedEvent
  | StateTransitionEvent
  | ModelCallStartedEvent
  | ModelCallCompletedEvent
  | ModelCallFailedEvent
  | ToolCallStartedEvent
  | ToolCallCompletedEvent
  | ToolCallFailedEvent
  | CommandExecutedEvent
  | PatchAppliedEvent
  | ReasoningTraceEvent
  | PatchProposedEvent
  | VerificationResultEvent
  | RunCompletedEvent
  | RunCancelledEvent
  | RunFailedEvent;
