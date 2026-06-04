// Re-export shim: normalize now lives in @oscharko-dev/keiko-model-gateway (issue #160, ADR-0019).
// All existing import sites (`from "../gateway/normalize.js"`) keep resolving unchanged via this barrel.

export { normalizeChatResponse } from "@oscharko-dev/keiko-model-gateway/internal/normalize";
export type { UsageSeed } from "@oscharko-dev/keiko-model-gateway/internal/normalize";
