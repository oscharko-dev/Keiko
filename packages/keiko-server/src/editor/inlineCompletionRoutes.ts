// BFF routes for governed editor inline completion / ghost text (Issue #1200, ADR-0042 D5/D6).
//
//   POST /api/editor/inline-completion           — produce a single ghost-text continuation.
//   POST /api/editor/inline-completion/telemetry — record content-free acceptance/rejection counts.
//
// Inline completion is model-only and GATED. Unlike the #1199 completion gateway there is no
// deterministic ghost-text tier: the route runs the model ONLY when the completion-model selection
// (#1210) elects an aligned ("instruct"/"edit-tuned") suffix-aware (FIM) model in budget, and only
// when the interaction mode fits the trigger — an "automatic" (as-you-type) request requires a FAST
// FIM model, an "explicit" request additionally accepts a slower manual-invoke FIM model. When no
// governed model is usable, the feature is disabled by policy, or the per-root rate limit is hit, the
// route returns ZERO items so the editor degrades to the deterministic completion gateway (#1199) —
// never a silent ungoverned model (ADR-0042 D5; Acceptance Criteria 1/4).
//
// Model-assisted inline completion enriches its prompt with governed coding context (#1211,
// `purpose: "inline"` — repository search only; embedding-cost providers are excluded as
// keystroke-sensitive), assembled server-side and recorded as content-free evidence. The response is
// content-free apart from the reviewable `insertText` ghost text: a source/provenance rollup with a
// SHA-256 prompt hash, never the prompt, the buffer, or any retrieved excerpt. The browser never
// reaches the Model Gateway, retrieval, or any provider directly (Acceptance Criterion 5). Request
// pacing is bounded server-side by a per-root rate limiter (cooldown + window cap) plus the per-call
// cost ceiling and an as-you-type latency budget; output is bounded by a hard character cap.

import {
  CODING_CONTEXT_BUDGETS,
  CODING_CONTEXT_SCHEMA_VERSION,
  EDITOR_INLINE_COMPLETION_SCHEMA_VERSION,
  isValidScopePath,
  parseEditorInlineCompletionRequest,
  parseEditorInlineCompletionTelemetry,
  stripUnsafeFormatChars,
  toCodingContextWirePack,
  type CodingContextPack,
  type CodingContextRequest,
  type CompletionDegradeReason,
  type CompletionInteractionMode,
  type CompletionModelSelection,
  type CostClass,
  type EditorCompletionSource,
  type EditorInlineCompletionWireItem,
  type EditorInlineCompletionWireRequest,
  type EditorInlineCompletionWireResponse,
  type UsageMetadata,
} from "@oscharko-dev/keiko-contracts";
import { Gateway, selectCompletionModel } from "@oscharko-dev/keiko-model-gateway";
import type { EnvSource, GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import { currentGatewayConfig, type UiHandlerDeps } from "../deps.js";
import { readJsonObject, resolveRoot, runFilesHandler } from "../files.js";
import { assembleCodingContext } from "./codingContext.js";
import { recordCodingContextEvidence } from "./codingContextEvidence.js";
import { recordEditorCompletionModelEvidence } from "./completionModelEvidence.js";
import { recordInlineCompletionTelemetryEvidence } from "./inlineCompletionTelemetryEvidence.js";
import { clientAbortSignal, resolveOverlayPath } from "./languageRoutes.js";
import type { ModelChatFn } from "./editorCompletionModel.js";
import { generateInlineCompletion } from "./editorInlineCompletionModel.js";
import {
  createInlineCompletionRateLimiter,
  type InlineCompletionRateLimiter,
} from "./inlineCompletionRateLimiter.js";
import {
  accountModelUsage,
  sharedEditorModelTokenBudget,
  type EditorModelTokenBudget,
} from "./editorModelTokenBudget.js";

// Body cap: the overlay buffer may be up to the document-size cap; allow 64 KiB of JSON on top. The
// language-service document cap is reused via the coding-context completion budget's source ceiling.
const MAX_INLINE_BODY_BYTES = 1_048_576 + 64 * 1024;
const MAX_TELEMETRY_BODY_BYTES = 16 * 1024;
// Content-free identifier of the inline-completion governance policy version (audit correlation).
const INLINE_COMPLETION_GATEWAY_POLICY_VERSION = "editor-inline-completion/1";
// Hard upper bound on generated ghost-text length; `maxOutputTokens` may lower it (≈4 chars/token).
const MAX_INLINE_INSERT_TEXT_CHARS = 2_000;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_CONTEXT_CHANGED_FILES = 64;
// p95 latency budget for as-you-type ghost text (ADR-0042 D5): a fast FIM call self-cancels past it.
const MODEL_AS_YOU_TYPE_TIMEOUT_MS = 750;
// Policy/configuration gate (Acceptance Criterion 7). The feature is ENABLED by default; a deployment
// disables it by setting this env var to a falsy token.
const INLINE_COMPLETION_POLICY_ENV = "KEIKO_EDITOR_INLINE_COMPLETION";
const INLINE_COMPLETION_MAX_COST_CLASS_ENV = "KEIKO_EDITOR_INLINE_COMPLETION_MAX_COST_CLASS";
const DEFAULT_INLINE_COMPLETION_MAX_COST_CLASS: CostClass = "low";
const COST_CLASS_RANK: Readonly<Record<CostClass, number>> = { low: 0, medium: 1, high: 2 };
const DISABLE_TOKENS: ReadonlySet<string> = new Set(["0", "false", "off", "no", "disabled"]);

/** Builds the chat function for the elected model. Injectable so tests avoid a live model call. */
export type InlineCompletionChatFactory = (config: GatewayConfig, modelId: string) => ModelChatFn;

export interface EditorInlineCompletionRouteOptions {
  readonly chatFactory?: InlineCompletionChatFactory | undefined;
  /** Injectable per-root rate limiter (tests supply a fresh one); defaults to a shared instance. */
  readonly rateLimiter?: InlineCompletionRateLimiter | undefined;
  /** Injectable per-root token budget (tests supply a fresh one); defaults to a shared instance. */
  readonly tokenBudget?: EditorModelTokenBudget | undefined;
  /** Injectable clock for the rate limiter and evidence timestamps; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Injectable as-you-type model timeout for tests; production default is 750 ms. */
  readonly asYouTypeTimeoutMs?: number | undefined;
}

// Process-wide default limiter: shared so pacing spans requests within a server lifetime.
const sharedRateLimiter: InlineCompletionRateLimiter = createInlineCompletionRateLimiter();

// Default chat seam: route the elected model through the Model Gateway, server-side only.
function defaultChatFactory(config: GatewayConfig, modelId: string): ModelChatFn {
  const gateway = new Gateway(config);
  return async (chatRequest, chatSignal) => {
    const response = await gateway.chat({
      modelId,
      messages: [
        { role: "system", content: chatRequest.system },
        { role: "user", content: chatRequest.user },
      ],
      cancellationSignal: chatSignal,
    });
    return { content: response.content, usage: response.usage };
  };
}

/** Whether inline completion is enabled by deployment policy (default on; env toggle off). */
export function isInlineCompletionEnabledByPolicy(env: EnvSource | undefined): boolean {
  const raw = env?.[INLINE_COMPLETION_POLICY_ENV];
  if (raw === undefined) {
    return true;
  }
  return !DISABLE_TOKENS.has(raw.trim().toLowerCase());
}

function parseCostClass(value: string | undefined): CostClass | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (trimmed === "low" || trimmed === "medium" || trimmed === "high") {
    return trimmed;
  }
  return undefined;
}

function stricterCostClass(left: CostClass, right: CostClass): CostClass {
  return COST_CLASS_RANK[left] <= COST_CLASS_RANK[right] ? left : right;
}

export function inlineCompletionMaxCostClassFromPolicy(env: EnvSource | undefined): CostClass {
  return (
    parseCostClass(env?.[INLINE_COMPLETION_MAX_COST_CLASS_ENV]) ??
    DEFAULT_INLINE_COMPLETION_MAX_COST_CLASS
  );
}

function effectiveMaxCostClass(
  request: EditorInlineCompletionWireRequest,
  env: EnvSource | undefined,
): CostClass {
  const serverCeiling = inlineCompletionMaxCostClassFromPolicy(env);
  return request.maxCostClass === undefined
    ? serverCeiling
    : stricterCostClass(serverCeiling, request.maxCostClass);
}

function redactPromptText(deps: UiHandlerDeps, value: string): string {
  const stripped = stripUnsafeFormatChars(value);
  const redacted = deps.redactor(stripped);
  return typeof redacted === "string" ? redacted : stripped;
}

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

// ─── Model tier ────────────────────────────────────────────────────────────────────────────────

interface InlineModelOutcome {
  readonly item: { readonly insertText: string } | null;
  readonly modelMode: CompletionInteractionMode;
  readonly degradeReason?: CompletionDegradeReason | undefined;
  readonly modelId?: string | undefined;
  readonly latencyClass?: string | undefined;
  readonly promptHash?: string | undefined;
  readonly contextSources: readonly EditorCompletionSource[];
  // Token usage of the elected model call (content-free counts), recorded into the per-root token
  // budget by the tier; absent on every degrade/no-model path.
  readonly usage?: UsageMetadata | undefined;
}

interface ElectedInlineModelContext {
  readonly request: EditorInlineCompletionWireRequest;
  readonly realRoot: string;
  readonly signal: AbortSignal;
  readonly deps: UiHandlerDeps;
  readonly selection: CompletionModelSelection;
  readonly modelId: string;
  readonly chatFactory: InlineCompletionChatFactory;
  readonly config: GatewayConfig;
  readonly nowMs: number;
}

function noItemOutcome(
  mode: CompletionInteractionMode,
  degradeReason: CompletionDegradeReason | undefined,
  modelId: string | undefined,
  latencyClass: string | undefined,
): InlineModelOutcome {
  return { item: null, modelMode: mode, degradeReason, modelId, latencyClass, contextSources: [] };
}

function buildContextRequest(request: EditorInlineCompletionWireRequest): CodingContextRequest {
  return {
    schemaVersion: CODING_CONTEXT_SCHEMA_VERSION,
    purpose: "inline",
    documentPath: request.document.path,
    symbol: request.context?.symbol,
    queryText: request.context?.queryText,
    changedFiles: request.context?.changedFiles,
    capsuleId: request.context?.capsuleId,
    capsuleSetId: request.context?.capsuleSetId,
  };
}

function effectiveContextBudgetBytes(request: EditorInlineCompletionWireRequest): number {
  return Math.min(
    CODING_CONTEXT_BUDGETS.inline.budgetBytes,
    Math.max(0, Math.trunc(request.contextBudgetBytes)),
  );
}

function effectiveMaxInsertTextChars(request: EditorInlineCompletionWireRequest): number {
  const fromTokens =
    request.maxOutputTokens === undefined
      ? MAX_INLINE_INSERT_TEXT_CHARS
      : request.maxOutputTokens * APPROX_CHARS_PER_TOKEN;
  return Math.min(MAX_INLINE_INSERT_TEXT_CHARS, fromTokens);
}

function modelSignal(
  selection: CompletionModelSelection,
  signal: AbortSignal,
  timeoutMs: number,
): AbortSignal {
  if (selection.mode !== "as-you-type") {
    return signal;
  }
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

// Whether the elected interaction mode is eligible for THIS trigger: as-you-type runs on either
// trigger; the slower manual-invoke mode runs only on an explicit invocation, bounding per-keystroke
// model cost (ADR-0042 D5).
function modeEligibleForTrigger(
  selection: CompletionModelSelection,
  triggerKind: EditorInlineCompletionWireRequest["triggerKind"],
): boolean {
  if (selection.mode === "as-you-type") {
    return true;
  }
  return selection.mode === "manual" && triggerKind === "explicit";
}

// Map the coding-context source kinds that actually contributed an excerpt to the AC7 source vocab.
function contextSourcesFromPack(pack: CodingContextPack): readonly EditorCompletionSource[] {
  const mapping: Partial<
    Record<CodingContextPack["excerpts"][number]["citation"]["sourceKind"], EditorCompletionSource>
  > = {
    "repo-search": "repository-context",
    "local-knowledge": "local-knowledge",
    memory: "memory",
    "connected-context": "connected-context",
  };
  const sources = new Set<EditorCompletionSource>();
  for (const excerpt of pack.excerpts) {
    const mapped = mapping[excerpt.citation.sourceKind];
    if (mapped !== undefined) {
      sources.add(mapped);
    }
  }
  return [...sources];
}

function inlineGenerationInput(
  ctx: ElectedInlineModelContext,
  pack: CodingContextPack,
): Parameters<typeof generateInlineCompletion>[0] {
  return {
    overlayText: ctx.request.document.text,
    position: ctx.request.position,
    languageId: ctx.request.document.languageId,
    contextPack: pack,
    maxInsertTextChars: effectiveMaxInsertTextChars(ctx.request),
    redactText: (value) => redactPromptText(ctx.deps, value),
  };
}

// Runs the elected model: assembles coding context (#1211), records content-free evidence, calls the
// gateway through the injected chat factory, and filters the output. A failure throws to the caller,
// which degrades.
async function runElectedInlineModel(ctx: ElectedInlineModelContext): Promise<InlineModelOutcome> {
  const pack = await assembleCodingContext(buildContextRequest(ctx.request), {
    deps: ctx.deps,
    realRoot: ctx.realRoot,
    signal: ctx.signal,
    nowMs: ctx.nowMs,
    budgetBytes: effectiveContextBudgetBytes(ctx.request),
  });
  recordCodingContextEvidence(
    ctx.deps.evidenceStore,
    ctx.deps.redactor,
    toCodingContextWirePack(pack),
    ctx.nowMs,
  );
  const generated = await generateInlineCompletion(
    inlineGenerationInput(ctx, pack),
    ctx.chatFactory(ctx.config, ctx.modelId),
    ctx.signal,
  );
  const insertText = generated.insertText;
  recordEditorCompletionModelEvidence(
    ctx.deps.evidenceStore,
    ctx.deps.redactor,
    {
      modelId: ctx.modelId,
      modelMode: ctx.selection.mode,
      latencyClass: ctx.selection.latencyClass,
      gatewayPolicyVersion: INLINE_COMPLETION_GATEWAY_POLICY_VERSION,
      promptHash: generated.promptHash,
      itemCount: insertText === null ? 0 : 1,
      truncated: generated.truncated,
      usage: generated.usage,
    },
    ctx.nowMs,
  );
  return {
    item: insertText === null ? null : { insertText },
    modelMode: ctx.selection.mode,
    modelId: ctx.modelId,
    latencyClass: ctx.selection.latencyClass,
    promptHash: generated.promptHash,
    contextSources: insertText === null ? [] : contextSourcesFromPack(pack),
    ...(generated.usage === undefined ? {} : { usage: generated.usage }),
  };
}

// The model-selection decision: either skip the model tier with a content-free outcome, or run the
// elected model. Keeps the gate ordering out of `runInlineModelTier` so its complexity stays bounded.
type InlineModelDecision =
  | { readonly kind: "skip"; readonly outcome: InlineModelOutcome }
  | {
      readonly kind: "run";
      readonly selection: CompletionModelSelection;
      readonly modelId: string;
      readonly config: GatewayConfig;
    };

// Order of gates: gateway configured → model selection (cost ceiling + aligned-FIM guardrail, in
// selectCompletionModel) → trigger/mode eligibility. (Policy and rate limiting are applied by the
// caller around this decision.)
function decideInlineModel(
  request: EditorInlineCompletionWireRequest,
  deps: UiHandlerDeps,
): InlineModelDecision {
  const config = currentGatewayConfig(deps);
  if (config === undefined) {
    return {
      kind: "skip",
      outcome: noItemOutcome("deterministic", "no-infilling-model", undefined, undefined),
    };
  }
  const selection: CompletionModelSelection = selectCompletionModel(config, {
    maxCostClass: effectiveMaxCostClass(request, deps.env),
  });
  const modelId = selection.modelId;
  if (
    selection.mode === "deterministic" ||
    modelId === undefined ||
    !modeEligibleForTrigger(selection, request.triggerKind)
  ) {
    return {
      kind: "skip",
      outcome: noItemOutcome(
        selection.mode,
        selection.degradeReason,
        modelId,
        selection.latencyClass,
      ),
    };
  }
  return { kind: "run", selection, modelId, config };
}

// True when a server ceiling blocks the model tier: the per-root request-rate limiter (#1200) or the
// per-root token budget (#1206 LLM10). `tryAcquire` records the request, so it is evaluated first.
function inlineModelTierBlocked(
  realRoot: string,
  nowMs: number,
  limiter: InlineCompletionRateLimiter,
  tokenBudget: EditorModelTokenBudget,
): boolean {
  return !limiter.tryAcquire(realRoot, nowMs) || tokenBudget.isExhausted(realRoot, nowMs);
}

// Decides whether the gated model tier runs and, if so, runs it. Order: policy → model decision →
// per-root request and token ceilings → run (a model/retrieval failure degrades to zero items).
async function runInlineModelTier(
  request: EditorInlineCompletionWireRequest,
  realRoot: string,
  signal: AbortSignal,
  deps: UiHandlerDeps,
  options: EditorInlineCompletionRouteOptions,
): Promise<InlineModelOutcome> {
  const now = options.now ?? Date.now;
  if (!isInlineCompletionEnabledByPolicy(deps.env)) {
    return noItemOutcome("deterministic", undefined, undefined, undefined);
  }
  const decision = decideInlineModel(request, deps);
  if (decision.kind === "skip") {
    return decision.outcome;
  }
  const { selection, modelId, config } = decision;
  const limiter = options.rateLimiter ?? sharedRateLimiter;
  const tokenBudget = options.tokenBudget ?? sharedEditorModelTokenBudget;
  if (inlineModelTierBlocked(realRoot, now(), limiter, tokenBudget)) {
    // Request rate (#1200) or token ceiling (#1206 LLM10) hit: render no ghost text (degrade to #1199).
    return noItemOutcome(selection.mode, undefined, modelId, selection.latencyClass);
  }
  try {
    const outcome = await runElectedInlineModel({
      request,
      realRoot,
      signal: modelSignal(
        selection,
        signal,
        options.asYouTypeTimeoutMs ?? MODEL_AS_YOU_TYPE_TIMEOUT_MS,
      ),
      deps,
      selection,
      modelId,
      chatFactory: options.chatFactory ?? defaultChatFactory,
      config,
      nowMs: now(),
    });
    accountModelUsage(tokenBudget, realRoot, now(), outcome.usage);
    return outcome;
  } catch {
    // ADR-0042 D5 / AC1: a model or retrieval failure renders no ghost text; it never breaks the route.
    return noItemOutcome(selection.mode, selection.degradeReason, modelId, selection.latencyClass);
  }
}

// ─── Request sanitisation (mirrors the completion gateway's containment checks) ──────────────────

function dedupeChangedFiles(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

function invalidChangedFiles(message: string): RouteResult {
  return { status: 400, body: errorBody("INVALID_REQUEST", message) };
}

function sanitizeChangedFiles(
  realRoot: string,
  changedFiles: readonly string[] | undefined,
): readonly string[] | RouteResult | undefined {
  if (changedFiles === undefined) {
    return undefined;
  }
  const deduped = dedupeChangedFiles(changedFiles);
  if (deduped.length > MAX_CONTEXT_CHANGED_FILES) {
    return invalidChangedFiles(
      `context.changedFiles must contain at most ${MAX_CONTEXT_CHANGED_FILES.toString()} paths.`,
    );
  }
  for (const changed of deduped) {
    if (!isValidScopePath(changed, { mustBeRelative: true })) {
      return invalidChangedFiles(
        `context.changedFiles contains an invalid workspace-relative path: ${changed}`,
      );
    }
    resolveOverlayPath(realRoot, changed);
  }
  return deduped.length > 0 ? deduped : undefined;
}

function sanitizeRequestContext(
  request: EditorInlineCompletionWireRequest,
  realRoot: string,
): EditorInlineCompletionWireRequest | RouteResult {
  const changedFiles = sanitizeChangedFiles(realRoot, request.context?.changedFiles);
  if (isRouteResult(changedFiles)) {
    return changedFiles;
  }
  if (request.context === undefined) {
    return request;
  }
  return {
    ...request,
    context: {
      ...(request.context.queryText === undefined ? {} : { queryText: request.context.queryText }),
      ...(request.context.symbol === undefined ? {} : { symbol: request.context.symbol }),
      ...(request.context.capsuleId === undefined ? {} : { capsuleId: request.context.capsuleId }),
      ...(request.context.capsuleSetId === undefined
        ? {}
        : { capsuleSetId: request.context.capsuleSetId }),
      ...(changedFiles === undefined ? {} : { changedFiles }),
    },
  };
}

// ─── Wire-response assembly ──────────────────────────────────────────────────────────────────────

function buildProvenance(
  outcome: InlineModelOutcome,
  produced: boolean,
): EditorInlineCompletionWireResponse["provenance"] {
  const sources: EditorCompletionSource[] = produced
    ? ["model-assisted", ...outcome.contextSources]
    : [];
  return {
    sources: [...new Set(sources)],
    modelMode: outcome.modelMode,
    ...(outcome.degradeReason === undefined ? {} : { degradeReason: outcome.degradeReason }),
    ...(produced && outcome.modelId !== undefined ? { modelId: outcome.modelId } : {}),
    ...(produced && outcome.latencyClass !== undefined
      ? { latencyClass: outcome.latencyClass }
      : {}),
    ...(produced ? { gatewayPolicyVersion: INLINE_COMPLETION_GATEWAY_POLICY_VERSION } : {}),
    ...(produced && outcome.promptHash !== undefined ? { promptHash: outcome.promptHash } : {}),
  };
}

function buildWireResponse(outcome: InlineModelOutcome): EditorInlineCompletionWireResponse {
  const items: EditorInlineCompletionWireItem[] =
    outcome.item === null ? [] : [{ insertText: outcome.item.insertText }];
  return {
    schemaVersion: EDITOR_INLINE_COMPLETION_SCHEMA_VERSION,
    items,
    provenance: buildProvenance(outcome, items.length > 0),
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────────────────────

export async function handleEditorInlineCompletion(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: EditorInlineCompletionRouteOptions = {},
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_INLINE_BODY_BYTES);
  if (isRouteResult(body)) {
    return body;
  }
  const parsed = parseEditorInlineCompletionRequest(body);
  if (!parsed.ok) {
    return { status: 400, body: errorBody("INVALID_REQUEST", parsed.errors.join("; ")) };
  }
  const request = parsed.value;
  return runFilesHandler(async () => {
    const root = await resolveRoot(deps.store, request.root, deps.redactor);
    // Containment check for the overlay document path (throws on escape → handled by runFilesHandler).
    resolveOverlayPath(root.realRoot, request.document.path);
    const sanitizedRequest = sanitizeRequestContext(request, root.realRoot);
    if (isRouteResult(sanitizedRequest)) {
      return sanitizedRequest;
    }
    const signal = clientAbortSignal(ctx);
    const outcome = await runInlineModelTier(
      sanitizedRequest,
      root.realRoot,
      signal,
      deps,
      options,
    );
    return { status: 200, body: deps.redactor(buildWireResponse(outcome)) };
  });
}

export async function handleEditorInlineCompletionTelemetry(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: Pick<EditorInlineCompletionRouteOptions, "now"> = {},
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_TELEMETRY_BODY_BYTES);
  if (isRouteResult(body)) {
    return body;
  }
  const parsed = parseEditorInlineCompletionTelemetry(body);
  if (!parsed.ok) {
    return { status: 400, body: errorBody("INVALID_REQUEST", parsed.errors.join("; ")) };
  }
  return runFilesHandler(async () => {
    const root = await resolveRoot(deps.store, parsed.value.root, deps.redactor);
    const now = options.now ?? Date.now;
    recordInlineCompletionTelemetryEvidence(
      deps.evidenceStore,
      deps.redactor,
      { ...parsed.value, root: root.realRoot },
      now(),
    );
    return { status: 200, body: deps.redactor({ ok: true }) };
  });
}
