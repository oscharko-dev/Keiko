// PURE planning entry point. Given a run plan, the probed availability, and the platform, decide how
// the command is executed: passthrough (inherited network), wrapped (enforced egress), or fail-closed
// (egress requested but unenforceable). The attestation it returns is recorded on the CommandResult so
// keiko-verification can report an HONEST `enforced` network flag (ADR-0043).

import { buildWrappedCommand } from "./backends.js";
import { selectEnforcingBackend } from "./select.js";
import type { BackendAvailability, IsolatedRunDecision, IsolatedRunPlan } from "./types.js";

const FAIL_CLOSED_REASON =
  'deny-by-default network isolation was requested (network: "none") but no enforcing sandbox ' +
  "backend is available on this host (need bubblewrap or unshare on Linux, sandbox-exec on macOS, " +
  "or docker/podman). Untrusted code is not executed.";

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
      attestation: { backend: "none", networkEnforced: false, platform },
    };
  }
  const backend = selectEnforcingBackend(platform, availability);
  const wrapped = buildWrappedCommand(backend, plan);
  if (backend === "none" || wrapped === undefined) {
    return {
      kind: "fail-closed",
      reason: FAIL_CLOSED_REASON,
      attestation: { backend: "none", networkEnforced: false, platform },
    };
  }
  return {
    kind: "wrapped",
    command: wrapped.command,
    args: wrapped.args,
    attestation: { backend, networkEnforced: true, platform },
  };
}
