// @oscharko-dev/keiko-sandbox — the reusable OS/container egress-isolation strategy (ADR-0043).
//
// keiko-sandbox decides HOW a `network: "none"` command is wrapped so that an outbound connection from
// the child fails; the single spawn boundary stays in keiko-tools' exec.ts, which applies the decision
// and records the returned attestation. The same path is the shared isolated-execution boundary for
// the #1202 assured pre-filter and the #1204 post-apply verification.

export {
  buildWrappedCommand,
  SEATBELT_DENY_EGRESS_PROFILE,
  DEFAULT_CONTAINER_IMAGE,
} from "./backends.js";
export type { WrappedCommand } from "./backends.js";
export { selectEnforcingBackend } from "./select.js";
export { planIsolatedRun } from "./plan.js";
export { probeBackends, currentPlatform, isExecutableOnPath } from "./probe.js";
export type {
  BackendAvailability,
  IsolatedRunDecision,
  IsolatedRunPlan,
  NetworkPolicy,
  SandboxAttestation,
  SandboxBackend,
} from "./types.js";
