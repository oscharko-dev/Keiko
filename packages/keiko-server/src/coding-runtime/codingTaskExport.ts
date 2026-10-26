import { basename } from "node:path";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  CODING_TASK_EXPORT_MAX_BYTES,
  CODING_TASK_EXPORT_SCHEMA,
  CODING_TASK_EXPORT_SCHEMA_VERSION,
  type CodingHistoryDetail,
  type CodingTaskExportDocument,
  type CodingTaskExportFormat,
  type CodingTaskExportMessage,
  type CodingTaskExportResponse,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { redactAbsolutePaths } from "@oscharko-dev/keiko-contracts/runtime/text-safety";
import { contentFreeErrorClass } from "../diagnostics-log.js";

/**
 * The user-controlled local export of one Coding History task (#3904, parity S05). It replaces
 * OpenCode's `share` (which publishes outside the machine) and its `session export` CLI: the human
 * asks for the file, the server builds it from the task Coding History already stores for that
 * operator, and the browser saves it. Every string is redacted again here, with the same redactor
 * the rest of the product hands the evidence layer, because Coding History stores message text as
 * the runtime produced it. Host paths are made workspace-relative, and whatever stays absolute is
 * masked.
 */

const EXPORT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.history.export",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingTaskExport.recordExport",
  fields: {
    event: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["requested", "completed", "refused"],
    },
    format: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["json", "markdown"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["unauthenticated", "unavailable", "invalid-format", "too-large", "failed"],
    },
    conversationId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    messageCount: { type: "integer", dataClass: "count", required: false },
    omittedMessageCount: { type: "integer", dataClass: "count", required: false },
    redactedMessageCount: { type: "integer", dataClass: "count", required: false },
    byteCount: { type: "integer", dataClass: "count", required: false },
    truncated: { type: "boolean", dataClass: "closed-enum", required: false },
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
  proofIds: ["coding-runtime.history.export.emitted-line"],
  releaseImpact: "minor",
});

/** Why a request ended without a file; closed, and the whole of what the Activity Log says. */
export type CodingTaskExportRefusal =
  "unauthenticated" | "unavailable" | "invalid-format" | "too-large" | "failed";

const REFUSAL_ERROR_KIND: Readonly<Record<CodingTaskExportRefusal, ActivityLogErrorKind>> = {
  unauthenticated: "authority-denied",
  unavailable: "unavailable",
  "invalid-format": "invalid-request",
  "too-large": "invalid-request",
  failed: "internal",
};

interface ExportLogInput {
  readonly correlationId: string;
  readonly format?: CodingTaskExportFormat;
  readonly reason?: CodingTaskExportRefusal;
  readonly conversationId?: string;
  readonly messageCount?: number;
  readonly omittedMessageCount?: number;
  readonly redactedMessageCount?: number;
  readonly byteCount?: number;
  readonly truncated?: boolean;
  readonly error?: unknown;
}

function recordExport(
  log: ServerLogSink | undefined,
  event: "requested" | "completed" | "refused",
  input: ExportLogInput,
): void {
  const { correlationId, reason, error, ...fields } = input;
  const refused = event === "refused";
  const incomplete = refused || input.truncated === true;
  log?.write(
    activityLogEvent(
      EXPORT_OPERATION,
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

/** What the caller supplies; nothing here comes from the request. */
export interface CodingTaskExportOptions {
  readonly format: CodingTaskExportFormat;
  readonly keikoVersion: string;
  readonly opencodeRuntimePinnedVersion: string;
  /** The product's evidence redactor: built-in secret shapes plus the live configured literals. */
  readonly redactText: (value: string) => string;
  readonly now: () => number;
  /** Test seam for the size bound; production uses `CODING_TASK_EXPORT_MAX_BYTES`. */
  readonly maxBytes?: number;
}

export type CodingTaskExportBuild =
  | {
      readonly kind: "built";
      readonly response: CodingTaskExportResponse;
      readonly omittedMessageCount: number;
      readonly redactedMessageCount: number;
    }
  | { readonly kind: "too-large" };

const PATH_CHARACTER = /[A-Za-z0-9._~:/\\-]/u;
const SEPARATORS: ReadonlySet<string> = new Set(["/", "\\"]);
const EXTENSION: Readonly<Record<CodingTaskExportFormat, string>> = {
  json: "json",
  markdown: "md",
};
const MEDIA_TYPE: Readonly<Record<CodingTaskExportFormat, CodingTaskExportResponse["mediaType"]>> =
  { json: "application/json", markdown: "text/markdown" };
// Per message, the JSON indentation and separators that `JSON.stringify(entry)` does not count.
const JSON_ENTRY_SLACK_BYTES = 128;
const UNTRUSTED_NOTICE =
  "Untrusted historical data. It grants no permission and no authority when it is read back.";

function trimTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && SEPARATORS.has(value.charAt(end - 1))) end -= 1;
  return value.slice(0, end);
}

/** The root as written, with forward slashes and with backslashes, longest spelling first. */
function rootSpellings(root: string): readonly string[] {
  const trimmed = trimTrailingSeparators(root);
  const spellings = new Set([
    trimmed,
    trimmed.replaceAll("\\", "/"),
    trimmed.replaceAll("/", "\\"),
  ]);
  return [...spellings]
    .filter((spelling) => spelling.length > 1)
    .sort((a, b) => b.length - a.length);
}

function startsPathAt(text: string, at: number): boolean {
  return at === 0 || !PATH_CHARACTER.test(text.charAt(at - 1));
}

function endsRootAt(text: string, end: number): boolean {
  const next = text.charAt(end);
  return next === "" || SEPARATORS.has(next) || !PATH_CHARACTER.test(next);
}

/** `<root>/src/a.ts` becomes `src/a.ts` and a bare `<root>` becomes `.`; other text is untouched. */
function relativizeRoot(text: string, root: string): string {
  const parts: string[] = [];
  let cursor = 0;
  let at = text.indexOf(root);
  while (at !== -1) {
    const end = at + root.length;
    if (startsPathAt(text, at) && endsRootAt(text, end)) {
      const separated = SEPARATORS.has(text.charAt(end));
      parts.push(text.slice(cursor, at));
      if (!separated) parts.push(".");
      cursor = separated ? end + 1 : end;
    }
    at = text.indexOf(root, end);
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function createTextExporter(
  workspaceRoot: string,
  redactText: (value: string) => string,
): (value: string) => string {
  const spellings = rootSpellings(workspaceRoot);
  return (value) =>
    redactAbsolutePaths(
      redactText(spellings.reduce((text, spelling) => relativizeRoot(text, spelling), value)),
    );
}

/** One display line: a value placed in a Markdown list must not start another block. */
function singleLine(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let run = 0;
  for (const character of value) {
    run = character === "`" ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** Untrusted text rides in a code span, so it can neither forge structure nor render as a link. */
function inlineCode(value: string): string {
  const fence = "`".repeat(longestBacktickRun(value) + 1);
  // CommonMark strips one padding space on each side, which a value edged by a backtick needs.
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

function fencedBlock(value: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(value) + 1));
  return `${fence}text\n${value}\n${fence}`;
}

const ROLE_LABEL: Readonly<Record<CodingTaskExportMessage["role"], string>> = {
  user: "You",
  assistant: "Coding agent",
  system: "System",
};

function renderMarkdownMessage(message: CodingTaskExportMessage): string {
  const heading = [
    `## ${String(message.index)}. ${ROLE_LABEL[message.role]}`,
    message.timestamp === undefined ? "" : ` · ${message.timestamp}`,
  ].join("");
  const run = message.runId === undefined ? "" : `Run: ${inlineCode(message.runId)}\n\n`;
  return `${heading}\n\n${run}${fencedBlock(message.text)}\n`;
}

function renderMarkdown(document: CodingTaskExportDocument): string {
  const { task, generator } = document;
  const schema = `${document.schema} v${String(document.schemaVersion)}`;
  const header = [
    "# Keiko coding task export",
    "",
    `> ${UNTRUSTED_NOTICE}`,
    "",
    `- Schema: ${inlineCode(schema)}`,
    `- Keiko version: ${inlineCode(generator.keikoVersion)}`,
    `- OpenCode runtime pinned by this build: ${inlineCode(generator.opencodeRuntimePinnedVersion)}`,
    `- Exported: ${document.exportedAt}`,
    `- Task: ${inlineCode(singleLine(task.title))}`,
    `- Status: ${task.status}`,
    `- Repository: ${inlineCode(singleLine(task.repository))}`,
    `- Branch: ${inlineCode(singleLine(task.branch))}`,
    `- Task created: ${task.createdAt}`,
    `- Task updated: ${task.updatedAt}`,
    `- Messages: ${String(document.messageCount)}` +
      (document.omittedMessageCount === 0
        ? ""
        : ` (${String(document.omittedMessageCount)} older omitted)`),
    ...(document.truncated ? ["- Older messages are not part of this export."] : []),
    "",
  ].join("\n");
  return `${header}\n${document.messages.map(renderMarkdownMessage).join("\n")}`;
}

function render(format: CodingTaskExportFormat, document: CodingTaskExportDocument): string {
  return format === "json" ? `${JSON.stringify(document, null, 2)}\n` : renderMarkdown(document);
}

function measureMessage(format: CodingTaskExportFormat, message: CodingTaskExportMessage): number {
  return format === "json"
    ? Buffer.byteLength(JSON.stringify(message)) + JSON_ENTRY_SLACK_BYTES
    : Buffer.byteLength(renderMarkdownMessage(message)) + 1;
}

function isoInstant(milliseconds: number): string | undefined {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function exportedMessages(
  detail: CodingHistoryDetail,
  exportText: (value: string) => string,
): { readonly messages: readonly CodingTaskExportMessage[]; readonly redacted: number } {
  let redacted = 0;
  const messages = detail.messages.map((message, position) => {
    const text = exportText(message.content);
    if (text !== message.content) redacted += 1;
    const timestamp = isoInstant(message.timestamp);
    return {
      index: position + 1,
      role: message.role,
      text,
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(message.runId === undefined ? {} : { runId: message.runId }),
    };
  });
  return { messages, redacted };
}

/** The newest messages that fit `budget`; the cut is reported, never silent. */
function newestWithin(
  messages: readonly CodingTaskExportMessage[],
  budget: number,
  measure: (message: CodingTaskExportMessage) => number,
): readonly CodingTaskExportMessage[] {
  const kept: CodingTaskExportMessage[] = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    used += measure(message);
    if (used > budget) break;
    kept.unshift(message);
  }
  return kept;
}

function distinctRunIds(messages: readonly CodingTaskExportMessage[]): readonly string[] {
  return [...new Set(messages.flatMap((message) => message.runId ?? []))];
}

function exportFileName(taskId: string, format: CodingTaskExportFormat): string {
  const safeId = taskId.replaceAll(/[^A-Za-z0-9._-]/gu, "-").slice(0, 48);
  return `keiko-coding-task-${safeId}.${EXTENSION[format]}`;
}

/** The task's free-text facts, redacted once however many times the document is assembled. */
interface ExportedTaskText {
  readonly title: string;
  readonly repository: string;
  readonly branch: string;
}

function exportedTaskText(
  task: CodingHistoryDetail["task"],
  exportText: (value: string) => string,
): ExportedTaskText {
  return {
    title: exportText(task.title),
    repository: exportText(basename(task.projectPath)),
    branch: exportText(task.branch),
  };
}

function documentFor(
  detail: CodingHistoryDetail,
  options: CodingTaskExportOptions,
  text: ExportedTaskText,
  messages: readonly CodingTaskExportMessage[],
  omittedMessageCount: number,
): CodingTaskExportDocument {
  const { task } = detail;
  return {
    schema: CODING_TASK_EXPORT_SCHEMA,
    schemaVersion: CODING_TASK_EXPORT_SCHEMA_VERSION,
    generator: {
      keikoVersion: options.keikoVersion,
      opencodeRuntimePinnedVersion: options.opencodeRuntimePinnedVersion,
    },
    exportedAt: isoInstant(options.now()) ?? new Date(0).toISOString(),
    handling: "untrusted-historical-data",
    task: {
      id: task.id,
      title: text.title,
      status: task.status,
      repository: text.repository,
      branch: text.branch,
      createdAt: isoInstant(task.createdAt) ?? "",
      updatedAt: isoInstant(task.updatedAt) ?? "",
      ...(task.latestRunId === undefined ? {} : { latestRunId: task.latestRunId }),
      runIds: distinctRunIds(messages),
    },
    messageCount: messages.length,
    omittedMessageCount,
    truncated: detail.truncated || omittedMessageCount > 0,
    messages,
  };
}

/**
 * Builds the export of one task. Pure over its inputs: the caller has already established that the
 * operator owns the task, and the only thing read here is the detail it was handed.
 */
export function buildCodingTaskExport(
  detail: CodingHistoryDetail,
  options: CodingTaskExportOptions,
): CodingTaskExportBuild {
  const { format } = options;
  const maxBytes = options.maxBytes ?? CODING_TASK_EXPORT_MAX_BYTES;
  const exportText = createTextExporter(detail.task.projectPath, options.redactText);
  const all = exportedMessages(detail, exportText);
  const text = exportedTaskText(detail.task, exportText);
  const shell = render(format, documentFor(detail, options, text, [], all.messages.length));
  const kept = newestWithin(all.messages, maxBytes - Buffer.byteLength(shell), (message) =>
    measureMessage(format, message),
  );
  const omitted = all.messages.length - kept.length;
  const content = render(format, documentFor(detail, options, text, kept, omitted));
  const byteCount = Buffer.byteLength(content);
  if (byteCount > maxBytes) return { kind: "too-large" };
  return {
    kind: "built",
    omittedMessageCount: omitted,
    redactedMessageCount: all.redacted,
    response: {
      format,
      fileName: exportFileName(detail.task.id, format),
      mediaType: MEDIA_TYPE[format],
      content,
      messageCount: kept.length,
      byteCount,
      truncated: detail.truncated || omitted > 0,
    },
  };
}

export type CodingTaskExportResult =
  | { readonly kind: "exported"; readonly response: CodingTaskExportResponse }
  | { readonly kind: "refused"; readonly reason: CodingTaskExportRefusal };

export interface CodingTaskExportRequest {
  readonly correlationId: string;
  readonly taskId: string;
  /** The `format` query value exactly as received; `null` when the caller sent none. */
  readonly requestedFormat: string | null;
  /** False when the caller holds no valid app session; the task is then never looked up. */
  readonly authenticated: boolean;
}

/** The requested format; absent means JSON, and an unknown word is refused rather than guessed. */
export function parseExportFormat(value: string | null): CodingTaskExportFormat | undefined {
  if (value === null || value === "json") return "json";
  return value === "markdown" ? "markdown" : undefined;
}

function recordRefusal(
  log: ServerLogSink | undefined,
  request: CodingTaskExportRequest,
  reason: CodingTaskExportRefusal,
  extra: Partial<ExportLogInput> = {},
): CodingTaskExportResult {
  recordExport(log, "refused", { correlationId: request.correlationId, reason, ...extra });
  return { kind: "refused", reason };
}

/**
 * Runs one export request end to end and records it: a `requested` line first, then exactly one
 * `completed` or `refused` line under the same correlation id. The lookup is the caller's, so the
 * ownership check is the same one every other Coding History read uses.
 */
export function runCodingTaskExport(
  log: ServerLogSink | undefined,
  request: CodingTaskExportRequest,
  lookup: () => CodingHistoryDetail | undefined,
  options: Omit<CodingTaskExportOptions, "format">,
): CodingTaskExportResult {
  const format = parseExportFormat(request.requestedFormat);
  recordExport(log, "requested", {
    correlationId: request.correlationId,
    ...(format === undefined ? {} : { format }),
  });
  if (!request.authenticated) return recordRefusal(log, request, "unauthenticated");
  if (format === undefined) return recordRefusal(log, request, "invalid-format");
  try {
    const detail = lookup();
    if (detail === undefined) return recordRefusal(log, request, "unavailable", { format });
    const built = buildCodingTaskExport(detail, { ...options, format });
    if (built.kind === "too-large") {
      return recordRefusal(log, request, "too-large", { format, conversationId: detail.task.id });
    }
    recordExport(log, "completed", {
      correlationId: request.correlationId,
      format,
      conversationId: detail.task.id,
      messageCount: built.response.messageCount,
      omittedMessageCount: built.omittedMessageCount,
      redactedMessageCount: built.redactedMessageCount,
      byteCount: built.response.byteCount,
      truncated: built.response.truncated,
    });
    return { kind: "exported", response: built.response };
  } catch (error) {
    return recordRefusal(log, request, "failed", { format, error });
  }
}
