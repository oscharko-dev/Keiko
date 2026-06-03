// Re-export shim: aggregation lives in @oscharko-dev/keiko-evidence (issue #163, ADR-0019). All
// existing import sites (`from "../audit/aggregate.js"`) keep resolving unchanged via this barrel.
// `resolveCostClass` was relocated to @oscharko-dev/keiko-model-gateway in the same issue and is
// deliberately ABSENT from this shim — callers import it from `../gateway/index.js`.

export { aggregateUsage } from "@oscharko-dev/keiko-evidence";
