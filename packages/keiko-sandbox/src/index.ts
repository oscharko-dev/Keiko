// @oscharko-dev/keiko-sandbox — the reusable OS/container egress-isolation strategy (ADR-0043).
//
// keiko-sandbox decides HOW isolated commands are wrapped. Disposable `network: "none"` runs keep
// their single spawn boundary in keiko-tools' exec.ts. Gateway-confined Linux runs use this package's
// internal launcher to own the namespace/relay lifecycle; callers still receive one wrapped command.
// The disposable path remains the shared isolated-execution boundary for the #1202 assured pre-filter
// and the #1204 post-apply verification.

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
  attestDarwinGitExecutable,
  resolveDarwinGitExecutable,
  type AttestedDarwinGitExecutable,
} from "./darwin-git.js";
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
  LINUX_GATEWAY_DIAGNOSTIC_FD,
  LINUX_GATEWAY_DIAGNOSTIC_FD_ENV,
  PRODUCTION_RUNTIME_QUALIFICATIONS,
  parseLinuxGatewayDiagnosticLine,
  qualificationFromReceipt,
  qualifyLongLivedRuntime,
} from "./runtime.js";
export type { ClosedRuntimeLaunchProfile, LongLivedRuntimeQualificationResult } from "./runtime.js";
export type {
  BackendAvailability,
  IsolatedRunDecision,
  IsolatedRunNetworkPolicy,
  IsolatedRunPlan,
  NetworkGatewayPolicy,
  NetworkPolicy,
  SandboxAttestation,
  SandboxBackend,
} from "./types.js";
