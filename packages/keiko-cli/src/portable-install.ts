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
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
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
  installUserLocalRegistration,
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

const STABLE_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const PORTABLE_TARGETS = ["windows-x64", "macos-arm64", "macos-x64"] as const;

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
    throw new Error("portable setup manifest package fields are malformed");
  }
  if (typeof stable !== "boolean" || typeof bootstrapUpdateEligible !== "boolean") {
    throw new Error("portable setup manifest state flags are malformed");
  }
  if (typeof primaryLauncher !== "string") {
    throw new Error("portable setup manifest launcher field is malformed");
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
  assertManagedRootAllowed(managedRoot, stateDir);
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

function createPortableUpgradePaths(managedRoot: string, stateDir: string): PortableUpgradePaths {
  assertManagedRootAllowed(managedRoot, stateDir);
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

function restoreManagedUpgrade(paths: PortableUpgradePaths, promoted: boolean): void {
  if (promoted) rmSync(paths.managedRoot, { recursive: true, force: true });
  if (existsSync(paths.backupTarget) && !existsSync(paths.managedRoot)) {
    renameSync(paths.backupTarget, paths.managedRoot);
  }
}

function cleanupPortableUpgrade(paths: PortableUpgradePaths): void {
  rmSync(paths.stagingRoot, { recursive: true, force: true });
  rmSync(paths.backupRoot, { recursive: true, force: true });
}

function promoteStagedUpgrade(
  input: PortableManagedUpgradeInput,
  stagedSource: ValidatedPortableRoot,
  paths: PortableUpgradePaths,
): PortableLayout {
  let moved = false;
  let promoted = false;
  try {
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
    if (moved) restoreManagedUpgrade(paths, promoted);
    throw error;
  }
}

export function upgradeManagedInstall(input: PortableManagedUpgradeInput): PortableLayout {
  if (!portableSourceCanReplaceManaged(input.source, input.current)) {
    throw new Error("portable upgrade candidate must be newer than or target-corrective");
  }
  const paths = createPortableUpgradePaths(input.managedRoot, input.stateDir);
  try {
    copyTreeSafe(input.source.layout.installRoot, paths.stagedTarget);
    const stagedSource = validatePortableRoot(input.target, paths.stagedTarget);
    return promoteStagedUpgrade(input, stagedSource, paths);
  } finally {
    cleanupPortableUpgrade(paths);
  }
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
  try {
    assertManagedRootAllowed(managedRoot, stateDir);
    for (const target of PORTABLE_TARGETS) {
      const attested = attestedPortableRootForTarget(target, managedRoot);
      if (attested !== undefined) return attested;
    }
    return undefined;
  } catch {
    return undefined;
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
  installUserLocalRegistration(
    layout,
    options.target,
    options.managedRoot,
    options.env,
    options.home,
  );
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

export function setupPortable(
  options: SetupPortableOptions,
  io: CliIo,
  now: Date,
): { readonly code: number; readonly layout: PortableLayout | undefined } {
  let managedLayout: PortableLayout | undefined;
  let createdManagedInstall = false;
  try {
    const source = validatePortableRoot(options.target, options.portableRoot);
    managedLayout = promoteToManaged(
      options.target,
      source.layout,
      options.managedRoot,
      options.stateDir,
      options.dryRun,
    );
    createdManagedInstall =
      !options.dryRun && !sameRealPath(source.layout.installRoot, managedLayout.installRoot);
    if (!options.dryRun) finalizeManagedSetup(options, managedLayout, source.manifest, now);
    io.out(
      `Keiko portable setup ready at ${options.dryRun ? "planned managed root" : "managed root"}.\n`,
    );
    return { code: 0, layout: managedLayout };
  } catch (error) {
    const message = error instanceof Error ? error.message : "portable setup failed";
    if (createdManagedInstall && managedLayout !== undefined) rollbackManagedSetup(managedLayout);
    if (!options.dryRun) recordFailedSetup(options, now, message);
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
    assertManagedRootAllowed(managedRoot, stateDir);
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
