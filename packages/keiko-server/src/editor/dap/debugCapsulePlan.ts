import { createHash } from "node:crypto";
import type { StrictDebugCapsulePlan } from "@oscharko-dev/keiko-sandbox";

declare const layer2PlanBrand: unique symbol;

export type DebugCapsuleBackend = "oci" | "linuxNamespace" | "windowsContainer";
type DebugTargetKind = "catalog" | "file";

export interface PosixDebugEndpointPlan {
  readonly kind: "posixSocket";
  readonly hostRuntimeDirectory: string;
  readonly hostSocketPath: string;
  readonly capsuleRuntimeDirectory: string;
  readonly capsuleSocketPath: string;
  readonly runtimeIdentity: string;
}

interface WindowsDebugEndpointPlan {
  readonly kind: "windowsPipe";
  readonly pipeName: string;
  readonly runtimeIdentity: string;
}

export interface ClosedFileDebugLaunchArguments {
  readonly request: "launch";
  readonly runtimeExecutable: string;
  readonly program: string;
  readonly args: readonly [];
  readonly cwd: "/keiko-execution-root";
  readonly console: "internalConsole";
}
export interface ClosedCatalogDebugLaunchArguments {
  readonly request: "launch";
  readonly runtimeExecutable: string;
  readonly runtimeArgs: readonly [string, string, string, string, string, string, "run", string];
  readonly cwd: "/keiko-execution-root";
  readonly console: "internalConsole";
}
export type ClosedDebugLaunchRequest =
  | { readonly command: "launch"; readonly arguments: ClosedFileDebugLaunchArguments }
  | { readonly command: "launch"; readonly arguments: ClosedCatalogDebugLaunchArguments };

export interface DebugCapsulePlanBinding {
  readonly workspacePartitionKey: string;
  readonly activationRevision: number;
  readonly targetKind: DebugTargetKind;
}

export interface DebugSpawnArtifactIdentity {
  readonly hostPath: string;
  readonly realPath: string;
  readonly approvedRootRealPath: string;
  readonly capsulePath: string;
  readonly identityDigest: string;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly mode: number;
  readonly ownerUid: number;
}

export interface DebugWorkspaceIdentity {
  readonly realPath: string;
  readonly identityDigest: string;
  readonly objectIdentityDigest: string;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly ownerUid: number;
}

export interface DebugRuntimeDirectoryIdentity {
  readonly realPath: string;
  readonly identityDigest: string;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly ownerUid: number;
}

type DebugSpawnTargetReference =
  | { readonly kind: "catalog"; readonly targetId: string }
  | { readonly kind: "file"; readonly fileId: string };

export interface DebugSpawnEnvelope {
  readonly schemaVersion: "1";
  readonly planId: string;
  readonly providerId: string;
  readonly backend: DebugCapsuleBackend;
  readonly provisioningDigest: string;
  readonly runtimeIdentityDigest: string;
  readonly runtimeDirectoryIdentity: DebugRuntimeDirectoryIdentity;
  readonly capsuleCommand: string;
  readonly capsuleArgs: readonly string[];
  readonly adapterExecutable: string;
  readonly adapterArgs: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly home: string;
  readonly temp: string;
  readonly cwd: "/keiko-execution-root";
  readonly endpoint: PosixDebugEndpointPlan | WindowsDebugEndpointPlan;
  readonly artifacts: readonly DebugSpawnArtifactIdentity[];
  readonly workspaceIdentity: DebugWorkspaceIdentity;
  readonly targetIdentityDigest: string;
  readonly targetReference: DebugSpawnTargetReference;
  readonly activationRevision: number;
  readonly epoch: number;
  readonly expiresAtMs: number;
  readonly identityDigest: string;
}

/**
 * Nominal Layer-2 result. A caller can submit only an untrusted candidate; the manager obtains this
 * value exclusively from its injected #2344 validator/re-deriver port.
 */
export interface Layer2DebugCapsulePlan extends DebugCapsulePlanBinding {
  readonly [layer2PlanBrand]: true;
  readonly schemaVersion: "1";
  readonly planId: string;
  readonly epoch: number;
  readonly expiresAtMs: number;
  readonly launchIdentityDigest: string;
  readonly provisioningDigest: string;
  readonly backend: DebugCapsuleBackend;
  readonly runtimeIdentityDigest: string;
  readonly endpoint: PosixDebugEndpointPlan | WindowsDebugEndpointPlan;
  readonly capsule: StrictDebugCapsulePlan;
  readonly spawnEnvelope: DebugSpawnEnvelope;
  readonly attestation: {
    readonly filesystem: "executionRoot";
    readonly network: "none";
    readonly processScope: "capsule";
    readonly runtimeDirectoryMode: "0700";
    readonly endpointOwnership: "currentUser";
  };
  readonly launchRequest: ClosedDebugLaunchRequest;
}

export interface DebugCapsuleLayer2Input {
  readonly candidate: unknown;
  /** Operation correlation minted by the server-owned launch route. */
  readonly correlationId?: string | undefined;
  readonly binding: DebugCapsulePlanBinding;
  readonly adapter: {
    readonly providerId: string;
    readonly executable: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly home: string;
    readonly temp: string;
    readonly runtimeRoot: string;
  };
}

export interface DebugCapsuleLayer2Validator {
  validateAndRederive(input: DebugCapsuleLayer2Input): Promise<Layer2DebugCapsulePlan>;
}

export class DebugCapsulePlanError extends Error {
  public readonly code = "INVALID_CAPSULE_PLAN" as const;
  public constructor() {
    super("INVALID_CAPSULE_PLAN");
    this.name = "DebugCapsulePlanError";
  }
}

export function assertPlanBoundToRequest(
  plan: Layer2DebugCapsulePlan,
  binding: DebugCapsulePlanBinding,
): void {
  const actual = bindingValues(plan);
  const expected = bindingValues(binding);
  if (actual.some((value, index) => value !== expected[index])) throw new DebugCapsulePlanError();
}

function bindingValues(binding: DebugCapsulePlanBinding): readonly (number | string)[] {
  return [binding.workspacePartitionKey, binding.activationRevision, binding.targetKind];
}

/** Canonical identity of the observed immutable provisioning closure, excluding session runtime. */
export function deriveCanonicalDebugProvisioningDigest(
  artifacts: readonly DebugSpawnArtifactIdentity[],
): string {
  const canonical = artifacts
    .map((artifact) => [
      artifact.capsulePath,
      artifact.realPath,
      artifact.approvedRootRealPath,
      artifact.identityDigest,
      artifact.device,
      artifact.inode,
      artifact.size,
      artifact.mode,
      artifact.ownerUid,
    ])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
