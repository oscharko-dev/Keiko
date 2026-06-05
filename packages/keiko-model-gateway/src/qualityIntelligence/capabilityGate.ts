// Quality Intelligence capability gate (Epic #270, Issue #279).
//
// Asserts that a model's capability record satisfies the structural requirements of a QI
// task profile. Throws a safe-error exception (no inputs, no secrets) on mismatch.

import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { QualityIntelligenceSafeErrorException, makeCapabilityMismatchError } from "./safeError.js";
import type {
  QualityIntelligenceCapability,
  QualityIntelligenceTaskProfile,
} from "./taskProfiles.js";

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

export function assertProfileCompatibleWithModel(
  profile: QualityIntelligenceTaskProfile,
  modelCapability: ModelCapability,
): void {
  const missing: QualityIntelligenceCapability[] = [];
  for (const required of profile.requiredCapabilities) {
    if (!modelSupports(required, modelCapability)) {
      missing.push(required);
    }
  }
  if (missing.length === 0) {
    return;
  }
  throw new QualityIntelligenceSafeErrorException(makeCapabilityMismatchError(profile.id, missing));
}
