import type { CodingHistoryMessage } from "./codingRuntimeHistory.js";
import { createHash } from "node:crypto";

import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES } from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type { CodingSafeActivitySignal } from "./codingSafeActivityProjection.js";
import type {
  OpenCodeCompactionActivity,
  OpenCodeReconciliationEvent,
} from "./opencodeReconciler.js";
import {
  createOpenCodeV2LiveText,
  type LiveTextKind,
  type OpenCodeV2LiveText,
} from "./opencodeV2LiveText.js";
import { OPENCODE_MODEL_VISIBLE_TOOL_NAMES } from "./opencodeToolSchemas.js";

const HISTORY_TOOLS: ReadonlySet<string> = new Set(OPENCODE_MODEL_VISIBLE_TOOL_NAMES);

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
  readonly captureMessages?: ((messages: readonly CodingHistoryMessage[]) => boolean) | undefined;
  readonly runId: string;
  readonly activityLog: ServerLogSink | undefined;
  /**
   * The runtime events merged into earlier history reads since the previous projection line, which
   * resets (#3873 review). Absent for a projection that is not fed by the event stream.
   */
  readonly takeMergedEventCount?: (() => number) | undefined;
}

interface Candidate {
  readonly key: string;
  readonly digest: string;
  readonly kind: OpenCodeReconciliationEvent["kind"];
  readonly compaction?: OpenCodeCompactionActivity;
  readonly signal?: CodingSafeActivitySignal | undefined;
  readonly emptyText?: true;
  // A text part's own text as the runtime persisted it. Coding History is built from this, never from
  // the live text the timeline shows while the part streams: partial answers are not captured.
  readonly capturedText?: string;
}

interface PendingProjection {
  readonly nextKnown: ReadonlyMap<string, KnownCandidate>;
  readonly events: readonly OpenCodeReconciliationEvent[];
  readonly signals: ReadonlyMap<string, CodingSafeActivitySignal>;
  readonly emptyTextCount: number;
}

interface KnownCandidate {
  readonly digest: string;
  readonly textLength?: number;
}

export class OpenCodeV2HistoryError extends Error {
  constructor(readonly safeCode: string) {
    super("opencode-v2-history-invalid");
  }
}

const MESSAGE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  user: ["id", "metadata", "time", "text", "files", "agents", "skills", "type"],
  assistant: [
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
    "providerState",
    "cost",
    "tokens",
    "error",
    "retry",
  ],
  idle: ["id", "metadata", "time", "type", "outcome"],
  system: ["id", "metadata", "time", "type", "text", "description"],
  synthetic: ["id", "metadata", "time", "type", "text", "description"],
  shell: ["id", "metadata", "time", "type", "shellID", "command", "status", "exit", "output"],
  skill: ["id", "metadata", "time", "type", "skill", "name", "text"],
  "agent-switched": ["id", "metadata", "time", "type", "agent", "previous"],
  "model-switched": ["id", "metadata", "time", "type", "model", "previous"],
  "location-switched": [
    "id",
    "metadata",
    "time",
    "type",
    "projectID",
    "subpath",
    "location",
    "previous",
  ],
  compaction: [
    "id",
    "metadata",
    "time",
    "type",
    "status",
    "reason",
    "model",
    "providerState",
    "summary",
    "recent",
    "providerContext",
    "cost",
    "tokens",
    "error",
  ],
};

export interface OpenCodeV2HistoryProjection {
  project(
    sessionId: string,
    messages: readonly Readonly<Record<string, unknown>>[],
    checkpoint: number | undefined,
  ): readonly OpenCodeReconciliationEvent[];
  takeSignal(event: OpenCodeReconciliationEvent): CodingSafeActivitySignal | undefined;
  clearSignals(): void;
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

function assertMessageShape(message: Readonly<Record<string, unknown>>): void {
  const role = message.type;
  if (typeof role !== "string")
    throw new OpenCodeV2HistoryError("reason=event-unknown:type=unsupported");
  const allowed = MESSAGE_FIELDS[role];
  if (allowed === undefined)
    throw new OpenCodeV2HistoryError("reason=event-unknown:type=unsupported");
  const extra = Object.keys(message).filter((key) => !allowed.includes(key));
  if (extra.length === 0) return;
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
  if (valid && inputBytes <= TOOL_CATALOG_LIMITS.maxArgumentBytes) return;
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
  if (Buffer.byteLength(text, "utf8") > 65_536) throw new Error("opencode-v2-text-oversized");
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

// #3878: the live timeline shows at most CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES of a
// message's reasoning, so a reasoning part is read up to twice that and no further: a long reasoner
// neither fails the history read like an oversized answer nor costs a digest of its whole text on
// every pull. The prefix grows with the part until the bound and then stays fixed.
const MAX_PROJECTED_REASONING_UTF8_BYTES = 2 * CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES;

function projectedReasoning(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_PROJECTED_REASONING_UTF8_BYTES) return text;
  let used = 0;
  let end = 0;
  for (const character of text) {
    used += Buffer.byteLength(character, "utf8");
    if (used > MAX_PROJECTED_REASONING_UTF8_BYTES) break;
    end += character.length;
  }
  return text.slice(0, end);
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
  const shown = projectedReasoning(text);
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
): CodingSafeActivitySignal & { kind: "tool" } {
  const state = record(part.state);
  const status = state?.status;
  if (state === undefined) throw new Error("opencode-v2-tool-state-invalid");
  const { id, name } = toolIdentity(part);
  assertToolInput(part, state);
  if (!HISTORY_TOOLS.has(name)) throw new Error("opencode-v2-tool-invalid");
  const mapped = displayToolState(status);
  return {
    kind: "tool",
    messageId,
    callId: id,
    tool: name,
    state: mapped,
    occurredAt: toolOccurredAt(part),
  };
}

function displayToolState(status: unknown): "pending" | "running" | "succeeded" | "failed" {
  if (status === "streaming") return "pending";
  if (status === "completed") return "succeeded";
  if (status === "error") return "failed";
  if (status === "running") return "running";
  throw new Error("opencode-v2-tool-state-invalid");
}

function assistantCandidates(
  message: Readonly<Record<string, unknown>>,
  parentMessageId: string,
  live: OpenCodeV2LiveText,
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
    result.push(...assistantPartCandidates(value, id, index, occurredAt, { live, ordinals }));
  }
  return result;
}

interface PartOrdinals {
  text: number;
  reasoning: number;
}

interface LivePartContext {
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
    const shown = shownPartText(context, messageId, "text", part.text);
    return [textCandidate(messageId, index, shown, occurredAt, part.text)];
  }
  if (part?.type === "reasoning" && typeof part.text === "string") {
    const shown = shownPartText(context, messageId, "reasoning", part.text);
    return [reasoningCandidate(messageId, index, shown, occurredAt)];
  }
  if (part?.type !== "tool") return [];
  const signal = toolState(part, messageId);
  return [candidate(`${messageId}:tool:${String(index)}`, "tool", part, signal)];
}

const NATIVE_COMPACTION_COMMON_FIELDS = ["id", "metadata", "time", "type", "status", "reason"];
// Exact pinned V2 variants. Summary/error bodies are checked only for shape, never projected.
const NATIVE_COMPACTION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  running: [...NATIVE_COMPACTION_COMMON_FIELDS, "summary", "recent"],
  completed: [
    ...NATIVE_COMPACTION_COMMON_FIELDS,
    "summary",
    "recent",
    "model",
    "providerState",
    "providerContext",
    "cost",
    "tokens",
  ],
  failed: [...NATIVE_COMPACTION_COMMON_FIELDS, "error", "cost", "tokens"],
};

function assertNativeCompactionShape(message: Readonly<Record<string, unknown>>): void {
  const allowed =
    typeof message.status === "string" ? NATIVE_COMPACTION_FIELDS[message.status] : undefined;
  if (
    allowed === undefined ||
    (message.reason !== "auto" && message.reason !== "manual") ||
    Object.keys(message).some((key) => !allowed.includes(key))
  ) {
    throw new OpenCodeV2HistoryError("reason=compaction-shape-invalid");
  }
}

function nativeCompactionRecent(message: Readonly<Record<string, unknown>>): string {
  const recent = message.recent;
  if (typeof message.summary !== "string" || typeof recent !== "string") {
    throw new OpenCodeV2HistoryError("reason=compaction-shape-invalid");
  }
  return recent;
}

function validNativeCompactionErrorStatus(status: unknown): boolean {
  return (
    status === undefined ||
    (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
  );
}

function assertNativeCompactionError(message: Readonly<Record<string, unknown>>): void {
  const error = record(message.error);
  if (
    error === undefined ||
    typeof error.type !== "string" ||
    typeof error.message !== "string" ||
    !validNativeCompactionErrorStatus(error.status) ||
    Object.keys(error).some((key) => !["type", "message", "status"].includes(key))
  ) {
    throw new OpenCodeV2HistoryError("reason=compaction-shape-invalid");
  }
}

function nativeCompactionActivity(
  message: Readonly<Record<string, unknown>>,
  id: string,
): OpenCodeCompactionActivity {
  assertNativeCompactionShape(message);
  const compactionIdSha256 = createHash("sha256").update(id, "utf8").digest("hex");
  if (message.status === "failed") {
    assertNativeCompactionError(message);
    return {
      event: "failed",
      compactionIdSha256,
      errorKind: "OpenCodeCompactionFailure",
      finishReason: "error",
    };
  }
  const recent = nativeCompactionRecent(message);
  if (message.status === "completed") return { event: "completed", compactionIdSha256 };
  const auto = message.reason === "auto";
  if (recent === "") return { event: "started", compactionIdSha256, auto, retainedTail: false };
  return {
    event: "tail-retained",
    compactionIdSha256,
    auto,
    retainedTail: true,
  };
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
): readonly Candidate[] {
  assertMessageShape(message);
  const id = messageId(message);
  const occurredAt = eventTime(message);
  if (message.type === "assistant") {
    if (parentMessageId === undefined) throw new Error("opencode-v2-parent-message-missing");
    return assistantCandidates(message, parentMessageId, live);
  }
  if (message.type === "user" && typeof message.text === "string") {
    return [
      candidate(`${id}:message`, "observation", id, {
        kind: "message",
        role: "user",
        messageId: id,
        occurredAt,
      }),
      textCandidate(id, 0, visibleUserText(message), occurredAt),
    ];
  }
  if (message.type === "compaction") return [nativeCompactionCandidate(message, id)];
  if (message.type === "idle") {
    return [
      candidate(
        `${id}:idle`,
        message.outcome === "succeeded" ? "terminal" : "terminal-failure",
        message.outcome,
      ),
    ];
  }
  return [candidate(`${id}:other`, "observation", message.type)];
}

function allCandidates(
  sessionId: string,
  messages: readonly Readonly<Record<string, unknown>>[],
  live: OpenCodeV2LiveText,
): readonly Candidate[] {
  const result: Candidate[] = [candidate(`${sessionId}:created`, "observation", sessionId)];
  let parentMessageId: string | undefined;
  for (const message of messages) {
    if (message.type === "user") parentMessageId = messageId(message);
    result.push(...messageCandidates(message, parentMessageId, live));
  }
  return result;
}

// Coding History records what the runtime persisted: a text part's own text, never the live text the
// timeline shows while the part streams, so a turn cut short does not leave a partial answer behind
// and a streaming turn does not rewrite the stored message on every delta.
function conversationMessages(candidates: readonly Candidate[]): readonly CodingHistoryMessage[] {
  const messages = new Map<string, CodingHistoryMessage>();
  for (const { signal, capturedText } of candidates) {
    if (signal?.kind === "message")
      messages.set(signal.messageId, {
        messageId: signal.messageId,
        role: signal.role,
        content: "",
      });
    if (signal?.kind !== "text") continue;
    const message = messages.get(signal.messageId);
    if (message !== undefined)
      messages.set(signal.messageId, {
        ...message,
        content: message.content + (capturedText ?? signal.text),
      });
  }
  return [...messages.values()];
}

function makePending(
  sessionId: string,
  checkpoint: number,
  known: ReadonlyMap<string, KnownCandidate>,
  candidates: readonly Candidate[],
): PendingProjection {
  const nextKnown = new Map(known);
  const events: OpenCodeReconciliationEvent[] = [];
  const signals = new Map<string, CodingSafeActivitySignal>();
  let emptyTextCount = 0;
  for (const item of candidates) {
    const previous = known.get(item.key);
    if (previous?.digest === item.digest) continue;
    const sequence = checkpoint + events.length + 1;
    const id = `evt_${item.digest.slice(0, 32)}`;
    const event = {
      id,
      aggregateId: sessionId,
      sequence,
      digest: item.digest,
      kind: item.kind,
      ...(item.compaction === undefined ? {} : { compaction: item.compaction }),
    };
    events.push(event);
    const text = candidateText(item);
    nextKnown.set(item.key, {
      digest: item.digest,
      ...(text === undefined ? {} : { textLength: text.length }),
    });
    if (item.emptyText) emptyTextCount += 1;
    const signal = incrementalSignal(item, previous);
    if (signal !== undefined) signals.set(`${sessionId}\u0000${String(sequence)}`, signal);
    if (events.length === 256) break;
  }
  return { nextKnown, events, signals, emptyTextCount };
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
        reasoningSignalCount: [...pending.signals.values()].filter(
          (signal) => signal.kind === "reasoning",
        ).length,
        ...(merged === undefined ? {} : { mergedEventCount: merged }),
        liveDeltaCount: counts.applied,
        liveDroppedCount: counts.dropped,
        liveDivergedCount: counts.diverged,
      },
    ),
  );
}

function conversationCapture(
  activity: HistoryActivity | undefined,
): (candidates: readonly Candidate[]) => void {
  let capturedDigest: string | undefined;
  return (candidates): void => {
    if (activity?.captureMessages === undefined) return;
    const conversation = conversationMessages(candidates);
    const currentDigest = digest(conversation);
    if (currentDigest !== capturedDigest && activity.captureMessages(conversation))
      capturedDigest = currentDigest;
  };
}

/** A pull repeats unchanged candidates until the adapter commits its checkpoint. */
export function createOpenCodeV2HistoryProjection(
  activity?: HistoryActivity,
): OpenCodeV2HistoryProjection {
  let known = new Map<string, KnownCandidate>();
  let pending: PendingProjection | undefined;
  let pendingStart = -1;
  const capture = conversationCapture(activity);
  const activeSignals = new Map<string, CodingSafeActivitySignal>();
  const live = createOpenCodeV2LiveText();
  return {
    project(sessionId, messages, checkpoint): readonly OpenCodeReconciliationEvent[] {
      const position = checkpoint ?? -1;
      if (pending !== undefined && position === pendingStart + pending.events.length) {
        known = new Map(pending.nextKnown);
        pending = undefined;
      }
      if (pending !== undefined && position !== pendingStart) {
        throw new Error("opencode-v2-checkpoint-invalid");
      }
      if (pending === undefined) {
        const candidates = allCandidates(sessionId, messages, live);
        pending = makePending(sessionId, position, known, candidates);
        capture(candidates);
        recordHistoryProjection(activity, pending, live);
        recordNativeQuestions(activity, pending);
      }
      pendingStart = position;
      for (const [key, signal] of pending.signals) activeSignals.set(key, signal);
      return pending.events;
    },
    takeSignal(event): CodingSafeActivitySignal | undefined {
      const key = `${event.aggregateId}\u0000${String(event.sequence)}`;
      const signal = activeSignals.get(key);
      activeSignals.delete(key);
      return signal;
    },
    clearSignals(): void {
      activeSignals.clear();
    },
    observeLiveEvent(sessionId, event): void {
      live.observe(sessionId, event);
    },
    freezeLiveText(): void {
      live.freeze();
    },
  };
}
