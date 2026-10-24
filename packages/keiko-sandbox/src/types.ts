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

/** The long-lived runtime profiles the gateway planner can wrap (ADR-0043 D14, #3897). */
export type RuntimeGatewayProfile = "keiko-gateway" | "keiko-native";

/**
 * The native profile's network disposition (#3897). `loopback-only` is the kernel-enforced floor
 * below Full access: the attested Model Gateway, the tool facade and local dev servers are loopback,
 * every other destination is denied before traffic. `inherited` is Full access, whose egress stays
 * bounded by the accepted Authority Envelope and the per-action permission policy.
 */
export type RuntimeGatewayEgress = "inherited" | "loopback-only";

/**
 * Transient, server-owned native service roots; model-visible access needs its own authority hook.
 * `read-write` is the native profile (#3897): the workspace is the agent's working tree, writes
 * stay inside it and the private state, and `deniedReadRoots` keeps credential stores and Keiko's
 * own state out of reach regardless of what the agent runs.
 */
export interface RuntimeGatewayFilesystem {
  readonly workspaceRoot: string;
  readonly workspaceAccess: "read-only" | "read-write";
  readonly privateStateRoot: string;
  readonly runtimeReadRoot: string;
  readonly deniedReadRoots?: readonly string[] | undefined;
  /**
   * Native profile only: absolute read-only support roots of the project's toolchains (the
   * directories the launcher's `PATH` names, or their install prefixes). Everything else outside
   * the workspace, the private state and the system roots stays unreadable (#3897).
   */
  readonly toolchainReadRoots?: readonly string[] | undefined;
  /**
   * Native profile only: the common Git directory of a workspace that is a linked worktree, which
   * its `.git` file names outside the workspace. The server proves the reciprocal worktree
   * registration before it names one; the process reads it, never writes it, so status, diff, log,
   * show and blame work while staging and delivery stay with Keiko (#3897 review). Absent means the
   * workspace carries its own Git directory, or none was proven.
   */
  readonly gitMetadataReadRoots?: readonly string[] | undefined;
  /**
   * Native profile only: absolute directories strictly inside the writable roots (the workspace or
   * the private state) that the process may read but never create, change, replace, remove or move
   * entries in, so a shell child cannot rewrite the policy plugin or the configuration the runtime
   * loads from its private state (#3897 review). Absent means the writable roots stay fully writable.
   */
  readonly protectedWriteRoots?: readonly string[] | undefined;
  /**
   * Native profile only: absolute directories strictly inside the private state where the process
   * writes ordinary files and directories but never creates a symbolic or hard link, and whose
   * ancestors up to the private state cannot be replaced, so a path inside one always names a file
   * physically inside it (the plan agent's notes, #3897 review). Absent means no such constraint.
   */
  readonly linkFreeWriteRoots?: readonly string[] | undefined;
}

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
// owns the requested network/filesystem wrapper and local container endpoint validation.
export interface IsolatedRunPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly network: IsolatedRunNetworkPolicy;
  readonly filesystem?: FilesystemPolicy | undefined;
  /** Exact trusted child executable admitted by the long-lived gateway profile. */
  readonly gatewayChildExecutable?: string | undefined;
  readonly gatewayFilesystem?: RuntimeGatewayFilesystem | undefined;
  /** Absent means the loopback-gateway-only profile; `keiko-native` opens toolchains and egress. */
  readonly gatewayProfile?: RuntimeGatewayProfile | undefined;
  /** Native profile only; absent fails closed to `loopback-only`. */
  readonly gatewayEgress?: RuntimeGatewayEgress | undefined;
}

// The decision for a single run:
//   - passthrough: network and filesystem "inherit" — run as-is, neither boundary enforced.
//   - wrapped: network "none" or filesystem "execution-root" with a compatible enforcing backend,
//     OR a valid gateway policy with a backend
//     that can bind the child to exactly that loopback destination (macOS Seatbelt or the Linux
//     namespace bridge) — run the wrapped command.
//   - fail-closed: a requested network/filesystem boundary with no compatible backend, OR a gateway policy on a platform
//     with no qualifying backend — the caller MUST NOT run the command.
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
