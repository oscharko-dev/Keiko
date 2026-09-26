import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync as nodeLstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  UpdateInstallMode,
  UpdateInstallModeKind,
  UpdatePortableInstallSummary,
  UpdatePortableManagedRootKind,
  UpdatePortableTarget,
} from "@oscharko-dev/keiko-contracts";
import { UPDATE_SESSION_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/update-session";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import { assertWindowsLocalVolume } from "@oscharko-dev/keiko-security/windows-local-volume";
import {
  generationBindingMatchesPackageLayout,
  parseWindowsGenerationBinding,
  portablePackageLayout,
  windowsGenerationBindingsEqual,
  type PortablePackageLayout,
  type WindowsGenerationBinding,
} from "./update-portable-windows-generation.js";

export type PortableManagementMode = "user-local" | "organization-managed" | "machine-managed";

export interface PortableUpdateRuntimeFacts {
  readonly packageRoot?: string | undefined;
  readonly stateDir?: string | undefined;
  readonly management?: PortableManagementMode | undefined;
}

export interface PortableDetectorFs {
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string, encoding: "utf8") => string;
  readonly readFileBytesSync?: ((path: string) => Uint8Array) | undefined;
  readonly fileStatSync?:
    | ((path: string) => {
        readonly ctimeMs: number;
        readonly dev: number;
        readonly ino: number;
        readonly isFile: () => boolean;
        readonly isSymbolicLink: () => boolean;
        readonly mtimeMs: number;
        readonly nlink: number;
        readonly size: number;
      })
    | undefined;
  readonly realpathSync: (path: string) => string;
  readonly lstatSync: (path: string) => { isSymbolicLink: () => boolean };
}

type PortableReadResult =
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | {
      readonly status: "present";
      readonly raw: Record<string, unknown>;
      readonly summary: UpdatePortableInstallSummary;
    };

interface PortableManifestSummary {
  readonly binding?: WindowsGenerationBinding | undefined;
  readonly bytes: string;
  readonly layout: PortablePackageLayout;
  readonly summary: UpdatePortableInstallSummary;
}

interface SelectedPortableManifest {
  readonly bytes: string;
  readonly layout: PortablePackageLayout;
  readonly raw: Record<string, unknown>;
  readonly target: UpdatePortableTarget;
}

const REGISTRATION_FILE = "portable-install-state.json";
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const MAX_TOKEN_LENGTH = 128;
const MAX_CONTROL_FILE_BYTES = 256 * 1024;
const MAX_LAUNCHER_BYTES = 64 * 1024 * 1024;
const FILE_READ_DEADLINE_MS = 5_000;
const READ_CHUNK_BYTES = 64 * 1024;
const WINDOWS_REGISTRATION_V2_KEYS = [
  "schemaVersion",
  "status",
  "updateEligible",
  "platformTarget",
  "packageVersion",
  "stable",
  "managedRootLocator",
  "setupManifestSha256",
  "installRootIdentitySha256",
  "launcherIdentitySha256",
  "windowsGeneration",
  "updatedAt",
] as const;
const PORTABLE_TARGETS: readonly UpdatePortableTarget[] = [
  "windows-x64",
  "macos-arm64",
  "macos-x64",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPortableTarget(value: unknown): value is UpdatePortableTarget {
  return typeof value === "string" && (PORTABLE_TARGETS as readonly string[]).includes(value);
}

function safeToken(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOKEN_LENGTH) {
    return undefined;
  }
  return /[\0\r\n]/u.test(value) ? undefined : value;
}

function safeSha256(value: unknown): string | undefined {
  return typeof value === "string" && HEX_SHA256.test(value) ? value : undefined;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort((left, right) => left.localeCompare(right, "en-US"));
  const wanted = [...expected].sort((left, right) => left.localeCompare(right, "en-US"));
  return actual.length === wanted.length && wanted.every((key, index) => actual[index] === key);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function nodeFileIsUnsafe(stat: ReturnType<typeof fstatSync>, maxBytes: number): boolean {
  return [!stat.isFile(), stat.nlink !== 1, stat.size < 0, stat.size > maxBytes].some(Boolean);
}

function nodeFileChanged(
  before: ReturnType<typeof fstatSync>,
  after: ReturnType<typeof fstatSync>,
  pathAfter: Stats,
  total: number,
): boolean {
  return [
    !after.isFile(),
    after.nlink !== 1,
    after.dev !== before.dev,
    after.ino !== before.ino,
    after.size !== before.size,
    after.mtimeMs !== before.mtimeMs,
    after.ctimeMs !== before.ctimeMs,
    !pathAfter.isFile(),
    pathAfter.nlink !== 1,
    pathAfter.dev !== before.dev,
    pathAfter.ino !== before.ino,
    pathAfter.size !== before.size,
    pathAfter.mtimeMs !== before.mtimeMs,
    pathAfter.ctimeMs !== before.ctimeMs,
    pathAfter.isSymbolicLink(),
    total !== before.size,
  ].some(Boolean);
}

function readNodeChunks(
  descriptor: number,
  maxBytes: number,
  deadline: number,
): { readonly chunks: readonly Buffer[]; readonly total: number } {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    if (Date.now() > deadline) throw new Error("portable identity read deadline exceeded");
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes - total + 1));
    const count = readSync(descriptor, chunk, 0, chunk.length, null);
    if (count === 0) return { chunks, total };
    total += count;
    if (total > maxBytes) throw new Error("portable identity file is oversized");
    chunks.push(chunk.subarray(0, count));
  }
}

function readBoundedNodeFile(path: string, maxBytes: number): Uint8Array {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const deadline = Date.now() + FILE_READ_DEADLINE_MS;
  try {
    const before = fstatSync(descriptor);
    if (nodeFileIsUnsafe(before, maxBytes)) {
      throw new Error("portable identity file is unsafe or oversized");
    }
    const { chunks, total } = readNodeChunks(descriptor, maxBytes, deadline);
    const after = fstatSync(descriptor);
    const pathAfter = nodeLstatSync(path);
    if (nodeFileChanged(before, after, pathAfter, total)) {
      throw new Error("portable identity file changed while it was read");
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(descriptor);
  }
}

function hashNodeChunks(
  descriptor: number,
  maxBytes: number,
  deadline: number,
): { readonly sha256: string; readonly total: number } {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let total = 0;
  for (;;) {
    if (Date.now() > deadline) throw new Error("portable identity read deadline exceeded");
    const count = readSync(descriptor, chunk, 0, chunk.length, null);
    if (count === 0) return { sha256: hash.digest("hex"), total };
    total += count;
    if (total > maxBytes) throw new Error("portable identity file is oversized");
    hash.update(chunk.subarray(0, count));
  }
}

function hashBoundedNodeFile(path: string, maxBytes: number): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const deadline = Date.now() + FILE_READ_DEADLINE_MS;
  try {
    const before = fstatSync(descriptor);
    if (nodeFileIsUnsafe(before, maxBytes)) {
      throw new Error("portable identity file is unsafe or oversized");
    }
    const result = hashNodeChunks(descriptor, maxBytes, deadline);
    if (nodeFileChanged(before, fstatSync(descriptor), nodeLstatSync(path), result.total)) {
      throw new Error("portable identity file changed while it was read");
    }
    return result.sha256;
  } finally {
    closeSync(descriptor);
  }
}

type InjectedFileStat = ReturnType<NonNullable<PortableDetectorFs["fileStatSync"]>>;

function injectedFileChanged(before: InjectedFileStat, after: InjectedFileStat): boolean {
  return [
    !after.isFile(),
    after.isSymbolicLink(),
    after.nlink !== 1,
    after.dev !== before.dev,
    after.ino !== before.ino,
    after.size !== before.size,
    after.mtimeMs !== before.mtimeMs,
    after.ctimeMs !== before.ctimeMs,
  ].some(Boolean);
}

function injectedFileUnsafe(stat: InjectedFileStat | undefined, maxBytes: number): boolean {
  if (stat === undefined) return true;
  return [
    !stat.isFile(),
    stat.isSymbolicLink(),
    stat.nlink !== 1,
    stat.size < 0,
    stat.size > maxBytes,
  ].some(Boolean);
}

function injectedContentChanged(
  before: InjectedFileStat,
  after: InjectedFileStat | undefined,
  byteLength: number,
  maxBytes: number,
): boolean {
  if (after === undefined) return true;
  return [
    injectedFileChanged(before, after),
    byteLength !== before.size,
    byteLength > maxBytes,
  ].some(Boolean);
}

function readBoundedFile(path: string, fs: PortableDetectorFs, maxBytes: number): Uint8Array {
  if (fs.readFileBytesSync === undefined) return readBoundedNodeFile(path, maxBytes);
  const stat = fs.fileStatSync?.(path);
  if (stat === undefined) {
    throw new Error("portable identity file is unsafe or oversized");
  }
  if (injectedFileUnsafe(stat, maxBytes)) {
    throw new Error("portable identity file is unsafe or oversized");
  }
  const bytes = fs.readFileBytesSync(path);
  const after = fs.fileStatSync?.(path);
  if (injectedContentChanged(stat, after, bytes.byteLength, maxBytes)) {
    throw new Error("portable identity file changed while it was read");
  }
  return bytes;
}

function readBoundedText(path: string, fs: PortableDetectorFs): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    readBoundedFile(path, fs, MAX_CONTROL_FILE_BYTES),
  );
}

function fileSha256(path: string, fs: PortableDetectorFs): string {
  return fs.readFileBytesSync === undefined
    ? hashBoundedNodeFile(path, MAX_LAUNCHER_BYTES)
    : sha256(readBoundedFile(path, fs, MAX_LAUNCHER_BYTES));
}

function safeManagedRootKind(value: unknown): UpdatePortableManagedRootKind | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "default" && hasExactKeys(value, ["kind"])) return value.kind;
  return safeLocatedManagedRootKind(value);
}

function safeLocatedManagedRootKind(
  value: Record<string, unknown>,
): UpdatePortableManagedRootKind | undefined {
  if (
    (value.kind === "home-relative" || value.kind === "absolute-local") &&
    hasExactKeys(value, ["kind", "path"]) &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    value.path.length <= 1024
  )
    return value.kind;
  return undefined;
}

function isSymlink(path: string, fs: PortableDetectorFs): boolean {
  try {
    return fs.existsSync(path) && fs.lstatSync(path).isSymbolicLink();
  } catch {
    return true;
  }
}

function hasSymlinkAncestor(path: string, fs: PortableDetectorFs): boolean {
  let cursor = resolve(path);
  for (;;) {
    if (isSymlink(cursor, fs)) return true;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function registrationPath(stateDir: string, fs: PortableDetectorFs): string | undefined {
  if (stateDir.length === 0 || /[\0\r\n]/u.test(stateDir)) return undefined;
  if (hasSymlinkAncestor(stateDir, fs)) return undefined;
  const path = join(stateDir, REGISTRATION_FILE);
  return isSymlink(path, fs) ? undefined : path;
}

function managedSummary(raw: Record<string, unknown>): UpdatePortableInstallSummary | undefined {
  if (raw.status !== "managed") return undefined;
  if (!isPortableTarget(raw.platformTarget) || typeof raw.stable !== "boolean") return undefined;
  const packageVersion = safeToken(raw.packageVersion);
  if (packageVersion === undefined) return undefined;
  if (raw.schemaVersion === 1 && raw.platformTarget === "windows-x64") {
    return legacyWindowsSummary(raw, packageVersion);
  }
  if (raw.updateEligible !== true) return undefined;
  return {
    status: "managed",
    target: raw.platformTarget,
    updateEligible: true,
    packageVersion,
    stable: raw.stable,
    managedRootKind: safeManagedRootKind(raw.managedRootLocator) ?? "unknown",
    setupManifestSha256: safeSha256(raw.setupManifestSha256),
    installRootIdentitySha256: safeSha256(raw.installRootIdentitySha256),
    launcherIdentitySha256: safeSha256(raw.launcherIdentitySha256),
  };
}

function legacyWindowsSummary(
  raw: Record<string, unknown>,
  packageVersion: string,
): UpdatePortableInstallSummary | undefined {
  if (typeof raw.updateEligible !== "boolean" || raw.windowsGeneration !== undefined) {
    return undefined;
  }
  return {
    status: "bootstrap",
    target: "windows-x64",
    updateEligible: false,
    packageVersion,
    stable: raw.stable === true,
  };
}

function failedSetupSummary(
  raw: Record<string, unknown>,
): UpdatePortableInstallSummary | undefined {
  if (raw.status !== "setup-failed" || raw.updateEligible !== false) return undefined;
  if (!isPortableTarget(raw.platformTarget) || typeof raw.stable !== "boolean") return undefined;
  const packageVersion = safeToken(raw.packageVersion);
  if (packageVersion === undefined) return undefined;
  return {
    status: "setup-failed",
    target: raw.platformTarget,
    updateEligible: false,
    packageVersion,
    stable: raw.stable,
    failureReason: safeToken(raw.failureReason),
  };
}

function summaryFromRegistration(
  raw: Record<string, unknown>,
): UpdatePortableInstallSummary | undefined {
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) return undefined;
  if (raw.schemaVersion === 2 && !validWindowsRegistration(raw)) return undefined;
  return managedSummary(raw) ?? failedSetupSummary(raw);
}

function validWindowsRegistration(raw: Record<string, unknown>): boolean {
  return [
    hasExactKeys(raw, WINDOWS_REGISTRATION_V2_KEYS),
    raw.status === "managed",
    raw.updateEligible === true,
    raw.platformTarget === "windows-x64",
    raw.stable === true,
    safeToken(raw.packageVersion) !== undefined,
    safeToken(raw.updatedAt) !== undefined,
    safeManagedRootKind(raw.managedRootLocator) !== undefined,
    safeSha256(raw.setupManifestSha256) !== undefined,
    safeSha256(raw.installRootIdentitySha256) !== undefined,
    safeSha256(raw.launcherIdentitySha256) !== undefined,
    parseWindowsGenerationBinding(raw.windowsGeneration) !== undefined,
  ].every(Boolean);
}

function readPortableRegistration(
  stateDir: string | undefined,
  fs: PortableDetectorFs,
): PortableReadResult {
  if (stateDir === undefined) return { status: "absent" };
  const path = registrationPath(stateDir, fs);
  if (path === undefined) return { status: "invalid" };
  if (!fs.existsSync(path)) return { status: "absent" };
  const raw = parseJsonObject(readBoundedText(path, fs));
  if (raw === undefined) return { status: "invalid" };
  const summary = summaryFromRegistration(raw);
  return summary === undefined ? { status: "invalid" } : { status: "present", raw, summary };
}

function bootstrapSummaryFromManifest(
  packageRoot: string | undefined,
  fs: PortableDetectorFs,
  packageName: string,
): PortableManifestSummary | undefined {
  const selected = selectPortableManifest(packageRoot, fs);
  if (selected === undefined) return undefined;
  const { bytes, layout, raw, target } = selected;
  const packageVersion = safeToken(raw.packageVersion);
  if (
    raw.packageName !== packageName ||
    typeof raw.stable !== "boolean" ||
    packageVersion === undefined
  ) {
    return undefined;
  }
  const summary: UpdatePortableInstallSummary = {
    status: "bootstrap",
    target,
    updateEligible: false,
    packageVersion,
    stable: raw.stable,
  };
  if (target !== "windows-x64") {
    return raw.schemaVersion === 1 && raw.windowsGeneration === undefined
      ? { bytes, layout, summary }
      : undefined;
  }
  return windowsManifestSummary(selected, summary, packageName, fs);
}

function selectPortableManifest(
  packageRoot: string | undefined,
  fs: PortableDetectorFs,
): SelectedPortableManifest | undefined {
  const targetLayouts = PORTABLE_TARGETS.map((target) =>
    portablePackageLayout(target, packageRoot),
  );
  for (const candidate of targetLayouts) {
    if (candidate === undefined || !fs.existsSync(candidate.rootSetupManifestPath)) continue;
    const bytes = readBoundedText(candidate.rootSetupManifestPath, fs);
    const raw = parseJsonObject(bytes);
    if (raw === undefined || !isPortableTarget(raw.platformTarget)) continue;
    const resolvedLayout = portablePackageLayout(raw.platformTarget, packageRoot);
    if (resolvedLayout?.kind === candidate.kind) {
      return { bytes, layout: resolvedLayout, raw, target: raw.platformTarget };
    }
  }
  return undefined;
}

function windowsManifestSummary(
  selected: SelectedPortableManifest,
  summary: UpdatePortableInstallSummary,
  packageName: string,
  fs: PortableDetectorFs,
): PortableManifestSummary | undefined {
  const { bytes, layout, raw } = selected;
  if (raw.schemaVersion === 1) {
    return legacyWindowsManifestSummary(selected, summary);
  }
  if (raw.schemaVersion !== 2) return undefined;
  const binding = parseWindowsGenerationBinding(raw.windowsGeneration);
  if (binding === undefined) return undefined;
  const runtime = isRecord(raw.runtime) ? raw.runtime : undefined;
  const manifestValid = [
    generationBindingMatchesPackageLayout(binding, layout),
    raw.primaryLauncher === "Keiko.exe",
    raw.bootstrapUpdateEligible === false,
    runtime?.nodePlatform === "win32",
    runtime?.nodeArchitecture === "x64",
  ].every(Boolean);
  if (!manifestValid) return undefined;
  const packageRecord = fs.existsSync(layout.packageJsonPath)
    ? parseJsonObject(readBoundedText(layout.packageJsonPath, fs))
    : undefined;
  if (!packageIdentityMatches(packageRecord, packageName, summary.packageVersion)) return undefined;
  return { binding, bytes, layout, summary };
}

function legacyWindowsManifestSummary(
  selected: SelectedPortableManifest,
  summary: UpdatePortableInstallSummary,
): PortableManifestSummary | undefined {
  return selected.layout.kind === "windows-flat-v1" && selected.raw.windowsGeneration === undefined
    ? { bytes: selected.bytes, layout: selected.layout, summary }
    : undefined;
}

function packageIdentityMatches(
  record: Record<string, unknown> | undefined,
  packageName: string,
  packageVersion: string | undefined,
): boolean {
  return record?.name === packageName && record.version === packageVersion;
}

function registrationMatchesManifest(
  registration: PortableReadResult & { readonly status: "present" },
  manifest: PortableManifestSummary,
  fs: PortableDetectorFs,
): boolean {
  const summaryMatches = [
    registration.summary.target === manifest.summary.target,
    registration.summary.packageVersion === manifest.summary.packageVersion,
    registration.summary.stable === manifest.summary.stable,
  ].every(Boolean);
  if (!summaryMatches) return false;
  if (manifest.binding === undefined) return registration.raw.windowsGeneration === undefined;

  const registrationBinding = parseWindowsGenerationBinding(registration.raw.windowsGeneration);
  if (
    registration.raw.schemaVersion !== 2 ||
    registrationBinding === undefined ||
    !windowsGenerationBindingsEqual(registrationBinding, manifest.binding)
  ) {
    return false;
  }
  return windowsRegistrationDiskMatches(registration.raw, manifest, manifest.binding, fs);
}

function windowsRegistrationDiskMatches(
  registration: Record<string, unknown>,
  manifest: PortableManifestSummary,
  binding: WindowsGenerationBinding,
  fs: PortableDetectorFs,
): boolean {
  return [
    registration.setupManifestSha256 === sha256(manifest.bytes),
    registration.installRootIdentitySha256 === sha256(fs.realpathSync(manifest.layout.installRoot)),
    registration.launcherIdentitySha256 === fileSha256(manifest.layout.rootLauncherPath, fs),
    registration.launcherIdentitySha256 === binding.launcherSha256,
  ].every(Boolean);
}

function normalizedPath(value: string | undefined): string {
  return (value ?? "").replaceAll("\\", "/").toLowerCase();
}

function hasMachineManagedRoot(packageRoot: string | undefined): boolean {
  const normalized = normalizedPath(packageRoot);
  return (
    normalized.startsWith("/applications/keiko.app/") ||
    /^[a-z]:\/program files( \(x86\))?\/keiko\//u.test(normalized) ||
    /^[a-z]:\/programdata\/keiko\//u.test(normalized)
  );
}

function isOrganizationManaged(facts: PortableUpdateRuntimeFacts): boolean {
  return facts.management === "organization-managed" || facts.management === "machine-managed";
}

function manualInstructions(reason: UpdateInstallMode["reason"]): string {
  if (reason === "portable-bootstrap") {
    return "Run the portable setup flow from the Keiko launcher before using in-app updates.";
  }
  if (reason === "portable-it-managed") {
    return "This Keiko install is managed outside the app and is not eligible for self-update.";
  }
  if (reason === "portable-non-stable") {
    return "Only stable portable Keiko releases are eligible for in-app updates.";
  }
  if (reason === "portable-setup-failed") {
    return "Portable setup did not complete. Re-run setup or download the latest Keiko package.";
  }
  return "Portable update eligibility could not be attested. Download the latest Keiko package.";
}

export function resolvePortableUnsupportedInstallKind(
  reason: UpdateInstallMode["reason"],
  portable: UpdatePortableInstallSummary,
): UpdateInstallModeKind {
  if (reason === "portable-setup-failed") {
    return "portable-setup-failed";
  }
  if (reason === "portable-it-managed") {
    return "portable-it-managed";
  }
  if (reason === "portable-non-stable" && portable.status === "managed") {
    return "portable-managed";
  }
  return "portable-bootstrap";
}

function portableUnsupportedMode(
  packageName: string,
  reason: UpdateInstallMode["reason"],
  portable: UpdatePortableInstallSummary,
): UpdateInstallMode {
  const installKind = resolvePortableUnsupportedInstallKind(reason, portable);
  return {
    schemaVersion: UPDATE_SESSION_SCHEMA_VERSION,
    status: "unsupported",
    packageName,
    installKind,
    portable,
    recommendedAction:
      reason === "portable-bootstrap" ? "portable-bootstrap-setup" : "manual-download",
    reason,
    manualInstructions: manualInstructions(reason),
  };
}

function portableSupportedMode(
  packageName: string,
  portable: UpdatePortableInstallSummary,
): UpdateInstallMode {
  return {
    schemaVersion: UPDATE_SESSION_SCHEMA_VERSION,
    status: "supported",
    packageName,
    installKind: "portable-managed",
    portable,
    recommendedAction: "portable-managed-update",
  };
}

function modeForPortableSummary(
  summary: UpdatePortableInstallSummary,
  facts: PortableUpdateRuntimeFacts,
  packageName: string,
): UpdateInstallMode {
  if (summary.status === "setup-failed") {
    return portableUnsupportedMode(packageName, "portable-setup-failed", summary);
  }
  if (summary.status === "bootstrap") {
    return portableUnsupportedMode(packageName, "portable-bootstrap", summary);
  }
  if (!summary.stable) return portableUnsupportedMode(packageName, "portable-non-stable", summary);
  if (isOrganizationManaged(facts) || hasMachineManagedRoot(facts.packageRoot)) {
    return portableUnsupportedMode(packageName, "portable-it-managed", {
      ...summary,
      status: "it-managed",
      updateEligible: false,
    });
  }
  return portableSupportedMode(packageName, summary);
}

export function portableStateDirFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const stateDir = env.KEIKO_STATE_DIR;
  return stateDir === undefined || stateDir.length === 0 ? undefined : stateDir;
}

export function detectPortableUpdateInstallMode(
  facts: PortableUpdateRuntimeFacts,
  fs: PortableDetectorFs,
  packageName: string,
  securityLogSink?: SecurityLogSink,
): UpdateInstallMode | undefined {
  const manifestSummary = bootstrapSummaryFromManifest(facts.packageRoot, fs, packageName);
  const registration = readPortableRegistration(facts.stateDir, fs);
  if (manifestSummary === undefined) return undefined;
  if (manifestSummary.summary.target === "windows-x64") {
    try {
      // Keep the original install-root spelling: canonicalization can hide mapped-share and
      // reparse boundaries which D3 explicitly denies.
      assertWindowsLocalVolume(manifestSummary.layout.installRoot, { securityLogSink });
    } catch {
      return portableUnsupportedMode(
        packageName,
        "portable-registration-invalid",
        manifestSummary.summary,
      );
    }
  }
  if (registration.status === "invalid") {
    return portableUnsupportedMode(
      packageName,
      "portable-registration-invalid",
      manifestSummary.summary,
    );
  }
  if (registration.status === "absent") {
    return modeForPortableSummary(manifestSummary.summary, facts, packageName);
  }
  if (!registrationMatchesManifest(registration, manifestSummary, fs)) {
    return portableUnsupportedMode(
      packageName,
      "portable-registration-invalid",
      manifestSummary.summary,
    );
  }
  return modeForPortableSummary(registration.summary, facts, packageName);
}
