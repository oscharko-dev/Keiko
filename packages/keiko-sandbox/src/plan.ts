// PURE planning entry point. Given a run plan, the probed availability, and the platform, decide how
// the command is executed: passthrough (inherited network), wrapped (enforced egress), or fail-closed
// (egress requested but unenforceable). The attestation it returns is recorded on the CommandResult so
// keiko-verification can report an HONEST `enforced` network flag (ADR-0043).

import { isValidNetworkGatewayPolicy } from "@oscharko-dev/keiko-contracts/runtime/tools";
import { buildWrappedCommand } from "./backends.js";
import { selectEnforcingBackend, selectGatewayBackend } from "./select.js";
import type { BackendAvailability, IsolatedRunDecision, IsolatedRunPlan } from "./types.js";

const FAIL_CLOSED_REASON =
  'deny-by-default isolation was requested (network: "none") but no compatible sandbox backend ' +
  "is available on this host. Network-only runs need bubblewrap or unshare on Linux, sandbox-exec " +
  "on macOS, or docker/podman; execution-root runs need strict bubblewrap or docker/podman. " +
  "Untrusted code is not executed.";

// Shared with keiko-server's native runtime backend (nativeRuntimeProcessBackend.ts) so a Windows
// (or any other unsupported-host) gateway launch reports the identical closed reason this planner
// would produce, instead of a second, independently-worded string (AGENTS.md #7).
export const GATEWAY_UNSUPPORTED_ON_HOST_REASON =
  "unsupported-on-this-host: gateway-allowlist isolation was requested but no backend on this " +
  "platform can bind a child process to exactly the configured loopback gateway destination. A " +
  "Linux bubblewrap/unshare network namespace (and a container's own network namespace) has no " +
  "route back to the parent's loopback socket without additional bridging this host does not " +
  "provide, and no Windows-native equivalent exists yet. Falling back to a weaker isolation tier " +
  "or an unconfined spawn is not an acceptable substitute. Untrusted network access is not granted.";

function noneEnforcedAttestation(platform: NodeJS.Platform): IsolatedRunDecision["attestation"] {
  return { backend: "none", networkEnforced: false, filesystemEnforced: false, platform };
}

export function planIsolatedRun(
  plan: IsolatedRunPlan,
  availability: BackendAvailability,
  platform: NodeJS.Platform,
): IsolatedRunDecision {
  if (plan.network === "inherit") {
    return {
      kind: "passthrough",
      command: plan.command,
      args: plan.args,
      attestation: noneEnforcedAttestation(platform),
    };
  }
  if (isValidNetworkGatewayPolicy(plan.network)) {
    return planGatewayRun(plan, availability, platform);
  }
  const filesystem = plan.filesystem ?? "inherit";
  const backend = selectEnforcingBackend(platform, availability, filesystem);
  const wrapped = buildWrappedCommand(backend, plan);
  if (backend === "none" || wrapped === undefined) {
    return {
      kind: "fail-closed",
      reason: FAIL_CLOSED_REASON,
      attestation: noneEnforcedAttestation(platform),
    };
  }
  return {
    kind: "wrapped",
    command: wrapped.command,
    args: wrapped.args,
    attestation: {
      backend,
      networkEnforced: true,
      filesystemEnforced: filesystem === "execution-root",
      platform,
    },
  };
}

function planGatewayRun(
  plan: IsolatedRunPlan,
  availability: BackendAvailability,
  platform: NodeJS.Platform,
): IsolatedRunDecision {
  const backend = selectGatewayBackend(platform, availability);
  const wrapped = buildWrappedCommand(backend, plan);
  if (backend === "none" || wrapped === undefined) {
    return {
      kind: "fail-closed",
      reason: GATEWAY_UNSUPPORTED_ON_HOST_REASON,
      attestation: noneEnforcedAttestation(platform),
    };
  }
  return {
    kind: "wrapped",
    command: wrapped.command,
    args: wrapped.args,
    attestation: { backend, networkEnforced: true, filesystemEnforced: false, platform },
  };
}
