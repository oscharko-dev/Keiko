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

export function sameRealPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

function readdirSafe(path: string): readonly string[] {
  return existsSync(path) ? [...new Set(readdirSync(path))].sort() : [];
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

export function validatePortableRoot(
  target: PortableTarget,
  root: string,
): { readonly layout: PortableLayout; readonly manifest: SetupManifest } {
  const layout = layoutFor(target, root);
  if (!existsSync(layout.setupManifestPath))
    throw new Error("portable setup manifest is unavailable");
  const manifest = parseSetupManifest(layout.setupManifestPath);
  validateSetupManifest(manifest, target);
  validateLayout(layout, manifest);
  return { layout, manifest };
}

export function attestedManagedRoot(
  target: PortableTarget,
  managedRoot: string,
  stateDir: string,
): PortableLayout | undefined {
  try {
    const { layout, manifest } = validatePortableRoot(target, managedRoot);
    const registration = readManagedRegistration(stateDir);
    if (registration === undefined) return undefined;
    return registrationMatches(registration, layout, manifest) ? layout : undefined;
  } catch {
    return undefined;
  }
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
    if (!options.dryRun) writeFailedRegistration(options.target, options.stateDir, now, message);
    io.err(`keiko portable setup: ${message}\n`);
    return { code: 1, layout: undefined };
  }
}

function candidateManagedRoots(
  target: PortableTarget,
  env: EnvSource,
  home: string,
): readonly string[] {
  if (target !== "windows-x64") return [defaultManagedRoot(target, env, home)];
  const roots = new Set<string>([defaultManagedRoot(target, env, home)]);
  const registeredExe = parseWindowsStartMenuRegistration(
    windowsStartMenuRegistrationPath(env, home),
  );
  if (registeredExe !== undefined) {
    roots.add(dirname(registeredExe));
  }
  return [...roots];
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
  for (const managedRoot of candidateManagedRoots(registration.platformTarget, env, home)) {
    try {
      const { layout, manifest } = validatePortableRoot(registration.platformTarget, managedRoot);
      if (registrationMatches(registration, layout, manifest)) {
        return { registration, target: registration.platformTarget, managedRoot, layout, manifest };
      }
    } catch {
      // Keep scanning other candidate roots.
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
