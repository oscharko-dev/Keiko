import {
  planIsolatedRun,
  type AttestedDarwinGitExecutable,
  type BackendAvailability,
  type RuntimeGatewayConfinement,
} from "@oscharko-dev/keiko-sandbox";
import { activityLogEvent } from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  RUNTIME_CONFINEMENT_SPAWNED_OPERATION,
  RUNTIME_CONFINEMENT_STALE_GRANTS_SWEPT_OPERATION,
} from "./codingRuntimeActivityOperations.js";
import { validateRuntimeGatewayFilesystemRoots } from "./nativeRuntimeProcessPaths.js";
import type { RuntimeSupervisorLaunchRequest } from "./runtimeProcessSupervisor.js";

interface RuntimeGatewayProcessSandboxInput {
  readonly request: RuntimeSupervisorLaunchRequest;
  readonly executable: string;
  readonly cwd: string;
  readonly runtimeRoots: readonly string[];
  readonly policy: RuntimeGatewayConfinement;
  readonly gitExecutable: AttestedDarwinGitExecutable | undefined;
  readonly availability: BackendAvailability;
  readonly platform: NodeJS.Platform;
}

/** Both prepared and direct launches derive the wrapper from the same owned gateway policy. */
export function prepareRuntimeGatewayProcessSandbox(
  input: RuntimeGatewayProcessSandboxInput,
): Extract<ReturnType<typeof planIsolatedRun>, { readonly kind: "wrapped" }> {
  const { policy, request, gitExecutable } = input;
  if (policy.runId !== request.runId || policy.treeBindingId !== request.treeBindingId)
    throw new Error("runtime-gateway-confinement-drift");
  validateRuntimeGatewayFilesystemRoots(policy.filesystem, input.runtimeRoots, input.cwd);
  const decision = planIsolatedRun(
    {
      command: input.executable,
      args: request.args,
      cwd: input.cwd,
      network: {
        mode: "gateway",
        host: policy.addressFamily === "ipv4" ? "127.0.0.1" : "::1",
        port: policy.port,
      },
      ...(gitExecutable === undefined ? {} : { gatewayChildExecutable: gitExecutable.path }),
      ...(policy.filesystem === undefined ? {} : { gatewayFilesystem: policy.filesystem }),
      gatewayProfile: policy.profile,
      ...(policy.egress === undefined ? {} : { gatewayEgress: policy.egress }),
    },
    input.availability,
    input.platform,
  );
  if (decision.kind !== "wrapped") throw new Error("runtime-gateway-confinement-unavailable");
  return decision;
}

/**
 * Only the gateway profile admits Git through its process-exec allowlist, so only it needs an
 * attested Git (ADR-0043 D16). The native profile has no exec allowlist: its shell runs the host's
 * toolchains, Git included, from the system PATH. Attesting there only refused a run on a managed
 * Mac whose Git is Xcode's in the admin-writable /Applications (customer, 1.3.4). Every backend
 * that launches a confined runtime asks this one rule.
 */
export function runtimeProfileAttestsGit(profile: RuntimeGatewayConfinement["profile"]): boolean {
  return profile !== "keiko-native";
}

function childExecutablePolicy(
  profile: RuntimeGatewayConfinement["profile"],
  git: AttestedDarwinGitExecutable | undefined,
): "toolchain-inherited" | "namespace-inherited" | "runtime-and-attested-git-only" {
  if (profile === "keiko-native") return "toolchain-inherited";
  return git === undefined ? "namespace-inherited" : "runtime-and-attested-git-only";
}

/**
 * A confined Windows tree handed to the broker (ADR-0043 D18, #4068). Every descendant inherits the
 * per-tree AppContainer token. The grants are counted, never named: the tree's own SID receives its
 * runtime and private state, and a managed worktree is readable only through its capability.
 */
export function recordWindowsGatewayConfinementSpawned(
  sink: ServerLogSink,
  runId: string,
  policy: RuntimeGatewayConfinement,
  grants: readonly { readonly principal: "tree" | "capability" }[],
): void {
  sink.write(
    activityLogEvent(
      RUNTIME_CONFINEMENT_SPAWNED_OPERATION,
      { correlationId: runId },
      {
        backend: "windows-wfp",
        policyDigest: policy.policyDigest,
        authorityDigest: policy.envelopeDigest,
        runtimeArtifactDigest: policy.runtimeArtifactDigest,
        modelProfileDigest: policy.modelProfileDigest,
        treeBindingId: policy.treeBindingId,
        profile: policy.profile,
        childExecutablePolicy: "appcontainer-inherited",
        windowsTreeGrantCount: grants.filter((grant) => grant.principal === "tree").length,
        windowsWorktreeAccess: grants.some((grant) => grant.principal === "capability")
          ? "capability-read"
          : "none",
      },
    ),
  );
}

/**
 * What a confined Windows launch removed of the tree entries crashed supervisors left on its
 * granted directories (#4068, ADR-0043 D18). Nothing is recorded when the sweep found nothing;
 * a failure keeps the launch, because a stale entry names a SID no later process can obtain.
 */
export function recordWindowsStaleGrantsSwept(
  sink: ServerLogSink,
  runId: string,
  sweep: { readonly removed: number; readonly failed: number },
): void {
  if (sweep.removed === 0 && sweep.failed === 0) return;
  sink.write(
    activityLogEvent(
      RUNTIME_CONFINEMENT_STALE_GRANTS_SWEPT_OPERATION,
      { correlationId: runId },
      { backend: "windows-wfp", removedEntryCount: sweep.removed, failedCount: sweep.failed },
    ),
  );
}

export function recordRuntimeGatewayConfinementSpawned(
  sink: ServerLogSink,
  runId: string,
  backend: "bubblewrap" | "unshare" | "seatbelt",
  policy: RuntimeGatewayConfinement,
  git: AttestedDarwinGitExecutable | undefined,
  parentLifetime?: "stdin-eof",
): void {
  sink.write(
    activityLogEvent(
      RUNTIME_CONFINEMENT_SPAWNED_OPERATION,
      { correlationId: runId },
      {
        backend,
        policyDigest: policy.policyDigest,
        authorityDigest: policy.envelopeDigest,
        runtimeArtifactDigest: policy.runtimeArtifactDigest,
        modelProfileDigest: policy.modelProfileDigest,
        treeBindingId: policy.treeBindingId,
        profile: policy.profile,
        ...(parentLifetime === undefined ? {} : { parentLifetime }),
        childExecutablePolicy: childExecutablePolicy(policy.profile, git),
        // Recorded for the native profile only: the kernel-enforced network disposition the run's
        // mode selected (loopback-only below Full access, inherited at Full access).
        ...(policy.egress === undefined ? {} : { egressDisposition: policy.egress }),
        ...(git === undefined ? {} : { childExecutableDigest: git.sha256 }),
        ...(git?.source === undefined ? {} : { childExecutableSource: git.source }),
        ...(policy.filesystem === undefined
          ? {}
          : {
              filesystemPolicy:
                policy.filesystem.workspaceAccess === "read-write"
                  ? "native-workspace-rw-v1"
                  : "native-root-union-v1",
              workspaceAccess:
                policy.filesystem.workspaceAccess === "read-write"
                  ? "read-write"
                  : "read-only-outside-private-state",
              privateStateAccess: "read-write",
            }),
      },
    ),
  );
}
