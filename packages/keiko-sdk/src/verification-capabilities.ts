import { type SandboxBackend } from "@oscharko-dev/keiko-contracts";
import {
  DEFAULT_VERIFICATION_LIMITS,
  nodeResourceMonitor,
  resolveStepNetwork,
  type NetworkEnforcementMode,
  type VerificationPlan,
  type VerificationStep,
} from "@oscharko-dev/keiko-verification";

export type VerificationCapabilityDenialReason =
  "memory-process-tree-unavailable" | "network-isolation-unavailable";

export type NetworkIsolationCapability =
  | { readonly backend: "none"; readonly enforced: false }
  | { readonly backend: Exclude<SandboxBackend, "none">; readonly enforced: boolean };

const UNATTESTED_NETWORK_ISOLATION: NetworkIsolationCapability = {
  backend: "none",
  enforced: false,
};

function assertNetworkIsolationCapability(capability: NetworkIsolationCapability): void {
  const candidate: { readonly backend: SandboxBackend; readonly enforced: boolean } = capability;
  if (candidate.backend === "none" && candidate.enforced) {
    throw new TypeError("network isolation cannot be enforced without a sandbox backend");
  }
}

export interface VerificationStepCapability {
  readonly kind: VerificationStep["kind"];
  readonly requiresMemoryCeiling: boolean;
  readonly requiresNetworkIsolation: boolean;
  readonly runnable: boolean;
  readonly denialReasons: readonly VerificationCapabilityDenialReason[];
}

export interface VerificationCapabilities {
  readonly memoryProcessTreeEnforced: boolean;
  readonly networkIsolation: NetworkIsolationCapability;
  readonly defaultNetworkEnforcement: NetworkEnforcementMode;
  readonly defaultRunnable: boolean;
  readonly defaultDenialReasons: readonly VerificationCapabilityDenialReason[];
  readonly steps: readonly VerificationStepCapability[];
}

function stepCapability(
  step: VerificationStep,
  memoryProcessTreeEnforced: boolean,
  networkEnforcement: NetworkEnforcementMode,
  networkEnforced: boolean,
): VerificationStepCapability {
  const denialReasons: VerificationCapabilityDenialReason[] = [];
  const requiresMemoryCeiling = step.limits.maxMemoryBytes !== undefined;
  const requiresNetworkIsolation = step.limits.network === "none";
  if (requiresMemoryCeiling && !memoryProcessTreeEnforced) {
    denialReasons.push("memory-process-tree-unavailable");
  }
  if (
    requiresNetworkIsolation &&
    (networkEnforcement === "inherit" ||
      resolveStepNetwork(step.limits, networkEnforcement, networkEnforced).kind === "fail-closed")
  ) {
    denialReasons.push("network-isolation-unavailable");
  }
  return {
    kind: step.kind,
    requiresMemoryCeiling,
    requiresNetworkIsolation,
    runnable: denialReasons.length === 0,
    denialReasons,
  };
}

export function probeVerificationCapabilities(
  plan: Pick<VerificationPlan, "steps">,
  networkEnforcement: NetworkEnforcementMode = "enforce-or-fail-closed",
  networkIsolation: NetworkIsolationCapability = UNATTESTED_NETWORK_ISOLATION,
): VerificationCapabilities {
  assertNetworkIsolationCapability(networkIsolation);
  const memoryProcessTreeEnforced = nodeResourceMonitor.canEnforceProcessTreeMemory();
  const defaultStep: VerificationStep = {
    kind: "test",
    scriptName: "test",
    command: "npm",
    args: ["test"],
    limits: DEFAULT_VERIFICATION_LIMITS,
  };
  const defaults = stepCapability(
    defaultStep,
    memoryProcessTreeEnforced,
    networkEnforcement,
    networkIsolation.enforced,
  );
  return {
    memoryProcessTreeEnforced,
    networkIsolation,
    defaultNetworkEnforcement: networkEnforcement,
    defaultRunnable: defaults.runnable,
    defaultDenialReasons: defaults.denialReasons,
    steps: plan.steps.map((step) =>
      stepCapability(
        step,
        memoryProcessTreeEnforced,
        networkEnforcement,
        networkIsolation.enforced,
      ),
    ),
  };
}
