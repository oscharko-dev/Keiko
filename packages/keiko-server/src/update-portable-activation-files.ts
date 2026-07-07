import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
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

const REGISTRATION_FILE = "portable-install-state.json";
const WINDOWS_SHORTCUT_SAFE_PATH = /^[A-Za-z0-9_@ .()\-./\\:]+$/u;

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

function activationPaths(
  input: PortableActivationFileInput,
  activationId: string,
): PortableActivationPaths {
  const managedRoot = managedRootFromPackageRoot(
    input.stage.target,
    input.runtimeFacts?.packageRoot,
  );
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
  const stageRoot = join(parent, PORTABLE_STAGE_DIR_PREFIX, input.stage.stageId);
  const candidateRoot =
    input.stage.target === "windows-x64"
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

function restoreManagedRoot(paths: PortableActivationPaths, promoted: boolean): void {
  if (promoted) rmSync(paths.managedRoot, { recursive: true, force: true });
  if (existsSync(paths.backupRoot) && !existsSync(paths.managedRoot)) {
    renameSync(paths.backupRoot, paths.managedRoot);
  }
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
  let promoted = false;
  try {
    renameSync(paths.managedRoot, paths.backupRoot);
    moved = true;
    renameSync(paths.candidateRoot, paths.managedRoot);
    promoted = true;
    return validateLayout(target, paths.managedRoot, targetVersion);
  } catch (error) {
    if (moved) restoreManagedRoot(paths, promoted);
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
  const path = join(input.stateDir, REGISTRATION_FILE);
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
  restoreManagedRoot(paths, true);
}
