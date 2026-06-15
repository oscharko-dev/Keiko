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
  selectConfiguredModel,
  QualityIntelligenceSafeErrorException,
  type ModelSelectionQuery,
  type ModelCapability,
} from "@oscharko-dev/keiko-model-gateway";
import type { UiHandlerDeps } from "../deps.js";
import { QiGenerationError } from "./generationPort.js";

type QiProfileId = MgQI.QualityIntelligenceTaskProfileId;

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

  if (deps.config === undefined) {
    return { kind: "baseline" };
  }

  const structured = selectCapabilityByGatewayQuery(deps, {
    kind: "chat",
    structuredOutput: true,
  });
  if (structured !== undefined) {
    return { kind: "model", ...structured };
  }

  const anyChat = selectCapabilityByGatewayQuery(deps, { kind: "chat" });
  if (anyChat !== undefined) {
    return { kind: "model", ...anyChat };
  }

  return { kind: "baseline" };
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
 * Resolve the image-input (multimodal) model for a vision-augmented stage (Issue #810).
 *
 * Selection is capability-driven: the cheapest configured chat model that advertises
 * supportsImageInput is chosen by capability. When no configured model offers
 * image input, this returns a TYPED "unavailable" so the caller degrades gracefully to the
 * deterministic IR-only baseline — never a silent text-model substitution that would pretend
 * to have seen the image. No model id is hard-coded.
 */
export function resolveQiMultimodalSelection(deps: UiHandlerDeps): QiMultimodalSelection {
  const selected = selectCapabilityByGatewayQuery(deps, {
    kind: "chat",
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
