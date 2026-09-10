import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { atomicPublishRename } from "@oscharko-dev/keiko-security/fs-atomic-rename";
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

export interface PortableHandoffLayouts {
  readonly paths: PortableActivationPaths;
  readonly current: PortableActivationLayout;
  readonly candidate: PortableActivationLayout;
  readonly currentSupervisorPath: string;
  readonly candidateSupervisorPath: string;
}

const REGISTRATION_FILE = "portable-install-state.json";
const UPDATES_DIR = "updates";
const HANDOFF_DIR = "handoff";
const REGISTRATION_SNAPSHOT_FILE = "registration.previous";
const REGISTRATION_ABSENT_FILE = "registration.previous.absent";
const MAX_REGISTRATION_BYTES = 64 * 1024;
const MAX_ACTIVE_SETUP_BYTES = 64 * 1024;
const MAX_ACTIVE_LAUNCHER_BYTES = 64 * 1024 * 1024;
const ACTIVE_ATTESTATION_TIMEOUT_MS = 15_000;
const ACTIVE_ATTESTATION_BUFFER_BYTES = 64 * 1024;

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
  if (target === "linux-x64") {
    return {
      installRoot: root,
      resourceRoot: root,
      appRoot: join(root, "app"),
      packageJsonPath: join(root, "app", "package.json"),
      setupManifestPath: join(root, ".portable", "setup-manifest.json"),
      launcherPath: join(root, "Keiko"),
      runtimeSupervisorPath: join(root, "runtime", "native", "keiko-runtime-supervisor"),
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
    target === "windows-x64" || target === "linux-x64"
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

function isSafeStageId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  );
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

function defaultManagedRoot(target: UpdatePortableTarget, env: EnvSource, home: string): string {
  if (target === "windows-x64") {
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "Keiko");
  }
  if (target === "linux-x64") return join(home, ".local", "opt", "Keiko");
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

function activeWindowsInstallBinding(
  record: Record<string, unknown>,
  input: {
    readonly managedRoot: string;
    readonly target: UpdatePortableTarget;
    readonly version: string;
  },
): WindowsGenerationBinding | undefined {
  const deadline = Date.now() + ACTIVE_ATTESTATION_TIMEOUT_MS;
  const setupManifestPath = join(input.managedRoot, ".portable", "setup-manifest.json");
  const launcherPath = join(input.managedRoot, "Keiko.exe");
  const setupBytes = readBoundedActiveFile(setupManifestPath, MAX_ACTIVE_SETUP_BYTES, deadline);
  const setup = parseJsonRecord(setupBytes.toString("utf8"));
  if (setup === undefined) return undefined;
  const expectedGeneration = parseWindowsGenerationBinding(setup.windowsGeneration);
  if (
    !activeSetupMatches(setup, input, expectedGeneration) ||
    !registrationSchemaMatches(record, input.target, expectedGeneration)
  ) {
    return undefined;
  }
  const setupManifestSha256 = createHash("sha256").update(setupBytes).digest("hex");
  const launcherSha256 = digestBoundedActiveFile(launcherPath, MAX_ACTIVE_LAUNCHER_BYTES, deadline);
  return activeRegistrationDigestsMatch(
    record,
    setupManifestSha256,
    launcherSha256,
    expectedGeneration,
  )
    ? expectedGeneration
    : undefined;
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

export interface PortableManagedRegistrationAttestationFacts {
  readonly windowsGeneration?: WindowsGenerationBinding | undefined;
}

export function attestPortableManagedRegistrationFacts(input: {
  readonly stateDir: string;
  readonly managedRoot: string;
  readonly target: UpdatePortableTarget;
  readonly version: string;
  readonly expectedSha256: string;
}): PortableManagedRegistrationAttestationFacts | undefined {
  try {
    assertNoSymlinkAncestor(input.stateDir);
    const registration = readPortableRegistrationSnapshot(registrationPath(input.stateDir));
    if (createHash("sha256").update(registration).digest("hex") !== input.expectedSha256) {
      return undefined;
    }
    const record = parseJsonRecord(registration.toString("utf8"));
    if (record === undefined || !registrationSchemaMatches(record, input.target)) return undefined;
    const windowsGeneration =
      input.target === "windows-x64" ? activeWindowsInstallBinding(record, input) : undefined;
    if (
      (input.target === "windows-x64" && windowsGeneration === undefined) ||
      !activeRegistrationMetadataMatches(record, input)
    ) {
      return undefined;
    }
    return windowsGeneration === undefined ? {} : { windowsGeneration };
  } catch {
    return undefined;
  }
}

export function attestPortableManagedRegistration(input: {
  readonly stateDir: string;
  readonly managedRoot: string;
  readonly target: UpdatePortableTarget;
  readonly version: string;
  readonly expectedSha256: string;
}): boolean {
  return attestPortableManagedRegistrationFacts(input) !== undefined;
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

export function cleanupPortableRegistrationSnapshot(input: {
  readonly stateDir: string;
  readonly activationId: string;
}): void {
  const snapshot = registrationSnapshotPaths(input.stateDir, input.activationId);
  rmSync(snapshot.content, { force: true });
  rmSync(snapshot.absent, { force: true });
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
