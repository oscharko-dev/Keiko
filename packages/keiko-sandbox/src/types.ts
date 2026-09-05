// Public types for the egress-isolation strategy (ADR-0043). The shareable result shape
// (SandboxAttestation/SandboxBackend) lives in keiko-contracts so any consumer can read an
// attestation off a CommandResult without depending on keiko-sandbox; this module adds the
// package-internal planning shapes.

import type {
  FilesystemPolicy,
  NetworkGatewayPolicy,
  NetworkPolicy,
  SandboxAttestation,
} from "@oscharko-dev/keiko-contracts";

export type { FilesystemPolicy, NetworkGatewayPolicy, NetworkPolicy, SandboxAttestation };
export type { SandboxBackend } from "@oscharko-dev/keiko-contracts";

// `IsolatedRunPlan.network` is deliberately WIDER than keiko-contracts' `NetworkPolicy`
// (`"inherit" | "none"`, the general SandboxPolicy-facing type keiko-tools' exec.ts exhaustively
// switches on). Folding the gateway shape into that shared type would make an existing
// `!== "none"` check on a `SandboxPolicy` elsewhere silently treat a gateway policy as "inherited"
// (unconfined) network — this planning-only union exists so the gateway shape can never reach a
// `SandboxPolicy` structurally, only this package's own plan/decision types.
export type IsolatedRunNetworkPolicy = NetworkPolicy | NetworkGatewayPolicy;

// Which enforcing backends a host has available. Produced by the probe, then fed into the PURE
// selector so backend choice is deterministic and unit-testable without touching the filesystem.
export interface BackendAvailability {
  readonly bubblewrap: boolean;
  readonly unshare: boolean;
  readonly seatbelt: boolean;
  readonly docker: boolean;
  readonly podman: boolean;
}

// A command to run under isolation. `cwd` must already be a real, workspace-contained directory:
// keiko-tools' exec.ts owns containment, env name-allowlisting, and HOME scrubbing — keiko-sandbox
// only prepends the egress wrapper.
export interface IsolatedRunPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly network: IsolatedRunNetworkPolicy;
  readonly filesystem?: FilesystemPolicy | undefined;
  /** Exact trusted child executable admitted by the long-lived gateway profile. */
  readonly gatewayChildExecutable?: string | undefined;
}

// The decision for a single run:
//   - passthrough: network "inherit" — run as-is, no isolation, networkEnforced false.
//   - wrapped: network "none" with an enforcing backend, OR a valid gateway policy with a backend
//     that can bind the child to exactly that loopback destination (macOS Seatbelt today) — run
//     the wrapped command.
//   - fail-closed: network "none" with no enforcing backend, OR a gateway policy on a platform
//     with no backend that can reach the host's loopback gateway (Linux network-namespace/
//     container isolation cannot bridge back to it; Windows has no backend at all) — the caller
//     MUST NOT run the command.
export type IsolatedRunDecision =
  | {
      readonly kind: "passthrough";
      readonly command: string;
      readonly args: readonly string[];
      readonly attestation: SandboxAttestation;
    }
  | {
      readonly kind: "wrapped";
      readonly command: string;
      readonly args: readonly string[];
      readonly attestation: SandboxAttestation;
    }
  | {
      readonly kind: "fail-closed";
      readonly reason: string;
      readonly attestation: SandboxAttestation;
    };
