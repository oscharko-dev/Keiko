import { createHash } from "node:crypto";
import type {
  CodingSafeActivityFeed,
  CodingSafeActivityMessageRole,
  CodingSafeActivityPlanStepState,
  CodingSafeActivityTextSegment,
  CodingSafeActivityTool,
  CodingSafeActivityToolState,
  UnavailableCodingSafeActivityFeed,
  VerificationKind,
} from "@oscharko-dev/keiko-contracts";
import {
  countFailedCall,
  createToolFailureLedger,
  EXIT_CODE_CLASSES,
  exitCodeClass,
  takeUnloggedFailure,
  type ToolFailureLedger,
} from "./codingSafeActivityToolFailures.js";
import {
  CODING_SAFE_ACTIVITY_MAX_DROPPED_EVENT_COUNT,
  CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN,
  CODING_SAFE_ACTIVITY_MAX_PLAN_STEPS,
  CODING_SAFE_ACTIVITY_MAX_PLAN_STEP_TEXT_CHARS,
  CODING_SAFE_ACTIVITY_MAX_PLAN_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_MAX_RETAINED_ANSWER_CHARS,
  CODING_SAFE_ACTIVITY_MAX_SEGMENTS_PER_MESSAGE,
  CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TOOLS_PER_TURN,
  CODING_SAFE_ACTIVITY_MAX_TURNS,
  CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_MAX_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_TOOL_STATES,
  CODING_SAFE_ACTIVITY_MESSAGE_ORIGINS,
  CODING_SAFE_ACTIVITY_PLAN_STEP_STATES,
  CODING_SAFE_ACTIVITY_TOOL_FAILURE_ORIGINS,
  codingSafeActivityStateFailureOrigin,
  unavailableCodingSafeActivityFeed,
  validateCodingSafeActivityFeed,
  isCodingSafeActivityToolPresentation,
  type CodingSafeActivityToolPresentation,
  type CodingSafeActivityAnswerPage,
  type CodingSafeActivityFullAnswer,
  type CodingSafeActivityMessageOrigin,
  type CodingSafeActivityReasoning,
  type CodingSafeActivityTextDelta,
  type CodingSafeActivityTextPart,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import { CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import {
  isCodingWorkbenchNativeRetry,
  type CodingWorkbenchNativeRetry,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/runtime/text-safety";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  emitServerDiagnostic,
  type ServerDiagnosticSink,
  type ServerDiagnosticSummary,
} from "../diagnostics-log.js";
import { correlationIdOrUnknown } from "../correlation.js";
import {
  cloneRetainedTexts,
  createRetainedTexts,
  FULL_TEXT_RESERVE,
  fullTextFor,
  markSourceCut,
  releaseUnlistedTexts,
  restoreRetainedTexts,
  retainedText,
  retainedTextPage,
  retainText,
  takeTextDeltas,
  type RetainedText,
  type RetainedTexts,
} from "./codingSafeActivityAnswers.js";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  DEFAULT_RUNTIME_MAX_DURATION_MINUTES,
  runtimeMaxDurationMs,
} from "./productionRuntimeWorkspaceAuthority.js";

// Retention outlives the Authority Envelope by this margin, so a run that fails closed at expiry
// still shows its last activity while it settles.
const SAFE_ACTIVITY_RETENTION_MARGIN_MS = 5 * 60_000;

/**
 * The TTL that keeps a run's feed for its whole envelope. The TTL is a hard cap that wins over a
 * longer authority expiry, and the envelope duration is an operator setting
 * (`KEIKO_CODING_RUNTIME_MAX_DURATION_MINUTES`, #3873): a fixed 30-minute cap evicted a live run's
 * feed at minute 30 of a 120-minute envelope. Production derives `ttlMs` from the configured
 * duration through this one formula, and the default below follows the default duration.
 */
export function codingSafeActivityTtlMs(runtimeMaxDurationMs: number): number {
  return runtimeMaxDurationMs + SAFE_ACTIVITY_RETENTION_MARGIN_MS;
}

const DEFAULT_TTL_MS = codingSafeActivityTtlMs(
  runtimeMaxDurationMs(DEFAULT_RUNTIME_MAX_DURATION_MINUTES),
);
const DEFAULT_MAX_SUBSCRIBERS = 32;
const DEFAULT_MAX_SIGNAL_IDENTITIES = 32_768;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const CODING_RUNTIME_SAFE_ACTIVITY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.safe-activity",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingSafeActivityProjection.lifecycle",
  fields: {
    // `superseded`: a late runtime update for a call Keiko already settled was set aside, not lost
    // (PR #3617 review), so a reader can reconstruct that the update arrived.
    event: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      // `interrupted`: a run's end (Stop, takeover or any other terminal state) settled the calls still open as cancelled and kept
      // the feed, as OpenCode keeps an aborted session's tool steps (owner decision 2026-10-30, #3907).
      // `answer-retained` / `reasoning-retained`: an assistant answer or the model's reasoning grew
      // longer than the bounded feed carries; the feed names it and its complete text is streamed as
      // deltas and read page by page, so nothing of it is lost.
      // `answer-clipped` / `reasoning-clipped`: the run's memory bound for retained model text cut
      // one, shown on the message.
      values: [
        "purged",
        "dropped",
        "superseded",
        "interrupted",
        "answer-retained",
        "answer-clipped",
        "reasoning-retained",
        "reasoning-clipped",
      ],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "stop",
        "takeover",
        "run-ended",
        "shutdown",
        "workspace-switch",
        "invariant-violation",
        "validation-rejected",
        "redactor-collapsed",
        "projection-rejected",
        "capacity-rejected",
        "subscriber-rejected",
        "late-restatement",
        "feed-bound",
        "retention-bound",
        "source-bound",
      ],
    },
    occurrenceCount: { type: "integer", dataClass: "count", required: false },
    // On a superseded update only: which call it restated, as a digest, and the call's settled state
    // against the state the late update restated (PR #3617 review).
    callIdSha256: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    settledState: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["succeeded", "failed", "denied", "cancelled"],
    },
    restatedState: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["pending", "running", "failed", "succeeded", "denied"],
    },
    // On a refused tool transition only (#4130 review lab): the call's state, the state the refused
    // update asked for ("absent" when the call is not in the feed), and whether OpenCode or Keiko's
    // own settlement sent it, so the log tells a lost update from a genuine regression.
    refusedFromState: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["absent", ...CODING_SAFE_ACTIVITY_TOOL_STATES],
    },
    refusedToState: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: CODING_SAFE_ACTIVITY_TOOL_STATES,
    },
    refusedSignalSource: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["opencode", "keiko"],
    },
    // #3610: why the projection refused a well-formed signal, on a projection-rejected drop only.
    rejection: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "parent-message-unknown",
        "message-unknown",
        "tool-transition-refused",
        "tool-name-missing",
        "feed-unavailable",
        // #3878: model reasoning addressed to a message that is not the assistant's.
        "reasoning-role-invalid",
      ],
    },
    lossState: {
      type: "string",
      dataClass: "loss-state",
      required: false,
      values: ["event-dropped"],
    },
  },
  causal: "correlation",
  lifecycle: "loss",
  analyzerProjection: "timeline",
  failureClasses: ["coding-safe-activity-projection"],
  proofIds: ["coding-runtime.safe-activity.emitted-line"],
  releaseImpact: "patch",
});

// The native tools outside Code Mode plus Code Mode's own `execute` entry (the tools it runs are
// reported as `execute`), spelled out so the operation registry can read the closed vocabulary; the
// owning test pins it to OPENCODE_NATIVE_TOOL_NAMES so the two cannot drift.
export const NATIVE_TOOL_DENIED_TOOLS: readonly string[] = [
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "patch",
  "shell",
  "webfetch",
  "websearch",
  "skill",
  "subagent",
  "question",
  "todowrite",
  "execute",
];
const NATIVE_TOOL_DENIED_TOOL_SET: ReadonlySet<string> = new Set(NATIVE_TOOL_DENIED_TOOLS);

/**
 * OpenCode settled a native tool call with its closed `permission.rejected` error type. That token
 * is shared by every permission rejection: a configured rule (such as the mode-independent
 * `external_directory` deny), Keiko's policy hook replying `reject`, and a person pressing Deny. It
 * does not name the origin, so no field here claims one. A matching
 * `coding-runtime.native-policy.decided` line exists only when Keiko's policy hook made or relayed
 * the decision. Body-free: the closed tool class and a per-run count, never a path, command or the
 * upstream message.
 */
const CODING_RUNTIME_NATIVE_TOOL_DENIED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.native-tool.denied",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingSafeActivityProjection.nativeToolDenied",
  fields: {
    tool: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...NATIVE_TOOL_DENIED_TOOLS, "other"],
    },
    occurrenceCount: { type: "integer", dataClass: "count", required: true },
    callIdSha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-native-policy"],
  proofIds: ["coding-runtime.native-tool.denied.emitted-line"],
  releaseImpact: "patch",
});

/**
 * A tool call that did not succeed, one line per call: where it failed (Keiko refused it, its
 * command failed, the tool failed, it timed out or was stopped), the tool's closed class and, for a
 * shell, the class of its exit status. Running counts make the run's pattern readable from its last
 * line ("12 command failures, 0 Keiko refusals"). Body-free: never a command, an output or a message.
 */
const CODING_RUNTIME_TOOL_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.tool.failed",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingSafeActivityProjection.toolFailed",
  fields: {
    tool: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...NATIVE_TOOL_DENIED_TOOLS, "keiko", "other"],
    },
    failureOrigin: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...CODING_SAFE_ACTIVITY_TOOL_FAILURE_ORIGINS],
    },
    exitCodeClass: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...EXIT_CODE_CLASSES],
    },
    commandFailureCount: { type: "integer", dataClass: "count", required: true },
    failedCallCount: { type: "integer", dataClass: "count", required: true },
    repeatedFailureCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-safe-activity-projection"],
  proofIds: ["coding-runtime.tool.failed.emitted-line"],
  releaseImpact: "patch",
});

// A native tool keeps its closed name, Keiko's governed tools are `keiko`, anything else `other`.
function toolLogClass(tool: string): string {
  if (NATIVE_TOOL_DENIED_TOOL_SET.has(tool)) return tool;
  return tool.startsWith("keiko_") ? "keiko" : "other";
}

interface SignalBase {
  readonly occurredAt: string;
  /** Optional upstream identity used to make replayed history idempotent. */
  readonly signalId?: string | undefined;
}

/** Raw plan-step input; the projection strips, clips, and bounds it before publication. */
export interface CodingSafeActivityPlanStepInput {
  readonly text: string;
  readonly state: CodingSafeActivityPlanStepState;
}

export type CodingSafeActivitySignal =
  | (SignalBase & {
      readonly kind: "message";
      readonly messageId: string;
      readonly role: CodingSafeActivityMessageRole;
      /**
       * A `user` message Keiko dispatched itself, read from the runtime message's origin metadata
       * (#4491). Absent: the person's own message.
       */
      readonly origin?: CodingSafeActivityMessageOrigin | undefined;
      readonly parentMessageId?: string | undefined;
      /** Committed native metadata; the backend projects it separately without retaining bodies. */
      readonly nativeRetry?: CodingWorkbenchNativeRetry;
    })
  | (SignalBase & {
      readonly kind: "text";
      readonly messageId: string;
      readonly text: string;
    })
  // #3878: a piece of the model's reasoning for an assistant message, appended like its text.
  | (SignalBase & {
      readonly kind: "reasoning";
      readonly messageId: string;
      readonly text: string;
    })
  // The source showed only a prefix of an assistant text part (the live part bound), so the text
  // the projection holds is cut and the feed marks it.
  | (SignalBase & {
      readonly kind: "text-cut";
      readonly messageId: string;
      readonly part: CodingSafeActivityTextPart;
    })
  | (SignalBase & {
      readonly kind: "tool";
      readonly messageId?: string | undefined;
      readonly callId: string;
      readonly tool?: string | undefined;
      readonly state: CodingSafeActivityToolState;
      readonly presentation?: CodingSafeActivityToolPresentation;
      /**
       * A finished native `shell` call's exit status for run evidence; the composition removes it
       * here and the timeline receives the number alone as `presentation.exitCode`.
       */
      readonly exitCode?: number | undefined;
      /**
       * The project check that exit status speaks for, read from the finished call's whole command
       * line; absent when the line is no check or another command could decide its status.
       */
      readonly exitStatusCheck?: VerificationKind | undefined;
      /** The finished call ran in a working directory it named itself, not the session's. */
      readonly ownWorkdir?: boolean | undefined;
    })
  | (SignalBase & {
      readonly kind: "plan";
      readonly anchorMessageId: string;
      readonly steps: readonly CodingSafeActivityPlanStepInput[];
    });

export type CodingSafeActivityPurgeReason =
  | "stop"
  | "takeover"
  | "shutdown"
  | "workspace-switch"
  // #2906 round 3: reserved for finalizeIngest's KEIKO-0878 invariant-violation branch -- validate
  // rejected a post-mutation feed that isFeedNearProjectionLimit's pre-mutation check believed
  // could not fail. Distinct from TTL/authority expiry (which never reaches purgeCurrent at all --
  // see expireCurrent, which purges silently with no diagnostic) so the timeline never collapses a
  // genuine invariant bug into an unrelated, diagnostic-free expiry code.
  | "invariant-violation";
export type CodingSafeActivityDropReason =
  | "validation-rejected"
  | "redactor-collapsed"
  | "projection-rejected"
  | "capacity-rejected"
  | "subscriber-rejected";

export interface CodingSafeActivityContent {
  readonly kind: "safe-activity";
  readonly feed: CodingSafeActivityFeed;
  /** What the model texts gained since the previous live update; live updates only. */
  readonly textDeltas?: readonly CodingSafeActivityTextDelta[];
}

/** Which page of which retained model text to read; from the request, so untrusted. */
export interface CodingSafeActivityTextPageRequest {
  readonly messageId: string;
  readonly part: CodingSafeActivityTextPart;
  readonly offset: number;
}

export interface CodingSafeActivityProjectionLimits {
  readonly maxTurns?: number | undefined;
  readonly maxMessagesPerTurn?: number | undefined;
  readonly maxSegmentsPerMessage?: number | undefined;
  readonly maxToolsPerTurn?: number | undefined;
  readonly maxMessageBytes?: number | undefined;
  readonly maxReasoningBytes?: number | undefined;
  readonly maxTurnBytes?: number | undefined;
  readonly maxTotalBytes?: number | undefined;
  readonly maxPlanSteps?: number | undefined;
  readonly maxPlanStepChars?: number | undefined;
  readonly maxPlanBytes?: number | undefined;
  readonly maxRetainedAnswerChars?: number | undefined;
}

export interface CodingSafeActivityOpenInput {
  readonly runId: string;
  readonly workspaceId: string;
  readonly authorityExpiresAt: string;
  readonly workspaceIsCurrent: () => boolean;
}

export interface CodingSafeActivityProjectionOptions {
  readonly now?: (() => number) | undefined;
  readonly ttlMs?: number | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly limits?: CodingSafeActivityProjectionLimits | undefined;
  readonly maxDroppedEventCount?: number | undefined;
  readonly maxSubscribers?: number | undefined;
  readonly maxSignalIdentities?: number | undefined;
}

export interface CodingSafeActivitySubscription {
  readonly admitted: boolean;
  readonly detach: () => void;
}

export interface CodingSafeActivityProjection {
  readonly open: (input: CodingSafeActivityOpenInput) => void;
  readonly ingest: (runId: string, signal: CodingSafeActivitySignal) => boolean;
  readonly recordDrop: (runId: string, reason: CodingSafeActivityDropReason) => void;
  readonly recordDrops: (
    runId: string,
    reason: CodingSafeActivityDropReason,
    count: number,
  ) => void;
  readonly purge: (runId: string, reason: CodingSafeActivityPurgeReason) => void;
  // `correlationId` is the calling operation (a server shutdown); see the implementation.
  readonly purgeAll: (reason: CodingSafeActivityPurgeReason, correlationId?: string) => void;
  readonly markUnavailable: (runId: string) => void;
  readonly interrupt: (runId: string, reason: "stop" | "takeover" | "run-ended") => void;
  readonly currentContent: () => CodingSafeActivityContent | null;
  /** A listed assistant answer's complete text, for Coding History; undefined when there is none. */
  readonly answerText: (runId: string, messageId: string) => string | undefined;
  /** One page of a listed assistant answer's or reasoning's complete text; null when none. */
  readonly answerPage: (
    runId: string,
    request: CodingSafeActivityTextPageRequest,
  ) => CodingSafeActivityAnswerPage | null;
  readonly subscribeContent: (
    listener: (content: CodingSafeActivityContent | null) => void,
  ) => CodingSafeActivitySubscription;
}

interface MutableMessage {
  messageId: string;
  role: CodingSafeActivityMessageRole;
  origin?: CodingSafeActivityMessageOrigin;
  occurredAt: string;
  segments: CodingSafeActivityTextSegment[];
  truncated: boolean;
  reasoning?: CodingSafeActivityReasoning;
  fullAnswer?: CodingSafeActivityFullAnswer;
  fullReasoning?: CodingSafeActivityFullAnswer;
}

interface MutableTurn {
  turnId: string;
  messages: MutableMessage[];
  tools: CodingSafeActivityTool[];
  truncated: boolean;
}

interface MutablePlanStep {
  text: string;
  state: CodingSafeActivityPlanStepState;
  truncated: boolean;
}

interface MutablePlan {
  revision: number;
  anchorMessageId: string;
  updatedAt: string;
  steps: MutablePlanStep[];
  truncated: boolean;
}

interface MutableFeed {
  schemaVersion: "1";
  availability: "available";
  runId: string;
  updatedAt: string;
  turns: MutableTurn[];
  plan?: MutablePlan;
  truncated: boolean;
  droppedEventCount: number;
}

// What an ingest near a bound may have to roll back to.
interface PriorState {
  readonly feed: StoredFeed | undefined;
  readonly messageTurns: Map<string, string> | undefined;
  readonly texts: RetainedTexts | undefined;
}

const NO_ROLLBACK: PriorState = { feed: undefined, messageTurns: undefined, texts: undefined };

function rollbackSnapshot(entry: ProjectionEntry): PriorState {
  return {
    feed: structuredClone(entry.feed),
    messageTurns: new Map(entry.messageTurns),
    texts: cloneRetainedTexts(entry.texts),
  };
}

const TEXT_PARTS: ReadonlySet<CodingSafeActivityTextPart> = new Set(["answer", "reasoning"]);
type TextCounts = Record<
  CodingSafeActivityTextPart,
  { readonly named: number; readonly clipped: number; readonly sourceCut: number }
>;
type TextFactEvent = `${CodingSafeActivityTextPart}-${"retained" | "clipped"}`;

function textCounts(texts: RetainedTexts): TextCounts {
  return { answer: { ...texts.counts.answer }, reasoning: { ...texts.counts.reasoning } };
}

// The channel snapshot's own keys around its content (`{"schemaVersion":"1","content":…}`), with room.
const SNAPSHOT_ENVELOPE_BYTES = 64;

interface ProjectionEntry {
  readonly runId: string;
  readonly workspaceId: string;
  readonly workspaceIsCurrent: () => boolean;
  readonly expiresAtMs: number;
  readonly signalIds: Set<string>;
  readonly messageTurns: Map<string, string>;
  /** The complete text of every assistant answer and reasoning the feed lists, beside the feed. */
  readonly texts: RetainedTexts;
  /** The run's failed tool calls: repeated-failure counts and which failures were logged. */
  readonly toolFailures: ToolFailureLedger;
  feed: StoredFeed;
  /** The run ended and its open calls were settled; no new open call is admitted after it. */
  interrupted: boolean;
}

type StoredFeed = MutableFeed | UnavailableCodingSafeActivityFeed;

interface ResolvedLimits {
  readonly maxTurns: number;
  readonly maxMessagesPerTurn: number;
  readonly maxSegmentsPerMessage: number;
  readonly maxToolsPerTurn: number;
  readonly maxMessageBytes: number;
  readonly maxReasoningBytes: number;
  readonly maxTurnBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPlanSteps: number;
  readonly maxPlanStepChars: number;
  readonly maxPlanBytes: number;
  readonly maxRetainedAnswerChars: number;
}

/**
 * #3610: why the projection refused a well-formed signal. The drop line carried only
 * "projection-rejected", so an omitted update could not be traced to the signal that caused it.
 */
type ProjectionRejection =
  | "parent-message-unknown"
  | "message-unknown"
  | "tool-transition-refused"
  | "tool-name-missing"
  | "feed-unavailable"
  | "reasoning-role-invalid";

type SignalApplication =
  "accepted" | "capacity-dropped" | "restatement-superseded" | ProjectionRejection;

const APPLIED: ReadonlySet<SignalApplication> = new Set<SignalApplication>([
  "accepted",
  "capacity-dropped",
  "restatement-superseded",
]);

function projectionRejection(application: SignalApplication): ProjectionRejection | undefined {
  return APPLIED.has(application) ? undefined : (application as ProjectionRejection);
}

class SafeActivityProjection implements CodingSafeActivityProjection {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly diagnostics: ServerDiagnosticSink | undefined;
  private readonly activityLog: ServerLogSink | undefined;
  private readonly limits: ResolvedLimits;
  private readonly maxDroppedEventCount: number;
  private readonly maxSubscribers: number;
  private readonly maxSignalIdentities: number;
  private readonly subscribers = new Set<(content: CodingSafeActivityContent | null) => void>();
  private entry: ProjectionEntry | undefined;
  private subscriberRunId: string | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private faultDropCount = 0;
  private supersededRestatementCount = 0;
  private nativeToolDenialCount = 0;
  private readonly recordedDenials = new Set<string>();

  public constructor(options: CodingSafeActivityProjectionOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = positive(options.ttlMs, DEFAULT_TTL_MS);
    this.diagnostics = options.diagnostics;
    this.activityLog = options.activityLog;
    this.limits = resolvedLimits(options.limits);
    this.maxDroppedEventCount = boundedCounterLimit(options.maxDroppedEventCount);
    this.maxSubscribers = positive(options.maxSubscribers, DEFAULT_MAX_SUBSCRIBERS);
    this.maxSignalIdentities = capped(options.maxSignalIdentities, DEFAULT_MAX_SIGNAL_IDENTITIES);
  }

  public open(input: CodingSafeActivityOpenInput): void {
    const now = this.now();
    const authorityExpiry = Date.parse(input.authorityExpiresAt);
    const expiresAtMs = Math.min(now + this.ttlMs, authorityExpiry);
    this.entry = {
      runId: input.runId,
      workspaceId: input.workspaceId,
      workspaceIsCurrent: input.workspaceIsCurrent,
      expiresAtMs,
      signalIds: new Set(),
      messageTurns: new Map(),
      texts: createRetainedTexts(this.limits.maxRetainedAnswerChars),
      toolFailures: createToolFailureLedger(),
      feed: emptyFeed(input.runId, instant(now)),
      interrupted: false,
    };
    if (this.subscribers.size > 0) this.subscriberRunId = input.runId;
    if (!validOpenInput(input, expiresAtMs, now)) this.expireCurrent();
    else {
      this.faultDropCount = 0;
      this.supersededRestatementCount = 0;
      this.nativeToolDenialCount = 0;
      this.recordedDenials.clear();
      this.scheduleExpiry(this.entry);
      this.notify();
    }
  }

  public ingest(runId: string, signal: CodingSafeActivitySignal): boolean {
    const entry = this.liveEntry(runId);
    if (entry?.feed.availability !== "available") return false;
    const rejected = signalDropReason(signal);
    if (rejected !== undefined) return this.reject(runId, rejected);
    if (signal.signalId !== undefined && entry.signalIds.has(signal.signalId)) return true;
    // KEIKO-0878: only take the rollback snapshot when the pre-mutation state is close enough to
    // a projection limit that validateCodingSafeActivityFeed could plausibly reject the
    // post-mutation state. The overwhelming common case is well below every limit (early in a
    // run) and never trips validate; skipping the structuredClone on that path replaces per-
    // signal deep-clone allocation with a cheap 3-field integer comparison. Validate is still
    // run every time, so a bug in enforceFeedBounds cannot slip past silently.
    const prior = isFeedNearProjectionLimit(entry, this.limits)
      ? rollbackSnapshot(entry)
      : NO_ROLLBACK;
    const countsBefore = textCounts(entry.texts);
    const application = this.applyRecordingDenial(runId, entry, signal);
    const ended = this.endedApplication(runId, entry, signal, application);
    if (ended !== undefined) {
      this.recordToolFailure(runId, entry);
      return ended;
    }
    entry.feed.updatedAt = signal.occurredAt;
    const capacityDrop = capacityDropForApplication(
      entry,
      application,
      this.maxDroppedEventCount,
      signal.occurredAt,
    );
    enforceFeedBounds(entry, this.limits);
    const finalized = this.finalizeCapacityDrop(runId, entry, signal, { ...prior, capacityDrop });
    releaseUnlistedTexts(entry.texts, (messageId) => entry.messageTurns.has(messageId));
    if (finalized) this.recordTextFacts(runId, entry, countsBefore);
    // A call that failed gets its line even when the feed dropped, displaced or refused it.
    this.recordToolFailure(runId, entry);
    return finalized;
  }

  // Only an applied signal counts as seen: one a capacity rollback refused is applied again when it
  // is delivered again, so a refused terminal tool state cannot leave its row running.
  private rememberAppliedSignal(entry: ProjectionEntry, signal: CodingSafeActivitySignal): void {
    if (signal.signalId === undefined) return;
    rememberBoundedIdentity(entry.signalIds, signal.signalId, this.maxSignalIdentities);
  }

  // One body-free line per failed call: where it failed, the tool's closed class, the shell's exit
  // status class and how often its command failed in the run — never the command or any output.
  // The facts come from the signal the ledger counted, never from the bounded feed.
  private recordToolFailure(runId: string, entry: ProjectionEntry): void {
    const failure = takeUnloggedFailure(entry.toolFailures);
    if (failure === undefined) return;
    this.activityLog?.write(
      activityLogEvent(
        CODING_RUNTIME_TOOL_FAILED_OPERATION,
        { correlationId: correlationIdOrUnknown(runId) },
        {
          tool: toolLogClass(failure.tool),
          failureOrigin: failure.origin,
          exitCodeClass: exitCodeClass(failure.exitCode),
          commandFailureCount: failure.failureCount,
          failedCallCount: entry.toolFailures.failedCalls,
          repeatedFailureCount: entry.toolFailures.repeatedFailures,
        },
      ),
    );
  }

  // Body-free facts of the retained texts: one line the first time an answer or a reasoning outgrows
  // the feed, and one for every cut the memory bound makes. None carries any text.
  private recordTextFacts(runId: string, entry: ProjectionEntry, before: TextCounts): void {
    for (const part of TEXT_PARTS) {
      const { named, clipped } = entry.texts.counts[part];
      if (named > before[part].named) {
        this.writeTextFact(runId, `${part}-retained`, "feed-bound", named);
      }
      if (clipped > before[part].clipped) {
        this.writeTextFact(runId, `${part}-clipped`, "retention-bound", clipped);
      }
      const { sourceCut } = entry.texts.counts[part];
      if (sourceCut > before[part].sourceCut) {
        this.writeTextFact(runId, `${part}-clipped`, "source-bound", sourceCut);
      }
    }
  }

  private writeTextFact(
    runId: string,
    event: TextFactEvent,
    reason: "feed-bound" | "retention-bound" | "source-bound",
    occurrenceCount: number,
  ): void {
    this.activityLog?.write(
      activityLogEvent(
        CODING_RUNTIME_SAFE_ACTIVITY_OPERATION,
        {
          correlationId: correlationIdOrUnknown(runId),
          ...(event.endsWith("-clipped") ? { level: "warn" } : {}),
        },
        { event, reason, occurrenceCount },
      ),
    );
  }

  public answerText(runId: string, messageId: string): string | undefined {
    const entry = this.liveEntry(runId);
    if (entry?.feed.availability !== "available" || !entry.messageTurns.has(messageId)) {
      return undefined;
    }
    const text = retainedText(entry.texts, "answer", messageId)?.text;
    return text === undefined || text.length === 0 ? undefined : text;
  }

  public answerPage(
    runId: string,
    request: CodingSafeActivityTextPageRequest,
  ): CodingSafeActivityAnswerPage | null {
    const entry = this.liveEntry(runId);
    if (entry?.feed.availability !== "available" || !entry.messageTurns.has(request.messageId)) {
      return null;
    }
    return retainedTextPage(entry.texts, runId, request);
  }

  private finalizeCapacityDrop(
    runId: string,
    entry: ProjectionEntry,
    signal: CodingSafeActivitySignal,
    prior: PriorState & { readonly capacityDrop: DropCountChange | undefined },
  ): boolean {
    const finalized = this.finalizeIngest(runId, entry, signal, prior);
    const { capacityDrop } = prior;
    if (finalized && capacityDrop !== undefined) {
      this.emitDropMilestones(runId, "capacity-rejected", capacityDrop.previous, capacityDrop.next);
    }
    return finalized;
  }

  /**
   * Validates the feed after a signal has been applied and bounds enforced, and settles the
   * ingest() call: on success remembers the applied signal's identity and then notifies
   * subscribers, so a subscriber that delivers the same signal again synchronously sees it as
   * already applied; on failure, rolls back to the pre-mutation
   * snapshot when one was taken (capacity rejection), or purges the entry entirely when validate
   * rejected state that isFeedNearProjectionLimit believed was within limits (a bug signal for
   * that threshold, per KEIKO-0878).
   */
  private finalizeIngest(
    runId: string,
    entry: ProjectionEntry,
    signal: CodingSafeActivitySignal,
    prior: PriorState,
  ): boolean {
    if (validateCodingSafeActivityFeed(entry.feed).ok) {
      this.rememberAppliedSignal(entry, signal);
      this.notify();
      return true;
    }
    if (prior.feed !== undefined && prior.messageTurns !== undefined) {
      entry.feed = prior.feed;
      replaceMap(entry.messageTurns, prior.messageTurns);
      // The retained texts roll back with the feed, so the feed names exactly what they hold.
      if (prior.texts !== undefined) restoreRetainedTexts(entry.texts, prior.texts);
      return this.reject(runId, "capacity-rejected");
    }
    // KEIKO-0878: pre-mutation state was in the safe zone yet validate rejected -- indicates
    // a bug in isFeedNearProjectionLimit's threshold, not TTL/authority expiry. Purge so a caller
    // reading the feed after this cannot see the invalid state; the next signal will start from a
    // fresh entry. #2906 round 3: reason is the distinct "invariant-violation" code (never
    // "expiry", which this path is not) so the activity timeline can tell a genuine
    // validation/invariant bug apart from every other purge cause instead of collapsing them all.
    this.purgeCurrent("invariant-violation");
    return false;
  }

  public recordDrop(
    runId: string,
    reason: CodingSafeActivityDropReason,
    rejection?: ProjectionRejection,
  ): void {
    this.recordDrops(runId, reason, 1, rejection);
  }

  public recordDrops(
    runId: string,
    reason: CodingSafeActivityDropReason,
    count: number,
    rejection?: ProjectionRejection,
    refusal?: RefusedTransition,
  ): void {
    const entry = this.liveEntry(runId);
    if (entry?.feed.availability !== "available") return;
    const increment = boundedDropIncrement(count, this.maxDroppedEventCount);
    const previous = entry.feed.droppedEventCount;
    const next = Math.min(this.maxDroppedEventCount, previous + increment);
    if (next === previous) return;
    entry.feed = withDroppedCount(entry.feed, next, instant(this.now()));
    this.notify();
    this.emitDropMilestones(runId, reason, previous, next, rejection, refusal);
  }

  public purge(runId: string, reason: CodingSafeActivityPurgeReason): void {
    if (this.entry?.runId !== runId && this.subscriberRunId !== runId) return;
    this.purgeCurrent(reason);
  }

  /**
   * `correlationId` is the caller's operation (a server shutdown's). A purge with no run to tie it to
   * carries that id instead of the unknown fallback; a purged run keeps its own.
   */
  public purgeAll(reason: CodingSafeActivityPurgeReason, correlationId?: string): void {
    this.purgeCurrent(reason, correlationId);
  }

  public markUnavailable(runId: string): void {
    const dropped = this.entry?.runId === runId ? this.entry.feed.droppedEventCount : 0;
    const feed = {
      ...unavailableCodingSafeActivityFeed(runId, instant(this.now())),
      droppedEventCount: dropped,
    };
    this.entry = {
      runId,
      workspaceId: "unavailable",
      workspaceIsCurrent: (): boolean => true,
      expiresAtMs: this.now() + this.ttlMs,
      signalIds: new Set(),
      messageTurns: new Map(),
      texts: createRetainedTexts(0),
      toolFailures: createToolFailureLedger(),
      feed,
      interrupted: false,
    };
    if (this.subscribers.size > 0) this.subscriberRunId = runId;
    this.scheduleExpiry(this.entry);
    this.notify();
  }

  /**
   * A run's end (Stop, takeover or any other terminal state) ends the run the way OpenCode aborts a session: the feed and its
   * tool rows stay, and every call that had not settled is shown as cancelled. The calls the run
   * made remain readable after it ended (owner decision 2026-10-30, #3907).
   */
  public interrupt(runId: string, reason: "stop" | "takeover" | "run-ended"): void {
    const entry = this.liveEntry(runId);
    if (entry?.feed.availability !== "available") return;
    const occurredAt = instant(this.now());
    entry.interrupted = true;
    const cancelled = cancelOpenTools(entry.feed.turns, occurredAt);
    if (cancelled > 0) {
      entry.feed.updatedAt = occurredAt;
      // Each settled call gains its origin; the feed is brought back under its bounds, as after an
      // ingest, before any subscriber reads it.
      enforceFeedBounds(entry, this.limits);
      releaseUnlistedTexts(entry.texts, (messageId) => entry.messageTurns.has(messageId));
      this.notify();
    }
    this.activityLog?.write(
      activityLogEvent(
        CODING_RUNTIME_SAFE_ACTIVITY_OPERATION,
        { correlationId: correlationIdOrUnknown(runId) },
        { event: "interrupted", reason, occurrenceCount: cancelled },
      ),
    );
  }

  public currentContent(): CodingSafeActivityContent | null {
    const entry = this.liveEntry();
    if (entry === undefined || !validateCodingSafeActivityFeed(entry.feed).ok) return null;
    return { kind: "safe-activity", feed: cloneFeed(entry.feed) };
  }

  public subscribeContent(
    listener: (content: CodingSafeActivityContent | null) => void,
  ): CodingSafeActivitySubscription {
    if (this.subscribers.size >= this.maxSubscribers) {
      this.recordDrop(this.entry?.runId ?? "unavailable", "subscriber-rejected");
      return { admitted: false, detach: (): void => undefined };
    }
    this.subscribers.add(listener);
    if (this.entry !== undefined) this.subscriberRunId = this.entry.runId;
    return {
      admitted: true,
      detach: (): void => {
        this.subscribers.delete(listener);
        if (this.subscribers.size === 0) this.subscriberRunId = undefined;
      },
    };
  }

  private liveEntry(runId?: string): ProjectionEntry | undefined {
    const entry = this.entry;
    if (entry === undefined || (runId !== undefined && entry.runId !== runId)) return undefined;
    if (entry.feed.availability === "unavailable") return entry;
    if (this.now() >= entry.expiresAtMs) {
      this.expireCurrent();
      return undefined;
    }
    if (!safeWorkspaceCheck(entry.workspaceIsCurrent)) {
      this.purgeCurrent("workspace-switch");
      return undefined;
    }
    return entry;
  }

  private reject(
    runId: string,
    reason: CodingSafeActivityDropReason,
    rejection?: ProjectionRejection,
    refusal?: RefusedTransition,
  ): false {
    this.recordDrops(runId, reason, 1, rejection, refusal);
    return false;
  }

  private expireCurrent(): void {
    const subscribers = [...this.subscribers];
    this.clearCurrentEntry();
    this.notifySubscribers(subscribers, null);
  }

  private purgeCurrent(
    reason: CodingSafeActivityPurgeReason,
    operationCorrelationId?: string,
  ): void {
    const retained = this.entry !== undefined || this.subscribers.size > 0;
    const correlationId = correlationIdOrUnknown(
      this.entry?.runId ?? this.subscriberRunId ?? operationCorrelationId,
    );
    const notify = this.entry !== undefined;
    const subscribers = [...this.subscribers];
    this.clearCurrentEntry();
    this.subscribers.clear();
    this.subscriberRunId = undefined;
    if (notify) this.notifySubscribers(subscribers, null);
    if (retained) {
      if (reason === "invariant-violation") {
        emitPurgeDiagnostic(this.diagnostics, this.now, correlationId, reason);
      }
      this.activityLog?.write(
        activityLogEvent(
          CODING_RUNTIME_SAFE_ACTIVITY_OPERATION,
          {
            correlationId,
            ...(reason === "invariant-violation" ? { level: "error", errorKind: "internal" } : {}),
          },
          { event: "purged", reason },
        ),
      );
    }
  }

  private clearCurrentEntry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.entry = undefined;
  }

  private notify(): void {
    this.notifySubscribers([...this.subscribers], this.liveUpdateContent());
  }

  // A live update carries what every model text gained since the previous update, within what the
  // channel's snapshot budget leaves beside the feed; a reader reads anything left out as pages.
  private liveUpdateContent(): CodingSafeActivityContent | null {
    const content = this.currentContentWithoutExpiry();
    const entry = this.entry;
    if (content === null || entry === undefined) return content;
    const budget =
      CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES - SNAPSHOT_ENVELOPE_BYTES - bytes(content);
    const deltas = takeTextDeltas(entry.texts, (id) => entry.messageTurns.has(id), budget);
    return deltas.length === 0 ? content : { ...content, textDeltas: deltas };
  }

  private notifySubscribers(
    subscribers: readonly ((content: CodingSafeActivityContent | null) => void)[],
    content: CodingSafeActivityContent | null,
  ): void {
    for (const subscriber of subscribers) {
      try {
        subscriber(content);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
    if (this.subscribers.size === 0) this.subscriberRunId = undefined;
  }

  // A refused signal is a drop and a superseded one is set aside; either ends the ingest here.
  private endedApplication(
    runId: string,
    entry: ProjectionEntry,
    signal: CodingSafeActivitySignal,
    application: SignalApplication,
  ): boolean | undefined {
    const rejection = projectionRejection(application);
    if (rejection !== undefined) {
      const refusal =
        rejection === "tool-transition-refused" && signal.kind === "tool"
          ? refusedTransition(entry, signal)
          : undefined;
      return this.reject(runId, "projection-rejected", rejection, refusal);
    }
    return application === "restatement-superseded"
      ? this.supersede(runId, entry, signal)
      : undefined;
  }

  // A late update that restates an earlier state of a call Keiko already settled is set aside: it
  // changes neither the feed nor its timestamp and notifies no one. Its line names the call, as a
  // digest, and both states, so the log reconstructs every update (PR #3617 review).
  private supersede(runId: string, entry: ProjectionEntry, signal: CodingSafeActivitySignal): true {
    if (signal.signalId !== undefined) {
      rememberBoundedIdentity(entry.signalIds, signal.signalId, this.maxSignalIdentities);
    }
    this.supersededRestatementCount += 1;
    const restatement = signal.kind === "tool" ? supersededRestatement(entry, signal) : {};
    this.activityLog?.write(
      activityLogEvent(
        CODING_RUNTIME_SAFE_ACTIVITY_OPERATION,
        { correlationId: correlationIdOrUnknown(runId) },
        {
          event: "superseded",
          reason: "late-restatement",
          occurrenceCount: this.supersededRestatementCount,
          ...restatement,
        },
      ),
    );
    return true;
  }

  // OpenCode's rejection is a fact even when it arrives after Keiko settled the call another way, so
  // it is recorded for every application the projection did not refuse.
  private applyRecordingDenial(
    runId: string,
    entry: ProjectionEntry,
    signal: CodingSafeActivitySignal,
  ): SignalApplication {
    const denial = newNativeToolDenial(entry, signal);
    const application = applySignal(entry, signal, this.limits);
    if (projectionRejection(application) === undefined) this.recordNativeToolDenial(runId, denial);
    return application;
  }

  // Once per call: the first OpenCode update that reports the call rejected is recorded, also when
  // Keiko's own settlement already marked it denied; repeated part updates are not.
  private recordNativeToolDenial(runId: string, denial: NativeToolDenial | undefined): void {
    if (denial === undefined || this.recordedDenials.has(denial.callIdSha256)) return;
    rememberBoundedIdentity(this.recordedDenials, denial.callIdSha256, this.maxSignalIdentities);
    this.nativeToolDenialCount += 1;
    this.activityLog?.write(
      activityLogEvent(
        CODING_RUNTIME_NATIVE_TOOL_DENIED_OPERATION,
        { correlationId: correlationIdOrUnknown(runId) },
        {
          tool: denial.tool,
          occurrenceCount: this.nativeToolDenialCount,
          callIdSha256: denial.callIdSha256,
        },
      ),
    );
  }

  private emitDropMilestones(
    runId: string,
    reason: CodingSafeActivityDropReason,
    previous: number,
    next: number,
    rejection?: ProjectionRejection,
    refusal?: RefusedTransition,
  ): void {
    this.activityLog?.write(
      activityLogEvent(
        CODING_RUNTIME_SAFE_ACTIVITY_OPERATION,
        {
          correlationId: correlationIdOrUnknown(runId),
          ...(reason === "capacity-rejected"
            ? {}
            : { level: "warn", errorKind: "validation-failed" }),
        },
        {
          event: "dropped",
          reason,
          occurrenceCount: next,
          lossState: "event-dropped",
          ...(rejection === undefined ? {} : { rejection }),
          ...refusal,
        },
      ),
    );
    // A capacity drop is the feed's DESIGNED truncation: a long agent turn keeps its newest
    // messages within the contract bounds. The activity line above records it; an error-level
    // diagnostic for it read as a fault in every long run (F49, Coding Workbench run 24).
    if (reason === "capacity-rejected") return;
    // Fault drops keep their own count, so the feed's truncation neither delays nor inflates the
    // diagnostic of a real fault (F49). The count only grows, so each milestone is reported once,
    // even when a capacity drop is rolled back.
    const before = this.faultDropCount;
    this.faultDropCount += next - previous;
    for (let milestone = 1; milestone <= this.faultDropCount; milestone *= 2) {
      if (milestone <= before) continue;
      emitDropDiagnostic(this.diagnostics, this.now, runId, reason, milestone);
    }
  }

  private currentContentWithoutExpiry(): CodingSafeActivityContent | null {
    const feed = this.entry?.feed;
    return feed !== undefined && validateCodingSafeActivityFeed(feed).ok
      ? { kind: "safe-activity", feed: cloneFeed(feed) }
      : null;
  }

  private scheduleExpiry(entry: ProjectionEntry): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    const delay = Math.max(0, entry.expiresAtMs - this.now());
    this.expiryTimer = setTimeout(() => {
      if (this.entry === entry) this.expireCurrent();
    }, delay);
    this.expiryTimer.unref();
  }
}

export function createCodingSafeActivityProjection(
  options: CodingSafeActivityProjectionOptions = {},
): CodingSafeActivityProjection {
  return new SafeActivityProjection(options);
}

function resolvedLimits(input: CodingSafeActivityProjectionLimits = {}): ResolvedLimits {
  return {
    maxTurns: capped(input.maxTurns, CODING_SAFE_ACTIVITY_MAX_TURNS),
    maxMessagesPerTurn: capped(
      input.maxMessagesPerTurn,
      CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN,
    ),
    maxSegmentsPerMessage: capped(
      input.maxSegmentsPerMessage,
      CODING_SAFE_ACTIVITY_MAX_SEGMENTS_PER_MESSAGE,
    ),
    maxToolsPerTurn: capped(input.maxToolsPerTurn, CODING_SAFE_ACTIVITY_MAX_TOOLS_PER_TURN),
    maxMessageBytes: capped(input.maxMessageBytes, CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES),
    maxReasoningBytes: capped(
      input.maxReasoningBytes,
      CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES,
    ),
    maxTurnBytes: capped(input.maxTurnBytes, CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES),
    maxTotalBytes: capped(input.maxTotalBytes, CODING_SAFE_ACTIVITY_MAX_UTF8_BYTES),
    maxPlanSteps: capped(input.maxPlanSteps, CODING_SAFE_ACTIVITY_MAX_PLAN_STEPS),
    maxPlanStepChars: capped(input.maxPlanStepChars, CODING_SAFE_ACTIVITY_MAX_PLAN_STEP_TEXT_CHARS),
    maxPlanBytes: capped(input.maxPlanBytes, CODING_SAFE_ACTIVITY_MAX_PLAN_UTF8_BYTES),
    maxRetainedAnswerChars: capped(
      input.maxRetainedAnswerChars,
      CODING_SAFE_ACTIVITY_MAX_RETAINED_ANSWER_CHARS,
    ),
  };
}

function emptyFeed(runId: string, updatedAt: string): MutableFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId,
    updatedAt,
    turns: [],
    truncated: false,
    droppedEventCount: 0,
  };
}

function applySignal(
  entry: ProjectionEntry,
  signal: CodingSafeActivitySignal,
  limits: ResolvedLimits,
): SignalApplication {
  if (entry.feed.availability !== "available") return "feed-unavailable";
  if (signal.kind === "message") return applyMessage(entry, signal, limits);
  if (signal.kind === "text") return applyText(entry, signal, limits);
  if (signal.kind === "reasoning") return applyReasoning(entry, signal, limits);
  if (signal.kind === "text-cut") return applyTextCut(entry, signal);
  if (signal.kind === "plan") return applyPlan(entry, signal, limits);
  return applyTool(entry, signal, limits);
}

function applyMessage(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "message" }>,
  limits: ResolvedLimits,
): SignalApplication {
  if (entry.feed.availability !== "available") return "feed-unavailable";
  const knownTurn = entry.messageTurns.get(signal.messageId);
  if (knownTurn !== undefined) return "accepted";
  const turn = turnForMessage(entry, signal);
  if (turn === undefined) return "parent-message-unknown";
  let application: SignalApplication = "accepted";
  if (turn.messages.length >= limits.maxMessagesPerTurn) {
    turn.truncated = true;
    if (!evictOldestAssistantMessage(entry, turn)) return "capacity-dropped";
    application = "capacity-dropped";
  }
  turn.messages.push(newMessage(signal));
  entry.messageTurns.set(signal.messageId, turn.turnId);
  enforceTurnCount(entry, limits.maxTurns);
  return application;
}

function evictOldestAssistantMessage(entry: ProjectionEntry, turn: MutableTurn): boolean {
  const index = turn.messages.findIndex(({ role }) => role === "assistant");
  if (index < 0) return false;
  const removed = turn.messages.splice(index, 1)[0];
  if (removed !== undefined) entry.messageTurns.delete(removed.messageId);
  return true;
}

function turnForMessage(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "message" }>,
): MutableTurn | undefined {
  if (entry.feed.availability !== "available") return undefined;
  if (signal.role === "user") {
    const turn: MutableTurn = {
      turnId: signal.messageId,
      messages: [],
      tools: [],
      truncated: false,
    };
    entry.feed.turns.push(turn);
    return turn;
  }
  const parentTurnId =
    signal.parentMessageId === undefined
      ? undefined
      : entry.messageTurns.get(signal.parentMessageId);
  return parentTurnId === undefined
    ? undefined
    : entry.feed.turns.find(({ turnId }) => turnId === parentTurnId);
}

function newMessage(
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "message" }>,
): MutableMessage {
  return {
    messageId: signal.messageId,
    role: signal.role,
    ...(signal.origin === undefined ? {} : { origin: signal.origin }),
    occurredAt: signal.occurredAt,
    segments: [],
    truncated: false,
  };
}

function applyText(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "text" }>,
  limits: ResolvedLimits,
): SignalApplication {
  const located = locateMessage(entry, signal.messageId);
  if (located === undefined) return "message-unknown";
  const { message, turn } = located;
  const cleaned = stripUnsafeFormatChars(signal.text);
  if (message.role === "assistant") {
    applyAnswerText(entry, message, turn, cleaned, limits);
    return "accepted";
  }
  const close = (): void => {
    markMessageTruncated(message, turn);
  };
  let rest = cleaned;
  while (rest.length > 0 && !message.truncated) {
    rest = appendTextPiece(message, rest, limits, { lossless: false, close });
  }
  return "accepted";
}

// An assistant answer is retained whole beside the feed, and the feed carries as much of it as its
// bounds admit. A full feed message closes to the answer without a truncation mark — the answer is
// named instead and read page by page — and only the memory bound's cut marks it (owner decision).
function applyAnswerText(
  entry: ProjectionEntry,
  message: MutableMessage,
  turn: MutableTurn,
  text: string,
  limits: ResolvedLimits,
): void {
  const { retained, kept } = retainText(entry.texts, "answer", message.messageId, text);
  const close = (): void => {
    retained.feedClosed = true;
  };
  let rest = kept;
  while (rest.length > 0 && !retained.feedClosed) {
    rest = appendTextPiece(message, rest, limits, { lossless: true, close });
  }
  if (retained.truncated) markMessageTruncated(message, turn);
  syncFullAnswer(entry, message, retained);
}

// Names the answer on its feed message when the segments do not carry all of it.
function syncFullAnswer(
  entry: ProjectionEntry,
  message: MutableMessage,
  retained: RetainedText,
): void {
  const carried = message.segments.reduce((length, segment) => length + segment.text.length, 0);
  const { full, firstNamed } = fullTextFor(carried, retained);
  if (full === undefined) delete message.fullAnswer;
  else message.fullAnswer = full;
  if (firstNamed) entry.texts.counts.answer.named += 1;
}

// Names the reasoning on its feed message when `reasoning` does not carry all of it.
function syncFullReasoning(
  entry: ProjectionEntry,
  message: MutableMessage,
  retained: RetainedText,
): void {
  const { full, firstNamed } = fullTextFor(message.reasoning?.text.length ?? 0, retained);
  if (full === undefined) delete message.fullReasoning;
  else message.fullReasoning = full;
  if (firstNamed) entry.texts.counts.reasoning.named += 1;
}

/** How a full feed message ends: with a truncation mark, or closed to a retained answer. */
interface FeedCloseMode {
  readonly lossless: boolean;
  readonly close: () => void;
}

// Lab ledger F2 (#3873): a streamed answer reaches the projection as many small text signals, one
// per history pull, and each used to open a segment of its own, so a streamed answer hit the
// segment bound after its first 32 pulls and the rest of it was dropped. A signal now continues the
// message's last segment up to the segment's character bound and opens a new segment only beyond
// it. Places one segment's worth of `text` and returns what is left; once nothing more fits, `mode`
// closes the message (a truncation mark, or a retained answer the feed then names), which ends the
// caller's loop.
function appendTextPiece(
  message: MutableMessage,
  text: string,
  limits: ResolvedLimits,
  mode: FeedCloseMode,
): string {
  const last = message.segments.at(-1);
  const continuing = last !== undefined && continuesSegment(last, text);
  if (!continuing && message.segments.length >= limits.maxSegmentsPerMessage) {
    mode.close();
    return "";
  }
  const prefix = continuing ? last.text : "";
  const characters = boundedCharacters(
    text,
    CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS - prefix.length,
  );
  const fits = (candidate: string, truncated: boolean): boolean =>
    textCandidateBytes(message, continuing, prefix + candidate, truncated && !mode.lossless) <=
    limits.maxMessageBytes;
  const clipped = clipToBudget(characters, fits);
  if (clipped.text.length > 0) {
    const segment: CodingSafeActivityTextSegment = {
      kind: "text",
      text: prefix + clipped.text,
      truncated: clipped.truncated && !mode.lossless,
    };
    if (continuing) message.segments[message.segments.length - 1] = segment;
    else message.segments.push(segment);
  }
  if (clipped.truncated) {
    mode.close();
    return "";
  }
  return text.slice(characters.join("").length);
}

// A segment takes more text while it is whole and has room for at least the next code point.
function continuesSegment(segment: CodingSafeActivityTextSegment, text: string): boolean {
  const next = text.codePointAt(0) ?? 0;
  const nextLength = next > 0xff_ff ? 2 : 1;
  return (
    !segment.truncated &&
    segment.text.length + nextLength <= CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS
  );
}

function textCandidateBytes(
  message: MutableMessage,
  continuing: boolean,
  text: string,
  truncated: boolean,
): number {
  const segment: CodingSafeActivityTextSegment = { kind: "text", text, truncated };
  const segments = continuing
    ? [...message.segments.slice(0, -1), segment]
    : [...message.segments, segment];
  return bytes({ ...measuredMessage(message), segments, truncated });
}

// An assistant message is always measured as if it named its answer and its reasoning at the
// largest size, also once it names them: a named text keeps growing while the model streams, and
// its longer `fullAnswer` or `fullReasoning` must never push a fitting message over its byte bound.
function measuredMessage(message: MutableMessage): MutableMessage {
  return message.role === "assistant"
    ? { ...message, fullAnswer: FULL_TEXT_RESERVE, fullReasoning: FULL_TEXT_RESERVE }
    : message;
}

// The longest prefix of `characters` that `fits`; `truncated` once any of them was left out.
function clipToBudget(
  characters: readonly string[],
  fits: (candidate: string, truncated: boolean) => boolean,
): { readonly text: string; readonly truncated: boolean } {
  const whole = characters.join("");
  if (fits(whole, false)) return { text: whole, truncated: false };
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(characters.slice(0, middle).join(""), true)) low = middle;
    else high = middle - 1;
  }
  return { text: characters.slice(0, low).join(""), truncated: true };
}

function applyReasoning(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "reasoning" }>,
  limits: ResolvedLimits,
): SignalApplication {
  const located = locateMessage(entry, signal.messageId);
  if (located === undefined) return "message-unknown";
  const { message } = located;
  if (message.role !== "assistant") return "reasoning-role-invalid";
  const text = stripUnsafeFormatChars(signal.text);
  const { retained, kept } = retainText(entry.texts, "reasoning", message.messageId, text);
  if (!retained.feedClosed) appendReasoning(message, retained, kept, limits);
  if (retained.truncated && message.reasoning !== undefined) {
    message.reasoning = { text: message.reasoning.text, truncated: true };
  }
  syncFullReasoning(entry, message, retained);
  return "accepted";
}

// A text the source cut: what the projection holds is all there is, and the feed marks it cut. The
// source names only assistant parts; another role is refused like misplaced reasoning.
function applyTextCut(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "text-cut" }>,
): SignalApplication {
  const located = locateMessage(entry, signal.messageId);
  if (located === undefined) return "message-unknown";
  const { message, turn } = located;
  if (message.role !== "assistant") return "reasoning-role-invalid";
  const { retained } = retainText(entry.texts, signal.part, message.messageId, "");
  if (!markSourceCut(entry.texts, retained)) return "accepted";
  if (signal.part === "answer") {
    markMessageTruncated(message, turn);
    syncFullAnswer(entry, message, retained);
    return "accepted";
  }
  if (message.reasoning !== undefined) {
    message.reasoning = { text: message.reasoning.text, truncated: true };
  }
  syncFullReasoning(entry, message, retained);
  return "accepted";
}

// #3878: the model's reasoning grows with every streamed piece. The feed carries as much of it as
// its own bound (half the message budget, so the answer keeps room of its own) and the message
// budget admit; once full it closes to the reasoning the projection retains whole, which the feed
// then names (`fullReasoning`) — the reasoning is never cut to fit the feed (owner decision). What
// the feed carries is always a true prefix of what the model wrote.
function appendReasoning(
  message: MutableMessage,
  retained: RetainedText,
  text: string,
  limits: ResolvedLimits,
): void {
  const prefix = message.reasoning?.text ?? "";
  const clipped = clipToBudget(codePoints(text), (candidate) => {
    const reasoning = { text: prefix + candidate, truncated: false };
    return (
      bytes(reasoning.text) <= limits.maxReasoningBytes &&
      bytes({ ...measuredMessage(message), reasoning }) <= limits.maxMessageBytes
    );
  });
  if (clipped.truncated) retained.feedClosed = true;
  const reasoningText = prefix + clipped.text;
  if (reasoningText.length > 0) message.reasoning = { text: reasoningText, truncated: false };
}

interface NativeToolDenial {
  readonly tool: string;
  readonly callIdSha256: string;
}

function isOpenCodeDenial(
  signal: CodingSafeActivitySignal,
): signal is Extract<CodingSafeActivitySignal, { readonly kind: "tool" }> {
  return signal.kind === "tool" && signal.state === "denied" && signal.messageId !== undefined;
}

// An update from OpenCode itself (it names a message; Keiko's facade settlements do not) that
// settles a call as denied reports a permission rejection, whatever its origin.
function newNativeToolDenial(
  entry: ProjectionEntry,
  signal: CodingSafeActivitySignal,
): NativeToolDenial | undefined {
  if (!isOpenCodeDenial(signal)) return undefined;
  const existing = locateToolTurn(entry, signal)?.turn.tools.find(
    ({ callId }) => callId === signal.callId,
  );
  const tool = signal.tool ?? existing?.tool ?? "";
  return {
    tool: NATIVE_TOOL_DENIED_TOOL_SET.has(tool) ? tool : "other",
    callIdSha256: callIdDigest(signal.callId),
  };
}

function applyTool(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>,
  limits: ResolvedLimits,
): SignalApplication {
  const located = locateToolTurn(entry, signal);
  if (located === undefined) return "message-unknown";
  const existingIndex = located.turn.tools.findIndex(({ callId }) => callId === signal.callId);
  const existing = located.turn.tools[existingIndex];
  if (existing !== undefined) {
    if (staleOpenCodeRestatement(existing.state, signal)) return "restatement-superseded";
    if (!allowedToolTransition(existing.state, signal.state)) return "tool-transition-refused";
    const presentation = withFailureCount(
      entry.toolFailures,
      { callId: signal.callId, tool: existing.tool },
      settledPresentation(signal.state, existing.presentation, signal.presentation),
    );
    located.turn.tools[existingIndex] = {
      callId: existing.callId,
      tool: existing.tool,
      state: signal.state,
      occurredAt: signal.occurredAt,
      ...(presentation === undefined ? {} : { presentation }),
    };
    return "accepted";
  }
  if (signal.tool === undefined) return "tool-name-missing";
  if (opensAfterInterrupt(entry, signal)) return "tool-transition-refused";
  return insertTool(entry, located.turn, signal, signal.tool, limits);
}

/** A failed call's presentation names how often its command has failed in this run. */
function withFailureCount(
  ledger: ToolFailureLedger,
  call: { readonly callId: string; readonly tool: string },
  presentation: CodingSafeActivityToolPresentation | undefined,
): CodingSafeActivityToolPresentation | undefined {
  const failureCount = countFailedCall(ledger, call, {
    origin: presentation?.failureOrigin,
    exitCode: presentation?.exitCode,
    command: presentation?.command?.text,
  });
  if (presentation === undefined || failureCount === undefined) return presentation;
  return Object.freeze({ ...presentation, failureCount });
}

/**
 * A delayed tool signal that arrives after the run ended cannot add an open call to the retained
 * feed: the run ended, so nothing it shows may still look pending or running (#3907).
 */
function opensAfterInterrupt(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>,
): boolean {
  return entry.interrupted && (signal.state === "pending" || signal.state === "running");
}

function insertTool(
  entry: ProjectionEntry,
  turn: MutableTurn,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>,
  tool: string,
  limits: ResolvedLimits,
): SignalApplication {
  // Counted before the turn's bound decides, so a failed call the full turn drops still gets its
  // Activity Log line.
  const presentation = withFailureCount(
    entry.toolFailures,
    { callId: signal.callId, tool },
    settledPresentation(signal.state, undefined, signal.presentation),
  );
  const saturated = turn.tools.length >= limits.maxToolsPerTurn;
  if (saturated) {
    turn.truncated = true;
    if (!evictOldestSettledTool(turn)) return "capacity-dropped";
  }
  turn.tools.push({
    callId: signal.callId,
    tool,
    state: signal.state,
    occurredAt: signal.occurredAt,
    ...(presentation === undefined ? {} : { presentation }),
  });
  return saturated ? "capacity-dropped" : "accepted";
}

/**
 * A call's presentation after a state signal: what the newer signal says wins, and what only the
 * earlier one knew (a shell's command and output, the facade's refusal cause) stays. A call that did
 * not succeed always names where it failed; one that runs again or succeeds names no failure.
 */
function settledPresentation(
  state: CodingSafeActivityToolState,
  earlier: CodingSafeActivityToolPresentation | undefined,
  newer: CodingSafeActivityToolPresentation | undefined,
): CodingSafeActivityToolPresentation | undefined {
  const merged: CodingSafeActivityToolPresentation = { ...earlier, ...newer };
  const { failureOrigin, refusalCause, command, output, errorText, detailOmitted, ...facts } =
    merged;
  const origin = settledFailureOrigin(state, failureOrigin, facts);
  const presentation: CodingSafeActivityToolPresentation = {
    ...facts,
    ...(origin === undefined ? {} : { failureOrigin: origin }),
    ...(origin === undefined || refusalCause === undefined ? {} : { refusalCause }),
    ...(keepsOmission(detailOmitted, newer)
      ? { detailOmitted: true }
      : toolText(command, output, errorText)),
  };
  return Object.keys(presentation).length === 0 ? undefined : Object.freeze(presentation);
}

// A row whose detail the feed shed stays without it until an update supplies the detail again; the
// feed's byte budget then decides afresh whether it fits.
function keepsOmission(
  detailOmitted: boolean | undefined,
  newer: CodingSafeActivityToolPresentation | undefined,
): boolean {
  if (detailOmitted !== true) return false;
  if (newer?.detailOmitted === true) return true;
  return (
    newer?.command === undefined && newer?.output === undefined && newer?.errorText === undefined
  );
}

function settledFailureOrigin(
  state: CodingSafeActivityToolState,
  reported: CodingSafeActivityToolPresentation["failureOrigin"],
  facts: CodingSafeActivityToolPresentation,
): CodingSafeActivityToolPresentation["failureOrigin"] {
  const failed = state === "failed" || state === "denied" || state === "cancelled";
  if (!failed || hasOwnOutcome(facts)) return undefined;
  return reported ?? codingSafeActivityStateFailureOrigin(state, facts.exitCode);
}

// A verification or Git step reports its own closed outcome (a red check, a refused push, a check
// that never ran); its row speaks in that vocabulary, not in a failure origin.
function hasOwnOutcome(facts: CodingSafeActivityToolPresentation): boolean {
  return facts.verificationOutcome !== undefined || facts.gitOutcome !== undefined;
}

function toolText(
  command: CodingSafeActivityToolPresentation["command"],
  output: CodingSafeActivityToolPresentation["output"],
  errorText: CodingSafeActivityToolPresentation["errorText"],
): Pick<CodingSafeActivityToolPresentation, "command" | "output" | "errorText"> {
  return {
    ...(command === undefined ? {} : { command }),
    ...(output === undefined ? {} : { output }),
    ...(errorText === undefined ? {} : { errorText }),
  };
}

/** Settles every call still pending or running as cancelled; returns how many it settled. */
function cancelOpenTools(turns: readonly MutableTurn[], occurredAt: string): number {
  let cancelled = 0;
  for (const turn of turns) {
    turn.tools = turn.tools.map((tool) => {
      if (tool.state !== "pending" && tool.state !== "running") return tool;
      cancelled += 1;
      const presentation = settledPresentation("cancelled", tool.presentation, undefined);
      return {
        callId: tool.callId,
        tool: tool.tool,
        state: "cancelled",
        occurredAt,
        ...(presentation === undefined ? {} : { presentation }),
      };
    });
  }
  return cancelled;
}

/**
 * At the per-turn bound the newest call replaces the oldest settled one, as a full message list
 * replaces its oldest assistant message. Dropping the newest call instead froze everything derived
 * from the feed (the run phase, the Changes refresh signal) for the rest of a long turn. Each
 * displacement is a capacity drop, so the feed's bounded loss counter keeps advancing; a call that
 * has not settled is never displaced.
 */
function evictOldestSettledTool(turn: MutableTurn): boolean {
  const index = turn.tools.findIndex(({ state }) => state !== "pending" && state !== "running");
  if (index < 0) return false;
  turn.tools.splice(index, 1);
  return true;
}

/** Replaces the whole snapshot; the upstream plan tool always writes the full step list. */
function applyPlan(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "plan" }>,
  limits: ResolvedLimits,
): SignalApplication {
  if (entry.feed.availability !== "available") return "feed-unavailable";
  const plan: MutablePlan = {
    revision: Math.min(Number.MAX_SAFE_INTEGER, (entry.feed.plan?.revision ?? 0) + 1),
    anchorMessageId: signal.anchorMessageId,
    updatedAt: signal.occurredAt,
    steps: [],
    truncated: false,
  };
  for (const step of signal.steps) {
    if (plan.steps.length >= limits.maxPlanSteps) {
      plan.truncated = true;
      break;
    }
    const cleaned = stripUnsafeFormatChars(step.text);
    if (cleaned.length === 0) {
      plan.truncated = true;
      continue;
    }
    const text = boundedCharacters(cleaned, limits.maxPlanStepChars).join("");
    const truncated = text !== cleaned;
    if (truncated) plan.truncated = true;
    plan.steps.push({ text, state: step.state, truncated });
  }
  shrinkPlan(plan, limits.maxPlanBytes);
  entry.feed.plan = plan;
  return "accepted";
}

function shrinkPlan(plan: MutablePlan, maxBytes: number): void {
  while (bytes(plan) > maxBytes && plan.steps.length > 0) {
    plan.steps.pop();
    plan.truncated = true;
  }
}

type SettledToolState = "succeeded" | "failed" | "denied" | "cancelled";
type RestatedToolState = "pending" | "running" | "failed" | "succeeded" | "denied";
const RESTATED_TOOL_STATES: ReadonlySet<CodingSafeActivityToolState> = new Set<RestatedToolState>([
  "pending",
  "running",
  "failed",
  "succeeded",
  "denied",
]);

function isSettledToolState(state: CodingSafeActivityToolState): state is SettledToolState {
  return TERMINAL_TOOL_STATES.has(state);
}

function isRestatedToolState(state: CodingSafeActivityToolState): state is RestatedToolState {
  return RESTATED_TOOL_STATES.has(state);
}

function callIdDigest(callId: string): string {
  return createHash("sha256").update("keiko.safe-activity.call.v1\0").update(callId).digest("hex");
}

function supersededRestatement(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>,
): {
  readonly callIdSha256: string;
  readonly settledState?: SettledToolState;
  readonly restatedState?: RestatedToolState;
} {
  const settled = locateToolTurn(entry, signal)?.turn.tools.find(
    ({ callId }) => callId === signal.callId,
  )?.state;
  return {
    callIdSha256: callIdDigest(signal.callId),
    ...(settled !== undefined && isSettledToolState(settled) ? { settledState: settled } : {}),
    ...(isRestatedToolState(signal.state) ? { restatedState: signal.state } : {}),
  };
}

interface RefusedTransition {
  readonly callIdSha256: string;
  readonly refusedFromState: CodingSafeActivityToolState | "absent";
  readonly refusedToState: CodingSafeActivityToolState;
  readonly refusedSignalSource: "opencode" | "keiko";
}

// Read before the refused signal changes anything: a refusal leaves the feed as it was.
function refusedTransition(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>,
): RefusedTransition {
  const existing = locateToolTurn(entry, signal)?.turn.tools.find(
    ({ callId }) => callId === signal.callId,
  )?.state;
  return {
    callIdSha256: callIdDigest(signal.callId),
    refusedFromState: existing ?? "absent",
    refusedToState: signal.state,
    refusedSignalSource: signal.messageId === undefined ? "keiko" : "opencode",
  };
}

function locateToolTurn(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>,
): { readonly turn: MutableTurn } | undefined {
  const existing =
    entry.feed.availability === "available"
      ? entry.feed.turns.find(({ tools }) => tools.some(({ callId }) => callId === signal.callId))
      : undefined;
  if (existing !== undefined) return { turn: existing };
  if (signal.messageId === undefined) return undefined;
  const located = locateMessage(entry, signal.messageId);
  return located === undefined ? undefined : { turn: located.turn };
}

function locateMessage(
  entry: ProjectionEntry,
  messageId: string,
): { readonly message: MutableMessage; readonly turn: MutableTurn } | undefined {
  if (entry.feed.availability !== "available") return undefined;
  const turnId = entry.messageTurns.get(messageId);
  const turn = entry.feed.turns.find((candidate) => candidate.turnId === turnId);
  const message = turn?.messages.find((candidate) => candidate.messageId === messageId);
  return turn === undefined || message === undefined ? undefined : { turn, message };
}

// KEIKO-0878: cheap safe-zone check. Returns true when the pre-mutation entry is close enough to
// any projection limit that a single applySignal + enforceFeedBounds pass could still leave the
// feed above bounds when validate runs. If false, ingest() may skip the rollback snapshot
// entirely -- an inexpensive integer comparison replaces a per-signal structuredClone + Map copy.
// Threshold is 75%: a signal cannot double any of these counters, so 75% headroom keeps a
// generous safety margin against ANY single-signal growth pushing past the limit.
function isFeedNearProjectionLimit(entry: ProjectionEntry, limits: ResolvedLimits): boolean {
  if (entry.feed.availability !== "available") return true;
  const feed = entry.feed;
  const turnThreshold = Math.max(1, Math.floor(limits.maxTurns * 3) / 4);
  if (feed.turns.length >= turnThreshold) return true;
  for (const turn of feed.turns) {
    if (turn.messages.length >= Math.max(1, Math.floor(limits.maxMessagesPerTurn * 3) / 4)) {
      return true;
    }
    if (turn.tools.length >= Math.max(1, Math.floor(limits.maxToolsPerTurn * 3) / 4)) {
      return true;
    }
  }
  return false;
}

function enforceFeedBounds(entry: ProjectionEntry, limits: ResolvedLimits): void {
  if (entry.feed.availability !== "available") return;
  const feed = entry.feed;
  for (const turn of feed.turns) shrinkTurn(entry, turn, limits.maxTurnBytes);
  shedRetainedSegments(entry, feed.turns, () => bytes(feed) > limits.maxTotalBytes);
  shedToolDetail(feed.turns, () => bytes(feed) > limits.maxTotalBytes);
  shedSettledReasoning(entry, feed.turns, () => bytes(feed) > limits.maxTotalBytes);
  while (bytes(feed) > limits.maxTotalBytes && feed.turns.length > 0) {
    const removed = feed.turns.shift();
    if (removed !== undefined) releaseTurn(entry, removed);
    feed.truncated = true;
  }
}

// #3878: under byte pressure the model's reasoning yields first. The reasoning of every message but
// the newest one goes, oldest first, before any answer text, tool or turn is evicted; the newest
// message keeps the reasoning that may still be streaming.
// A reasoning the projection retains loses nothing: the feed then names it and its pages carry it.
function shedSettledReasoning(
  entry: ProjectionEntry,
  turns: readonly MutableTurn[],
  over: () => boolean,
): void {
  const newest = turns.at(-1)?.messages.at(-1);
  for (const turn of turns) {
    for (const message of turn.messages) {
      // Only a message with settled reasoning costs a size check, so a feed without reasoning
      // pays nothing for this pass.
      if (message === newest || message.reasoning === undefined) continue;
      if (!over()) return;
      delete message.reasoning;
      const retained = retainedText(entry.texts, "reasoning", message.messageId);
      if (retained === undefined || retained.text.length === 0) {
        turn.truncated = true;
        continue;
      }
      retained.feedClosed = true;
      syncFullReasoning(entry, message, retained);
    }
  }
}

// Under byte pressure a settled call's command, output and error text go before any message, tool
// or turn: oldest first, a call that succeeded before one that failed, so the failures a person has
// to read stay longest. The row says its detail left the live view (`detailOmitted`).
function shedToolDetail(turns: readonly MutableTurn[], over: () => boolean): void {
  for (const keepFailures of [true, false]) {
    for (const turn of turns) {
      for (let index = 0; index < turn.tools.length; index += 1) {
        if (!over()) return;
        const tool = turn.tools[index];
        if (tool !== undefined && sheddable(tool, keepFailures)) {
          turn.tools[index] = withoutToolDetail(tool);
        }
      }
    }
  }
}

function sheddable(tool: CodingSafeActivityTool, keepFailures: boolean): boolean {
  if (tool.state === "running" || !hasToolDetail(tool)) return false;
  return !keepFailures || tool.presentation?.failureOrigin === undefined;
}

function hasToolDetail(tool: CodingSafeActivityTool): boolean {
  const presentation = tool.presentation;
  return (
    presentation?.command !== undefined ||
    presentation?.output !== undefined ||
    presentation?.errorText !== undefined
  );
}

function withoutToolDetail(tool: CodingSafeActivityTool): CodingSafeActivityTool {
  const {
    command: _command,
    output: _output,
    errorText: _error,
    ...rest
  } = tool.presentation ?? {};
  return { ...tool, presentation: Object.freeze({ ...rest, detailOmitted: true as const }) };
}

// Under byte pressure an answer the projection retains gives up its feed text first, oldest first:
// that costs nothing, because the feed then names the answer and its pages carry it whole. Only then
// does anything that would be lost — reasoning, text, a tool or a turn — yield.
function shedRetainedSegments(
  entry: ProjectionEntry,
  turns: readonly MutableTurn[],
  over: () => boolean,
): void {
  for (const turn of turns) {
    for (const message of turn.messages) {
      const retained = retainedText(entry.texts, "answer", message.messageId);
      if (retained === undefined || retained.text.length === 0 || message.segments.length === 0) {
        continue;
      }
      if (!over()) return;
      shedAnswerSegments(entry, message, retained);
    }
  }
}

function shedAnswerSegments(
  entry: ProjectionEntry,
  message: MutableMessage,
  retained: RetainedText,
): void {
  message.segments = [];
  retained.feedClosed = true;
  syncFullAnswer(entry, message, retained);
}

// #4546: a turn over its byte bound sheds its oldest content, never its messages. The turn's user
// message is the parent every later answer names, and a message whose text was shed may still
// stream; a message without content costs a few bytes, and `maxMessagesPerTurn` bounds how many.
// Retained answer text, settled tool detail and settled reasoning go first: they lose nothing a
// page or the row's `detailOmitted` does not name.
function shrinkTurn(entry: ProjectionEntry, turn: MutableTurn, maxBytes: number): void {
  if (bytes(turn) <= maxBytes) return;
  shedRetainedSegments(entry, [turn], () => bytes(turn) > maxBytes);
  shedToolDetail([turn], () => bytes(turn) > maxBytes);
  shedSettledReasoning(entry, [turn], () => bytes(turn) > maxBytes);
  for (const message of turn.messages) {
    while (message.segments.length > 0 && bytes(turn) > maxBytes) {
      message.segments.shift();
      turn.truncated = true;
    }
  }
  while (bytes(turn) > maxBytes && turn.tools.length > 0) {
    turn.tools.shift();
    turn.truncated = true;
  }
}

function enforceTurnCount(entry: ProjectionEntry, maxTurns: number): void {
  if (entry.feed.availability !== "available") return;
  while (entry.feed.turns.length > maxTurns) {
    const removed = entry.feed.turns.shift();
    if (removed !== undefined) releaseTurn(entry, removed);
    entry.feed.truncated = true;
  }
}

function releaseTurn(entry: ProjectionEntry, turn: MutableTurn): void {
  for (const message of turn.messages) entry.messageTurns.delete(message.messageId);
}

function markMessageTruncated(message: MutableMessage, turn: MutableTurn): void {
  message.truncated = true;
  turn.truncated = true;
}

// Whole code points, so a clip never splits a surrogate pair.
function codePoints(value: string): readonly string[] {
  return boundedCharacters(value, value.length);
}

function boundedCharacters(value: string, maxChars: number): readonly string[] {
  const characters: string[] = [];
  let usedChars = 0;
  for (const character of value) {
    if (usedChars + character.length > maxChars) break;
    characters.push(character);
    usedChars += character.length;
  }
  return characters;
}

const TERMINAL_TOOL_STATES: ReadonlySet<CodingSafeActivityToolState> = new Set([
  "succeeded",
  "failed",
  "denied",
  "cancelled",
]);

// A late OpenCode part update identifies its message after the call has already ended. Keiko settles
// a call from the facade result, independently of OpenCode's part updates, and can do so before
// OpenCode's earlier pending or running update arrives over the event stream (a lab run of 1.1.8: a
// 10 ms read). The facade also returns HTTP 200 with a governed failed result for a red verification;
// OpenCode calls that transport success even though Keiko already settled the tool as failed. Keiko
// alone settles denied and cancelled calls, which OpenCode may likewise report as generic failure
// or completed, and a call Keiko stopped or failed may still arrive as OpenCode's own permission
// rejection (#4271). These restatements keep Keiko's verdict and produce evidence, not omitted
// updates. A settlement never restates pending or running, so one that tries is still a refused
// regression; a rejection after success is contradictory and is refused as well.
function staleOpenCodeRestatement(
  from: CodingSafeActivityToolState,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>,
): boolean {
  if (signal.messageId === undefined || !TERMINAL_TOOL_STATES.has(from)) return false;
  if (signal.state === "pending" || signal.state === "running") return true;
  return restatesKeikoSettlement(from, signal.state);
}

function restatesKeikoSettlement(
  from: CodingSafeActivityToolState,
  to: CodingSafeActivityToolState,
): boolean {
  if (from !== "denied" && from !== "cancelled" && from !== "failed") return false;
  // denied after denied is an ordinary idempotent repeat, not a restatement.
  if (to === "denied") return from !== "denied";
  return to === "failed" || to === "succeeded";
}

function allowedToolTransition(
  from: CodingSafeActivityToolState,
  to: CodingSafeActivityToolState,
): boolean {
  if (from === to) return true;
  if (from === "pending") return to !== "pending";
  if (from === "running") return !["pending", "running"].includes(to);
  return false;
}

function validSignal(signal: CodingSafeActivitySignal): boolean {
  if (!validSignalBase(signal)) return false;
  if (signal.kind === "message") return validMessageSignal(signal);
  if (signal.kind === "text" || signal.kind === "reasoning") return validTextSignal(signal);
  if (signal.kind === "text-cut") {
    return safeId(signal.messageId) && TEXT_PARTS.has(signal.part);
  }
  if (signal.kind === "plan") return validPlanSignal(signal);
  return validToolSignal(signal);
}

function validSignalBase(signal: CodingSafeActivitySignal): boolean {
  return (
    exactSignalKeys(signal) &&
    strictInstant(signal.occurredAt) &&
    (signal.signalId === undefined || safeId(signal.signalId))
  );
}

// An origin names a user message Keiko dispatched itself, by the contract's closed word.
function validMessageOrigin(
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "message" }>,
): boolean {
  if (signal.origin === undefined) return true;
  return (
    signal.role === "user" &&
    (CODING_SAFE_ACTIVITY_MESSAGE_ORIGINS as readonly string[]).includes(signal.origin)
  );
}

function validMessageSignal(
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "message" }>,
): boolean {
  return (
    safeId(signal.messageId) &&
    validMessageOrigin(signal) &&
    (signal.parentMessageId === undefined || safeId(signal.parentMessageId)) &&
    (signal.nativeRetry === undefined ||
      (signal.role === "assistant" && isCodingWorkbenchNativeRetry(signal.nativeRetry)))
  );
}

function validTextSignal(
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "text" | "reasoning" }>,
): boolean {
  return safeId(signal.messageId) && typeof signal.text === "string" && signal.text.length > 0;
}

function validToolSignal(
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>,
): boolean {
  return (
    (signal.messageId === undefined || safeId(signal.messageId)) &&
    safeId(signal.callId) &&
    (signal.tool === undefined || safeId(signal.tool)) &&
    (signal.presentation === undefined || isCodingSafeActivityToolPresentation(signal.presentation))
  );
}

function validPlanSignal(
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "plan" }>,
): boolean {
  return (
    safeId(signal.anchorMessageId) &&
    Array.isArray(signal.steps) &&
    signal.steps.every((step) => validPlanStepInput(step))
  );
}

function validPlanStepInput(step: unknown): boolean {
  if (typeof step !== "object" || step === null || Array.isArray(step)) return false;
  const candidate = step as Record<string, unknown>;
  return (
    Object.keys(candidate).every((key) => key === "text" || key === "state") &&
    typeof candidate.text === "string" &&
    candidate.text.length > 0 &&
    (CODING_SAFE_ACTIVITY_PLAN_STEP_STATES as readonly unknown[]).includes(candidate.state)
  );
}

function signalDropReason(
  signal: CodingSafeActivitySignal,
): CodingSafeActivityDropReason | undefined {
  if (!validSignal(signal)) return "validation-rejected";
  if (
    (signal.kind === "text" || signal.kind === "reasoning") &&
    stripUnsafeFormatChars(signal.text).length === 0
  ) {
    return "redactor-collapsed";
  }
  return signal.kind === "plan" && signal.steps.length > 0 && planCollapses(signal.steps)
    ? "redactor-collapsed"
    : undefined;
}

function planCollapses(steps: readonly CodingSafeActivityPlanStepInput[]): boolean {
  return steps.every((step) => stripUnsafeFormatChars(step.text).length === 0);
}

function validOpenInput(
  input: CodingSafeActivityOpenInput,
  expiresAtMs: number,
  now: number,
): boolean {
  return (
    safeId(input.runId) &&
    safeId(input.workspaceId) &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > now
  );
}

function strictInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

const COMMON_SIGNAL_KEYS = ["kind", "occurredAt", "signalId"] as const;

/** Extra keys admitted per signal kind; anything else makes the signal structurally invalid. */
const SIGNAL_KIND_KEYS: Readonly<Record<CodingSafeActivitySignal["kind"], readonly string[]>> = {
  message: ["messageId", "role", "origin", "parentMessageId", "nativeRetry"],
  text: ["messageId", "text"],
  reasoning: ["messageId", "text"],
  "text-cut": ["messageId", "part"],
  plan: ["anchorMessageId", "steps"],
  tool: ["messageId", "callId", "tool", "state", "presentation"],
};

function exactSignalKeys(signal: CodingSafeActivitySignal): boolean {
  const allowed = new Set<string>([...COMMON_SIGNAL_KEYS, ...SIGNAL_KIND_KEYS[signal.kind]]);
  return Object.keys(signal).every((key) => allowed.has(key));
}

function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function rememberBoundedIdentity(identities: Set<string>, identity: string, max: number): void {
  identities.delete(identity);
  identities.add(identity);
  while (identities.size > max) {
    const oldest = identities.values().next().value;
    if (oldest === undefined) return;
    identities.delete(oldest);
  }
}

function withDroppedCount(
  feed: StoredFeed,
  droppedEventCount: number,
  updatedAt: string,
): StoredFeed {
  return {
    ...feed,
    updatedAt,
    droppedEventCount,
  };
}

function incrementDroppedCount(
  entry: ProjectionEntry,
  maximum: number,
  updatedAt: string,
): DropCountChange | undefined {
  if (entry.feed.availability !== "available") return undefined;
  const previous = entry.feed.droppedEventCount;
  const next = Math.min(maximum, previous + 1);
  if (next === previous) return undefined;
  entry.feed = withDroppedCount(entry.feed, next, updatedAt);
  return { previous, next };
}

interface DropCountChange {
  readonly previous: number;
  readonly next: number;
}

function capacityDropForApplication(
  entry: ProjectionEntry,
  application: SignalApplication,
  maximum: number,
  updatedAt: string,
): DropCountChange | undefined {
  return application === "capacity-dropped"
    ? incrementDroppedCount(entry, maximum, updatedAt)
    : undefined;
}

// Issue #3245: the fault drop/purge reasons are small and genuinely closed, so each
// (reason -> fixed vocabulary member) pairing is enumerated directly rather than moved to
// `code` — `code` already carries the fixed generic event code here (CODING_SAFE_ACTIVITY_*), and
// the bounded count for a drop already has its own dedicated field (`occurrenceCount`), so nothing
// about the drop/purge is lost by keeping `message` a closed-vocabulary lookup instead of a
// template literal.
// A capacity drop is designed truncation and has no diagnostic (F49); every other drop reason is a
// fault an operator must see.
type FaultDropReason = Exclude<CodingSafeActivityDropReason, "capacity-rejected">;

const SAFE_ACTIVITY_DROP_SUMMARY: Readonly<Record<FaultDropReason, ServerDiagnosticSummary>> = {
  "validation-rejected": "safe-activity-dropped-validation-rejected",
  "redactor-collapsed": "safe-activity-dropped-redactor-collapsed",
  "projection-rejected": "safe-activity-dropped-projection-rejected",
  "subscriber-rejected": "safe-activity-dropped-subscriber-rejected",
};

// A routine purge (stop, takeover, shutdown, workspace switch) clears an in-memory UI projection
// and loses nothing, so, like a capacity drop, it has no diagnostic: its `purged` line on
// `coding-runtime.safe-activity` records it. Only an invariant violation is a fault. Reporting the
// routine reasons as an error-level `server.diagnostic.failure` made every server shutdown open a
// false support incident and pin evidence for it.
type FaultPurgeReason = Extract<CodingSafeActivityPurgeReason, "invariant-violation">;

const SAFE_ACTIVITY_PURGE_SUMMARY: Readonly<Record<FaultPurgeReason, ServerDiagnosticSummary>> = {
  "invariant-violation": "safe-activity-purged-invariant-violation",
};

function emitDropDiagnostic(
  sink: ServerDiagnosticSink | undefined,
  now: () => number,
  runId: string,
  reason: FaultDropReason,
  count: number,
): void {
  emitServerDiagnostic(sink, {
    correlationId: correlationIdOrUnknown(runId),
    timestamp: instant(now()),
    operation: "coding-runtime.safe-activity",
    source: "opencode.safe-activity",
    errorClass: "SafeActivityProjectionDrop",
    message: SAFE_ACTIVITY_DROP_SUMMARY[reason],
    code: "CODING_SAFE_ACTIVITY_EVENT_DROPPED",
    occurrenceCount: count,
  });
}

function emitPurgeDiagnostic(
  sink: ServerDiagnosticSink | undefined,
  now: () => number,
  correlationId: string,
  reason: FaultPurgeReason,
): void {
  emitServerDiagnostic(sink, {
    correlationId,
    timestamp: instant(now()),
    operation: "coding-runtime.safe-activity",
    source: "opencode.safe-activity",
    errorClass: "SafeActivityProjectionPurge",
    message: SAFE_ACTIVITY_PURGE_SUMMARY[reason],
    code: "CODING_SAFE_ACTIVITY_PURGED",
  });
}

function boundedDropIncrement(count: number, maximum: number): number {
  return Number.isSafeInteger(count) && count > 0 ? Math.min(count, maximum) : 0;
}

function cloneFeed(feed: CodingSafeActivityFeed): CodingSafeActivityFeed {
  const copy = structuredClone(feed);
  if (copy.availability === "available") {
    for (const turn of copy.turns) {
      for (const tool of turn.tools) {
        if (tool.presentation !== undefined) Object.freeze(tool.presentation);
      }
    }
  }
  return copy;
}

function safeWorkspaceCheck(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

function boundedCounterLimit(value: number | undefined): number {
  return capped(value, CODING_SAFE_ACTIVITY_MAX_DROPPED_EVENT_COUNT);
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function capped(value: number | undefined, cap: number): number {
  return Math.min(cap, positive(value, cap));
}

function instant(value: number): string {
  return new Date(value).toISOString();
}

function bytes(value: unknown): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(serialized, "utf8");
}
