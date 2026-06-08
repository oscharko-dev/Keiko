// Quality Intelligence capability-based model selector (Epic #761, Issue #762).
//
// Resolves the best configured model for a given QI task profile. Logic:
// 1. If a `requested` model id is given, configured, and satisfies the profile → return it.
// 2. Otherwise map the profile's requiredCapabilities to a ModelSelectionQuery and call
//    selectConfiguredModel to pick the lowest-cost matching model.
// 3. If no configured model satisfies the requirements → throw QI_CAPABILITY_UNAVAILABLE.
//
// Future profile capability extensions: "vision" → supportsImageInput query flag;
// "function-calling" → toolCalling query flag. Extend buildSelectionQuery only.

import {
  QualityIntelligence as MgQI,
  findConfiguredCapability,
  selectConfiguredModel,
  QualityIntelligenceSafeErrorException,
  type ModelSelectionQuery,
} from "@oscharko-dev/keiko-model-gateway";
import type { UiHandlerDeps } from "../deps.js";
import { QiGenerationError } from "./generationPort.js";

// The task-profile id type lives under the model-gateway QualityIntelligence namespace.
type QiProfileId = MgQI.QualityIntelligenceTaskProfileId;

function buildSelectionQuery(profileId: QiProfileId): ModelSelectionQuery {
  const profile = MgQI.getQualityIntelligenceTaskProfile(profileId);
  const base: ModelSelectionQuery = { kind: "chat" };
  const needsStructuredOutput = profile.requiredCapabilities.includes("structured-output");
  return needsStructuredOutput ? { ...base, structuredOutput: true } : base;
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

/**
 * Resolve the model id to use for a given QI task profile. Never returns undefined; throws
 * QI_CAPABILITY_UNAVAILABLE when no configured model satisfies the profile requirements.
 */
export function selectModelForQiCapability(
  deps: UiHandlerDeps,
  profileId: QiProfileId,
  requested?: string,
): string {
  const trimmed = requested?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    if (isRequestedModelCompatible(deps, trimmed, profileId)) return trimmed;
  }
  if (deps.config === undefined) {
    throw new QiGenerationError(
      "QI_CAPABILITY_UNAVAILABLE",
      `No configured model satisfies the ${profileId} capability requirements.`,
    );
  }
  const query = buildSelectionQuery(profileId);
  const selected = selectConfiguredModel(deps.config, query);
  if (selected === undefined) {
    throw new QiGenerationError(
      "QI_CAPABILITY_UNAVAILABLE",
      `No configured model satisfies the ${profileId} capability requirements.`,
    );
  }
  return selected;
}
