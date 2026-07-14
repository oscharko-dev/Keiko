import { dirname, isAbsolute, normalize } from "node:path";
import { EXECUTION_ROOT_MOUNT } from "./backends.js";
import {
  isDigestPinnedDebugCapsuleImage,
  isSha256Digest,
} from "./debug-capsule-security-predicates.js";
import { selectEnforcingBackend } from "./select.js";
import type { BackendAvailability, SandboxBackend } from "./types.js";

export interface DebugCapsuleImmutableMount {
  readonly hostPath: string;
  readonly capsulePath: string;
  readonly identityDigest: string;
}

export interface StrictDebugCapsuleInput {
  readonly platform: NodeJS.Platform;
  readonly availability: BackendAvailability;
  readonly executionRoot: string;
  readonly runtimeHostDirectory: string;
  readonly runtimeCapsuleDirectory: string;
  readonly backendExecutables?:
    | {
        readonly bubblewrap?: string | undefined;
        readonly docker?: string | undefined;
        readonly podman?: string | undefined;
      }
    | undefined;
  readonly backendExecutableIdentityDigests?:
    | {
        readonly bubblewrap?: string | undefined;
        readonly docker?: string | undefined;
        readonly podman?: string | undefined;
      }
    | undefined;
  readonly runtimeMountIdentityDigest: string;
  readonly runtimeMountQualified: boolean;
  readonly executionRootIdentityDigest: string;
  readonly containerImage?: string | undefined;
  readonly adapterCapsuleExecutable: string;
  readonly adapterArgs: readonly string[];
  readonly immutableMounts: readonly DebugCapsuleImmutableMount[];
  readonly runtimeIdentityDigest: string;
}

// Stryker disable next-line StringLiteral: module-level constant initializers are evaluated before
// per-test mutant activation; the explicit contract test still pins this security-sensitive path.
export const DEBUG_CAPSULE_RUNTIME_MOUNT = "/run/keiko-debug";

export interface StrictDebugCapsulePlan {
  readonly backend: "linuxNamespace" | "oci" | "windowsContainer";
  readonly command: string;
  readonly backendExecutableIdentityDigest: string;
  readonly args: readonly string[];
  readonly executionRoot: string;
  readonly runtimeMount: {
    readonly hostPath: string;
    readonly capsulePath: string;
    readonly mode: "0700";
    readonly writable: true;
  };
  readonly immutableMounts: readonly DebugCapsuleImmutableMount[];
  readonly network: "none";
  readonly filesystem: "executionRoot";
  readonly descendantScope: "qualifiedCapsuleInit";
  readonly initMechanism: "bubblewrapPid1Reaper" | "ociInit";
  readonly runtimeIdentityDigest: string;
}

export class StrictDebugCapsulePlanError extends Error {
  public readonly code = "DEBUG_CAPSULE_UNAVAILABLE" as const;
  public constructor() {
    super("DEBUG_CAPSULE_UNAVAILABLE");
    this.name = "StrictDebugCapsulePlanError";
  }
}

function pathContains(parent: string, child: string): boolean {
  if (parent === "/") return child.startsWith("/");
  return child === parent || child.startsWith(`${parent}/`);
}

function normalizedAbsolute(path: string): string {
  if (!isAbsolute(path) || path.includes("\u0000")) throw new StrictDebugCapsulePlanError();
  const normalized = normalize(path);
  if (normalized !== path) throw new StrictDebugCapsulePlanError();
  return normalized;
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

function assertQualifiedPaths(input: StrictDebugCapsuleInput): void {
  const paths = [
    input.executionRoot,
    input.runtimeHostDirectory,
    input.runtimeCapsuleDirectory,
    input.adapterCapsuleExecutable,
  ];
  paths.forEach(normalizedAbsolute);
  if (
    input.executionRoot === "/" ||
    input.runtimeHostDirectory === "/" ||
    input.adapterCapsuleExecutable === "/"
  ) {
    throw new StrictDebugCapsulePlanError();
  }
  if (input.runtimeCapsuleDirectory !== DEBUG_CAPSULE_RUNTIME_MOUNT) {
    throw new StrictDebugCapsulePlanError();
  }
}

function assertQualifiedDigests(input: StrictDebugCapsuleInput): void {
  if (
    !isSha256Digest(input.runtimeIdentityDigest) ||
    !isSha256Digest(input.runtimeMountIdentityDigest) ||
    !isSha256Digest(input.executionRootIdentityDigest) ||
    !input.runtimeMountQualified
  ) {
    throw new StrictDebugCapsulePlanError();
  }
}

function assertMountDestinations(input: StrictDebugCapsuleInput): void {
  const mountedPaths = new Set<string>();
  for (const mount of input.immutableMounts) {
    normalizedAbsolute(mount.capsulePath);
    if (
      [EXECUTION_ROOT_MOUNT, DEBUG_CAPSULE_RUNTIME_MOUNT, ...mountedPaths].some((path) =>
        pathsOverlap(path, mount.capsulePath),
      )
    ) {
      throw new StrictDebugCapsulePlanError();
    }
    mountedPaths.add(mount.capsulePath);
  }
  if (!mountedPaths.has(input.adapterCapsuleExecutable)) {
    throw new StrictDebugCapsulePlanError();
  }
}

function assertImmutableMounts(input: StrictDebugCapsuleInput): void {
  const protectedSources = [input.executionRoot, input.runtimeHostDirectory];
  const mountedSources = new Set<string>();
  if (pathsOverlap(input.executionRoot, input.runtimeHostDirectory)) {
    throw new StrictDebugCapsulePlanError();
  }
  if (
    input.immutableMounts.some((mount) => {
      normalizedAbsolute(mount.hostPath);
      normalizedAbsolute(mount.capsulePath);
      const overlaps = [...protectedSources, ...mountedSources].some((path) =>
        pathsOverlap(path, mount.hostPath),
      );
      mountedSources.add(mount.hostPath);
      return mount.capsulePath === "/" || !isSha256Digest(mount.identityDigest) || overlaps;
    })
  ) {
    throw new StrictDebugCapsulePlanError();
  }
}

function backendExecutable(input: StrictDebugCapsuleInput, backend: SandboxBackend): string {
  let executable: string | undefined;
  if (backend === "bubblewrap") executable = input.backendExecutables?.bubblewrap;
  else if (backend === "container-docker") executable = input.backendExecutables?.docker;
  else if (backend === "container-podman") executable = input.backendExecutables?.podman;
  if (executable === undefined) throw new StrictDebugCapsulePlanError();
  const normalized = normalizedAbsolute(executable);
  if (normalized === "/") throw new StrictDebugCapsulePlanError();
  return normalized;
}

function backendExecutableDigest(input: StrictDebugCapsuleInput, backend: SandboxBackend): string {
  let digest: string | undefined;
  if (backend === "bubblewrap") digest = input.backendExecutableIdentityDigests?.bubblewrap;
  else if (backend === "container-docker") digest = input.backendExecutableIdentityDigests?.docker;
  else if (backend === "container-podman") digest = input.backendExecutableIdentityDigests?.podman;
  if (digest === undefined || !isSha256Digest(digest)) throw new StrictDebugCapsulePlanError();
  return digest;
}

function assertQualifiedInput(input: StrictDebugCapsuleInput): void {
  assertQualifiedPaths(input);
  assertQualifiedDigests(input);
  assertMountDestinations(input);
  assertImmutableMounts(input);
}

function immutableBubblewrapArgs(mounts: readonly DebugCapsuleImmutableMount[]): readonly string[] {
  return mounts.flatMap((mount) => ["--ro-bind", mount.hostPath, mount.capsulePath]);
}

function pathAncestors(path: string): readonly string[] {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.map((_segment, index) => `/${segments.slice(0, index + 1).join("/")}`);
}

function bubblewrapDirectoryArgs(input: StrictDebugCapsuleInput): readonly string[] {
  const directories = [
    ...pathAncestors(EXECUTION_ROOT_MOUNT),
    ...pathAncestors(input.runtimeCapsuleDirectory),
    ...input.immutableMounts.flatMap((mount) => pathAncestors(dirname(mount.capsulePath))),
  ];
  return [...new Set(directories)].flatMap((directory) => ["--dir", directory]);
}

function immutableContainerArgs(mounts: readonly DebugCapsuleImmutableMount[]): readonly string[] {
  return mounts.flatMap((mount) => ["--volume", `${mount.hostPath}:${mount.capsulePath}:ro`]);
}

function payload(input: StrictDebugCapsuleInput): readonly string[] {
  return [input.adapterCapsuleExecutable, ...input.adapterArgs];
}

function bubblewrapPlan(
  input: StrictDebugCapsuleInput,
  command: string,
  executableDigest: string,
): StrictDebugCapsulePlan {
  return freezePlan(input, "linuxNamespace", command, executableDigest, [
    "--unshare-net",
    "--unshare-pid",
    "--die-with-parent",
    "--new-session",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...bubblewrapDirectoryArgs(input),
    "--bind",
    input.executionRoot,
    EXECUTION_ROOT_MOUNT,
    "--bind",
    input.runtimeHostDirectory,
    input.runtimeCapsuleDirectory,
    ...immutableBubblewrapArgs(input.immutableMounts),
    "--chdir",
    EXECUTION_ROOT_MOUNT,
    "--",
    ...payload(input),
  ]);
}

function containerPlan(
  input: StrictDebugCapsuleInput,
  backend: "container-docker" | "container-podman",
  command: string,
  executableDigest: string,
): StrictDebugCapsulePlan {
  if (input.containerImage === undefined) throw new StrictDebugCapsulePlanError();
  if (!isDigestPinnedDebugCapsuleImage(input.containerImage.normalize())) {
    throw new StrictDebugCapsulePlanError();
  }
  return freezePlan(
    input,
    input.platform === "win32" ? "windowsContainer" : "oci",
    command,
    executableDigest,
    [
      "run",
      "--rm",
      "--pull=never",
      "--init",
      "--network=none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m",
      "--volume",
      `${input.executionRoot}:${EXECUTION_ROOT_MOUNT}:rw`,
      "--volume",
      `${input.runtimeHostDirectory}:${input.runtimeCapsuleDirectory}:rw`,
      ...immutableContainerArgs(input.immutableMounts),
      "--workdir",
      EXECUTION_ROOT_MOUNT,
      input.containerImage,
      ...payload(input),
    ],
  );
}

function freezePlan(
  input: StrictDebugCapsuleInput,
  backend: StrictDebugCapsulePlan["backend"],
  command: string,
  backendExecutableIdentityDigest: string,
  args: readonly string[],
): StrictDebugCapsulePlan {
  const initMechanism = deriveInitMechanism(backend, args);
  return Object.freeze({
    backend,
    command,
    backendExecutableIdentityDigest,
    args: Object.freeze([...args]),
    executionRoot: input.executionRoot,
    runtimeMount: Object.freeze({
      hostPath: input.runtimeHostDirectory,
      capsulePath: input.runtimeCapsuleDirectory,
      mode: "0700",
      writable: true,
    }),
    immutableMounts: Object.freeze(
      input.immutableMounts.map((mount) => Object.freeze({ ...mount })),
    ),
    network: "none",
    filesystem: "executionRoot",
    descendantScope: "qualifiedCapsuleInit",
    initMechanism,
    runtimeIdentityDigest: input.runtimeIdentityDigest,
  });
}

function deriveInitMechanism(
  backend: StrictDebugCapsulePlan["backend"],
  args: readonly string[],
): StrictDebugCapsulePlan["initMechanism"] {
  if (backend === "linuxNamespace") {
    const required = ["--unshare-net", "--unshare-pid", "--die-with-parent"];
    if (!required.every((argument) => args.includes(argument)) || args.includes("--as-pid-1")) {
      throw new StrictDebugCapsulePlanError();
    }
    return "bubblewrapPid1Reaper";
  }
  if (
    !args.includes("--init") ||
    !args.includes("--network=none") ||
    !args.includes("--pull=never")
  ) {
    throw new StrictDebugCapsulePlanError();
  }
  return "ociInit";
}

function buildForBackend(
  input: StrictDebugCapsuleInput,
  backend: SandboxBackend,
): StrictDebugCapsulePlan {
  switch (backend) {
    case "bubblewrap":
      return bubblewrapPlan(
        input,
        backendExecutable(input, backend),
        backendExecutableDigest(input, backend),
      );
    case "container-docker":
    case "container-podman":
      return containerPlan(
        input,
        backend,
        backendExecutable(input, backend),
        backendExecutableDigest(input, backend),
      );
    default:
      throw new StrictDebugCapsulePlanError();
  }
}

export function planStrictDebugCapsule(input: StrictDebugCapsuleInput): StrictDebugCapsulePlan {
  assertQualifiedInput(input);
  // Stryker disable next-line StringLiteral: changing this typed selector literal can only choose
  // an unsupported backend that reaches the same fail-closed error; no plan can be emitted.
  const backend = selectEnforcingBackend(input.platform, input.availability, "execution-root");
  return buildForBackend(input, backend);
}

export {
  assertImmutableMounts as __assertImmutableMounts,
  assertMountDestinations as __assertMountDestinations,
  assertQualifiedPaths as __assertQualifiedPaths,
  backendExecutable as __backendExecutable,
  backendExecutableDigest as __backendExecutableDigest,
  buildForBackend as __buildForBackend,
  deriveInitMechanism as __deriveInitMechanism,
  pathContains as __pathContains,
};
