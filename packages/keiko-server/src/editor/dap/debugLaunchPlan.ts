import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, normalize } from "node:path";
import {
  planStrictDebugCapsule,
  type BackendAvailability,
  type DebugCapsuleImmutableMount,
  type StrictDebugCapsuleInput,
} from "@oscharko-dev/keiko-sandbox";
import { validateDebugLaunchPolicy, type ClosedDebugExecution } from "@oscharko-dev/keiko-tools";
import { isWithinWorkspace, type WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import {
  type DebugCapsuleLayer2Input,
  type DebugCapsuleLayer2Validator,
  type ClosedDebugLaunchRequest,
  type ClosedCatalogDebugLaunchArguments,
  type ClosedFileDebugLaunchArguments,
  DebugCapsulePlanError,
  type Layer2DebugCapsulePlan,
  type DebugSpawnArtifactIdentity,
  type DebugSpawnEnvelope,
  type DebugRuntimeDirectoryIdentity,
  type DebugWorkspaceIdentity,
  deriveCanonicalDebugProvisioningDigest,
} from "./debugCapsulePlan.js";
import {
  deriveCatalogDebugTarget,
  deriveFileDebugTarget,
  type DebugLaunchCatalogDeps,
  type DebugLaunchTarget,
} from "./debugLaunchCatalog.js";
import { isSafeDapSocketBasename, isSha256Digest } from "./debugLaunchSecurityPredicates.js";

const CAPSULE_ROOT = "/keiko-execution-root" as const;
const CAPSULE_RUNTIME_ROOT = "/run/keiko-debug" as const;
const NPM_USER_CONFIG_PATH = "/opt/keiko-debug/npm-user-config" as const;
const NPM_GLOBAL_CONFIG_PATH = "/opt/keiko-debug/npm-global-config" as const;
const PLAN_TTL_MS = 30_000;

export interface ApprovedDebugArtifact {
  readonly hostPath: string;
  readonly realPath: string;
  readonly approvedRoot: string;
  readonly capsulePath: string;
  readonly identityDigest: string;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly mode: number;
  readonly ownerUid: number;
}

export interface DebugRuntimeMountInspection {
  readonly hostRealPath: string;
  readonly mode: "0700";
  readonly owner: "currentUser";
  readonly symlink: false;
  readonly identityDigest: string;
  readonly device: number;
  readonly inode: number;
  readonly modeBits: number;
  readonly ownerUid: number;
}

export interface DebugLaunchRuntimeContext {
  readonly workspaceRoot: string;
  readonly canonicalWorkspaceRoot: string;
  readonly workspaceIdentity: DebugWorkspaceIdentity;
  readonly workspaceTrusted: boolean;
  readonly projectId: string;
  readonly fs: WorkspaceFs;
  readonly discover: DebugLaunchCatalogDeps["discover"];
  readonly platform: NodeJS.Platform;
  readonly availability: BackendAvailability;
  readonly hostRuntimeDirectory: string;
  readonly runtimeRoot: string;
  readonly hostSocketPath: string;
  readonly capsuleRuntimeDirectory: string;
  readonly capsuleSocketPath: string;
  readonly runtimeMount: DebugRuntimeMountInspection;
  readonly adapter: ApprovedDebugArtifact;
  readonly node: ApprovedDebugArtifact;
  readonly npm: ApprovedDebugArtifact;
  readonly shell: ApprovedDebugArtifact;
  readonly npmUserConfig: ApprovedDebugArtifact;
  readonly npmGlobalConfig: ApprovedDebugArtifact;
  readonly runtimeClosure: readonly ApprovedDebugArtifact[];
  readonly backendExecutable: ApprovedDebugArtifact;
  readonly environment: Readonly<Record<string, string>>;
  readonly layer1Allowed: (executable: string, args: readonly string[]) => boolean;
  readonly containerImage?: string | undefined;
}

export interface DebugLaunchPlanDeps {
  readonly resolveContext: (input: DebugCapsuleLayer2Input) => Promise<DebugLaunchRuntimeContext>;
  readonly now: () => number;
  readonly epoch: () => number;
  readonly planCapsule?: typeof planStrictDebugCapsule | undefined;
}

type OpaqueTarget =
  | { readonly kind: "catalog"; readonly targetId: string }
  | { readonly kind: "file"; readonly fileId: string };

/** @internal Security-boundary helper exposed for direct mutation verification. */
export function debugOwnTargetData(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) throw new DebugCapsulePlanError();
  if (!("value" in descriptor)) throw new DebugCapsulePlanError();
  return descriptor.value;
}

/** @internal Security-boundary helper exposed for direct mutation verification. */
export function assertDebugTargetCandidate(candidate: unknown): asserts candidate is object {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
    throw new DebugCapsulePlanError();
  const prototype = Object.getPrototypeOf(candidate) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new DebugCapsulePlanError();
}

/** @internal Security-boundary helper exposed for direct mutation verification. */
export function parseDebugCatalogTarget(
  candidate: object,
  keys: string[],
  kind: unknown,
): OpaqueTarget | undefined {
  if (kind !== "catalog" || keys.join(",") !== "kind,targetId") return undefined;
  const targetId = debugOwnTargetData(candidate, "targetId");
  return typeof targetId === "string" ? { kind, targetId } : undefined;
}

/** @internal Security-boundary helper exposed for direct mutation verification. */
export function parseDebugFileTarget(
  candidate: object,
  keys: string[],
  kind: unknown,
): OpaqueTarget | undefined {
  if (kind !== "file" || keys.join(",") !== "fileId,kind") return undefined;
  const fileId = debugOwnTargetData(candidate, "fileId");
  return typeof fileId === "string" ? { kind, fileId } : undefined;
}

/** @internal Opaque target parser exposed for direct mutation verification. */
export function parseOpaqueDebugTarget(candidate: unknown): OpaqueTarget {
  assertDebugTargetCandidate(candidate);
  const keys = Object.keys(candidate).sort();
  const kind = debugOwnTargetData(candidate, "kind");
  const parsed =
    parseDebugCatalogTarget(candidate, keys, kind) ?? parseDebugFileTarget(candidate, keys, kind);
  if (parsed !== undefined) return parsed;
  throw new DebugCapsulePlanError();
}

function validateArtifact(
  artifact: ApprovedDebugArtifact,
  expectedCapsulePath: string,
  workspaceRoot: string,
): void {
  const root = realpathSync(artifact.approvedRoot);
  const real = realpathSync(artifact.hostPath);
  const stat = lstatSync(real);
  const digest = createHash("sha256").update(readFileSync(real)).digest("hex");
  const pathsValid =
    isAbsolute(artifact.hostPath) &&
    real === artifact.realPath &&
    artifact.capsulePath === expectedCapsulePath &&
    isWithinWorkspace(root, real) &&
    !isWithinWorkspace(workspaceRoot, artifact.realPath);
  const identityValid =
    digest === artifact.identityDigest &&
    stat.isFile() &&
    [stat.dev, stat.ino, stat.size, stat.mode, stat.uid].every(
      (value, index) =>
        value ===
        [artifact.device, artifact.inode, artifact.size, artifact.mode, artifact.ownerUid][index],
    );
  if (!pathsValid || !identityValid) throw new DebugCapsulePlanError();
}

/** @internal Exact path-overlap predicate used by strict boundary tests. */
export function debugPathsOverlap(first: string, second: string): boolean {
  const left = normalize(first);
  const right = normalize(second);
  return isWithinWorkspace(left, right) || isWithinWorkspace(right, left);
}

/** @internal Exact runtime-location predicate used by strict boundary tests. */
export function isDebugRuntimeLocationValid(
  context: DebugLaunchRuntimeContext,
  runtimeRoot: string,
  runtime: string,
): boolean {
  return (
    runtime === context.runtimeMount.hostRealPath &&
    isWithinWorkspace(runtimeRoot, runtime) &&
    !debugPathsOverlap(runtime, context.workspaceRoot) &&
    !debugPathsOverlap(runtime, context.canonicalWorkspaceRoot)
  );
}

/** @internal Exact runtime-stat predicate used by strict boundary tests. */
export function isDebugRuntimeStatValid(stat: Stats): boolean {
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) return false;
  const getuid = process.getuid;
  return getuid !== undefined && stat.uid === getuid();
}

function runtimeIdentityValid(
  context: DebugLaunchRuntimeContext,
  runtime: string,
  stat: Stats,
): boolean {
  return (
    context.runtimeMount.device === stat.dev &&
    context.runtimeMount.inode === stat.ino &&
    context.runtimeMount.modeBits === stat.mode &&
    context.runtimeMount.ownerUid === stat.uid &&
    context.runtimeMount.identityDigest === hash([runtime, stat.dev, stat.ino, stat.mode, stat.uid])
  );
}

function validateRuntimeDirectory(context: DebugLaunchRuntimeContext): void {
  const runtimeRoot = realpathSync(context.runtimeRoot);
  const runtime = realpathSync(context.hostRuntimeDirectory);
  const stat = lstatSync(context.hostRuntimeDirectory);
  if (
    !isDebugRuntimeLocationValid(context, runtimeRoot, runtime) ||
    !isDebugRuntimeStatValid(stat) ||
    !runtimeIdentityValid(context, runtime, stat)
  )
    throw new DebugCapsulePlanError();
}

function validateEndpoint(context: DebugLaunchRuntimeContext): void {
  const mount = context.runtimeMount;
  const hostContained = dirname(context.hostSocketPath) === context.hostRuntimeDirectory;
  const capsuleContained = dirname(context.capsuleSocketPath) === CAPSULE_RUNTIME_ROOT;
  const safeNames =
    isSafeDapSocketBasename(basename(context.hostSocketPath)) &&
    isSafeDapSocketBasename(basename(context.capsuleSocketPath));
  const lengths =
    Buffer.byteLength(context.hostSocketPath) <= 100 &&
    Buffer.byteLength(context.capsuleSocketPath) <= 100;
  const runtimeMount = mount as unknown as Readonly<Record<string, unknown>>;
  const validMount =
    runtimeMount.mode === "0700" &&
    runtimeMount.owner === "currentUser" &&
    runtimeMount.symlink === false &&
    isSha256Digest(mount.identityDigest);
  if (![hostContained, capsuleContained, safeNames, lengths, validMount].every(Boolean))
    throw new DebugCapsulePlanError();
  if (context.capsuleRuntimeDirectory !== CAPSULE_RUNTIME_ROOT) throw new DebugCapsulePlanError();
  validateRuntimeDirectory(context);
}

function validateWorkspaceIdentity(context: DebugLaunchRuntimeContext): void {
  const workspaceStat = lstatSync(context.canonicalWorkspaceRoot);
  const workspaceIdentity = context.workspaceIdentity;
  const observed = [workspaceStat.dev, workspaceStat.ino, workspaceStat.mode, workspaceStat.uid];
  const expected = [
    workspaceIdentity.device,
    workspaceIdentity.inode,
    workspaceIdentity.mode,
    workspaceIdentity.ownerUid,
  ];
  const valid =
    !context.workspaceTrusted ||
    context.fs.realPath(context.workspaceRoot) !== context.canonicalWorkspaceRoot ||
    workspaceIdentity.realPath !== context.canonicalWorkspaceRoot ||
    observed.some((value, index) => value !== expected[index]) ||
    workspaceIdentity.identityDigest !==
      hash([
        workspaceIdentity.realPath,
        workspaceStat.dev,
        workspaceStat.ino,
        workspaceStat.mode,
        workspaceStat.uid,
      ]);
  if (valid) throw new DebugCapsulePlanError();
}

function validateArtifacts(context: DebugLaunchRuntimeContext): void {
  if (context.platform === "win32") throw new DebugCapsulePlanError();
  validateArtifact(context.adapter, "/opt/keiko-debug/adapter", context.workspaceRoot);
  validateArtifact(context.node, "/opt/keiko-runtime/node", context.workspaceRoot);
  validateArtifact(context.npm, "/opt/keiko-runtime/npm", context.workspaceRoot);
  validateArtifact(context.shell, "/opt/keiko-runtime/shell", context.workspaceRoot);
  validateArtifact(context.npmUserConfig, NPM_USER_CONFIG_PATH, context.workspaceRoot);
  validateArtifact(context.npmGlobalConfig, NPM_GLOBAL_CONFIG_PATH, context.workspaceRoot);
  if (
    context.npmUserConfig.size !== 0 ||
    context.npmGlobalConfig.size !== 0 ||
    context.npmUserConfig.realPath === context.npmGlobalConfig.realPath
  )
    throw new DebugCapsulePlanError();
  validateArtifact(
    context.backendExecutable,
    context.backendExecutable.capsulePath,
    context.workspaceRoot,
  );
  for (const artifact of context.runtimeClosure) {
    validateArtifact(artifact, artifact.capsulePath, context.workspaceRoot);
  }
}

function validateAdapterBinding(
  input: DebugCapsuleLayer2Input,
  context: DebugLaunchRuntimeContext,
): void {
  const bindingValid =
    input.adapter.providerId.length === 0 ||
    input.adapter.executable !== context.adapter.hostPath ||
    input.adapter.temp !== context.hostRuntimeDirectory ||
    !sameRecord(input.adapter.env, context.environment);
  const argumentsValid =
    input.adapter.args.length !== 2 ||
    input.adapter.args[0] !== "--server" ||
    input.adapter.args[1] !== context.capsuleSocketPath;
  if (bindingValid || argumentsValid) throw new DebugCapsulePlanError();
}

/** @internal Direct security-boundary entry point used by strict mutation tests. */
export function validateDebugLaunchContext(
  input: DebugCapsuleLayer2Input,
  context: DebugLaunchRuntimeContext,
): void {
  validateWorkspaceIdentity(context);
  validateArtifacts(context);
  validateAdapterBinding(input, context);
  validateEndpoint(context);
}

function sameRecord(
  first: Readonly<Record<string, string>>,
  second: Readonly<Record<string, string>>,
): boolean {
  const firstKeys = Object.keys(first).sort();
  const secondKeys = Object.keys(second).sort();
  return (
    firstKeys.length === secondKeys.length &&
    firstKeys.every((key, index) => key === secondKeys[index] && first[key] === second[key])
  );
}

function catalogDeps(context: DebugLaunchRuntimeContext): DebugLaunchCatalogDeps {
  return {
    discover: context.discover,
    fs: context.fs,
    workspaceRoot: context.workspaceRoot,
    projectId: context.projectId,
    workspaceTrusted: context.workspaceTrusted,
  };
}

function deriveTarget(
  candidate: OpaqueTarget,
  context: DebugLaunchRuntimeContext,
): DebugLaunchTarget {
  return candidate.kind === "catalog"
    ? deriveCatalogDebugTarget(candidate.targetId, catalogDeps(context))
    : deriveFileDebugTarget(candidate.fileId, catalogDeps(context));
}

function executionFor(
  target: DebugLaunchTarget,
  context: DebugLaunchRuntimeContext,
): ClosedDebugExecution {
  if (target.kind === "file") {
    return {
      kind: "file",
      executable: context.node.capsulePath,
      args: [target.capsulePath],
      target: target.capsulePath,
      cwd: CAPSULE_ROOT,
      env: context.environment,
    };
  }
  return {
    // Stryker disable next-line StringLiteral: compile-time discriminant; execution and wire output
    // are independently fixed and changing this literal does not change the resulting closed plan.
    kind: "catalog",
    executable: context.npm.capsulePath,
    args: [
      "--ignore-scripts",
      `--script-shell=${context.shell.capsulePath}`,
      `--userconfig=${context.npmUserConfig.capsulePath}`,
      `--globalconfig=${context.npmGlobalConfig.capsulePath}`,
      "--location=global",
      "run",
      target.scriptName,
    ],
    scriptName: target.scriptName,
    shell: context.shell.capsulePath,
    cwd: CAPSULE_ROOT,
    env: context.environment,
  };
}

/** @internal Direct environment-boundary entry point used by strict mutation tests. */
export function assertDebugLaunchEnvironment(context: DebugLaunchRuntimeContext): void {
  const allowed = new Set([
    "HOME",
    "USERPROFILE",
    "PATH",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
  ]);
  if (Object.keys(context.environment).some((key) => !allowed.has(key)))
    throw new DebugCapsulePlanError();
  const home = context.environment.HOME;
  const temp = context.environment.TMPDIR;
  if (
    context.environment.PATH !== "/opt/keiko-runtime" ||
    home === undefined ||
    temp === undefined ||
    context.environment.USERPROFILE !== home ||
    context.environment.TEMP !== temp ||
    context.environment.TMP !== temp
  )
    throw new DebugCapsulePlanError();
}

function launchRequest(
  execution: ClosedDebugExecution,
  context: DebugLaunchRuntimeContext,
): ClosedDebugLaunchRequest {
  if (execution.kind === "file") {
    const args: readonly [] = Object.freeze([]);
    const argumentsValue: ClosedFileDebugLaunchArguments = Object.freeze({
      request: "launch",
      runtimeExecutable: execution.executable,
      program: execution.target,
      args,
      cwd: CAPSULE_ROOT,
      console: "internalConsole",
    });
    return Object.freeze({
      command: "launch",
      arguments: argumentsValue,
    });
  }
  const runtimeArgs: ClosedCatalogDebugLaunchArguments["runtimeArgs"] = Object.freeze([
    "--ignore-scripts",
    `--script-shell=${execution.shell}`,
    `--userconfig=${context.npmUserConfig.capsulePath}`,
    `--globalconfig=${context.npmGlobalConfig.capsulePath}`,
    "--location=global",
    "run",
    execution.scriptName,
  ]);
  const argumentsValue: ClosedCatalogDebugLaunchArguments = Object.freeze({
    request: "launch",
    runtimeExecutable: execution.executable,
    runtimeArgs,
    cwd: CAPSULE_ROOT,
    console: "internalConsole",
  });
  return Object.freeze({
    command: "launch",
    arguments: argumentsValue,
  });
}

function immutableMounts(
  context: DebugLaunchRuntimeContext,
): readonly DebugCapsuleImmutableMount[] {
  return [
    context.adapter,
    context.node,
    context.npm,
    context.shell,
    context.npmUserConfig,
    context.npmGlobalConfig,
    ...context.runtimeClosure,
  ].map((artifact) => ({
    hostPath: artifact.realPath,
    capsulePath: artifact.capsulePath,
    identityDigest: artifact.identityDigest,
  }));
}

function provisioningArtifacts(
  context: DebugLaunchRuntimeContext,
): readonly ApprovedDebugArtifact[] {
  return [
    context.adapter,
    context.node,
    context.npm,
    context.shell,
    context.backendExecutable,
    context.npmUserConfig,
    context.npmGlobalConfig,
    ...context.runtimeClosure,
  ];
}

export function deriveDebugProvisioningDigest(context: DebugLaunchRuntimeContext): string {
  return deriveCanonicalDebugProvisioningDigest(
    provisioningArtifacts(context).map(artifactIdentity),
  );
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** @internal Derives the exact closed input passed to the enforcing capsule planner. */
export function deriveStrictDebugCapsuleInput(
  input: DebugCapsuleLayer2Input,
  context: DebugLaunchRuntimeContext,
  runtimeDigest: string,
): StrictDebugCapsuleInput {
  const backendName = basename(context.backendExecutable.realPath);
  const backendExecutables = {
    ...(backendName === "bwrap" ? { bubblewrap: context.backendExecutable.realPath } : {}),
    ...(backendName === "docker" ? { docker: context.backendExecutable.realPath } : {}),
    ...(backendName === "podman" ? { podman: context.backendExecutable.realPath } : {}),
  };
  const backendExecutableIdentityDigests = {
    ...(backendName === "bwrap" ? { bubblewrap: context.backendExecutable.identityDigest } : {}),
    ...(backendName === "docker" ? { docker: context.backendExecutable.identityDigest } : {}),
    ...(backendName === "podman" ? { podman: context.backendExecutable.identityDigest } : {}),
  };
  return {
    platform: context.platform,
    availability: context.availability,
    executionRoot: context.canonicalWorkspaceRoot,
    executionRootIdentityDigest: context.workspaceIdentity.identityDigest,
    runtimeHostDirectory: context.hostRuntimeDirectory,
    runtimeCapsuleDirectory: context.capsuleRuntimeDirectory,
    backendExecutables,
    backendExecutableIdentityDigests,
    runtimeMountIdentityDigest: context.runtimeMount.identityDigest,
    runtimeMountQualified: true,
    adapterCapsuleExecutable: context.adapter.capsulePath,
    adapterArgs: Object.freeze([...input.adapter.args]),
    immutableMounts: immutableMounts(context),
    runtimeIdentityDigest: runtimeDigest,
    containerImage: context.containerImage,
  };
}

function artifactIdentity(artifact: ApprovedDebugArtifact): DebugSpawnArtifactIdentity {
  return Object.freeze({
    hostPath: artifact.hostPath,
    realPath: artifact.realPath,
    approvedRootRealPath: realpathSync(artifact.approvedRoot),
    capsulePath: artifact.capsulePath,
    identityDigest: artifact.identityDigest,
    device: artifact.device,
    inode: artifact.inode,
    size: artifact.size,
    mode: artifact.mode,
    ownerUid: artifact.ownerUid,
  });
}

function spawnArtifacts(context: DebugLaunchRuntimeContext): readonly DebugSpawnArtifactIdentity[] {
  return Object.freeze(
    [
      context.backendExecutable,
      context.adapter,
      context.node,
      context.npm,
      context.shell,
      context.npmUserConfig,
      context.npmGlobalConfig,
      ...context.runtimeClosure,
    ].map(artifactIdentity),
  );
}

function spawnEnvelope(
  input: DebugCapsuleLayer2Input,
  candidate: OpaqueTarget,
  context: DebugLaunchRuntimeContext,
  target: DebugLaunchTarget,
  capsule: Layer2DebugCapsulePlan["capsule"],
  endpoint: Layer2DebugCapsulePlan["endpoint"],
  clock: { readonly epoch: number; readonly expiresAtMs: number },
  runtimeIdentityDigest: string,
  provisioningDigest: string,
): DebugSpawnEnvelope {
  const runtimeDirectoryIdentity: DebugRuntimeDirectoryIdentity = Object.freeze({
    realPath: context.runtimeMount.hostRealPath,
    identityDigest: context.runtimeMount.identityDigest,
    device: context.runtimeMount.device,
    inode: context.runtimeMount.inode,
    mode: context.runtimeMount.modeBits,
    ownerUid: context.runtimeMount.ownerUid,
  });
  const values = {
    schemaVersion: "1" as const,
    providerId: input.adapter.providerId,
    backend: capsule.backend,
    provisioningDigest,
    runtimeIdentityDigest,
    runtimeDirectoryIdentity,
    capsuleCommand: context.backendExecutable.realPath,
    capsuleArgs: Object.freeze([...capsule.args]),
    adapterExecutable: context.adapter.capsulePath,
    adapterArgs: Object.freeze([...input.adapter.args]),
    environment: Object.freeze({ ...context.environment }),
    home: input.adapter.home,
    temp: input.adapter.temp,
    cwd: CAPSULE_ROOT,
    endpoint,
    artifacts: spawnArtifacts(context),
    workspaceIdentity: Object.freeze({ ...context.workspaceIdentity }),
    targetIdentityDigest: target.targetIdentityDigest,
    targetReference: Object.freeze({ ...candidate }),
    activationRevision: input.binding.activationRevision,
    ...clock,
  };
  const identityDigest = hash(values);
  return Object.freeze({ ...values, planId: identityDigest, identityDigest });
}

async function validate(
  deps: DebugLaunchPlanDeps,
  input: DebugCapsuleLayer2Input,
): Promise<Layer2DebugCapsulePlan> {
  try {
    return await buildPlan(deps, input);
  } catch {
    throw new DebugCapsulePlanError();
  }
}

async function buildPlan(
  deps: DebugLaunchPlanDeps,
  input: DebugCapsuleLayer2Input,
): Promise<Layer2DebugCapsulePlan> {
  const candidate = parseOpaqueDebugTarget(input.candidate);
  const context = await deps.resolveContext(input);
  validateDebugLaunchContext(input, context);
  const provisioningDigest = deriveDebugProvisioningDigest(context);
  assertDebugLaunchEnvironment(context);
  const target = deriveTarget(candidate, context);
  if (target.kind !== input.binding.targetKind) throw new DebugCapsulePlanError();
  const execution = executionFor(target, context);
  assertExecutionPolicy(execution, context);
  const finalTarget = deriveTarget(candidate, context);
  if (finalTarget.targetIdentityDigest !== target.targetIdentityDigest)
    throw new DebugCapsulePlanError();
  return assemblePlan(deps, input, context, target, execution, candidate, provisioningDigest);
}

function assertExecutionPolicy(
  execution: ClosedDebugExecution,
  context: DebugLaunchRuntimeContext,
): void {
  const policy = {
    nodeExecutable: context.node.capsulePath,
    npmExecutable: context.npm.capsulePath,
    shellExecutable: context.shell.capsulePath,
    npmUserConfig: context.npmUserConfig.capsulePath,
    npmGlobalConfig: context.npmGlobalConfig.capsulePath,
    cwd: CAPSULE_ROOT,
    env: context.environment,
    layer1Allowed: context.layer1Allowed,
  };
  if (!validateDebugLaunchPolicy(execution, policy).allowed) throw new DebugCapsulePlanError();
}

function planClock(
  deps: DebugLaunchPlanDeps,
  activationRevision: number,
): { readonly epoch: number; readonly expiresAtMs: number } {
  const epoch = deps.epoch();
  const now = deps.now();
  const valid =
    Number.isSafeInteger(epoch) &&
    epoch >= 0 &&
    Number.isSafeInteger(now) &&
    Number.isSafeInteger(activationRevision);
  if (!valid) throw new DebugCapsulePlanError();
  const expiresAtMs = now + PLAN_TTL_MS;
  if (!Number.isSafeInteger(expiresAtMs)) throw new DebugCapsulePlanError();
  return { epoch, expiresAtMs };
}

function endpointPlan(context: DebugLaunchRuntimeContext): Layer2DebugCapsulePlan["endpoint"] {
  return Object.freeze({
    kind: "posixSocket" as const,
    hostRuntimeDirectory: context.hostRuntimeDirectory,
    hostSocketPath: context.hostSocketPath,
    capsuleRuntimeDirectory: context.capsuleRuntimeDirectory,
    capsuleSocketPath: context.capsuleSocketPath,
    runtimeIdentity: context.runtimeMount.identityDigest,
  });
}

function assertCapsuleBackend(
  context: DebugLaunchRuntimeContext,
  capsule: Layer2DebugCapsulePlan["capsule"],
): void {
  validateArtifact(
    context.backendExecutable,
    context.backendExecutable.capsulePath,
    context.workspaceRoot,
  );
  const valid =
    context.backendExecutable.realPath === capsule.command &&
    context.backendExecutable.identityDigest === capsule.backendExecutableIdentityDigest;
  if (!valid) throw new DebugCapsulePlanError();
}

function finalLayer2Plan(
  input: DebugCapsuleLayer2Input,
  capsule: Layer2DebugCapsulePlan["capsule"],
  runtimeIdentityDigest: string,
  envelope: DebugSpawnEnvelope,
  clock: { readonly epoch: number; readonly expiresAtMs: number },
  endpoint: Layer2DebugCapsulePlan["endpoint"],
  launchIdentityDigest: string,
  launchRequestValue: ClosedDebugLaunchRequest,
  provisioningDigest: string,
): Layer2DebugCapsulePlan {
  return Object.freeze({
    schemaVersion: "1",
    ...input.binding,
    provisioningDigest,
    backend: capsule.backend,
    runtimeIdentityDigest,
    capsule,
    spawnEnvelope: envelope,
    ...clock,
    launchIdentityDigest,
    planId: envelope.planId,
    endpoint,
    attestation: Object.freeze({
      filesystem: "executionRoot",
      network: "none",
      processScope: "capsule",
      runtimeDirectoryMode: "0700",
      endpointOwnership: "currentUser",
    }),
    launchRequest: launchRequestValue,
  }) as unknown as Layer2DebugCapsulePlan;
}

function assemblePlan(
  deps: DebugLaunchPlanDeps,
  input: DebugCapsuleLayer2Input,
  context: DebugLaunchRuntimeContext,
  target: DebugLaunchTarget,
  execution: ClosedDebugExecution,
  candidate: OpaqueTarget,
  provisioningDigest: string,
): Layer2DebugCapsulePlan {
  const runtimeDigest = hash([context.runtimeMount.identityDigest, immutableMounts(context)]);
  const capsule = (deps.planCapsule ?? planStrictDebugCapsule)(
    deriveStrictDebugCapsuleInput(input, context, runtimeDigest),
  );
  assertCapsuleBackend(context, capsule);
  const clock = planClock(deps, input.binding.activationRevision);
  const endpoint = endpointPlan(context);
  const launch = launchRequest(execution, context);
  const envelope = spawnEnvelope(
    input,
    candidate,
    context,
    target,
    capsule,
    endpoint,
    clock,
    runtimeDigest,
    provisioningDigest,
  );
  const launchIdentityDigest = hash([
    input.binding,
    provisioningDigest,
    target,
    execution,
    context.environment,
    capsule,
    endpoint,
    envelope,
  ]);
  return finalLayer2Plan(
    input,
    capsule,
    runtimeDigest,
    envelope,
    clock,
    endpoint,
    launchIdentityDigest,
    launch,
    provisioningDigest,
  );
}

export function createDebugLaunchLayer2Validator(
  deps: DebugLaunchPlanDeps,
): DebugCapsuleLayer2Validator {
  return { validateAndRederive: (input) => validate(deps, input) };
}
