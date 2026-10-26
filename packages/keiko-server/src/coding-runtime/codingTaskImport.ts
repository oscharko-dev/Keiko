import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  CODING_TASK_EXPORT_SCHEMA,
  CODING_TASK_EXPORT_SCHEMA_VERSION,
  CODING_TASK_IMPORT_MAX_MESSAGES,
  type CodingHistoryTask,
  type CodingTaskImportResponse,
  type CodingTaskImportSource,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  redactAbsolutePaths,
  stripUnsafeFormatChars,
} from "@oscharko-dev/keiko-contracts/runtime/text-safety";
import { contentFreeErrorClass } from "../diagnostics-log.js";
import {
  codingHistoryChunkEnd,
  type CodingHistoryImportedMessage,
} from "../store/codingHistory.js";

/**
 * The user-controlled local import of one saved task (#3904 AC4, parity S05): the counterpart of the
 * export, and of OpenCode's `session import`. The human picks a file; it becomes a new task of this
 * operator in the active workspace. Two files are read: Keiko's own task export, and the transcript
 * an earlier OpenCode release wrote with `opencode export`. The file is untrusted historical data:
 * only the conversation's text is taken, each string is stripped of invisible format characters and
 * redacted again, and the task never carries the file's ids, runs, paths, tools or settings. It has
 * no run of its own, so continuing it starts a fork that carries the conversation as context.
 */

const IMPORT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.history.import",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingTaskImport.recordImport",
  fields: {
    event: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["requested", "completed", "refused"],
    },
    source: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["keiko-task-export", "opencode-session"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "unauthenticated",
        "unavailable",
        "no-workspace",
        "invalid-document",
        "unsupported-version",
        "too-large",
        "empty",
        "failed",
      ],
    },
    conversationId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    messageCount: { type: "integer", dataClass: "count", required: false },
    omittedMessageCount: { type: "integer", dataClass: "count", required: false },
    skippedMessageCount: { type: "integer", dataClass: "count", required: false },
    redactedMessageCount: { type: "integer", dataClass: "count", required: false },
    byteCount: { type: "integer", dataClass: "count", required: false },
    errorClass: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    frames: {
      type: "string-array",
      dataClass: "safe-platform-class",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-history-persistence"],
  proofIds: ["coding-runtime.history.import.emitted-line"],
  releaseImpact: "minor",
});

/** Why a request ended without a task; closed, and the whole of what the Activity Log says. */
export type CodingTaskImportRefusal =
  | "unauthenticated"
  | "unavailable"
  | "no-workspace"
  | "invalid-document"
  | "unsupported-version"
  | "too-large"
  | "empty"
  | "failed";

const REFUSAL_ERROR_KIND: Readonly<Record<CodingTaskImportRefusal, ActivityLogErrorKind>> = {
  unauthenticated: "authority-denied",
  unavailable: "unavailable",
  "no-workspace": "unavailable",
  "invalid-document": "invalid-request",
  "unsupported-version": "invalid-request",
  "too-large": "invalid-request",
  empty: "invalid-request",
  failed: "internal",
};

interface ImportLogInput {
  readonly correlationId: string;
  readonly source?: CodingTaskImportSource;
  readonly reason?: CodingTaskImportRefusal;
  readonly conversationId?: string;
  readonly messageCount?: number;
  readonly omittedMessageCount?: number;
  readonly skippedMessageCount?: number;
  readonly redactedMessageCount?: number;
  readonly byteCount?: number;
  readonly error?: unknown;
}

function recordImport(
  log: ServerLogSink | undefined,
  event: "requested" | "completed" | "refused",
  input: ImportLogInput,
): void {
  const { correlationId, reason, error, ...fields } = input;
  const refused = event === "refused";
  const incomplete = refused || (input.omittedMessageCount ?? 0) > 0;
  log?.write(
    activityLogEvent(
      IMPORT_OPERATION,
      {
        correlationId,
        ...(refused
          ? ({ level: "warn", errorKind: REFUSAL_ERROR_KIND[reason ?? "failed"] } as const)
          : {}),
      },
      {
        event,
        ...fields,
        ...(reason === undefined ? {} : { reason }),
        ...(error === undefined
          ? {}
          : {
              errorClass: contentFreeErrorClass(error),
              frames: keikoStackFrames(error),
              causeChain: causeChain(error),
            }),
        completeness: incomplete ? "partial" : "complete",
        loss: incomplete ? "event-dropped" : "none",
      },
    ),
  );
}

/** One message of the file, before it is cleaned; `timestamp` is what the file claims. */
interface FileMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp?: number;
}

export type CodingTaskImportParse =
  | {
      readonly kind: "parsed";
      readonly source: CodingTaskImportSource;
      readonly title: string | undefined;
      readonly messages: readonly FileMessage[];
      /** Messages the file holds that carry no conversation text: system lines, tool-only turns. */
      readonly skipped: number;
    }
  | { readonly kind: "refused"; readonly reason: "invalid-document" | "unsupported-version" };

const INVALID = { kind: "refused", reason: "invalid-document" } as const;
// The keys Keiko's own export writes (schema version 1); a file with any other key was not written
// by this export and is refused rather than half-read.
const EXPORT_KEYS: ReadonlySet<string> = new Set([
  "schema",
  "schemaVersion",
  "generator",
  "exportedAt",
  "handling",
  "task",
  "messageCount",
  "omittedMessageCount",
  "truncated",
  "messages",
]);
const EXPORT_MESSAGE_KEYS: ReadonlySet<string> = new Set([
  "index",
  "role",
  "text",
  "timestamp",
  "runId",
]);
// The latest instant a JavaScript date can hold.
const MAX_INSTANT = 8.64e15;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closedKeys(value: Readonly<Record<string, unknown>>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function instant(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 && value <= MAX_INSTANT ? value : undefined;
}

function withTime(
  role: FileMessage["role"],
  text: string,
  timestamp: number | undefined,
): FileMessage {
  return { role, text, ...(timestamp === undefined ? {} : { timestamp }) };
}

// A conversation role, a system line that carries no conversation, or a malformed role.
function exportRole(role: unknown): FileMessage["role"] | "skipped" | undefined {
  if (role === "user" || role === "assistant") return role;
  return role === "system" ? "skipped" : undefined;
}

function exportInstant(timestamp: string | undefined): number | undefined {
  return timestamp === undefined ? undefined : instant(Date.parse(timestamp));
}

/** One message of Keiko's export; `skipped` for a system line, `undefined` when malformed. */
function exportMessage(entry: unknown): FileMessage | "skipped" | undefined {
  if (!isRecord(entry) || !closedKeys(entry, EXPORT_MESSAGE_KEYS)) return undefined;
  const { text, timestamp } = entry;
  if (typeof text !== "string" || (timestamp !== undefined && typeof timestamp !== "string"))
    return undefined;
  const role = exportRole(entry.role);
  if (role === undefined || role === "skipped") return role;
  if (text.trim().length === 0) return "skipped";
  return withTime(role, text, exportInstant(timestamp));
}

function parseExport(document: Readonly<Record<string, unknown>>): CodingTaskImportParse {
  if (document.schemaVersion !== CODING_TASK_EXPORT_SCHEMA_VERSION)
    return { kind: "refused", reason: "unsupported-version" };
  const { task, messages } = document;
  if (!closedKeys(document, EXPORT_KEYS) || !isRecord(task) || !Array.isArray(messages))
    return INVALID;
  if (typeof task.title !== "string") return INVALID;
  const kept: FileMessage[] = [];
  let skipped = 0;
  for (const entry of messages as readonly unknown[]) {
    const message = exportMessage(entry);
    if (message === undefined) return INVALID;
    if (message === "skipped") skipped += 1;
    else kept.push(message);
  }
  return {
    kind: "parsed",
    source: "keiko-task-export",
    title: task.title,
    messages: kept,
    skipped,
  };
}

/** The visible text of an OpenCode message: its text parts, without synthetic or ignored ones. */
function transcriptText(parts: readonly unknown[]): string | undefined {
  const texts: string[] = [];
  for (const part of parts) {
    if (!isRecord(part) || typeof part.type !== "string") return undefined;
    if (part.type !== "text" || part.synthetic === true || part.ignored === true) continue;
    if (typeof part.text !== "string") return undefined;
    texts.push(part.text);
  }
  return texts.join("\n\n");
}

function transcriptMessage(entry: unknown): FileMessage | "skipped" | undefined {
  if (!isRecord(entry) || !isRecord(entry.info) || !Array.isArray(entry.parts)) return undefined;
  const text = transcriptText(entry.parts as readonly unknown[]);
  if (text === undefined) return undefined;
  const { role, time } = entry.info;
  if ((role !== "user" && role !== "assistant") || text.trim().length === 0) return "skipped";
  return withTime(role, text, transcriptInstant(time));
}

function transcriptInstant(time: unknown): number | undefined {
  return isRecord(time) && typeof time.created === "number" ? instant(time.created) : undefined;
}

function parseTranscript(document: Readonly<Record<string, unknown>>): CodingTaskImportParse {
  const { info, messages } = document;
  if (!isRecord(info) || !Array.isArray(messages)) return INVALID;
  const kept: FileMessage[] = [];
  let skipped = 0;
  for (const entry of messages as readonly unknown[]) {
    const message = transcriptMessage(entry);
    if (message === undefined) return INVALID;
    if (message === "skipped") skipped += 1;
    else kept.push(message);
  }
  const title = typeof info.title === "string" ? info.title : undefined;
  return { kind: "parsed", source: "opencode-session", title, messages: kept, skipped };
}

/** Reads a parsed file as one of the two supported documents, or refuses it whole. */
export function parseCodingTaskImport(value: unknown): CodingTaskImportParse {
  if (!isRecord(value)) return INVALID;
  if ("schema" in value)
    return value.schema === CODING_TASK_EXPORT_SCHEMA ? parseExport(value) : INVALID;
  return parseTranscript(value);
}

/** What is stored: the cleaned title and the newest messages, oldest first. */
export interface CodingTaskImportTask {
  readonly title: string;
  readonly messages: readonly CodingHistoryImportedMessage[];
}

interface BuiltImport {
  readonly task: CodingTaskImportTask;
  readonly omitted: number;
  readonly redacted: number;
}

const TITLE_MAX_CHARS = 100;
const FALLBACK_TITLE = "Imported task";

function cleaner(redactText: (value: string) => string): (value: string) => string {
  return (value) => redactAbsolutePaths(redactText(stripUnsafeFormatChars(value)));
}

/** One display line of at most 100 UTF-16 units that ends on a whole character. */
function importedTitle(title: string | undefined, clean: (value: string) => string): string {
  const line = clean(title ?? "")
    .replaceAll(/\s+/gu, " ")
    .trim();
  let end = Math.min(line.length, TITLE_MAX_CHARS);
  if (end < line.length && (line.codePointAt(end - 1) ?? 0) > 0xffff) end -= 1;
  const bounded = line.slice(0, end).trim();
  return bounded.length > 0 ? bounded : FALLBACK_TITLE;
}

/** A message longer than one stored message is kept whole as consecutive stored messages. */
function chunked(message: FileMessage, text: string): readonly CodingHistoryImportedMessage[] {
  const chunks: CodingHistoryImportedMessage[] = [];
  for (let offset = 0; offset < text.length;) {
    const end = codingHistoryChunkEnd(text, offset);
    chunks.push({ role: message.role, content: text.slice(offset, end) });
    offset = end;
  }
  return chunks;
}

/**
 * Coding History lists a task's messages by time, so a file's times are kept only as a
 * non-decreasing sequence no later than now; a message without one takes its predecessor's.
 */
function ordered(
  messages: readonly {
    readonly message: FileMessage;
    readonly stored: CodingHistoryImportedMessage;
  }[],
  now: number,
): readonly CodingHistoryImportedMessage[] {
  const first = messages.find(({ message }) => message.timestamp !== undefined)?.message.timestamp;
  if (first === undefined) return messages.map(({ stored }) => stored);
  let running = Math.min(first, now);
  return messages.map(({ message, stored }) => {
    running = Math.min(Math.max(running, message.timestamp ?? running), now);
    return { ...stored, timestamp: running };
  });
}

function buildImport(
  parsed: Extract<CodingTaskImportParse, { kind: "parsed" }>,
  redactText: (value: string) => string,
  now: number,
): BuiltImport {
  const clean = cleaner(redactText);
  let redacted = 0;
  const stored = parsed.messages.flatMap((message) => {
    const text = clean(message.text);
    if (text !== message.text) redacted += 1;
    return chunked(message, text).map((chunk) => ({ message, stored: chunk }));
  });
  const kept = stored.slice(Math.max(0, stored.length - CODING_TASK_IMPORT_MAX_MESSAGES));
  return {
    task: { title: importedTitle(parsed.title, clean), messages: ordered(kept, now) },
    omitted: stored.length - kept.length,
    redacted,
  };
}

export type CodingTaskImportBody =
  { readonly kind: "read"; readonly text: string } | { readonly kind: "too-large" };

/** Where the task goes; resolved by the caller before the file is read. */
export type CodingTaskImportTarget =
  ((task: CodingTaskImportTask) => CodingHistoryTask) | "unavailable" | "no-workspace";

export interface CodingTaskImportPorts {
  readonly target: CodingTaskImportTarget;
  readonly readBody: () => Promise<CodingTaskImportBody>;
  /** The product's evidence redactor: built-in secret shapes plus the live configured literals. */
  readonly redactText: (value: string) => string;
  readonly now: () => number;
}

export interface CodingTaskImportRequest {
  readonly correlationId: string;
  /** False when the caller holds no valid app session; the file is then never read. */
  readonly authenticated: boolean;
}

export type CodingTaskImportResult =
  | { readonly kind: "imported"; readonly response: CodingTaskImportResponse }
  | { readonly kind: "refused"; readonly reason: CodingTaskImportRefusal };

function recordRefusal(
  log: ServerLogSink | undefined,
  request: CodingTaskImportRequest,
  reason: CodingTaskImportRefusal,
  extra: Partial<ImportLogInput> = {},
): CodingTaskImportResult {
  recordImport(log, "refused", { correlationId: request.correlationId, reason, ...extra });
  return { kind: "refused", reason };
}

async function importFile(
  log: ServerLogSink | undefined,
  request: CodingTaskImportRequest,
  ports: CodingTaskImportPorts,
  store: (task: CodingTaskImportTask) => CodingHistoryTask,
): Promise<CodingTaskImportResult> {
  const body = await ports.readBody();
  if (body.kind === "too-large") return recordRefusal(log, request, "too-large");
  const byteCount = Buffer.byteLength(body.text);
  let value: unknown;
  try {
    value = JSON.parse(body.text) as unknown;
  } catch {
    // A file that is not JSON is an invalid document.
    return recordRefusal(log, request, INVALID.reason, { byteCount });
  }
  const parsed = parseCodingTaskImport(value);
  if (parsed.kind === "refused") return recordRefusal(log, request, parsed.reason, { byteCount });
  const { source, skipped } = parsed;
  const built = buildImport(parsed, ports.redactText, ports.now());
  if (built.task.messages.length === 0)
    return recordRefusal(log, request, "empty", {
      source,
      byteCount,
      skippedMessageCount: skipped,
    });
  const task = store(built.task);
  const counts = {
    messageCount: built.task.messages.length,
    omittedMessageCount: built.omitted,
    skippedMessageCount: skipped,
  };
  recordImport(log, "completed", {
    correlationId: request.correlationId,
    source,
    conversationId: task.id,
    ...counts,
    redactedMessageCount: built.redacted,
    byteCount,
  });
  return { kind: "imported", response: { task, source, ...counts } };
}

/**
 * Runs one import request end to end and records it: a `requested` line first, then exactly one
 * `completed` or `refused` line under the same correlation id. Nothing is read before the caller
 * proved an app session and a workspace to import into.
 */
export async function runCodingTaskImport(
  log: ServerLogSink | undefined,
  request: CodingTaskImportRequest,
  ports: CodingTaskImportPorts,
): Promise<CodingTaskImportResult> {
  recordImport(log, "requested", { correlationId: request.correlationId });
  if (!request.authenticated) return recordRefusal(log, request, "unauthenticated");
  const { target } = ports;
  if (typeof target === "string") return recordRefusal(log, request, target);
  try {
    return await importFile(log, request, ports, target);
  } catch (error) {
    return recordRefusal(log, request, "failed", { error });
  }
}
