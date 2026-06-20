// Public types for the egress-isolation strategy (ADR-0043). The shareable result shape
// (SandboxAttestation/SandboxBackend) lives in keiko-contracts so any consumer can read an
// attestation off a CommandResult without depending on keiko-sandbox; this module adds the
// package-internal planning shapes.

import type {
  NetworkPolicy,
  SandboxAttestation,
  SandboxBackend,
} from "@oscharko-dev/keiko-contracts";

export type { NetworkPolicy, SandboxAttestation, SandboxBackend };

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
  readonly network: NetworkPolicy;
}

// The decision for a single run:
//   - passthrough: network "inherit" — run as-is, no isolation, networkEnforced false.
//   - wrapped: network "none" with an enforcing backend — run the wrapped command.
//   - fail-closed: network "none" but no enforcing backend — the caller MUST NOT run the command.
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
