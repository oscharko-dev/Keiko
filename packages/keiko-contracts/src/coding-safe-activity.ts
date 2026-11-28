import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";
import {
  exactKeys,
  invalid,
  isOneOf,
  isRecord,
  result,
  validateSafeId,
} from "./coding-workbench-runtime-api-validation.js";
import { stripUnsafeFormatChars } from "./text-safety.js";
import { isPortableWorkspaceRelativePath } from "./workspace-contract-primitives.js";
import { EDITOR_AGENT_CONFLICT_CODES, EDITOR_AGENT_FAILURE_CODES } from "./editor-agent.js";

export const CODING_SAFE_ACTIVITY_CONTRACT_VERSION = "1" as const;
export const CODING_SAFE_ACTIVITY_MESSAGE_ROLES = ["user", "assistant"] as const;
/**
 * Who wrote a `user` message when it was not the person: `keiko` is a turn Keiko dispatched itself
 * (a continuation of the accepted request), read from the runtime message's own origin metadata,
 * never inferred from its text (#4491). Absent means the person's own message.
 */
export const CODING_SAFE_ACTIVITY_MESSAGE_ORIGINS = ["keiko"] as const;
export const CODING_SAFE_ACTIVITY_TOOL_STATES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "denied",
  "cancelled",
] as const;
export const CODING_SAFE_ACTIVITY_PLAN_STEP_STATES = [
  "pending",
  "active",
  "completed",
  "cancelled",
] as const;
export const CODING_SAFE_ACTIVITY_MAX_TURNS = 32;
// #4491 A-1: OpenCode opens one assistant message per agent step and a coding run calls a tool per
// action, so a count that ends ordinary work is a defect (owner decision "Work-ending limits"). The
// per-turn message and tool counts therefore sit above what the byte bounds below can ever admit:
// even a message or call with a one-character id serializes to more than 64 bytes, so 512 of them
// exceed the 32 KiB turn bound and the byte bound decides first. A test pins this dependency
// (codingSafeActivityProjection.longRun.test.ts). The byte bounds are the memory guard; these
// counts only stop a runaway producer of empty shells. A turn the byte bound trims reads as
// truncated and its lost messages and calls are counted.
export const CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN = 512;
export const CODING_SAFE_ACTIVITY_MAX_SEGMENTS_PER_MESSAGE = 32;
export const CODING_SAFE_ACTIVITY_MAX_TOOLS_PER_TURN = 512;
export const CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS = 4_096;
export const CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES = 16 * 1_024;
// #3878: an assistant message's model reasoning keeps to half of the message budget, so the answer
// always keeps room of its own.
export const CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES = 8 * 1_024;
export const CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES = 32 * 1_024;
// Leaves serialization reserve for the authenticated channel's tagged snapshot wrapper.
export const CODING_SAFE_ACTIVITY_MAX_UTF8_BYTES = 60 * 1_024;
export const CODING_SAFE_ACTIVITY_MAX_DROPPED_EVENT_COUNT = 65_535;
export const CODING_SAFE_ACTIVITY_TOOL_LABEL_MAX_CHARS = 128;
export const CODING_SAFE_ACTIVITY_MAX_PLAN_STEPS = 64;
export const CODING_SAFE_ACTIVITY_MAX_PLAN_STEP_TEXT_CHARS = 256;
// Fits inside the aggregate feed budget beside a fully populated turn history.
export const CODING_SAFE_ACTIVITY_MAX_PLAN_UTF8_BYTES = 8 * 1_024;
/**
 * A model's answer is never cut to fit the bounded feed (owner decision "Work-ending limits"): the
 * projection keeps every assistant answer's complete text outside the feed and the feed names it
 * (`CodingSafeActivityMessage.fullAnswer`). This bound protects server memory alone: it covers all
 * answers one run holds at once, in UTF-16 code units, far above any answer a model's output window
 * produces, and a cut it makes is shown on the message and recorded, never silent.
 */
export const CODING_SAFE_ACTIVITY_MAX_RETAINED_ANSWER_CHARS = 16 * 1_024 * 1_024;
/**
 * One page of a retained answer, in UTF-16 code units; a page never splits a surrogate pair. Large
 * enough that the longest answer a run retains is read in at most 64 requests.
 */
export const CODING_SAFE_ACTIVITY_ANSWER_PAGE_MAX_CHARS = 256 * 1_024;
/** One live text delta, in UTF-16 code units; a longer gain reaches the reader as pages. */
export const CODING_SAFE_ACTIVITY_MAX_TEXT_DELTA_CHARS = 32 * 1_024;
/**
 * The two kinds of model text the projection retains whole beside the feed: the answer and the
 * model's reasoning. Neither is cut to fit the feed; both are read page by page and streamed as
 * append-only deltas.
 */
export const CODING_SAFE_ACTIVITY_TEXT_PARTS = ["answer", "reasoning"] as const;
export type CodingSafeActivityTextPart = (typeof CODING_SAFE_ACTIVITY_TEXT_PARTS)[number];
/** Most deltas one channel update carries; the rest are read as pages. */
export const CODING_SAFE_ACTIVITY_MAX_TEXT_DELTAS = 64;

/** The existing governed edit facade's closed refusal vocabulary, shared with its live UI. */
export const CODING_SAFE_ACTIVITY_EDIT_REFUSAL_REASON_CODES = [
  ...EDITOR_AGENT_CONFLICT_CODES,
  ...EDITOR_AGENT_FAILURE_CODES,
  "RESPONSE_TOO_LARGE",
  "TRANSPORT_FAILURE",
  "REDIRECT_BLOCKED",
  "EDIT_TRANSPORT_ERROR",
  "EDIT_PREPARE_FAILED",
  "WORKSPACE_ACCESS_LOST",
  "EDIT_MUTATION_FAILED",
  // The native runtime refused to edit a file that is not UTF-8 text and left its bytes unchanged.
  "FILE_NOT_UTF8",
  "ci-observation-required",
] as const;
export type CodingSafeActivityEditRefusalReason =
  (typeof CODING_SAFE_ACTIVITY_EDIT_REFUSAL_REASON_CODES)[number];

/**
 * Why one governed verification (`keiko_verification`) ended as it did, in closed words (#3579). A
 * verification that could not check anything is not a check that failed, and the timeline must not
 * paint it as one: `waiting-for-trust` is the package-script decision only the operator can make,
 * `no-runnable-steps` a request for which the verifier found nothing it can run (the selected
 * package or target has no test, lint or build script; the repository may still define others), and
 * `not-run` a run whose steps were skipped, denied or cancelled, and `isolation-unavailable` a run
 * whose steps were denied because this computer has no enforcing isolation backend (no container
 * runtime), a host condition rather than a policy decision. `dependencies-unavailable` is a run whose
 * dependency installation was refused or failed, so no check ran (#4522). `failed-check` is a check
 * that ran and went red, `passed` every requested check green.
 */
export const CODING_SAFE_ACTIVITY_VERIFICATION_OUTCOMES = [
  "passed",
  "failed-check",
  "waiting-for-trust",
  "no-runnable-steps",
  "not-run",
  "isolation-unavailable",
  "dependencies-unavailable",
] as const;
export type CodingSafeActivityVerificationOutcome =
  (typeof CODING_SAFE_ACTIVITY_VERIFICATION_OUTCOMES)[number];

/**
 * How one governed Git step (`keiko_git` stage, unstage, fetch, pull, branch, or the verified
 * commit) really ended, in closed words. The governed facade answers a refused step as a completed
 * tool call that carries the refusal, so the call state alone reads "Succeeded" although nothing was
 * committed or staged. `completed` is a step Keiko carried out; every other word names why it did
 * not: `waiting-for-approval` the human decision still open, `prepared` a proposal that needs no
 * further decision (policy authorized it, or the person already approved it) and waits only for its
 * execute step, `verification-failed` and
 * `verification-missing` a commit that no passing verification of the staged change covers,
 * `not-staged` a commit whose change is only partly staged, `unsaved-changes` a commit that open
 * editor files with unsaved changes hold back, `blocked` a policy or authority refusal,
 * `commit-protected-branch` a commit refused because the run works directly on a protected branch
 * such as main or dev, `branch-*` a task branch Keiko refused for the one reason the word names (a
 * name it will not create, a name already taken, a run that is not on its base branch, a checkout
 * that is not local or holds executable Git filters, a repository condition that blocks the
 * switch), `changed` a candidate or repository that moved since the
 * proposal, and `not-done` a step that failed or whose result is uncertain.
 */
export const CODING_SAFE_ACTIVITY_GIT_OUTCOMES = [
  "completed",
  "waiting-for-approval",
  "prepared",
  "verification-failed",
  "verification-missing",
  "not-staged",
  "unsaved-changes",
  "blocked",
  "commit-protected-branch",
  "branch-invalid-name",
  "branch-protected-name",
  "branch-exists",
  "branch-not-on-base",
  "branch-not-local-checkout",
  "branch-executable-filters",
  "branch-preflight",
  "changed",
  "not-done",
] as const;
export type CodingSafeActivityGitOutcome = (typeof CODING_SAFE_ACTIVITY_GIT_OUTCOMES)[number];

/**
 * Which index change a `keiko_git_stage` call asked for. Both directions travel through the one tool
 * name, so a row cannot tell a stage from an unstage by the name alone (U-49). Closed vocabulary,
 * derived from the governed result's own kind, never from prose.
 */
export const CODING_SAFE_ACTIVITY_GIT_ACTIONS = ["stage", "unstage"] as const;
export type CodingSafeActivityGitAction = (typeof CODING_SAFE_ACTIVITY_GIT_ACTIONS)[number];

/**
 * Where a tool call that did not succeed failed, so a person sees at a glance whether Keiko caused
 * it: `keiko-refused` Keiko's governance (a policy rule, a refused step or a declined approval)
 * blocked the call; `command-failed` a command ran and ended with a non-zero exit status;
 * `tool-error` the tool itself failed (a bad argument from the model, a missing file);
 * `timed-out` the command ran out of its time; `cancelled` the call was stopped. Closed vocabulary,
 * derived from the governed facade's state and the runtime's own status facts, never from prose.
 */
export const CODING_SAFE_ACTIVITY_TOOL_FAILURE_ORIGINS = [
  "keiko-refused",
  "command-failed",
  "tool-error",
  "timed-out",
  "invalid-arguments",
  "cancelled",
] as const;
export type CodingSafeActivityToolFailureOrigin =
  (typeof CODING_SAFE_ACTIVITY_TOOL_FAILURE_ORIGINS)[number];

/**
 * A failed call's origin when its producer named none: the closed state decides it. The server's
 * projection and the Workbench share this one rule, so a row and the run's log never disagree.
 */
export function codingSafeActivityStateFailureOrigin(
  state: CodingSafeActivityToolState,
  exitCode: number | undefined,
): CodingSafeActivityToolFailureOrigin | undefined {
  if (state === "denied") return "keiko-refused";
  if (state === "cancelled") return "cancelled";
  if (state !== "failed") return undefined;
  return exitCode !== undefined && exitCode !== 0 ? "command-failed" : "tool-error";
}

/** Why Keiko refused a call, where the governed facade knows it: a person declined, or nobody decided in time. */
export const CODING_SAFE_ACTIVITY_TOOL_REFUSAL_CAUSES = [
  "approval-declined",
  "approval-expired",
] as const;
export type CodingSafeActivityToolRefusalCause =
  (typeof CODING_SAFE_ACTIVITY_TOOL_REFUSAL_CAUSES)[number];

/** A shell call's command line, up to this many characters (the opened row shows all of it). */
export const CODING_SAFE_ACTIVITY_MAX_TOOL_COMMAND_CHARS = 1_000;
/** The error message a failed tool returned to the model, up to this many characters. */
export const CODING_SAFE_ACTIVITY_MAX_TOOL_ERROR_CHARS = 1_000;
/** A subagent call's agent name, up to this many characters. */
export const CODING_SAFE_ACTIVITY_MAX_TOOL_AGENT_NAME_CHARS = 80;
/** A subagent call's short task description, up to this many characters. */
export const CODING_SAFE_ACTIVITY_MAX_TOOL_TASK_DESCRIPTION_CHARS = 240;
/** A subagent call's prompt, up to this many characters (the opened row shows all of it). */
export const CODING_SAFE_ACTIVITY_MAX_TOOL_TASK_PROMPT_CHARS = 1_000;
/** Output lines a tool row shows from the start and from the end; the lines between are counted. */
export const CODING_SAFE_ACTIVITY_TOOL_OUTPUT_HEAD_LINES = 5;
export const CODING_SAFE_ACTIVITY_TOOL_OUTPUT_TAIL_LINES = 20;
/** Characters each of the output's head and tail holds at most. */
export const CODING_SAFE_ACTIVITY_MAX_TOOL_OUTPUT_PART_CHARS = 2_000;

/**
 * Canonical server facts only. Live authenticated presentation. Paths and byte counts never enter
 * Activity Log evidence; the closed `verificationOutcome` and `gitOutcome` alone are also recorded, body-free, on
 * `coding-runtime.tool-result-rendered`.
 */
export interface CodingSafeActivityToolPresentation {
  /** The workspace-contained file a completed governed read actually returned. */
  readonly relativePath?: string;
  /** The authoritative file at which edit materialization refused; absent if unknown. */
  readonly affectedRelativePath?: string;
  /** Bytes in the returned read window, not the whole file. */
  readonly readByteCount?: number;
  /** Line count of the whole read file, not the returned window. */
  readonly totalFileLines?: number;
  /** Actual discovery items returned after filtering and limits, not inventory or text lines. */
  readonly returnedPathCount?: number;
  readonly refusalReason?: CodingSafeActivityEditRefusalReason;
  /** Why a governed verification ended as it did; present on `keiko_verification` calls only. */
  readonly verificationOutcome?: CodingSafeActivityVerificationOutcome;
  /** How a governed Git step really ended; present on `keiko_git` and commit calls only. */
  readonly gitOutcome?: CodingSafeActivityGitOutcome;
  /** Whether a governed index step staged or unstaged; present on `keiko_git_stage` calls only. */
  readonly gitAction?: CodingSafeActivityGitAction;
  /** Elapsed bridge service time; includes governed waits, excludes model generation time. */
  readonly bridgeDurationMs?: number;
  /** A finished native shell call's own exit status, as the runtime reported it. */
  readonly exitCode?: number;
  /** Where a call that did not succeed failed; absent while running and on success. */
  readonly failureOrigin?: CodingSafeActivityToolFailureOrigin;
  /** Why Keiko refused the call, where the governed facade knows it. */
  readonly refusalCause?: CodingSafeActivityToolRefusalCause;
  /** Wall time the runtime ran the call, from its start to its end. */
  readonly durationMs?: number;
  /** How many times this call's command has failed in the run, this call included. */
  readonly failureCount?: number;
  /**
   * The shell command line, as the model wrote it. Untrusted content with the credential floor
   * applied; rendered as text only and never part of the Activity Log or any evidence.
   */
  readonly command?: CodingSafeActivityToolText;
  /** What the call printed (a shell call's output), as its first and last lines. Same rules. */
  readonly output?: CodingSafeActivityToolOutput;
  /** The error message the tool returned to the model when it failed. Same rules. */
  readonly errorText?: CodingSafeActivityToolText;
  /** A subagent call's agent name (the model's argument). Same rules as `command`. */
  readonly agentName?: CodingSafeActivityToolText;
  /** A subagent call's short task description. Same rules. */
  readonly taskDescription?: CodingSafeActivityToolText;
  /** A subagent call's prompt; detail the live feed may shed with the command. Same rules. */
  readonly taskPrompt?: CodingSafeActivityToolText;
  /** The live feed shed this call's command, output and error text to stay inside its budget. */
  readonly detailOmitted?: true;
  /** The runtime kept only the start of this call's result for the model; the whole result was saved. */
  readonly outputShortened?: CodingSafeActivityOutputShortened;
}

/**
 * What the runtime kept of a result it shortened for the model's context window. Counts only: the
 * line counts are present when the runtime stated them.
 */
export interface CodingSafeActivityOutputShortened {
  readonly keptBytes: number;
  readonly keptLines?: number;
  readonly totalLines?: number;
}

/** Untrusted tool text with the credential floor applied; `truncated` when cut to its bound. */
export interface CodingSafeActivityToolText {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * A tool's output as its first lines (`head`) and its last lines (`tail`), with the lines between
 * them counted (`hiddenLineCount`). A short output is all `head` and an empty `tail`. `truncated` is
 * true when a line was cut to the part's character bound.
 */
export interface CodingSafeActivityToolOutput {
  readonly head: string;
  readonly tail: string;
  readonly lineCount: number;
  readonly hiddenLineCount: number;
  readonly truncated: boolean;
}

export type CodingSafeActivityMessageRole = (typeof CODING_SAFE_ACTIVITY_MESSAGE_ROLES)[number];
export type CodingSafeActivityMessageOrigin = (typeof CODING_SAFE_ACTIVITY_MESSAGE_ORIGINS)[number];
export type CodingSafeActivityToolState = (typeof CODING_SAFE_ACTIVITY_TOOL_STATES)[number];
export type CodingSafeActivityPlanStepState =
  (typeof CODING_SAFE_ACTIVITY_PLAN_STEP_STATES)[number];

/**
 * Untrusted runtime text. Consumers must render it through escaped text nodes or Keiko's vetted
 * SafeMarkdown renderer; never inject raw markup or executable content.
 */
export interface CodingSafeActivityTextSegment {
  readonly kind: "text";
  readonly text: string;
  /** True when the segment was shortened to remain inside a declared projection bound. */
  readonly truncated: boolean;
}

/**
 * #3878: the model's own reasoning beside an assistant message, as the provider returned it
 * (`reasoning_content`). Untrusted, unverified model text: consumers render it as escaped text,
 * label it as unverified model reasoning and never treat it as the answer. Live content only — it
 * never enters Coding History, evidence, a support export or the Activity Log.
 */
export interface CodingSafeActivityReasoning {
  readonly text: string;
  /**
   * True only when the server's memory bound shortened the reasoning it holds. The feed carries a
   * prefix of a long reasoning and names the whole (`CodingSafeActivityMessage.fullReasoning`).
   */
  readonly truncated: boolean;
}

/**
 * An assistant answer longer than the feed carries. Its segments hold a part of it, or none, and its
 * complete text is read page by page (`CodingSafeActivityAnswerPage`). The answer only grows while
 * it streams, so `length` only grows; `truncated` is the retention bound's own visible cut.
 */
export interface CodingSafeActivityFullAnswer {
  /**
   * UTF-16 code units of the complete answer the server holds; 0 only together with `truncated`,
   * for a text the memory bound left no room for.
   */
  readonly length: number;
  /** True when the server's memory bound shortened the answer it holds. */
  readonly truncated: boolean;
}

export interface CodingSafeActivityMessage {
  readonly messageId: string;
  readonly role: CodingSafeActivityMessageRole;
  readonly occurredAt: string;
  readonly segments: readonly CodingSafeActivityTextSegment[];
  readonly truncated: boolean;
  /** User messages only; see `CODING_SAFE_ACTIVITY_MESSAGE_ORIGINS`. Absent: the person's own. */
  readonly origin?: CodingSafeActivityMessageOrigin;
  /** Assistant messages only; absent when the model returned no reasoning or it is not shown. */
  readonly reasoning?: CodingSafeActivityReasoning;
  /** Assistant messages only; present when the segments do not carry the whole answer. */
  readonly fullAnswer?: CodingSafeActivityFullAnswer;
  /** Assistant messages only; present when `reasoning` does not carry the whole reasoning. */
  readonly fullReasoning?: CodingSafeActivityFullAnswer;
  /**
   * Assistant messages only: the model's turn ended because it reached its output limit, as the
   * runtime reported the turn's finish reason. A fact the answer was cut off, never inferred from
   * its text. Absent otherwise.
   */
  readonly outputLimitReached?: true;
}

/**
 * Text appended to a retained answer or reasoning since the previous channel update, starting at
 * `offset`. Append-only: a reader that holds exactly `offset` characters appends it; any other
 * reader reads the missing part as pages. A delta never splits a surrogate pair.
 */
export interface CodingSafeActivityTextDelta {
  readonly messageId: string;
  readonly part: CodingSafeActivityTextPart;
  readonly offset: number;
  readonly text: string;
}

/**
 * One page of a retained assistant answer, read through the authenticated app-session channel.
 * Untrusted model text with the same rendering rules as a feed segment. `offset` is where `text`
 * starts in the answer, `length` the answer's whole length when the page was read, and `truncated`
 * the retention bound's cut, as on `CodingSafeActivityFullAnswer`.
 */
export interface CodingSafeActivityAnswerPage
  extends CodingSafeActivityTextDelta, CodingSafeActivityFullAnswer {
  readonly schemaVersion: typeof CODING_SAFE_ACTIVITY_CONTRACT_VERSION;
  readonly runId: string;
}

export interface CodingSafeActivityTool {
  readonly callId: string;
  /** Closed-adapter safe label only; raw arguments/results and provider data are absent. */
  readonly tool: string;
  readonly state: CodingSafeActivityToolState;
  readonly occurredAt: string;
  readonly presentation?: CodingSafeActivityToolPresentation;
}

export interface CodingSafeActivityTurn {
  readonly turnId: string;
  readonly messages: readonly CodingSafeActivityMessage[];
  readonly tools: readonly CodingSafeActivityTool[];
  /** True when a message, segment, tool, or byte-budget eviction removed part of this turn. */
  readonly truncated: boolean;
}

/** Untrusted plan step text. Consumers must render this as text, never markup or executable content. */
export interface CodingSafeActivityPlanStep {
  readonly text: string;
  readonly state: CodingSafeActivityPlanStepState;
  /** True when the step text was shortened to remain inside a declared projection bound. */
  readonly truncated: boolean;
}

export interface CodingSafeActivityPlan {
  /** Monotonic projection-assigned revision anchoring live plan updates for consumers. */
  readonly revision: number;
  /** Assistant message that carried the latest accepted plan update. */
  readonly anchorMessageId: string;
  readonly updatedAt: string;
  readonly steps: readonly CodingSafeActivityPlanStep[];
  /** True when steps were dropped or clipped to stay inside the declared plan bounds. */
  readonly truncated: boolean;
}

export interface AvailableCodingSafeActivityFeed {
  readonly schemaVersion: typeof CODING_SAFE_ACTIVITY_CONTRACT_VERSION;
  readonly availability: "available";
  readonly runId: string;
  readonly updatedAt: string;
  readonly turns: readonly CodingSafeActivityTurn[];
  /** Latest agent-maintained plan snapshot; absent until the first accepted plan update. */
  readonly plan?: CodingSafeActivityPlan;
  /** True when whole turns were evicted from the bounded feed. */
  readonly truncated: boolean;
  readonly droppedEventCount: number;
}

export interface UnavailableCodingSafeActivityFeed {
  readonly schemaVersion: typeof CODING_SAFE_ACTIVITY_CONTRACT_VERSION;
  readonly availability: "unavailable";
  readonly runId: string;
  readonly updatedAt: string;
  readonly droppedEventCount: number;
}

export type CodingSafeActivityFeed =
  AvailableCodingSafeActivityFeed | UnavailableCodingSafeActivityFeed;

export function unavailableCodingSafeActivityFeed(
  runId: string,
  updatedAt: string,
): UnavailableCodingSafeActivityFeed {
  return {
    schemaVersion: CODING_SAFE_ACTIVITY_CONTRACT_VERSION,
    availability: "unavailable",
    runId,
    updatedAt,
    droppedEventCount: 0,
  };
}

export function validateCodingSafeActivityFeed(
  value: unknown,
): CodingWorkbenchValidationResult<CodingSafeActivityFeed> {
  try {
    return validateFeed(value);
  } catch {
    return invalid("safe activity feed validation failed");
  }
}

function validateFeed(value: unknown): CodingWorkbenchValidationResult<CodingSafeActivityFeed> {
  if (!isRecord(value)) return invalid("safe activity feed must be an object");
  const errors = exactKeys(value, feedKeys(value.availability), "safeActivityFeed");
  validateFeedBase(value, errors);
  if (value.availability === "available") validateAvailableFeed(value, errors);
  if (errors.length === 0 && serializedBytes(value) > CODING_SAFE_ACTIVITY_MAX_UTF8_BYTES) {
    errors.push("safeActivityFeed exceeds the aggregate UTF-8 byte budget");
  }
  return result(value, errors);
}

function feedKeys(availability: unknown): readonly string[] {
  const base = ["schemaVersion", "availability", "runId", "updatedAt", "droppedEventCount"];
  return availability === "available" ? [...base, "turns", "truncated", "plan"] : base;
}

function validateFeedBase(value: Record<string, unknown>, errors: string[]): void {
  if (value.schemaVersion !== CODING_SAFE_ACTIVITY_CONTRACT_VERSION) {
    errors.push("safeActivityFeed.schemaVersion is invalid");
  }
  if (value.availability !== "available" && value.availability !== "unavailable") {
    errors.push("safeActivityFeed.availability is invalid");
  }
  validateSafeId(value.runId, "safeActivityFeed.runId", errors, 128);
  validateUtcMilliseconds(value.updatedAt, "safeActivityFeed.updatedAt", errors);
  if (
    !Number.isSafeInteger(value.droppedEventCount) ||
    Number(value.droppedEventCount) < 0 ||
    Number(value.droppedEventCount) > CODING_SAFE_ACTIVITY_MAX_DROPPED_EVENT_COUNT
  ) {
    errors.push("safeActivityFeed.droppedEventCount is invalid");
  }
}

function validateAvailableFeed(value: Record<string, unknown>, errors: string[]): void {
  if (!Array.isArray(value.turns) || value.turns.length > CODING_SAFE_ACTIVITY_MAX_TURNS) {
    errors.push("safeActivityFeed.turns must be a bounded array");
  } else {
    const ids = { turns: new Set<string>(), messages: new Set<string>(), tools: new Set<string>() };
    value.turns.forEach((turn, index) => {
      validateTurn(turn, index, ids, errors);
    });
  }
  if (typeof value.truncated !== "boolean") {
    errors.push("safeActivityFeed.truncated must be a boolean");
  }
  if ("plan" in value) validatePlan(value.plan, errors);
}

function validatePlan(value: unknown, errors: string[]): void {
  const before = errors.length;
  const path = "safeActivityFeed.plan";
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  errors.push(
    ...exactKeys(value, ["revision", "anchorMessageId", "updatedAt", "steps", "truncated"], path),
  );
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
    errors.push(`${path}.revision must be a positive safe integer`);
  }
  validateSafeId(value.anchorMessageId, `${path}.anchorMessageId`, errors, 128);
  validateUtcMilliseconds(value.updatedAt, `${path}.updatedAt`, errors);
  validatePlanSteps(value.steps, path, errors);
  if (typeof value.truncated !== "boolean") errors.push(`${path}.truncated must be a boolean`);
  if (planHasTruncatedStep(value) && value.truncated !== true) {
    errors.push(`${path}.truncated must reflect truncated steps`);
  }
  // KEIKO-0749: mirror validateFeed's guard — only serialise for the byte budget check when the
  // structure is otherwise valid. serializedBytes runs JSON.stringify over the entire nested
  // object; running it on a value the caller has already failed shape-validation on wastes work.
  if (
    errors.length === before &&
    serializedBytes(value) > CODING_SAFE_ACTIVITY_MAX_PLAN_UTF8_BYTES
  ) {
    errors.push(`${path} exceeds the plan UTF-8 byte budget`);
  }
}

function validatePlanSteps(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length > CODING_SAFE_ACTIVITY_MAX_PLAN_STEPS) {
    errors.push(`${path}.steps must be a bounded array`);
    return;
  }
  value.forEach((step, index) => {
    validatePlanStep(step, `${path}.steps[${String(index)}]`, errors);
  });
}

function validatePlanStep(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  errors.push(...exactKeys(value, ["text", "state", "truncated"], path));
  if (
    typeof value.text !== "string" ||
    value.text.length < 1 ||
    value.text.length > CODING_SAFE_ACTIVITY_MAX_PLAN_STEP_TEXT_CHARS
  ) {
    errors.push(`${path}.text must be a bounded non-empty string`);
  } else if (stripUnsafeFormatChars(value.text) !== value.text) {
    errors.push(`${path}.text contains unsafe format characters`);
  }
  if (!isOneOf(value.state, CODING_SAFE_ACTIVITY_PLAN_STEP_STATES)) {
    errors.push(`${path}.state is invalid`);
  }
  if (typeof value.truncated !== "boolean") {
    errors.push(`${path}.truncated must be a boolean`);
  }
}

function planHasTruncatedStep(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.steps) &&
    value.steps.some((step) => isRecord(step) && step.truncated === true)
  );
}

interface FeedIdentities {
  readonly turns: Set<string>;
  readonly messages: Set<string>;
  readonly tools: Set<string>;
}

function validateTurn(value: unknown, index: number, ids: FeedIdentities, errors: string[]): void {
  const before = errors.length;
  const path = `safeActivityFeed.turns[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  errors.push(...exactKeys(value, ["turnId", "messages", "tools", "truncated"], path));
  validateUniqueId(value.turnId, `${path}.turnId`, ids.turns, errors);
  validateMessages(value.messages, path, ids.messages, errors);
  validateTools(value.tools, path, ids.tools, errors);
  if (typeof value.truncated !== "boolean") errors.push(`${path}.truncated must be a boolean`);
  if (turnHasTruncatedMessage(value) && value.truncated !== true) {
    errors.push(`${path}.truncated must reflect truncated messages`);
  }
  // KEIKO-0749: only run the deep serializedBytes call when the structure is otherwise valid,
  // mirroring validateFeed's own guard.
  if (
    errors.length === before &&
    serializedBytes(value) > CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES
  ) {
    errors.push(`${path} exceeds the turn UTF-8 byte budget`);
  }
}

function validateMessages(value: unknown, path: string, ids: Set<string>, errors: string[]): void {
  if (!Array.isArray(value) || value.length > CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN) {
    errors.push(`${path}.messages must be a bounded array`);
    return;
  }
  value.forEach((message, index) => {
    validateMessage(message, `${path}.messages[${String(index)}]`, ids, errors);
  });
}

function validateMessage(value: unknown, path: string, ids: Set<string>, errors: string[]): void {
  const before = errors.length;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  errors.push(
    ...exactKeys(
      value,
      [
        "messageId",
        "role",
        "occurredAt",
        "segments",
        "truncated",
        "reasoning",
        "origin",
        "fullAnswer",
        "fullReasoning",
        "outputLimitReached",
      ],
      path,
    ),
  );
  validateMessageOrigin(value, path, errors);
  validateOutputLimit(value, path, errors);
  validateUniqueId(value.messageId, `${path}.messageId`, ids, errors);
  if (!isOneOf(value.role, CODING_SAFE_ACTIVITY_MESSAGE_ROLES)) {
    errors.push(`${path}.role is invalid`);
  }
  validateUtcMilliseconds(value.occurredAt, `${path}.occurredAt`, errors);
  validateSegments(value.segments, path, errors);
  validateMessageTexts(value, path, errors);
  if (typeof value.truncated !== "boolean") errors.push(`${path}.truncated must be a boolean`);
  if (messageHasTruncatedSegment(value) && value.truncated !== true) {
    errors.push(`${path}.truncated must reflect truncated segments`);
  }
  // KEIKO-0749: only run the deep serializedBytes call when the structure is otherwise valid.
  if (
    errors.length === before &&
    serializedBytes(value) > CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES
  ) {
    errors.push(`${path} exceeds the message UTF-8 byte budget`);
  }
}

function validateMessageTexts(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if ("reasoning" in value) validateReasoning(value, path, errors);
  if ("fullAnswer" in value) validateFullAnswer(value, path, errors);
  if ("fullReasoning" in value) validateFullText(value, "fullReasoning", path, errors);
}

function validateOutputLimit(value: Record<string, unknown>, path: string, errors: string[]): void {
  if (!("outputLimitReached" in value)) return;
  if (value.outputLimitReached !== true) errors.push(`${path}.outputLimitReached must be true`);
  else if (value.role !== "assistant") {
    errors.push(`${path}.outputLimitReached is only allowed on assistant`);
  }
}

function validateMessageOrigin(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (!("origin" in value)) return;
  if (!isOneOf(value.origin, CODING_SAFE_ACTIVITY_MESSAGE_ORIGINS)) {
    errors.push(`${path}.origin is invalid`);
  } else if (value.role !== "user") {
    errors.push(`${path}.origin is only allowed on user`);
  }
}

function validateSegments(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length > CODING_SAFE_ACTIVITY_MAX_SEGMENTS_PER_MESSAGE) {
    errors.push(`${path}.segments must be a bounded array`);
    return;
  }
  value.forEach((segment, index) => {
    const segmentPath = `${path}.segments[${String(index)}]`;
    if (!isRecord(segment)) {
      errors.push(`${segmentPath} must be an object`);
      return;
    }
    errors.push(...exactKeys(segment, ["kind", "text", "truncated"], segmentPath));
    if (segment.kind !== "text") errors.push(`${segmentPath}.kind is invalid`);
    if (
      typeof segment.text !== "string" ||
      segment.text.length < 1 ||
      segment.text.length > CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS
    ) {
      errors.push(`${segmentPath}.text must be a bounded non-empty string`);
    } else if (stripUnsafeFormatChars(segment.text) !== segment.text) {
      errors.push(`${segmentPath}.text contains unsafe format characters`);
    }
    if (typeof segment.truncated !== "boolean") {
      errors.push(`${segmentPath}.truncated must be a boolean`);
    }
  });
}

function validateReasoning(message: Record<string, unknown>, path: string, errors: string[]): void {
  const reasoningPath = `${path}.reasoning`;
  const value = message.reasoning;
  if (message.role !== "assistant") errors.push(`${reasoningPath} is only allowed on assistant`);
  if (!isRecord(value)) {
    errors.push(`${reasoningPath} must be an object`);
    return;
  }
  errors.push(...exactKeys(value, ["text", "truncated"], reasoningPath));
  if (
    typeof value.text !== "string" ||
    value.text.length < 1 ||
    utf8Bytes(value.text) > CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES
  ) {
    errors.push(`${reasoningPath}.text must be a bounded non-empty string`);
  } else if (stripUnsafeFormatChars(value.text) !== value.text) {
    errors.push(`${reasoningPath}.text contains unsafe format characters`);
  }
  if (typeof value.truncated !== "boolean") {
    errors.push(`${reasoningPath}.truncated must be a boolean`);
  }
}

function validateFullAnswer(
  message: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (!validateFullText(message, "fullAnswer", path, errors)) return;
  const value = message.fullAnswer as Record<string, unknown>;
  if (value.truncated === true && message.truncated !== true) {
    errors.push(`${path}.truncated must reflect a truncated answer`);
  }
}

// The whole length of a retained text the feed names; true when its shape is valid.
function validateFullText(
  message: Record<string, unknown>,
  key: "fullAnswer" | "fullReasoning",
  path: string,
  errors: string[],
): boolean {
  const textPath = `${path}.${key}`;
  const value = message[key];
  if (message.role !== "assistant") errors.push(`${textPath} is only allowed on assistant`);
  if (!isRecord(value)) {
    errors.push(`${textPath} must be an object`);
    return false;
  }
  const before = errors.length;
  errors.push(...exactKeys(value, ["length", "truncated"], textPath));
  // Length 0 names a text the memory bound cut to nothing; an uncut text is never named empty.
  const emptyCut = value.length === 0 && value.truncated === true;
  if (!emptyCut && !validAnswerLength(value.length)) errors.push(`${textPath}.length is invalid`);
  if (typeof value.truncated !== "boolean") errors.push(`${textPath}.truncated must be a boolean`);
  return errors.length === before;
}

function validAnswerLength(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= CODING_SAFE_ACTIVITY_MAX_RETAINED_ANSWER_CHARS
  );
}

const ANSWER_PAGE_KEYS = [
  "schemaVersion",
  "runId",
  "messageId",
  "part",
  "offset",
  "text",
  "length",
  "truncated",
] as const;

/** Validates one retained-answer page: exact keys, a bounded page that lies inside the answer. */
/** A run or message identifier as the feed carries it: a bounded safe identifier. */
export function isCodingSafeActivityIdentifier(value: string): boolean {
  const errors: string[] = [];
  validateSafeId(value, "identifier", errors, 128);
  return errors.length === 0;
}

export function validateCodingSafeActivityAnswerPage(
  value: unknown,
): CodingWorkbenchValidationResult<CodingSafeActivityAnswerPage> {
  if (!isRecord(value)) return invalid("safe activity answer page must be an object");
  const errors = exactKeys(value, ANSWER_PAGE_KEYS, "answerPage");
  if (value.schemaVersion !== CODING_SAFE_ACTIVITY_CONTRACT_VERSION) {
    errors.push("answerPage.schemaVersion is invalid");
  }
  validateSafeId(value.runId, "answerPage.runId", errors, 128);
  validateSafeId(value.messageId, "answerPage.messageId", errors, 128);
  if (!isOneOf(value.part, CODING_SAFE_ACTIVITY_TEXT_PARTS))
    errors.push("answerPage.part is invalid");
  validateAnswerPageText(value, errors);
  if (typeof value.truncated !== "boolean") errors.push("answerPage.truncated must be a boolean");
  return result(value, errors);
}

function validateAnswerPageText(value: Record<string, unknown>, errors: string[]): void {
  const { offset, text, length } = value;
  if (!validAnswerLength(length)) {
    errors.push("answerPage.length is invalid");
    return;
  }
  if (!isTextOffset(offset)) {
    errors.push("answerPage.offset is invalid");
    return;
  }
  if (
    typeof text !== "string" ||
    text.length > CODING_SAFE_ACTIVITY_ANSWER_PAGE_MAX_CHARS ||
    offset + text.length > length ||
    (text.length === 0 && offset < length)
  ) {
    errors.push("answerPage.text must be a bounded page inside the answer");
    return;
  }
  validateSafeText(text, "answerPage.text", errors);
}

function isTextOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateSafeText(text: string, path: string, errors: string[]): void {
  if (stripUnsafeFormatChars(text) !== text)
    errors.push(`${path} contains unsafe format characters`);
}

/** Validates one channel update's text deltas: a bounded list of non-empty, safe pieces. */
export function validateCodingSafeActivityTextDeltas(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!Array.isArray(value) || value.length > CODING_SAFE_ACTIVITY_MAX_TEXT_DELTAS) {
    errors.push(`${path} must be a bounded array`);
    return;
  }
  value.forEach((delta: unknown, index) => {
    validateTextDelta(delta, `${path}[${String(index)}]`, errors);
  });
}

function validateTextDelta(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  errors.push(...exactKeys(value, ["messageId", "part", "offset", "text"], path));
  validateSafeId(value.messageId, `${path}.messageId`, errors, 128);
  if (!isOneOf(value.part, CODING_SAFE_ACTIVITY_TEXT_PARTS)) errors.push(`${path}.part is invalid`);
  const { offset, text } = value;
  if (!isTextOffset(offset) || offset >= CODING_SAFE_ACTIVITY_MAX_RETAINED_ANSWER_CHARS) {
    errors.push(`${path}.offset is invalid`);
  }
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > CODING_SAFE_ACTIVITY_MAX_TEXT_DELTA_CHARS
  ) {
    errors.push(`${path}.text must be a bounded non-empty piece`);
    return;
  }
  validateSafeText(text, `${path}.text`, errors);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function validateTools(value: unknown, path: string, ids: Set<string>, errors: string[]): void {
  if (!Array.isArray(value) || value.length > CODING_SAFE_ACTIVITY_MAX_TOOLS_PER_TURN) {
    errors.push(`${path}.tools must be a bounded array`);
    return;
  }
  value.forEach((tool, index) => {
    validateTool(tool, `${path}.tools[${String(index)}]`, ids, errors);
  });
}

function messageHasTruncatedSegment(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.segments) &&
    value.segments.some((segment) => isRecord(segment) && segment.truncated === true)
  );
}

function turnHasTruncatedMessage(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.messages) &&
    value.messages.some((message) => isRecord(message) && message.truncated === true)
  );
}

function validateTool(value: unknown, path: string, ids: Set<string>, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  errors.push(...exactKeys(value, ["callId", "tool", "state", "occurredAt", "presentation"], path));
  validateUniqueId(value.callId, `${path}.callId`, ids, errors);
  validateSafeId(value.tool, `${path}.tool`, errors, CODING_SAFE_ACTIVITY_TOOL_LABEL_MAX_CHARS);
  if (!isOneOf(value.state, CODING_SAFE_ACTIVITY_TOOL_STATES)) {
    errors.push(`${path}.state is invalid`);
  }
  validateUtcMilliseconds(value.occurredAt, `${path}.occurredAt`, errors);
  if (
    value.presentation !== undefined &&
    !isCodingSafeActivityToolPresentation(value.presentation)
  ) {
    errors.push(`${path}.presentation is invalid`);
  }
}

export function isCodingSafeActivityToolPresentation(
  value: unknown,
): value is CodingSafeActivityToolPresentation {
  if (!isRecord(value) || Object.keys(value).length === 0) return false;
  const allowed = [
    "relativePath",
    "affectedRelativePath",
    "readByteCount",
    "totalFileLines",
    "returnedPathCount",
    "refusalReason",
    "verificationOutcome",
    "gitOutcome",
    "gitAction",
    "bridgeDurationMs",
    "exitCode",
    "failureOrigin",
    "refusalCause",
    "durationMs",
    "failureCount",
    "command",
    "output",
    "errorText",
    "agentName",
    "taskDescription",
    "taskPrompt",
    "detailOmitted",
    "outputShortened",
  ];
  if (exactKeys(value, allowed, "presentation").length > 0) return false;
  return (
    validPresentationPaths(value) &&
    validPresentationCounts(value) &&
    validPresentationScalars(value) &&
    validPresentationVocabulary(value) &&
    validPresentationText(value)
  );
}

function validPresentationScalars(value: Record<string, unknown>): boolean {
  return (
    (value.exitCode === undefined || Number.isSafeInteger(value.exitCode)) &&
    (value.detailOmitted === undefined || value.detailOmitted === true) &&
    (value.outputShortened === undefined || isOutputShortened(value.outputShortened))
  );
}

function isOutputShortened(value: unknown): boolean {
  if (
    !isRecord(value) ||
    exactKeys(value, ["keptBytes", "keptLines", "totalLines"], "x").length > 0
  )
    return false;
  const { keptBytes, keptLines, totalLines } = value;
  if (!isCount(keptBytes)) return false;
  if (keptLines === undefined && totalLines === undefined) return true;
  return isCount(keptLines) && isCount(totalLines) && keptLines < totalLines;
}

function validPresentationVocabulary(value: Record<string, unknown>): boolean {
  return (
    (value.gitAction === undefined || isOneOf(value.gitAction, CODING_SAFE_ACTIVITY_GIT_ACTIONS)) &&
    validPresentationOutcomeVocabulary(value)
  );
}

function validPresentationOutcomeVocabulary(value: Record<string, unknown>): boolean {
  return (
    (value.refusalReason === undefined ||
      isOneOf(value.refusalReason, CODING_SAFE_ACTIVITY_EDIT_REFUSAL_REASON_CODES)) &&
    (value.verificationOutcome === undefined ||
      isOneOf(value.verificationOutcome, CODING_SAFE_ACTIVITY_VERIFICATION_OUTCOMES)) &&
    (value.gitOutcome === undefined ||
      isOneOf(value.gitOutcome, CODING_SAFE_ACTIVITY_GIT_OUTCOMES)) &&
    (value.failureOrigin === undefined ||
      isOneOf(value.failureOrigin, CODING_SAFE_ACTIVITY_TOOL_FAILURE_ORIGINS)) &&
    (value.refusalCause === undefined ||
      isOneOf(value.refusalCause, CODING_SAFE_ACTIVITY_TOOL_REFUSAL_CAUSES))
  );
}

// A tool's text is bounded, free of unsafe format characters, and never carried beside a shed one.
function validPresentationText(value: Record<string, unknown>): boolean {
  if (
    value.detailOmitted === true &&
    [value.command, value.output, value.errorText, value.taskPrompt].some(Boolean)
  )
    return false;
  return (
    validSubagentText(value) &&
    (value.command === undefined ||
      isToolText(value.command, CODING_SAFE_ACTIVITY_MAX_TOOL_COMMAND_CHARS)) &&
    (value.errorText === undefined ||
      isToolText(value.errorText, CODING_SAFE_ACTIVITY_MAX_TOOL_ERROR_CHARS)) &&
    (value.output === undefined || isToolOutput(value.output))
  );
}

function validSubagentText(value: Record<string, unknown>): boolean {
  return (
    (value.agentName === undefined ||
      isToolText(value.agentName, CODING_SAFE_ACTIVITY_MAX_TOOL_AGENT_NAME_CHARS)) &&
    (value.taskDescription === undefined ||
      isToolText(value.taskDescription, CODING_SAFE_ACTIVITY_MAX_TOOL_TASK_DESCRIPTION_CHARS)) &&
    (value.taskPrompt === undefined ||
      isToolText(value.taskPrompt, CODING_SAFE_ACTIVITY_MAX_TOOL_TASK_PROMPT_CHARS))
  );
}

function isToolText(value: unknown, maxChars: number): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, ["text", "truncated"], "text").length === 0 &&
    isBoundedSafeText(value.text, maxChars) &&
    value.text !== "" &&
    typeof value.truncated === "boolean"
  );
}

function isToolOutput(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = ["head", "tail", "lineCount", "hiddenLineCount", "truncated"];
  if (exactKeys(value, keys, "output").length > 0) return false;
  const { head, tail } = value;
  return (
    isBoundedSafeText(head, CODING_SAFE_ACTIVITY_MAX_TOOL_OUTPUT_PART_CHARS) &&
    isBoundedSafeText(tail, CODING_SAFE_ACTIVITY_MAX_TOOL_OUTPUT_PART_CHARS) &&
    head !== "" &&
    validOutputLines(value.lineCount, value.hiddenLineCount, tail) &&
    typeof value.truncated === "boolean"
  );
}

// Lines are hidden only between a head and a tail, and never all of them.
function validOutputLines(lineCount: unknown, hiddenLineCount: unknown, tail: string): boolean {
  return (
    isCount(lineCount) &&
    isCount(hiddenLineCount) &&
    hiddenLineCount < lineCount &&
    (tail !== "" || hiddenLineCount === 0)
  );
}

function isBoundedSafeText(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" && value.length <= maxChars && stripUnsafeFormatChars(value) === value
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validPresentationPaths(value: Record<string, unknown>): boolean {
  return ["relativePath", "affectedRelativePath"].every(
    (key) => value[key] === undefined || isCodingSafeActivityPresentationPath(value[key]),
  );
}

function validPresentationCounts(value: Record<string, unknown>): boolean {
  return [
    "readByteCount",
    "totalFileLines",
    "returnedPathCount",
    "bridgeDurationMs",
    "durationMs",
    "failureCount",
  ].every((key) => {
    const count = value[key];
    return (
      count === undefined ||
      (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
    );
  });
}

/** Reuses the workspace path contract and excludes deceptive/control characters from UI labels. */
export function isCodingSafeActivityPresentationPath(value: unknown): value is string {
  return (
    isPortableWorkspaceRelativePath(value) &&
    stripUnsafeFormatChars(value) === value &&
    displayPathHasNoControls(value)
  );
}

function displayPathHasNoControls(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function validateUniqueId(value: unknown, path: string, ids: Set<string>, errors: string[]): void {
  const before = errors.length;
  validateSafeId(value, path, errors, 128);
  if (errors.length !== before || typeof value !== "string") return;
  if (ids.has(value)) errors.push(`${path} must be unique`);
  else ids.add(value);
}

function validateUtcMilliseconds(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    errors.push(`${path} must be a strict UTC millisecond instant`);
    return;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) {
    errors.push(`${path} must be a strict UTC millisecond instant`);
  }
}

function serializedBytes(value: object): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
