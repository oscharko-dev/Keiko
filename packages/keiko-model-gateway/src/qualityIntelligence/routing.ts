// Quality Intelligence routing (Epic #270, Issue #279).
//
// Pure deterministic model selection over an injected capability registry. NO live network
// probe lives here — the registry is supplied by the caller (typically the gateway's
// CAPABILITY_REGISTRY, augmented with runtime-configured records). The function walks the
// registry's declared ordering and returns the first capability-compatible match; if none
// match, it throws a `qi/capability-mismatch` safe-error exception.

import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { QualityIntelligenceSafeErrorException, makeCapabilityMismatchError } from "./safeError.js";
import type {
  QualityIntelligenceCapability,
  QualityIntelligenceTaskProfile,
} from "./taskProfiles.js";

export interface QualityIntelligenceModelRegistry {
  readonly capabilities: readonly ModelCapability[];
}

export interface QualityIntelligenceSelectedModel {
  readonly modelId: string;
  readonly capability: ModelCapability;
}

function modelSupports(capability: QualityIntelligenceCapability, model: ModelCapability): boolean {
  switch (capability) {
    case "text":
      return model.kind === "chat";
    case "vision":
      return model.supportsImageInput;
    case "structured-output":
      return model.structuredOutput;
    case "function-calling":
      return model.toolCalling;
  }
}

function satisfiesAll(
  required: readonly QualityIntelligenceCapability[],
  model: ModelCapability,
): boolean {
  for (const cap of required) {
    if (!modelSupports(cap, model)) {
      return false;
    }
  }
  return true;
}

export function selectModelForProfile(
  profile: QualityIntelligenceTaskProfile,
  registry: QualityIntelligenceModelRegistry,
): QualityIntelligenceSelectedModel {
  for (const candidate of registry.capabilities) {
    if (satisfiesAll(profile.requiredCapabilities, candidate)) {
      return Object.freeze({ modelId: candidate.id, capability: candidate });
    }
  }
  throw new QualityIntelligenceSafeErrorException(
    makeCapabilityMismatchError(profile.id, profile.requiredCapabilities),
  );
}
