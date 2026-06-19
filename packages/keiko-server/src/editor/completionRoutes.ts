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
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  EDITOR_COMPLETION_SCHEMA_VERSION,
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
} from "@oscharko-dev/keiko-contracts";
import { Gateway, selectCompletionModel } from "@oscharko-dev/keiko-model-gateway";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import { currentGatewayConfig, type UiHandlerDeps } from "../deps.js";
import { readJsonObject, resolveRoot, runFilesHandler } from "../files.js";
import { assembleCodingContext } from "./codingContext.js";
import { recordCodingContextEvidence } from "./codingContextEvidence.js";
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
    return response.content;
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
  readonly invoked: boolean;
  readonly promptHash?: string | undefined;
  readonly contextSources: readonly EditorCompletionSource[];
  readonly truncated: boolean;
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
  invoked: false,
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

// Runs the elected model: assembles coding context (#1211), records content-free evidence, and calls
// the gateway through the injected chat factory. A failure throws to the caller, which degrades.
async function runElectedModel(
  request: EditorCompletionWireRequest,
  realRoot: string,
  signal: AbortSignal,
  deps: UiHandlerDeps,
  selection: CompletionModelSelection,
  modelId: string,
  chatFactory: CompletionChatFactory,
  config: GatewayConfig,
): Promise<ModelTierOutcome> {
  const nowMs = Date.now();
  const pack = await assembleCodingContext(buildContextRequest(request), {
    deps,
    realRoot,
    signal,
    nowMs,
  });
  recordCodingContextEvidence(
    deps.evidenceStore,
    deps.redactor,
    toCodingContextWirePack(pack),
    nowMs,
  );
  const generated = await generateModelCompletions(
    {
      overlayText: request.document.text,
      position: request.position,
      languageId: request.document.languageId,
      contextPack: pack,
      maxItems: MAX_MODEL_ITEMS,
      maxInsertTextChars: MAX_MODEL_INSERT_TEXT_CHARS,
    },
    chatFactory(config, modelId),
    signal,
  );
  return {
    items: generated.items,
    modelMode: selection.mode,
    modelId,
    latencyClass: selection.latencyClass,
    invoked: true,
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
    return await runElectedModel(
      request,
      realRoot,
      signal,
      deps,
      selection,
      modelId,
      chatFactory,
      config,
    );
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
  model: readonly ModelCompletionItem[],
  deterministic: readonly LanguageCompletionItem[],
  maxItems: number,
): { items: readonly EditorCompletionWireItem[]; capped: boolean } {
  const items: EditorCompletionWireItem[] = [];
  const seen = new Set<string>();
  // Model-assisted items rank first; deterministic items follow. Duplicates by insert text are dropped.
  for (const item of model) {
    if (!seen.has(item.insertText)) {
      seen.add(item.insertText);
      items.push(wireItem(item, "model-assisted"));
    }
  }
  let capped = false;
  for (const item of deterministic) {
    const candidate = deterministicWireItem(item);
    if (seen.has(candidate.insertText)) {
      continue;
    }
    if (items.length >= maxItems) {
      capped = true;
      break;
    }
    seen.add(candidate.insertText);
    items.push(candidate);
  }
  return { items, capped };
}

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
    ...(model.modelId === undefined ? {} : { modelId: model.modelId }),
    ...(model.latencyClass === undefined ? {} : { latencyClass: model.latencyClass }),
    ...(model.degradeReason === undefined ? {} : { degradeReason: model.degradeReason }),
    ...(model.invoked ? { gatewayPolicyVersion: COMPLETION_GATEWAY_POLICY_VERSION } : {}),
    ...(model.promptHash === undefined ? {} : { promptHash: model.promptHash }),
  };
}

function buildWireResponse(
  deterministic: LanguageCompletionResult,
  model: ModelTierOutcome,
): EditorCompletionWireResponse {
  const { items, capped } = mergeItems(
    model.items,
    deterministic.items,
    DEFAULT_LANGUAGE_SERVICE_LIMITS.maxCompletionItems,
  );
  const producedModelItems = model.items.length > 0;
  return {
    schemaVersion: EDITOR_COMPLETION_SCHEMA_VERSION,
    items,
    isIncomplete: deterministic.isIncomplete || capped,
    truncated: deterministic.truncated || model.truncated || capped,
    provenance: buildProvenance(model, producedModelItems),
  };
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
    const signal = clientAbortSignal(ctx);

    // Tier 1: deterministic language-service completion (always).
    const langRequest: LanguageServiceRequest = {
      operation: "completion",
      root: request.root,
      document: request.document,
      position: request.position,
    };
    const outcome = runLanguageOperation(langRequest, {
      fs: nodeWorkspaceFs,
      realRoot: root.realRoot,
      overlayAbsolutePath,
      signal,
    });
    if (outcome.kind === "error") {
      return {
        status: STATUS_BY_CODE[outcome.code],
        body: errorBody(outcome.code, outcome.message),
      };
    }
    if (outcome.kind !== "completion") {
      // Unreachable: the request fixes operation to "completion". Defensive, keeps the type total.
      return { status: 500, body: errorBody("INTERNAL", "Unexpected language-service outcome.") };
    }

    // Tier 2: gated model-assisted completion.
    const model = await runModelTier(
      request,
      root.realRoot,
      signal,
      deps,
      options.chatFactory ?? defaultChatFactory,
    );

    return { status: 200, body: deps.redactor(buildWireResponse(outcome.result, model)) };
  });
}
