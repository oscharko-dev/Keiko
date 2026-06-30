// Quality Intelligence capability-based model selector (Epic #761, Issue #762/#763).
//
// Two selection modes exist:
//   1. A strict profile selector used for flows that must satisfy the task profile exactly.
//   2. A test-design resolver that prefers structured-output chat models but degrades gracefully
//      to chat-only models, and finally to a deterministic no-model baseline.
//
// The test-design resolver is intentionally separate from the strict selector so the #761 graceful
// degradation semantics do not get lost in generic "required capabilities only" routing.

import {
  QualityIntelligence as MgQI,
  findConfiguredCapability,
  listConfiguredCapabilities,
  selectConfiguredModel,
  QualityIntelligenceSafeErrorException,
  type ModelSelectionQuery,
  type ModelCapability,
} from "@oscharko-dev/keiko-model-gateway";
import type {
  QualityIntelligenceModelPolicy,
  QualityIntelligenceModelPolicyValidation,
  QualityIntelligenceResolvedModelPolicy,
  QualityIntelligenceStartRunRequest,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import { QiGenerationError } from "./generationPort.js";

type QiProfileId = MgQI.QualityIntelligenceTaskProfileId;
const QI_MODEL_POLICY_VERSION = 1 as const;

const COST_RANK = { low: 0, medium: 1, high: 2 } as const;
const LATENCY_RANK = { fast: 0, standard: 1, slow: 2 } as const;

function buildSelectionQuery(profileId: QiProfileId): ModelSelectionQuery {
  const profile = MgQI.getQualityIntelligenceTaskProfile(profileId);
  // Single source of truth: the gateway derives the selection query from the profile's required
  // capabilities using the SAME mapping the capability gate enforces, so the auto-selector and the
  // gate cannot diverge on any capability (text/structured-output/function-calling/vision) (#762).
  return MgQI.buildSelectionQueryForCapabilities(profile.requiredCapabilities);
}

function isRequestedModelCompatible(
  deps: UiHandlerDeps,
  modelId: string,
  profileId: QiProfileId,
): boolean {
  if (deps.config === undefined) return false;
  const capability = findConfiguredCapability(deps.config, modelId);
  if (capability === undefined) return false;
  const profile = MgQI.getQualityIntelligenceTaskProfile(profileId);
  try {
    MgQI.assertProfileCompatibleWithModel(profile, capability);
    return true;
  } catch (error) {
    if (error instanceof QualityIntelligenceSafeErrorException) return false;
    throw error;
  }
}

function configuredChatCapability(
  deps: UiHandlerDeps,
  modelId: string,
): ModelCapability | undefined {
  if (deps.config === undefined) return undefined;
  const capability = findConfiguredCapability(deps.config, modelId);
  return capability?.kind === "chat" ? capability : undefined;
}

function configuredCapability(deps: UiHandlerDeps, modelId: string): ModelCapability | undefined {
  if (deps.config === undefined) return undefined;
  return findConfiguredCapability(deps.config, modelId);
}

function configuredCapabilities(deps: UiHandlerDeps): readonly ModelCapability[] {
  return deps.config === undefined ? [] : listConfiguredCapabilities(deps.config);
}

function selectCapabilityByGatewayQuery(
  deps: UiHandlerDeps,
  query: ModelSelectionQuery,
): { readonly modelId: string; readonly capability: ModelCapability } | undefined {
  if (deps.config === undefined) return undefined;
  const modelId = selectConfiguredModel(deps.config, query);
  if (modelId === undefined) return undefined;
  const capability = findConfiguredCapability(deps.config, modelId);
  if (capability === undefined) return undefined;
  return { modelId, capability };
}

export type QiTestDesignSelection =
  | { readonly kind: "baseline" }
  | {
      readonly kind: "model";
      readonly modelId: string;
      readonly capability: ModelCapability;
    };

interface IndexedCapability {
  readonly capability: ModelCapability;
  readonly index: number;
}

function chatCapabilities(deps: UiHandlerDeps): readonly IndexedCapability[] {
  return configuredCapabilities(deps)
    .map((capability, index) => ({ capability, index }))
    .filter((entry) => entry.capability.kind === "chat");
}

function compareBooleanDesc(a: boolean | undefined, b: boolean | undefined): number {
  return Number(b === true) - Number(a === true);
}

function compareNumberDesc(a: number | undefined, b: number | undefined): number {
  return (b ?? 0) - (a ?? 0);
}

function compareGenerationDefault(a: IndexedCapability, b: IndexedCapability): number {
  return (
    compareBooleanDesc(a.capability.structuredOutput, b.capability.structuredOutput) ||
    compareBooleanDesc(a.capability.supportsResponseFormat, b.capability.supportsResponseFormat) ||
    compareNumberDesc(a.capability.contextWindow, b.capability.contextWindow) ||
    compareNumberDesc(a.capability.maxOutputTokens, b.capability.maxOutputTokens) ||
    LATENCY_RANK[a.capability.latencyClass] - LATENCY_RANK[b.capability.latencyClass] ||
    COST_RANK[a.capability.costClass] - COST_RANK[b.capability.costClass] ||
    a.index - b.index
  );
}

function compareJudgeDefault(a: IndexedCapability, b: IndexedCapability): number {
  return (
    compareBooleanDesc(a.capability.supportsResponseFormat, b.capability.supportsResponseFormat) ||
    compareNumberDesc(a.capability.contextWindow, b.capability.contextWindow) ||
    compareNumberDesc(a.capability.maxOutputTokens, b.capability.maxOutputTokens) ||
    LATENCY_RANK[a.capability.latencyClass] - LATENCY_RANK[b.capability.latencyClass] ||
    COST_RANK[a.capability.costClass] - COST_RANK[b.capability.costClass] ||
    a.index - b.index
  );
}

function defaultGenerationCapability(deps: UiHandlerDeps): ModelCapability | undefined {
  return chatCapabilities(deps).slice().sort(compareGenerationDefault)[0]?.capability;
}

function defaultJudgeCapability(deps: UiHandlerDeps): ModelCapability | undefined {
  return chatCapabilities(deps)
    .filter((entry) => entry.capability.structuredOutput)
    .slice()
    .sort(compareJudgeDefault)[0]?.capability;
}

/**
 * Resolve the test-design generation strategy.
 *
 * Order:
 * 1. Explicit configured chat model id, even when it lacks structured output.
 * 2. Cheapest configured chat model that advertises structured output.
 * 3. Cheapest configured chat model of any kind.
 * 4. Deterministic no-model baseline.
 */
export function resolveQiTestDesignSelection(
  deps: UiHandlerDeps,
  requested?: string,
): QiTestDesignSelection {
  const trimmed = requested?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    const requestedCapability = configuredChatCapability(deps, trimmed);
    if (requestedCapability !== undefined) {
      return { kind: "model", modelId: trimmed, capability: requestedCapability };
    }
  }

  const recommended = defaultGenerationCapability(deps);
  if (recommended !== undefined) {
    return { kind: "model", modelId: recommended.id, capability: recommended };
  }

  return { kind: "baseline" };
}

function cleanModelId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function normaliseQiModelPolicy(
  raw: QualityIntelligenceModelPolicy | undefined,
): QualityIntelligenceModelPolicy {
  const testDesignModelId = cleanModelId(raw?.testDesignModelId);
  const judgeModelId = cleanModelId(raw?.judgeModelId);
  return {
    policyVersion: QI_MODEL_POLICY_VERSION,
    ...(testDesignModelId !== undefined ? { testDesignModelId } : {}),
    ...(judgeModelId !== undefined ? { judgeModelId } : {}),
    ...(raw?.updatedAt !== undefined ? { updatedAt: raw.updatedAt } : {}),
  };
}

export function recommendQiModelPolicy(deps: UiHandlerDeps): QualityIntelligenceModelPolicy {
  const generation = defaultGenerationCapability(deps);
  const judge = defaultJudgeCapability(deps);
  return {
    policyVersion: QI_MODEL_POLICY_VERSION,
    ...(generation !== undefined ? { testDesignModelId: generation.id } : {}),
    ...(judge !== undefined ? { judgeModelId: judge.id } : {}),
  };
}

export function validateQiModelPolicy(
  deps: UiHandlerDeps,
  policy: QualityIntelligenceModelPolicy,
): QualityIntelligenceModelPolicyValidation {
  const issues: QualityIntelligenceModelPolicyValidation["issues"][number][] = [];
  const testDesignModelId = cleanModelId(policy.testDesignModelId);
  if (testDesignModelId !== undefined) {
    const capability = configuredCapability(deps, testDesignModelId);
    if (capability === undefined) {
      issues.push({
        field: "testDesignModelId",
        code: "model-not-configured",
        message: "The selected generation model is not configured.",
      });
    } else if (capability.kind !== "chat") {
      issues.push({
        field: "testDesignModelId",
        code: "model-not-chat",
        message: "The selected generation model is not a chat model.",
      });
    }
  }
  const judgeModelId = cleanModelId(policy.judgeModelId);
  if (judgeModelId !== undefined) {
    const capability = configuredCapability(deps, judgeModelId);
    if (capability === undefined) {
      issues.push({
        field: "judgeModelId",
        code: "model-not-configured",
        message: "The selected judge model is not configured.",
      });
    } else if (capability.kind !== "chat") {
      issues.push({
        field: "judgeModelId",
        code: "model-not-chat",
        message: "The selected judge model is not a chat model.",
      });
    } else if (!capability.structuredOutput) {
      issues.push({
        field: "judgeModelId",
        code: "model-not-structured",
        message: "The selected judge model does not advertise structured output.",
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

export function repairQiModelPolicy(
  deps: UiHandlerDeps,
  policy: QualityIntelligenceModelPolicy,
): { readonly policy: QualityIntelligenceModelPolicy; readonly repaired: boolean } {
  const normalized = normaliseQiModelPolicy(policy);
  const validation = validateQiModelPolicy(deps, normalized);
  if (validation.ok) return { policy: normalized, repaired: false };
  return { policy: recommendQiModelPolicy(deps), repaired: true };
}

interface QiModelPolicyResolution {
  readonly requested: QualityIntelligenceModelPolicy;
  readonly recommended: QualityIntelligenceModelPolicy;
  readonly resolved: QualityIntelligenceResolvedModelPolicy;
  readonly validation: QualityIntelligenceModelPolicyValidation;
}

function requestedPolicyFromRequest(
  request: Pick<QualityIntelligenceStartRunRequest, "modelId" | "modelPolicy">,
): QualityIntelligenceModelPolicy {
  const legacyModelId = cleanModelId(request.modelId);
  if (request.modelPolicy !== undefined) return normaliseQiModelPolicy(request.modelPolicy);
  return normaliseQiModelPolicy({
    policyVersion: QI_MODEL_POLICY_VERSION,
    ...(legacyModelId !== undefined ? { testDesignModelId: legacyModelId } : {}),
  });
}

function resolvedFromRecommended(
  recommended: QualityIntelligenceModelPolicy,
): QualityIntelligenceResolvedModelPolicy {
  return {
    ...(recommended.testDesignModelId !== undefined
      ? { testDesignModelId: recommended.testDesignModelId }
      : {}),
    ...(recommended.judgeModelId !== undefined
      ? { judgeModelId: recommended.judgeModelId }
      : { judgeUnavailableReason: "no-compatible-model" as const }),
  };
}

function legacyJudgeModelId(
  deps: UiHandlerDeps,
  request: Pick<QualityIntelligenceStartRunRequest, "modelId" | "modelPolicy">,
): string | undefined {
  const legacyModelId = cleanModelId(request.modelId);
  return request.modelPolicy === undefined &&
    legacyModelId !== undefined &&
    validateQiModelPolicy(deps, {
      policyVersion: QI_MODEL_POLICY_VERSION,
      judgeModelId: legacyModelId,
    }).ok
    ? legacyModelId
    : undefined;
}

function resolvedFromPolicy(args: {
  readonly requested: QualityIntelligenceModelPolicy;
  readonly recommended: QualityIntelligenceModelPolicy;
  readonly legacyJudge: string | undefined;
}): QualityIntelligenceResolvedModelPolicy {
  const { requested, recommended, legacyJudge } = args;
  const testDesignModelId = requested.testDesignModelId ?? recommended.testDesignModelId;
  const judgeModelId = requested.judgeModelId ?? legacyJudge ?? recommended.judgeModelId;
  return {
    ...(testDesignModelId !== undefined ? { testDesignModelId } : {}),
    ...(judgeModelId !== undefined
      ? { judgeModelId }
      : { judgeUnavailableReason: "no-compatible-model" as const }),
  };
}

export function resolveQiModelPolicy(
  deps: UiHandlerDeps,
  request: Pick<QualityIntelligenceStartRunRequest, "modelId" | "modelPolicy">,
): QiModelPolicyResolution {
  const recommended = recommendQiModelPolicy(deps);
  const requested = requestedPolicyFromRequest(request);
  const validation = validateQiModelPolicy(deps, requested);
  const resolved = validation.ok
    ? resolvedFromPolicy({
        requested,
        recommended,
        legacyJudge: legacyJudgeModelId(deps, request),
      })
    : resolvedFromRecommended(recommended);
  return {
    requested,
    recommended,
    resolved,
    validation,
  };
}

export type QiMultimodalSelection =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "model";
      readonly modelId: string;
      readonly capability: ModelCapability;
    };

export type QiStrictCapabilitySelection =
  | {
      readonly kind: "model";
      readonly modelId: string;
    }
  | {
      readonly kind: "unavailable";
      readonly code: "QI_CAPABILITY_UNAVAILABLE";
      readonly message: string;
    };

/**
 * Resolve the image-input model for a vision-augmented stage (Issue #810).
 *
 * Selection is capability-driven: prefer the cheapest configured chat model that advertises
 * supportsImageInput, then fall back to the cheapest configured pure `ocr-vision` model with the
 * same image-input capability. When no configured model offers image input, this returns a TYPED
 * "unavailable" so callers degrade honestly — never a silent text-model substitution that would
 * pretend to have seen the image. No model id is hard-coded and model ids are never parsed by name.
 */
export function resolveQiMultimodalSelection(deps: UiHandlerDeps): QiMultimodalSelection {
  const selectedChat = selectCapabilityByGatewayQuery(deps, {
    kind: "chat",
    supportsImageInput: true,
  });
  const selected =
    selectedChat ??
    selectCapabilityByGatewayQuery(deps, {
      kind: "ocr-vision",
      supportsImageInput: true,
    });
  if (selected === undefined) {
    return { kind: "unavailable" };
  }
  return { kind: "model", ...selected };
}

function unavailableCapabilitySelection(profileId: QiProfileId): QiStrictCapabilitySelection {
  return {
    kind: "unavailable",
    code: "QI_CAPABILITY_UNAVAILABLE",
    message: `No configured model satisfies the ${profileId} capability requirements.`,
  };
}

/**
 * Resolve a strict profile-compatible model without throwing for a missing capability. Callers that
 * treat the profile as optional can degrade on the typed unavailable result; callers that require
 * the capability should use selectModelForQiCapability below.
 */
export function resolveModelForQiCapability(
  deps: UiHandlerDeps,
  profileId: QiProfileId,
  requested?: string,
): QiStrictCapabilitySelection {
  const trimmed = requested?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    if (isRequestedModelCompatible(deps, trimmed, profileId)) {
      return { kind: "model", modelId: trimmed };
    }
  }
  if (deps.config === undefined) {
    return unavailableCapabilitySelection(profileId);
  }
  const query = buildSelectionQuery(profileId);
  const selected = selectConfiguredModel(deps.config, query);
  if (selected === undefined) {
    return unavailableCapabilitySelection(profileId);
  }
  return { kind: "model", modelId: selected };
}

/**
 * Resolve the model id to use for a given QI task profile. Never returns undefined; throws
 * QI_CAPABILITY_UNAVAILABLE when no configured model satisfies the profile requirements.
 */
export function selectModelForQiCapability(
  deps: UiHandlerDeps,
  profileId: QiProfileId,
  requested?: string,
): string {
  const selection = resolveModelForQiCapability(deps, profileId, requested);
  if (selection.kind === "model") return selection.modelId;
  throw new QiGenerationError(selection.code, selection.message);
}
