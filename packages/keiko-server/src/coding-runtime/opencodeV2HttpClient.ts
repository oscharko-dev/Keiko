import {
  CODING_WORKBENCH_PROMPT_REFERENCES_MAX,
  isCodingWorkbenchAgent,
  isCodingWorkbenchCommandName,
  isCodingWorkbenchPromptDelivery,
  type CodingWorkbenchAgent,
  type CodingWorkbenchPromptDelivery,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import { SHELL_BLOCK_MARKER } from "./codingRuntimeRepositoryItemSanitizer.js";
import { OPENCODE_HISTORY_RESPONSE_MAX_BYTES } from "./opencodeProtocol.js";

const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,251}$/u;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,256}$/u;
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{1,251}$/u;
const MAX_JSON_BYTES = OPENCODE_HISTORY_RESPONSE_MAX_BYTES;
/**
 * The ceiling on one prompt's text as the sidecar receives it: the initial context, the `\n\n`
 * separator and the human task intent together. Exported so the server-side composition of that
 * context (`codingRuntimeRepositoryInstructions.ts`) can yield before the client refuses the turn.
 */
export const OPENCODE_PROMPT_TEXT_MAX_BYTES = 65_536;
/** One referenced file's ceiling, in the file's own bytes. */
export const OPENCODE_PROMPT_FILE_MAX_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = OPENCODE_PROMPT_TEXT_MAX_BYTES;
// History reads share the sidecar's event loop with tool execution. A burst of parallel tools may
// delay its local HTTP response without making the run unhealthy; keep a bounded scheduling margin.
const DEFAULT_TIMEOUT_MS = 30_000;
const MESSAGE_PAGE_SIZE = 100;
const MAX_MESSAGE_PAGES = 64;
const MAX_MESSAGES = 4096;
const MAX_EVENT_FRAME_BYTES = 1024 * 1024;
const MAX_DIFF_FILES = 4096;
const MAX_DIFF_PATH_CHARS = 4096;

export interface OpenCodeV2HttpClientOptions {
  readonly endpoint: string;
  readonly password: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface OpenCodeV2PromptDisplay {
  readonly displayText: string;
  readonly hiddenContextSha256: string;
}

/**
 * One file attached to a prompt (`PromptInput.FileAttachment` of the pinned 2.1.4 schema, reduced to
 * the two fields Keiko sends): the absolute `file://` URI the runtime reads and the name it shows the
 * model. Which file may be named is decided before this client (`opencodePromptInputs.ts`); the
 * client only keeps the wire shape closed.
 */
/**
 * One attached file: the bytes Keiko admitted, inline as a `data:text/plain;base64,` URI, and the
 * file's name. Never a path the runtime would open again, which a link swapped in after admission
 * could redirect (#3897 review).
 */
export interface OpenCodeV2PromptFile {
  readonly uri: string;
  readonly name: string;
}

/**
 * The prompt inputs beyond the text. `delivery` sends the message into the turn that is running
 * (`steer`) or behind it (`queue`) instead of starting one; absent keeps the ordinary prompt.
 */
export interface OpenCodeV2PromptInputs {
  readonly delivery?: CodingWorkbenchPromptDelivery | undefined;
  readonly files?: readonly OpenCodeV2PromptFile[] | undefined;
  /**
   * The message's own id (`Session.Message.ID` of the pinned 2.1.4 schema, the prompt body's `id`).
   * The producer stores one input per id and answers a repeated post with the receipt it holds, so a
   * caller that resends the id after a lost acknowledgement does not create a second input. The
   * receipt must name this id, or the post fails with `OpenCodeV2ReceiptMismatchError`.
   */
  readonly id?: string | undefined;
}

/**
 * One slash command the runtime lists (`Command.Info` of the pinned 2.1.4 schema): its name and the
 * one-line description it gives, both untrusted display text. The command's template stays with the
 * runtime; Keiko never reads it.
 */
export interface OpenCodeV2Command {
  readonly name: string;
  readonly description?: string | undefined;
}

/**
 * The most commands one listing may hold before the client refuses it. The built-in set is two; the
 * bound only keeps a hostile or broken listing from growing the server's memory.
 */
const MAX_COMMANDS = 256;
const COMMAND_DESCRIPTION_MAX_CHARS = 1_024;

/**
 * The prompt was refused before any byte left: a bound or a shape the client itself checks. Nothing
 * reached the producer, so nothing can be accepted there.
 */
export class OpenCodeV2PromptRefusedError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenCodeV2PromptRefusedError";
  }
}

/** The producer answered with an HTTP error status; the status is the whole of what is kept. */
export class OpenCodeV2HttpStatusError extends Error {
  public constructor(public readonly status: number) {
    super("opencode-v2-response-invalid");
    this.name = "OpenCodeV2HttpStatusError";
  }
}

/** The producer accepted the prompt (HTTP 2xx) but its receipt does not name the id that was sent. */
export class OpenCodeV2ReceiptMismatchError extends Error {
  public constructor() {
    super("opencode-v2-prompt-receipt-mismatch");
    this.name = "OpenCodeV2ReceiptMismatchError";
  }
}

/**
 * What a failed prompt post tells about the producer's side, in the only three words a retry needs:
 * `not-submitted` (the client refused it before any byte left, or the producer refused it with a 4xx
 * status it declares for this route), `possibly-accepted` (anything else: the connection was lost or
 * timed out after the request was sent, a 5xx the route does not declare, a 2xx whose receipt could
 * not be read) and `receipt-mismatch` (accepted, under an id other than the one sent). Unknown
 * failures are `possibly-accepted`, never `not-submitted`: a retry that reuses the id is safe for
 * every accepted input, a retry that did not could duplicate one.
 */
export type OpenCodeV2PromptFailure = "not-submitted" | "possibly-accepted" | "receipt-mismatch";

export function classifyOpenCodeV2PromptFailure(error: unknown): OpenCodeV2PromptFailure {
  if (error instanceof OpenCodeV2PromptRefusedError) return "not-submitted";
  if (error instanceof OpenCodeV2ReceiptMismatchError) return "receipt-mismatch";
  if (error instanceof OpenCodeV2HttpStatusError && error.status >= 400 && error.status < 500) {
    return "not-submitted";
  }
  return "possibly-accepted";
}

/**
 * One file a session turn changed, in the closed shape Keiko reads. The runtime's patch text is
 * dropped at this boundary, so a diff can be counted and logged without ever carrying file content.
 */
export interface OpenCodeV2FileDiff {
  readonly file: string;
  readonly status: "added" | "deleted" | "modified";
  readonly additions: number;
  readonly deletions: number;
}

/** A staged revert: the user message the session was rewound to and the files that restored. */
export interface OpenCodeV2StagedRevert {
  readonly messageId: string;
  readonly files: readonly OpenCodeV2FileDiff[];
}

export interface OpenCodeV2HttpClient {
  info(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
  document(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
  events(signal: AbortSignal): AsyncIterable<Readonly<Record<string, unknown>>>;
  createSession(
    directory: string,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>>;
  sessions(signal?: AbortSignal): Promise<readonly Readonly<Record<string, unknown>>[]>;
  messages(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<readonly Readonly<Record<string, unknown>>[]>;
  prompt(
    sessionId: string,
    text: string,
    signal?: AbortSignal,
    display?: OpenCodeV2PromptDisplay,
    inputs?: OpenCodeV2PromptInputs,
  ): Promise<void>;
  /**
   * The slash commands the runtime offers right now (`GET /api/command`, operation `command.list`).
   * An entry whose name is not a bounded command name is dropped and never reaches a caller; a
   * description that is not bounded text is dropped from its entry.
   */
  commands(signal?: AbortSignal): Promise<readonly OpenCodeV2Command[]>;
  /**
   * Runs the session's next turn as a slash command (`POST /api/session/{sessionID}/command`,
   * operation `session.command`): the runtime expands the command's template with `text` as its
   * arguments and runs the turn. The body has no message id, so unlike a prompt the post cannot be
   * resent safely after a lost acknowledgement; a failure is final for the turn that sent it.
   * `files` are the same attachments a prompt carries.
   */
  command(
    sessionId: string,
    name: string,
    text: string,
    signal?: AbortSignal,
    inputs?: Pick<OpenCodeV2PromptInputs, "files">,
  ): Promise<void>;
  interrupt(sessionId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Switches the primary agent that runs the session's SUBSEQUENT provider turns
   * (`POST /api/session/{sessionID}/agent`, operation `session.switchAgent`). Only the closed
   * Workbench vocabulary is accepted; the runtime's own refusal (unknown session, unknown agent)
   * rejects, so a caller never reports a switch that did not happen.
   */
  switchAgent(sessionId: string, agent: CodingWorkbenchAgent, signal?: AbortSignal): Promise<void>;
  /**
   * The files the session's newest turn changed (`GET /api/session/{sessionID}/diff`, operation
   * `session.diff`), without their patch text. A step still running compares against the working copy.
   */
  sessionDiff(sessionId: string, signal?: AbortSignal): Promise<readonly OpenCodeV2FileDiff[]>;
  /**
   * Rewinds the session to just before a user message and restores the files its turn changed
   * (`POST /api/session/{sessionID}/revert/stage`, operation `session.revert.stage`). The revert is
   * only staged: the rewound messages stay recoverable until `commitRevert`, and `clearRevert`
   * re-applies the files. The runtime refuses a busy session (409).
   */
  stageRevert(
    sessionId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeV2StagedRevert>;
  /** Makes a staged revert final (`POST .../revert/commit`, `session.revert.commit`). */
  commitRevert(sessionId: string, signal?: AbortSignal): Promise<void>;
  /** Drops a staged revert and re-applies its files (`DELETE .../revert`, `session.revert.clear`). */
  clearRevert(sessionId: string, signal?: AbortSignal): Promise<void>;
  active(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
  permissions(signal?: AbortSignal): Promise<readonly Readonly<Record<string, unknown>>[]>;
  /** The producer's plugins and their load state (`GET /api/plugin`, operation `plugin.list`). */
  plugins(signal?: AbortSignal): Promise<readonly Readonly<Record<string, unknown>>[]>;
  forms(signal?: AbortSignal): Promise<readonly Readonly<Record<string, unknown>>[]>;
  replyForm(
    sessionId: string,
    formId: string,
    answer: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<void>;
  cancelForm(sessionId: string, formId: string, signal?: AbortSignal): Promise<void>;
  /**
   * `message` rides with a `reject`: OpenCode 2.0.10 hands it to the model as the correction for that
   * one call and its loop goes on, where a bare reject ends the turn (ADR-0124 D6).
   */
  replyPermission(
    sessionId: string,
    requestId: string,
    decision: "once" | "reject",
    message?: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export function parseOpenCodeV2ChildEndpoint(output: string): string | undefined {
  if (output.length > 1024) return undefined;
  // Both forms are emitted by the pinned native CLI. A single closed URL record carries no body.
  const match =
    /^(?:server listening on |\{"url":")http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(?:"\})?\n$/u.exec(
      output,
    );
  if (match === null || output.startsWith("{") !== output.endsWith('"}\n')) return undefined;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port <= 65_535
    ? `http://127.0.0.1:${String(port)}`
    : undefined;
}

function parseEndpoint(value: string): URL | undefined {
  if (!URL.canParse(value)) return undefined;
  const endpoint = new URL(value);
  return endpoint.protocol === "http:" &&
    endpoint.hostname === "127.0.0.1" &&
    endpoint.username === "" &&
    endpoint.password === "" &&
    endpoint.pathname === "/" &&
    endpoint.search === "" &&
    endpoint.hash === ""
    ? endpoint
    : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

async function boundedJson(response: Response): Promise<Readonly<Record<string, unknown>>> {
  if (response.status === 204) return {};
  if (!response.ok) throw new OpenCodeV2HttpStatusError(response.status);
  if (!(response.headers.get("content-type") ?? "").startsWith("application/json")) {
    throw new Error("opencode-v2-response-invalid");
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) {
    await response.body?.cancel();
    throw new Error("opencode-v2-response-oversized");
  }
  if (response.body === null) throw new Error("opencode-v2-response-invalid");
  const bytes = await readBoundedJsonBytes(response.body);
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(decoded);
  const parsed = record(value);
  if (parsed === undefined) throw new Error("opencode-v2-response-invalid");
  return parsed;
}

async function readBoundedJsonBytes(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > MAX_JSON_BYTES) throw new Error("opencode-v2-response-oversized");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function envelope(value: Readonly<Record<string, unknown>>): unknown {
  if (!("data" in value)) throw new Error("opencode-v2-envelope-invalid");
  return value.data;
}

function objectEnvelope(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const parsed = record(envelope(value));
  if (parsed === undefined) throw new Error("opencode-v2-envelope-invalid");
  return parsed;
}

function arrayEnvelope(
  value: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  const data = envelope(value);
  if (!Array.isArray(data) || !data.every((item: unknown) => record(item) !== undefined)) {
    throw new Error("opencode-v2-envelope-invalid");
  }
  return data as readonly Readonly<Record<string, unknown>>[];
}

function safeSessionId(value: string): string {
  if (!SESSION_ID.test(value)) throw new Error("opencode-v2-session-invalid");
  return value;
}

function safeCommandName(value: string): string {
  if (!isCodingWorkbenchCommandName(value)) throw new Error("opencode-v2-command-invalid");
  return value;
}

function commandDescription(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= COMMAND_DESCRIPTION_MAX_CHARS &&
    !hasControlCharacter(value)
    ? value
    : undefined;
}

/** Keeps the closed fields of every well-named entry; the rest of an entry is never copied. */
function commandEntries(
  entries: readonly Readonly<Record<string, unknown>>[],
): readonly OpenCodeV2Command[] {
  if (entries.length > MAX_COMMANDS) throw new Error("opencode-v2-envelope-invalid");
  return entries.flatMap((entry): readonly OpenCodeV2Command[] => {
    const name = entry.name;
    if (!isCodingWorkbenchCommandName(name)) return [];
    const description = commandDescription(entry.description);
    return [description === undefined ? { name } : { name, description }];
  });
}

function safeAgent(value: string): CodingWorkbenchAgent {
  if (!isCodingWorkbenchAgent(value)) throw new Error("opencode-v2-agent-invalid");
  return value;
}

function safeMessageId(value: string): string {
  if (!MESSAGE_ID.test(value)) throw new Error("opencode-v2-message-invalid");
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("opencode-v2-envelope-invalid");
  }
  return value;
}

function fileDiffStatus(value: unknown): OpenCodeV2FileDiff["status"] {
  if (value !== "added" && value !== "deleted" && value !== "modified") {
    throw new Error("opencode-v2-envelope-invalid");
  }
  return value;
}

/** Keeps only the closed fields of every entry; the patch text is never copied. */
function fileDiffs(value: unknown): readonly OpenCodeV2FileDiff[] {
  if (!Array.isArray(value) || value.length > MAX_DIFF_FILES) {
    throw new Error("opencode-v2-envelope-invalid");
  }
  return value.map((entry: unknown): OpenCodeV2FileDiff => {
    const diff = record(entry);
    const file = diff?.file;
    if (typeof file !== "string" || file.length === 0 || file.length > MAX_DIFF_PATH_CHARS) {
      throw new Error("opencode-v2-envelope-invalid");
    }
    return {
      file,
      status: fileDiffStatus(diff?.status),
      additions: nonNegativeInteger(diff?.additions),
      deletions: nonNegativeInteger(diff?.deletions),
    };
  });
}

function stagedRevert(value: Readonly<Record<string, unknown>>): OpenCodeV2StagedRevert {
  const messageId = value.messageID;
  if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) {
    throw new Error("opencode-v2-envelope-invalid");
  }
  return { messageId, files: value.files === undefined ? [] : fileDiffs(value.files) };
}

const PROMPT_FILE_DATA_PREFIX = "data:text/plain;base64,";
const PROMPT_FILE_DATA_MAX_CHARS =
  PROMPT_FILE_DATA_PREFIX.length + 4 * Math.ceil(OPENCODE_PROMPT_FILE_MAX_BYTES / 3);
const PROMPT_FILE_NAME_MAX_CHARS = 255;

/** The inline text attachment of a file's admitted bytes. */
export function openCodeV2PromptFileData(bytes: Buffer): string {
  return `${PROMPT_FILE_DATA_PREFIX}${bytes.toString("base64")}`;
}

/** A canonical, bounded inline attachment; a file URI or any other scheme is refused. */
function promptFileDataValid(uri: string): boolean {
  if (!uri.startsWith(PROMPT_FILE_DATA_PREFIX) || uri.length > PROMPT_FILE_DATA_MAX_CHARS) {
    return false;
  }
  const encoded = uri.slice(PROMPT_FILE_DATA_PREFIX.length);
  const bytes = Buffer.from(encoded, "base64");
  return bytes.length <= OPENCODE_PROMPT_FILE_MAX_BYTES && bytes.toString("base64") === encoded;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function safePromptFile(file: OpenCodeV2PromptFile): OpenCodeV2PromptFile {
  if (
    !promptFileDataValid(file.uri) ||
    file.name.length === 0 ||
    file.name.length > PROMPT_FILE_NAME_MAX_CHARS ||
    hasControlCharacter(file.name)
  ) {
    throw new Error("opencode-v2-prompt-file-invalid");
  }
  return { uri: file.uri, name: file.name };
}

/** The body fields the prompt inputs add; none when the prompt is an ordinary text prompt. */
function promptInputFields(inputs: OpenCodeV2PromptInputs | undefined): Record<string, unknown> {
  const files = inputs?.files ?? [];
  if (files.length > CODING_WORKBENCH_PROMPT_REFERENCES_MAX) {
    throw new Error("opencode-v2-prompt-files-oversized");
  }
  const delivery = inputs?.delivery;
  if (delivery !== undefined && !isCodingWorkbenchPromptDelivery(delivery)) {
    throw new Error("opencode-v2-prompt-delivery-invalid");
  }
  return {
    ...messageIdField(inputs?.id),
    ...(files.length === 0 ? {} : { files: files.map(safePromptFile) }),
    ...(delivery === undefined ? {} : { delivery }),
  };
}

function messageIdField(id: string | undefined): Record<string, unknown> {
  return id === undefined ? {} : { id: safeMessageId(id) };
}

/**
 * Every check that can refuse a command before a byte is sent, in one place, like `preparedPrompt`:
 * a failure here is `not-submitted` by construction.
 */
function preparedCommand(
  sessionId: string,
  name: string,
  text: string,
  inputs: Pick<OpenCodeV2PromptInputs, "files"> | undefined,
): { readonly path: string; readonly body: Record<string, unknown> } {
  try {
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES)
      throw new Error("opencode-v2-prompt-oversized");
    // The producer expands every bang-backtick block of the template AFTER substituting the text
    // into it, runs it in the project directory and consults no permission hook (#3903, proven
    // against the original executable), so the text can never carry one.
    if (text.includes(SHELL_BLOCK_MARKER))
      throw new Error("opencode-v2-command-shell-substitution");
    const { files } = promptInputFields(inputs);
    return {
      path: `/api/session/${safeSessionId(sessionId)}/command`,
      body: { name: safeCommandName(name), text, ...(files === undefined ? {} : { files }) },
    };
  } catch (error) {
    throw new OpenCodeV2PromptRefusedError(
      error instanceof Error ? error.message : "opencode-v2-command-invalid",
      { cause: error },
    );
  }
}

interface PreparedPrompt {
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly sessionId: string;
  readonly messageId: string | undefined;
}

/**
 * Every check that can refuse a prompt before a byte is sent, in one place: a failure here is
 * `not-submitted` by construction, whichever check raised it, with the check's own message.
 */
function preparedPrompt(
  sessionId: string,
  value: string,
  display: OpenCodeV2PromptDisplay | undefined,
  inputs: OpenCodeV2PromptInputs | undefined,
): PreparedPrompt {
  try {
    if (Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES)
      throw new Error("opencode-v2-prompt-oversized");
    const inputFields = promptInputFields(inputs);
    if (
      display !== undefined &&
      (Buffer.byteLength(display.displayText, "utf8") > MAX_TEXT_BYTES ||
        !/^[a-f0-9]{64}$/u.test(display.hiddenContextSha256))
    )
      throw new Error("opencode-v2-prompt-display-invalid");
    return {
      path: `/api/session/${safeSessionId(sessionId)}/prompt`,
      sessionId,
      messageId: inputs?.id,
      body: {
        text: value,
        ...inputFields,
        ...(display === undefined ? {} : { metadata: { keikoContextPresentationV1: display } }),
      },
    };
  } catch (error) {
    throw new OpenCodeV2PromptRefusedError(
      error instanceof Error ? error.message : "opencode-v2-prompt-invalid",
      { cause: error },
    );
  }
}

/** The receipt the producer answered with must be the input that was sent, under the id it carried. */
function reconcileReceipt(
  receipt: Readonly<Record<string, unknown>>,
  prepared: PreparedPrompt,
): void {
  if (prepared.messageId === undefined) return;
  if (receipt.id !== prepared.messageId || receipt.sessionID !== prepared.sessionId) {
    throw new OpenCodeV2ReceiptMismatchError();
  }
}

function safeRequestId(value: string): string {
  if (!REQUEST_ID.test(value)) throw new Error("opencode-v2-request-invalid");
  return value;
}

function safeFormId(value: string): string {
  if (!/^frm_[A-Za-z0-9_-]{1,251}$/u.test(value)) throw new Error("opencode-v2-form-invalid");
  return value;
}

type V2Request = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<Readonly<Record<string, unknown>>>;

function parseEventFrame(frame: string): Readonly<Record<string, unknown>> | undefined {
  if (frame.startsWith(":")) return undefined;
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .join("\n");
  if (data.length === 0) throw new Error("opencode-v2-event-invalid");
  const parsed: unknown = JSON.parse(data);
  const event = record(parsed);
  if (event === undefined || typeof event.id !== "string" || typeof event.type !== "string") {
    throw new Error("opencode-v2-event-invalid");
  }
  return event;
}

async function* readEventFrames(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<Readonly<Record<string, unknown>>> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    pending = pending.replaceAll("\r\n", "\n");
    if (Buffer.byteLength(pending, "utf8") > MAX_EVENT_FRAME_BYTES) {
      throw new Error("opencode-v2-event-oversized");
    }
    let boundary = pending.indexOf("\n\n");
    while (boundary >= 0) {
      const event = parseEventFrame(pending.slice(0, boundary));
      pending = pending.slice(boundary + 2);
      if (event !== undefined) yield event;
      boundary = pending.indexOf("\n\n");
    }
  }
  if (pending.length > 0) throw new Error("opencode-v2-event-truncated");
}

async function* openEvents(
  endpoint: URL,
  authorization: string,
  fetchFn: typeof globalThis.fetch,
  signal: AbortSignal,
): AsyncIterable<Readonly<Record<string, unknown>>> {
  const response = await fetchFn(new URL("/api/event", endpoint), {
    method: "GET",
    redirect: "manual",
    signal,
    headers: { Authorization: authorization, Accept: "text/event-stream" },
  });
  if (
    !response.ok ||
    response.headers.get("content-type")?.startsWith("text/event-stream") !== true ||
    response.body === null
  ) {
    throw new Error("opencode-v2-event-unavailable");
  }
  yield* readEventFrames(response.body);
}

// The runtime pages its session list (50 rows by default). A session-tree proof that read only the
// first page could not see a later child, so the list is read to its end, bounded (#3897 review).
const SESSION_PAGE_SIZE = 100;
const MAX_SESSIONS = 2048;

async function pagedSessions(
  request: V2Request,
  signal?: AbortSignal,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const rows: Readonly<Record<string, unknown>>[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page <= MAX_SESSIONS / SESSION_PAGE_SIZE; page += 1) {
    const query = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const response = await request(
      "GET",
      `/api/session?limit=${String(SESSION_PAGE_SIZE)}${query}`,
      undefined,
      signal,
    );
    const batch = arrayEnvelope(response);
    if (rows.length + batch.length > MAX_SESSIONS)
      throw new Error("opencode-v2-sessions-oversized");
    rows.push(...batch);
    cursor = batch.length < SESSION_PAGE_SIZE ? undefined : nextSessionsCursor(response, cursors);
    if (cursor === undefined) return rows;
  }
  throw new Error("opencode-v2-sessions-oversized");
}

/** The next page's cursor, undefined at the end of the list; a repeated or oversized one throws. */
function nextSessionsCursor(
  response: Readonly<Record<string, unknown>>,
  seen: Set<string>,
): string | undefined {
  const next = record(response.cursor)?.next;
  if (next === undefined || next === null) return undefined;
  if (typeof next !== "string" || next.length > 2048 || seen.has(next)) {
    throw new Error("opencode-v2-cursor-invalid");
  }
  seen.add(next);
  return next;
}

async function pagedMessages(
  request: V2Request,
  sessionId: string,
  signal?: AbortSignal,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const base = `/api/session/${safeSessionId(sessionId)}/message`;
  const rows: Readonly<Record<string, unknown>>[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
    const query = cursor === undefined ? "order=desc" : `cursor=${encodeURIComponent(cursor)}`;
    const response = await request(
      "GET",
      `${base}?limit=${String(MESSAGE_PAGE_SIZE)}&${query}`,
      undefined,
      signal,
    );
    const batch = arrayEnvelope(response);
    if (rows.length + batch.length > MAX_MESSAGES) throw new Error("opencode-v2-history-oversized");
    rows.push(...batch);
    if (batch.length < MESSAGE_PAGE_SIZE) return rows.reverse();
    const next = record(response.cursor)?.next;
    if (typeof next !== "string" || next.length > 2048 || cursors.has(next)) {
      throw new Error("opencode-v2-cursor-invalid");
    }
    cursors.add(next);
    cursor = next;
  }
  throw new Error("opencode-v2-history-oversized");
}

/** Only the session API needed by a governed run is reachable from this client. */
// eslint-disable-next-line max-lines-per-function -- one closed method table makes the admitted V2 API auditable.
export function createOpenCodeV2HttpClient(
  options: OpenCodeV2HttpClientOptions,
): OpenCodeV2HttpClient {
  const endpoint = parseEndpoint(options.endpoint);
  if (endpoint === undefined || options.password.length === 0) {
    throw new Error("opencode-v2-endpoint-invalid");
  }
  const credentials = `opencode:${options.password}`;
  const authorization = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
  async function request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const response = await (options.fetch ?? globalThis.fetch)(new URL(path, endpoint), {
      method,
      redirect: "manual",
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      headers: {
        Authorization: authorization,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.type === "opaqueredirect") throw new Error("opencode-v2-redirect-denied");
    return boundedJson(response);
  }
  return {
    info: (signal) => request("GET", "/api/info", undefined, signal),
    document: (signal) => request("GET", "/openapi.json", undefined, signal),
    events: (signal) =>
      openEvents(endpoint, authorization, options.fetch ?? globalThis.fetch, signal),
    createSession: async (directory, signal): Promise<Readonly<Record<string, unknown>>> => {
      if (!directory.startsWith("/")) throw new Error("opencode-v2-directory-invalid");
      return objectEnvelope(
        await request(
          "POST",
          "/api/session",
          {
            title: "Keiko governed runtime",
            location: { directory },
          },
          signal,
        ),
      );
    },
    sessions: (signal) => pagedSessions(request, signal),
    messages: (sessionId, signal) => pagedMessages(request, sessionId, signal),
    prompt: async (sessionId, value, signal, display, inputs): Promise<void> => {
      const prepared = preparedPrompt(sessionId, value, display, inputs);
      const receipt = objectEnvelope(await request("POST", prepared.path, prepared.body, signal));
      reconcileReceipt(receipt, prepared);
    },
    commands: async (signal) =>
      commandEntries(arrayEnvelope(await request("GET", "/api/command", undefined, signal))),
    command: async (sessionId, name, text, signal, inputs): Promise<void> => {
      const prepared = preparedCommand(sessionId, name, text, inputs);
      await request("POST", prepared.path, prepared.body, signal);
    },
    interrupt: async (sessionId, signal): Promise<void> => {
      await request("POST", `/api/session/${safeSessionId(sessionId)}/interrupt`, {}, signal);
    },
    switchAgent: async (sessionId, agent, signal): Promise<void> => {
      await request(
        "POST",
        `/api/session/${safeSessionId(sessionId)}/agent`,
        { agent: safeAgent(agent) },
        signal,
      );
    },
    sessionDiff: async (sessionId, signal): Promise<readonly OpenCodeV2FileDiff[]> => {
      // `context=0` asks for hunks without surrounding lines: the patch text is discarded anyway.
      const response = await request(
        "GET",
        `/api/session/${safeSessionId(sessionId)}/diff?context=0`,
        undefined,
        signal,
      );
      return fileDiffs(envelope(response));
    },
    stageRevert: async (sessionId, messageId, signal) =>
      stagedRevert(
        objectEnvelope(
          await request(
            "POST",
            `/api/session/${safeSessionId(sessionId)}/revert/stage`,
            { messageID: safeMessageId(messageId), files: true },
            signal,
          ),
        ),
      ),
    commitRevert: async (sessionId, signal): Promise<void> => {
      await request(
        "POST",
        `/api/session/${safeSessionId(sessionId)}/revert/commit`,
        undefined,
        signal,
      );
    },
    clearRevert: async (sessionId, signal): Promise<void> => {
      await request("DELETE", `/api/session/${safeSessionId(sessionId)}/revert`, undefined, signal);
    },
    active: async (signal) =>
      objectEnvelope(await request("GET", "/api/session/active", undefined, signal)),
    permissions: async (signal) =>
      arrayEnvelope(await request("GET", "/api/permission/request", undefined, signal)),
    plugins: async (signal) =>
      arrayEnvelope(await request("GET", "/api/plugin", undefined, signal)),
    forms: async (signal) => arrayEnvelope(await request("GET", "/api/form", undefined, signal)),
    replyForm: async (sessionId, formId, answer, signal): Promise<void> => {
      await request(
        "POST",
        `/api/session/${safeSessionId(sessionId)}/form/${safeFormId(formId)}/reply`,
        { answer },
        signal,
      );
    },
    cancelForm: async (sessionId, formId, signal): Promise<void> => {
      await request(
        "DELETE",
        `/api/session/${safeSessionId(sessionId)}/form/${safeFormId(formId)}`,
        undefined,
        signal,
      );
    },
    replyPermission: async (sessionId, requestId, decision, message, signal): Promise<void> => {
      await request(
        "POST",
        `/api/session/${safeSessionId(sessionId)}/permission/${safeRequestId(requestId)}/reply`,
        message === undefined ? { decision } : { decision, message },
        signal,
      );
    },
  };
}
