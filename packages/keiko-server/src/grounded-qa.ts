// BFF route POST /api/chats/messages/grounded (Issue #185 / Epic #177). Composes the
// orchestrator's pure pipeline with the UiStore so a single HTTP round trip persists both
// the user question and the assistant answer alongside a redacted citation projection.
// All path validation runs in the composed layers; this module only validates wire-shape
// inputs (chatId + content) and enforces that the chat carries a connected scope.

import type { IncomingMessage } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  CancelledError,
  GatewayError,
  findCapability,
  findConfiguredCapability,
  resolveCostClass,
  type ChatMessage as GatewayChatMessage,
  type ModelCapability,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { persistConnectedContextEvidence } from "@oscharko-dev/keiko-evidence";
import { redact } from "@oscharko-dev/keiko-security";
import {
  RepoSearchInvalidQueryError,
  RepoSearchInvalidRangeError,
  RepoSearchUnsupportedFileError,
} from "@oscharko-dev/keiko-workspace";

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
import { currentGatewayConfig, currentRedactionSecrets } from "./deps.js";
import type { Chat, ChatConnectedScope, ChatMessage } from "./store/index.js";
import {
  ClarificationNeededError,
  runGroundedExploration,
  type GroundedAnswerer,
  type OrchestratorInput,
  type OrchestratorOutput,
} from "./grounded-orchestrator.js";
import type { GroundedAnswerResult } from "./grounded-answer.js";
import { microIndexForGroundedScope } from "./grounded-context-index.js";
import { pathIsDenied } from "./files-deny.js";
import { handleLocalKnowledgeGroundedAsk } from "./local-knowledge-grounded-qa.js";
import {
  buildConnectedScopes,
  createMultiSourceAnswerer,
  defaultRetriever,
  runMultiSourceAsk,
  type GroundedRetriever,
  type MultiSourceAnswerer,
} from "./grounded-qa-multi-source.js";
import {
  buildLocalKnowledgeScopes,
  runHybridGroundedAsk,
  type ConnectorRetrieve,
  type FolderRetriever,
  type HybridAnswerer,
} from "./grounded-qa-hybrid.js";
import { GROUNDED_SYSTEM_PROMPT } from "./grounded-prompt.js";
import { rememberGroundedTurn } from "./grounded-turn-registry.js";

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

export function badRequest(message: string): RouteResult {
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

export function internalError(message: string): RouteResult {
  return { status: 500, body: errorBody("INTERNAL", message) };
}

// Issue #154 (GAP-B) — the dynamic `error.message` of a GatewayError may echo the provider base
// URL, an `Authorization: Bearer …` header, or an `api-key: …` value back from the provider's
// response. It is scrubbed through the SAME boundary as the desktop chat path
// (redact + currentRedactionSecrets) before crossing the browser wire. The static `error.code`
// enum and the fixed cancellation string carry no caller data and stay verbatim. Reading the LIVE
// secrets via currentRedactionSecrets(deps) (not the startup snapshot) scrubs apiKey/baseUrl values
// added through PATCH /api/gateway/config after process start (Epic #177).
function gatewayErrorResult(error: GatewayError, deps: UiHandlerDeps): RouteResult {
  if (error instanceof CancelledError) {
    return { status: 499, body: errorBody(error.code, "Grounded request was cancelled.") };
  }
  const status = error.code === "GATEWAY_AUTHENTICATION" ? 401 : error.retryable ? 503 : 502;
  const message = redact(error.message, currentRedactionSecrets(deps));
  return { status, body: errorBody(error.code, message) };
}

export function mappedGatewayError(error: unknown, deps: UiHandlerDeps): RouteResult | undefined {
  return error instanceof GatewayError ? gatewayErrorResult(error, deps) : undefined;
}

export function mappedWorkspaceError(error: unknown): RouteResult | undefined {
  if (
    error instanceof RepoSearchInvalidQueryError ||
    error instanceof RepoSearchInvalidRangeError ||
    error instanceof RepoSearchUnsupportedFileError
  ) {
    return badRequest(error.message);
  }
  return undefined;
}

export function isValidGroundedPack(pack: ConnectedContextPack): boolean {
  try {
    return validateConnectedContextPack(pack).ok;
  } catch {
    return false;
  }
}

interface AskInput {
  readonly chatId: string;
  readonly content: string;
  readonly modelId: string | undefined;
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
  let modelId: string | undefined;
  if ("modelId" in obj) {
    if (typeof obj.modelId !== "string" || obj.modelId.trim().length === 0) {
      return {
        kind: "err",
        result: badRequest('Field "modelId" must be a non-empty string when provided.'),
      };
    }
    modelId = obj.modelId.trim();
  }
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
  return { kind: "ok", value: { chatId, content, modelId } };
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
    .update(
      `${chat.id}|${String(chat.connectedScope.connectedAtMs)}|${chat.connectedScope.root ?? ""}`,
    )
    .digest("hex");
  return `cs-${hash.slice(0, 16)}`;
}

// Epic #532 — per-source scope id for the multi-source path. The index makes ids distinct even
// when two connected scopes share a root and connectedAtMs (e.g. the same folder added twice with
// differing relativePaths). The single-source path keeps `deriveScopeId(chat)` (index-free) so its
// scopeId — which the microIndex key and audit evidence derive from — stays byte-identical (AC5).
export function deriveScopeIdFrom(chat: Chat, cs: ChatConnectedScope, index: number): string {
  const hash = createHash("sha256")
    .update(`${chat.id}|${String(cs.connectedAtMs)}|${cs.root ?? ""}|${String(index)}`)
    .digest("hex");
  return `cs-${hash.slice(0, 16)}`;
}

// Builds ONE SelectedScope from a connected scope. `scopeId` is supplied by the caller so the
// single path can pass the legacy `deriveScopeId(chat)` value while the multi path passes a
// per-source id; everything else is identical between the two paths.
export function buildSelectedScopeFrom(
  chat: Chat,
  cs: ChatConnectedScope,
  scopeId: string,
): SelectedScope {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId,
    // Epic #532 — a connected folder may live outside the chat's project. When the scope carries
    // its own validated root, ground against that folder; otherwise fall back to the chat project.
    workspaceRoot: cs.root ?? chat.projectPath,
    kind: cs.kind,
    relativePaths: cs.relativePaths,
    conversationId: chat.id,
    connectedAtMs: cs.connectedAtMs,
    // This scope was built from a user-connected folder/files (Files↔Chat edge or scope pill), so
    // the planner may accept plain natural-language questions without a file/symbol anchor.
    explicitConnection: true,
  };
}

function buildSelectedScope(chat: Chat): SelectedScope | undefined {
  const cs = chat.connectedScope;
  if (cs === undefined) return undefined;
  return buildSelectedScopeFrom(chat, cs, deriveScopeId(chat));
}

function canonicalGroundedRoot(rootInput: string, deps: UiHandlerDeps): string | RouteResult {
  if (pathIsDenied(rootInput)) {
    return badRequest("Connected scope is excluded from Keiko's safe read surface.");
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(rootInput);
  } catch {
    return badRequest("Connected scope root is not accessible.");
  }
  if (pathIsDenied(realRoot)) {
    return badRequest("Connected scope is excluded from Keiko's safe read surface.");
  }
  const redacted = deps.redactor(realRoot);
  if (typeof redacted === "string" && redacted !== realRoot) {
    return badRequest("Connected scope root contains credential-shaped metadata.");
  }
  return realRoot;
}

function canonicalizeGroundedFolderScopes(
  chat: Chat,
  deps: UiHandlerDeps,
  scopes: readonly ChatConnectedScope[],
): readonly ChatConnectedScope[] | RouteResult {
  const canonical: ChatConnectedScope[] = [];
  for (const scope of scopes) {
    const realRoot = canonicalGroundedRoot(scope.root ?? chat.projectPath, deps);
    if (typeof realRoot !== "string") return realRoot;
    canonical.push({ ...scope, root: realRoot });
  }
  return canonical;
}

function withCanonicalFolderScopes(chat: Chat, scopes: readonly ChatConnectedScope[]): Chat {
  if (scopes.length === 0) return chat;
  return { ...chat, connectedScopes: scopes, connectedScope: scopes[0] };
}

export function buildQuery(content: string, nowMs: () => number): RetrievalQuery {
  return {
    kind: "natural-language",
    text: content,
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: nowMs(),
  };
}

// ─── Model Gateway answerer ───────────────────────────────────────────────────

function chatCapability(deps: UiHandlerDeps, modelId: string): ModelCapability | undefined {
  const config = currentGatewayConfig(deps);
  return config === undefined ? findCapability(modelId) : findConfiguredCapability(config, modelId);
}

function resolveGroundedModelId(
  deps: UiHandlerDeps,
  chat: Chat,
  requestedModelId: string | undefined,
): string | RouteResult {
  const modelId = requestedModelId ?? chat.selectedModel;
  const capability = chatCapability(deps, modelId);
  if (capability?.kind !== "chat") {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "modelId must be a configured chat model id."),
    };
  }
  return modelId;
}

function requestAbortSignal(ctx: RouteContext): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort("grounded request cancelled");
    }
  };
  ctx.req.on("aborted", abort);
  ctx.res.on("close", () => {
    if (!ctx.res.writableEnded) abort();
  });
  return controller.signal;
}

export function ensureNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CancelledError("grounded request cancelled");
  }
}

function formatLineRange(citation: GroundedEvidenceCitation): string {
  if (citation.lineRange === undefined) return citation.scopePath;
  return `${citation.scopePath}:${String(citation.lineRange.startLine)}-${String(citation.lineRange.endLine)}`;
}

function redactedString(redactor: Redactor, value: string): string {
  const redacted = redactor(value);
  return typeof redacted === "string" ? redacted : value;
}

export function promptSafeExcerptText(value: string): string {
  return value.split("```").join("` ` `");
}

export function packBudgetSummary(pack: ConnectedContextPack): string {
  const { usage, budget } = pack;
  return [
    `search calls ${String(usage.searchCalls)}/${String(budget.searchCallsMax)}`,
    `files read ${String(usage.filesRead)}/${String(budget.filesReadMax)}`,
    `excerpt bytes ${String(usage.excerptBytes)}/${String(budget.excerptBytesMax)}`,
    `model input tokens ${String(usage.modelInputTokens)}/${String(budget.modelInputTokensMax)}`,
    `model output tokens ${String(usage.modelOutputTokens)}/${String(budget.modelOutputTokensMax)}`,
    `rerank calls ${String(usage.rerankCalls)}/${String(budget.rerankCallsMax)}`,
    `elapsed ${String(usage.elapsedMs)}/${String(budget.elapsedMsMax)} ms`,
  ].join("; ");
}

export function evidenceLines(pack: ConnectedContextPack, redactor: Redactor): readonly string[] {
  const lines: string[] = [];
  for (const file of pack.files) {
    lines.push(`File: ${redactedString(redactor, file.scopePath)}`);
    if (file.excerpts.length === 0) {
      lines.push("- No excerpt content was available for this selected file.");
      continue;
    }
    for (const excerpt of file.excerpts) {
      const citation = formatLineRange({
        scopePath: excerpt.atom.scopePath,
        lineRange: excerpt.atom.lineRange,
        score: excerpt.atom.score,
        stableId: excerpt.atom.stableId,
      });
      lines.push(
        `- Evidence ${redactedString(redactor, citation)} (score ${excerpt.atom.score.toFixed(2)}):`,
      );
      lines.push("```");
      lines.push(promptSafeExcerptText(redactedString(redactor, excerpt.content)));
      lines.push("```");
    }
  }
  if (lines.length === 0) {
    lines.push("No evidence excerpts were selected for this question.");
  }
  return lines;
}

export function uncertaintyLines(
  pack: ConnectedContextPack,
  redactor: Redactor,
): readonly string[] {
  if (pack.uncertainty.length === 0) return ["None."];
  return pack.uncertainty.map(
    (marker) => `- ${marker.kind}: ${redactedString(redactor, marker.claim)}`,
  );
}

// The grounded system message is shared verbatim by the single-source and multi-source (#532)
// paths so both apply the identical untrusted-evidence + citation + no-secret guardrails. The
// single-source wire output must stay byte-identical (AC5), so this literal must not change.
// GROUNDED_SYSTEM_PROMPT now lives in the dependency-free ./grounded-prompt.js leaf (re-exported
// here for back-compat) so the hybrid path can interpolate it without a circular-import TDZ.
export { GROUNDED_SYSTEM_PROMPT };

function buildGroundedGatewayMessages(
  question: string,
  pack: ConnectedContextPack,
  redactor: Redactor,
): readonly GatewayChatMessage[] {
  const safeQuestion = redactedString(redactor, question);
  const userContent = [
    "User question:",
    safeQuestion,
    "",
    "Connected repository context pack:",
    `- schemaVersion: ${pack.schemaVersion}`,
    `- stableId: ${redactedString(redactor, pack.stableId)}`,
    `- scope kind: ${pack.scope.kind}`,
    `- query kind: ${pack.query.kind}`,
    `- budget/usage: ${packBudgetSummary(pack)}`,
    `- omitted evidence atoms: ${String(pack.omitted.length)}`,
    "",
    "Repository evidence excerpts:",
    ...evidenceLines(pack, redactor),
    "",
    "Known uncertainty from retrieval:",
    ...uncertaintyLines(pack, redactor),
  ].join("\n");
  return [
    { role: "system", content: GROUNDED_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

function createGatewayAnswerer(
  model: ModelPort,
  modelId: string,
  redactor: Redactor,
  signal: AbortSignal,
): GroundedAnswerer {
  return {
    answer: async (question, pack): Promise<GroundedAnswerResult> => {
      ensureNotCancelled(signal);
      const response = await model.call(
        {
          modelId,
          messages: buildGroundedGatewayMessages(question, pack, redactor),
          stream: false,
        },
        signal,
      );
      const content = response.content.trim();
      return {
        content: content.length > 0 ? content : "The model returned an empty response.",
        usage: {
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
        },
      };
    },
  };
}

function defaultRunner(
  deps: UiHandlerDeps,
  modelId: string,
  signal: AbortSignal,
): GroundedRunner | RouteResult {
  const model = deps.modelPortFactory(modelId);
  if (model === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  return (input: OrchestratorInput): Promise<OrchestratorOutput> => {
    const nowMs = Date.now;
    return runGroundedExploration(input, {
      answerer: createGatewayAnswerer(model, modelId, deps.redactor, signal),
      nowMs,
      signal,
      microIndex: microIndexForGroundedScope(input.scope, nowMs),
    });
  };
}

// ─── Citation projection ──────────────────────────────────────────────────────

export function redactString(redactor: Redactor, value: string): string {
  return redactor(value) as string;
}

export function buildCitations(
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

export function buildUncertainty(
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
// callers omit this seam and use the Model Gateway-backed default runner.
export type GroundedRunner = (input: OrchestratorInput) => Promise<OrchestratorOutput>;

// ─── Lookup helpers ───────────────────────────────────────────────────────────

// Epic #177 audit: the grounded-ask hot path scanned every project's chat list per request
// (O(projects × chats)). The chat id is unique across projects, so `UiStore.findChatById` is a
// single-row SELECT. This helper is kept (instead of inlining the store call) so callers can
// continue to depend on the deps surface rather than the store directly.
function findChatById(deps: UiHandlerDeps, chatId: string): Chat | undefined {
  return deps.store.findChatById(chatId);
}

// ─── Route worker (extracted to keep handleGroundedAsk under the LOC bound) ───

interface AskWorkerCtx {
  readonly chat: Chat;
  readonly scope: SelectedScope;
  readonly content: string;
  readonly modelId: string;
  readonly deps: UiHandlerDeps;
  readonly runner: GroundedRunner;
  readonly signal: AbortSignal;
}

interface PreparedGroundedAsk {
  readonly chat: Chat;
  readonly input: AskInput;
  readonly signal: AbortSignal;
}

// Atomic insert via the existing createMessages batch (wraps BEGIN/COMMIT) so a transient
// failure on the assistant insert rolls back the user insert. Returns both rows.
export function persistGroundedExchange(
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

function persistGroundedAuditEvidence(
  workerCtx: AskWorkerCtx,
  output: OrchestratorOutput,
  citationCount: number,
): string {
  const finishedAt = Date.now();
  const startedAt = Math.max(0, finishedAt - output.elapsedMs);
  const runId = `grounded-${randomUUID()}`;
  persistConnectedContextEvidence(
    {
      runId,
      modelId: workerCtx.modelId,
      // Epic #532 audit (L1): record the root that was ACTUALLY searched. For a connected external
      // folder scope.workspaceRoot is cs.root, not chat.projectPath — the evidence ledger must name
      // the real grounding root so the audit trail is honest about which tree produced the answer.
      workspaceRoot: workerCtx.scope.workspaceRoot,
      chatId: workerCtx.chat.id,
      plan: output.plan,
      pack: output.pack,
      citationCount,
      elapsedMs: output.elapsedMs,
      startedAt,
      finishedAt,
    },
    {
      store: workerCtx.deps.evidenceStore,
      env: workerCtx.deps.env,
      // Epic #177 audit: read the LIVE gateway-derived secrets list so apiKey/baseUrl values
      // added via the runtime PATCH /api/gateway/config path are scrubbed by the evidence
      // persister. `deps.redactionSecrets` is the startup snapshot frozen by buildUiHandlerDeps.
      additionalSecrets: currentRedactionSecrets(workerCtx.deps),
      costClassResolver: resolveCostClass,
    },
  );
  return runId;
}

async function runAsk(workerCtx: AskWorkerCtx): Promise<RouteResult> {
  const { chat, content, deps } = workerCtx;
  const query = buildQuery(content, () => Date.now());
  const output = await runGroundedRunner(workerCtx, query);
  if (isRouteResult(output)) return output;
  if (!isValidGroundedPack(output.pack)) {
    return internalError("Grounded answer context pack failed validation.");
  }
  const cancelResult = ensureRouteNotCancelled(workerCtx.signal, deps);
  if (cancelResult !== undefined) return cancelResult;
  const userContent = redactString(deps.redactor, content);
  const assistantContent = redactString(deps.redactor, output.assistantContent);
  const citations = buildCitations(output.pack, deps.redactor);
  const evidenceRunId = persistGroundedAuditEvidence(workerCtx, output, citations.length);
  const [userMessage, assistantMessage] = persistGroundedExchange(
    deps,
    chat.id,
    userContent,
    assistantContent,
  );
  const contextPack = buildGroundedAnswerContextPackSummary(
    output.pack,
    citations.length,
    output.elapsedMs,
  );
  const answer: GroundedAnswer = {
    groundingKind: "connected-context",
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    evidenceRunId,
    content: assistantContent,
    citations,
    uncertainty: buildUncertainty(output.pack, deps.redactor),
    omittedCount: output.pack.omitted.length,
    elapsedMs: output.elapsedMs,
    contextPack,
  };
  rememberGroundedTurn({
    assistantMessageId: assistantMessage.id,
    chatId: chat.id,
    workspaceRoot: output.pack.scope.workspaceRoot,
    evidenceRunId,
    packs: [output.pack],
  });
  return { status: 200, body: answer };
}

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value;
}

function ensureRouteNotCancelled(
  signal: AbortSignal,
  deps: UiHandlerDeps,
): RouteResult | undefined {
  try {
    ensureNotCancelled(signal);
    return undefined;
  } catch (error) {
    const gatewayResult = mappedGatewayError(error, deps);
    if (gatewayResult !== undefined) return gatewayResult;
    throw error;
  }
}

async function runGroundedRunner(
  workerCtx: AskWorkerCtx,
  query: RetrievalQuery,
): Promise<OrchestratorOutput | RouteResult> {
  const { scope, runner } = workerCtx;
  try {
    ensureNotCancelled(workerCtx.signal);
    // Epic #532 — ground against the scope's own root (a folder that may live outside the chat's
    // project), not the chat projectPath. buildSelectedScope set scope.workspaceRoot = cs.root ??
    // chat.projectPath, so a connected external folder resolves correctly.
    const output = await runner({ scope, query, workspaceRoot: scope.workspaceRoot });
    ensureNotCancelled(workerCtx.signal);
    return output;
  } catch (error) {
    if (error instanceof ClarificationNeededError) {
      return badRequest(error.message);
    }
    const workspaceResult = mappedWorkspaceError(error);
    if (workspaceResult !== undefined) return workspaceResult;
    const gatewayResult = mappedGatewayError(error, workerCtx.deps);
    if (gatewayResult !== undefined) return gatewayResult;
    throw error;
  }
}

async function prepareGroundedAsk(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<PreparedGroundedAsk | RouteResult> {
  const signal = requestAbortSignal(ctx);
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
  return { chat, input: parsed.value, signal };
}

function resolveGroundedRunner(
  deps: UiHandlerDeps,
  chat: Chat,
  requestedModelId: string | undefined,
  signal: AbortSignal,
  runner: GroundedRunner | undefined,
): { readonly modelId: string; readonly runner: GroundedRunner } | RouteResult {
  if (runner !== undefined) {
    return {
      modelId: requestedModelId ?? chat.selectedModel,
      runner,
    };
  }
  const modelId = resolveGroundedModelId(deps, chat, requestedModelId);
  if (typeof modelId !== "string") return modelId;
  const builtRunner = defaultRunner(deps, modelId, signal);
  if (typeof builtRunner !== "function") return builtRunner;
  return { modelId, runner: builtRunner };
}

// ─── Multi-source seam (test injection) ───────────────────────────────────────

// Epic #532 — the multi-source branch's two ports. Tests inject a deterministic retriever (no real
// workspace) plus an answerer; production omits this and builds both from the resolved model port.
export interface MultiSourceSeam {
  readonly retriever: GroundedRetriever;
  readonly answerer: MultiSourceAnswerer;
}

function resolveMultiSourceSeam(
  deps: UiHandlerDeps,
  modelId: string,
  signal: AbortSignal,
  override: MultiSourceSeam | undefined,
): MultiSourceSeam | RouteResult {
  if (override !== undefined) return override;
  const model = deps.modelPortFactory(modelId);
  if (model === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  return {
    retriever: defaultRetriever(signal),
    answerer: createMultiSourceAnswerer(model, modelId, deps.redactor, signal),
  };
}

async function dispatchMultiSourceAsk(
  args: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  scopes: ReturnType<typeof buildConnectedScopes>,
  seamOverride: MultiSourceSeam | undefined,
): Promise<RouteResult> {
  const { chat, input, signal } = args;
  // An injected seam (tests) bypasses model-capability resolution exactly as the single-source path
  // does for an injected runner: there is no real model port to validate against. Production (no
  // override) resolves the chat-model guardrails once, shared with the single path.
  const modelId =
    seamOverride !== undefined
      ? (input.modelId ?? chat.selectedModel)
      : resolveGroundedModelId(deps, chat, input.modelId);
  if (typeof modelId !== "string") return modelId;
  const seam = resolveMultiSourceSeam(deps, modelId, signal, seamOverride);
  if ("status" in seam) return seam;
  return runMultiSourceAsk({
    chat,
    scopes,
    content: input.content,
    modelId,
    deps,
    retriever: seam.retriever,
    answerer: seam.answerer,
    signal,
  });
}

// Epic #532 — builds the single-source SelectedScope from the canonical list when the legacy
// `connectedScope` field is absent. Uses index 0's per-source id; this branch never applies to a
// legacy chat (which carries `connectedScope`), so the byte-identical legacy path is untouched.
function singleScopeFromList(
  chat: Chat,
  scopes: ReturnType<typeof buildConnectedScopes>,
): SelectedScope | undefined {
  const cs = scopes[0];
  if (cs === undefined) return undefined;
  return buildSelectedScopeFrom(chat, cs, deriveScopeIdFrom(chat, cs, 0));
}

// Epic #532 — the folder-only branch (0 → bad request; 1 → the byte-identical legacy single-source
// runner; 2+ → the multi-source merge). Extracted so handleGroundedAsk stays the thin count-based
// dispatcher.
async function dispatchFolderAsk(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  scopes: ReturnType<typeof buildConnectedScopes>,
  runner: GroundedRunner | undefined,
  multiSource: MultiSourceSeam | undefined,
): Promise<RouteResult> {
  const { chat, input, signal } = prepared;
  if (scopes.length >= 2) {
    return dispatchMultiSourceAsk(prepared, deps, scopes, multiSource);
  }
  const scope = buildSelectedScope(chat) ?? singleScopeFromList(chat, scopes);
  if (scope === undefined) {
    return badRequest("Chat has no connected scope.");
  }
  // Epic #177 audit (GAP-B) — mirror the PATCH-route deny-list check for the grounded-ask hot
  // path. The PATCH route validates via validateFallbackProjectRoot before persisting a scope;
  // a chat whose projectPath was created before the deny-list was added (or via the test store)
  // could otherwise reach the orchestrator with a credential-dir workspaceRoot. Reject before
  // calling the runner so no filesystem access occurs against a denied path.
  if (pathIsDenied(scope.workspaceRoot)) {
    return badRequest("Connected scope is excluded from Keiko's safe read surface.");
  }
  const resolved = resolveGroundedRunner(deps, chat, input.modelId, signal, runner);
  if ("status" in resolved) return resolved;
  return runAsk({
    chat,
    scope,
    content: input.content,
    modelId: resolved.modelId,
    deps,
    runner: resolved.runner,
    signal,
  });
}

// ─── Hybrid seam (test injection) ─────────────────────────────────────────────

// Epic #189 — the hybrid branch's three ports. Tests inject deterministic retrieval/answer (no real
// workspace or embeddings); production omits this and builds them inside runHybridGroundedAsk.
export interface HybridSeam {
  readonly folderRetriever?: FolderRetriever;
  readonly connectorRetrieve?: ConnectorRetrieve;
  readonly answer?: HybridAnswerer;
}

function hybridSeamFields(seam: HybridSeam | undefined): Partial<{
  folderRetriever: FolderRetriever;
  connectorRetrieve: ConnectorRetrieve;
  answer: HybridAnswerer;
}> {
  if (seam === undefined) return {};
  return {
    ...(seam.folderRetriever !== undefined ? { folderRetriever: seam.folderRetriever } : {}),
    ...(seam.connectorRetrieve !== undefined ? { connectorRetrieve: seam.connectorRetrieve } : {}),
    ...(seam.answer !== undefined ? { answer: seam.answer } : {}),
  };
}

async function dispatchHybridAsk(
  prepared: PreparedGroundedAsk,
  deps: UiHandlerDeps,
  seam: HybridSeam | undefined,
): Promise<RouteResult> {
  const { chat, input, signal } = prepared;
  // An injected answerer (tests) bypasses model-capability resolution exactly as the multi-source
  // path does: there is no real model port to validate. Production resolves the guardrails once.
  const modelId =
    seam?.answer !== undefined
      ? (input.modelId ?? chat.selectedModel)
      : resolveGroundedModelId(deps, chat, input.modelId);
  if (typeof modelId !== "string") return modelId;
  return runHybridGroundedAsk({
    chat,
    content: input.content,
    modelId,
    deps,
    signal,
    ...hybridSeamFields(seam),
  });
}

// ─── Public handler ───────────────────────────────────────────────────────────

export async function handleGroundedAsk(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runner?: GroundedRunner,
  multiSource?: MultiSourceSeam,
  hybrid?: HybridSeam,
): Promise<RouteResult> {
  const prepared = await prepareGroundedAsk(ctx, deps);
  if ("status" in prepared) return prepared;
  const { chat } = prepared;
  // Epic #189 — count-based dispatch over BOTH source kinds. 0+0 → no scope. Connector-free chats
  // keep the EXISTING folder path (#532, byte-identical). A lone connector with no folders keeps the
  // EXISTING single-connector path (#189, byte-identical). Everything else (folders+connector, or
  // 2+ connectors) is the hybrid merge.
  const folderScopes = buildConnectedScopes(chat);
  const canonicalFolderScopes = canonicalizeGroundedFolderScopes(chat, deps, folderScopes);
  if (isRouteResult(canonicalFolderScopes)) return canonicalFolderScopes;
  const preparedWithCanonicalFolders: PreparedGroundedAsk = {
    ...prepared,
    chat: withCanonicalFolderScopes(chat, canonicalFolderScopes),
  };
  const connectorCount = buildLocalKnowledgeScopes(chat).length;
  if (folderScopes.length === 0 && connectorCount === 0) {
    return badRequest("Chat has no connected scope.");
  }
  if (connectorCount === 0) {
    return dispatchFolderAsk(
      preparedWithCanonicalFolders,
      deps,
      canonicalFolderScopes,
      runner,
      multiSource,
    );
  }
  if (folderScopes.length === 0 && connectorCount === 1) {
    return handleLocalKnowledgeGroundedAsk(chat, prepared.input, deps, prepared.signal);
  }
  return dispatchHybridAsk(preparedWithCanonicalFolders, deps, hybrid);
}
