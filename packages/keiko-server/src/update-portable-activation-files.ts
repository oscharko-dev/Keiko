import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
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

export interface PortableActivationFileInput {
  readonly sessionId: string;
  readonly targetVersion: string;
  readonly stage: UpdatePortableStagingSummary;
  readonly runtimeFacts?: UpdateRuntimeFacts | undefined;
}

export interface PortableActivationLayout {
  readonly installRoot: string;
  readonly appRoot: string;
  readonly packageJsonPath: string;
  readonly setupManifestPath: string;
  readonly launcherPath: string;
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

export interface PortableActivationRecovery {
  readonly activationId: string;
  readonly stageId: string;
  readonly target: UpdatePortableTarget;
  readonly phase: "prepared" | "promoted" | "registered" | "verified";
}

const REGISTRATION_FILE = "portable-install-state.json";
const REGISTRATION_SNAPSHOT_SUFFIX = ".registration-backup";
const REGISTRATION_ABSENT_SUFFIX = ".registration-absent";
const RECOVERY_FILE = "portable-activation-recovery.json";
const UPDATES_DIR = "updates";
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

function layoutFor(target: UpdatePortableTarget, root: string): PortableActivationLayout {
  if (target === "windows-x64") {
    return {
      installRoot: root,
      appRoot: join(root, "app"),
      packageJsonPath: join(root, "app", "package.json"),
      setupManifestPath: join(root, ".portable", "setup-manifest.json"),
      launcherPath: join(root, "Keiko.exe"),
    };
  }
  const resources = join(root, "Contents", "Resources");
  return {
    installRoot: root,
    appRoot: join(resources, "app"),
    packageJsonPath: join(resources, "app", "package.json"),
    setupManifestPath: join(resources, ".portable", "setup-manifest.json"),
    launcherPath: join(root, "Contents", "MacOS", "Keiko"),
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
    record.schemaVersion === 1 &&
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
  const layout = layoutFor(target, root);
  requiredFile(layout.packageJsonPath);
  requiredFile(layout.setupManifestPath);
  requiredFile(layout.launcherPath);
  validateSetupManifest(readJsonRecord(layout.setupManifestPath), target, targetVersion);
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

function restoreManagedRoot(paths: PortableActivationPaths): void {
  if (!existsSync(paths.backupRoot)) return;
  if (existsSync(paths.managedRoot)) {
    if (existsSync(paths.candidateRoot)) {
      throw activationFailed("portable activation recovery is incomplete");
    }
    renameSync(paths.managedRoot, paths.candidateRoot);
  }
  renameSync(paths.backupRoot, paths.managedRoot);
}

function promote(
  paths: PortableActivationPaths,
  target: UpdatePortableTarget,
  targetVersion: string,
): PortableActivationLayout {
  if (existsSync(paths.backupRoot)) {
    throw activationFailed("portable activation backup path is occupied");
  }
  validateLayout(target, paths.candidateRoot, targetVersion);
  let moved = false;
  try {
    renameSync(paths.managedRoot, paths.backupRoot);
    moved = true;
    renameSync(paths.candidateRoot, paths.managedRoot);
    return validateLayout(target, paths.managedRoot, targetVersion);
  } catch (error) {
    if (moved) restoreManagedRoot(paths);
    if (error instanceof PortableUpdateActivationError) throw error;
    throw activationFailed("portable activation swap failed");
  }
}

function defaultManagedRoot(target: UpdatePortableTarget, env: EnvSource, home: string): string {
  if (target === "windows-x64") {
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "Keiko");
  }
  return join(home, "Applications", "Keiko.app");
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
): PortablePromotionResult {
  const paths = activationPaths(input, activationId);
  return {
    paths,
    layout: promote(paths, input.stage.target, input.targetVersion),
  };
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
  const root = join(stateDir, UPDATES_DIR);
  return {
    content: join(root, `${activationId}${REGISTRATION_SNAPSHOT_SUFFIX}`),
    absent: join(root, `${activationId}${REGISTRATION_ABSENT_SUFFIX}`),
  };
}

function writeExclusiveFile(path: string, content: Uint8Array | string): void {
  writeFileSync(path, content, { mode: 0o600, flag: "wx" });
}

export function capturePortableRegistration(input: {
  readonly stateDir: string;
  readonly activationId: string;
}): void {
  assertNoSymlinkAncestor(input.stateDir);
  mkdirSync(join(input.stateDir, UPDATES_DIR), { recursive: true, mode: 0o700 });
  const registration = registrationPath(input.stateDir);
  const snapshot = registrationSnapshotPaths(input.stateDir, input.activationId);
  if (existsSync(snapshot.content) || existsSync(snapshot.absent)) {
    throw activationFailed("portable registration recovery is pending");
  }
  if (!existsSync(registration)) {
    writeExclusiveFile(snapshot.absent, "");
    return;
  }
  if (lstatSync(registration).isSymbolicLink()) {
    throw activationFailed("portable registration path is unsafe");
  }
  writeExclusiveFile(snapshot.content, readFileSync(registration));
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
  writeExclusiveFile(temporary, readFileSync(snapshot.content));
  renameSync(temporary, registration);
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
    value === "prepared" || value === "promoted" || value === "registered" || value === "verified"
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

function hasExactRecoveryKeys(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record);
  return (
    keys.length === 4 &&
    keys.every((key) => ["activationId", "stageId", "target", "phase"].includes(key))
  );
}

function isPortableActivationRecovery(value: unknown): value is PortableActivationRecovery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return !hasExactRecoveryKeys(record)
    ? false
    : typeof record.activationId === "string" &&
        /^[a-f0-9]{32}$/u.test(record.activationId) &&
        isSafeStageId(record.stageId) &&
        isRecoveryTarget(record.target) &&
        isRecoveryPhase(record.phase);
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
  renameSync(temporaryPath, path);
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
  const manifest = readJsonRecord(input.layout.setupManifestPath);
  const registration = {
    schemaVersion: 1,
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
    launcherIdentitySha256: sha256File(input.layout.launcherPath),
    updatedAt: new Date(input.now).toISOString(),
  };
  const temporaryPath = `${path}.${String(process.pid)}.tmp`;
  writeExclusiveFile(temporaryPath, `${JSON.stringify(registration, null, 2)}\n`);
  renameSync(temporaryPath, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
}

export function refreshPortableShortcut(input: {
  readonly target: UpdatePortableTarget;
  readonly layout: PortableActivationLayout;
  readonly env: EnvSource;
  readonly home: string;
}): boolean {
  if (input.target !== "windows-x64") return true;
  if (!WINDOWS_SHORTCUT_SAFE_PATH.test(input.layout.launcherPath)) return false;
  const root = input.env.APPDATA ?? join(input.home, "AppData", "Roaming");
  const path = join(root, "Microsoft", "Windows", "Start Menu", "Programs", "Keiko.bat");
  const content = `@start "" "${input.layout.launcherPath}" start --open\r\n`;
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) return false;
  if (existsSync(path) && statSync(path).isFile() && readFileSync(path, "utf8") !== content) {
    return false;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, content, { encoding: "utf8", mode: 0o644 });
  return true;
}

export function cleanupPortableActivation(paths: PortableActivationPaths): void {
  rmSync(paths.backupRoot, { recursive: true, force: true });
  rmSync(paths.stageRoot, { recursive: true, force: true });
}

export function restorePortableActivation(paths: PortableActivationPaths): void {
  restoreManagedRoot(paths);
}
