// Quality Intelligence capability mapping (Epic #270, Issue #279; consolidated under Epic #761).
//
// The single source of truth for the READ side of the QI-capability ⇄ model-capability mapping:
// "does a model satisfy a required QI capability?". Both the capability gate
// (assertProfileCompatibleWithModel) and the deterministic profile router (selectModelForProfile)
// consume this one predicate, so they can never disagree on what a capability means. The WRITE-side
// counterpart that projects required capabilities onto a gateway ModelSelectionQuery is
// buildSelectionQueryForCapabilities (capabilityGate.ts), kept consistent with this READ side by the
// capabilityGate tests.

import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import type { QualityIntelligenceCapability } from "./taskProfiles.js";

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
      return model.toolCalling;
  }
}
