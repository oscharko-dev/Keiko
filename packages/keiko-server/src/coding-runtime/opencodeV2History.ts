import type { CodingHistoryMessage } from "./codingRuntimeHistory.js";
import { createHash } from "node:crypto";

import type { VerificationKind } from "@oscharko-dev/keiko-contracts";
import { toolArgumentLimitsByToolName } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  isCodingWorkbenchNativeRetry,
  type CodingWorkbenchNativeRetry,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";

import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type { CodingSafeActivitySignal } from "./codingSafeActivityProjection.js";
import type {
  OpenCodeCompactionActivity,
  OpenCodeReconciliationEvent,
} from "./opencodeReconciler.js";
import {
  createOpenCodeV2LiveText,
  fittingUtf8Prefix,
  MAX_LIVE_REASONING_UTF8_BYTES,
  MAX_LIVE_TEXT_UTF8_BYTES,
  type LiveTextKind,
  type OpenCodeV2LiveText,
} from "./opencodeV2LiveText.js";
import {
  type OpenCodeToolProfile,
  openCodeVisibleToolNames,
  OPENCODE_MODEL_VISIBLE_TOOL_NAMES,
} from "./opencodeToolSchemas.js";
import {
  isAdmissibleOpenCodeToolName,
  isOpenCodeCodeModeExecutionFailure,
} from "./opencodeNativeTools.js";
import { openCodeNativeVerificationKind } from "./opencodeNativePolicy.js";
import { OPENCODE_PLAN_CARRIER_TOOLS } from "./opencodeProtocol.js";
import { openCodePlanCarrierSignal } from "./opencodeSafeActivity.js";
import { ConversationLedger } from "./opencodeV2HistoryConversation.js";

const HISTORY_TOOLS: ReadonlySet<string> = new Set(OPENCODE_MODEL_VISIBLE_TOOL_NAMES);

/** The native profile (#3897) reports OpenCode's own tool ids, bounded by shape, not by list. */
function historyToolAdmitted(name: string, profile: OpenCodeToolProfile): boolean {
  if (profile === "native") return isAdmissibleOpenCodeToolName(name);
  return HISTORY_TOOLS.has(name) || (profile === "code-mode" && name === "execute");
}
const NATIVE_RETRY_FIELDS: ReadonlySet<string> = new Set(["attempt", "at", "error"]);

const HISTORY_PROJECTION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.history-projection",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeV2History.project",
  fields: {
    eventCount: { type: "integer", dataClass: "count", required: true },
    signalCount: { type: "integer", dataClass: "count", required: true },
    emptyTextCount: { type: "integer", dataClass: "count", required: true },
    // #3878: how many of the signals carried model reasoning to the live timeline; a count only.
    // `required: false`: lines written before this field existed lack it.
    reasoningSignalCount: { type: "integer", dataClass: "count", required: false },
    nativeRetrySignalCount: { type: "integer", dataClass: "count", required: false },
    // #3873 review (PR #3876): the runtime event stream's events that did not cost a history read of
    // their own, because a read already queued or a later control hint's read covered them
    // (`coalescedSyncHints`), since the previous line. Each one is a read saved; when a run's timeline
    // lags or skips an update, this says how many events one read stood for. Absent when the composition
    // reports none (a projection built without the stream).
    mergedEventCount: { type: "integer", dataClass: "count", required: false },
    // #3873 review (PR #3876): OpenCode 2.0.10 persists a streamed text or reasoning part only empty
    // and complete, so the live timeline grows from the event stream's ephemeral deltas
    // (`opencodeV2LiveText.ts`). Counts since the previous line, never text: the deltas appended to a
    // live part; the deltas that extended nothing (the part was never seen starting, its stream was
    // interrupted since, or it is full); the parts whose complete text did not extend what the
    // timeline had already shown, which keeps the shown text. `required: false` because a line written
    // before these fields existed lacks them.
    liveDeltaCount: { type: "integer", dataClass: "count", required: false },
    liveDroppedCount: { type: "integer", dataClass: "count", required: false },
    liveDivergedCount: { type: "integer", dataClass: "count", required: false },
    // The idle messages of this pass that did not end the run's work because a subagent launched in
    // the background had not yet reported back (`backgroundChildren`); a count, absent when none.
    heldIdleCount: { type: "integer", dataClass: "count", required: false },
    // #4104: how the pass obtained the session's messages. `tail` read only the messages from the
    // last checkpoint's anchor on and carried the older ones over unchanged; `full` read the whole
    // window (the first pass, a catch-up after an event cap, a retry that holds an uncommitted page);
    // `verify` is the scheduled complete read that catches an edit older than the tail; `anchor-lost`
    // asked for a tail but the session no longer held the anchor (a revert or compaction), so it was
    // read whole. `readMessageCount` is the messages the pass handed to the projection and
    // `retainedMessageCount` the older ones it carried over without reading. Counts and a closed
    // word only; `required: false` because a line written before these fields existed lacks them.
    readMode: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["tail", "full", "verify", "anchor-lost"],
    },
    readMessageCount: { type: "integer", dataClass: "count", required: false },
    retainedMessageCount: { type: "integer", dataClass: "count", required: false },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-safe-activity-projection"],
  proofIds: ["coding-runtime.history-projection.emitted-line"],
  releaseImpact: "patch",
});

const NATIVE_QUESTION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.native-question.observed",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeV2History.recordNativeQuestions",
  fields: {
    callDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    failureReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["native-tool-error"],
    },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["pending", "running", "succeeded", "failed", "cancelled", "denied"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-safe-activity-projection"],
  proofIds: ["coding-runtime.native-question.observed.emitted-line"],
  releaseImpact: "patch",
});

interface HistoryActivity {
  readonly toolProfile?: OpenCodeToolProfile | undefined;
  readonly captureMessages?: ((messages: readonly CodingHistoryMessage[]) => boolean) | undefined;
  readonly runId: string;
  readonly activityLog: ServerLogSink | undefined;
  /**
   * The runtime events merged into earlier history reads since the previous projection line, which
   * resets (#3873 review). Absent for a projection that is not fed by the event stream.
   */
  readonly takeMergedEventCount?: (() => number) | undefined;
  /**
   * The text a user message is presented by when it is a slash command's (`opencodeCommands.ts`):
   * the runtime stores the command's expanded template as that message. `isNew` says the history had
   * not shown the message before this read. Absent presents every user message by its own text.
   */
  readonly userMessageDisplay?:
    ((messageId: string, isNew: boolean) => string | undefined) | undefined;
}

interface Candidate {
  readonly key: string;
  readonly digest: string;
  readonly kind: OpenCodeReconciliationEvent["kind"];
  readonly compaction?: OpenCodeCompactionActivity;
  readonly signal?: CodingSafeActivitySignal | undefined;
  readonly emptyText?: true;
  readonly nativeRetryState?: true;
  // An idle message that ended the session's execution but not the run's work (see `BackgroundChildren`).
  readonly heldIdle?: true;
  // A text part's own text as the runtime persisted it. Coding History is built from this, never from
  // the live text the timeline shows while the part streams: partial answers are not captured.
  readonly capturedText?: string;
}

interface PendingProjection {
  /** What the pass changed in the known candidates; adopted when its checkpoint is committed. */
  readonly knownUpdates: ReadonlyMap<string, KnownCandidate>;
  readonly events: readonly OpenCodeReconciliationEvent[];
  readonly signals: ReadonlyMap<string, CodingSafeActivitySignal>;
  readonly emptyTextCount: number;
  readonly nativeRetrySignalCount: number;
  readonly heldIdleCount: number;
  /** The pass stopped at the event cap, so candidates it did not reach are still to be emitted. */
  readonly capped: boolean;
  /** Where the next sync may start reading; absent when it must read the whole window. */
  readonly tail?: TailState | undefined;
  readonly sync?: OpenCodeV2SyncStats | undefined;
}

interface KnownCandidate {
  readonly digest: string;
  readonly textLength?: number;
}

/** How a settled sync read its window: an anchored tail, a lost anchor, or the planned full read. */
function settledReadMode(
  base: TailState | undefined,
  planned: OpenCodeV2ReadMode | undefined,
): OpenCodeV2ReadMode {
  if (base !== undefined) return "tail";
  if (planned === "tail") return "anchor-lost";
  return planned ?? "full";
}
export class OpenCodeV2HistoryError extends Error {
  constructor(readonly safeCode: string) {
    super("opencode-v2-history-invalid");
  }
}

// The exact top-level fields each message type may carry, from the upstream `Session.Message.*`
// schemas (`additionalProperties: false`). A type lists one field set per admitted runtime layout:
// a message is admitted when its fields fit one set completely, so the layouts never mix.
type FieldLayouts = readonly (readonly string[])[];

/** A table keyed by untrusted text answers for its own entries only, never `constructor`. */
function ownEntry<Value>(table: Readonly<Record<string, Value>>, key: string): Value | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

const ASSISTANT_FIELDS = [
  "id",
  "metadata",
  "time",
  "type",
  "agent",
  "model",
  "content",
  "snapshot",
  "finish",
  "rawFinish",
  "cost",
  "tokens",
  "error",
  "retry",
];

const COMPACTION_ENVELOPE_FIELDS = ["id", "metadata", "time", "type", "status", "reason"];

type CompactionLayout = "current" | "legacy";

// `Session.Message.Compaction.{Running,Completed,Failed}`, per runtime layout and status. The
// current layout is OpenCode 2.1.4: the provider replay state is `native` and no tail is reported.
// The legacy layout is the 2.0.10 npm runtime's: it carried the retained tail text (`recent`) and
// its provider state (`providerState`, `providerContext`). Summary, error and provider bodies are
// checked for shape only and never projected.
const COMPACTION_LAYOUT_FIELDS: Readonly<
  Record<CompactionLayout, Readonly<Record<string, readonly string[]>>>
> = {
  current: {
    running: [...COMPACTION_ENVELOPE_FIELDS, "summary"],
    completed: [...COMPACTION_ENVELOPE_FIELDS, "summary", "model", "native", "cost", "tokens"],
    failed: [...COMPACTION_ENVELOPE_FIELDS, "error", "cost", "tokens"],
  },
  legacy: {
    running: [...COMPACTION_ENVELOPE_FIELDS, "summary", "recent"],
    completed: [
      ...COMPACTION_ENVELOPE_FIELDS,
      "summary",
      "recent",
      "model",
      "providerState",
      "providerContext",
      "cost",
      "tokens",
    ],
    failed: [...COMPACTION_ENVELOPE_FIELDS, "error", "cost", "tokens"],
  },
};

const MESSAGE_FIELDS: Readonly<Record<string, FieldLayouts>> = {
  user: [["id", "metadata", "time", "text", "files", "agents", "skills", "type"]],
  assistant: [
    // OpenCode 2.1.4 renamed the provider replay state of a message to `native`.
    [...ASSISTANT_FIELDS, "native"],
    [...ASSISTANT_FIELDS, "providerState"],
  ],
  idle: [["id", "metadata", "time", "type", "outcome", "error"]],
  system: [["id", "metadata", "time", "type", "text", "description"]],
  synthetic: [["id", "metadata", "time", "type", "text", "description"]],
  shell: [["id", "metadata", "time", "type", "shellID", "command", "status", "exit", "output"]],
  skill: [["id", "metadata", "time", "type", "skill", "name", "text"]],
  "agent-switched": [["id", "metadata", "time", "type", "agent", "previous"]],
  "model-switched": [["id", "metadata", "time", "type", "model", "previous"]],
  "location-switched": [
    ["id", "metadata", "time", "type", "projectID", "subpath", "location", "previous"],
  ],
  // The union of every layout and status: the per-status layouts are enforced where the message is
  // decoded (`compactionLayout`), so an unknown field is named here before any layout is chosen.
  compaction: [
    [
      ...new Set(
        Object.values(COMPACTION_LAYOUT_FIELDS).flatMap((statuses) =>
          Object.values(statuses).flat(),
        ),
      ),
    ],
  ],
};

const STRUCTURED_ERROR_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "message",
  "status",
  "response",
  "retryAfterMs",
]);

/**
 * OpenCode 2.1.4 ends a failed turn with an idle message carrying `Session.StructuredError`
 * (`type`, `message`, optional HTTP `status`, `response.body`, `retryAfterMs`); 2.0.10 had no such
 * field. The shape is checked strictly, and nothing of it is projected: the terminal failure stays
 * body-free (#3897 review).
 */
function assertIdleErrorShape(value: unknown): void {
  if (value !== undefined && !isStructuredError(value))
    throw new OpenCodeV2HistoryError("reason=event-unknown:role=idle:error-shape=unsupported");
}

/**
 * `Session.StructuredError`, the one error shape every 2.1.4 message uses (a failed compaction
 * carries it as well as an idle message). 2.0.10's error was the `type`, `message` and `status`
 * subset of it, so one check serves both layouts.
 */
function isStructuredError(value: unknown): boolean {
  const error = record(value);
  return (
    error !== undefined &&
    hasStructuredErrorIdentity(error) &&
    hasStructuredErrorResponse(error.response)
  );
}

function hasStructuredErrorIdentity(error: Readonly<Record<string, unknown>>): boolean {
  return (
    Object.keys(error).every((key) => STRUCTURED_ERROR_FIELDS.has(key)) &&
    typeof error.type === "string" &&
    typeof error.message === "string" &&
    (error.status === undefined || isHttpStatus(error.status)) &&
    (error.retryAfterMs === undefined || isNonNegativeInteger(error.retryAfterMs))
  );
}

function hasStructuredErrorResponse(value: unknown): boolean {
  if (value === undefined) return true;
  const response = record(value);
  return (
    response !== undefined &&
    typeof response.body === "string" &&
    Object.keys(response).every((key) => key === "body")
  );
}

function isHttpStatus(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599;
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

export interface OpenCodeV2ProjectionReuse {
  readonly reusedMessageCount: number;
  readonly projectedMessageCount: number;
}

export interface OpenCodeV2HistoryProjectionOptions {
  /** Defaults to true. Off rebuilds every message each call, the reference the reuse is proven against. */
  readonly reuseMessages?: boolean | undefined;
  /**
   * Defaults to true. Off plans every read as a complete one and projects the whole window each call,
   * the reference the tail reads are proven against (#4104).
   */
  readonly incremental?: boolean | undefined;
  /**
   * How many of the newest messages a tail read re-reads and re-projects, because the runtime
   * persists a streamed part empty and then completes it in place. Defaults to 32.
   */
  readonly tailMargin?: number | undefined;
  /**
   * After this many tail reads the next read is a complete one, which catches an edit to a message
   * older than the tail. Defaults to 256.
   */
  readonly verifyEvery?: number | undefined;
}

const DEFAULT_TAIL_MARGIN = 32;
const DEFAULT_VERIFY_EVERY = 256;
// The most events one pass returns; a pass that reaches it leaves candidates for the next.
const PASS_EVENT_CAP = 256;

/** How a pass obtained its messages (#4104); the projection line records it. */
export type OpenCodeV2ReadMode = "tail" | "full" | "verify" | "anchor-lost";

/** What the next history read should ask the runtime for. */
export interface OpenCodeV2ReadPlan {
  /**
   * The id of a message the projection already holds. The read may end there and hand the messages
   * from it on. Absent when the whole window must be read.
   */
  readonly anchorId: string | undefined;
}

/** How the last `project` call obtained and spent its messages. Counts and a closed word only. */
export interface OpenCodeV2SyncStats {
  readonly readMode: OpenCodeV2ReadMode;
  /** The messages the call handed to the projection. */
  readonly readMessageCount: number;
  /** The older messages the call carried over from earlier calls without reading them. */
  readonly retainedMessageCount: number;
}

/** What the messages of one `project` call are: the whole session, or only its newest window. */
export interface OpenCodeV2HistoryWindow {
  /**
   * Older messages exist and were not read. They produce no candidates and so no events, and the
   * conversation Coding History captured earlier is kept rather than replaced by the window.
   */
  readonly truncated?: boolean | undefined;
  /**
   * The messages begin at the anchor the last `readPlan` named, and the older ones are unchanged
   * since the previous call (#4104). The projection then works on these messages alone and carries
   * everything before them over. A window that does not begin at that anchor is refused.
   */
  readonly anchored?: boolean | undefined;
}

export interface OpenCodeV2HistoryProjection {
  project(
    sessionId: string,
    messages: readonly Readonly<Record<string, unknown>>[],
    checkpoint: number | undefined,
    window?: OpenCodeV2HistoryWindow,
  ): readonly OpenCodeReconciliationEvent[];
  takeSignal(event: OpenCodeReconciliationEvent): CodingSafeActivitySignal | undefined;
  clearSignals(): void;
  /**
   * How the last `project` call spent its work: settled assistant messages reused from the previous
   * call, and those projected again. Counts only, for the projection line and its proofs.
   */
  lastReuse(): OpenCodeV2ProjectionReuse;
  /**
   * Where the next read should start (#4104). Every read before a `project` call asks for it, with
   * the checkpoint it will pass: the plan names an anchor only when the earlier calls are fully
   * committed and caught up, so the messages before it cannot hold anything still to be emitted.
   */
  readPlan(checkpoint: number | undefined): OpenCodeV2ReadPlan;
  /** How the last `project` call obtained its messages and how many it handed and carried over. */
  lastSync(): OpenCodeV2SyncStats;
  /**
   * Notes one event of the runtime's event stream. A streamed part is persisted only empty and
   * complete, so the text and reasoning deltas the stream carries are what the next `project` shows
   * of a part that is still streaming (`opencodeV2LiveText.ts`). Everything else is ignored.
   */
  observeLiveEvent(sessionId: string, event: Readonly<Record<string, unknown>>): void;
  /**
   * The event stream was interrupted: the parts it was feeding missed events, so none is extended
   * again, and each shows what it has until the history shows it complete.
   */
  freezeLiveText(): void;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

// The fields no admitted layout allows: none when the message fits one layout completely, otherwise
// those of the closest layout (the first on a tie), which is what the safe code counts and digests.
function unknownFields(
  message: Readonly<Record<string, unknown>>,
  layouts: FieldLayouts,
): readonly string[] {
  let closest: readonly string[] | undefined;
  for (const allowed of layouts) {
    const extra = Object.keys(message).filter((key) => !allowed.includes(key));
    if (closest === undefined || extra.length < closest.length) closest = extra;
    if (extra.length === 0) break;
  }
  return closest ?? [];
}

function assertMessageShape(message: Readonly<Record<string, unknown>>): void {
  const role = message.type;
  if (typeof role !== "string")
    throw new OpenCodeV2HistoryError("reason=event-unknown:type=unsupported");
  const layouts = ownEntry(MESSAGE_FIELDS, role);
  if (layouts === undefined)
    throw new OpenCodeV2HistoryError("reason=event-unknown:type=unsupported");
  const extra = unknownFields(message, layouts);
  if (extra.length === 0) {
    if (role === "idle") assertIdleErrorShape(message.error);
    return;
  }
  throw new OpenCodeV2HistoryError(
    `reason=event-unknown:eventSha256=${digest(message).slice(0, 16)}:role=${role}:extraCount=${String(extra.length)}:extraKeySha256=${digest(
      extra.slice().sort((left, right) => {
        if (left === right) return 0;
        return left < right ? -1 : 1;
      }),
    ).slice(0, 16)}`,
  );
}

function assertToolInput(
  part: Readonly<Record<string, unknown>>,
  state: Readonly<Record<string, unknown>>,
): void {
  const input = state.input;
  const valid =
    state.status === "streaming" ? typeof input === "string" : record(input) !== undefined;
  const inputBytes = valid ? Buffer.byteLength(JSON.stringify(input), "utf8") : 0;
  // A changeset edit carries file content up to the changeset cap; every other tool keeps the
  // generic catalog argument bound.
  const limits = toolArgumentLimitsByToolName(typeof part.name === "string" ? part.name : "");
  if (valid && inputBytes <= limits.maxArgumentBytes) return;
  throw new OpenCodeV2HistoryError(
    `reason=argument-bound:eventSha256=${digest(part).slice(0, 16)}:toolSha256=${digest(part.name).slice(0, 16)}:statusSha256=${digest(state.status ?? null).slice(0, 16)}:partBytes=${String(Buffer.byteLength(JSON.stringify(part), "utf8"))}`,
  );
}

function eventTime(message: Readonly<Record<string, unknown>>): string {
  const created = record(message.time)?.created;
  if (typeof created !== "number" || !Number.isSafeInteger(created) || created < 0) {
    throw new Error("opencode-v2-message-time-invalid");
  }
  return new Date(created).toISOString();
}

function messageId(message: Readonly<Record<string, unknown>>): string {
  const value = message.id;
  if (typeof value !== "string" || !/^msg_[A-Za-z0-9_-]{1,251}$/u.test(value)) {
    throw new Error("opencode-v2-message-id-invalid");
  }
  return value;
}

function candidate(
  key: string,
  kind: Candidate["kind"],
  data: unknown,
  signal?: CodingSafeActivitySignal,
): Candidate {
  return { key, kind, digest: digest([key, data]), ...(signal === undefined ? {} : { signal }) };
}

// `text` is what the timeline shows; `capturedText` is the part's persisted text (the same, unless
// the part is still streaming and the history shows it empty).
function textCandidate(
  id: string,
  index: number,
  text: string,
  occurredAt: string,
  capturedText: string = text,
): Candidate {
  if (Buffer.byteLength(text, "utf8") > MAX_LIVE_TEXT_UTF8_BYTES)
    throw new Error("opencode-v2-text-oversized");
  const key = `${id}:text:${String(index)}`;
  // V2 starts streaming with an empty part. Reconcile its identity, but publish no empty text.
  if (text.length === 0) {
    return { ...candidate(key, "observation", text), emptyText: true, capturedText };
  }
  return {
    ...candidate(key, "observation", text, {
      kind: "text",
      messageId: id,
      text,
      occurredAt,
    }),
    capturedText,
  };
}

// A part is read up to a bound and no further, cut at a whole character, so a long part neither
// fails the history read nor costs a digest of its whole text on every pull. The prefix grows with the
// part until the bound and then stays fixed, and it is the very prefix the live overlay keeps
// (`opencodeV2LiveText.ts`). #3878: the live timeline shows at most
// CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES of a message's reasoning, so a reasoning part is
// read up to twice that (`MAX_LIVE_REASONING_UTF8_BYTES`). An answer part is read up to the part
// bound (`MAX_LIVE_TEXT_UTF8_BYTES`), which the history of the answer used to refuse outright.
function boundedPartText(text: string, maxBytes: number): string {
  return Buffer.byteLength(text, "utf8") <= maxBytes ? text : fittingUtf8Prefix(text, maxBytes);
}

// OpenCode records the model's reasoning (`reasoning_content`) as a `reasoning` content part. It
// grows by suffix like text and is projected into its own live signal; Coding History never
// captures it (conversationMessages keeps text only). An empty part reconciles its identity only.
function reasoningCandidate(
  id: string,
  index: number,
  text: string,
  occurredAt: string,
): Candidate {
  const key = `${id}:reasoning:${String(index)}`;
  const shown = boundedPartText(text, MAX_LIVE_REASONING_UTF8_BYTES);
  if (shown.length === 0) return candidate(key, "observation", shown);
  return candidate(key, "observation", shown, {
    kind: "reasoning",
    messageId: id,
    text: shown,
    occurredAt,
  });
}

function visibleUserText(message: Readonly<Record<string, unknown>>): string {
  const text = message.text;
  if (typeof text !== "string") throw new OpenCodeV2HistoryError("reason=user-text-invalid");
  const display = record(record(message.metadata)?.keikoContextPresentationV1);
  if (display === undefined) return text;
  const visible = display.displayText;
  const expected = display.hiddenContextSha256;
  if (typeof visible !== "string" || typeof expected !== "string")
    throw new OpenCodeV2HistoryError("reason=context-display-invalid");
  const separator = `\n\n${visible}`;
  const context = text.slice(0, -separator.length);
  if (!text.endsWith(separator) || createHash("sha256").update(context).digest("hex") !== expected)
    throw new OpenCodeV2HistoryError("reason=context-display-mismatch");
  return visible;
}

function toolIdentity(part: Readonly<Record<string, unknown>>): { id: string; name: string } {
  const id = part.id;
  const name = part.name;
  if (typeof id !== "string" || typeof name !== "string") {
    throw new TypeError("opencode-v2-tool-invalid");
  }
  return { id, name };
}

function toolOccurredAt(part: Readonly<Record<string, unknown>>): string {
  const created = record(part.time)?.created;
  if (typeof created !== "number" || !Number.isSafeInteger(created) || created < 0) {
    throw new Error("opencode-v2-tool-time-invalid");
  }
  return new Date(created).toISOString();
}

function toolState(
  part: Readonly<Record<string, unknown>>,
  messageId: string,
  profile: OpenCodeToolProfile,
): CodingSafeActivitySignal & { kind: "tool" } {
  const state = record(part.state);
  if (state === undefined) throw new Error("opencode-v2-tool-state-invalid");
  const { id, name } = toolIdentity(part);
  assertToolInput(part, state);
  if (!historyToolAdmitted(name, profile)) throw new Error("opencode-v2-tool-invalid");
  const exit = name === "shell" ? shellExitEvidence(state) : {};
  // The runtime completes a shell call whatever its command returned (`metadata.exit`); a command
  // that exited non-zero failed, which the timeline and the run's evidence both say (#3901).
  const mapped =
    exit.exitCode !== undefined && exit.exitCode !== 0 ? "failed" : displayToolState(name, state);
  return {
    kind: "tool",
    messageId,
    callId: id,
    tool: name,
    state: mapped,
    occurredAt: toolOccurredAt(part),
    ...exit,
  };
}

/** A finished shell call's exit status, the check it speaks for, and whether it chose its directory. */
function shellExitEvidence(state: Readonly<Record<string, unknown>>): {
  readonly exitCode?: number;
  readonly exitStatusCheck?: VerificationKind;
  readonly ownWorkdir?: true;
} {
  const exitCode = shellExitCode(state);
  if (exitCode === undefined) return {};
  const exitStatusCheck = shellLineCheck(state);
  if (exitStatusCheck === undefined) return { exitCode };
  return shellOwnWorkdir(state)
    ? { exitCode, exitStatusCheck, ownWorkdir: true }
    : { exitCode, exitStatusCheck };
}

/**
 * The project check a finished shell call's exit status speaks for (#3897 review). The permission
 * check sees the line split into its commands, without the operators between them; the finished
 * part still holds the whole line, so only it can show that no later command decided the status.
 */
function shellLineCheck(state: Readonly<Record<string, unknown>>): VerificationKind | undefined {
  const command = record(state.input)?.command;
  return typeof command === "string" ? openCodeNativeVerificationKind([command]) : undefined;
}

/**
 * Whether a shell call named its own working directory (`workdir`). The runtime treats an empty one
 * and `.` as the session's directory; anything else, even the same path spelled out, ran from a
 * directory whose package.json the admission did not read.
 */
function shellOwnWorkdir(state: Readonly<Record<string, unknown>>): boolean {
  const workdir = record(state.input)?.workdir;
  if (workdir === undefined || workdir === null) return false;
  if (typeof workdir !== "string") return true;
  const trimmed = workdir.trim();
  return trimmed.length > 0 && trimmed !== ".";
}

/** A completed shell call's own exit status; a job moved to the background reports none. */
function shellExitCode(state: Readonly<Record<string, unknown>>): number | undefined {
  if (state.status !== "completed") return undefined;
  const exit = record(state.metadata)?.exit;
  return typeof exit === "number" && Number.isInteger(exit) ? exit : undefined;
}

// A completed part is a succeeded tool, except a Code Mode `execute` whose program failed: the
// producer returns that as a completed part carrying its own `metadata.error` flag (#3897).
function displayToolState(
  name: string,
  state: Readonly<Record<string, unknown>>,
): "pending" | "running" | "succeeded" | "failed" {
  const status = state.status;
  if (status === "streaming") return "pending";
  if (status === "completed")
    return isOpenCodeCodeModeExecutionFailure(name, state) ? "failed" : "succeeded";
  if (status === "error") return "failed";
  if (status === "running") return "running";
  throw new Error("opencode-v2-tool-state-invalid");
}

function assistantCandidates(
  message: Readonly<Record<string, unknown>>,
  parentMessageId: string,
  live: OpenCodeV2LiveText,
  toolProfile: OpenCodeToolProfile,
): readonly Candidate[] {
  const id = messageId(message);
  const occurredAt = eventTime(message);
  const result: Candidate[] = [
    candidate(`${id}:message`, "observation", id, {
      kind: "message",
      role: "assistant",
      messageId: id,
      parentMessageId,
      occurredAt,
    }),
  ];
  if (!Array.isArray(message.content)) throw new Error("opencode-v2-content-invalid");
  // The runtime numbers the text blocks, and apart from them the reasoning blocks, of one assistant
  // message from zero in the order they start: the ordinal of a delta is the part's position among
  // the same-kind parts of the message.
  const ordinals: PartOrdinals = { text: 0, reasoning: 0 };
  for (const [index, value] of message.content.entries()) {
    result.push(
      ...assistantPartCandidates(value, id, index, occurredAt, { live, ordinals, toolProfile }),
    );
  }
  return result;
}

function nativeRetryFacts(value: unknown): CodingWorkbenchNativeRetry | undefined {
  if (value === undefined) return undefined;
  const retry = record(value);
  if (retry === undefined || Object.keys(retry).some((key) => !NATIVE_RETRY_FIELDS.has(key))) {
    throw new OpenCodeV2HistoryError("reason=native-retry-shape-invalid");
  }
  const at = retry.at;
  if (
    typeof at !== "number" ||
    !Number.isSafeInteger(at) ||
    at < 0 ||
    at > 253_402_300_799_999 ||
    record(retry.error) === undefined
  ) {
    throw new OpenCodeV2HistoryError("reason=native-retry-shape-invalid");
  }
  const facts = { attempt: retry.attempt, scheduledAt: new Date(at).toISOString() };
  if (!isCodingWorkbenchNativeRetry(facts)) {
    throw new OpenCodeV2HistoryError("reason=native-retry-shape-invalid");
  }
  return facts;
}

function nativeRetryCandidate(
  message: Readonly<Record<string, unknown>>,
  id: string,
  parentMessageId: string,
  occurredAt: string,
): Candidate {
  const nativeRetry = nativeRetryFacts(message.retry);
  return {
    ...candidate(`${id}:retry`, "observation", nativeRetry ?? null, {
      kind: "message",
      role: "assistant",
      messageId: id,
      parentMessageId,
      occurredAt,
      ...(nativeRetry === undefined ? {} : { nativeRetry }),
    }),
    nativeRetryState: true,
  };
}

interface PartOrdinals {
  text: number;
  reasoning: number;
}

interface LivePartContext {
  readonly toolProfile: OpenCodeToolProfile;
  readonly live: OpenCodeV2LiveText;
  readonly ordinals: PartOrdinals;
}

// The text a part shows. The history shows a streamed part empty until it ends, so while it streams
// the timeline shows the text the runtime's event stream delivered (`opencodeV2LiveText.ts`); once
// the history shows the part complete, its own text, which extends what was shown, takes over and
// the live text is spent, so nothing is appended twice. The shown text never shrinks and is always a
// prefix of the next one: a complete text that does not extend what was already shown keeps the
// shown text (counted), because the timeline cannot take words back.
function shownPartText(
  context: LivePartContext,
  messageId: string,
  kind: LiveTextKind,
  durable: string,
): string {
  const ordinal = context.ordinals[kind];
  context.ordinals[kind] += 1;
  const liveText = context.live.textOf(messageId, kind, ordinal);
  if (liveText === undefined || liveText.length === 0) return durable;
  if (durable.length === 0) return liveText;
  if (durable.startsWith(liveText)) {
    context.live.retire(messageId, kind, ordinal);
    return durable;
  }
  if (!liveText.startsWith(durable)) context.live.markDiverged(messageId, kind, ordinal);
  return liveText;
}

function assistantPartCandidates(
  value: unknown,
  messageId: string,
  index: number,
  occurredAt: string,
  context: LivePartContext,
): readonly Candidate[] {
  const part = record(value);
  if (part?.type === "text" && typeof part.text === "string") {
    // The timeline shows an answer up to the part bound; Coding History keeps the part whole.
    const shown = boundedPartText(
      shownPartText(context, messageId, "text", part.text),
      MAX_LIVE_TEXT_UTF8_BYTES,
    );
    return [textCandidate(messageId, index, shown, occurredAt, part.text)];
  }
  if (part?.type === "reasoning" && typeof part.text === "string") {
    const shown = shownPartText(context, messageId, "reasoning", part.text);
    return [reasoningCandidate(messageId, index, shown, occurredAt)];
  }
  if (part?.type !== "tool") return [];
  const signal = toolState(part, messageId, context.toolProfile);
  return [
    candidate(
      `${messageId}:tool:${String(index)}`,
      "tool",
      part,
      toolOrPlanSignal(part, messageId, signal),
    ),
  ];
}

// The plan tool is the governed plan snapshot and never productive tool activity (#2480): a
// completed part shows its step list, a part that has not completed (or failed) shows nothing, and
// a completed list that cannot be read stays visible as the tool it is rather than being lost.
function toolOrPlanSignal(
  part: Readonly<Record<string, unknown>>,
  messageId: string,
  tool: CodingSafeActivitySignal & { kind: "tool" },
): CodingSafeActivitySignal | undefined {
  const state = record(part.state);
  if (!OPENCODE_PLAN_CARRIER_TOOLS.has(toolIdentity(part).name) || state === undefined) return tool;
  const plan = openCodePlanCarrierSignal(messageId, state, tool.occurredAt);
  if (plan.kind === "value") return plan.value;
  return plan.kind === "skip" ? undefined : tool;
}

/**
 * The layout a compaction message fits, strictly: its fields all belong to its status in that layout
 * and the fields the decoder reads are present with their schema types. `undefined` when no admitted
 * layout fits, so a message mixing the two, or missing a required field, is refused.
 */
function compactionLayout(
  message: Readonly<Record<string, unknown>>,
): CompactionLayout | undefined {
  const { status, reason } = message;
  if (typeof status !== "string" || (reason !== "auto" && reason !== "manual")) return undefined;
  const layouts: readonly CompactionLayout[] = ["current", "legacy"];
  return layouts.find((layout) => compactionFitsLayout(message, status, layout));
}

function compactionFitsLayout(
  message: Readonly<Record<string, unknown>>,
  status: string,
  layout: CompactionLayout,
): boolean {
  const allowed = ownEntry(COMPACTION_LAYOUT_FIELDS[layout], status);
  if (allowed === undefined || Object.keys(message).some((key) => !allowed.includes(key)))
    return false;
  if (status === "failed") return isStructuredError(message.error);
  return (
    typeof message.summary === "string" &&
    (layout === "current" || typeof message.recent === "string")
  );
}

function nativeCompactionActivity(
  message: Readonly<Record<string, unknown>>,
  id: string,
): OpenCodeCompactionActivity {
  const layout = compactionLayout(message);
  if (layout === undefined) throw new OpenCodeV2HistoryError("reason=compaction-shape-invalid");
  const compactionIdSha256 = createHash("sha256").update(id, "utf8").digest("hex");
  if (message.status === "failed") {
    return {
      event: "failed",
      compactionIdSha256,
      errorKind: "OpenCodeCompactionFailure",
      finishReason: "error",
    };
  }
  if (message.status === "completed") return { event: "completed", compactionIdSha256 };
  const auto = message.reason === "auto";
  // Only the 2.0.10 runtime reports the tail it retained (`recent`, empty until it chose one);
  // 2.1.4 reports none, and a tail it did not report is not invented.
  if (layout === "legacy" && message.recent !== "") {
    return { event: "tail-retained", compactionIdSha256, auto, retainedTail: true };
  }
  return { event: "started", compactionIdSha256, auto, retainedTail: false };
}

function nativeCompactionCandidate(
  message: Readonly<Record<string, unknown>>,
  id: string,
): Candidate {
  const compaction = nativeCompactionActivity(message, id);
  // Compaction failure is an observation; only native execution settlement ends the task.
  return {
    ...candidate(`${id}:compaction:${compaction.event}`, "observation", compaction),
    compaction,
  };
}

function messageCandidates(
  message: Readonly<Record<string, unknown>>,
  parentMessageId: string | undefined,
  live: OpenCodeV2LiveText,
  toolProfile: OpenCodeToolProfile,
  children: BackgroundChildren,
  userDisplay?: string,
): readonly Candidate[] {
  assertMessageShape(message);
  const id = messageId(message);
  const occurredAt = eventTime(message);
  if (message.type === "assistant") {
    if (parentMessageId === undefined) throw new Error("opencode-v2-parent-message-missing");
    return assistantCandidates(message, parentMessageId, live, toolProfile);
  }
  if (message.type === "user" && typeof message.text === "string") {
    return [
      candidate(`${id}:message`, "observation", id, {
        kind: "message",
        role: "user",
        messageId: id,
        occurredAt,
      }),
      textCandidate(id, 0, userDisplay ?? visibleUserText(message), occurredAt),
    ];
  }
  if (message.type === "compaction") return [nativeCompactionCandidate(message, id)];
  if (message.type === "idle") return [idleCandidate(id, message.outcome, children)];
  return [candidate(`${id}:other`, "observation", message.type)];
}

/**
 * What the runtime tells a parent about a subagent it launched in the background
 * (https://opencode.ai/v2/docs/tools/#subagent): the launching tool call returns at once, the parent
 * goes idle while the child keeps working, and when the child ends the runtime appends a synthetic
 * message naming it (completed, failed or cancelled) and runs the parent again to read it. A parent's
 * idle message is therefore the end of the run's work only when every background child it launched
 * has reported back; before that it ends the parent's execution and nothing more. The rule reads the
 * parent's own history, so it holds across a reconnect and needs no timing: a child launched but not
 * yet reported is "owed", and an owed child is a launch (a completed `subagent` call with
 * `background: true` that names its child session) without a synthetic message carrying that child's
 * id. A failed idle message is a verdict whatever is owed.
 */
interface BackgroundChildren {
  readonly launched: Set<string>;
  readonly reported: Set<string>;
}

const BACKGROUND_CHILD_SESSION_ID = /^ses_[A-Za-z0-9_-]{1,251}$/u;

function backgroundLaunch(part: unknown): string | undefined {
  const tool = record(part);
  if (tool?.type !== "tool" || tool.name !== "subagent") return undefined;
  const state = record(tool.state);
  if (state?.status !== "completed" || record(state.input)?.background !== true) return undefined;
  return backgroundChildId(record(state.metadata)?.sessionID);
}

function backgroundChildId(value: unknown): string | undefined {
  return typeof value === "string" && BACKGROUND_CHILD_SESSION_ID.test(value) ? value : undefined;
}

function backgroundReport(message: Readonly<Record<string, unknown>>): string | undefined {
  const metadata = record(message.metadata);
  if (message.type !== "synthetic" || metadata?.source !== "subagent") return undefined;
  return backgroundChildId(metadata.childID);
}

function observeBackgroundChildren(
  message: Readonly<Record<string, unknown>>,
  children: BackgroundChildren,
): void {
  const reported = backgroundReport(message);
  if (reported !== undefined) children.reported.add(reported);
  if (message.type !== "assistant" || !Array.isArray(message.content)) return;
  for (const part of message.content as readonly unknown[]) {
    const launched = backgroundLaunch(part);
    if (launched !== undefined) children.launched.add(launched);
  }
}

function idleCandidate(id: string, outcome: unknown, children: BackgroundChildren): Candidate {
  const key = `${id}:idle`;
  if (outcome !== "succeeded") return candidate(key, "terminal-failure", outcome);
  const owed = [...children.launched].some((child) => !children.reported.has(child));
  return owed
    ? { ...candidate(key, "observation", outcome), heldIdle: true }
    : candidate(key, "terminal", outcome);
}

// A settled assistant message projects to the same candidates as long as nothing it depends on has
// changed: its own serialized form, the user message it answers, and the live text fed into it. The
// retained message is compared by value, so the reuse can never show an older read.
interface ReusedMessage {
  readonly message: Readonly<Record<string, unknown>>;
  readonly parentMessageId: string | undefined;
  readonly candidates: readonly Candidate[];
}

interface MessageReuse {
  readonly memo: Map<string, ReusedMessage>;
  readonly seen: Set<string>;
  reused: number;
  projected: number;
}

function newMessageReuse(): MessageReuse {
  return { memo: new Map(), seen: new Set(), reused: 0, projected: 0 };
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null)
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      jsonEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}

function assistantCandidatesReusing(
  message: Readonly<Record<string, unknown>>,
  parentMessageId: string | undefined,
  live: OpenCodeV2LiveText,
  toolProfile: OpenCodeToolProfile,
  children: BackgroundChildren,
  reuse: MessageReuse,
): readonly Candidate[] {
  const id = message.id;
  // An unreadable identity takes the ordinary path and its ordinary error.
  if (typeof id !== "string")
    return messageCandidates(message, parentMessageId, live, toolProfile, children);
  reuse.seen.add(id);
  const previous = reuse.memo.get(id);
  const settled = !live.tracks(id);
  if (
    settled &&
    previous !== undefined &&
    previous.parentMessageId === parentMessageId &&
    jsonEqual(previous.message, message)
  ) {
    reuse.reused += 1;
    return previous.candidates;
  }
  const candidates = messageCandidates(message, parentMessageId, live, toolProfile, children);
  reuse.projected += 1;
  // A message live text is still being fed into is decided by that text too, so it is not retained;
  // one whose live text retired during this call projected to what its history alone shows.
  if (!live.tracks(id)) reuse.memo.set(id, { message, parentMessageId, candidates });
  else reuse.memo.delete(id);
  return candidates;
}

// Counts the call and forgets the messages it no longer saw, so the retained set follows the history.
function settleReuse(reuse: MessageReuse): OpenCodeV2ProjectionReuse {
  for (const id of reuse.memo.keys()) if (!reuse.seen.has(id)) reuse.memo.delete(id);
  const counts = { reusedMessageCount: reuse.reused, projectedMessageCount: reuse.projected };
  reuse.seen.clear();
  reuse.reused = 0;
  reuse.projected = 0;
  return counts;
}

/**
 * What a scan carries from one message to the next: the user message the next assistant message
 * answers and the background children launched and reported so far. A tail read resumes from it.
 */
interface ScanState {
  readonly parentMessageId: string | undefined;
  readonly launched: ReadonlySet<string>;
  readonly reported: ReadonlySet<string>;
}

/** Where the next sync reads from (#4104): the anchor message and what the scan held before it. */
interface TailState {
  readonly anchorId: string;
  readonly scan: ScanState;
  /** The messages before the anchor that earlier syncs carried over. */
  readonly precedingCount: number;
  /** The ids of the messages from the anchor to the newest of the pass that chose it. */
  readonly windowIds: ReadonlySet<string>;
  /** The base read was the newest window of a session past the read bound. */
  readonly truncated: boolean;
}

interface ScanWindow {
  /** The state before the window's first message; absent when the window opens the session. */
  readonly start?: ScanState | undefined;
  /** The index of the message the next window starts at. */
  readonly anchorIndex: number;
}

interface ScannedCandidates {
  readonly candidates: readonly Candidate[];
  /** The next window's start; absent for an empty window. */
  readonly anchor?:
    | {
        readonly id: string;
        /** The index of the anchor message's first candidate. */
        readonly candidateIndex: number;
        readonly state: ScanState;
      }
    | undefined;
}

interface ScanContext {
  readonly live: OpenCodeV2LiveText;
  readonly known: ReadonlyMap<string, KnownCandidate>;
  readonly toolProfile: OpenCodeToolProfile;
  readonly activity?: HistoryActivity | undefined;
  readonly reuse?: MessageReuse | undefined;
}

interface ScanCursor {
  readonly candidates: Candidate[];
  readonly children: BackgroundChildren;
  parentMessageId: string | undefined;
}

function userDisplayFor(
  message: Readonly<Record<string, unknown>>,
  context: ScanContext,
): string | undefined {
  if (message.type !== "user") return undefined;
  const id = messageId(message);
  return context.activity?.userMessageDisplay?.(id, !context.known.has(`${id}:message`));
}

function scanMessage(
  cursor: ScanCursor,
  message: Readonly<Record<string, unknown>>,
  context: ScanContext,
): void {
  const { live, known, toolProfile, reuse } = context;
  if (message.type === "user") cursor.parentMessageId = messageId(message);
  observeBackgroundChildren(message, cursor.children);
  const { parentMessageId, children } = cursor;
  cursor.candidates.push(
    ...(reuse !== undefined && message.type === "assistant"
      ? assistantCandidatesReusing(message, parentMessageId, live, toolProfile, children, reuse)
      : messageCandidates(
          message,
          parentMessageId,
          live,
          toolProfile,
          children,
          userDisplayFor(message, context),
        )),
    ...changedNativeRetryCandidates(message, parentMessageId, known),
  );
}

function snapshotAnchor(
  cursor: ScanCursor,
  message: Readonly<Record<string, unknown>>,
): NonNullable<ScannedCandidates["anchor"]> {
  return {
    id: messageId(message),
    candidateIndex: cursor.candidates.length,
    state: {
      parentMessageId: cursor.parentMessageId,
      launched: new Set(cursor.children.launched),
      reported: new Set(cursor.children.reported),
    },
  };
}

function allCandidates(
  sessionId: string,
  messages: readonly Readonly<Record<string, unknown>>[],
  context: ScanContext,
  window: ScanWindow,
): ScannedCandidates {
  const cursor: ScanCursor = {
    candidates: [candidate(`${sessionId}:created`, "observation", sessionId)],
    children: {
      launched: new Set(window.start?.launched),
      reported: new Set(window.start?.reported),
    },
    parentMessageId: window.start?.parentMessageId,
  };
  let anchor: ScannedCandidates["anchor"];
  for (const [index, message] of messages.entries()) {
    if (index === window.anchorIndex) anchor = snapshotAnchor(cursor, message);
    scanMessage(cursor, message, context);
  }
  return { candidates: cursor.candidates, anchor };
}

function changedNativeRetryCandidates(
  message: Readonly<Record<string, unknown>>,
  parentMessageId: string | undefined,
  known: ReadonlyMap<string, KnownCandidate>,
): readonly Candidate[] {
  if (message.type !== "assistant" || parentMessageId === undefined) return [];
  const id = messageId(message);
  if (message.retry === undefined && !known.has(`${id}:retry`)) return [];
  return [nativeRetryCandidate(message, id, parentMessageId, eventTime(message))];
}

function makePending(
  sessionId: string,
  checkpoint: number,
  known: ReadonlyMap<string, KnownCandidate>,
  candidates: readonly Candidate[],
): PendingProjection {
  // Only what this pass changes: copying the whole known set per pass would cost the session's
  // length on every sync, and the set is adopted into the owned map when the checkpoint commits.
  const knownUpdates = new Map<string, KnownCandidate>();
  const events: OpenCodeReconciliationEvent[] = [];
  const signals = new Map<string, CodingSafeActivitySignal>();
  let emptyTextCount = 0;
  let nativeRetrySignalCount = 0;
  let heldIdleCount = 0;
  for (const item of candidates) {
    const previous = known.get(item.key);
    if (previous?.digest === item.digest) continue;
    const sequence = checkpoint + events.length + 1;
    const identity = historyEventDigest(item, sessionId, sequence);
    const id = `evt_${identity.slice(0, 32)}`;
    const event = {
      id,
      aggregateId: sessionId,
      sequence,
      digest: identity,
      kind: item.kind,
      ...(item.compaction === undefined ? {} : { compaction: item.compaction }),
    };
    events.push(event);
    const text = candidateText(item);
    knownUpdates.set(item.key, {
      digest: item.digest,
      ...(text === undefined ? {} : { textLength: text.length }),
    });
    if (item.emptyText) emptyTextCount += 1;
    nativeRetrySignalCount += Number(item.nativeRetryState === true);
    heldIdleCount += Number(item.heldIdle === true);
    const signal = incrementalSignal(item, previous);
    if (signal !== undefined) signals.set(`${sessionId}\u0000${String(sequence)}`, signal);
    if (events.length === PASS_EVENT_CAP) break;
  }
  return {
    knownUpdates,
    events,
    signals,
    emptyTextCount,
    nativeRetrySignalCount,
    heldIdleCount,
    capped: events.length === PASS_EVENT_CAP,
  };
}

function historyEventDigest(item: Candidate, sessionId: string, sequence: number): string {
  // Repeated native clears have identical facts but are distinct committed transitions.
  return item.nativeRetryState ? digest([sessionId, sequence, item.digest]) : item.digest;
}

type GrowingTextSignal = Extract<CodingSafeActivitySignal, { readonly kind: "text" | "reasoning" }>;

// Answer text and model reasoning both grow by suffix and are projected by their new characters.
function growingTextSignal(item: Candidate): GrowingTextSignal | undefined {
  const signal = item.signal;
  return signal?.kind === "text" || signal?.kind === "reasoning" ? signal : undefined;
}

function candidateText(item: Candidate): string | undefined {
  if (item.emptyText) return "";
  return growingTextSignal(item)?.text;
}

function incrementalSignal(
  item: Candidate,
  previous: KnownCandidate | undefined,
): CodingSafeActivitySignal | undefined {
  const text = candidateText(item);
  const offset = previous?.textLength;
  if (text === undefined || offset === undefined) return item.signal;
  if (offset > text.length || digest([item.key, text.slice(0, offset)]) !== previous?.digest)
    throw new OpenCodeV2HistoryError("reason=text-prefix-invalid");
  const growing = growingTextSignal(item);
  return growing === undefined ? item.signal : { ...growing, text: text.slice(offset) };
}

function recordNativeQuestions(
  activity: HistoryActivity | undefined,
  pending: PendingProjection,
): void {
  if (activity?.activityLog === undefined) return;
  for (const signal of pending.signals.values()) {
    if (signal.kind !== "tool" || signal.tool !== "question") continue;
    activity.activityLog.write(
      activityLogEvent(
        NATIVE_QUESTION_OPERATION,
        {
          correlationId: activity.runId,
          ...(signal.state === "failed" ? ({ level: "warn", errorKind: "internal" } as const) : {}),
        },
        {
          callDigest: digest(signal.callId),
          state: signal.state,
          ...(signal.state === "failed" ? { failureReason: "native-tool-error" } : {}),
        },
      ),
    );
  }
}

// A pass that produced nothing writes no line, and the counts it accumulated wait for the next one.
function recordHistoryProjection(
  activity: HistoryActivity | undefined,
  pending: PendingProjection,
  live: OpenCodeV2LiveText,
): void {
  if (pending.events.length === 0) return;
  if (activity?.activityLog === undefined) return;
  const counts = live.takeCounts();
  const merged = activity.takeMergedEventCount?.();
  activity.activityLog.write(
    activityLogEvent(
      HISTORY_PROJECTION_OPERATION,
      { correlationId: activity.runId },
      {
        eventCount: pending.events.length,
        signalCount: pending.signals.size,
        emptyTextCount: pending.emptyTextCount,
        nativeRetrySignalCount: pending.nativeRetrySignalCount,
        reasoningSignalCount: [...pending.signals.values()].filter(
          (signal) => signal.kind === "reasoning",
        ).length,
        ...(merged === undefined ? {} : { mergedEventCount: merged }),
        liveDeltaCount: counts.applied,
        liveDroppedCount: counts.dropped,
        liveDivergedCount: counts.diverged,
        ...(pending.heldIdleCount === 0 ? {} : { heldIdleCount: pending.heldIdleCount }),
        ...pending.sync,
      },
    ),
  );
}

/** A pull repeats unchanged candidates until the adapter commits its checkpoint. */
/**
 * The files one finished assistant step changed, as the runtime's own snapshot of the workspace
 * names them (`snapshot.files`), and the tool calls of that step (#3901). The snapshot covers the
 * whole workspace, so a shell command's or a child session's writes are in it as much as an edit
 * tool's. Paths stay in memory for the verification evidence and never reach a log.
 */
export interface OpenCodeV2StepChange {
  readonly messageId: string;
  readonly files: readonly string[];
  readonly callIds: readonly string[];
  /** The list was longer than the bound, or held something other than a path. */
  readonly truncated: boolean;
}

/** The most changed files of one step that are compared one by one. */
export const OPENCODE_V2_STEP_CHANGE_FILES_MAX = 10_000;

export function openCodeV2StepChanges(
  messages: readonly Readonly<Record<string, unknown>>[],
): readonly OpenCodeV2StepChange[] {
  return messages.flatMap((message) => {
    const change = stepChange(message);
    return change === undefined ? [] : [change];
  });
}

function stepChange(message: Readonly<Record<string, unknown>>): OpenCodeV2StepChange | undefined {
  if (message.type !== "assistant" || message.finish === undefined) return undefined;
  const files = record(message.snapshot)?.files;
  if (typeof message.id !== "string" || !Array.isArray(files) || files.length === 0)
    return undefined;
  const bounded = (files as readonly unknown[]).slice(0, OPENCODE_V2_STEP_CHANGE_FILES_MAX);
  const paths = bounded.filter((file): file is string => typeof file === "string");
  return {
    messageId: message.id,
    files: paths,
    callIds: stepCallIds(message.content),
    truncated: files.length > bounded.length || paths.length < bounded.length,
  };
}

function stepCallIds(content: unknown): readonly string[] {
  if (!Array.isArray(content)) return [];
  return (content as readonly unknown[]).flatMap((part) => {
    const tool = record(part);
    return tool?.type === "tool" && typeof tool.id === "string" ? [tool.id] : [];
  });
}

function tailSettings(options: OpenCodeV2HistoryProjectionOptions | undefined): {
  readonly incremental: boolean;
  readonly margin: number;
  readonly verifyEvery: number;
} {
  return {
    incremental: options?.incremental !== false,
    margin: Math.max(1, options?.tailMargin ?? DEFAULT_TAIL_MARGIN),
    verifyEvery: Math.max(1, options?.verifyEvery ?? DEFAULT_VERIFY_EVERY),
  };
}

class HistoryProjection implements OpenCodeV2HistoryProjection {
  private readonly known = new Map<string, KnownCandidate>();
  // Where the next sync may start reading, as of the last committed pass.
  private tail: TailState | undefined;
  private pending: PendingProjection | undefined;
  private pendingStart = -1;
  private readonly toolProfile: OpenCodeToolProfile;
  private readonly ledger: ConversationLedger;
  private readonly activeSignals = new Map<string, CodingSafeActivitySignal>();
  private readonly live = createOpenCodeV2LiveText();
  private readonly reuse: MessageReuse | undefined;
  private readonly incremental: boolean;
  private readonly margin: number;
  private readonly verifyEvery: number;
  // Tail reads since the last complete one, and what the last `readPlan` asked for.
  private tailPasses = 0;
  private plannedMode: OpenCodeV2ReadMode | undefined;
  private reuseOfLastProject: OpenCodeV2ProjectionReuse = {
    reusedMessageCount: 0,
    projectedMessageCount: 0,
  };
  private syncOfLastProject: OpenCodeV2SyncStats = {
    readMode: "full",
    readMessageCount: 0,
    retainedMessageCount: 0,
  };

  constructor(
    private readonly activity: HistoryActivity | undefined,
    options: OpenCodeV2HistoryProjectionOptions | undefined,
  ) {
    this.toolProfile = activity?.toolProfile ?? "direct";
    openCodeVisibleToolNames(this.toolProfile);
    this.ledger = new ConversationLedger(activity?.captureMessages);
    this.reuse = options?.reuseMessages === false ? undefined : newMessageReuse();
    const tail = tailSettings(options);
    this.incremental = tail.incremental;
    this.margin = tail.margin;
    this.verifyEvery = tail.verifyEvery;
  }

  lastReuse(): OpenCodeV2ProjectionReuse {
    return this.reuseOfLastProject;
  }

  lastSync(): OpenCodeV2SyncStats {
    return this.syncOfLastProject;
  }

  readPlan(checkpoint: number | undefined): OpenCodeV2ReadPlan {
    this.settle(checkpoint ?? -1);
    const tail = this.usableTail();
    if (tail === undefined) return this.plan("full", undefined);
    if (this.tailPasses >= this.verifyEvery) return this.plan("verify", undefined);
    return this.plan("tail", tail.anchorId);
  }

  project(
    sessionId: string,
    messages: readonly Readonly<Record<string, unknown>>[],
    checkpoint: number | undefined,
    window?: OpenCodeV2HistoryWindow,
  ): readonly OpenCodeReconciliationEvent[] {
    const position = checkpoint ?? -1;
    this.settle(position);
    if (this.pending !== undefined && position !== this.pendingStart) {
      throw new Error("opencode-v2-checkpoint-invalid");
    }
    this.pending ??= this.projectFresh(sessionId, messages, position, window);
    this.pendingStart = position;
    for (const [key, signal] of this.pending.signals) this.activeSignals.set(key, signal);
    return this.pending.events;
  }

  // The checkpoint reached the end of the pending page: its changes become the known state, and the
  // tail it chose becomes where the next read starts.
  private settle(position: number): void {
    if (this.pending === undefined || position !== this.pendingStart + this.pending.events.length)
      return;
    for (const [key, known] of this.pending.knownUpdates) this.known.set(key, known);
    this.tail = this.pending.tail;
    this.pending = undefined;
  }

  private plan(mode: OpenCodeV2ReadMode, anchorId: string | undefined): OpenCodeV2ReadPlan {
    this.plannedMode = mode;
    return { anchorId };
  }

  // A tail is usable only when everything before it is committed and caught up (a page still
  // pending, or a pass cut at the event cap, leaves candidates the older messages still owe), and
  // when no message older than the tail still holds live text: such a message is decided by its
  // overlay and the history together, so it is read again.
  private usableTail(): TailState | undefined {
    const tail = this.tail;
    if (!this.incremental || tail === undefined || this.pending !== undefined) return undefined;
    for (const id of this.live.fedMessageIds())
      if (!tail.windowIds.has(id) && this.known.has(`${id}:message`)) return undefined;
    return tail;
  }

  // The tail state this pass starts from, when its window is anchored.
  private anchoredBase(
    messages: readonly Readonly<Record<string, unknown>>[],
    window: OpenCodeV2HistoryWindow | undefined,
  ): TailState | undefined {
    if (window?.anchored !== true) return undefined;
    if (this.tail === undefined || messages[0]?.id !== this.tail.anchorId)
      throw new Error("opencode-v2-tail-anchor-mismatch");
    return this.tail;
  }

  private projectFresh(
    sessionId: string,
    messages: readonly Readonly<Record<string, unknown>>[],
    position: number,
    window: OpenCodeV2HistoryWindow | undefined,
  ): PendingProjection {
    const base = this.anchoredBase(messages, window);
    const anchorIndex = Math.max(0, messages.length - this.margin);
    const scanned = allCandidates(
      sessionId,
      messages,
      {
        live: this.live,
        known: this.known,
        toolProfile: this.toolProfile,
        activity: this.activity,
        reuse: this.reuse,
      },
      { start: base?.scan, anchorIndex },
    );
    if (this.reuse !== undefined) this.reuseOfLastProject = settleReuse(this.reuse);
    const made = makePending(sessionId, position, this.known, scanned.candidates);
    // A truncated window never replaces the conversation captured from the complete history.
    const truncated = base?.truncated ?? window?.truncated === true;
    if (!truncated)
      this.ledger.observe(
        scanned.candidates,
        scanned.anchor?.candidateIndex ?? 0,
        base === undefined,
      );
    const sync = this.settleSync(base, messages.length);
    const pending = {
      ...made,
      sync,
      tail: made.capped
        ? undefined
        : this.nextTail(messages, scanned, base, truncated, anchorIndex),
    };
    recordHistoryProjection(this.activity, pending, this.live);
    recordNativeQuestions(this.activity, pending);
    return pending;
  }

  private settleSync(base: TailState | undefined, windowLength: number): OpenCodeV2SyncStats {
    const planned = this.plannedMode;
    this.plannedMode = undefined;
    this.tailPasses = base === undefined ? 0 : this.tailPasses + 1;
    this.syncOfLastProject = {
      readMode: settledReadMode(base, planned),
      readMessageCount: windowLength,
      retainedMessageCount: base?.precedingCount ?? 0,
    };
    return this.syncOfLastProject;
  }

  private nextTail(
    messages: readonly Readonly<Record<string, unknown>>[],
    scanned: ScannedCandidates,
    base: TailState | undefined,
    truncated: boolean,
    anchorIndex: number,
  ): TailState | undefined {
    if (!this.incremental || scanned.anchor === undefined) return undefined;
    return {
      anchorId: scanned.anchor.id,
      scan: scanned.anchor.state,
      precedingCount: (base?.precedingCount ?? 0) + anchorIndex,
      windowIds: new Set(messages.slice(anchorIndex).map((message) => messageId(message))),
      truncated,
    };
  }

  takeSignal(event: OpenCodeReconciliationEvent): CodingSafeActivitySignal | undefined {
    const key = `${event.aggregateId}\u0000${String(event.sequence)}`;
    const signal = this.activeSignals.get(key);
    this.activeSignals.delete(key);
    return signal;
  }

  clearSignals(): void {
    this.activeSignals.clear();
  }

  observeLiveEvent(sessionId: string, event: Readonly<Record<string, unknown>>): void {
    this.live.observe(sessionId, event);
  }

  freezeLiveText(): void {
    this.live.freeze();
  }
}

export function createOpenCodeV2HistoryProjection(
  activity?: HistoryActivity,
  options?: OpenCodeV2HistoryProjectionOptions,
): OpenCodeV2HistoryProjection {
  return new HistoryProjection(activity, options);
}
