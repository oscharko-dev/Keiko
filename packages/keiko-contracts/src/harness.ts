// All harness interfaces, states, events, limits, and task types. No runtime code
// other than the frozen constant tables (DEFAULT_LIMITS, HARNESS_CODES, TERMINAL_STATES) and the
// isTerminalHarnessState predicate that the type layer needs to expose as values. Mirrors the
// ADR-0003 types.ts precedent.

import type { CodingContextPack } from "./coding-context.js";

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

// Frozen backing tuple for TerminalState. `satisfies readonly TerminalState[]` compiler-binds the
// enumeration to the type (KEIKO-0807): if TerminalState gains or loses a member without this
// tuple following, the mismatch is a compile error instead of a silent runtime drift. Frozen with
// Object.freeze, not a Set: Object.freeze on a Set does not block .add()/.delete() at runtime, so a
// caller (or an unsafe cast) could previously widen terminal-ness for the remaining process
// lifetime (KEIKO-0879). Test membership with isTerminalHarnessState, not array/.has() access.
export const TERMINAL_STATES: readonly TerminalState[] = Object.freeze([
  "completed",
  "cancelled",
  "failed",
  "limit-exceeded",
] as const satisfies readonly TerminalState[]);

export function isTerminalHarnessState(state: HarnessStateName): boolean {
  return (TERMINAL_STATES as readonly HarnessStateName[]).includes(state);
}

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

// Object.freeze (KEIKO-0879): a plain object literal is writable at runtime regardless of the
// `HarnessLimits` (all-readonly) type annotation — TypeScript's readonly is compile-time only.
export const DEFAULT_LIMITS: HarnessLimits = Object.freeze({
  maxIterations: 10,
  maxModelCalls: 20,
  maxToolCalls: 30,
  maxCommandExecutions: 10,
  maxContextBytes: 512_000,
  maxPatchBytes: 65_536,
  maxWallTimeMs: 300_000,
  maxFailureAttempts: 3,
} as const);

// Version manifest stamped onto every RunManifest and side-file fingerprint header. Bump on a
// breaking-shape change to the harness event union or RunManifest schema; consumers compare the
// literal at parse time. Lives in contracts (not src/harness/session.ts) because tools' browser
// side-file emission needs the same constant without importing the harness layer.
export const HARNESS_VERSION = "0.1.7";

// ─── Task types ───────────────────────────────────────────────────────────────

export type TaskType =
  "generate-unit-tests" | "investigate-bug" | "explain-plan" | "verify" | "editor-agent-turn";

export interface GenerateUnitTestsInput {
  readonly filePath: string;
  readonly targetFunction?: string | undefined;
  // Legacy free-form context string (pre-#1211). Still honoured for backward compatibility; the BFF
  // supplies the structured `retrievedContext` pack instead. Both may be present (pack wins, string
  // appended after).
  readonly context?: string | undefined;
  // Issue #1211: a governed, redacted coding-context pack assembled server-side (repo-search and,
  // for explicit requests, Local Knowledge + memory). The harness renders it deterministically into
  // the prompt; retrieved content is untrusted data and never grants tool authority (allowsTools
  // stays false for this task regardless of pack contents).
  readonly retrievedContext?: CodingContextPack | undefined;
}

export interface InvestigateBugInput {
  readonly description: string;
  readonly filePaths?: readonly string[] | undefined;
  readonly context?: string | undefined;
}

export interface ExplainPlanInput {
  readonly filePath: string;
  readonly question?: string | undefined;
  // Optional redacted file excerpt supplied by the BFF. The task remains read-only; this only
  // grounds the model so it does not infer file contents from the path alone.
  readonly context?: string | undefined;
}

// Verify task is deterministic: the run engine invokes the verification orchestrator directly
// (no model loop), so this shape carries only the workspaceRoot and optional target file subset.
export interface VerifyInput {
  readonly workspaceRoot: string;
  readonly targetFiles?: readonly string[] | undefined;
}

// Issue #2489 (Findings 1/2) — the Keiko-native producer task. A governed model turn whose tool
// calls dispatch through the EditorAgentToolHost seam, scoped by the producer to the four
// server-resolved/synchronously-governed retrofit tools (navigateSymbol, searchWorkspace,
// queryGit, requestVerification). sessionId/workspaceRoot are resolved server-side from the live
// editor session registry; only the free-form goal is caller-supplied.
export interface EditorAgentTurnInput {
  readonly goal: string;
  readonly sessionId: string;
}

export type TaskInput =
  | { readonly taskType: "generate-unit-tests"; readonly input: GenerateUnitTestsInput }
  | { readonly taskType: "investigate-bug"; readonly input: InvestigateBugInput }
  | { readonly taskType: "explain-plan"; readonly input: ExplainPlanInput }
  | { readonly taskType: "verify"; readonly input: VerifyInput }
  | { readonly taskType: "editor-agent-turn"; readonly input: EditorAgentTurnInput };

// ─── Runtime counters (harness-internal mutable state) ────────────────────────

export interface RunCounters {
  iterations: number;
  modelCalls: number;
  toolCalls: number;
  commandExecutions: number;
  failureAttempts: number;
  // ADR-0017 D7 — reserved for future harness-integrated browser sessions. The MVP browser tool
  // runs as a BFF surface (ADR-0017 D8/D9) and does not flow through the harness loop, so this
  // field stays at 0 in MVP. Additive, never decremented. See ADR-0017 D7 + D11.
  browserNavigations: number;
}

// ─── Run result ───────────────────────────────────────────────────────────────

// A run's outcome IS the terminal harness state it reached — expressed as a projection of
// TerminalState (KEIKO-0807), not a second independently-written 4-member union, so the two can
// never silently drift apart. The alias is deliberate: it preserves the semantic name at call
// sites (a `RunOutcome`-typed field reads as "the run's outcome", not "a terminal harness state
// that happens to be a run's outcome"), while the compiler still enforces set-equality via the
// projection.
// NOSONAR (typescript:S6564): the alias is a semantic name, not redundant abstraction. Replacing
// every `RunOutcome` with `TerminalState` would erase the domain-model distinction between "the
// set of terminal states" and "the specific terminal state a run produced".
export type RunOutcome = TerminalState;

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
  readonly workingDirectory: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
  readonly events: readonly HarnessEvent[];
}

// ─── Failure taxonomy ─────────────────────────────────────────────────────────

// Object.freeze (KEIKO-0879): `as const` narrows the literal types the compiler sees but does not
// make the object immutable at runtime.
export const HARNESS_CODES = Object.freeze({
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
} as const);

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

// Redacted sandbox configuration snapshot used for the command. Names-only env allowlist,
// documented network policy, limits, and whether a non-root cwd was requested. No env values,
// command arguments, stdout/stderr, or paths.
export interface SandboxConfiguredEvent extends BaseEvent {
  readonly type: "sandbox:configured";
  readonly envAllowlist: readonly string[];
  readonly network: "inherit" | "none";
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly terminationGraceMs: number;
  readonly cwdRequested: boolean;
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

// ─── Browser tool events (ADR-0017 D7) ───────────────────────────────────────
//
// These events live outside the harness state machine: the browser tool is a BFF-level surface,
// not a workflow. The events share BaseEvent's schemaVersion+seq+ts shape so the existing SSE
// framer and redactor can carry them without change. `originOnly` carries scheme + authority only
// (never path/query/fragment) so a URL with a token in its querystring never appears in the event
// stream.

export type BrowserSessionCloseReason =
  "explicit" | "process-exit" | "chrome-disconnected" | "idle-timeout";

export interface BrowserSessionOpenedEvent extends BaseEvent {
  readonly type: "browser:session-opened";
  readonly sessionId: string;
  readonly cdpPort: number;
  readonly targetId: string;
}

export interface BrowserNavigatedEvent extends BaseEvent {
  readonly type: "browser:navigated";
  readonly sessionId: string;
  readonly originOnly: string;
  readonly httpStatus: number | null;
}

export interface BrowserScreenshotCapturedEvent extends BaseEvent {
  readonly type: "browser:screenshot-captured";
  readonly sessionId: string;
  readonly captureSeq: number;
  readonly persisted: boolean;
  readonly viewportPx: { readonly width: number; readonly height: number };
  // Present only on persisted=true. Relative to the per-run side-file directory.
  readonly path?: string | undefined;
}

export interface BrowserPageContentCapturedEvent extends BaseEvent {
  readonly type: "browser:page-content-captured";
  readonly sessionId: string;
  readonly captureSeq: number;
  readonly byteLength: number;
}

export interface BrowserSessionClosedEvent extends BaseEvent {
  readonly type: "browser:session-closed";
  readonly sessionId: string;
  readonly reason: BrowserSessionCloseReason;
}

export interface BrowserTrustWarningEvent extends BaseEvent {
  readonly type: "browser:trust-warning";
  readonly sessionId: string;
  readonly warning: string;
}

export interface BrowserErrorEvent extends BaseEvent {
  readonly type: "browser:error";
  readonly sessionId: string;
  readonly code: string;
  readonly message: string;
}

export type BrowserEvent =
  | BrowserSessionOpenedEvent
  | BrowserNavigatedEvent
  | BrowserScreenshotCapturedEvent
  | BrowserPageContentCapturedEvent
  | BrowserSessionClosedEvent
  | BrowserTrustWarningEvent
  | BrowserErrorEvent;

// ADR-0055 D4: shaping/compaction of a tool observation is additive — a fault there falls back to
// the raw tool output rather than failing the run (KEIKO-0099). This is the observability signal
// for that fallback: `reason` is a closed, safe vocabulary the harness itself chooses, never the
// underlying error's message or the tool's raw output, so it needs no redaction.
export type ToolShapingDegradedReason = "shaper-threw" | "unserializable-observation";

export interface ToolShapingDegradedEvent extends BaseEvent {
  readonly type: "tool:shaping:degraded";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly reason: ToolShapingDegradedReason;
}

// KEIKO-0205: a sink whose emit() throws is quarantined by the harness's Emitter so a broken sink
// integration can never fault the whole fan-out or reject the run — but dropping the FACT of that
// failure (as opposed to the throw's untrusted VALUE, which is correctly discarded) would leave a
// run reporting `completed` with a silently incomplete audit trail. This is the observability
// signal for the quarantine: `reason` is a closed, safe vocabulary the emitter itself chooses, and
// `sinkIndex` is the failing sink's position in the constructor-injected sink list — never the
// underlying error's message, stack, or the event that failed to deliver, so it needs no
// redaction.
export type SinkDegradedReason = "sink-threw";

export interface SinkDegradedEvent extends BaseEvent {
  readonly type: "sink:degraded";
  readonly sinkIndex: number;
  readonly reason: SinkDegradedReason;
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
  | SandboxConfiguredEvent
  | PatchAppliedEvent
  | ReasoningTraceEvent
  | PatchProposedEvent
  | VerificationResultEvent
  | RunCompletedEvent
  | RunCancelledEvent
  | RunFailedEvent
  | BrowserEvent
  | ToolShapingDegradedEvent
  | SinkDegradedEvent;
