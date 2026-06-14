// Quality Intelligence capability gate (Epic #270, Issue #279).
//
// Asserts that a model's capability record satisfies the structural requirements of a QI
// task profile. Throws a safe-error exception (no inputs, no secrets) on mismatch.

import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { QualityIntelligenceSafeErrorException, makeCapabilityMismatchError } from "./safeError.js";
import type { ModelSelectionQuery } from "../model-selection.js";
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

/**
 * Project a profile's required QI capabilities onto the gateway `ModelSelectionQuery` constraints
 * the selector understands. This is the WRITE side of the SAME capability mapping that `modelSupports`
 * READS, kept in one file so auto-selection and the gate can never drift (Issue #762: a single shared
 * capability mapping, never a per-stage duplicate). text → chat kind (every QI task profile is a chat
 * task); structured-output → structuredOutput; function-calling → toolCalling; vision → supportsImageInput.
 */
export function buildSelectionQueryForCapabilities(
  required: readonly QualityIntelligenceCapability[],
): ModelSelectionQuery {
  let structuredOutput: true | undefined;
  let toolCalling: true | undefined;
  let supportsImageInput: true | undefined;
  for (const capability of required) {
    switch (capability) {
      case "text":
        break;
      case "structured-output":
        structuredOutput = true;
        break;
      case "function-calling":
        toolCalling = true;
        break;
      case "vision":
        supportsImageInput = true;
        break;
    }
  }
  return {
    kind: "chat",
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(toolCalling !== undefined ? { toolCalling } : {}),
    ...(supportsImageInput !== undefined ? { supportsImageInput } : {}),
  };
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
