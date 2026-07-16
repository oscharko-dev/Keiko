import type { IsolatedRunDecision } from "@oscharko-dev/keiko-sandbox";

export interface SeparateDebugWrapperTopology {
  readonly capsuleCount: 2;
  readonly mutuallyReachable: false;
  readonly accepted: false;
}

function isIsolated(decision: IsolatedRunDecision): boolean {
  return decision.attestation.networkEnforced;
}

export function inspectSeparateDebugWrappers(
  adapter: IsolatedRunDecision,
  debuggee: IsolatedRunDecision,
): SeparateDebugWrapperTopology {
  if (!isIsolated(adapter) || !isIsolated(debuggee)) {
    throw new Error("DEBUG_TOPOLOGY_UNPROVEN");
  }
  return Object.freeze({ capsuleCount: 2, mutuallyReachable: false, accepted: false });
}
