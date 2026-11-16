import {
  DEFAULT_CONTEXT_PROFILE,
  deriveContextProfileFromCapability,
  type ContextProfile,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import {
  ERROR_CODES,
  findConfiguredCapability,
  GatewayError,
  type GatewayCallRequest,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { raceAbort } from "../abort-race.js";
import { fitToolRoundOutput } from "../chat-tool-continuation-fit.js";
import { withChatContentPolicy } from "../content-redactor.js";
import { currentGatewayConfig, type UiHandlerDeps } from "../deps.js";
import type { DraftBatchGeneration } from "./jiraDraftBatch.js";
import type { DraftBatchMessage } from "./jiraDraftBatchPrompt.js";
import type { JiraChatCatalogContext } from "./jiraChatCatalogConsumer.js";

// The model side of a draft batch: every page is one non-streaming call of the accepted turn's
// model, metered and admitted by the Chat tool turn, with its output budget fitted to the window.

type BatchModelContext = Pick<
  JiraChatCatalogContext,
  "chatId" | "knowledgeReviewModelId" | "meterModel" | "confirmModelOperation"
> & { readonly correlationId: string; readonly signal: AbortSignal };

export type BatchModelRefusal = "model-unavailable" | "budget-unavailable";

export interface BatchModel {
  readonly generate: (
    messages: readonly DraftBatchMessage[],
    purpose: "outline" | "fill",
  ) => Promise<DraftBatchGeneration>;
  /** The most output one call can carry, before any prompt is counted. */
  readonly maxOutputTokens: number;
  /** The prompt budget of the model when the gateway states its window; absent when unknown. */
  readonly maxInputTokens?: number | undefined;
}

const OUTLINE_SCHEMA = {
  type: "object",
  properties: { groups: { type: "array" } },
  required: ["groups"],
} as const;
const FILL_SCHEMA = {
  type: "object",
  properties: { items: { type: "array" } },
  required: ["items"],
} as const;

interface ModelSetup {
  readonly modelId: string;
  readonly profile: ContextProfile;
  readonly outputCeiling: number;
  readonly structured: boolean;
  /** The capability states the window, so the input budget is a fact and not a default. */
  readonly windowKnown: boolean;
  readonly reasoningHistoryField: "reasoning_content" | "reasoning" | undefined;
}

function modelSetup(deps: UiHandlerDeps, modelId: string): ModelSetup {
  const config = currentGatewayConfig(deps);
  const capability = config === undefined ? undefined : findConfiguredCapability(config, modelId);
  const profile =
    capability?.kind === "chat"
      ? deriveContextProfileFromCapability(capability)
      : DEFAULT_CONTEXT_PROFILE;
  return {
    modelId,
    profile,
    outputCeiling: capability?.kind === "chat" ? capability.maxOutputTokens : 0,
    structured: capability?.supportsResponseFormat === true,
    windowKnown: capability?.kind === "chat",
    reasoningHistoryField: config?.providers.find((provider) => provider.modelId === modelId)
      ?.reasoningHistoryField,
  };
}

function requestFor(
  setup: ModelSetup,
  correlationId: string,
  messages: readonly DraftBatchMessage[],
  purpose: "outline" | "fill",
): GatewayCallRequest {
  const request: GatewayCallRequest = {
    modelId: setup.modelId,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    stream: false,
    maxOutputTokens: setup.profile.reservedOutputTokens,
    temperature: 0,
    // Mechanical JSON writing from given text: the page needs no reasoning (measured: 3,349 of
    // 5,895 completion tokens were reasoning). Orchestration rounds keep the model's default.
    reasoningPreference: "off",
    ...(setup.structured
      ? {
          responseFormat: {
            type: "json_schema",
            name: purpose === "outline" ? "draft_outline" : "draft_page",
            schema: purpose === "outline" ? OUTLINE_SCHEMA : FILL_SCHEMA,
          },
        }
      : {}),
    logContext: { correlationId },
  };
  return fitToolRoundOutput(request, setup.profile, [], {
    maxOutputTokens:
      setup.outputCeiling > 0 ? setup.outputCeiling : setup.profile.reservedOutputTokens,
    reasoningHistoryField: setup.reasoningHistoryField,
  });
}

/**
 * A page that ran out of output or whose prompt overflowed the window is the same signal for the
 * batch: the page is too big, and halving it is the answer.
 */
function isTooBig(error: unknown): boolean {
  return (
    error instanceof GatewayError &&
    (error.code === ERROR_CODES.OUTPUT_EXHAUSTED || error.code === ERROR_CODES.CONTEXT_OVERFLOW)
  );
}

async function call(
  model: ModelPort,
  context: BatchModelContext,
  request: GatewayCallRequest,
): Promise<DraftBatchGeneration> {
  try {
    const response = await raceAbort(model.call(request, context.signal), context.signal);
    if (response.finishReason === "length") return { kind: "exhausted" };
    // The page is used: it leaves the synthesis grant, so tens of pages cannot exhaust it.
    context.confirmModelOperation?.(response);
    const tokens = response.usage.completionTokens;
    return {
      kind: "text",
      text: response.content,
      ...(Number.isFinite(tokens) && tokens > 0 ? { completionTokens: tokens } : {}),
    };
  } catch (error) {
    if (isTooBig(error)) return { kind: "exhausted" };
    throw error;
  }
}

/** The model of the accepted turn, or the closed reason a batch cannot use one. */
export function createBatchModel(
  deps: UiHandlerDeps,
  context: BatchModelContext,
): BatchModel | BatchModelRefusal {
  const modelId =
    context.knowledgeReviewModelId?.() ?? deps.store.findChatById(context.chatId)?.selectedModel;
  const raw = modelId === undefined ? undefined : deps.modelPortFactory(modelId);
  if (modelId === undefined || raw === undefined) return "model-unavailable";
  if (context.meterModel === undefined) return "budget-unavailable";
  const model = context.meterModel(withChatContentPolicy(deps, raw));
  const setup = modelSetup(deps, modelId);
  return {
    maxOutputTokens: requestFor(setup, context.correlationId, [], "fill").maxOutputTokens ?? 0,
    ...(setup.windowKnown ? { maxInputTokens: setup.profile.effectiveInputBudget } : {}),
    generate: (messages, purpose) =>
      call(model, context, requestFor(setup, context.correlationId, messages, purpose)),
  };
}
