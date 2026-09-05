// @oscharko-dev/keiko-sandbox — the reusable OS/container egress-isolation strategy (ADR-0043).
//
// keiko-sandbox decides HOW a `network: "none"` command is wrapped so that an outbound connection from
// the child fails; the single spawn boundary stays in keiko-tools' exec.ts, which applies the decision
// and records the returned attestation. The same path is the shared isolated-execution boundary for
// the #1202 assured pre-filter and the #1204 post-apply verification.

export {
  buildWrappedCommand,
  buildGatewaySeatbeltCommand,
  SEATBELT_DENY_EGRESS_PROFILE,
  DEFAULT_CONTAINER_IMAGE,
} from "./backends.js";
export type { WrappedCommand } from "./backends.js";
export { selectEnforcingBackend, selectGatewayBackend } from "./select.js";
export { planIsolatedRun, GATEWAY_UNSUPPORTED_ON_HOST_REASON } from "./plan.js";
export {
  DEBUG_CAPSULE_RUNTIME_MOUNT,
  planStrictDebugCapsule,
  StrictDebugCapsulePlanError,
  type StrictDebugCapsuleInput,
  type StrictDebugCapsulePlan,
  type DebugCapsuleImmutableMount,
} from "./debug-capsule.js";
export { probeBackends, currentPlatform, isExecutableOnPath } from "./probe.js";
export {
  createRuntimeGatewayConfinement,
  copyRuntimeGatewayConfinement,
  isRuntimeGatewayConfinement,
  buildRuntimeGatewaySeatbeltCommand,
  type RuntimeGatewayConfinement,
  type RuntimeGatewayConfinementInput,
} from "./runtime-gateway.js";
export {
  CLOSED_RUNTIME_LAUNCH_PROFILE,
  PRODUCTION_RUNTIME_QUALIFICATIONS,
  qualificationFromReceipt,
  qualifyLongLivedRuntime,
} from "./runtime.js";
export type {
  ClosedRuntimeLaunchProfile,
  LongLivedRuntimeArchitecture,
  LongLivedRuntimeBackend,
  LongLivedRuntimePlatform,
  LongLivedRuntimeQualification,
  LongLivedRuntimeQualificationResult,
  RuntimeQualificationReceipt,
  RuntimeQualificationReceiptBinding,
  RuntimeQualificationReceiptResult,
  RuntimeQualificationSidecarDigest,
  RuntimeQualificationTarget,
} from "./runtime.js";
export type {
  BackendAvailability,
  IsolatedRunDecision,
  IsolatedRunPlan,
  NetworkGatewayPolicy,
  NetworkPolicy,
  SandboxAttestation,
  SandboxBackend,
} from "./types.js";
