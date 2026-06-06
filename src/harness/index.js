// Re-export shim: the harness now lives in @oscharko-dev/keiko-harness (issue #164,
// ADR-0019). All existing import sites (`from "../harness/index.js"`) keep resolving
// unchanged via this barrel. Symbols enumerated explicitly to match the PRE-MOVE surface
// of src/harness/index.ts (per the keiko-tools / keiko-workspace / keiko-evidence
// precedent — never `export *` in a legacy shim).
export { createSession, HARNESS_VERSION, runAgent, } from "@oscharko-dev/keiko-harness";
export { DEFAULT_LIMITS, HARNESS_CODES, TERMINAL_STATES, } from "@oscharko-dev/keiko-harness";
export { HarnessError, HarnessInternalError, HarnessModelError, HarnessToolError, LimitExceededError, toFailure, } from "@oscharko-dev/keiko-harness";
export { DryRunToolPort, GatewayModelPort, } from "@oscharko-dev/keiko-harness";
export { CliEventSink, MemoryEventSink, } from "@oscharko-dev/keiko-harness";
export { canonicalise, configFingerprint, counterIdSource, defaultFingerprinter, defaultIdSource, } from "@oscharko-dev/keiko-harness";
export { resolveTaskPlan } from "@oscharko-dev/keiko-harness";
