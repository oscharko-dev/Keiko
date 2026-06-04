// Re-export shim: model-selection now lives in @oscharko-dev/keiko-model-gateway (issue #160, ADR-0019).
// All existing import sites (`from "../gateway/model-selection.js"`) keep resolving unchanged via this barrel.

export {
  assertConfiguredModel,
  findConfiguredCapability,
  listConfiguredCapabilities,
  selectConfiguredModel,
} from "@oscharko-dev/keiko-model-gateway";
export type { ModelSelectionQuery } from "@oscharko-dev/keiko-model-gateway";
