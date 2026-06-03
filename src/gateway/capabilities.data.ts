// Re-export shim: capabilities.data now lives in @oscharko-dev/keiko-model-gateway (issue #160, ADR-0019).
// All existing import sites (`from "../gateway/capabilities.data.js"`) keep resolving unchanged via this barrel.

export { CAPABILITY_DATA } from "@oscharko-dev/keiko-model-gateway";
