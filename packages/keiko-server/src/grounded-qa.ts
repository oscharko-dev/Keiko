// BFF route POST /api/chats/messages/grounded (Issue #185 / Epic #177). Composes the
// orchestrator's pure pipeline with the UiStore so a single HTTP round trip persists both
// the user question and the assistant answer alongside a redacted citation projection.
// All path validation runs in the composed layers; this module only validates wire-shape
// inputs (chatId + content) and enforces that the chat carries a connected scope.

import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  validateConnectedContextPack,
  type ConnectedContextPack,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  buildGroundedAnswerContextPackSummary,
  type GroundedAnswer,
  type GroundedEvidenceCitation,
  type GroundedUncertainty,
} from "@oscharko-dev/keiko-contracts/bff-wire";

import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { Redactor, UiHandlerDeps } from "./deps.js";
import type { Chat, ChatMessage } from "./store/index.js";
import {
  ClarificationNeededError,
  echoAnswerer,
  runGroundedExploration,
  type OrchestratorInput,
  type OrchestratorOutput,
} from "./grounded-orchestrator.js";
import { microIndexForGroundedScope } from "./grounded-context-index.js";

// ─── Body parsing (mirrors store-handlers' bounded reader) ────────────────────

const MAX_BODY_BYTES = 128_000;
const MAX_CONTENT_CHARS = 16_000;

class BodyTooLargeError extends Error {
  public constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function badRequest(message: string): RouteResult {
  return { status: 400, body: errorBody("BAD_REQUEST", message) };
}

function notFound(message: string): RouteResult {
  return { status: 404, body: errorBody("NOT_FOUND", message) };
}

function payloadTooLarge(): RouteResult {
  return {
    status: 413,
    body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
  };
}

function internalError(message: string): RouteResult {
  return { status: 500, body: errorBody("INTERNAL", message) };
}

function isValidGroundedPack(pack: ConnectedContextPack): boolean {
  try {
    return validateConnectedContextPack(pack).ok;
  } catch {
    return false;
  }
}

interface AskInput {
  readonly chatId: string;
  readonly content: string;
}

type ParseResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "err"; readonly result: RouteResult };

function parseJsonObject(raw: string): ParseResult<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    return { kind: "err", result: badRequest("Request body is not valid JSON.") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "err", result: badRequest("Request body must be a JSON object.") };
  }
  return { kind: "ok", value: parsed as Record<string, unknown> };
}

function parseBody(raw: string): ParseResult<AskInput> {
  const objResult = parseJsonObject(raw);
  if (objResult.kind === "err") return objResult;
  const obj = objResult.value;
  const chatId = typeof obj.chatId === "string" ? obj.chatId : "";
  const content = typeof obj.content === "string" ? obj.content.trim() : "";
  if (chatId.length === 0) {
    return { kind: "err", result: badRequest('Field "chatId" is required.') };
  }
  if (content.length === 0 || content.length > MAX_CONTENT_CHARS) {
    return {
      kind: "err",
      result: badRequest(
        `Field "content" must be between 1 and ${String(MAX_CONTENT_CHARS)} characters.`,
      ),
    };
  }
  return { kind: "ok", value: { chatId, content } };
}

// ─── Scope / query construction ───────────────────────────────────────────────

// SHA-256(chatId + connectedAtMs) truncated to 16 hex chars — deterministic across calls so
// the assembler's pack stableId is stable for a given chat-scope binding. The scopeId is
// observable only inside the BFF; no client trust is placed on the value.
function deriveScopeId(chat: Chat): string {
  if (chat.connectedScope === undefined) {
    return `chat-${chat.id}`;
  }
  const hash = createHash("sha256")
    .update(`${chat.id}|${String(chat.connectedScope.connectedAtMs)}`)
    .digest("hex");
  return `cs-${hash.slice(0, 16)}`;
}

function buildSelectedScope(chat: Chat): SelectedScope | undefined {
  const cs = chat.connectedScope;
  if (cs === undefined) return undefined;
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: deriveScopeId(chat),
    workspaceRoot: chat.projectPath,
    kind: cs.kind,
    relativePaths: cs.relativePaths,
    conversationId: chat.id,
    connectedAtMs: cs.connectedAtMs,
  };
}

function buildQuery(content: string, nowMs: () => number): RetrievalQuery {
  return {
    kind: "natural-language",
    text: content,
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: nowMs(),
  };
}

// ─── Citation projection ──────────────────────────────────────────────────────

function redactString(redactor: Redactor, value: string): string {
  return redactor(value) as string;
}

function buildCitations(
  pack: ConnectedContextPack,
  redactor: Redactor,
): readonly GroundedEvidenceCitation[] {
  const citations: GroundedEvidenceCitation[] = [];
  for (const file of pack.files) {
    for (const excerpt of file.excerpts) {
      citations.push({
        scopePath: redactString(redactor, excerpt.atom.scopePath),
        lineRange: excerpt.atom.lineRange,
        score: excerpt.atom.score,
        stableId: redactString(redactor, excerpt.atom.stableId),
      });
    }
  }
  citations.sort((a, b) => b.score - a.score);
  return citations;
}

function buildUncertainty(
  pack: ConnectedContextPack,
  redactor: Redactor,
): readonly GroundedUncertainty[] {
  // uncertainty.claim is the one wire-visible string sourced from the in-process pack that
  // can carry user-controlled text (e.g., excerpt fragments paraphrased into a confidence
  // marker). Production packs SHOULD be upstream-redacted (per ADR-0019), but the BFF still
  // applies the live-payload redactor as defense in depth so secret-shaped strings never
  // reach the browser even when the pack assembler skips its own redaction step.
  return pack.uncertainty.map((u) => ({
    kind: u.kind,
    claim: redactor(u.claim) as string,
  }));
}

// ─── Composition seam (test injection) ────────────────────────────────────────

// The seam lets the route's tests substitute a deterministic orchestrator runner without
// having to spin up a real workspace fixture for every wire-shape assertion. Production
// callers pass `runGroundedExploration` directly so the route stays a thin wrapper.
export type GroundedRunner = (input: OrchestratorInput) => Promise<OrchestratorOutput>;

function defaultRunner(input: OrchestratorInput): Promise<OrchestratorOutput> {
  const nowMs = Date.now;
  return runGroundedExploration(input, {
    answerer: echoAnswerer,
    nowMs,
    microIndex: microIndexForGroundedScope(input.scope, nowMs),
  });
}

// ─── Lookup helpers ───────────────────────────────────────────────────────────

function findChatById(deps: UiHandlerDeps, chatId: string): Chat | undefined {
  for (const project of deps.store.listProjects()) {
    for (const chat of deps.store.listChats(project.path)) {
      if (chat.id === chatId) return chat;
    }
  }
  return undefined;
}

// ─── Route worker (extracted to keep handleGroundedAsk under the LOC bound) ───

interface AskWorkerCtx {
  readonly chat: Chat;
  readonly scope: SelectedScope;
  readonly content: string;
  readonly deps: UiHandlerDeps;
  readonly runner: GroundedRunner;
}

// Atomic insert via the existing createMessages batch (wraps BEGIN/COMMIT) so a transient
// failure on the assistant insert rolls back the user insert. Returns both rows.
function persistGroundedExchange(
  deps: UiHandlerDeps,
  chatId: string,
  userContent: string,
  assistantContent: string,
): readonly [ChatMessage, ChatMessage] {
  const now = Date.now();
  const base = {
    chatId,
    timestamp: now,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  } as const;
  const [user, assistant] = deps.store.createMessages([
    { ...base, role: "user", content: userContent },
    { ...base, role: "assistant", content: assistantContent },
  ]);
  if (user === undefined || assistant === undefined) {
    throw new Error("createMessages returned fewer rows than expected");
  }
  return [user, assistant];
}

async function runAsk(workerCtx: AskWorkerCtx): Promise<RouteResult> {
  const { chat, scope, content, deps, runner } = workerCtx;
  const query = buildQuery(content, () => Date.now());
  let output: OrchestratorOutput;
  try {
    output = await runner({ scope, query, workspaceRoot: chat.projectPath });
  } catch (error) {
    if (error instanceof ClarificationNeededError) {
      return badRequest(error.message);
    }
    throw error;
  }
  if (!isValidGroundedPack(output.pack)) {
    return internalError("Grounded answer context pack failed validation.");
  }
  const assistantContent = redactString(deps.redactor, output.assistantContent);
  const [userMessage, assistantMessage] = persistGroundedExchange(
    deps,
    chat.id,
    content,
    assistantContent,
  );
  const citations = buildCitations(output.pack, deps.redactor);
  const contextPack = buildGroundedAnswerContextPackSummary(
    output.pack,
    citations.length,
    output.elapsedMs,
  );
  const answer: GroundedAnswer = {
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    content: assistantContent,
    citations,
    uncertainty: buildUncertainty(output.pack, deps.redactor),
    omittedCount: output.pack.omitted.length,
    elapsedMs: output.elapsedMs,
    contextPack,
  };
  return { status: 200, body: answer };
}

// ─── Public handler ───────────────────────────────────────────────────────────

export async function handleGroundedAsk(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runner: GroundedRunner = defaultRunner,
): Promise<RouteResult> {
  let raw: string;
  try {
    raw = await readBody(ctx.req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return payloadTooLarge();
    throw error;
  }
  const parsed = parseBody(raw);
  if (parsed.kind === "err") return parsed.result;
  const chat = findChatById(deps, parsed.value.chatId);
  if (chat === undefined) return notFound("Chat not found.");
  const scope = buildSelectedScope(chat);
  if (scope === undefined) {
    return badRequest("Chat has no connected scope.");
  }
  return runAsk({ chat, scope, content: parsed.value.content, deps, runner });
}
