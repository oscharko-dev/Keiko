import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpTool } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  DEFAULT_CONTEXT_PROFILE,
  deriveContextProfileFromCapability,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import {
  findConfiguredCapability,
  type GatewayCallRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { createToolDescriptor, createToolRef } from "@oscharko-dev/keiko-tool-catalog";
import { object, text } from "./atlassian/jiraManagedSchemas.js";
import { raceAbort } from "./abort-race.js";
import { GATEWAY_BUFFERED_BUDGET_FLOOR_MS } from "@oscharko-dev/keiko-model-gateway/internal/resilience";
import { fitToolRoundOutput } from "./chat-tool-continuation-fit.js";
import { withChatContentPolicy } from "./content-redactor.js";
import { currentGatewayConfig, type UiHandlerDeps } from "./deps.js";
import { depsRoot } from "./request-deps-root.js";
import { encodeCursor } from "./requirement-inventory.js";
import type { RequirementsToolContext } from "./requirementsTool.js";
import { KNOWLEDGE_REVIEW_TOOL } from "./requirementsToolName.js";
import { KNOWLEDGE_RESULT_SCHEMA } from "./knowledgeDocumentsTool.js";
import {
  KNOWLEDGE_REVIEW_FAILURE_STAGES,
  KNOWLEDGE_REVIEW_VALIDATION_REASONS,
  type KnowledgeReviewFailureStage,
  type KnowledgeReviewObservation,
} from "./knowledge-document-activity.js";
import {
  knowledgeDigest,
  knowledgeWindowEnd,
  decodeKnowledgeCursor,
  knowledgeDocumentRevision,
  knowledgeDocumentScope,
  findKnowledgeDocument,
  readKnowledgeDocument,
  type ReadKnowledgeDocument,
} from "./knowledge-document-source.js";
import {
  executeKnowledgeTool,
  knowledgeToolFailure,
  KNOWLEDGE_TOOL_RESULT_BYTES_MAX,
  type KnowledgeToolEnvironment,
  type KnowledgeToolRead,
} from "./knowledge-tool-execution.js";
import {
  REVIEW_FINDINGS_MAX,
  semanticReviewFormat,
  semanticReviewInstruction,
  reviewAnchors,
  reviewWindowCount,
  reviewPrompt,
  parseSemanticReviewDetailed,
  renderSemanticFindings,
  type SemanticReview,
  type ReviewAnchor,
} from "./knowledge-semantic-review.js";

const REVIEW_COUNT_SCHEMA = { type: "integer", minimum: 0 } as const;
const REVIEW_FLAG_SCHEMA = { type: "boolean" } as const;
const REVIEW_SOURCE_SCHEMA = object({
  documentScope: text(8),
  revisionDigest: text(64),
  textRevision: text(64),
  characterStart: REVIEW_COUNT_SCHEMA,
  characterEnd: REVIEW_COUNT_SCHEMA,
  quote: text(100),
  quoteTruncated: REVIEW_FLAG_SCHEMA,
});
const KNOWLEDGE_REVIEW_RESULT_SCHEMA: CatalogJsonObject = {
  ...KNOWLEDGE_RESULT_SCHEMA,
  properties: {
    ...(KNOWLEDGE_RESULT_SCHEMA.properties as CatalogJsonObject),
    failureStage: { type: "string", enum: KNOWLEDGE_REVIEW_FAILURE_STAGES },
    validationReason: { type: "string", enum: KNOWLEDGE_REVIEW_VALIDATION_REASONS },
    sourceAvailable: REVIEW_FLAG_SCHEMA,
    items: {
      type: "array",
      maxItems: REVIEW_FINDINGS_MAX,
      items: object({
        proposalId: text(16),
        origin: { type: "string", enum: ["model-proposal"] },
        status: { type: "string", enum: ["proposed"] },
        kind: {
          type: "string",
          enum: ["obligation", "acceptance-criterion", "conflict", "omission", "clarification"],
        },
        proposal: text(300),
        question: text(160),
        sources: { type: "array", maxItems: 2, items: REVIEW_SOURCE_SCHEMA },
      }),
    },
    coverage: object({
      documentScope: text(8),
      revisionDigest: text(64),
      textRevision: text(64),
      reviewFingerprint: text(64),
      characterStart: REVIEW_COUNT_SCHEMA,
      characterEnd: REVIEW_COUNT_SCHEMA,
      documentChars: REVIEW_COUNT_SCHEMA,
      reviewedWindows: REVIEW_COUNT_SCHEMA,
      totalWindows: REVIEW_COUNT_SCHEMA,
      documentReviewComplete: REVIEW_FLAG_SCHEMA,
      windowReviewComplete: REVIEW_FLAG_SCHEMA,
      windowSkipped: REVIEW_FLAG_SCHEMA,
      failedWindows: REVIEW_COUNT_SCHEMA,
      semanticExhaustivenessProven: { type: "boolean", enum: [false] },
      originalModified: { type: "boolean", enum: [false] },
      cached: REVIEW_FLAG_SCHEMA,
    }),
  },
};

const CACHE_WINDOWS_MAX = 128;
const caches = new WeakMap<UiHandlerDeps, Map<string, SemanticReview>>();
function cacheFor(deps: UiHandlerDeps): Map<string, SemanticReview> {
  const root = depsRoot(deps);
  let cache = caches.get(root);
  if (cache === undefined) {
    cache = new Map();
    caches.set(root, cache);
  }
  return cache;
}
function remember(cache: Map<string, SemanticReview>, key: string, review: SemanticReview): void {
  if (!review.complete) return;
  cache.set(key, review);
  while (cache.size > CACHE_WINDOWS_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

interface ReviewInput {
  readonly document: ReadKnowledgeDocument;
  readonly documentScope: string;
  readonly revisionDigest: string;
  readonly textRevision: string;
  readonly modelId: string;
  readonly generation: number;
  readonly fingerprint: string;
  readonly start: number;
  readonly anchors: readonly ReviewAnchor[];
}

function reviewStart(
  args: CatalogJsonObject,
  fingerprint: string,
  source: string,
): number | undefined {
  const cursor = typeof args.cursor === "string" ? decodeKnowledgeCursor(args.cursor) : undefined;
  if (args.cursor !== undefined && cursor?.fingerprint !== fingerprint) return undefined;
  const start = cursor?.offset ?? 0;
  return start < source.length && knowledgeWindowEnd(source, start) === start ? start : undefined;
}
function reviewIdentity(
  environment: KnowledgeToolEnvironment,
  document: ReadKnowledgeDocument,
  modelId: string,
  projected: string,
): Pick<ReviewInput, "generation" | "textRevision" | "fingerprint"> {
  const textRevision = knowledgeDigest(document.text);
  const generation = environment.deps.gatewayConfig?.generation() ?? 0;
  const fingerprint = knowledgeDigest(
    JSON.stringify([
      String(document.capsuleId),
      String(document.documentId),
      textRevision,
      modelId,
      generation,
      knowledgeDigest(projected),
    ]),
  );
  return { textRevision, generation, fingerprint };
}
function inputFor(
  environment: KnowledgeToolEnvironment,
  args: CatalogJsonObject,
): ReviewInput | undefined {
  const { deps, store, snapshot, context, redact } = environment;
  const selected = findKnowledgeDocument(snapshot, args.documentScope, args.revisionDigest);
  if (selected === undefined) return undefined;
  const document = readKnowledgeDocument(store, snapshot, selected);
  const modelId =
    context.knowledgeReviewModelId?.() ?? deps.store.findChatById(context.chatId)?.selectedModel;
  if (document === undefined || modelId === undefined) return undefined;
  const projected = redact(document.text);
  const identity = reviewIdentity(environment, document, modelId, projected);
  const start = reviewStart(args, identity.fingerprint, document.text);
  if (start === undefined) return undefined;
  const anchors = reviewAnchors(document, start, redact, projected);
  if (anchors.length === 0) return undefined;
  return {
    document,
    documentScope: knowledgeDocumentScope(selected),
    revisionDigest: knowledgeDocumentRevision(selected),
    modelId,
    ...identity,
    start,
    anchors,
  };
}

function modelRequest(
  environment: KnowledgeToolEnvironment,
  input: ReviewInput,
): GatewayCallRequest {
  const config = currentGatewayConfig(environment.deps);
  const capability =
    config === undefined ? undefined : findConfiguredCapability(config, input.modelId);
  const profile =
    capability?.kind === "chat"
      ? deriveContextProfileFromCapability(capability)
      : DEFAULT_CONTEXT_PROFILE;
  const format = semanticReviewFormat(input.anchors.length);
  const request: GatewayCallRequest = {
    modelId: input.modelId,
    messages: [
      { role: "system", content: semanticReviewInstruction(format) },
      { role: "user", content: reviewPrompt(input.document, input.anchors) },
    ],
    stream: false,
    maxOutputTokens: profile.reservedOutputTokens,
    temperature: 0,
    ...(capability?.supportsResponseFormat === true ? { responseFormat: format } : {}),
    logContext: { correlationId: environment.context.correlationId },
  };
  return fitToolRoundOutput(request, profile, [], {
    maxOutputTokens:
      capability?.kind === "chat" ? capability.maxOutputTokens : profile.reservedOutputTokens,
    reasoningHistoryField: config?.providers.find((provider) => provider.modelId === input.modelId)
      ?.reasoningHistoryField,
  });
}

type GeneratedReview =
  | {
      readonly ok: true;
      readonly review: SemanticReview;
      readonly response: NormalizedResponse;
      readonly observation: KnowledgeReviewObservation;
    }
  | {
      readonly ok: false;
      readonly failureStage: KnowledgeReviewFailureStage;
      readonly observation: KnowledgeReviewObservation;
      readonly diagnosticError?: unknown;
    };
function unavailableReview(
  stage: KnowledgeReviewFailureStage,
  anchorCount: number,
): GeneratedReview {
  return {
    ok: false,
    failureStage: stage,
    observation: { reviewFailureStage: stage, reviewAnchorCount: anchorCount },
  };
}

async function generateReview(
  environment: KnowledgeToolEnvironment,
  input: ReviewInput,
): Promise<GeneratedReview> {
  const { deps, context } = environment;
  const raw = deps.modelPortFactory(input.modelId);
  if (raw === undefined) return unavailableReview("model-port-unavailable", input.anchors.length);
  if (context.meterModel === undefined)
    return unavailableReview("budget-port-unavailable", input.anchors.length);
  const model = context.meterModel(withChatContentPolicy(deps, raw));
  // The managed tool and accepted turn own cancellation; the gateway owns model timing.
  const response = await raceAbort(
    model.call(modelRequest(environment, input), context.signal),
    context.signal,
  );
  const parsed = parseSemanticReviewDetailed(response, input.anchors.length);
  return parsed.ok
    ? { ok: true, review: parsed.review, response, observation: parsed.observation }
    : {
        ok: false,
        failureStage: "model-output-invalid",
        observation: parsed.observation,
        ...(parsed.syntaxError === undefined ? {} : { diagnosticError: parsed.syntaxError }),
      };
}

function reviewCoverage(
  input: ReviewInput,
  review: SemanticReview,
  cached: boolean,
): CatalogJsonObject {
  const windows = reviewWindowCount(input.document.text);
  return {
    documentScope: input.documentScope,
    revisionDigest: input.revisionDigest,
    textRevision: input.textRevision,
    reviewFingerprint: input.fingerprint,
    characterStart: input.start,
    characterEnd: input.anchors.at(-1)?.characterEnd ?? input.start,
    documentChars: input.document.text.length,
    reviewedWindows: review.complete ? 1 : 0,
    totalWindows: windows,
    documentReviewComplete: review.complete && input.start === 0 && windows === 1,
    windowReviewComplete: review.complete,
    semanticExhaustivenessProven: false,
    originalModified: false,
    cached,
  };
}

function reviewResult(
  input: ReviewInput,
  review: SemanticReview,
  cached: boolean,
  environment: KnowledgeToolEnvironment,
): KnowledgeToolRead {
  const end = input.anchors.at(-1)?.characterEnd ?? input.start;
  const next = end < input.document.text.length;
  return {
    cached,
    sourceChars: end - input.start,
    data: {
      outcome: "succeeded",
      view: "review",
      items: renderSemanticFindings(
        review,
        input.anchors,
        {
          documentScope: input.documentScope,
          revisionDigest: input.revisionDigest,
          textRevision: input.textRevision,
        },
        environment.redact,
      ),
      coverage: reviewCoverage(input, review, cached),
      nextStep: review.complete
        ? "Keep original requirements and acceptance criteria unchanged. Label model findings as proposals; resolve their specific questions. Review every document window before claiming corpus review coverage."
        : "This window review is incomplete. Read its source and resolve the remaining questions.",
      ...(next
        ? {
            nextCursor: encodeCursor({
              offset: end,
              fingerprint: input.fingerprint,
            }),
          }
        : {}),
    },
  };
}

function admittedReviewResult(
  environment: KnowledgeToolEnvironment,
  input: ReviewInput,
  review: SemanticReview,
  cached: boolean,
  generated: Extract<GeneratedReview, { ok: true }> | undefined,
): KnowledgeToolRead {
  const result = reviewResult(input, review, cached, environment);
  if (generated === undefined) return result;
  return {
    ...result,
    reviewObservation: generated.observation,
    confirmModelOperation: (): void =>
      environment.context.confirmModelOperation?.(generated.response),
  };
}

/** Source and authority have already been rechecked; a refused model output is not coverage. */
function failedWindowContinuation(input: ReviewInput): CatalogJsonObject {
  const end = input.anchors.at(-1)?.characterEnd ?? input.start;
  return {
    view: "review",
    coverage: {
      ...reviewCoverage(input, { complete: false, findings: [] }, false),
      windowSkipped: true,
      failedWindows: 1,
    },
    nextStep:
      "This source window was not reviewed successfully. Continue nextCursor with the same document selection if present; report this failed window and do not claim complete document review.",
    ...(end < input.document.text.length
      ? { nextCursor: encodeCursor({ offset: end, fingerprint: input.fingerprint }) }
      : {}),
  };
}

function failedReview(
  input: ReviewInput,
  generated: Extract<GeneratedReview, { ok: false }>,
): KnowledgeToolRead {
  const { failureStage } = generated;
  return {
    data: {
      outcome: "failed",
      reason: failureStage,
      failureStage,
      sourceAvailable: true,
      ...(failureStage === "model-output-invalid" ? failedWindowContinuation(input) : {}),
      ...(generated.observation.reviewValidationReason === undefined
        ? {}
        : { validationReason: generated.observation.reviewValidationReason }),
    },
    sourceChars: (input.anchors.at(-1)?.characterEnd ?? input.start) - input.start,
    reviewObservation: generated.observation,
    ...(generated.diagnosticError === undefined
      ? {}
      : { diagnosticError: generated.diagnosticError }),
  };
}

function reviewAuthorityCurrent(context: RequirementsToolContext): boolean {
  return !context.signal.aborted && context.beforeEffect();
}

function reviewContinuationFailure(
  environment: KnowledgeToolEnvironment,
  args: CatalogJsonObject,
  input: ReviewInput,
): KnowledgeToolRead | undefined {
  if (!reviewAuthorityCurrent(environment.context)) return knowledgeToolFailure("denied");
  const refreshed = inputFor(environment, args);
  if (refreshed?.fingerprint !== input.fingerprint) return knowledgeToolFailure("source-changed");
  return undefined;
}

async function review(
  environment: KnowledgeToolEnvironment,
  args: CatalogJsonObject,
): Promise<KnowledgeToolRead> {
  const input = inputFor(environment, args);
  if (input === undefined) return knowledgeToolFailure("document-or-cursor-stale");
  const cache = cacheFor(environment.deps);
  const key = `${input.fingerprint}|${String(input.start)}`;
  const hit = cache.get(key);
  if (!reviewAuthorityCurrent(environment.context)) return knowledgeToolFailure("denied");
  const generated = hit === undefined ? await generateReview(environment, input) : undefined;
  const continuationFailure = reviewContinuationFailure(environment, args, input);
  if (continuationFailure !== undefined) return continuationFailure;
  if (generated !== undefined && !generated.ok) return failedReview(input, generated);
  const result = hit ?? generated?.review;
  if (result === undefined) return knowledgeToolFailure("model-port-unavailable");
  remember(cache, key, result);
  return admittedReviewResult(environment, input, result, hit !== undefined, generated);
}

export function createKnowledgeReviewTool<Context extends RequirementsToolContext>(
  deps: UiHandlerDeps,
): ManagedMcpTool<Context> {
  const descriptor = createToolDescriptor({
    toolRef: createToolRef("keiko.knowledge.review", 2),
    description:
      "Semantically review one window of an attached document, after knowledge.documents inventory. Uses the selected model with the turn's existing budget. Pass documentScope, revisionDigest and returned nextCursor until all windows are reviewed. Reviews are cached per document revision/model/content policy. Returns source-anchored PROPOSALS for obligations, acceptance criteria, conflicts, omissions and targeted clarification questions; never changes original requirements. Review all documents for whole-Pod work; semantic review is not a proof of exhaustiveness.",
    inputSchema: object({ documentScope: text(8), revisionDigest: text(64), cursor: text(512) }, [
      "documentScope",
      "revisionDigest",
    ]),
    resultSchema: KNOWLEDGE_REVIEW_RESULT_SCHEMA,
    effects: ["connector-access"],
    actionMapping: [{ action: KNOWLEDGE_REVIEW_TOOL, effects: ["connector-access"] }],
    policyReferences: ["adr-0128.d4"],
    handlerRequirement: { id: KNOWLEDGE_REVIEW_TOOL, contractVersion: 1 },
    bounds: {
      maxArgumentBytes: 1024,
      maxResultBytes: KNOWLEDGE_TOOL_RESULT_BYTES_MAX,
      maxResultCount: REVIEW_FINDINGS_MAX,
      maxDurationMs: GATEWAY_BUFFERED_BUDGET_FLOOR_MS,
    },
    idempotency: "server-key-required",
    cancellation: "before-effect",
  });
  return {
    name: KNOWLEDGE_REVIEW_TOOL,
    risk: "read",
    descriptor,
    execute: (args, context) =>
      executeKnowledgeTool(deps, context, "review", (environment) => review(environment, args)),
  };
}
