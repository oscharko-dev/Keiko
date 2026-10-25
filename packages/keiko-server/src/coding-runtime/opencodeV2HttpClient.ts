import { parseRuntimeLoopbackServiceEndpoint } from "@oscharko-dev/keiko-sandbox";
import {
  CODING_WORKBENCH_PROMPT_REFERENCES_MAX,
  isCodingWorkbenchAgent,
  isCodingWorkbenchBuiltInAgent,
  isCodingWorkbenchCommandName,
  isCodingWorkbenchMentionName,
  isCodingWorkbenchPromptDelivery,
  parseCodingWorkbenchPromptMentions,
  type CodingWorkbenchAgent,
  type CodingWorkbenchAgentMention,
  type CodingWorkbenchPromptDelivery,
  type CodingWorkbenchSkillMention,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import { SHELL_BLOCK_MARKER } from "./codingRuntimeRepositoryItemSanitizer.js";
import { OPENCODE_HISTORY_RESPONSE_MAX_BYTES } from "./opencodeProtocol.js";

const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,251}$/u;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,256}$/u;
// The only answers Keiko gives a permission request; `always` is never one of them.
const PERMISSION_DECISIONS: ReadonlySet<string> = new Set(["once", "reject"]);
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
/**
 * One image or PDF attachment (#3906 AC1). Larger than a text file because a screenshot is; the
 * run's attachment budget still bounds what all of them add up to.
 */
export const OPENCODE_PROMPT_MEDIA_MAX_BYTES = 512 * 1024;
/** The media a prompt may attach inline, as the runtime's own `File.mime`. */
export const OPENCODE_PROMPT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
] as const;
export type OpenCodePromptMediaType = (typeof OPENCODE_PROMPT_MEDIA_TYPES)[number];
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
  /** The subagents and skills the prompt mentions (S15, #3906), already checked by the caller. */
  readonly mentions?: OpenCodeV2PromptMentions | undefined;
  /**
   * Set when Keiko itself starts the turn to continue the human's accepted request (its automatic
   * verification continuation). It is stored on the message as `OPENCODE_TURN_ORIGIN_METADATA`, so
   * an undo of the newest turn reaches back to that request (#3904 AC3).
   */
  readonly origin?: "verification-continuation" | undefined;
}

/** The prompt metadata key that marks a turn Keiko started to continue the human's request. */
export const OPENCODE_TURN_ORIGIN_METADATA = "keikoTurnOriginV1";

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
 * A subagent the runtime lists (`Agent.Info` of the pinned 2.1.4 schema, mode `subagent` or `all`,
 * not hidden), by the id a prompt mentions it with, and a skill (`Skill.Info`) by its id and name.
 * Only these closed fields are kept: an agent's system prompt and permissions and a skill's path and
 * content never leave the client.
 */
export interface OpenCodeV2Agent {
  readonly name: string;
  readonly description?: string | undefined;
}

export interface OpenCodeV2Skill {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
}

/** The mentions a prompt carries, in the runtime's own attachment shape. */
export interface OpenCodeV2PromptMentions {
  readonly agents?: readonly CodingWorkbenchAgentMention[] | undefined;
  readonly skills?: readonly CodingWorkbenchSkillMention[] | undefined;
}

/** A listing past this bound is refused whole; the built-in subagents are two. */
const MAX_MENTIONABLES = 256;

/**
 * One entry of a session's inbox (`Session.Inbox.Info` of the pinned 2.1.4 schema), reduced to the
 * three fields Keiko reads: the input's own message id, whether it is an operator message (`user`,
 * the only kind Keiko delivers) or something else the runtime queued itself, and how it will be
 * delivered. The payload (the text, the attachments, the metadata) is never copied.
 */
export interface OpenCodeV2InboxEntry {
  readonly id: string;
  readonly kind: "user" | "other";
  readonly delivery: CodingWorkbenchPromptDelivery;
}

/** The most entries one inbox listing may hold before the client refuses it. */
const MAX_INBOX_ENTRIES = 256;

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
/**
 * A shell command the runtime runs for the workspace (`shell.list`): its id and, when the runtime
 * records it, the session whose tool started it. Only running commands are listed.
 */
export interface OpenCodeV2Shell {
  readonly id: string;
  readonly sessionId?: string | undefined;
}

/**
 * An MCP server of the runtime's `mcp.list` answer (#3903 AC3): its name, a closed status and the
 * integration that holds its credential. The runtime's own error text is never read.
 */
export interface OpenCodeV2McpServer {
  readonly name: string;
  readonly status: OpenCodeV2McpStatus;
  readonly integrationId?: string | undefined;
}

export type OpenCodeV2McpStatus = "connected" | "needs-auth" | "failed" | "disabled" | "pending";

/** The runtime's own OAuth attempt for an MCP integration (`Integration.Attempt`). */
export interface OpenCodeV2OAuthAttempt {
  readonly attemptId: string;
  readonly url: string;
  /** `auto`: the runtime's loopback callback completes the attempt. */
  readonly mode: "auto" | "code";
  readonly expiresAtMs: number;
}

export type OpenCodeV2OAuthAttemptStatus = "pending" | "complete" | "failed" | "expired";

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

/**
 * The session `session.fork` created (`Session.Info` of the pinned 2.1.4 schema, reduced to what
 * Keiko checks): its id, the directory the runtime placed it in, the session it was forked from and
 * the boundary the copy ended at. `before` ends it just ahead of a message, `through` at the last one.
 */
export interface OpenCodeV2ForkedSession {
  readonly id: string;
  readonly directory: string;
  readonly sourceSessionId: string;
  readonly boundary: { readonly type: "before" | "through"; readonly messageId: string };
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
   * The subagents a prompt may mention (`GET /api/agent`, operation `agent.list`) for the run's
   * workspace: an entry that is primary, hidden or not well named is dropped.
   */
  agents(directory: string, signal?: AbortSignal): Promise<readonly OpenCodeV2Agent[]>;
  /**
   * The custom primary agents the session may switch to (`GET /api/agent`, operation `agent.list`)
   * for the run's workspace (#3903 AC1): primary or all-mode agents that are not hidden, other than
   * the built-in `build` and `plan`, each well named.
   */
  primaryAgents(directory: string, signal?: AbortSignal): Promise<readonly OpenCodeV2Agent[]>;
  /** The skills a prompt may mention (`GET /api/skill`, operation `skill.list`) for the workspace. */
  skills(directory: string, signal?: AbortSignal): Promise<readonly OpenCodeV2Skill[]>;
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
    inputs?: Pick<OpenCodeV2PromptInputs, "files" | "mentions">,
  ): Promise<void>;
  /**
   * The ids of the session's newest messages, newest first (`GET /api/session/{sessionID}/message`,
   * one page, `order=desc`). Ids only: no text, part or metadata is copied. The proof, right after
   * an inbox change, that a message did or did not reach the model.
   */
  recentMessageIds(sessionId: string, signal?: AbortSignal): Promise<readonly string[]>;
  /**
   * The inputs the session has accepted but not yet handed to the model (`GET
   * /api/session/{sessionID}/inbox`, operation `session.inbox.list`), in the producer's order. An
   * entry that is not about this session, whose id is not a message id, or whose delivery is not
   * `steer` or `queue` is dropped; the payload is never read.
   */
  inbox(sessionId: string, signal?: AbortSignal): Promise<readonly OpenCodeV2InboxEntry[]>;
  /**
   * Withdraws a pending input before the model sees it (`DELETE
   * /api/session/{sessionID}/inbox/{inboxID}`, operation `session.inbox.cancel`).
   */
  cancelInboxEntry(sessionId: string, inboxId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Changes a pending input to `steer`, so it joins the running turn at its next step (`PATCH
   * /api/session/{sessionID}/inbox/{inboxID}`, operation `session.inbox.update`). The runtime answers
   * 409 for an input it no longer holds as it was.
   */
  promoteInboxEntry(sessionId: string, inboxId: string, signal?: AbortSignal): Promise<void>;
  interrupt(sessionId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Copies a session's messages into a new session of the same location (`POST
   * /api/session/{sessionID}/fork`, operation `session.fork`). With `before` the copy ends just
   * ahead of that message; without it the copy runs through the session's last message. The source
   * is untouched, and the copied messages get new ids in the new session.
   */
  forkSession(
    sessionId: string,
    before?: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeV2ForkedSession>;
  /**
   * Deletes a session and its messages (`DELETE /api/session/{sessionID}`, operation
   * `session.remove`). Keiko removes only sessions it created itself in a run's private state: the
   * source of a fork and the scratch session of a readiness challenge.
   */
  removeSession(sessionId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Switches the primary agent that runs the session's SUBSEQUENT provider turns
   * (`POST /api/session/{sessionID}/agent`, operation `session.switchAgent`). Only the closed
   * Workbench vocabulary is accepted; the runtime's own refusal (unknown session, unknown agent)
   * rejects, so a caller never reports a switch that did not happen.
   */
  switchAgent(sessionId: string, agent: CodingWorkbenchAgent, signal?: AbortSignal): Promise<void>;
  /**
   * The files the session's newest turn changed (`GET /api/session/{sessionID}/diff`, operation
   * `session.diff`), without their patch text, or, with `from`, every file changed since that user
   * message. A step still running compares against the working copy.
   */
  sessionDiff(
    sessionId: string,
    signal?: AbortSignal,
    from?: string,
  ): Promise<readonly OpenCodeV2FileDiff[]>;
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
  /**
   * The shell commands the runtime is running now for the workspace (`GET /api/shell`,
   * `shell.list`; exited commands are not listed). A background job an agent started outlives its
   * turn, so a run is not over while one of its jobs runs (#3901 AC3).
   */
  shells(directory: string, signal?: AbortSignal): Promise<readonly OpenCodeV2Shell[]>;
  /** Stops and removes one shell command (`DELETE /api/shell/{id}`, `shell.remove`). */
  removeShell(id: string, directory: string, signal?: AbortSignal): Promise<void>;
  /** The MCP servers the runtime holds for the workspace (`GET /api/mcp`, `mcp.list`). */
  mcpServers(directory: string, signal?: AbortSignal): Promise<readonly OpenCodeV2McpServer[]>;
  /**
   * Starts the runtime's own OAuth authorization of one MCP integration
   * (`POST /api/integration/{integrationID}/connect/oauth`, `integration.oauth.connect`): it
   * registers a client if needed, prepares PKCE and listens on its loopback callback.
   */
  connectMcpOAuth(
    integrationId: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeV2OAuthAttempt>;
  /** The attempt's state (`GET .../connect/oauth/{attemptID}`, `integration.oauth.status`). */
  mcpOAuthStatus(
    integrationId: string,
    attemptId: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeV2OAuthAttemptStatus>;
  /** Abandons the attempt (`DELETE .../connect/oauth/{attemptID}`, `integration.oauth.cancel`). */
  cancelMcpOAuth(
    integrationId: string,
    attemptId: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Hands the runtime an MCP credential Keiko kept from an earlier run (`POST /api/credential`,
   * `credential.create`). Keiko never lists or reads the runtime's credentials through its API.
   */
  createMcpCredential(
    credential: {
      readonly integrationId: string;
      readonly label: string;
      readonly value: Readonly<Record<string, unknown>>;
    },
    signal?: AbortSignal,
  ): Promise<void>;
  permissions(signal?: AbortSignal): Promise<readonly Readonly<Record<string, unknown>>[]>;
  /** The producer's plugins and their load state (`GET /api/plugin`, operation `plugin.list`). */
  plugins(signal?: AbortSignal): Promise<readonly Readonly<Record<string, unknown>>[]>;
  /** Pending forms belong to a location; omit it only when the service cwd is the intended scope. */
  forms(
    directory?: string,
    signal?: AbortSignal,
  ): Promise<readonly Readonly<Record<string, unknown>>[]>;
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
  return parseRuntimeLoopbackServiceEndpoint(output);
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

function locationQuery(directory: string): string {
  if (!directory.startsWith("/")) throw new Error("opencode-v2-directory-invalid");
  return `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
}

function mentionDescription(value: unknown): { readonly description?: string } {
  const description = commandDescription(value);
  return description === undefined ? {} : { description };
}

/** Only listed subagents that are not hidden, by their well-formed id. */
function agentEntries(
  entries: readonly Readonly<Record<string, unknown>>[],
): readonly OpenCodeV2Agent[] {
  if (entries.length > MAX_MENTIONABLES) throw new Error("opencode-v2-envelope-invalid");
  return entries.flatMap((entry): readonly OpenCodeV2Agent[] => {
    const { id, mode, hidden } = entry;
    if (!isCodingWorkbenchMentionName(id) || hidden !== false) return [];
    if (mode !== "subagent" && mode !== "all") return [];
    return [{ name: id, ...mentionDescription(entry.description) }];
  });
}

function primaryAgentEntries(
  entries: readonly Readonly<Record<string, unknown>>[],
): readonly OpenCodeV2Agent[] {
  if (entries.length > MAX_MENTIONABLES) throw new Error("opencode-v2-envelope-invalid");
  return entries.flatMap((entry): readonly OpenCodeV2Agent[] => {
    const { id, mode, hidden } = entry;
    if (!isCodingWorkbenchMentionName(id) || hidden !== false) return [];
    if (isCodingWorkbenchBuiltInAgent(id) || (mode !== "primary" && mode !== "all")) return [];
    return [{ name: id, ...mentionDescription(entry.description) }];
  });
}

function skillEntries(
  entries: readonly Readonly<Record<string, unknown>>[],
): readonly OpenCodeV2Skill[] {
  if (entries.length > MAX_MENTIONABLES) throw new Error("opencode-v2-envelope-invalid");
  return entries.flatMap((entry): readonly OpenCodeV2Skill[] => {
    const { id, name } = entry;
    if (!isCodingWorkbenchMentionName(id) || !isCodingWorkbenchMentionName(name)) return [];
    return [{ id, name, ...mentionDescription(entry.description) }];
  });
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

/** Only well-formed message ids survive; the rest of a message row is never read. */
function messageIds(rows: readonly Readonly<Record<string, unknown>>[]): readonly string[] {
  return rows.flatMap((row): readonly string[] =>
    typeof row.id === "string" && MESSAGE_ID.test(row.id) ? [row.id] : [],
  );
}

/**
 * The closed fields of every inbox entry that is about the asked session and well formed; the rest of
 * an entry, its payload above all, is never copied. A listing past the bound is refused whole.
 */
function inboxEntries(
  sessionId: string,
  entries: readonly Readonly<Record<string, unknown>>[],
): readonly OpenCodeV2InboxEntry[] {
  if (entries.length > MAX_INBOX_ENTRIES) throw new Error("opencode-v2-envelope-invalid");
  return entries.flatMap((entry): readonly OpenCodeV2InboxEntry[] => {
    const { id, delivery } = entry;
    if (entry.sessionID !== sessionId || typeof id !== "string" || !MESSAGE_ID.test(id)) return [];
    if (!isCodingWorkbenchPromptDelivery(delivery)) return [];
    return [{ id, kind: entry.type === "user" ? "user" : "other", delivery }];
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

function forkBoundary(value: unknown): OpenCodeV2ForkedSession["boundary"] {
  const boundary = record(value);
  const type = boundary?.type;
  const messageId = boundary?.messageID;
  if ((type !== "before" && type !== "through") || typeof messageId !== "string") {
    throw new Error("opencode-v2-envelope-invalid");
  }
  if (!MESSAGE_ID.test(messageId)) throw new Error("opencode-v2-envelope-invalid");
  return { type, messageId };
}

function forkedSession(value: Readonly<Record<string, unknown>>): OpenCodeV2ForkedSession {
  const fork = record(value.fork);
  const directory = record(value.location)?.directory;
  const id = value.id;
  const source = fork?.sessionID;
  if (typeof id !== "string" || typeof source !== "string" || typeof directory !== "string") {
    throw new TypeError("opencode-v2-envelope-invalid");
  }
  if (!SESSION_ID.test(id) || !SESSION_ID.test(source)) {
    throw new Error("opencode-v2-envelope-invalid");
  }
  return { id, directory, sourceSessionId: source, boundary: forkBoundary(fork?.boundary) };
}

function stagedRevert(value: Readonly<Record<string, unknown>>): OpenCodeV2StagedRevert {
  const messageId = value.messageID;
  if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) {
    throw new Error("opencode-v2-envelope-invalid");
  }
  return { messageId, files: value.files === undefined ? [] : fileDiffs(value.files) };
}

const PROMPT_FILE_NAME_MAX_CHARS = 255;

function promptDataPrefix(mime: string): string {
  return `data:${mime};base64,`;
}

/** Each inline attachment prefix with the byte ceiling of what it may carry. */
const PROMPT_FILE_DATA_BOUNDS: readonly (readonly [string, number])[] = [
  [promptDataPrefix("text/plain"), OPENCODE_PROMPT_FILE_MAX_BYTES],
  ...OPENCODE_PROMPT_MEDIA_TYPES.map(
    (mime) => [promptDataPrefix(mime), OPENCODE_PROMPT_MEDIA_MAX_BYTES] as const,
  ),
];

/** The inline attachment of a file's admitted bytes: text, or an admitted image or PDF. */
export function openCodeV2PromptFileData(
  bytes: Buffer,
  mime: "text/plain" | OpenCodePromptMediaType = "text/plain",
): string {
  return `${promptDataPrefix(mime)}${bytes.toString("base64")}`;
}

/** A canonical, bounded inline attachment; a file URI or any other scheme is refused. */
function promptFileDataValid(uri: string): boolean {
  const bound = PROMPT_FILE_DATA_BOUNDS.find(([prefix]) => uri.startsWith(prefix));
  if (bound === undefined) return false;
  const [prefix, maxBytes] = bound;
  if (uri.length > prefix.length + 4 * Math.ceil(maxBytes / 3)) return false;
  const encoded = uri.slice(prefix.length);
  const bytes = Buffer.from(encoded, "base64");
  return bytes.length <= maxBytes && bytes.toString("base64") === encoded;
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
function checkedFiles(inputs: OpenCodeV2PromptInputs | undefined): readonly OpenCodeV2PromptFile[] {
  const files = inputs?.files ?? [];
  if (files.length > CODING_WORKBENCH_PROMPT_REFERENCES_MAX) {
    throw new Error("opencode-v2-prompt-files-oversized");
  }
  return files;
}

function checkedDelivery(
  inputs: OpenCodeV2PromptInputs | undefined,
): CodingWorkbenchPromptDelivery | undefined {
  const delivery = inputs?.delivery;
  if (delivery !== undefined && !isCodingWorkbenchPromptDelivery(delivery)) {
    throw new Error("opencode-v2-prompt-delivery-invalid");
  }
  return delivery;
}

/** The message metadata Keiko reads back: the context presentation and the turn's origin. */
function promptMetadata(
  display: OpenCodeV2PromptDisplay | undefined,
  origin: OpenCodeV2PromptInputs["origin"],
): Record<string, unknown> {
  if (display === undefined && origin === undefined) return {};
  return {
    metadata: {
      ...(display === undefined ? {} : { keikoContextPresentationV1: display }),
      ...(origin === undefined ? {} : { [OPENCODE_TURN_ORIGIN_METADATA]: origin }),
    },
  };
}

function promptInputFields(inputs: OpenCodeV2PromptInputs | undefined): Record<string, unknown> {
  const files = checkedFiles(inputs);
  const delivery = checkedDelivery(inputs);
  return {
    ...messageIdField(inputs?.id),
    ...(files.length === 0 ? {} : { files: files.map(safePromptFile) }),
    ...mentionFields(inputs?.mentions),
    ...(delivery === undefined ? {} : { delivery }),
  };
}

/** The attachments exactly as the runtime's own interface sends them; anything malformed refuses. */
function mentionFields(mentions: OpenCodeV2PromptMentions | undefined): Record<string, unknown> {
  if (mentions === undefined) return {};
  const parsed = parseCodingWorkbenchPromptMentions(mentions);
  if (!parsed.ok) throw new Error("opencode-v2-prompt-mentions-invalid");
  const { agents, skills } = parsed.value;
  return {
    ...(agents === undefined ? {} : { agents }),
    ...(skills === undefined ? {} : { skills }),
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
  inputs: Pick<OpenCodeV2PromptInputs, "files" | "mentions"> | undefined,
): { readonly path: string; readonly body: Record<string, unknown> } {
  try {
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES)
      throw new Error("opencode-v2-prompt-oversized");
    // The producer expands every bang-backtick block of the template AFTER substituting the text
    // into it, runs it in the project directory and consults no permission hook (#3903, proven
    // against the original executable), so the text can never carry one.
    if (text.includes(SHELL_BLOCK_MARKER))
      throw new Error("opencode-v2-command-shell-substitution");
    // The command body has no message id and no delivery; files and mentions ride it like a prompt.
    const { files, agents, skills } = promptInputFields(inputs);
    return {
      path: `/api/session/${safeSessionId(sessionId)}/command`,
      body: {
        name: safeCommandName(name),
        text,
        ...(files === undefined ? {} : { files }),
        ...(agents === undefined ? {} : { agents }),
        ...(skills === undefined ? {} : { skills }),
      },
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
        ...promptMetadata(display, inputs?.origin),
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

const SHELL_ID = /^sh_[A-Za-z0-9]{1,128}$/u;
const SHELL_SESSION_ID = /^ses_[A-Za-z0-9_-]{1,251}$/u;

function safeShellId(value: string): string {
  if (!SHELL_ID.test(value)) throw new Error("opencode-v2-shell-invalid");
  return value;
}

/** The running commands of a `shell.list` answer; any other status or shape is not one. */
function runningShells(entries: readonly Readonly<Record<string, unknown>>[]): OpenCodeV2Shell[] {
  return entries.flatMap((entry) => {
    if (entry.status !== "running" || typeof entry.id !== "string" || !SHELL_ID.test(entry.id))
      return [];
    const sessionId = record(entry.metadata)?.sessionID;
    return [
      typeof sessionId === "string" && SHELL_SESSION_ID.test(sessionId)
        ? { id: entry.id, sessionId }
        : { id: entry.id },
    ];
  });
}

const INTEGRATION_ID = /^mcp_[0-9a-f]{16}$/u;
const ATTEMPT_ID = /^con_[A-Za-z0-9]{1,64}$/u;
const MCP_SERVER_NAME = /^[a-z][a-z0-9]{0,30}$/u;
const MCP_STATUSES: Readonly<Record<string, OpenCodeV2McpStatus>> = {
  connected: "connected",
  needs_auth: "needs-auth",
  needs_client_registration: "needs-auth",
  failed: "failed",
  disabled: "disabled",
  pending: "pending",
};
const OAUTH_ATTEMPT_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "complete",
  "failed",
  "expired",
]);

function safeIntegrationId(value: string): string {
  if (!INTEGRATION_ID.test(value)) throw new Error("opencode-v2-integration-invalid");
  return value;
}

function safeAttemptId(value: string): string {
  if (!ATTEMPT_ID.test(value)) throw new Error("opencode-v2-attempt-invalid");
  return value;
}

/** The well-named servers of a `mcp.list` answer; an unknown status reads as `failed`. */
function mcpServerEntries(
  entries: readonly Readonly<Record<string, unknown>>[],
): OpenCodeV2McpServer[] {
  return entries.flatMap((entry) => {
    if (typeof entry.name !== "string" || !MCP_SERVER_NAME.test(entry.name)) return [];
    const reported = record(entry.status)?.status;
    const status = (typeof reported === "string" ? MCP_STATUSES[reported] : undefined) ?? "failed";
    const integrationId =
      typeof entry.integrationID === "string" && INTEGRATION_ID.test(entry.integrationID)
        ? entry.integrationID
        : undefined;
    return [
      { name: entry.name, status, ...(integrationId === undefined ? {} : { integrationId }) },
    ];
  });
}

function oauthAttempt(value: Readonly<Record<string, unknown>>): OpenCodeV2OAuthAttempt {
  const { attemptID, url, mode } = value;
  const expires = record(value.time)?.expires;
  if (
    typeof attemptID !== "string" ||
    !ATTEMPT_ID.test(attemptID) ||
    typeof url !== "string" ||
    url.length > 8_192 ||
    (mode !== "auto" && mode !== "code") ||
    typeof expires !== "number" ||
    !Number.isSafeInteger(expires)
  )
    throw new Error("opencode-v2-envelope-invalid");
  return { attemptId: attemptID, url, mode, expiresAtMs: expires };
}

function oauthAttemptStatus(
  value: Readonly<Record<string, unknown>>,
): OpenCodeV2OAuthAttemptStatus {
  const status = value.status;
  if (typeof status !== "string" || !OAUTH_ATTEMPT_STATUSES.has(status))
    throw new Error("opencode-v2-envelope-invalid");
  return status as OpenCodeV2OAuthAttemptStatus;
}

function oauthAttemptPath(integrationId: string, attemptId: string, directory: string): string {
  return `/api/integration/${safeIntegrationId(integrationId)}/connect/oauth/${safeAttemptId(
    attemptId,
  )}?${locationQuery(directory)}`;
}

function safeFormId(value: string): string {
  if (!/^frm_[A-Za-z0-9_-]{1,251}$/u.test(value)) throw new Error("opencode-v2-form-invalid");
  return value;
}

type V2Request = (
  method: "GET" | "POST" | "DELETE" | "PATCH",
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
    method: "GET" | "POST" | "DELETE" | "PATCH",
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
    agents: async (directory, signal) =>
      agentEntries(
        arrayEnvelope(
          await request("GET", `/api/agent?${locationQuery(directory)}`, undefined, signal),
        ),
      ),
    primaryAgents: async (directory, signal) =>
      primaryAgentEntries(
        arrayEnvelope(
          await request("GET", `/api/agent?${locationQuery(directory)}`, undefined, signal),
        ),
      ),
    skills: async (directory, signal) =>
      skillEntries(
        arrayEnvelope(
          await request("GET", `/api/skill?${locationQuery(directory)}`, undefined, signal),
        ),
      ),
    command: async (sessionId, name, text, signal, inputs): Promise<void> => {
      const prepared = preparedCommand(sessionId, name, text, inputs);
      await request("POST", prepared.path, prepared.body, signal);
    },
    recentMessageIds: async (sessionId, signal) =>
      messageIds(
        arrayEnvelope(
          await request(
            "GET",
            `/api/session/${safeSessionId(sessionId)}/message?limit=${String(MESSAGE_PAGE_SIZE)}&order=desc`,
            undefined,
            signal,
          ),
        ),
      ),
    inbox: async (sessionId, signal) =>
      inboxEntries(
        sessionId,
        arrayEnvelope(
          await request("GET", `/api/session/${safeSessionId(sessionId)}/inbox`, undefined, signal),
        ),
      ),
    cancelInboxEntry: async (sessionId, inboxId, signal): Promise<void> => {
      await request(
        "DELETE",
        `/api/session/${safeSessionId(sessionId)}/inbox/${safeMessageId(inboxId)}`,
        undefined,
        signal,
      );
    },
    promoteInboxEntry: async (sessionId, inboxId, signal): Promise<void> => {
      await request(
        "PATCH",
        `/api/session/${safeSessionId(sessionId)}/inbox/${safeMessageId(inboxId)}`,
        { delivery: "steer" },
        signal,
      );
    },
    interrupt: async (sessionId, signal): Promise<void> => {
      await request("POST", `/api/session/${safeSessionId(sessionId)}/interrupt`, {}, signal);
    },
    forkSession: async (sessionId, before, signal): Promise<OpenCodeV2ForkedSession> =>
      forkedSession(
        objectEnvelope(
          await request(
            "POST",
            `/api/session/${safeSessionId(sessionId)}/fork`,
            before === undefined ? {} : { before: safeMessageId(before) },
            signal,
          ),
        ),
      ),
    removeSession: async (sessionId, signal): Promise<void> => {
      await request("DELETE", `/api/session/${safeSessionId(sessionId)}`, undefined, signal);
    },
    switchAgent: async (sessionId, agent, signal): Promise<void> => {
      await request(
        "POST",
        `/api/session/${safeSessionId(sessionId)}/agent`,
        { agent: safeAgent(agent) },
        signal,
      );
    },
    sessionDiff: async (sessionId, signal, from): Promise<readonly OpenCodeV2FileDiff[]> => {
      // `context=0` asks for hunks without surrounding lines: the patch text is discarded anyway.
      const since = from === undefined ? "" : `&from=${safeMessageId(from)}`;
      const response = await request(
        "GET",
        `/api/session/${safeSessionId(sessionId)}/diff?context=0${since}`,
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
    shells: async (directory, signal) =>
      runningShells(
        arrayEnvelope(
          await request("GET", `/api/shell?${locationQuery(directory)}`, undefined, signal),
        ),
      ),
    removeShell: async (id, directory, signal): Promise<void> => {
      await request(
        "DELETE",
        `/api/shell/${safeShellId(id)}?${locationQuery(directory)}`,
        undefined,
        signal,
      );
    },
    mcpServers: async (directory, signal) =>
      mcpServerEntries(
        arrayEnvelope(
          await request("GET", `/api/mcp?${locationQuery(directory)}`, undefined, signal),
        ),
      ),
    connectMcpOAuth: async (integrationId, directory, signal) =>
      oauthAttempt(
        objectEnvelope(
          await request(
            "POST",
            `/api/integration/${safeIntegrationId(integrationId)}/connect/oauth?${locationQuery(directory)}`,
            { methodID: integrationId },
            signal,
          ),
        ),
      ),
    mcpOAuthStatus: async (integrationId, attemptId, directory, signal) =>
      oauthAttemptStatus(
        objectEnvelope(
          await request(
            "GET",
            oauthAttemptPath(integrationId, attemptId, directory),
            undefined,
            signal,
          ),
        ),
      ),
    cancelMcpOAuth: async (integrationId, attemptId, directory, signal): Promise<void> => {
      await request(
        "DELETE",
        oauthAttemptPath(integrationId, attemptId, directory),
        undefined,
        signal,
      );
    },
    createMcpCredential: async (credential, signal): Promise<void> => {
      await request(
        "POST",
        "/api/credential",
        {
          integrationID: safeIntegrationId(credential.integrationId),
          label: credential.label,
          value: credential.value,
        },
        signal,
      );
    },
    permissions: async (signal) =>
      arrayEnvelope(await request("GET", "/api/permission/request", undefined, signal)),
    plugins: async (signal) =>
      arrayEnvelope(await request("GET", "/api/plugin", undefined, signal)),
    forms: async (directory, signal) =>
      arrayEnvelope(
        await request(
          "GET",
          directory === undefined ? "/api/form" : `/api/form?${locationQuery(directory)}`,
          undefined,
          signal,
        ),
      ),
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
      // An `always` is remembered for the rest of the session, which a retained and resumed session
      // would carry across runs (S02): Keiko answers one request at a time, whatever the type says.
      if (!PERMISSION_DECISIONS.has(decision)) {
        throw new Error("opencode-v2-permission-decision-invalid");
      }
      await request(
        "POST",
        `/api/session/${safeSessionId(sessionId)}/permission/${safeRequestId(requestId)}/reply`,
        message === undefined ? { decision } : { decision, message },
        signal,
      );
    },
  };
}
