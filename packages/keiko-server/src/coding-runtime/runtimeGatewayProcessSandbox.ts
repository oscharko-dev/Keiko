import {
  planIsolatedRun,
  type AttestedDarwinGitExecutable,
  type BackendAvailability,
  type RuntimeGatewayConfinement,
} from "@oscharko-dev/keiko-sandbox";
import { activityLogEvent } from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { RUNTIME_CONFINEMENT_SPAWNED_OPERATION } from "./codingRuntimeActivityOperations.js";
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
    },
    input.availability,
    input.platform,
  );
  if (decision.kind !== "wrapped") throw new Error("runtime-gateway-confinement-unavailable");
  return decision;
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
        childExecutablePolicy:
          git === undefined ? "namespace-inherited" : "runtime-and-attested-git-only",
        ...(git === undefined ? {} : { childExecutableDigest: git.sha256 }),
        ...(git?.source === undefined ? {} : { childExecutableSource: git.source }),
        ...(policy.filesystem === undefined
          ? {}
          : {
              filesystemPolicy: "native-root-union-v1",
              workspaceAccess: "read-only-outside-private-state",
              privateStateAccess: "read-write",
            }),
      },
    ),
  );
}
