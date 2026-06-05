// Quality Intelligence dispatcher (Epic #270, Issue #279).
//
// Routes a Quality Intelligence model call through the existing gateway ModelPort. The
// dispatcher COMPOSES — it never instantiates a provider SDK. It performs (in order):
//   1. capability check                       (M1: capabilityGate)
//   2. budget reservation                     (M2: budget)
//   3. prompt segmentation                    (M1: promptSegmentation)
//   4. cache lookup                           (M2: replayCache)
//   5. wire-prompt assembly                   (this file, pure)
//   6. ModelPort.call(...) with composed signal and profile timeout (this file)
//   7. cache store (if cacheable)             (M2: replayCache)
//   8. error -> qi/* safe-error shape         (M1: safeError)
// The ModelPort itself is the gateway's existing ProviderAdapter — proven at the type
// level by the parameter signature.

import type {
  ChatMessage,
  GatewayRequest,
  ModelCapability,
  NormalizedResponse,
} from "@oscharko-dev/keiko-contracts";
import { composeCancellationSignal } from "./cancellation.js";
import { isExhausted, reserveBudget } from "./budget.js";
import type { QualityIntelligenceBudgetState } from "./budget.js";
import { assertProfileCompatibleWithModel } from "./capabilityGate.js";
import {
  buildPromptSegments,
  type QualityIntelligencePromptSegments,
  type QualityIntelligenceUntrustedEvidenceInput,
} from "./promptSegmentation.js";
import {
  deriveReplayCacheKey,
  isCacheable,
  type QualityIntelligenceReplayCachePort,
} from "./replayCache.js";
import {
  QualityIntelligenceSafeErrorException,
  makeBudgetExhaustedError,
  makeCancelledError,
  makeProviderError,
  makeTimeoutError,
} from "./safeError.js";
import type { QualityIntelligenceTaskProfile } from "./taskProfiles.js";
import type { ModelProviderConfig, ProviderAdapter } from "../types.js";

export interface QualityIntelligenceDispatcherArgs {
  readonly profile: QualityIntelligenceTaskProfile;
  readonly instruction: string;
  readonly evidence: readonly QualityIntelligenceUntrustedEvidenceInput[];
  readonly model: ModelCapability;
  readonly providerConfig: ModelProviderConfig;
  readonly port: ProviderAdapter;
  readonly cache: QualityIntelligenceReplayCachePort<NormalizedResponse>;
  readonly budget: QualityIntelligenceBudgetState;
  readonly signal?: AbortSignal | undefined;
}

export interface QualityIntelligenceDispatcherResult {
  readonly response: NormalizedResponse;
  readonly budget: QualityIntelligenceBudgetState;
  readonly cacheHit: boolean;
}

function assembleMessages(segments: QualityIntelligencePromptSegments): readonly ChatMessage[] {
  const evidenceBlock =
    segments.evidenceUntrusted.length === 0
      ? ""
      : segments.evidenceUntrusted
          .map((e) => `<qi-evidence kind="${e.kind}">${e.value}</qi-evidence>`)
          .join("\n");
  const userContent =
    evidenceBlock === ""
      ? segments.instructionTrusted
      : `${segments.instructionTrusted}\n${evidenceBlock}`;
  return Object.freeze([
    Object.freeze<ChatMessage>({ role: "system", content: segments.systemTrusted }),
    Object.freeze<ChatMessage>({ role: "user", content: userContent }),
  ]);
}

function buildGatewayRequest(
  modelId: string,
  segments: QualityIntelligencePromptSegments,
  signal: AbortSignal,
): GatewayRequest {
  return Object.freeze({
    modelId,
    messages: assembleMessages(segments),
    stream: false,
    cancellationSignal: signal,
  });
}

function classifyAndThrow(
  profileId: string,
  timeoutMs: number,
  reasonKind: "timeout" | "external" | "none",
  caught: unknown,
): never {
  if (caught instanceof QualityIntelligenceSafeErrorException) {
    throw caught;
  }
  if (reasonKind === "timeout") {
    throw new QualityIntelligenceSafeErrorException(makeTimeoutError(profileId, timeoutMs));
  }
  if (reasonKind === "external") {
    throw new QualityIntelligenceSafeErrorException(makeCancelledError(profileId));
  }
  throw new QualityIntelligenceSafeErrorException(makeProviderError(profileId));
}

interface InvocationContext {
  readonly profile: QualityIntelligenceTaskProfile;
  readonly port: ProviderAdapter;
  readonly providerConfig: ModelProviderConfig;
  readonly modelId: string;
  readonly segments: QualityIntelligencePromptSegments;
  readonly externalSignal: AbortSignal | undefined;
}

async function invokePort(ctx: InvocationContext): Promise<NormalizedResponse> {
  const handle = composeCancellationSignal(ctx.profile.timeoutMsHint, ctx.externalSignal);
  try {
    const request = buildGatewayRequest(ctx.modelId, ctx.segments, handle.signal);
    return await ctx.port.call(request, ctx.providerConfig);
  } catch (caught: unknown) {
    classifyAndThrow(ctx.profile.id, ctx.profile.timeoutMsHint, handle.reasonKind(), caught);
  } finally {
    handle.dispose();
  }
}

export async function dispatchQualityIntelligenceRequest(
  args: QualityIntelligenceDispatcherArgs,
): Promise<QualityIntelligenceDispatcherResult> {
  assertProfileCompatibleWithModel(args.profile, args.model);

  if (isExhausted(args.budget)) {
    throw new QualityIntelligenceSafeErrorException(makeBudgetExhaustedError(args.profile.id));
  }
  const nextBudget = reserveBudget(args.budget, args.profile.tokenBudgetHint);

  const segments = buildPromptSegments(args.profile, args.instruction, args.evidence);
  const cacheKey = await deriveReplayCacheKey(args.profile, segments, args.model.id);

  if (isCacheable(args.profile)) {
    const cached = args.cache.get(cacheKey);
    if (cached !== undefined) {
      return Object.freeze({
        response: cached,
        budget: nextBudget,
        cacheHit: true,
      });
    }
  }

  const response = await invokePort({
    profile: args.profile,
    port: args.port,
    providerConfig: args.providerConfig,
    modelId: args.model.id,
    segments,
    externalSignal: args.signal,
  });

  if (isCacheable(args.profile)) {
    args.cache.set(cacheKey, response);
  }
  return Object.freeze({
    response,
    budget: nextBudget,
    cacheHit: false,
  });
}
