import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  type FailedSetupRegistration,
  type ManagedRootLocator,
  type ManagedSetupRegistration,
  readManagedRegistration,
  registrationMatches,
  writeFailedRegistration,
  writeManagedRegistration,
  readPortableInstallRegistration,
  type PortableInstallRegistration,
} from "./portable-registration.js";
import {
  inspectPortableManagedInstall,
  installNativeRegistration,
  parseWindowsStartMenuRegistration,
  removePortableManagedInstall,
  windowsStartMenuRegistrationPath,
} from "./portable-maintenance.js";
import { assertManagedRootAllowed } from "./portable-root-policy.js";
import type { CliIo } from "./runner.js";
import {
  defaultManagedRoot,
  isPortableTarget,
  layoutFor,
  PACKAGE_NAME,
  primaryLauncherName,
  targetRuntime,
  type PortableLayout,
  type PortableTarget,
  type SetupManifest,
  type SetupRuntimeManifest,
  type SetupStatus,
  type SpawnFn,
} from "./portable-shared.js";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

export interface ValidatedPortableRoot {
  readonly layout: PortableLayout;
  readonly manifest: SetupManifest;
}

export interface PortableManagedUpgradeInput {
  readonly target: PortableTarget;
  readonly source: ValidatedPortableRoot;
  readonly current: ValidatedPortableRoot;
  readonly managedRoot: string;
  readonly stateDir: string;
  readonly env: EnvSource;
  readonly home: string;
  readonly now: Date;
}

type PortableManagedReplacementInput = Omit<PortableManagedUpgradeInput, "current">;

interface StableVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

interface PortableUpgradePaths {
  readonly managedRoot: string;
  readonly stagingRoot: string;
  readonly stagedTarget: string;
  readonly backupRoot: string;
  readonly backupTarget: string;
}

class PortableUpgradeRollbackError extends Error {
  readonly rollbackCause: unknown;

  constructor(backupRoot: string, promotionCause: unknown, rollbackCause: unknown) {
    super(
      `portable upgrade failed and automatic rollback also failed; the previous install was preserved at ${backupRoot} — restore it manually`,
      { cause: promotionCause },
    );
    this.name = "PortableUpgradeRollbackError";
    this.rollbackCause = rollbackCause;
  }
}

export class PortableSetupBusyError extends Error {
  constructor() {
    super("portable setup or upgrade is already in progress");
    this.name = "PortableSetupBusyError";
  }
}

class PortableSetupFailureRecordedError extends Error {
  public constructor(public readonly original: unknown) {
    super(original instanceof Error ? original.message : "portable setup failed");
  }
}

class PortableManagedRegistrationRepairError extends Error {
  public constructor(public readonly original: unknown) {
    super(original instanceof Error ? original.message : "portable registration repair failed");
  }
}

const STABLE_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const PORTABLE_TARGETS = ["windows-x64", "macos-arm64", "macos-x64"] as const;
const PORTABLE_SETUP_LOCK = "portable-setup.lock";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSetupRuntime(value: unknown): SetupRuntimeManifest {
  if (!isRecord(value)) throw new Error("portable setup manifest runtime is malformed");
  const nodePlatform = value.nodePlatform;
  const nodeArchitecture = value.nodeArchitecture;
  if (nodePlatform !== "win32" && nodePlatform !== "darwin") {
    throw new Error("portable setup manifest runtime platform is unsupported");
  }
  if (nodeArchitecture !== "x64" && nodeArchitecture !== "arm64") {
    throw new Error("portable setup manifest runtime architecture is unsupported");
  }
  return { nodePlatform, nodeArchitecture };
}

function parseSetupManifest(path: string): SetupManifest {
  const raw = readJson(path);
  if (!isRecord(raw) || raw.schemaVersion !== 1) {
    throw new Error("portable setup manifest is malformed");
  }
  const targetName = typeof raw.platformTarget === "string" ? raw.platformTarget : undefined;
  if (targetName !== "windows-x64" && targetName !== "macos-arm64" && targetName !== "macos-x64") {
    throw new Error("portable setup manifest target is unsupported");
  }
  return parseSetupManifestRecord(raw, targetName);
}

function parseSetupManifestRecord(
  raw: Record<string, unknown>,
  targetName: PortableTarget,
): SetupManifest {
  const packageName = raw.packageName;
  const packageVersion = raw.packageVersion;
  const stable = raw.stable;
  const primaryLauncher = raw.primaryLauncher;
  const bootstrapUpdateEligible = raw.bootstrapUpdateEligible;
  if (typeof packageName !== "string" || typeof packageVersion !== "string") {
    throw new TypeError("portable setup manifest package fields are malformed");
  }
  if (typeof stable !== "boolean" || typeof bootstrapUpdateEligible !== "boolean") {
    throw new TypeError("portable setup manifest state flags are malformed");
  }
  if (typeof primaryLauncher !== "string") {
    throw new TypeError("portable setup manifest launcher field is malformed");
  }
  return {
    schemaVersion: 1,
    platformTarget: targetName,
    packageName,
    packageVersion,
    stable,
    primaryLauncher,
    bootstrapUpdateEligible,
    runtime: parseSetupRuntime(raw.runtime),
  };
}

function validateSetupManifest(manifest: SetupManifest, target: PortableTarget): void {
  const runtime = targetRuntime(target);
  if (manifest.platformTarget !== target)
    throw new Error("portable setup manifest target mismatch");
  if (manifest.packageName !== PACKAGE_NAME)
    throw new Error("portable setup manifest package mismatch");
  if (!manifest.stable) throw new Error("portable setup manifest must describe a stable release");
  if (manifest.bootstrapUpdateEligible) throw new Error("bootstrap roots are not update eligible");
  if (manifest.primaryLauncher !== primaryLauncherName(target)) {
    throw new Error("portable setup manifest launcher target mismatch");
  }
  if (
    manifest.runtime.nodePlatform !== runtime.nodePlatform ||
    manifest.runtime.nodeArchitecture !== runtime.nodeArchitecture
  ) {
    throw new Error("portable setup manifest runtime target mismatch");
  }
}

function validateLayout(layout: PortableLayout, manifest: SetupManifest): void {
  const requiredFiles = [
    { label: "package metadata", path: layout.packageJsonPath },
    { label: "bundled Node runtime", path: layout.runtimeNodePath },
    { label: "primary launcher", path: layout.primaryLauncherPath },
  ] as const;
  for (const file of requiredFiles) {
    if (!existsSync(file.path) || !statSync(file.path).isFile()) {
      throw new Error(`missing portable ${file.label}`);
    }
  }
  validateAppPackage(layout.packageJsonPath, manifest.packageVersion);
}

function validateAppPackage(path: string, expectedVersion: string): void {
  const appPackage = readJson(path);
  if (!isRecord(appPackage) || appPackage.name !== PACKAGE_NAME) {
    throw new Error("portable app package name mismatch");
  }
  if (appPackage.version !== expectedVersion) {
    throw new Error("portable app package version mismatch");
  }
}

function parseStableVersion(value: string): StableVersion | undefined {
  const match = STABLE_SEMVER_RE.exec(value);
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

function compareStableVersions(left: string, right: string): number {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (a === undefined || b === undefined) {
    throw new Error("portable upgrade requires stable semver versions");
  }
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function portableSourceIsNewer(
  source: ValidatedPortableRoot,
  current: ValidatedPortableRoot,
): boolean {
  return compareStableVersions(source.manifest.packageVersion, current.manifest.packageVersion) > 0;
}

export function portableSourceCanReplaceManaged(
  source: ValidatedPortableRoot,
  current: ValidatedPortableRoot,
): boolean {
  const versionComparison = compareStableVersions(
    source.manifest.packageVersion,
    current.manifest.packageVersion,
  );
  if (versionComparison > 0) return true;
  return (
    versionComparison === 0 && source.manifest.platformTarget !== current.manifest.platformTarget
  );
}

export function sameRealPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

function readdirSafe(path: string): readonly string[] {
  return existsSync(path) ? [...new Set(readdirSync(path))].sort((a, b) => a.localeCompare(b)) : [];
}

function copyTreeSafe(source: string, destination: string): void {
  const file = lstatSync(source);
  if (file.isSymbolicLink()) throw new Error("portable payload contains unsafe links");
  if (file.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSafe(source))
      copyTreeSafe(join(source, entry), join(destination, entry));
    return;
  }
  if (!file.isFile()) throw new Error("portable payload contains unsupported filesystem entries");
  if (file.nlink > 1) throw new Error("portable payload contains unsafe links");
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function promoteToManaged(
  target: PortableTarget,
  source: PortableLayout,
  managedRoot: string,
  stateDir: string,
  dryRun: boolean,
): PortableLayout {
  assertManagedRootAllowed(managedRoot, stateDir, target);
  if (sameRealPath(source.installRoot, managedRoot)) return source;
  if (existsSync(managedRoot)) throw new Error("managed install root already exists");
  if (dryRun) return layoutFor(target, managedRoot);
  mkdirSync(dirname(managedRoot), { recursive: true, mode: 0o755 });
  const stagingRoot = mkdtempSync(join(dirname(managedRoot), ".keiko-portable-setup-"));
  const stagedTarget = join(stagingRoot, basename(managedRoot));
  try {
    copyTreeSafe(source.installRoot, stagedTarget);
    renameSync(stagedTarget, managedRoot);
    return layoutFor(target, managedRoot);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export function validatePortableRoot(target: PortableTarget, root: string): ValidatedPortableRoot {
  const layout = layoutFor(target, root);
  if (!existsSync(layout.setupManifestPath))
    throw new Error("portable setup manifest is unavailable");
  const manifest = parseSetupManifest(layout.setupManifestPath);
  validateSetupManifest(manifest, target);
  validateLayout(layout, manifest);
  return { layout, manifest };
}

function createPortableUpgradePaths(
  target: PortableTarget,
  managedRoot: string,
  stateDir: string,
): PortableUpgradePaths {
  assertManagedRootAllowed(managedRoot, stateDir, target);
  const parent = dirname(managedRoot);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  const stagingRoot = mkdtempSync(join(parent, ".keiko-portable-upgrade-"));
  const backupRoot = mkdtempSync(join(parent, ".keiko-previous-"));
  return {
    managedRoot,
    stagingRoot,
    stagedTarget: join(stagingRoot, basename(managedRoot)),
    backupRoot,
    backupTarget: join(backupRoot, basename(managedRoot)),
  };
}

function restoreManagedUpgrade(
  paths: PortableUpgradePaths,
  promoted: boolean,
): { readonly restored: true } | { readonly restored: false; readonly cause: unknown } {
  try {
    if (promoted) rmSync(paths.managedRoot, { recursive: true, force: true });
    if (existsSync(paths.backupTarget) && !existsSync(paths.managedRoot)) {
      renameSync(paths.backupTarget, paths.managedRoot);
    }
    if (!existsSync(paths.managedRoot) || existsSync(paths.backupTarget)) {
      return { restored: false, cause: new Error("portable rollback could not be verified") };
    }
    return { restored: true };
  } catch (error) {
    return { restored: false, cause: error };
  }
}

function cleanupPortableUpgrade(paths: PortableUpgradePaths, removeBackup: boolean): void {
  rmSync(paths.stagingRoot, { recursive: true, force: true });
  if (removeBackup) rmSync(paths.backupRoot, { recursive: true, force: true });
}

function promoteStagedUpgrade(
  input: PortableManagedReplacementInput,
  stagedSource: ValidatedPortableRoot,
  paths: PortableUpgradePaths,
  verifyCurrent?: () => void,
): PortableLayout {
  let moved = false;
  let promoted = false;
  try {
    if (verifyCurrent !== undefined) verifyCurrent();
    renameSync(paths.managedRoot, paths.backupTarget);
    moved = true;
    renameSync(paths.stagedTarget, paths.managedRoot);
    promoted = true;
    const layout = layoutFor(input.target, paths.managedRoot);
    finalizeManagedSetup(
      {
        target: input.target,
        portableRoot: input.source.layout.installRoot,
        managedRoot: input.managedRoot,
        stateDir: input.stateDir,
        dryRun: false,
        env: input.env,
        home: input.home,
      },
      layout,
      stagedSource.manifest,
      input.now,
    );
    return layout;
  } catch (error) {
    if (moved) {
      const rollback = restoreManagedUpgrade(paths, promoted);
      if (!rollback.restored) {
        throw new PortableUpgradeRollbackError(paths.backupRoot, error, rollback.cause);
      }
    }
    throw error;
  }
}

function recoverFailedManagedInstall(
  input: PortableManagedReplacementInput,
  verifyCurrent: () => void,
): PortableLayout {
  const paths = createPortableUpgradePaths(input.target, input.managedRoot, input.stateDir);
  let removeBackup = true;
  try {
    copyTreeSafe(input.source.layout.installRoot, paths.stagedTarget);
    const stagedSource = validatePortableRoot(input.target, paths.stagedTarget);
    return promoteStagedUpgrade(input, stagedSource, paths, verifyCurrent);
  } catch (error) {
    if (error instanceof PortableUpgradeRollbackError) removeBackup = false;
    throw error;
  } finally {
    cleanupPortableUpgrade(paths, removeBackup);
  }
}

export function upgradeManagedInstall(input: PortableManagedUpgradeInput): PortableLayout {
  assertManagedRootAllowed(input.managedRoot, input.stateDir, input.target);
  return withPortableSetupLocks(input, () => upgradeLockedManagedInstall(input));
}

function upgradeLockedManagedInstall(input: PortableManagedUpgradeInput): PortableLayout {
  requireAttestedManagedUpgradeCurrent(input);
  const paths = createPortableUpgradePaths(input.target, input.managedRoot, input.stateDir);
  let removeBackup = true;
  try {
    copyTreeSafe(input.source.layout.installRoot, paths.stagedTarget);
    const stagedSource = validatePortableRoot(input.target, paths.stagedTarget);
    const verifyCurrent = (): void => {
      requireAttestedManagedUpgradeCurrent(input);
    };
    return promoteStagedUpgrade(input, stagedSource, paths, verifyCurrent);
  } catch (error) {
    if (error instanceof PortableUpgradeRollbackError) removeBackup = false;
    throw error;
  } finally {
    cleanupPortableUpgrade(paths, removeBackup);
  }
}

function requireAttestedManagedUpgradeCurrent(
  input: PortableManagedUpgradeInput,
): ValidatedPortableRoot {
  const current = attestedRecordedManagedInstall(input.managedRoot, input.stateDir);
  if (current === undefined || inspectPortableManagedInstall(current.layout).issues.length > 0) {
    throw new Error("portable managed install changed before upgrade");
  }
  if (!portableSourceCanReplaceManaged(input.source, current)) {
    throw new Error("portable upgrade candidate must be newer than or target-corrective");
  }
  return current;
}

export function attestedManagedInstall(
  target: PortableTarget,
  managedRoot: string,
  stateDir: string,
): ValidatedPortableRoot | undefined {
  const registration = readManagedRegistration(stateDir);
  if (registration?.platformTarget !== target) return undefined;
  return attestedManagedLayout(registration, managedRoot, stateDir);
}

export function attestedRecordedManagedInstall(
  managedRoot: string,
  stateDir: string,
): ValidatedPortableRoot | undefined {
  const registration = readManagedRegistration(stateDir);
  if (registration === undefined) return undefined;
  return attestedManagedLayout(registration, managedRoot, stateDir);
}

export function attestedExistingPortableInstall(
  managedRoot: string,
  stateDir: string,
): ValidatedPortableRoot | undefined {
  for (const target of PORTABLE_TARGETS) {
    if (!managedRootAllowedForTarget(managedRoot, stateDir, target)) continue;
    const attested = attestedPortableRootForTarget(target, managedRoot);
    if (attested !== undefined) return attested;
  }
  return undefined;
}

function managedRootAllowedForTarget(
  managedRoot: string,
  stateDir: string,
  target: PortableTarget,
): boolean {
  try {
    assertManagedRootAllowed(managedRoot, stateDir, target);
    return true;
  } catch {
    return false;
  }
}

function attestedPortableRootForTarget(
  target: PortableTarget,
  managedRoot: string,
): ValidatedPortableRoot | undefined {
  if (!isPortableTarget(target)) return undefined;
  try {
    return validatePortableRoot(target, managedRoot);
  } catch {
    return undefined;
  }
}

export function attestedManagedRoot(
  target: PortableTarget,
  managedRoot: string,
  stateDir: string,
): PortableLayout | undefined {
  return attestedManagedInstall(target, managedRoot, stateDir)?.layout;
}

interface SetupPortableOptions {
  readonly target: PortableTarget;
  readonly portableRoot: string;
  readonly managedRoot: string;
  readonly stateDir: string;
  readonly dryRun: boolean;
  readonly env: EnvSource;
  readonly home: string;
}

const SILENT_IO: CliIo = {
  out: (_text: string): void => undefined,
  err: (_text: string): void => undefined,
};

function finalizeManagedSetup(
  options: SetupPortableOptions,
  layout: PortableLayout,
  manifest: SetupManifest,
  now: Date,
): void {
  validatePortableRoot(options.target, layout.installRoot);
  installNativeRegistration(layout, options.target, options.managedRoot, options.env, options.home);
  writeManagedRegistration({
    stateDir: options.stateDir,
    layout,
    manifest,
    env: options.env,
    home: options.home,
    now,
  });
}

function rollbackManagedSetup(layout: PortableLayout): void {
  try {
    removePortableManagedInstall(layout, SILENT_IO, false);
  } catch {
    // Best-effort rollback: setup still records a fail-closed state.
  }
}

function recordFailedSetup(options: SetupPortableOptions, now: Date, message: string): void {
  try {
    writeFailedRegistration(options.target, options.stateDir, now, message);
  } catch {
    // Refusing a symlinked state file must not turn setup failure into unsafe overwrite logic.
  }
}

function sameInstallRegistration(
  left: PortableInstallRegistration | undefined,
  right: PortableInstallRegistration | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function recordPreLockSetupFailure(
  options: SetupPortableOptions,
  registrationBeforeSetup: PortableInstallRegistration | undefined,
  now: Date,
  message: string,
): void {
  if (registrationBeforeSetup?.status === "managed") return;
  let managedRootAllowed = true;
  try {
    assertManagedRootAllowed(options.managedRoot, options.stateDir, options.target);
  } catch {
    managedRootAllowed = false;
  }
  try {
    const record = (): void => {
      const current = readPortableInstallRegistration(options.stateDir);
      if (!sameInstallRegistration(current, registrationBeforeSetup)) return;
      recordFailedSetup(options, now, message);
    };
    if (managedRootAllowed) withPortableSetupLocks(options, record);
    else withPortableStateSetupLock(options.stateDir, record);
  } catch {
    // A concurrent owner or unsafe lock state takes precedence over recording stale failure state.
  }
}

function assertSamePathSetupAttested(options: SetupPortableOptions): void {
  const sourceInstallRoot = layoutFor(options.target, options.portableRoot).installRoot;
  if (!sameRealPath(sourceInstallRoot, options.managedRoot)) return;
  if (attestedManagedInstall(options.target, options.managedRoot, options.stateDir) !== undefined) {
    return;
  }
  // Owner-approved in-place adoption (0.3.0-beta.1): the canonical macOS install gesture drags
  // the bundle to /Applications BEFORE the first launch, so a pristine state dir plus a root that
  // passes full validation is a first run, not an attack. The #2966 pin is relocated, not
  // relaxed: adoption never happens over an EXISTING registration — re-binding a recorded install
  // identity to different bytes at the same path stays refused below, which is exactly what
  // detects post-attestation tampering — and validation is never waived, because setup continues
  // into validatePortableRoot and attests only what passes it.
  if (readPortableInstallRegistration(options.stateDir) === undefined) return;
  throw new Error("existing same-path managed install root is not attested");
}

export function recoverableFailedManagedRoot(
  target: PortableTarget,
  managedRoot: string,
  stateDir: string,
): string | undefined {
  return attestedFailedManagedInstall(target, managedRoot, stateDir)?.layout.installRoot;
}

function failedManagedAttestation(
  registration: FailedSetupRegistration,
): ManagedSetupRegistration | undefined {
  if (
    registration.installRootPlatformTarget === undefined ||
    registration.setupManifestSha256 === undefined ||
    registration.installRootIdentitySha256 === undefined ||
    registration.launcherIdentitySha256 === undefined
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    status: "managed",
    updateEligible: true,
    platformTarget: registration.installRootPlatformTarget,
    packageVersion: registration.packageVersion,
    stable: registration.stable,
    setupManifestSha256: registration.setupManifestSha256,
    installRootIdentitySha256: registration.installRootIdentitySha256,
    launcherIdentitySha256: registration.launcherIdentitySha256,
    updatedAt: registration.updatedAt,
  };
}

function attestedFailedManagedInstall(
  target: PortableTarget,
  managedRoot: string,
  stateDir: string,
): ValidatedPortableRoot | undefined {
  const registration = readPortableInstallRegistration(stateDir);
  if (registration?.status !== "setup-failed" || registration.platformTarget !== target)
    return undefined;
  const attestation = failedManagedAttestation(registration);
  if (attestation === undefined) return undefined;
  try {
    assertManagedRootAllowed(managedRoot, stateDir, attestation.platformTarget);
    const current = validatePortableRoot(attestation.platformTarget, managedRoot);
    if (!registrationMatches(attestation, current.layout, current.manifest)) return undefined;
    if (inspectPortableManagedInstall(current.layout).issues.length > 0) return undefined;
    return current;
  } catch {
    return undefined;
  }
}

export function recoverableFailedWindowsManagedRoot(
  stateDir: string,
  env: EnvSource,
  home: string,
): string | undefined {
  const registeredExe = parseWindowsStartMenuRegistration(
    windowsStartMenuRegistrationPath(env, home),
  );
  if (registeredExe === undefined) return undefined;
  return recoverableFailedManagedRoot("windows-x64", dirname(registeredExe), stateDir);
}

function canRecoverFailedManagedInstall(options: SetupPortableOptions): boolean {
  if (!existsSync(options.managedRoot)) return false;
  return (
    recoverableFailedManagedRoot(options.target, options.managedRoot, options.stateDir) !==
    undefined
  );
}

export interface PortableMutationLockOptions {
  readonly target: PortableTarget;
  readonly managedRoot: string;
  readonly stateDir: string;
}

export function portableManagedSetupLockPath(target: PortableTarget, managedRoot: string): string {
  // Lock identity must not change when the managed root appears between concurrent callers.
  // Root policy rejects symlinked ancestors before mutation, so lexical normalization is both
  // deterministic and aligned with the path that callers were authorized to manage.
  const canonicalRoot = resolve(managedRoot);
  const identity = target === "windows-x64" ? canonicalRoot.toLowerCase() : canonicalRoot;
  const digest = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 24);
  return join(dirname(canonicalRoot), `.keiko-portable-setup-${digest}.lock`);
}

function portableSetupLockPaths(options: PortableMutationLockOptions): readonly string[] {
  return [
    ...new Set([
      join(options.stateDir, PORTABLE_SETUP_LOCK),
      portableManagedSetupLockPath(options.target, options.managedRoot),
    ]),
  ].sort(comparePortableSetupLockPaths);
}

function comparePortableSetupLockPaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

const PORTABLE_SETUP_LOCK_OWNER = "owner.json";
const OWNERLESS_STALE_LOCK_MS = 30 * 60 * 1000;

interface PortableSetupLockOwner {
  readonly schemaVersion: 1;
  readonly pid: number;
}

function portableSetupLockOwnerValue(value: unknown): PortableSetupLockOwner | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("schemaVersion" in value) || value.schemaVersion !== 1) return undefined;
  if (!("pid" in value) || typeof value.pid !== "number") return undefined;
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return undefined;
  return value as PortableSetupLockOwner;
}

function portableSetupLockOwnerPath(path: string): string | undefined {
  const entries = readdirSync(path);
  if (entries.length !== 1 || entries[0] !== PORTABLE_SETUP_LOCK_OWNER) return undefined;
  const ownerPath = join(path, PORTABLE_SETUP_LOCK_OWNER);
  const ownerStat = lstatSync(ownerPath);
  if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) return undefined;
  if (ownerStat.nlink !== 1 || ownerStat.size > 1024) return undefined;
  return ownerPath;
}

function readPortableSetupLockOwner(path: string): PortableSetupLockOwner | undefined {
  try {
    const ownerPath = portableSetupLockOwnerPath(path);
    if (ownerPath === undefined) return undefined;
    const value = JSON.parse(readFileSync(ownerPath, "utf8")) as unknown;
    return portableSetupLockOwnerValue(value);
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

interface StalePortableSetupLock {
  readonly device: number;
  readonly inode: number;
  readonly kind: "dead-owner" | "ownerless";
}

function stalePortableSetupLock(path: string): StalePortableSetupLock | undefined {
  const pathStat = lstatSync(path);
  if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) return undefined;
  const entries = readdirSync(path);
  if (entries.length === 0) {
    if (Date.now() - pathStat.mtimeMs < OWNERLESS_STALE_LOCK_MS) return undefined;
    return { device: pathStat.dev, inode: pathStat.ino, kind: "ownerless" };
  }
  const owner = readPortableSetupLockOwner(path);
  if (owner === undefined || processIsAlive(owner.pid)) return undefined;
  return { device: pathStat.dev, inode: pathStat.ino, kind: "dead-owner" };
}

function samePortableSetupLock(
  left: StalePortableSetupLock,
  right: StalePortableSetupLock,
): boolean {
  return left.device === right.device && left.inode === right.inode && left.kind === right.kind;
}

function restoreClaimedPortableSetupLock(claimedPath: string, path: string): void {
  try {
    renameSync(claimedPath, path);
  } catch {
    // Preserve the claimed directory when the canonical path was concurrently recreated.
  }
}

function reclaimPortableSetupLock(path: string): boolean {
  const claimedPath = `${path}.reclaim-${String(process.pid)}-${randomUUID()}`;
  let stale: StalePortableSetupLock;
  try {
    const inspected = stalePortableSetupLock(path);
    if (inspected === undefined) return false;
    stale = inspected;
    renameSync(path, claimedPath);
  } catch {
    return false;
  }
  try {
    const claimed = stalePortableSetupLock(claimedPath);
    if (claimed === undefined || !samePortableSetupLock(stale, claimed)) {
      restoreClaimedPortableSetupLock(claimedPath, path);
      return false;
    }
    if (claimed.kind === "dead-owner") {
      rmSync(join(claimedPath, PORTABLE_SETUP_LOCK_OWNER), { force: true });
    }
    rmdirSync(claimedPath);
    return true;
  } catch {
    restoreClaimedPortableSetupLock(claimedPath, path);
    return false;
  }
}

function createPortableSetupLock(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  try {
    writeFileSync(
      join(path, PORTABLE_SETUP_LOCK_OWNER),
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    try {
      rmdirSync(path);
    } catch {
      // Preserve an unexpected replacement rather than deleting it recursively.
    }
    throw error;
  }
}

function acquirePortableSetupLock(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    createPortableSetupLock(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (!reclaimPortableSetupLock(path)) throw new PortableSetupBusyError();
      try {
        createPortableSetupLock(path);
        return;
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code === "EEXIST") {
          throw new PortableSetupBusyError();
        }
        throw retryError;
      }
    }
    throw error;
  }
}

function releasePortableSetupLocks(paths: readonly string[]): void {
  for (const path of [...paths].reverse()) {
    try {
      const owner = readPortableSetupLockOwner(path);
      if (owner?.pid !== process.pid) continue;
      rmSync(join(path, PORTABLE_SETUP_LOCK_OWNER), { force: true });
      rmdirSync(path);
    } catch {
      // Refuse to recursively remove a replaced or non-empty lock artifact.
    }
  }
}

function acquirePortableSetupLocks(options: PortableMutationLockOptions): readonly string[] {
  const acquired: string[] = [];
  try {
    for (const path of portableSetupLockPaths(options)) {
      acquirePortableSetupLock(path);
      acquired.push(path);
    }
    return acquired;
  } catch (error) {
    releasePortableSetupLocks(acquired);
    throw error;
  }
}

function withPortableSetupLocks<T>(options: PortableMutationLockOptions, operation: () => T): T {
  const acquired = acquirePortableSetupLocks(options);
  try {
    return operation();
  } finally {
    releasePortableSetupLocks(acquired);
  }
}

function withPortableStateSetupLock<T>(stateDir: string, operation: () => T): T {
  const path = join(stateDir, PORTABLE_SETUP_LOCK);
  acquirePortableSetupLock(path);
  try {
    return operation();
  } finally {
    releasePortableSetupLocks([path]);
  }
}

export type PortableManagedUpgradeFn = (input: PortableManagedUpgradeInput) => PortableLayout;

export async function withPortableManagedMutation<T>(
  options: PortableMutationLockOptions,
  operation: (upgrade: PortableManagedUpgradeFn) => Promise<T>,
): Promise<T> {
  const acquired = acquirePortableSetupLocks(options);
  const expectedLocks = portableSetupLockPaths(options);
  let active = true;
  const upgrade: PortableManagedUpgradeFn = (input) => {
    if (!active) throw new Error("portable upgrade lock capability is no longer active");
    const inputLocks = portableSetupLockPaths(input);
    if (
      inputLocks.length !== expectedLocks.length ||
      inputLocks.some((path, index) => path !== expectedLocks[index])
    ) {
      throw new Error("portable upgrade lock scope does not match the managed install");
    }
    return upgradeLockedManagedInstall(input);
  };
  try {
    return await operation(upgrade);
  } finally {
    active = false;
    releasePortableSetupLocks(acquired);
  }
}

function assertFailedSetupRecoveryBound(options: SetupPortableOptions): void {
  const registration = readPortableInstallRegistration(options.stateDir);
  if (registration?.status !== "setup-failed") return;
  if (registration.platformTarget !== options.target) {
    throw new Error("failed managed install target does not match the requested target");
  }
  if (
    registration.installRootIdentitySha256 !== undefined &&
    existsSync(options.managedRoot) &&
    !canRecoverFailedManagedInstall(options)
  ) {
    throw new Error("failed managed install root does not match its recorded identity");
  }
}

interface PreparedPortableSetup {
  readonly layout: PortableLayout;
  readonly createdManagedInstall: boolean;
  readonly message: string;
}

function validateExistingManagedSetup(
  options: SetupPortableOptions,
  source: ValidatedPortableRoot,
  now: Date,
): PreparedPortableSetup | undefined {
  if (options.dryRun || sameRealPath(source.layout.installRoot, options.managedRoot)) {
    return undefined;
  }
  const existing = attestedManagedInstall(options.target, options.managedRoot, options.stateDir);
  if (existing === undefined) return undefined;
  try {
    finalizeManagedSetup(options, existing.layout, existing.manifest, now);
  } catch (error) {
    throw new PortableManagedRegistrationRepairError(error);
  }
  return {
    layout: existing.layout,
    createdManagedInstall: false,
    message: "Keiko portable setup validated at managed root.\n",
  };
}

function recoverBoundFailedSetup(
  options: SetupPortableOptions,
  source: ValidatedPortableRoot,
  now: Date,
): PreparedPortableSetup | undefined {
  if (
    options.dryRun ||
    sameRealPath(source.layout.installRoot, options.managedRoot) ||
    !canRecoverFailedManagedInstall(options)
  ) {
    return undefined;
  }
  return recoverLockedFailedSetup(options, source, now);
}

function recoverLockedFailedSetup(
  options: SetupPortableOptions,
  source: ValidatedPortableRoot,
  now: Date,
): PreparedPortableSetup {
  const current = requireAttestedFailedManagedInstall(options);
  if (compareStableVersions(source.manifest.packageVersion, current.manifest.packageVersion) < 0) {
    throw new Error("portable recovery candidate must not be older than the managed install");
  }
  const verifyCurrent = (): void => {
    requireAttestedFailedManagedInstall(options);
  };
  return {
    layout: recoverFailedManagedInstall({ ...options, source, now }, verifyCurrent),
    createdManagedInstall: false,
    message: "Keiko portable setup recovered at managed root.\n",
  };
}

function requireAttestedFailedManagedInstall(options: SetupPortableOptions): ValidatedPortableRoot {
  const current = attestedFailedManagedInstall(
    options.target,
    options.managedRoot,
    options.stateDir,
  );
  if (current === undefined) throw new Error("failed managed install changed during recovery");
  return current;
}

function preparePortableSetup(
  options: SetupPortableOptions,
  source: ValidatedPortableRoot,
  now: Date,
): PreparedPortableSetup {
  const existing = validateExistingManagedSetup(options, source, now);
  if (existing !== undefined) return existing;
  const recovered = recoverBoundFailedSetup(options, source, now);
  if (recovered !== undefined) return recovered;
  const layout = promoteToManaged(
    options.target,
    source.layout,
    options.managedRoot,
    options.stateDir,
    options.dryRun,
  );
  const createdManagedInstall =
    !options.dryRun && !sameRealPath(source.layout.installRoot, layout.installRoot);
  try {
    if (!options.dryRun) finalizeManagedSetup(options, layout, source.manifest, now);
  } catch (error) {
    if (createdManagedInstall) rollbackManagedSetup(layout);
    throw error;
  }
  return {
    layout,
    createdManagedInstall,
    message: `Keiko portable setup ready at ${options.dryRun ? "planned managed root" : "managed root"}.\n`,
  };
}

export function setupPortable(
  options: SetupPortableOptions,
  io: CliIo,
  now: Date,
): { readonly code: number; readonly layout: PortableLayout | undefined } {
  let managedLayout: PortableLayout | undefined;
  let createdManagedInstall = false;
  let registrationBeforeSetup: PortableInstallRegistration | undefined;
  try {
    registrationBeforeSetup = readPortableInstallRegistration(options.stateDir);
    assertSamePathSetupAttested(options);
    const source = validatePortableRoot(options.target, options.portableRoot);
    assertManagedRootAllowed(options.managedRoot, options.stateDir, options.target);
    assertFailedSetupRecoveryBound(options);
    const prepared = options.dryRun
      ? preparePortableSetup(options, source, now)
      : withPortableSetupLocks(options, () => {
          try {
            return preparePortableSetup(options, source, now);
          } catch (error) {
            const original =
              error instanceof PortableManagedRegistrationRepairError ? error.original : error;
            const message = original instanceof Error ? original.message : "portable setup failed";
            if (!(error instanceof PortableManagedRegistrationRepairError)) {
              recordFailedSetup(options, now, message);
            }
            throw new PortableSetupFailureRecordedError(original);
          }
        });
    managedLayout = prepared.layout;
    createdManagedInstall = prepared.createdManagedInstall;
    io.out(prepared.message);
    return { code: 0, layout: managedLayout };
  } catch (error) {
    const original = error instanceof PortableSetupFailureRecordedError ? error.original : error;
    const message = original instanceof Error ? original.message : "portable setup failed";
    if (createdManagedInstall && managedLayout !== undefined) rollbackManagedSetup(managedLayout);
    if (
      !options.dryRun &&
      !(error instanceof PortableSetupFailureRecordedError) &&
      !(original instanceof PortableSetupBusyError)
    ) {
      recordPreLockSetupFailure(options, registrationBeforeSetup, now, message);
    }
    io.err(`keiko portable setup: ${message}\n`);
    return { code: 1, layout: undefined };
  }
}

function candidateManagedRoots(
  registration: PortableInstallRegistration,
  env: EnvSource,
  home: string,
): readonly string[] {
  const target = registration.platformTarget;
  const roots = new Set<string>([defaultManagedRoot(target, env, home)]);
  const hintedRoot = resolveManagedRootLocator(registration, home);
  if (hintedRoot !== undefined) roots.add(hintedRoot);
  if (target !== "windows-x64") return [...roots];
  const registeredExe = parseWindowsStartMenuRegistration(
    windowsStartMenuRegistrationPath(env, home),
  );
  if (registeredExe !== undefined) {
    roots.add(dirname(registeredExe));
  }
  return [...roots];
}

function resolveManagedRootLocator(
  registration: PortableInstallRegistration,
  home: string,
): string | undefined {
  if (registration.status !== "managed") return undefined;
  return resolveManagedRootPath(registration.managedRootLocator, home);
}

function resolveManagedRootPath(
  locator: ManagedRootLocator | undefined,
  home: string,
): string | undefined {
  if (locator === undefined || locator.kind === "default") return undefined;
  return locator.kind === "home-relative" ? resolve(home, locator.path) : resolve(locator.path);
}

function attestedManagedLayout(
  registration: ManagedSetupRegistration,
  managedRoot: string,
  stateDir: string,
): { readonly layout: PortableLayout; readonly manifest: SetupManifest } | undefined {
  try {
    assertManagedRootAllowed(managedRoot, stateDir, registration.platformTarget);
    const { layout, manifest } = validatePortableRoot(registration.platformTarget, managedRoot);
    return registrationMatches(registration, layout, manifest) ? { layout, manifest } : undefined;
  } catch {
    return undefined;
  }
}

export function attestedPortableInstallRecord(
  stateDir: string,
  env: EnvSource,
  home: string,
):
  | {
      readonly registration: PortableInstallRegistration;
      readonly target: PortableTarget;
      readonly managedRoot: string | undefined;
      readonly layout: PortableLayout | undefined;
      readonly manifest: SetupManifest | undefined;
    }
  | undefined {
  const registration = readPortableInstallRegistration(stateDir);
  if (registration === undefined) return undefined;
  if (registration.status !== "managed") {
    return {
      registration,
      target: registration.platformTarget,
      managedRoot: undefined,
      layout: undefined,
      manifest: undefined,
    };
  }
  for (const managedRoot of candidateManagedRoots(registration, env, home)) {
    const attested = attestedManagedLayout(registration, managedRoot, stateDir);
    if (attested !== undefined) {
      return {
        registration,
        target: registration.platformTarget,
        managedRoot,
        layout: attested.layout,
        manifest: attested.manifest,
      };
    }
  }
  return {
    registration,
    target: registration.platformTarget,
    managedRoot: undefined,
    layout: undefined,
    manifest: undefined,
  };
}

export function spawnManagedLauncher(layout: PortableLayout, spawnFn: SpawnFn): void {
  const child = spawnFn(layout.primaryLauncherPath, [], { detached: true, stdio: "ignore" });
  child.unref();
}

export function statusPortable(
  options: {
    readonly target: PortableTarget;
    readonly portableRoot: string;
    readonly managedRoot: string;
    readonly stateDir: string;
  },
  io: CliIo,
): number {
  try {
    const { layout, manifest } = validatePortableRoot(options.target, options.portableRoot);
    const managedLayout = attestedManagedRoot(
      options.target,
      options.managedRoot,
      options.stateDir,
    );
    const status: SetupStatus =
      managedLayout !== undefined && sameRealPath(layout.installRoot, managedLayout.installRoot)
        ? "managed"
        : "unmanaged";
    io.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          status,
          updateEligible: status === "managed",
          platformTarget: manifest.platformTarget,
          packageVersion: manifest.packageVersion,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  } catch (error) {
    io.err(`keiko portable status: ${error instanceof Error ? error.message : "unavailable"}\n`);
    return 1;
  }
}
