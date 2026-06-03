// Re-export shim: capabilities now lives in @oscharko-dev/keiko-model-gateway (issue #160, ADR-0019).
// All existing import sites (`from "../gateway/capabilities.js"`) keep resolving unchanged via this barrel.

export {
  CAPABILITY_REGISTRY,
  createDefaultChatCapability,
  findCapability,
  listCapabilities,
  selectCheapest,
} from "@oscharko-dev/keiko-model-gateway";
export type { CapabilityQuery } from "@oscharko-dev/keiko-model-gateway";
