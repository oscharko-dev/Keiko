// Re-export shim: gateway now lives in @oscharko-dev/keiko-model-gateway (issue #160, ADR-0019).
// All existing import sites (`from "../gateway/gateway.js"`) keep resolving unchanged via this barrel.

export { Gateway } from "@oscharko-dev/keiko-model-gateway";
export type { GatewayDeps } from "@oscharko-dev/keiko-model-gateway";
