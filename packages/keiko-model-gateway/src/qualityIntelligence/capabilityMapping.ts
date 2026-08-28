// Quality Intelligence capability mapping (Epic #270, Issue #279; consolidated under Epic #761).
//
// The single source of truth for the READ side of the QI-capability ⇄ model-capability mapping:
// "does a model satisfy a required QI capability?". Both the capability gate
// (assertProfileCompatibleWithModel) and the deterministic profile router (selectModelForProfile)
// consume this one predicate, so they can never disagree on what a capability means. The WRITE-side
// counterpart that projects required capabilities onto a gateway ModelSelectionQuery is
// buildSelectionQueryForCapabilities (capabilityGate.ts), kept consistent with this READ side by the
// capabilityGate tests.

import type { ModelCapability, ToolCallingVerification } from "@oscharko-dev/keiko-contracts";
import type { QualityIntelligenceCapability } from "./taskProfiles.js";

const TOOL_CALLING_VERIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isFreshToolCallingVerification(
  verification: ToolCallingVerification | undefined,
  now = Date.now(),
): boolean {
  if (verification?.status !== "verified") return false;
  const checkedAt = Date.parse(verification.checkedAt);
  const ageMs = now - checkedAt;
  return Number.isFinite(checkedAt) && ageMs >= 0 && ageMs <= TOOL_CALLING_VERIFICATION_MAX_AGE_MS;
}

export function modelSupportsCapability(
  capability: QualityIntelligenceCapability,
  model: ModelCapability,
): boolean {
  switch (capability) {
    case "text":
      return model.kind === "chat";
    case "vision":
      return model.supportsImageInput;
    case "structured-output":
      return model.structuredOutput;
    case "function-calling":
      return model.toolCalling && isFreshToolCallingVerification(model.toolCallingVerification);
  }
}
