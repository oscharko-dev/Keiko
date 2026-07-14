import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { BackendAvailability } from "@oscharko-dev/keiko-sandbox";
import { isWithinWorkspace, type WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import type { DebugCapsuleLayer2Input } from "./debugCapsulePlan.js";
import type { DebugWorkspaceIdentity } from "./debugCapsulePlan.js";
import type { DebugSpawnEnvelope } from "./debugCapsulePlan.js";
import type { DebugLaunchCatalogDeps } from "./debugLaunchCatalog.js";
import { deriveCatalogDebugTarget, deriveFileDebugTarget } from "./debugLaunchCatalog.js";
import {
  type ApprovedDebugArtifact,
  type DebugLaunchRuntimeContext,
  type DebugRuntimeMountInspection,
} from "./debugLaunchPlan.js";

const CAPSULE_RUNTIME_ROOT = "/run/keiko-debug";
const SOCKET_NAME = "dap.sock";
const NPM_USER_CONFIG_PATH = "/opt/keiko-debug/npm-user-config";
const NPM_GLOBAL_CONFIG_PATH = "/opt/keiko-debug/npm-global-config";

function currentUid(): number {
  if (process.getuid === undefined) throw new Error("INVALID_DEBUG_RUNTIME");
  return process.getuid();
}

export interface DebugProvisionedArtifact {
  readonly hostPath: string;
  readonly approvedRoot: string;
  readonly capsulePath: string;
}

export interface DebugBackendQualificationInput {
  readonly backend: DebugProvisionedArtifact;
  readonly platform?: NodeJS.Platform | undefined;
}

export interface QualifiedDebugBackend {
  readonly platform: NodeJS.Platform;
  readonly availability: BackendAvailability;
  readonly backendExecutable: ApprovedDebugArtifact;
}

export interface DebugLaunchContextResolverDeps {
  readonly workspaceRoot: string;
  readonly workspaceTrusted: boolean;
  readonly projectId: string;
  readonly fs: WorkspaceFs;
  readonly discover: DebugLaunchCatalogDeps["discover"];
  readonly adapterApprovedRoot: string;
  readonly node: DebugProvisionedArtifact;
  readonly npm: DebugProvisionedArtifact;
  readonly shell: DebugProvisionedArtifact;
  readonly npmUserConfig: DebugProvisionedArtifact;
  readonly npmGlobalConfig: DebugProvisionedArtifact;
  readonly backend: DebugProvisionedArtifact;
  readonly backendQualification: QualifiedDebugBackend;
  readonly runtimeClosure: readonly DebugProvisionedArtifact[];
  readonly platform?: NodeJS.Platform | undefined;
  readonly containerImage?: string | undefined;
  readonly layer1Allowed: (executable: string, args: readonly string[]) => boolean;
}

function inspectArtifact(artifact: DebugProvisionedArtifact): ApprovedDebugArtifact {
  const supplied = lstatSync(artifact.hostPath);
  const realPath = realpathSync(artifact.hostPath);
  const approvedRoot = realpathSync(artifact.approvedRoot);
  const stat = lstatSync(realPath);
  if (
    supplied.isSymbolicLink() ||
    realPath === approvedRoot ||
    !isWithinWorkspace(approvedRoot, realPath) ||
    !stat.isFile()
  ) {
    throw new Error("INVALID_DEBUG_ARTIFACT");
  }
  return Object.freeze({
    hostPath: artifact.hostPath,
    realPath,
    approvedRoot,
    capsulePath: artifact.capsulePath,
    identityDigest: createHash("sha256").update(readFileSync(realPath)).digest("hex"),
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mode: stat.mode,
    ownerUid: stat.uid,
  });
}

function inspectProvisioned(artifact: DebugProvisionedArtifact): readonly ApprovedDebugArtifact[] {
  const supplied = lstatSync(artifact.hostPath);
  if (supplied.isSymbolicLink()) throw new Error("INVALID_DEBUG_ARTIFACT");
  const realPath = realpathSync(artifact.hostPath);
  const stat = lstatSync(realPath);
  if (stat.isFile()) return [inspectArtifact(artifact)];
  if (!stat.isDirectory()) throw new Error("INVALID_DEBUG_ARTIFACT");
  return readdirSync(realPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      return inspectProvisioned({
        hostPath: join(realPath, entry.name),
        approvedRoot: artifact.approvedRoot,
        capsulePath: join(artifact.capsulePath, entry.name),
      });
    });
}

function inspectEmptyNpmConfig(
  artifact: DebugProvisionedArtifact,
  capsulePath: string,
): ApprovedDebugArtifact {
  if (artifact.capsulePath !== capsulePath) throw new Error("INVALID_DEBUG_ARTIFACT");
  const inspected = inspectArtifact(artifact);
  if (inspected.size !== 0) throw new Error("INVALID_DEBUG_ARTIFACT");
  return inspected;
}

function runtimeDirectory(
  workspaceRoot: string,
  runtimeRootInput: string,
  runtimeDirectoryInput: string,
): { readonly root: string; readonly directory: string } {
  const root = realpathSync(runtimeRootInput);
  const directory = realpathSync(runtimeDirectoryInput);
  const rootStat = lstatSync(runtimeRootInput);
  const directoryStat = lstatSync(runtimeDirectoryInput);
  const owner = currentUid();
  const qualifiedDirectories = [rootStat, directoryStat].every(
    (stat) => stat.isDirectory() && (stat.mode & 0o777) === 0o700 && stat.uid === owner,
  );
  const strictChild = directory !== root && isWithinWorkspace(root, directory);
  const workspaceDisjoint = [root, directory].every(
    (path) => !isWithinWorkspace(workspaceRoot, path) && !isWithinWorkspace(path, workspaceRoot),
  );
  if (!qualifiedDirectories || !strictChild || !workspaceDisjoint) {
    throw new Error("INVALID_DEBUG_RUNTIME");
  }
  return { root, directory };
}

function assertRuntimeLayout(input: DebugCapsuleLayer2Input, runtimeDirectory: string): void {
  const suppliedHome = lstatSync(input.adapter.home);
  const home = realpathSync(input.adapter.home);
  const temp = realpathSync(join(runtimeDirectory, "tmp"));
  const valid =
    !suppliedHome.isSymbolicLink() &&
    home === join(runtimeDirectory, "home") &&
    temp === join(runtimeDirectory, "tmp") &&
    [home, temp].every((path) => {
      const stat = lstatSync(path);
      return stat.isDirectory() && (stat.mode & 0o777) === 0o700;
    });
  if (!valid) throw new Error("INVALID_DEBUG_RUNTIME");
}

function strictBubblewrapProbe(backend: ApprovedDebugArtifact, runtime: string): boolean {
  const marker = join(runtime, ".qualification-probe");
  rmSync(marker, { force: true });
  const result = spawnSync(
    backend.realPath,
    [
      "--unshare-net",
      "--unshare-pid",
      "--die-with-parent",
      "--new-session",
      "--dir",
      "/run",
      "--dir",
      CAPSULE_RUNTIME_ROOT,
      "--dir",
      "/usr",
      "--ro-bind",
      "/usr",
      "/usr",
      "--dir",
      "/bin",
      "--ro-bind",
      "/bin",
      "/bin",
      "--dir",
      "/lib",
      "--ro-bind",
      "/lib",
      "/lib",
      "--bind",
      runtime,
      CAPSULE_RUNTIME_ROOT,
      "--",
      "/bin/sh",
      "-c",
      `printf qualified > ${CAPSULE_RUNTIME_ROOT}/.qualification-probe`,
    ],
    { env: {}, timeout: 5_000 },
  );
  const qualified = result.status === 0 && existsSync(marker);
  rmSync(marker, { force: true });
  return qualified;
}

function privateQualificationRuntime(): string {
  const supplied = mkdtempSync(join(tmpdir(), "keiko-dap-qualification-"));
  try {
    chmodSync(supplied, 0o700);
    const runtime = realpathSync(supplied);
    const stat = lstatSync(runtime);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== currentUid()) {
      throw new Error("INVALID_DEBUG_RUNTIME");
    }
    return runtime;
  } catch (error: unknown) {
    // Stryker disable next-line BooleanLiteral: supplied was created successfully in this synchronous
    // function and recursive removal has identical behavior with either force value while it exists.
    rmSync(supplied, { recursive: true, force: true });
    throw error;
  }
}

function probeBackend(
  backend: ApprovedDebugArtifact,
  platform: NodeJS.Platform,
  runtime: string,
): BackendAvailability {
  const result = spawnSync(backend.realPath, ["--version"], {
    env: {},
    timeout: 5_000,
  });
  if (result.status !== 0) throw new Error("INVALID_DEBUG_BACKEND");
  const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8").trim();
  const name = basename(backend.realPath);
  const bubblewrap =
    platform === "linux" &&
    name === "bwrap" &&
    /^bubblewrap\s+\d+(?:\.\d+)+$/iu.test(output) &&
    strictBubblewrapProbe(backend, runtime);
  if (name === "bwrap" && !bubblewrap) throw new Error("INVALID_DEBUG_BACKEND");
  return Object.freeze({
    bubblewrap,
    unshare: false,
    seatbelt: false,
    docker: false,
    podman: false,
  });
}

export function qualifyProductionDebugBackend(
  input: DebugBackendQualificationInput,
): QualifiedDebugBackend {
  const platform = input.platform ?? process.platform;
  const backendExecutable = inspectArtifact(input.backend);
  if (platform !== "linux" || basename(backendExecutable.realPath) !== "bwrap") {
    throw new Error("INVALID_DEBUG_BACKEND");
  }
  const runtime = privateQualificationRuntime();
  try {
    const availability = probeBackend(backendExecutable, platform, runtime);
    // Stryker disable next-line ConditionalExpression,BlockStatement,StringLiteral: probeBackend
    // already throws INVALID_DEBUG_BACKEND for the only supported bwrap identity when this flag is
    // false; this retained assertion documents the production qualification invariant.
    if (!availability.bubblewrap) throw new Error("INVALID_DEBUG_BACKEND");
    return Object.freeze({ platform, availability, backendExecutable });
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
}

function inspectRuntime(path: string): DebugRuntimeMountInspection {
  const real = realpathSync(path);
  const stat = lstatSync(path);
  // Stryker disable next-line ConditionalExpression,LogicalOperator: runtimeDirectory validates
  // the same directory type, mode, and owner synchronously without an intervening await. This
  // repeated final-mount assertion is intentionally retained as defense in depth.
  const valid = stat.isDirectory() && (stat.mode & 0o777) === 0o700 && stat.uid === currentUid();
  if (!valid) throw new Error("INVALID_DEBUG_RUNTIME");
  const identityDigest = createHash("sha256")
    .update(JSON.stringify([real, stat.dev, stat.ino, stat.mode, stat.uid]))
    .digest("hex");
  return Object.freeze({
    hostRealPath: real,
    mode: "0700",
    owner: "currentUser",
    symlink: false,
    identityDigest,
    device: stat.dev,
    inode: stat.ino,
    modeBits: stat.mode,
    ownerUid: stat.uid,
  });
}

export function inspectDebugWorkspaceIdentity(path: string): DebugWorkspaceIdentity {
  const realPath = realpathSync(path);
  const stat = lstatSync(realPath);
  if (!stat.isDirectory()) throw new Error("INVALID_DEBUG_WORKSPACE");
  const values = [realPath, stat.dev, stat.ino, stat.mode, stat.uid];
  return Object.freeze({
    realPath,
    identityDigest: createHash("sha256").update(JSON.stringify(values)).digest("hex"),
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    ownerUid: stat.uid,
  });
}

function workspaceIdentityMatches(
  expected: DebugWorkspaceIdentity,
  observed: DebugWorkspaceIdentity,
): boolean {
  return (
    observed.realPath === expected.realPath &&
    observed.device === expected.device &&
    observed.inode === expected.inode &&
    observed.mode === expected.mode &&
    observed.ownerUid === expected.ownerUid &&
    observed.identityDigest === expected.identityDigest
  );
}

function adapterArtifact(
  input: DebugCapsuleLayer2Input,
  approvedRoot: string,
): ApprovedDebugArtifact {
  return inspectArtifact({
    hostPath: input.adapter.executable,
    approvedRoot,
    capsulePath: "/opt/keiko-debug/adapter",
  });
}

function artifactIdentityMatches(
  expected: ApprovedDebugArtifact,
  observed: ApprovedDebugArtifact,
): boolean {
  return (
    expected.realPath === observed.realPath &&
    expected.approvedRoot === observed.approvedRoot &&
    expected.capsulePath === observed.capsulePath &&
    expected.identityDigest === observed.identityDigest &&
    expected.device === observed.device &&
    expected.inode === observed.inode &&
    expected.size === observed.size &&
    expected.mode === observed.mode &&
    expected.ownerUid === observed.ownerUid
  );
}

function qualifiedBackend(deps: DebugLaunchContextResolverDeps): ApprovedDebugArtifact {
  const platform = deps.platform ?? process.platform;
  const observed = inspectArtifact(deps.backend);
  const qualification = deps.backendQualification;
  if (
    qualification.platform !== platform ||
    !qualification.availability.bubblewrap ||
    !artifactIdentityMatches(qualification.backendExecutable, observed)
  ) {
    throw new Error("INVALID_DEBUG_BACKEND");
  }
  return observed;
}

export function createProductionDebugLaunchContextResolver(
  deps: DebugLaunchContextResolverDeps,
): (input: DebugCapsuleLayer2Input) => Promise<DebugLaunchRuntimeContext> {
  return async (input): Promise<DebugLaunchRuntimeContext> => {
    await Promise.resolve();
    const workspaceRoot = realpathSync(deps.workspaceRoot);
    const runtime = runtimeDirectory(workspaceRoot, input.adapter.runtimeRoot, input.adapter.temp);
    const runtimeRoot = runtime.root;
    const hostRuntimeDirectory = runtime.directory;
    assertRuntimeLayout(input, hostRuntimeDirectory);
    const hostSocketPath = join(hostRuntimeDirectory, SOCKET_NAME);
    const capsuleSocketPath = `${CAPSULE_RUNTIME_ROOT}/${SOCKET_NAME}`;
    const backend = qualifiedBackend(deps);
    return Object.freeze({
      workspaceRoot: deps.workspaceRoot,
      canonicalWorkspaceRoot: workspaceRoot,
      workspaceIdentity: inspectDebugWorkspaceIdentity(workspaceRoot),
      workspaceTrusted: deps.workspaceTrusted,
      projectId: deps.projectId,
      fs: deps.fs,
      discover: deps.discover,
      platform: deps.platform ?? process.platform,
      availability: deps.backendQualification.availability,
      hostRuntimeDirectory,
      runtimeRoot,
      hostSocketPath,
      capsuleRuntimeDirectory: CAPSULE_RUNTIME_ROOT,
      capsuleSocketPath,
      runtimeMount: inspectRuntime(hostRuntimeDirectory),
      adapter: adapterArtifact(input, deps.adapterApprovedRoot),
      node: inspectArtifact(deps.node),
      npm: inspectArtifact(deps.npm),
      shell: inspectArtifact(deps.shell),
      npmUserConfig: inspectEmptyNpmConfig(deps.npmUserConfig, NPM_USER_CONFIG_PATH),
      npmGlobalConfig: inspectEmptyNpmConfig(deps.npmGlobalConfig, NPM_GLOBAL_CONFIG_PATH),
      backendExecutable: backend,
      runtimeClosure: Object.freeze(deps.runtimeClosure.flatMap(inspectProvisioned)),
      environment: Object.freeze({ ...input.adapter.env }),
      layer1Allowed: deps.layer1Allowed,
      containerImage: deps.containerImage,
    });
  };
}

export function createProductionDebugTargetRevalidator(
  deps: DebugLaunchCatalogDeps,
): (envelope: DebugSpawnEnvelope) => boolean {
  return (envelope): boolean => {
    try {
      const workspaceBefore = inspectDebugWorkspaceIdentity(deps.workspaceRoot);
      if (!workspaceIdentityMatches(envelope.workspaceIdentity, workspaceBefore)) return false;
      const verifiedDeps = Object.freeze({ ...deps, workspaceRoot: workspaceBefore.realPath });
      const reference = envelope.targetReference;
      const target =
        reference.kind === "catalog"
          ? deriveCatalogDebugTarget(reference.targetId, verifiedDeps)
          : deriveFileDebugTarget(reference.fileId, verifiedDeps);
      const workspaceAfter = inspectDebugWorkspaceIdentity(deps.workspaceRoot);
      return (
        workspaceIdentityMatches(envelope.workspaceIdentity, workspaceAfter) &&
        target.targetIdentityDigest === envelope.targetIdentityDigest
      );
    } catch {
      return false;
    }
  };
}
