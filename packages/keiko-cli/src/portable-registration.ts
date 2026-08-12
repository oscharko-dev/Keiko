import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  REGISTRATION_FILE,
  defaultManagedRoot,
  isPortableTarget,
  type PortableLayout,
  type PortableTarget,
  type SetupManifest,
  type SetupStatus,
} from "./portable-shared.js";
import { STAGING_OWNERSHIP_MARKER } from "./state-paths.js";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

interface SetupRegistrationBase {
  readonly schemaVersion: 1;
  readonly status: SetupStatus;
  readonly updateEligible: boolean;
  readonly platformTarget: PortableTarget;
  readonly packageVersion: string;
  readonly stable: boolean;
  readonly updatedAt: string;
}

export interface ManagedSetupRegistration extends SetupRegistrationBase {
  readonly status: "managed";
  readonly updateEligible: true;
  readonly managedRootLocator?: ManagedRootLocator | undefined;
  readonly setupManifestSha256?: string | undefined;
  readonly installRootIdentitySha256?: string | undefined;
  readonly launcherIdentitySha256?: string | undefined;
}

export interface FailedSetupRegistration extends SetupRegistrationBase {
  readonly status: "setup-failed";
  readonly updateEligible: false;
  readonly failureReason?: string | undefined;
  readonly installRootPlatformTarget?: PortableTarget | undefined;
  readonly setupManifestSha256?: string | undefined;
  readonly installRootIdentitySha256?: string | undefined;
  readonly launcherIdentitySha256?: string | undefined;
}

export type PortableInstallRegistration = ManagedSetupRegistration | FailedSetupRegistration;
export type ManagedRootLocator =
  | { readonly kind: "default" }
  | { readonly kind: "home-relative"; readonly path: string }
  | { readonly kind: "absolute-local"; readonly path: string };

const WINDOWS_DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const SHA256_RE = /^[0-9a-f]{64}$/u;

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

export function portableInstallRootIdentitySha256(path: string): string {
  return sha256Text(realpathSync(path));
}

// #KEIKO-0333: fail closed to `undefined` on a truncated / non-JSON registration file
// so a crash mid-write leaves callers with "no registration recorded" instead of a
// thrown SyntaxError. Matches launcher-state.ts loadState's behavior for the sibling
// state file: an unreadable state artifact is a signal, not a crash.
//
// PR-review follow-up: narrow the swallowed failure to JSON.parse's SyntaxError only.
// A filesystem error (EACCES, EMFILE, EIO) is NOT a "no registration" signal — the
// registration may still exist and be authoritative. Callers must see those failures
// so they do not skip managed-update / cleanup behaviour or overwrite retained
// installation attestation while the actual storage failure stays hidden.
function readJson(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRegistrationFileSafe(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("portable install record refuses symlinked state file");
  }
}

function assertStateDirSafe(stateDir: string): void {
  let cursor = resolve(stateDir);
  for (;;) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error("portable install record refuses symlinked state directory");
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function registrationFileExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function hasPortableInstallRegistration(stateDir: string): boolean {
  assertStateDirSafe(stateDir);
  const path = join(stateDir, REGISTRATION_FILE);
  if (!registrationFileExists(path)) return false;
  assertRegistrationFileSafe(path);
  return true;
}

// #KEIKO-0333: write through mkdtemp -> write -> rename so a crash mid-write can never
// leave a truncated registration on disk. Reuses launcher-state.ts saveState's atomic
// idiom so the two state files that live side by side in the same `.keiko` directory
// have consistent durability semantics.
function writeRegistration(stateDir: string, registration: PortableInstallRegistration): void {
  assertStateDirSafe(stateDir);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, REGISTRATION_FILE);
  assertRegistrationFileSafe(path);
  const tmpDir = mkdtempSync(join(stateDir, ".portable-registration-"));
  // PR-review follow-up (KfQ thread 3770583048): mkdtempSync creates 0700 by default on
  // POSIX (glibc mkdtemp) but the guarantee is implementation-defined. Belt-and-suspenders:
  // explicitly chmod the staging directory to 0700 so a hostile umask (or a non-POSIX FS
  // that widened the default) cannot leave the temp readable to other users during the
  // brief writeFileSync → renameSync window.
  try {
    chmodSync(tmpDir, 0o700);
  } catch {
    // Best-effort on non-POSIX filesystems where chmod has no effect.
  }
  // PR-review follow-up (Codex thread 3770922333): drop the ownership marker so
  // state-paths.ts's isMkdtempOwnedDir classifier can distinguish this Keiko staging dir
  // from a customer-created directory that happens to match the same prefix + 6-alphanum
  // shape. Without the marker, `keiko uninstall --state` walks past a look-alike rather
  // than recursively deleting user data.
  try {
    writeFileSync(join(tmpDir, STAGING_OWNERSHIP_MARKER), "", "utf8");
  } catch {
    // Marker write failure is not fatal — the sweep just will not classify this dir as
    // owned if it survives a crash, which is safer than pretending success.
  }
  const tmpFile = join(tmpDir, "registration.json");
  try {
    writeFileSync(tmpFile, `${JSON.stringify(registration, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmpFile, path);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
}

function managedRegistration(input: {
  readonly layout: PortableLayout;
  readonly manifest: SetupManifest;
  readonly env: EnvSource;
  readonly home: string;
  readonly now: Date;
}): ManagedSetupRegistration {
  const realInstallRoot = realpathSync(input.layout.installRoot);
  return {
    schemaVersion: 1,
    status: "managed",
    updateEligible: true,
    platformTarget: input.manifest.platformTarget,
    packageVersion: input.manifest.packageVersion,
    stable: input.manifest.stable,
    managedRootLocator: managedRootLocator(
      input.manifest.platformTarget,
      realInstallRoot,
      input.env,
      input.home,
    ),
    setupManifestSha256: sha256File(input.layout.setupManifestPath),
    installRootIdentitySha256: sha256Text(realInstallRoot),
    launcherIdentitySha256: sha256File(input.layout.primaryLauncherPath),
    updatedAt: input.now.toISOString(),
  };
}

function managedRootLocator(
  target: PortableTarget,
  installRoot: string,
  env: EnvSource,
  home: string,
): ManagedRootLocator {
  const defaultRoot = resolve(defaultManagedRoot(target, env, home));
  if (installRoot === defaultRoot) return { kind: "default" };
  const relativeToHome = relative(resolve(home), installRoot);
  if (
    relativeToHome.length > 0 &&
    !relativeToHome.startsWith("..") &&
    !isAbsolute(relativeToHome)
  ) {
    return { kind: "home-relative", path: relativeToHome };
  }
  return { kind: "absolute-local", path: installRoot };
}

function setupFailureReasonCode(message: string): string {
  const match = SETUP_FAILURE_REASON_PATTERNS.find(([fragment]) => message.includes(fragment));
  return match?.[1] ?? "setup-failed";
}

function retainedInstallAttestation(registration: PortableInstallRegistration | undefined):
  | {
      readonly packageVersion: string;
      readonly stable: boolean;
      readonly installRootPlatformTarget: PortableTarget;
      readonly setupManifestSha256: string;
      readonly installRootIdentitySha256: string;
      readonly launcherIdentitySha256: string;
    }
  | undefined {
  if (registration === undefined) return undefined;
  const installRootPlatformTarget =
    registration.status === "managed"
      ? registration.platformTarget
      : registration.installRootPlatformTarget;
  if (
    installRootPlatformTarget === undefined ||
    registration.setupManifestSha256 === undefined ||
    registration.installRootIdentitySha256 === undefined ||
    registration.launcherIdentitySha256 === undefined
  ) {
    return undefined;
  }
  return {
    packageVersion: registration.packageVersion,
    stable: registration.stable,
    installRootPlatformTarget,
    setupManifestSha256: registration.setupManifestSha256,
    installRootIdentitySha256: registration.installRootIdentitySha256,
    launcherIdentitySha256: registration.launcherIdentitySha256,
  };
}

export function writeManagedRegistration(input: {
  readonly stateDir: string;
  readonly layout: PortableLayout;
  readonly manifest: SetupManifest;
  readonly env: EnvSource;
  readonly home: string;
  readonly now: Date;
}): void {
  writeRegistration(input.stateDir, managedRegistration(input));
}

export function writeFailedRegistration(
  target: PortableTarget,
  stateDir: string,
  now: Date,
  failureReason: string,
): void {
  const existingRegistration = readPortableInstallRegistration(stateDir);
  const retainedAttestation = retainedInstallAttestation(existingRegistration);
  writeRegistration(stateDir, {
    schemaVersion: 1,
    status: "setup-failed",
    updateEligible: false,
    platformTarget: target,
    packageVersion: retainedAttestation?.packageVersion ?? "unknown",
    stable: retainedAttestation?.stable ?? false,
    failureReason: setupFailureReasonCode(failureReason),
    ...retainedAttestation,
    updatedAt: now.toISOString(),
  });
}

export function readPortableInstallRegistration(
  stateDir: string,
): PortableInstallRegistration | undefined {
  if (!hasPortableInstallRegistration(stateDir)) return undefined;
  const path = join(stateDir, REGISTRATION_FILE);
  // #KEIKO-0333: readJson returns undefined for a truncated / non-JSON file so
  // downstream callers observe "no registration recorded" instead of a thrown
  // SyntaxError. That matches launcher-state.ts's fail-closed-to-empty semantics
  // for the sibling state file.
  const raw = readJson(path);
  if (raw === undefined) return undefined;
  if (isManagedRegistrationRecord(raw)) return managedRegistrationFromRecord(raw);
  if (isFailedRegistrationRecord(raw)) return failedRegistrationFromRecord(raw);
  return undefined;
}

// PR-review follow-up (Codex thread 3771011311): destructive callers such as
// `keiko uninstall --state` must refuse when the registration file EXISTS but cannot be
// parsed into a recognised registration record — otherwise the uninstall skips
// removePortableManagedStep AND then deletes the registration itself as an ordinary state
// artifact, erasing the attestation needed to locate and remove the managed installation
// safely. Callers that only need "what's registered" continue to use
// readPortableInstallRegistration (which fails closed to undefined for backward
// compatibility). Returns true only when the file exists but yields neither a managed nor
// a failed registration through the strict record parsers.
export function isPortableInstallRegistrationCorrupt(stateDir: string): boolean {
  if (!hasPortableInstallRegistration(stateDir)) return false;
  const path = join(stateDir, REGISTRATION_FILE);
  const raw = readJson(path);
  if (raw === undefined) return true;
  if (isManagedRegistrationRecord(raw)) return false;
  if (isFailedRegistrationRecord(raw)) return false;
  return true;
}

export function readManagedRegistration(stateDir: string): ManagedSetupRegistration | undefined {
  const registration = readPortableInstallRegistration(stateDir);
  return registration?.status === "managed" ? registration : undefined;
}

function isManagedRegistrationRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (value.status !== "managed" || value.updateEligible !== true) return false;
  if (
    !isPortableTarget(typeof value.platformTarget === "string" ? value.platformTarget : undefined)
  ) {
    return false;
  }
  return typeof value.packageVersion === "string" && typeof value.stable === "boolean";
}

function managedRegistrationFromRecord(raw: Record<string, unknown>): ManagedSetupRegistration {
  const platformTarget =
    typeof raw.platformTarget === "string" && isPortableTarget(raw.platformTarget)
      ? raw.platformTarget
      : undefined;
  if (platformTarget === undefined) {
    throw new Error("portable registration target is invalid");
  }
  return {
    schemaVersion: 1,
    status: "managed",
    updateEligible: true,
    platformTarget,
    packageVersion: String(raw.packageVersion),
    stable: raw.stable === true,
    managedRootLocator: parseManagedRootLocator(raw.managedRootLocator),
    setupManifestSha256: parseSha256(raw.setupManifestSha256),
    installRootIdentitySha256: parseSha256(raw.installRootIdentitySha256),
    launcherIdentitySha256: parseSha256(raw.launcherIdentitySha256),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

function parseSha256(value: unknown): string | undefined {
  return typeof value === "string" && SHA256_RE.test(value) ? value : undefined;
}

function parseManagedRootLocator(value: unknown): ManagedRootLocator | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "default") return { kind: "default" };
  const path = parseManagedRootLocatorPath(value.path);
  if (path === undefined) return undefined;
  if (value.kind === "home-relative" && isSafeHomeRelativeLocatorPath(path)) {
    return { kind: "home-relative", path };
  }
  if (value.kind === "absolute-local" && isSafeAbsoluteLocalLocatorPath(path)) {
    return { kind: "absolute-local", path };
  }
  return undefined;
}

function parseManagedRootLocatorPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.length > 1024) return undefined;
  return value;
}

function isSafeHomeRelativeLocatorPath(value: string): boolean {
  if (isSafeAbsoluteLocalLocatorPath(value)) return false;
  return value
    .split(/[\\/]+/)
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isSafeAbsoluteLocalLocatorPath(value: string): boolean {
  return isAbsolute(value) || WINDOWS_DRIVE_ABSOLUTE_PATH.test(value);
}

function isFailedRegistrationRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (value.status !== "setup-failed" || value.updateEligible !== false) return false;
  if (
    !isPortableTarget(typeof value.platformTarget === "string" ? value.platformTarget : undefined)
  ) {
    return false;
  }
  return typeof value.packageVersion === "string" && typeof value.stable === "boolean";
}

function failedRegistrationFromRecord(raw: Record<string, unknown>): FailedSetupRegistration {
  const platformTarget =
    typeof raw.platformTarget === "string" && isPortableTarget(raw.platformTarget)
      ? raw.platformTarget
      : undefined;
  if (platformTarget === undefined) {
    throw new Error("portable registration target is invalid");
  }
  return {
    schemaVersion: 1,
    status: "setup-failed",
    updateEligible: false,
    platformTarget,
    packageVersion: String(raw.packageVersion),
    stable: raw.stable === true,
    failureReason: typeof raw.failureReason === "string" ? raw.failureReason : undefined,
    installRootPlatformTarget:
      typeof raw.installRootPlatformTarget === "string" &&
      isPortableTarget(raw.installRootPlatformTarget)
        ? raw.installRootPlatformTarget
        : undefined,
    setupManifestSha256: parseSha256(raw.setupManifestSha256),
    installRootIdentitySha256: parseSha256(raw.installRootIdentitySha256),
    launcherIdentitySha256: parseSha256(raw.launcherIdentitySha256),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

export function registrationMatches(
  registration: ManagedSetupRegistration,
  layout: PortableLayout,
  manifest: SetupManifest,
): boolean {
  return (
    registration.platformTarget === manifest.platformTarget &&
    registration.packageVersion === manifest.packageVersion &&
    registration.stable === manifest.stable &&
    registration.setupManifestSha256 === sha256File(layout.setupManifestPath) &&
    registration.installRootIdentitySha256 ===
      portableInstallRootIdentitySha256(layout.installRoot) &&
    registration.launcherIdentitySha256 === sha256File(layout.primaryLauncherPath)
  );
}
