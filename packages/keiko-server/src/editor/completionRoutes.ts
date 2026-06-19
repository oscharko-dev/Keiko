// BFF route for the governed editor completion gateway (Issue #1199, ADR-0042 D4/D5/D6).
//
//   POST /api/editor/completion — produce completion items for an editor overlay. Two governed tiers:
//     Tier 1 (always): deterministic, model-free language-service completion (#1198) — the source of
//       truth and the always-available default.
//     Tier 2 (gated):  model-assisted completion routed through the Model Gateway, run ONLY when the
//       completion-model selection (#1210) elects an aligned ("instruct"/"edit-tuned") infilling model
//       in budget. The as-you-type tier may run on a trigger character; the manual tier runs only on an
//       explicit invoke. When no governed model is usable the route degrades to deterministic-only and
//       records the content-free degrade reason — never a silent ungoverned fallback.
//
// Model-assisted completion enriches its prompt with governed coding context (#1211, repository search
// plus — when a capsule/capsule-set is selected and the budget allows — Local Knowledge and retained
// memory), assembled server-side and recorded as content-free evidence. The response is content-free
// apart from reviewable `insertText`: per-item origin plus a source/provenance rollup with a SHA-256
// prompt hash, never the prompt, the buffer, or any retrieved excerpt. The browser never reaches the
// Model Gateway, retrieval, or any provider directly (Acceptance Criterion 5).

import {
  CODING_CONTEXT_SCHEMA_VERSION,
  CODING_CONTEXT_BUDGETS,
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  EDITOR_COMPLETION_SCHEMA_VERSION,
  isValidScopePath,
  parseEditorCompletionRequest,
  toCodingContextWirePack,
  type CodingContextPack,
  type CodingContextRequest,
  type CompletionDegradeReason,
  type CompletionInteractionMode,
  type CompletionModelSelection,
  type EditorCompletionItemOrigin,
  type EditorCompletionSource,
  type EditorCompletionWireItem,
  type EditorCompletionWireRequest,
  type EditorCompletionWireResponse,
  type LanguageCompletionItem,
  type LanguageCompletionResult,
  type LanguageServiceRequest,
  type UsageMetadata,
} from "@oscharko-dev/keiko-contracts";
import { Gateway, selectCompletionModel } from "@oscharko-dev/keiko-model-gateway";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import { currentGatewayConfig, type UiHandlerDeps } from "../deps.js";
import { readJsonObject, resolveRoot, runFilesHandler } from "../files.js";
import { assembleCodingContext } from "./codingContext.js";
import { recordCodingContextEvidence } from "./codingContextEvidence.js";
import { recordEditorCompletionModelEvidence } from "./completionModelEvidence.js";
import { clientAbortSignal, resolveOverlayPath, STATUS_BY_CODE } from "./languageRoutes.js";
import { runLanguageOperation } from "./languageService.js";
import {
  generateModelCompletions,
  type ModelChatFn,
  type ModelCompletionItem,
} from "./editorCompletionModel.js";

// The overlay buffer may be up to the document-size cap; allow 64 KiB of JSON envelope on top.
const MAX_COMPLETION_BODY_BYTES = DEFAULT_LANGUAGE_SERVICE_LIMITS.maxDocumentBytes + 64 * 1024;
// Content-free identifier of the completion governance policy version (audit correlation).
const COMPLETION_GATEWAY_POLICY_VERSION = "editor-completion/1";
const MAX_MODEL_ITEMS = 8;
const MAX_MODEL_INSERT_TEXT_CHARS = 2_000;
const MAX_CONTEXT_CHANGED_FILES = 64;
export const COMPLETION_LANGUAGE_SERVICE_LIMITS = {
  ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
  deadlineMs: 500,
} as const;
const MODEL_AS_YOU_TYPE_TIMEOUT_MS = 750;

/** Builds the chat function for the elected model. Injectable so tests avoid a live model call. */
export type CompletionChatFactory = (config: GatewayConfig, modelId: string) => ModelChatFn;

export interface EditorCompletionRouteOptions {
  readonly chatFactory?: CompletionChatFactory | undefined;
}

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

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

// ─── Model tier (gated) ────────────────────────────────────────────────────────────────────────

interface ModelTierOutcome {
  readonly items: readonly ModelCompletionItem[];
  readonly modelMode: CompletionInteractionMode;
  readonly degradeReason?: CompletionDegradeReason | undefined;
  readonly modelId?: string | undefined;
  readonly latencyClass?: string | undefined;
  readonly promptHash?: string | undefined;
  readonly contextSources: readonly EditorCompletionSource[];
  readonly truncated: boolean;
}

interface ElectedModelContext {
  readonly request: EditorCompletionWireRequest;
  readonly realRoot: string;
  readonly signal: AbortSignal;
  readonly deps: UiHandlerDeps;
  readonly selection: CompletionModelSelection;
  readonly modelId: string;
  readonly chatFactory: CompletionChatFactory;
  readonly config: GatewayConfig;
}

const DETERMINISTIC_OUTCOME = (
  mode: CompletionInteractionMode,
  degradeReason: CompletionDegradeReason | undefined,
  modelId: string | undefined,
  latencyClass: string | undefined,
): ModelTierOutcome => ({
  items: [],
  modelMode: mode,
  degradeReason,
  modelId,
  latencyClass,
  contextSources: [],
  truncated: false,
});

function buildContextRequest(request: EditorCompletionWireRequest): CodingContextRequest {
  return {
    schemaVersion: CODING_CONTEXT_SCHEMA_VERSION,
    purpose: "completion",
    documentPath: request.document.path,
    symbol: request.context?.symbol,
    queryText: request.context?.queryText,
    changedFiles: request.context?.changedFiles,
    capsuleId: request.context?.capsuleId,
    capsuleSetId: request.context?.capsuleSetId,
  };
}

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
  request: EditorCompletionWireRequest,
  realRoot: string,
): EditorCompletionWireRequest | RouteResult {
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

function effectiveContextBudgetBytes(request: EditorCompletionWireRequest): number {
  return Math.min(
    CODING_CONTEXT_BUDGETS.completion.budgetBytes,
    Math.max(0, Math.trunc(request.contextBudgetBytes)),
  );
}

function modelSignal(selection: CompletionModelSelection, signal: AbortSignal): AbortSignal {
  if (selection.mode !== "as-you-type") {
    return signal;
  }
  return AbortSignal.any([signal, AbortSignal.timeout(MODEL_AS_YOU_TYPE_TIMEOUT_MS)]);
}

// Map the coding-context source kinds that actually contributed an excerpt to the AC7 completion
// source vocabulary. Source kinds outside that vocabulary (QI, workflow, files-focus) are not surfaced.
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

function recordModelEvidence(input: {
  readonly deps: UiHandlerDeps;
  readonly modelId: string;
  readonly selection: CompletionModelSelection;
  readonly promptHash: string;
  readonly itemCount: number;
  readonly truncated: boolean;
  readonly usage: UsageMetadata | undefined;
  readonly nowMs: number;
}): void {
  recordEditorCompletionModelEvidence(
    input.deps.evidenceStore,
    input.deps.redactor,
    {
      modelId: input.modelId,
      modelMode: input.selection.mode,
      latencyClass: input.selection.latencyClass,
      gatewayPolicyVersion: COMPLETION_GATEWAY_POLICY_VERSION,
      promptHash: input.promptHash,
      itemCount: input.itemCount,
      truncated: input.truncated,
      usage: input.usage,
    },
    input.nowMs,
  );
}

// Runs the elected model: assembles coding context (#1211), records content-free evidence, and calls
// the gateway through the injected chat factory. A failure throws to the caller, which degrades.
async function runElectedModel(ctx: ElectedModelContext): Promise<ModelTierOutcome> {
  const nowMs = Date.now();
  const pack = await assembleCodingContext(buildContextRequest(ctx.request), {
    deps: ctx.deps,
    realRoot: ctx.realRoot,
    signal: ctx.signal,
    nowMs,
    budgetBytes: effectiveContextBudgetBytes(ctx.request),
  });
  recordCodingContextEvidence(
    ctx.deps.evidenceStore,
    ctx.deps.redactor,
    toCodingContextWirePack(pack),
    nowMs,
  );
  const generated = await generateModelCompletions(
    {
      overlayText: ctx.request.document.text,
      position: ctx.request.position,
      languageId: ctx.request.document.languageId,
      contextPack: pack,
      maxItems: MAX_MODEL_ITEMS,
      maxInsertTextChars: MAX_MODEL_INSERT_TEXT_CHARS,
    },
    ctx.chatFactory(ctx.config, ctx.modelId),
    ctx.signal,
  );
  recordModelEvidence({
    deps: ctx.deps,
    modelId: ctx.modelId,
    selection: ctx.selection,
    promptHash: generated.promptHash,
    itemCount: generated.items.length,
    truncated: generated.truncated,
    usage: generated.usage,
    nowMs,
  });
  return {
    items: generated.items,
    modelMode: ctx.selection.mode,
    modelId: ctx.modelId,
    latencyClass: ctx.selection.latencyClass,
    promptHash: generated.promptHash,
    contextSources: generated.items.length > 0 ? contextSourcesFromPack(pack) : [],
    truncated: generated.truncated,
  };
}

// Decides whether the gated model tier runs for this request and, if so, runs it. The cost ceiling
// (#1206) and the aligned-FIM guardrail (#1210) are enforced by `selectCompletionModel`.
async function runModelTier(
  request: EditorCompletionWireRequest,
  realRoot: string,
  signal: AbortSignal,
  deps: UiHandlerDeps,
  chatFactory: CompletionChatFactory,
): Promise<ModelTierOutcome> {
  const config = currentGatewayConfig(deps);
  if (config === undefined) {
    return DETERMINISTIC_OUTCOME("deterministic", "no-infilling-model", undefined, undefined);
  }
  const selection: CompletionModelSelection = selectCompletionModel(
    config,
    request.maxCostClass === undefined ? {} : { maxCostClass: request.maxCostClass },
  );
  const modelId = selection.modelId;
  // As-you-type-capable (fast) models may run on a trigger character; a manual-only model runs only on
  // an explicit invoke, bounding per-keystroke cost (ADR-0042 D5/D6).
  const triggerEligible = request.triggerKind === "invoked" || selection.mode === "as-you-type";
  if (selection.mode === "deterministic" || modelId === undefined || !triggerEligible) {
    return DETERMINISTIC_OUTCOME(
      selection.mode,
      selection.degradeReason,
      modelId,
      selection.latencyClass,
    );
  }
  try {
    return await runElectedModel({
      request,
      realRoot,
      signal: modelSignal(selection, signal),
      deps,
      selection,
      modelId,
      chatFactory,
      config,
    });
  } catch {
    // ADR-0042 D5 / AC4: a model or retrieval failure degrades to deterministic-only; it never breaks
    // the route or surfaces partial junk to the editor.
    return DETERMINISTIC_OUTCOME(
      selection.mode,
      selection.degradeReason,
      modelId,
      selection.latencyClass,
    );
  }
}

// ─── Wire-response assembly ──────────────────────────────────────────────────────────────────────

function wireItem(
  item: {
    label: string;
    kind: LanguageCompletionItem["kind"];
    insertText: string;
    detail?: string | undefined;
    sortText?: string | undefined;
  },
  origin: EditorCompletionItemOrigin,
): EditorCompletionWireItem {
  return {
    label: item.label,
    kind: item.kind,
    insertText: item.insertText,
    origin,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.sortText === undefined ? {} : { sortText: item.sortText }),
  };
}

function deterministicWireItem(item: LanguageCompletionItem): EditorCompletionWireItem {
  return wireItem(
    {
      label: item.label,
      kind: item.kind,
      // LSP completion items may omit `insertText` (the label is inserted verbatim).
      insertText: item.insertText ?? item.label,
      detail: item.detail,
      sortText: item.sortText,
    },
    "deterministic",
  );
}

function mergeItems(
  deterministic: readonly LanguageCompletionItem[],
  model: readonly ModelCompletionItem[],
  maxItems: number,
): { items: readonly EditorCompletionWireItem[]; capped: boolean } {
  const items: EditorCompletionWireItem[] = [];
  const seen = new Set<string>();
  let capped = false;

  function push(candidate: EditorCompletionWireItem): void {
    if (seen.has(candidate.insertText)) {
      return;
    }
    if (items.length >= maxItems) {
      capped = true;
      return;
    }
    seen.add(candidate.insertText);
    items.push(candidate);
  }

  // Deterministic completions remain first and win de-dupe conflicts; model items are additive.
  for (const item of deterministic) {
    push(deterministicWireItem(item));
  }
  for (const item of model) {
    push(wireItem(item, "model-assisted"));
  }
  return { items, capped };
}

// The model-identifying fields (modelId, latencyClass, gatewayPolicyVersion, promptHash) are present
// only when model-assisted items were actually produced — they identify the model that produced THIS
// response's items, matching the wire contract. `modelMode`/`degradeReason` always reflect the
// selection, so an elected-but-unused model is still visible to the client without a misleading
// model-identity/audit signal at the response level. (The model invocation itself, including the
// invoked-but-empty case, is recorded server-side as content-free evidence by the route.)
function buildProvenance(
  model: ModelTierOutcome,
  producedModelItems: boolean,
): EditorCompletionWireResponse["provenance"] {
  const sources: EditorCompletionSource[] = ["deterministic-language-service"];
  if (producedModelItems) {
    sources.push("model-assisted", ...model.contextSources);
  }
  return {
    sources: [...new Set(sources)],
    modelMode: model.modelMode,
    ...(model.degradeReason === undefined ? {} : { degradeReason: model.degradeReason }),
    ...(producedModelItems && model.modelId !== undefined ? { modelId: model.modelId } : {}),
    ...(producedModelItems && model.latencyClass !== undefined
      ? { latencyClass: model.latencyClass }
      : {}),
    ...(producedModelItems ? { gatewayPolicyVersion: COMPLETION_GATEWAY_POLICY_VERSION } : {}),
    ...(producedModelItems && model.promptHash !== undefined
      ? { promptHash: model.promptHash }
      : {}),
  };
}

function buildWireResponse(
  deterministic: LanguageCompletionResult,
  model: ModelTierOutcome,
): EditorCompletionWireResponse {
  const { items, capped } = mergeItems(
    deterministic.items,
    model.items,
    DEFAULT_LANGUAGE_SERVICE_LIMITS.maxCompletionItems,
  );
  const producedModelItems = items.some((item) => item.origin === "model-assisted");
  return {
    schemaVersion: EDITOR_COMPLETION_SCHEMA_VERSION,
    items,
    isIncomplete: deterministic.isIncomplete || capped,
    truncated: deterministic.truncated || model.truncated || capped,
    provenance: buildProvenance(model, producedModelItems),
  };
}

function runDeterministicCompletion(input: {
  readonly request: EditorCompletionWireRequest;
  readonly realRoot: string;
  readonly overlayAbsolutePath: string;
  readonly signal: AbortSignal;
}): LanguageCompletionResult | RouteResult {
  const langRequest: LanguageServiceRequest = {
    operation: "completion",
    root: input.request.root,
    document: input.request.document,
    position: input.request.position,
  };
  const outcome = runLanguageOperation(langRequest, {
    fs: nodeWorkspaceFs,
    realRoot: input.realRoot,
    overlayAbsolutePath: input.overlayAbsolutePath,
    signal: input.signal,
    limits: COMPLETION_LANGUAGE_SERVICE_LIMITS,
  });
  if (outcome.kind === "error") {
    return {
      status: STATUS_BY_CODE[outcome.code],
      body: errorBody(outcome.code, outcome.message),
    };
  }
  if (outcome.kind !== "completion") {
    return { status: 500, body: errorBody("INTERNAL", "Unexpected language-service outcome.") };
  }
  return outcome.result;
}

// ─── Route ──────────────────────────────────────────────────────────────────────────────────────

export async function handleEditorCompletion(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: EditorCompletionRouteOptions = {},
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_COMPLETION_BODY_BYTES);
  if (isRouteResult(body)) {
    return body;
  }
  const parsed = parseEditorCompletionRequest(body);
  if (!parsed.ok) {
    return { status: 400, body: errorBody("INVALID_REQUEST", parsed.errors.join("; ")) };
  }
  const request = parsed.value;
  return runFilesHandler(async () => {
    const root = await resolveRoot(deps.store, request.root, deps.redactor);
    const overlayAbsolutePath = resolveOverlayPath(root.realRoot, request.document.path);
    const sanitizedRequest = sanitizeRequestContext(request, root.realRoot);
    if (isRouteResult(sanitizedRequest)) {
      return sanitizedRequest;
    }
    const signal = clientAbortSignal(ctx);

    // Tier 1: deterministic language-service completion (always).
    const deterministic = runDeterministicCompletion({
      request: sanitizedRequest,
      realRoot: root.realRoot,
      overlayAbsolutePath,
      signal,
    });
    if (isRouteResult(deterministic)) {
      return deterministic;
    }

    // Tier 2: gated model-assisted completion.
    const model = await runModelTier(
      sanitizedRequest,
      root.realRoot,
      signal,
      deps,
      options.chatFactory ?? defaultChatFactory,
    );

    return { status: 200, body: deps.redactor(buildWireResponse(deterministic, model)) };
  });
}
