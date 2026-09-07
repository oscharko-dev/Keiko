import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 as win32Path } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import {
  WINDOWS_SHORTCUT_MAX_BYTES,
  equivalentWindowsShortcutPath,
  readWindowsShortcutDefinition,
  writeWindowsShortcutDefinition,
  type SecurityLogSink,
  type WindowsShortcutDefinition,
} from "@oscharko-dev/keiko-security";
import {
  atomicPublishRename,
  atomicPublishTreeSwap,
  withCwdOutsideTree,
} from "@oscharko-dev/keiko-security/fs-atomic-rename";
import type {
  UpdatePortableStagingSummary,
  UpdatePortableTarget,
  UpdateSessionFailureReason,
} from "@oscharko-dev/keiko-contracts";
import type { UpdateRuntimeFacts } from "./update-install-mode.js";
import { managedRootFromPackageRoot } from "./update-portable-staging-archive.js";
import {
  PACKAGE_NAME,
  PORTABLE_PAYLOAD_ROOT,
  PORTABLE_STAGE_DIR_PREFIX,
  parseJsonRecord,
  primaryLauncher,
  runtimeFor,
} from "./update-portable-staging-shared.js";
import {
  parseWindowsGenerationBinding,
  resolveWindowsGenerationLayout,
  windowsGenerationBindingsEqual,
  type WindowsGenerationBinding,
} from "./update-portable-windows-generation.js";

export interface PortableActivationFileInput {
  readonly sessionId: string;
  readonly targetVersion: string;
  readonly stage: UpdatePortableStagingSummary;
  readonly runtimeFacts?: UpdateRuntimeFacts | undefined;
}

export interface PortableActivationLayout {
  readonly installRoot: string;
  readonly resourceRoot: string;
  readonly appRoot: string;
  readonly packageJsonPath: string;
  readonly setupManifestPath: string;
  readonly launcherPath: string;
  readonly runtimeSupervisorPath: string;
  readonly windowsGeneration?: WindowsGenerationBinding | undefined;
}

export interface PortableActivationPaths {
  readonly managedRoot: string;
  readonly stageRoot: string;
  readonly candidateRoot: string;
  readonly backupRoot: string;
}

export interface PortablePromotionResult {
  readonly layout: PortableActivationLayout;
  readonly paths: PortableActivationPaths;
}

export interface PortableHandoffLayouts {
  readonly paths: PortableActivationPaths;
  readonly current: PortableActivationLayout;
  readonly candidate: PortableActivationLayout;
  readonly currentSupervisorPath: string;
  readonly candidateSupervisorPath: string;
}

export interface PortableActivationRecovery {
  readonly activationId: string;
  readonly stageId: string;
  readonly target: UpdatePortableTarget;
  readonly phase: "prepared" | "promoted" | "registered" | "verified" | "cleanup-pending";
  readonly updaterPid?: number | undefined;
}

const REGISTRATION_FILE = "portable-install-state.json";
const RECOVERY_FILE = "portable-activation-recovery.json";
const UPDATES_DIR = "updates";
const HANDOFF_DIR = "handoff";
const REGISTRATION_SNAPSHOT_FILE = "registration.previous";
const REGISTRATION_ABSENT_FILE = "registration.previous.absent";
const MAX_REGISTRATION_BYTES = 64 * 1024;
const MAX_ACTIVE_SETUP_BYTES = 64 * 1024;
const MAX_ACTIVE_LAUNCHER_BYTES = 64 * 1024 * 1024;
const ACTIVE_ATTESTATION_TIMEOUT_MS = 15_000;
const ACTIVE_ATTESTATION_BUFFER_BYTES = 64 * 1024;
const WINDOWS_SHORTCUT_SAFE_PATH = /^[A-Za-z0-9_@ .()/\\:-]+$/u;

export class PortableUpdateActivationError extends Error {
  public constructor(
    public readonly reason: UpdateSessionFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "PortableUpdateActivationError";
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function activationIdFor(input: PortableActivationFileInput): string {
  return createHash("sha256")
    .update(`${input.sessionId}:${input.stage.stageId}:${input.stage.sha256}`)
    .digest("hex")
    .slice(0, 32);
}

function layoutFor(
  target: UpdatePortableTarget,
  root: string,
  setupManifest: Record<string, unknown>,
): PortableActivationLayout {
  if (target === "windows-x64") {
    const binding = parseWindowsGenerationBinding(setupManifest.windowsGeneration);
    if (binding === undefined) {
      throw activationFailed("portable activation Windows generation binding is malformed");
    }
    const generation = resolveWindowsGenerationLayout(root, binding);
    return {
      installRoot: root,
      resourceRoot: generation.resourceRoot,
      appRoot: generation.appRoot,
      packageJsonPath: generation.packageJsonPath,
      setupManifestPath: generation.rootSetupManifestPath,
      launcherPath: generation.rootLauncherPath,
      runtimeSupervisorPath: generation.runtimeSupervisorPath,
      windowsGeneration: binding,
    };
  }
  const resources = join(root, "Contents", "Resources");
  return {
    installRoot: root,
    resourceRoot: resources,
    appRoot: join(resources, "app"),
    packageJsonPath: join(resources, "app", "package.json"),
    setupManifestPath: join(resources, ".portable", "setup-manifest.json"),
    launcherPath: join(root, "Contents", "MacOS", "Keiko"),
    runtimeSupervisorPath: join(resources, "runtime", "native", "keiko-runtime-supervisor"),
  };
}

function activationFailed(message: string): PortableUpdateActivationError {
  return new PortableUpdateActivationError("portable-activation-failed", message);
}

function requiredFile(path: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw activationFailed("portable activation layout is incomplete");
  }
}

function readJsonRecord(path: string): Record<string, unknown> {
  const record = parseJsonRecord(readFileSync(path, "utf8"));
  if (record === undefined) throw activationFailed("portable activation metadata is malformed");
  return record;
}

function runtimeMatches(record: Record<string, unknown>, target: UpdatePortableTarget): boolean {
  const runtime = record.runtime;
  const runtimeRecord =
    typeof runtime === "object" && runtime !== null && !Array.isArray(runtime)
      ? (runtime as Record<string, unknown>)
      : {};
  const expected = runtimeFor(target);
  return (
    runtimeRecord.nodePlatform === expected.platform &&
    runtimeRecord.nodeArchitecture === expected.arch
  );
}

function manifestCoreMatches(
  record: Record<string, unknown>,
  target: UpdatePortableTarget,
  targetVersion: string,
): boolean {
  return (
    record.schemaVersion === (target === "windows-x64" ? 2 : 1) &&
    record.platformTarget === target &&
    record.packageName === PACKAGE_NAME &&
    record.packageVersion === targetVersion &&
    record.stable === true &&
    record.bootstrapUpdateEligible === false &&
    record.primaryLauncher === primaryLauncher(target)
  );
}

function validateSetupManifest(
  record: Record<string, unknown>,
  target: UpdatePortableTarget,
  targetVersion: string,
): void {
  if (!manifestCoreMatches(record, target, targetVersion) || !runtimeMatches(record, target)) {
    throw activationFailed("portable activation target is not eligible");
  }
  if (target !== "windows-x64") {
    if (record.windowsGeneration !== undefined) {
      throw activationFailed("portable activation target is not eligible");
    }
    return;
  }
  const binding = parseWindowsGenerationBinding(record.windowsGeneration);
  if (binding === undefined) {
    throw activationFailed("portable activation Windows generation binding is malformed");
  }
}

function validatePackageJson(record: Record<string, unknown>, targetVersion: string): void {
  if (record.name !== PACKAGE_NAME || record.version !== targetVersion) {
    throw new PortableUpdateActivationError(
      "portable-version-verification-failed",
      "portable activation package version did not match",
    );
  }
}

function validateLayout(
  target: UpdatePortableTarget,
  root: string,
  targetVersion: string,
): PortableActivationLayout {
  const rootSetupManifestPath =
    target === "windows-x64"
      ? join(root, ".portable", "setup-manifest.json")
      : join(root, "Contents", "Resources", ".portable", "setup-manifest.json");
  requiredFile(rootSetupManifestPath);
  const setupManifest = readJsonRecord(rootSetupManifestPath);
  const layout = layoutFor(target, root, setupManifest);
  requiredFile(layout.packageJsonPath);
  requiredFile(layout.setupManifestPath);
  requiredFile(layout.launcherPath);
  requiredFile(layout.runtimeSupervisorPath);
  validateSetupManifest(setupManifest, target, targetVersion);
  if (
    layout.windowsGeneration !== undefined &&
    sha256File(layout.launcherPath) !== layout.windowsGeneration.launcherSha256
  ) {
    throw activationFailed("portable activation root launcher digest did not match setup");
  }
  validatePackageJson(readJsonRecord(layout.packageJsonPath), targetVersion);
  return layout;
}

function assertNoSymlinkAncestor(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw activationFailed("portable activation path is unsafe");
  }
  let cursor = resolve(path);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
  if (lstatSync(cursor).isSymbolicLink()) {
    throw activationFailed("portable activation path is unsafe");
  }
  cursor = realpathSync(cursor);
  for (;;) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw activationFailed("portable activation path is unsafe");
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function activationPathsFor(
  target: UpdatePortableTarget,
  runtimeFacts: UpdateRuntimeFacts | undefined,
  stageId: string,
  activationId: string,
): PortableActivationPaths {
  if (!isSafeStageId(stageId)) {
    throw activationFailed("portable activation stage id is invalid");
  }
  const managedRoot = managedRootFromPackageRoot(target, runtimeFacts?.packageRoot);
  if (
    managedRoot === undefined ||
    !existsSync(managedRoot) ||
    !statSync(managedRoot).isDirectory()
  ) {
    throw new PortableUpdateActivationError(
      "portable-preflight-ineligible",
      "managed install root is unavailable",
    );
  }
  assertNoSymlinkAncestor(managedRoot);
  const parent = realpathSync(dirname(managedRoot));
  const stageRoot = join(parent, PORTABLE_STAGE_DIR_PREFIX, stageId);
  const candidateRoot =
    target === "windows-x64"
      ? join(stageRoot, PORTABLE_PAYLOAD_ROOT)
      : join(stageRoot, PORTABLE_PAYLOAD_ROOT, "Keiko.app");
  assertNoSymlinkAncestor(stageRoot);
  return {
    managedRoot,
    stageRoot,
    candidateRoot,
    backupRoot: join(parent, `.keiko-previous-${activationId}`),
  };
}

function activationPaths(
  input: PortableActivationFileInput,
  activationId: string,
): PortableActivationPaths {
  return activationPathsFor(
    input.stage.target,
    input.runtimeFacts,
    input.stage.stageId,
    activationId,
  );
}

function treeSwapOptions(
  securityLogSink: SecurityLogSink | undefined,
):
  | { readonly rename: typeof renameSync }
  | { readonly rename: typeof renameSync; readonly securityLogSink: SecurityLogSink } {
  if (securityLogSink === undefined) return { rename: renameSync };
  return { rename: renameSync, securityLogSink };
}

function restoreManagedRoot(
  paths: PortableActivationPaths,
  securityLogSink?: SecurityLogSink,
): void {
  const rename = treeSwapOptions(securityLogSink);
  withCwdOutsideTree(paths.managedRoot, () => {
    if (!existsSync(paths.backupRoot)) return;
    if (existsSync(paths.managedRoot)) {
      if (existsSync(paths.candidateRoot)) {
        throw activationFailed("portable activation recovery is incomplete");
      }
      atomicPublishTreeSwap(paths.managedRoot, paths.candidateRoot, rename);
    }
    atomicPublishTreeSwap(paths.backupRoot, paths.managedRoot, rename);
  });
}

function promote(
  paths: PortableActivationPaths,
  target: UpdatePortableTarget,
  targetVersion: string,
  securityLogSink?: SecurityLogSink,
): PortableActivationLayout {
  if (existsSync(paths.backupRoot)) {
    throw activationFailed("portable activation backup path is occupied");
  }
  validateLayout(target, paths.candidateRoot, targetVersion);
  return withCwdOutsideTree(paths.managedRoot, () =>
    swapManagedRoot(paths, target, targetVersion, securityLogSink),
  );
}

function swapManagedRoot(
  paths: PortableActivationPaths,
  target: UpdatePortableTarget,
  targetVersion: string,
  securityLogSink?: SecurityLogSink,
): PortableActivationLayout {
  const rename = treeSwapOptions(securityLogSink);
  let moved = false;
  try {
    atomicPublishTreeSwap(paths.managedRoot, paths.backupRoot, rename);
    moved = true;
    atomicPublishTreeSwap(paths.candidateRoot, paths.managedRoot, rename);
    return validateLayout(target, paths.managedRoot, targetVersion);
  } catch (error) {
    if (moved) restoreManagedRoot(paths, securityLogSink);
    if (error instanceof PortableUpdateActivationError) throw error;
    throw activationFailed("portable activation swap failed");
  }
}

function defaultManagedRoot(target: UpdatePortableTarget, env: EnvSource, home: string): string {
  if (target === "windows-x64") {
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "Keiko");
  }
  return "/Applications/Keiko.app";
}

function managedRootLocator(
  target: UpdatePortableTarget,
  root: string,
  env: EnvSource,
  home: string,
): Record<string, string> {
  const realRoot = realpathSync(root);
  if (resolve(defaultManagedRoot(target, env, home)) === realRoot) return { kind: "default" };
  const homeRelative = relative(resolve(home), realRoot);
  if (homeRelative.length > 0 && !homeRelative.startsWith("..") && !isAbsolute(homeRelative)) {
    return { kind: "home-relative", path: homeRelative };
  }
  return { kind: "absolute-local", path: realRoot };
}

export function promotePortableInstall(
  input: PortableActivationFileInput,
  activationId: string,
  securityLogSink?: SecurityLogSink,
): PortablePromotionResult {
  const paths = activationPaths(input, activationId);
  return {
    paths,
    layout: promote(paths, input.stage.target, input.targetVersion, securityLogSink),
  };
}

export function resolvePortableHandoffLayouts(input: {
  readonly activation: PortableActivationFileInput;
  readonly activationId: string;
  readonly currentVersion: string;
}): PortableHandoffLayouts {
  const unresolved = activationPaths(input.activation, input.activationId);
  const paths = { ...unresolved, managedRoot: realpathSync(unresolved.managedRoot) };
  const current = validateLayout(
    input.activation.stage.target,
    paths.managedRoot,
    input.currentVersion,
  );
  const candidate = validateLayout(
    input.activation.stage.target,
    paths.candidateRoot,
    input.activation.targetVersion,
  );
  const currentSupervisorPath = current.runtimeSupervisorPath;
  const candidateSupervisorPath = candidate.runtimeSupervisorPath;
  requiredFile(currentSupervisorPath);
  requiredFile(candidateSupervisorPath);
  return { paths, current, candidate, currentSupervisorPath, candidateSupervisorPath };
}

function recoveryPath(stateDir: string): string {
  return join(stateDir, UPDATES_DIR, RECOVERY_FILE);
}

function registrationPath(stateDir: string): string {
  return join(stateDir, REGISTRATION_FILE);
}

function registrationSnapshotPaths(
  stateDir: string,
  activationId: string,
): {
  readonly content: string;
  readonly absent: string;
} {
  if (!/^[a-f0-9]{32}$/u.test(activationId)) {
    throw activationFailed("portable registration activation identity is invalid");
  }
  const root = join(stateDir, UPDATES_DIR, HANDOFF_DIR, activationId);
  return {
    content: join(root, REGISTRATION_SNAPSHOT_FILE),
    absent: join(root, REGISTRATION_ABSENT_FILE),
  };
}

function writeExclusiveFile(path: string, content: Uint8Array | string): void {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readPortableRegistrationSnapshot(path: string): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_REGISTRATION_BYTES) {
      throw activationFailed("portable registration path is unsafe");
    }
    const content = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < content.length) {
      const count = readSync(descriptor, content, offset, content.length - offset, null);
      if (count === 0) throw activationFailed("portable registration changed during capture");
      offset += count;
    }
    if (fstatSync(descriptor).size !== stat.size) {
      throw activationFailed("portable registration changed during capture");
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function openedBoundedFile(path: string, descriptor: number, maximumBytes: number): Stats {
  const current = lstatSync(path);
  const opened = fstatSync(descriptor);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.nlink !== 1 ||
    !opened.isFile() ||
    opened.nlink !== 1 ||
    opened.size < 1 ||
    opened.size > maximumBytes ||
    current.dev !== opened.dev ||
    current.ino !== opened.ino
  ) {
    throw activationFailed("portable active attestation path is unsafe");
  }
  return opened;
}

function sameActiveFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function stableActivePath(current: Stats, opened: Stats): boolean {
  return (
    sameActiveFileIdentity(current, opened) && current.nlink === 1 && !current.isSymbolicLink()
  );
}

function assertBoundedFileStable(
  path: string,
  descriptor: number,
  opened: Stats,
  bytesRead: number,
): void {
  const after = fstatSync(descriptor);
  const current = lstatSync(path);
  if (
    bytesRead !== opened.size ||
    !sameActiveFileIdentity(after, opened) ||
    !stableActivePath(current, opened)
  ) {
    throw activationFailed("portable active attestation file changed while reading");
  }
}

function assertActiveAttestationDeadline(deadline: number): void {
  if (Date.now() > deadline) {
    throw activationFailed("portable active attestation timed out");
  }
}

function readBoundedActiveFile(path: string, maximumBytes: number, deadline: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = openedBoundedFile(path, descriptor, maximumBytes);
    const content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < content.length) {
      assertActiveAttestationDeadline(deadline);
      const count = readSync(descriptor, content, offset, content.length - offset, null);
      if (count === 0) {
        throw activationFailed("portable active attestation file changed while reading");
      }
      offset += count;
    }
    assertBoundedFileStable(path, descriptor, opened, offset);
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function digestBoundedActiveFile(path: string, maximumBytes: number, deadline: number): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = openedBoundedFile(path, descriptor, maximumBytes);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(ACTIVE_ATTESTATION_BUFFER_BYTES);
    let bytesRead = 0;
    for (;;) {
      assertActiveAttestationDeadline(deadline);
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytesRead += count;
      if (bytesRead > opened.size || bytesRead > maximumBytes) {
        throw activationFailed("portable active attestation file changed while reading");
      }
      hash.update(buffer.subarray(0, count));
    }
    assertBoundedFileStable(path, descriptor, opened, bytesRead);
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function activeSetupMatches(
  setup: Record<string, unknown>,
  input: { readonly target: UpdatePortableTarget; readonly version: string },
  expectedGeneration: WindowsGenerationBinding | undefined,
): boolean {
  const schemaMatches =
    input.target === "windows-x64"
      ? setup.schemaVersion === 2 && expectedGeneration !== undefined
      : setup.schemaVersion === 1 && setup.windowsGeneration === undefined;
  return (
    schemaMatches &&
    setup.platformTarget === input.target &&
    setup.packageVersion === input.version &&
    setup.stable === true
  );
}

function activeRegistrationDigestsMatch(
  record: Record<string, unknown>,
  setupManifestSha256: string,
  launcherSha256: string,
  expectedGeneration: WindowsGenerationBinding | undefined,
): boolean {
  return (
    record.setupManifestSha256 === setupManifestSha256 &&
    record.launcherIdentitySha256 === launcherSha256 &&
    (expectedGeneration === undefined ||
      expectedGeneration.launcherSha256 === record.launcherIdentitySha256)
  );
}

function activeWindowsInstallMatchesRegistration(
  record: Record<string, unknown>,
  input: {
    readonly managedRoot: string;
    readonly target: UpdatePortableTarget;
    readonly version: string;
  },
): boolean {
  const deadline = Date.now() + ACTIVE_ATTESTATION_TIMEOUT_MS;
  const setupManifestPath = join(input.managedRoot, ".portable", "setup-manifest.json");
  const launcherPath = join(input.managedRoot, "Keiko.exe");
  const setupBytes = readBoundedActiveFile(setupManifestPath, MAX_ACTIVE_SETUP_BYTES, deadline);
  const setup = parseJsonRecord(setupBytes.toString("utf8"));
  if (setup === undefined) return false;
  const expectedGeneration = parseWindowsGenerationBinding(setup.windowsGeneration);
  if (
    !activeSetupMatches(setup, input, expectedGeneration) ||
    !registrationSchemaMatches(record, input.target, expectedGeneration)
  ) {
    return false;
  }
  const setupManifestSha256 = createHash("sha256").update(setupBytes).digest("hex");
  const launcherSha256 = digestBoundedActiveFile(launcherPath, MAX_ACTIVE_LAUNCHER_BYTES, deadline);
  return activeRegistrationDigestsMatch(
    record,
    setupManifestSha256,
    launcherSha256,
    expectedGeneration,
  );
}

function activeRegistrationMetadataMatches(
  record: Record<string, unknown>,
  input: {
    readonly managedRoot: string;
    readonly target: UpdatePortableTarget;
    readonly version: string;
  },
): boolean {
  return (
    record.status === "managed" &&
    record.updateEligible === true &&
    record.stable === true &&
    record.platformTarget === input.target &&
    record.packageVersion === input.version &&
    record.installRootIdentitySha256 === sha256Text(realpathSync(input.managedRoot))
  );
}

export function attestPortableManagedRegistration(input: {
  readonly stateDir: string;
  readonly managedRoot: string;
  readonly target: UpdatePortableTarget;
  readonly version: string;
  readonly expectedSha256: string;
}): boolean {
  try {
    assertNoSymlinkAncestor(input.stateDir);
    const registration = readPortableRegistrationSnapshot(registrationPath(input.stateDir));
    if (createHash("sha256").update(registration).digest("hex") !== input.expectedSha256) {
      return false;
    }
    const record = parseJsonRecord(registration.toString("utf8"));
    if (record === undefined || !registrationSchemaMatches(record, input.target)) return false;
    if (input.target === "windows-x64" && !activeWindowsInstallMatchesRegistration(record, input)) {
      return false;
    }
    return activeRegistrationMetadataMatches(record, input);
  } catch {
    return false;
  }
}

export interface PortableRegistrationSnapshot {
  readonly state: "present" | "absent";
  readonly sha256: string;
}

function registrationSchemaMatches(
  record: Record<string, unknown>,
  target: UpdatePortableTarget,
  expectedWindowsGeneration?: WindowsGenerationBinding,
): boolean {
  if (target !== "windows-x64") {
    return record.schemaVersion === 1 && record.windowsGeneration === undefined;
  }
  const actual = parseWindowsGenerationBinding(record.windowsGeneration);
  return (
    record.schemaVersion === 2 &&
    actual !== undefined &&
    (expectedWindowsGeneration === undefined ||
      windowsGenerationBindingsEqual(actual, expectedWindowsGeneration))
  );
}

function registrationIdentityMatches(
  record: Record<string, unknown>,
  input: {
    readonly expectedManagedRootIdentitySha256?: string | undefined;
    readonly expectedTarget?: UpdatePortableTarget | undefined;
    readonly expectedVersion?: string | undefined;
  },
): boolean {
  if (
    input.expectedManagedRootIdentitySha256 !== undefined &&
    record.installRootIdentitySha256 !== input.expectedManagedRootIdentitySha256
  ) {
    return false;
  }
  if (input.expectedTarget !== undefined && record.platformTarget !== input.expectedTarget) {
    return false;
  }
  return input.expectedVersion === undefined || record.packageVersion === input.expectedVersion;
}

function isManagedRegistration(record: Record<string, unknown>): boolean {
  return record.status === "managed" && record.updateEligible === true && record.stable === true;
}

function managedRegistrationMatches(
  record: Record<string, unknown> | undefined,
  input: {
    readonly expectedManagedRootIdentitySha256?: string | undefined;
    readonly expectedTarget?: UpdatePortableTarget | undefined;
    readonly expectedVersion?: string | undefined;
    readonly expectedWindowsGeneration?: WindowsGenerationBinding | undefined;
  },
): boolean {
  if (record === undefined) return false;
  const target = input.expectedTarget;
  if (target === "windows-x64" && input.expectedWindowsGeneration === undefined) return false;
  if (
    target !== undefined &&
    !registrationSchemaMatches(record, target, input.expectedWindowsGeneration)
  ) {
    return false;
  }
  if (target === undefined && record.schemaVersion !== 1) return false;
  return registrationIdentityMatches(record, input) && isManagedRegistration(record);
}

export function capturePortableRegistration(input: {
  readonly stateDir: string;
  readonly activationId: string;
  readonly expectedManagedRootIdentitySha256?: string | undefined;
  readonly expectedTarget?: UpdatePortableTarget | undefined;
  readonly expectedVersion?: string | undefined;
  readonly expectedWindowsGeneration?: WindowsGenerationBinding | undefined;
}): PortableRegistrationSnapshot {
  assertNoSymlinkAncestor(input.stateDir);
  const snapshot = registrationSnapshotPaths(input.stateDir, input.activationId);
  const snapshotRoot = dirname(snapshot.content);
  assertNoSymlinkAncestor(snapshotRoot);
  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestor(snapshotRoot);
  const registration = registrationPath(input.stateDir);
  if (existsSync(snapshot.content) || existsSync(snapshot.absent)) {
    throw activationFailed("portable registration recovery is pending");
  }
  if (!existsSync(registration)) {
    writeExclusiveFile(snapshot.absent, "");
    return { state: "absent", sha256: sha256Text("") };
  }
  const content = readPortableRegistrationSnapshot(registration);
  const record = parseJsonRecord(content.toString("utf8"));
  if (!managedRegistrationMatches(record, input)) {
    throw activationFailed("portable registration does not match the managed install");
  }
  writeExclusiveFile(snapshot.content, content);
  const sourceSha256 = createHash("sha256").update(content).digest("hex");
  const snapshotSha256 = createHash("sha256")
    .update(readPortableRegistrationSnapshot(snapshot.content))
    .digest("hex");
  if (snapshotSha256 !== sourceSha256) {
    throw activationFailed("portable registration changed during snapshot publication");
  }
  return { state: "present", sha256: snapshotSha256 };
}

export function restorePortableRegistration(input: {
  readonly stateDir: string;
  readonly activationId: string;
}): void {
  assertNoSymlinkAncestor(input.stateDir);
  const registration = registrationPath(input.stateDir);
  const snapshot = registrationSnapshotPaths(input.stateDir, input.activationId);
  if (existsSync(snapshot.absent)) {
    if (lstatSync(snapshot.absent).isSymbolicLink()) {
      throw activationFailed("portable registration recovery path is unsafe");
    }
    if (existsSync(registration)) rmSync(registration, { force: true });
    return;
  }
  if (!existsSync(snapshot.content)) return;
  if (lstatSync(snapshot.content).isSymbolicLink()) {
    throw activationFailed("portable registration recovery path is unsafe");
  }
  const temporary = `${registration}.${String(process.pid)}.restore`;
  writeExclusiveFile(temporary, readPortableRegistrationSnapshot(snapshot.content));
  atomicPublishRename(temporary, registration, { rename: renameSync });
}

export function cleanupPortableRegistrationSnapshot(input: {
  readonly stateDir: string;
  readonly activationId: string;
}): void {
  const snapshot = registrationSnapshotPaths(input.stateDir, input.activationId);
  rmSync(snapshot.content, { force: true });
  rmSync(snapshot.absent, { force: true });
}

function isRecoveryTarget(value: unknown): value is UpdatePortableTarget {
  return value === "windows-x64" || value === "macos-arm64" || value === "macos-x64";
}

function isRecoveryPhase(value: unknown): value is PortableActivationRecovery["phase"] {
  return (
    value === "prepared" ||
    value === "promoted" ||
    value === "registered" ||
    value === "verified" ||
    value === "cleanup-pending"
  );
}

function isSafeStageId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  );
}

function hasAllowedRecoveryKeys(record: Record<string, unknown>): boolean {
  const allowed = new Set(["activationId", "stageId", "target", "phase", "updaterPid"]);
  const keys = Object.keys(record);
  return (
    ["activationId", "stageId", "target", "phase"].every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function isUpdaterPid(value: unknown): value is number | undefined {
  if (value === undefined) return true;
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPortableActivationRecovery(value: unknown): value is PortableActivationRecovery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return !hasAllowedRecoveryKeys(record)
    ? false
    : typeof record.activationId === "string" &&
        /^[a-f0-9]{32}$/u.test(record.activationId) &&
        isSafeStageId(record.stageId) &&
        isRecoveryTarget(record.target) &&
        isRecoveryPhase(record.phase) &&
        isUpdaterPid(record.updaterPid);
}

function assertRecovery(value: unknown): PortableActivationRecovery {
  if (!isPortableActivationRecovery(value)) {
    throw activationFailed("portable activation recovery metadata is malformed");
  }
  return value;
}

export function readPortableActivationRecovery(
  stateDir: string,
): PortableActivationRecovery | undefined {
  assertNoSymlinkAncestor(stateDir);
  const path = recoveryPath(stateDir);
  if (!existsSync(path)) return undefined;
  if (lstatSync(path).isSymbolicLink()) {
    throw activationFailed("portable activation recovery path is unsafe");
  }
  return assertRecovery(parseJsonRecord(readFileSync(path, "utf8")));
}

export function writePortableActivationRecovery(input: {
  readonly stateDir: string;
  readonly recovery: PortableActivationRecovery;
}): void {
  assertNoSymlinkAncestor(input.stateDir);
  const path = recoveryPath(input.stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw activationFailed("portable activation recovery path is unsafe");
  }
  const temporaryPath = `${path}.${String(process.pid)}.tmp`;
  if (existsSync(temporaryPath)) {
    throw activationFailed("portable activation recovery is pending");
  }
  writeFileSync(temporaryPath, `${JSON.stringify(input.recovery)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  atomicPublishRename(temporaryPath, path, { rename: renameSync });
}

export function beginPortableActivationRecovery(input: {
  readonly stateDir: string;
  readonly recovery: PortableActivationRecovery;
}): void {
  assertNoSymlinkAncestor(input.stateDir);
  const path = recoveryPath(input.stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    throw activationFailed("portable activation recovery is pending");
  }
  const temporaryPath = `${path}.${String(process.pid)}.tmp`;
  if (existsSync(temporaryPath)) {
    throw activationFailed("portable activation recovery is pending");
  }
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(input.recovery)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    linkSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath) && !lstatSync(temporaryPath).isSymbolicLink()) {
      rmSync(temporaryPath, { force: true });
    }
  }
}

export function clearPortableActivationRecovery(stateDir: string): void {
  const path = recoveryPath(stateDir);
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) {
    throw activationFailed("portable activation recovery path is unsafe");
  }
  rmSync(path, { force: true });
}

export function recoveryPaths(input: {
  readonly target: UpdatePortableTarget;
  readonly stageId: string;
  readonly runtimeFacts?: UpdateRuntimeFacts | undefined;
  readonly activationId: string;
}): PortableActivationPaths {
  return activationPathsFor(input.target, input.runtimeFacts, input.stageId, input.activationId);
}

export function refreshPortableRegistration(input: {
  readonly stateDir: string;
  readonly layout: PortableActivationLayout;
  readonly target: UpdatePortableTarget;
  readonly env: EnvSource;
  readonly home: string;
  readonly now: number;
}): void {
  assertNoSymlinkAncestor(input.stateDir);
  mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
  const path = registrationPath(input.stateDir);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw activationFailed("portable registration path is unsafe");
  }
  const registration = portableRegistrationDocument(input);
  const temporaryPath = `${path}.${String(process.pid)}.tmp`;
  writeExclusiveFile(temporaryPath, registration);
  atomicPublishRename(temporaryPath, path, { rename: renameSync });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
}

export function portableRegistrationDocument(input: {
  readonly layout: PortableActivationLayout;
  readonly target: UpdatePortableTarget;
  readonly env: EnvSource;
  readonly home: string;
  readonly now: number;
  readonly launcherIdentitySha256?: string | undefined;
}): string {
  const manifest = readJsonRecord(input.layout.setupManifestPath);
  const launcherIdentitySha256 =
    input.launcherIdentitySha256 ?? sha256File(input.layout.launcherPath);
  if (!/^[a-f0-9]{64}$/u.test(launcherIdentitySha256)) {
    throw activationFailed("portable registration launcher identity is invalid");
  }
  const windowsGeneration = input.layout.windowsGeneration;
  if (input.target === "windows-x64" && windowsGeneration === undefined) {
    throw activationFailed("portable registration Windows generation binding is missing");
  }
  const registration = {
    schemaVersion: input.target === "windows-x64" ? 2 : 1,
    status: "managed",
    updateEligible: true,
    platformTarget: input.target,
    packageVersion: String(manifest.packageVersion),
    stable: true,
    managedRootLocator: managedRootLocator(
      input.target,
      input.layout.installRoot,
      input.env,
      input.home,
    ),
    setupManifestSha256: sha256File(input.layout.setupManifestPath),
    installRootIdentitySha256: sha256Text(realpathSync(input.layout.installRoot)),
    launcherIdentitySha256,
    ...(windowsGeneration === undefined ? {} : { windowsGeneration }),
    updatedAt: new Date(input.now).toISOString(),
  };
  return `${JSON.stringify(registration, null, 2)}\n`;
}

const SHORTCUT_FAILURE_PREFIX = "portable activation shortcut command failed";

type WindowsShortcutArtifact = WindowsShortcutDefinition;

function readShortcut(
  path: string,
  env: EnvSource,
  sink?: SecurityLogSink,
): WindowsShortcutArtifact | undefined {
  return readWindowsShortcutDefinition(path, env, SHORTCUT_FAILURE_PREFIX, { sink });
}

function readGuardedShortcut(
  path: string,
  env: EnvSource,
  sink?: SecurityLogSink,
): WindowsShortcutArtifact | undefined {
  // One lstat, no exists-then-stat window: a file removed between the two calls must read as
  // absent, not throw out of a read that callers treat as a plain lookup.
  const stat = lstatEntryOrUndefined(path);
  if (stat === undefined || !stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
    return undefined;
  }
  if (stat.size <= 0 || stat.size > WINDOWS_SHORTCUT_MAX_BYTES) return undefined;
  return readShortcut(path, env, sink);
}

export function readWindowsPortableShortcutTarget(
  path: string,
  env: EnvSource = process.env,
): string | undefined {
  return readGuardedShortcut(path, env)?.targetPath;
}

// Attribution check for the overwrite guard, deliberately target-only: a shortcut whose target
// is this install's managed launcher is OURS, and the rewrite that follows refreshes every
// managed field — a stale working directory is exactly what the rewrite repairs. Widening the
// match to more fields would make the guard refuse the very artifacts the refresh exists to
// heal; a target pointing anywhere else marks a foreign or user-edited file we never touch.
function shortcutMatches(
  path: string,
  artifact: WindowsShortcutArtifact,
  env: EnvSource,
  sink?: SecurityLogSink,
): boolean {
  const shortcut = readGuardedShortcut(path, env, sink);
  return (
    shortcut !== undefined &&
    equivalentWindowsShortcutPath(shortcut.targetPath, artifact.targetPath)
  );
}

function writeShortcut(
  path: string,
  artifact: WindowsShortcutArtifact,
  env: EnvSource,
  sink?: SecurityLogSink,
): void {
  writeWindowsShortcutDefinition(path, artifact, env, SHORTCUT_FAILURE_PREFIX, { sink });
}

export function refreshPortableShortcut(input: {
  readonly target: UpdatePortableTarget;
  readonly layout: PortableActivationLayout;
  readonly env: EnvSource;
  readonly home: string;
  // Wired from the server composition root (`processServerLogSink()` in deps.ts). A hostile or
  // malformed SystemRoot/WINDIR is logged through it — `security.windows-shortcut.system-root-
  // refused`, emitted by the shared cscript invocation in windows-shortcuts.ts — BEFORE this
  // function's own catch below discards the exception into the boolean contract. Omitted, every
  // call stays exactly as silent as before this field existed.
  readonly securityLogSink?: SecurityLogSink | undefined;
}): boolean {
  if (input.target !== "windows-x64") return true;
  if (!WINDOWS_SHORTCUT_SAFE_PATH.test(input.layout.launcherPath)) return false;
  // Absolute-only, like every other environment-sourced root here: an empty or relative
  // APPDATA would re-anchor the Start Menu path at the process working directory.
  const configuredAppData = input.env.APPDATA;
  const root =
    configuredAppData !== undefined && win32Path.isAbsolute(configuredAppData)
      ? configuredAppData
      : join(input.home, "AppData", "Roaming");
  const path = join(root, "Microsoft", "Windows", "Start Menu", "Programs", "Keiko.lnk");
  const artifact = {
    targetPath: input.layout.launcherPath,
    workingDirectory: input.layout.installRoot,
    iconPath: input.layout.launcherPath,
  };
  try {
    // lstat first: `existsSync` follows symlinks, so a DANGLING symlink would pass an
    // exists-guarded check and the write would follow it to an attacker-chosen target. lstat
    // sees the link itself regardless of its target.
    const entry = lstatEntryOrUndefined(path);
    if (entry !== undefined) {
      if (entry.isSymbolicLink()) return false;
      // Refuse-to-overwrite, not refresh-at-any-cost: an existing regular file whose target is
      // not this install's launcher cannot be attributed to this product — it is foreign or
      // user-edited, and activation must never destroy it (`shortcutRefreshed: false` reports
      // the refusal). An attributed shortcut passes and is fully rewritten below, which is how
      // a stale working directory or icon gets repaired.
      if (entry.isFile() && !shortcutMatches(path, artifact, input.env, input.securityLogSink)) {
        return false;
      }
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    writeShortcut(path, artifact, input.env, input.securityLogSink);
    return true;
  } catch {
    // Boolean contract: a shortcut-host failure degrades to shortcutRefreshed=false — it must
    // never abort an otherwise-completed activation. The redacted failure detail (exit status +
    // stderr byte count) is intentionally not persisted here in its own right: the API-visible
    // signal is `shortcutRefreshed: false` in the activation summary, and the operator-diagnosable
    // path for the same artifact is `keiko portable repair`, which checks and rewrites this
    // registration with full CLI diagnostics. A trust-boundary refusal specifically (a hostile or
    // malformed SystemRoot/WINDIR) is NOT silent even so: `shortcutMatches`/`writeShortcut` above
    // already logged it through `input.securityLogSink`, when wired, before this catch ever runs —
    // see the field's doc comment.
    return false;
  }
}

function lstatEntryOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

export interface PortableActivationCleanupOptions {
  readonly platform?: NodeJS.Platform;
  readonly execPath?: string;
  readonly updaterPid?: number;
}

export interface PortableActivationCleanupResult {
  readonly backupDeleteDeferred: boolean;
}

export function cleanupPortableActivation(
  paths: PortableActivationPaths,
  options: PortableActivationCleanupOptions = {},
): PortableActivationCleanupResult {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const backupDeleteDeferred = shouldDeferBackupDelete(
    paths.backupRoot,
    platform,
    execPath,
    options.updaterPid,
  );
  if (!backupDeleteDeferred) {
    rmSync(paths.backupRoot, { recursive: true, force: true });
  }
  rmSync(paths.stageRoot, { recursive: true, force: true });
  return { backupDeleteDeferred };
}

function deferredCleanupUpdaterPid(
  recovery: PortableActivationRecovery,
  updaterPid: number | undefined,
): Pick<PortableActivationRecovery, "updaterPid"> | Record<string, never> {
  const pid = updaterPid ?? recovery.updaterPid;
  return pid === undefined ? {} : { updaterPid: pid };
}

function emitPortableBackupCleanup(
  sink: SecurityLogSink | undefined,
  correlationId: string,
  outcome: "deferred" | "removed",
): void {
  sink?.write({
    category: "security",
    op: "security.fs.portable-backup-cleanup",
    correlationId,
    extra: { outcome },
  });
}

export function commitPortableActivationCleanup(input: {
  readonly stateDir: string;
  readonly paths: PortableActivationPaths;
  readonly recovery: PortableActivationRecovery;
  readonly cleanup?: PortableActivationCleanupOptions;
  readonly securityLogSink?: SecurityLogSink;
}): "deferred" | "removed" {
  const cleanup = input.cleanup ?? {};
  const result = cleanupPortableActivation(input.paths, cleanup);
  cleanupPortableRegistrationSnapshot({
    stateDir: input.stateDir,
    activationId: input.recovery.activationId,
  });
  if (result.backupDeleteDeferred) {
    writePortableActivationRecovery({
      stateDir: input.stateDir,
      recovery: {
        activationId: input.recovery.activationId,
        stageId: input.recovery.stageId,
        target: input.recovery.target,
        phase: "cleanup-pending",
        ...deferredCleanupUpdaterPid(input.recovery, cleanup.updaterPid),
      },
    });
    emitPortableBackupCleanup(input.securityLogSink, input.recovery.activationId, "deferred");
    return "deferred";
  }
  clearPortableActivationRecovery(input.stateDir);
  emitPortableBackupCleanup(input.securityLogSink, input.recovery.activationId, "removed");
  return "removed";
}

function shouldDeferBackupDelete(
  backupRoot: string,
  platform: NodeJS.Platform,
  execPath: string,
  updaterPid: number | undefined,
): boolean {
  if (platform !== "win32") return false;
  if (updaterPid === process.pid) return true;
  return execPathMapsBackup(backupRoot, execPath);
}

function resolvedOrLiteral(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function execPathMapsBackup(backupRoot: string, execPath: string): boolean {
  const rel = relative(resolvedOrLiteral(backupRoot), resolvedOrLiteral(execPath));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function restorePortableActivation(
  paths: PortableActivationPaths,
  securityLogSink?: SecurityLogSink,
): void {
  restoreManagedRoot(paths, securityLogSink);
}
