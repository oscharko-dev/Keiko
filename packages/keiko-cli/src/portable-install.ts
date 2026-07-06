import { createHash } from "node:crypto";
import {
  chmodSync,
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { CliIo } from "./runner.js";
import {
  layoutFor,
  PACKAGE_NAME,
  primaryLauncherName,
  REGISTRATION_FILE,
  targetRuntime,
  type PortableLayout,
  type PortableTarget,
  type SetupManifest,
  type SetupRuntimeManifest,
  type SetupStatus,
  type SpawnFn,
} from "./portable-shared.js";

interface SetupRegistration {
  readonly schemaVersion: 1;
  readonly status: SetupStatus;
  readonly updateEligible: boolean;
  readonly platformTarget: PortableTarget;
  readonly packageVersion: string;
  readonly stable: boolean;
  readonly setupManifestSha256?: string | undefined;
  readonly installRootIdentitySha256?: string | undefined;
  readonly launcherIdentitySha256?: string | undefined;
  readonly failureReason?: string | undefined;
  readonly updatedAt: string;
}

const SETUP_FAILURE_REASON_PATTERNS = [
  [".keiko runtime state", "managed-root-state-conflict"],
  ["temporary directory", "managed-root-temporary"],
  ["symlink", "managed-root-symlink"],
  ["already exists", "managed-root-exists"],
  ["setup manifest", "setup-manifest-invalid"],
  ["package", "app-package-invalid"],
  ["runtime", "runtime-invalid"],
  ["launcher", "launcher-invalid"],
  ["unsafe links", "portable-payload-links"],
  ["unsupported filesystem", "portable-payload-entry"],
] as const;

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

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

function assertManagedRootAllowed(path: string): void {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/.keiko/") || normalized.endsWith("/.keiko")) {
    throw new Error("managed install root must be separate from .keiko runtime state");
  }
  const tmp = resolve(tmpdir()).replaceAll("\\", "/").toLowerCase();
  if (normalized === tmp || normalized.startsWith(`${tmp}/`)) {
    throw new Error("managed install root must not be inside a temporary directory");
  }
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new Error("managed install root must not be a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function sameRealPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

function writeRegistration(stateDir: string, registration: SetupRegistration): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, REGISTRATION_FILE);
  writeFileSync(path, `${JSON.stringify(registration, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
}

function managedRegistration(input: {
  readonly layout: PortableLayout;
  readonly manifest: SetupManifest;
  readonly now: Date;
}): SetupRegistration {
  const realInstallRoot = realpathSync(input.layout.installRoot);
  return {
    schemaVersion: 1,
    status: "managed",
    updateEligible: true,
    platformTarget: input.manifest.platformTarget,
    packageVersion: input.manifest.packageVersion,
    stable: input.manifest.stable,
    setupManifestSha256: sha256File(input.layout.setupManifestPath),
    installRootIdentitySha256: sha256Text(realInstallRoot),
    launcherIdentitySha256: sha256File(input.layout.primaryLauncherPath),
    updatedAt: input.now.toISOString(),
  };
}

function setupFailureReasonCode(message: string): string {
  const match = SETUP_FAILURE_REASON_PATTERNS.find(([fragment]) => message.includes(fragment));
  return match?.[1] ?? "setup-failed";
}

function failedRegistration(
  target: PortableTarget,
  stateDir: string,
  now: Date,
  failureReason: string,
): void {
  writeRegistration(stateDir, {
    schemaVersion: 1,
    status: "setup-failed",
    updateEligible: false,
    platformTarget: target,
    packageVersion: "unknown",
    stable: false,
    failureReason: setupFailureReasonCode(failureReason),
    updatedAt: now.toISOString(),
  });
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
  dryRun: boolean,
): PortableLayout {
  assertManagedRootAllowed(managedRoot);
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

export function setupPortable(
  options: {
    readonly target: PortableTarget;
    readonly portableRoot: string;
    readonly managedRoot: string;
    readonly stateDir: string;
    readonly dryRun: boolean;
  },
  io: CliIo,
  now: Date,
): { readonly code: number; readonly layout: PortableLayout | undefined } {
  try {
    const source = validatePortableRoot(options.target, options.portableRoot);
    const managedLayout = promoteToManaged(
      options.target,
      source.layout,
      options.managedRoot,
      options.dryRun,
    );
    if (!options.dryRun) validatePortableRoot(options.target, managedLayout.installRoot);
    if (!options.dryRun) {
      writeRegistration(
        options.stateDir,
        managedRegistration({ layout: managedLayout, manifest: source.manifest, now }),
      );
    }
    io.out(
      `Keiko portable setup ready at ${options.dryRun ? "planned managed root" : "managed root"}.\n`,
    );
    return { code: 0, layout: managedLayout };
  } catch (error) {
    const message = error instanceof Error ? error.message : "portable setup failed";
    if (!options.dryRun) failedRegistration(options.target, options.stateDir, now, message);
    io.err(`keiko portable setup: ${message}\n`);
    return { code: 1, layout: undefined };
  }
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
  },
  io: CliIo,
): number {
  try {
    const { layout, manifest } = validatePortableRoot(options.target, options.portableRoot);
    const status: SetupStatus = sameRealPath(layout.installRoot, options.managedRoot)
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
