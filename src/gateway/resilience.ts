// Re-export shim: resilience now lives in @oscharko-dev/keiko-model-gateway (issue #160, ADR-0019).
// All existing import sites (`from "../gateway/resilience.js"`) keep resolving unchanged via this barrel.

export { CircuitBreaker, executeWithRetry, systemClock } from "@oscharko-dev/keiko-model-gateway";
export type { RetryConfig } from "@oscharko-dev/keiko-model-gateway";
