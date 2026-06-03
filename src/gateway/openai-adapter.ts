// Re-export shim: openai-adapter now lives in @oscharko-dev/keiko-model-gateway (issue #160, ADR-0019).
// All existing import sites (`from "../gateway/openai-adapter.js"`) keep resolving unchanged via this barrel.

export { OpenAiAdapter } from "@oscharko-dev/keiko-model-gateway";
export type { AdapterDeps } from "@oscharko-dev/keiko-model-gateway";
