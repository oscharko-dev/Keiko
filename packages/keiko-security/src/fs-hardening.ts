// Shared filesystem-hardening primitives [GEN-MAINT-COUPLING-005]. Three SQLite/secret surfaces
// (keiko-memory-vault/store db, keiko-server/store db, and this package's secret-vault) each carried
// a byte-identical private copy of the 0o700 directory / 0o600 file hardening pair. They now share
// this single owner so the win32 no-op and best-effort try/catch semantics can never drift between
// surfaces. Behavior is copied VERBATIM from those copies — no product change.
//
// keiko-security depends only on keiko-contracts and is depended upon by the store/vault packages, so
// hoisting this module here introduces no dependency cycle.

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

// Owner-only directory: rwx for the owner, nothing for group/other.
export const DIR_MODE = 0o700;
// Owner-only file: rw for the owner, nothing for group/other.
export const FILE_MODE = 0o600;

// Creates `dir` (recursively) at DIR_MODE when absent, then tightens an already-existing directory to
// DIR_MODE on POSIX. On win32 the chmod is a no-op (POSIX modes are meaningless there). The chmod is
// best-effort: a parent-owned directory we cannot chmod is preferable to a hard failure that blocks
// the user from opening the store/vault.
export function ensureDirHardened(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, DIR_MODE);
    } catch {
      // Best-effort: a parent-owned directory we cannot chmod is preferable to a hard failure.
    }
  }
}

// Best-effort chmod of a path that may not exist yet (e.g. a WAL/-shm sidecar). No-op on win32;
// swallows any error (ENOENT and friends) so callers can hardening-sweep a set of maybe-present paths
// without branching on existence.
export function chmodIfPresent(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, mode);
  } catch {
    // The sidecar (-wal/-shm) may not exist yet; best-effort.
  }
}

export const SAFE_ARTIFACT_CLASSES = [
  "activity-log",
  "support-report",
  "replay-fixture",
  "manifest",
  "integrity-artifact",
] as const;

export const SAFE_ARTIFACT_FILE_FAILURE_KINDS = [
  "invalid-publication",
  "close-failed",
  "durability-failed",
  "open-failed",
  "permission-failed",
  "permission-unsafe",
  "publish-failed",
  "publish-unsupported",
  "read-failed",
  "recovery-conflict",
  "replace-failed",
  "target-exists",
  "target-mutated",
  "unsafe-ancestor",
  "unsafe-target",
  "write-failed",
] as const;

export type SafeArtifactClass = (typeof SAFE_ARTIFACT_CLASSES)[number];
export type SafeArtifactContainmentAssurance = "private-root-guarded" | "platform-inherited";
export type SafeArtifactDurabilityAssurance = "verified" | "directory-sync-unavailable";
export type SafeArtifactPermissionAssurance = "verified-private" | "platform-inherited";
export type SafeArtifactOpenMode =
  "append-existing-or-create" | "exclusive-create" | "read" | "read-write-existing";
export type SafeArtifactFileFailureKind = (typeof SAFE_ARTIFACT_FILE_FAILURE_KINDS)[number];

const SAFE_ARTIFACT_CLASS_SET: ReadonlySet<string> = new Set(SAFE_ARTIFACT_CLASSES);
const SAFE_ARTIFACT_FAILURE_SET: ReadonlySet<string> = new Set(SAFE_ARTIFACT_FILE_FAILURE_KINDS);

function isSafeArtifactClass(value: unknown): value is SafeArtifactClass {
  return typeof value === "string" && SAFE_ARTIFACT_CLASS_SET.has(value);
}

function isSafeArtifactFailureKind(value: unknown): value is SafeArtifactFileFailureKind {
  return typeof value === "string" && SAFE_ARTIFACT_FAILURE_SET.has(value);
}

/** A closed, body-free filesystem failure safe to project into diagnostics. */
export class SafeArtifactFileError extends Error {
  public override readonly name = "SafeArtifactFileError";
  public readonly artifactClass: SafeArtifactClass;
  public readonly kind: SafeArtifactFileFailureKind;

  public constructor(artifactClass: unknown, kind: unknown) {
    const closedClass = isSafeArtifactClass(artifactClass) ? artifactClass : "manifest";
    const closedKind = isSafeArtifactFailureKind(kind) ? kind : "open-failed";
    super(`safe artifact ${closedClass} failed: ${closedKind}`);
    this.artifactClass = closedClass;
    this.kind = closedKind;
  }
}

export interface OpenSafeArtifactFileOptions {
  readonly artifactClass: SafeArtifactClass;
  readonly mode: SafeArtifactOpenMode;
  readonly trustedRoot: string;
}

/** Windows inherits privacy from the operator-selected root ACL; Node cannot attest that DACL. */
export function safeArtifactPermissionAssurance(): SafeArtifactPermissionAssurance {
  return process.platform === "win32" ? "platform-inherited" : "verified-private";
}

/** Node has no portable descriptor-relative create; containment inherits the guarded root. */
export function safeArtifactContainmentAssurance(): SafeArtifactContainmentAssurance {
  return process.platform === "win32" ? "platform-inherited" : "private-root-guarded";
}

function safeFileError(
  artifactClass: SafeArtifactClass,
  kind: SafeArtifactFileFailureKind,
): SafeArtifactFileError {
  return new SafeArtifactFileError(artifactClass, kind);
}

function closeArtifactDescriptor(descriptor: number, artifactClass: SafeArtifactClass): void {
  try {
    closeSync(descriptor);
  } catch {
    throw safeFileError(artifactClass, "close-failed");
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function pathExists(path: string, artifactClass: SafeArtifactClass): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw safeFileError(artifactClass, "open-failed");
  }
}

interface DirectoryGuard {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly descriptor: number | undefined;
}

function lstatDirectory(path: string, artifactClass: SafeArtifactClass): BigIntStats {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !directoryAuthorityIsSafe(stat)) {
      throw safeFileError(artifactClass, "unsafe-ancestor");
    }
    return stat;
  } catch (error) {
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(artifactClass, "unsafe-ancestor");
  }
}

function directoryAuthorityIsSafe(stat: BigIntStats): boolean {
  if (process.platform === "win32") return true;
  const effectiveUser = process.geteuid?.();
  if (effectiveUser === undefined) return false;
  const ownerIsTrusted = stat.uid === 0n || stat.uid === BigInt(effectiveUser);
  const writableByOthers = (stat.mode & 0o022n) !== 0n;
  const rootStickyDirectory = stat.uid === 0n && (stat.mode & 0o1000n) !== 0n;
  return ownerIsTrusted && (!writableByOthers || rootStickyDirectory);
}

function directoryChain(path: string): readonly string[] {
  const absolute = resolve(path);
  const filesystemRoot = parse(absolute).root;
  const fromRoot = relative(filesystemRoot, absolute);
  const directories = [filesystemRoot];
  let current = filesystemRoot;
  for (const component of fromRoot === "" ? [] : fromRoot.split(sep)) {
    current = join(current, component);
    directories.push(current);
  }
  return directories;
}

function resolvedRealPath(path: string, artifactClass: SafeArtifactClass): string {
  try {
    return realpathSync(path);
  } catch {
    throw safeFileError(artifactClass, "unsafe-ancestor");
  }
}

function sameFilesystemPath(left: string, right: string): boolean {
  return filesystemComparisonPath(left) === filesystemComparisonPath(right);
}

function containedDirectories(
  trustedRoot: string,
  targetPath: string,
  artifactClass: SafeArtifactClass,
): readonly string[] {
  const root = resolve(trustedRoot);
  const parent = dirname(resolve(targetPath));
  const fromRoot = relative(root, parent);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw safeFileError(artifactClass, "unsafe-ancestor");
  }
  const canonicalRoot = resolvedRealPath(root, artifactClass);
  if (process.platform === "win32" && !sameFilesystemPath(root, canonicalRoot)) {
    throw safeFileError(artifactClass, "unsafe-ancestor");
  }
  const canonicalParent = resolve(canonicalRoot, fromRoot);
  if (!sameFilesystemPath(resolvedRealPath(parent, artifactClass), canonicalParent)) {
    throw safeFileError(artifactClass, "unsafe-ancestor");
  }
  const directories = [...directoryChain(canonicalParent), root];
  let current = root;
  for (const component of fromRoot === "" ? [] : fromRoot.split(sep)) {
    current = join(current, component);
    directories.push(current);
  }
  const unique = new Map(directories.map((path) => [filesystemComparisonPath(path), path]));
  return [...unique.values()];
}

function openDirectoryGuard(path: string, artifactClass: SafeArtifactClass): DirectoryGuard {
  const before = lstatDirectory(path, artifactClass);
  if (process.platform === "win32") {
    const after = lstatDirectory(path, artifactClass);
    if (after.dev !== before.dev || after.ino !== before.ino) {
      throw safeFileError(artifactClass, "target-mutated");
    }
    return { path, dev: after.dev, ino: after.ino, descriptor: undefined };
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const directory = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow | directory);
    return validateDirectoryGuard(path, before.dev, before.ino, descriptor, artifactClass);
  } catch (error) {
    if (descriptor !== undefined) closeDescriptorIgnoringErrors(descriptor);
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(artifactClass, "unsafe-ancestor");
  }
}

function validateDirectoryGuard(
  path: string,
  dev: bigint,
  ino: bigint,
  descriptor: number,
  artifactClass: SafeArtifactClass,
): DirectoryGuard {
  let opened: BigIntStats;
  try {
    opened = fstatSync(descriptor, { bigint: true });
  } catch {
    throw safeFileError(artifactClass, "unsafe-ancestor");
  }
  const pathname = lstatDirectory(path, artifactClass);
  if (
    !opened.isDirectory() ||
    opened.dev !== dev ||
    opened.ino !== ino ||
    pathname.dev !== dev ||
    pathname.ino !== ino
  ) {
    throw safeFileError(artifactClass, "target-mutated");
  }
  return { path, dev, ino, descriptor };
}

function closeDescriptorIgnoringErrors(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Preserve the already-closed primary failure.
  }
}

function captureDirectoryGuards(
  trustedRoot: string,
  targetPath: string,
  artifactClass: SafeArtifactClass,
): readonly DirectoryGuard[] {
  const guards: DirectoryGuard[] = [];
  try {
    for (const path of containedDirectories(trustedRoot, targetPath, artifactClass)) {
      guards.push(openDirectoryGuard(path, artifactClass));
    }
    return guards;
  } catch (error) {
    closeDirectoryGuardsIgnoringErrors(guards);
    throw error;
  }
}

function directoryGuardStillMatches(guard: DirectoryGuard): boolean {
  try {
    const pathname = lstatSync(guard.path, { bigint: true });
    if (!pathname.isDirectory() || pathname.isSymbolicLink()) return false;
    if (pathname.dev !== guard.dev || pathname.ino !== guard.ino) return false;
    if (guard.descriptor === undefined) return process.platform === "win32";
    const opened = fstatSync(guard.descriptor, { bigint: true });
    return opened.isDirectory() && opened.dev === guard.dev && opened.ino === guard.ino;
  } catch {
    return false;
  }
}

function closeDirectoryGuardsIgnoringErrors(guards: readonly DirectoryGuard[]): void {
  for (const guard of guards) {
    if (guard.descriptor === undefined) continue;
    closeDescriptorIgnoringErrors(guard.descriptor);
  }
}

function closeDirectoryGuards(
  guards: readonly DirectoryGuard[],
  artifactClass: SafeArtifactClass,
): void {
  let failed = false;
  for (const guard of guards) {
    if (guard.descriptor === undefined) continue;
    try {
      closeSync(guard.descriptor);
    } catch {
      failed = true;
    }
  }
  if (failed) throw safeFileError(artifactClass, "close-failed");
}

function refuseSymlinkFallback(path: string, artifactClass: SafeArtifactClass): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw safeFileError(artifactClass, "unsafe-target");
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(artifactClass, "open-failed");
  }
}

function openFlags(mode: SafeArtifactOpenMode): number {
  if (mode === "read") return constants.O_RDONLY;
  if (mode === "read-write-existing") return constants.O_RDWR;
  const create = constants.O_WRONLY | constants.O_CREAT;
  return mode === "exclusive-create" ? create | constants.O_EXCL : create | constants.O_APPEND;
}

function permissionIsPrivate(mode: number | bigint): boolean {
  if (process.platform === "win32") return true;
  return typeof mode === "bigint" ? (mode & 0o077n) === 0n : (mode & 0o077) === 0;
}

function verifyDescriptorIdentity(
  descriptor: number,
  path: string,
  artifactClass: SafeArtifactClass,
): BigIntStats {
  let opened: BigIntStats;
  try {
    opened = fstatSync(descriptor, { bigint: true });
  } catch {
    throw safeFileError(artifactClass, "open-failed");
  }
  if (!opened.isFile() || opened.nlink !== 1n) {
    throw safeFileError(artifactClass, "unsafe-target");
  }
  let pathname: BigIntStats;
  try {
    pathname = lstatSync(path, { bigint: true });
  } catch {
    throw safeFileError(artifactClass, "target-mutated");
  }
  if (
    pathname.isSymbolicLink() ||
    !pathname.isFile() ||
    pathname.nlink !== 1n ||
    pathname.dev !== opened.dev ||
    pathname.ino !== opened.ino
  ) {
    throw safeFileError(artifactClass, "target-mutated");
  }
  return opened;
}

/** Verifies the opened descriptor and final pathname still name one private regular inode. */
export function verifySafeArtifactFileDescriptor(
  descriptor: number,
  path: string,
  options: Pick<OpenSafeArtifactFileOptions, "artifactClass" | "trustedRoot">,
): void {
  const guards = captureDirectoryGuards(options.trustedRoot, path, options.artifactClass);
  try {
    const opened = verifyDescriptorIdentity(descriptor, path, options.artifactClass);
    if (!permissionIsPrivate(opened.mode)) {
      throw safeFileError(options.artifactClass, "permission-unsafe");
    }
    if (!guards.every(directoryGuardStillMatches)) {
      throw safeFileError(options.artifactClass, "target-mutated");
    }
  } catch (error) {
    closeDirectoryGuardsIgnoringErrors(guards);
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(options.artifactClass, "open-failed");
  }
  closeDirectoryGuards(guards, options.artifactClass);
}

function tightenDescriptor(descriptor: number, artifactClass: SafeArtifactClass): void {
  if (process.platform === "win32") return;
  try {
    fchmodSync(descriptor, FILE_MODE);
  } catch {
    throw safeFileError(artifactClass, "permission-failed");
  }
}

function mapOpenError(error: unknown): SafeArtifactFileFailureKind {
  const code = errorCode(error);
  if (code === "EEXIST") return "target-exists";
  if (code === "ELOOP" || code === "EISDIR" || code === "ENXIO") return "unsafe-target";
  return "open-failed";
}

function noFollowFlag(): number {
  if (process.platform === "win32") return 0;
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function openArtifactDescriptor(path: string, options: OpenSafeArtifactFileOptions): number {
  const noFollow = noFollowFlag();
  const nonBlocking = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  if (noFollow === 0) refuseSymlinkFallback(path, options.artifactClass);
  try {
    return openSync(path, openFlags(options.mode) | noFollow | nonBlocking, FILE_MODE);
  } catch (error) {
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(options.artifactClass, mapOpenError(error));
  }
}

function validateOpenedArtifact(
  descriptor: number,
  path: string,
  options: OpenSafeArtifactFileOptions,
  guards: readonly DirectoryGuard[],
): void {
  verifyDescriptorIdentity(descriptor, path, options.artifactClass);
  if (!guards.every(directoryGuardStillMatches)) {
    throw safeFileError(options.artifactClass, "target-mutated");
  }
  if (options.mode !== "read") tightenDescriptor(descriptor, options.artifactClass);
  const opened = verifyDescriptorIdentity(descriptor, path, options.artifactClass);
  if (!permissionIsPrivate(opened.mode)) {
    throw safeFileError(options.artifactClass, "permission-unsafe");
  }
  if (!guards.every(directoryGuardStillMatches)) {
    throw safeFileError(options.artifactClass, "target-mutated");
  }
}

/**
 * Opens without following the final symlink and verifies the descriptor before any caller write.
 * POSIX containment relies on the verified owner-private ancestor chain because Node has no
 * descriptor-relative open API. A same-UID ancestor mutation can create an empty file before the
 * post-open guard rejects it, so the closed assurance is `private-root-guarded`, not absolute
 * containment; no descriptor is returned and no content or chmod reaches the redirected file.
 * Windows also lacks stable no-follow directory descriptors and Node cannot inspect NTFS DACLs.
 * Its permission assurance is therefore `platform-inherited`, never `verified-private`.
 */
export function openSafeArtifactFile(path: string, options: OpenSafeArtifactFileOptions): number {
  const guards = captureDirectoryGuards(options.trustedRoot, path, options.artifactClass);
  let descriptor: number | undefined;
  try {
    descriptor = openArtifactDescriptor(path, options);
    validateOpenedArtifact(descriptor, path, options, guards);
    closeDirectoryGuards(guards, options.artifactClass);
    return descriptor;
  } catch (error) {
    closeDirectoryGuardsIgnoringErrors(guards);
    if (descriptor !== undefined) closeArtifactDescriptor(descriptor, options.artifactClass);
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(options.artifactClass, "open-failed");
  }
}

export interface SafeArtifactPublicationEntry {
  readonly path: string;
  readonly contents: string | Uint8Array;
  readonly artifactClass: SafeArtifactClass;
}

export interface SafeArtifactPublicationOptions {
  readonly commitPath: string;
  readonly trustedRoot: string;
}

export interface SafeArtifactPublicationResult {
  readonly status: "published" | "recovered";
  readonly permissionAssurance: SafeArtifactPermissionAssurance;
  readonly durabilityAssurance: SafeArtifactDurabilityAssurance;
}

export interface ReplaceSafeArtifactFileOptions {
  readonly artifactClass: SafeArtifactClass;
  readonly trustedRoot: string;
}

interface PreparedPublicationEntry {
  readonly path: string;
  readonly stagePath: string;
  readonly bytes: Buffer;
  readonly artifactClass: SafeArtifactClass;
  readonly trustedRoot: string;
}

function publicationId(
  entries: readonly SafeArtifactPublicationEntry[],
  commitPath: string,
): string {
  const hash = createHash("sha256");
  const ordered = [...entries].sort((left, right) =>
    resolve(left.path).localeCompare(resolve(right.path)),
  );
  for (const entry of ordered) {
    const bytes =
      typeof entry.contents === "string"
        ? Buffer.from(entry.contents, "utf8")
        : Buffer.from(entry.contents);
    hash
      .update(entry.artifactClass)
      .update("\0")
      .update(resolve(entry.path))
      .update("\0")
      .update(String(bytes.length))
      .update("\0")
      .update(bytes)
      .update("\0");
  }
  hash.update(resolve(commitPath)).update("\0");
  return hash.digest("hex").slice(0, 24);
}

function preparePublicationEntries(
  entries: readonly SafeArtifactPublicationEntry[],
  commitPath: string,
  trustedRoot: string,
): readonly PreparedPublicationEntry[] {
  const parent = dirname(resolve(commitPath));
  const id = publicationId(entries, commitPath);
  const ordered = [...entries].sort((left, right) =>
    resolve(left.path).localeCompare(resolve(right.path)),
  );
  return ordered.map((entry, index) => ({
    path: resolve(entry.path),
    stagePath: join(parent, `.keiko-publish-${id}-${String(index)}.stage`),
    bytes:
      typeof entry.contents === "string"
        ? Buffer.from(entry.contents, "utf8")
        : Buffer.from(entry.contents),
    artifactClass: entry.artifactClass,
    trustedRoot: resolve(trustedRoot),
  }));
}

function filesystemComparisonPath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "darwin" || process.platform === "win32"
    ? resolved.normalize("NFC").toLocaleLowerCase("en-US")
    : resolved;
}

function validatePublication(
  entries: readonly SafeArtifactPublicationEntry[],
  options: SafeArtifactPublicationOptions,
): void {
  const fallbackClass = entries[0]?.artifactClass ?? "manifest";
  const resolvedCommit = resolve(options.commitPath);
  const paths = entries.map((entry) => resolve(entry.path));
  const comparisonPaths = paths.map(filesystemComparisonPath);
  const parents = new Set(paths.map(dirname));
  if (
    entries.length === 0 ||
    !paths.includes(resolvedCommit) ||
    new Set(comparisonPaths).size !== paths.length ||
    parents.size !== 1
  ) {
    throw safeFileError(fallbackClass, "invalid-publication");
  }
  for (const path of paths) containedDirectories(options.trustedRoot, path, fallbackClass);
}

function writeAll(descriptor: number, bytes: Buffer, artifactClass: SafeArtifactClass): void {
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw safeFileError(artifactClass, "write-failed");
      offset += written;
    }
  } catch (error) {
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(artifactClass, "write-failed");
  }
}

function syncArtifactDescriptor(descriptor: number, artifactClass: SafeArtifactClass): void {
  try {
    fsyncSync(descriptor);
  } catch {
    throw safeFileError(artifactClass, "durability-failed");
  }
}

function createStage(entry: PreparedPublicationEntry): void {
  const descriptor = openSafeArtifactFile(entry.stagePath, {
    artifactClass: entry.artifactClass,
    mode: "exclusive-create",
    trustedRoot: entry.trustedRoot,
  });
  try {
    writeAll(descriptor, entry.bytes, entry.artifactClass);
    syncArtifactDescriptor(descriptor, entry.artifactClass);
  } catch (error) {
    closeDescriptorIgnoringErrors(descriptor);
    throw error;
  }
  closeArtifactDescriptor(descriptor, entry.artifactClass);
}

function syncDirectory(
  path: string,
  trustedRoot: string,
  artifactClass: SafeArtifactClass,
): SafeArtifactDurabilityAssurance {
  const guards = captureDirectoryGuards(
    trustedRoot,
    join(path, ".keiko-directory-sync"),
    artifactClass,
  );
  try {
    const parent = guards.at(-1);
    if (parent === undefined || !guards.every(directoryGuardStillMatches)) {
      throw safeFileError(artifactClass, "target-mutated");
    }
    if (parent.descriptor !== undefined) fsyncSync(parent.descriptor);
    if (!guards.every(directoryGuardStillMatches)) {
      throw safeFileError(artifactClass, "target-mutated");
    }
  } catch (error) {
    closeDirectoryGuardsIgnoringErrors(guards);
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(artifactClass, "durability-failed");
  }
  const assurance =
    guards.at(-1)?.descriptor === undefined ? "directory-sync-unavailable" : "verified";
  closeDirectoryGuards(guards, artifactClass);
  return assurance;
}

function readExactPrivateFile(
  path: string,
  expected: Buffer,
  artifactClass: SafeArtifactClass,
  trustedRoot: string,
): boolean {
  const descriptor = openSafeArtifactFile(path, {
    artifactClass,
    mode: "read",
    trustedRoot,
  });
  try {
    const buffer = Buffer.alloc(expected.length + 1);
    const read = readIntoBuffer(descriptor, buffer, artifactClass);
    verifySafeArtifactFileDescriptor(descriptor, path, { artifactClass, trustedRoot });
    return read === expected.length && buffer.subarray(0, read).equals(expected);
  } catch (error) {
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(artifactClass, "read-failed");
  } finally {
    closeArtifactDescriptor(descriptor, artifactClass);
  }
}

function readIntoBuffer(
  descriptor: number,
  buffer: Buffer,
  artifactClass: SafeArtifactClass,
): number {
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const read = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return offset;
  } catch {
    throw safeFileError(artifactClass, "read-failed");
  }
}

function linkedRecoveryStats(entry: PreparedPublicationEntry): {
  readonly stage: BigIntStats;
  readonly target: BigIntStats;
} {
  try {
    const stage = lstatSync(entry.stagePath, { bigint: true });
    const target = lstatSync(entry.path, { bigint: true });
    if (!linkedStatsAreSafe(stage, target)) {
      throw safeFileError(entry.artifactClass, "recovery-conflict");
    }
    return { stage, target };
  } catch (error) {
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(entry.artifactClass, "recovery-conflict");
  }
}

function linkedStatsAreSafe(stage: BigIntStats, target: BigIntStats): boolean {
  const checks = [
    stage.isFile(),
    target.isFile(),
    !stage.isSymbolicLink(),
    !target.isSymbolicLink(),
    stage.nlink === 2n,
    target.nlink === 2n,
    stage.dev === target.dev,
    stage.ino === target.ino,
    permissionIsPrivate(stage.mode),
    permissionIsPrivate(target.mode),
  ];
  return checks.every(Boolean);
}

function openLinkedStage(entry: PreparedPublicationEntry): number {
  const noFollow = noFollowFlag();
  const nonBlocking = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  if (noFollow === 0) refuseSymlinkFallback(entry.stagePath, entry.artifactClass);
  try {
    return openSync(entry.stagePath, constants.O_RDWR | noFollow | nonBlocking);
  } catch (error) {
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(entry.artifactClass, "read-failed");
  }
}

function linkedDescriptorMatches(descriptor: number, expected: BigIntStats): boolean {
  const opened = fstatSync(descriptor, { bigint: true });
  return [
    opened.isFile(),
    opened.dev === expected.dev,
    opened.ino === expected.ino,
    opened.nlink === 2n,
  ].every(Boolean);
}

function readMatchesPublication(descriptor: number, entry: PreparedPublicationEntry): boolean {
  const buffer = Buffer.alloc(entry.bytes.length + 1);
  const read = readIntoBuffer(descriptor, buffer, entry.artifactClass);
  return read === entry.bytes.length && buffer.subarray(0, read).equals(entry.bytes);
}

function linkedRecoveryContentsMatch(entry: PreparedPublicationEntry): boolean {
  const expected = linkedRecoveryStats(entry).stage;
  const guards = captureDirectoryGuards(entry.trustedRoot, entry.stagePath, entry.artifactClass);
  let descriptor: number | undefined;
  try {
    descriptor = openLinkedStage(entry);
    if (
      !linkedDescriptorMatches(descriptor, expected) ||
      !guards.every(directoryGuardStillMatches)
    ) {
      throw safeFileError(entry.artifactClass, "recovery-conflict");
    }
    const matches = readMatchesPublication(descriptor, entry);
    syncArtifactDescriptor(descriptor, entry.artifactClass);
    closeArtifactDescriptor(descriptor, entry.artifactClass);
    closeDirectoryGuards(guards, entry.artifactClass);
    return matches;
  } catch (error) {
    if (descriptor !== undefined) closeDescriptorIgnoringErrors(descriptor);
    closeDirectoryGuardsIgnoringErrors(guards);
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(entry.artifactClass, "read-failed");
  }
}

function samePathNode(left: string, right: string): boolean {
  try {
    const leftStat = lstatSync(left, { bigint: true });
    const rightStat = lstatSync(right, { bigint: true });
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function recoverLinkedStage(entry: PreparedPublicationEntry): boolean {
  if (
    !pathExists(entry.stagePath, entry.artifactClass) ||
    !pathExists(entry.path, entry.artifactClass)
  ) {
    return false;
  }
  if (!samePathNode(entry.stagePath, entry.path) || !linkedRecoveryContentsMatch(entry)) {
    throw safeFileError(entry.artifactClass, "recovery-conflict");
  }
  return true;
}

function syncRecoveredStage(entry: PreparedPublicationEntry): void {
  const descriptor = openSafeArtifactFile(entry.stagePath, {
    artifactClass: entry.artifactClass,
    mode: "read-write-existing",
    trustedRoot: entry.trustedRoot,
  });
  try {
    syncArtifactDescriptor(descriptor, entry.artifactClass);
  } catch (error) {
    closeDescriptorIgnoringErrors(descriptor);
    throw error;
  }
  closeArtifactDescriptor(descriptor, entry.artifactClass);
}

function removeVerifiedStage(entry: PreparedPublicationEntry): void {
  const descriptor = openSafeArtifactFile(entry.stagePath, {
    artifactClass: entry.artifactClass,
    mode: "read",
    trustedRoot: entry.trustedRoot,
  });
  try {
    verifySafeArtifactFileDescriptor(descriptor, entry.stagePath, {
      artifactClass: entry.artifactClass,
      trustedRoot: entry.trustedRoot,
    });
    unlinkSync(entry.stagePath);
    syncDirectory(dirname(entry.stagePath), entry.trustedRoot, entry.artifactClass);
  } catch (error) {
    closeDescriptorIgnoringErrors(descriptor);
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(entry.artifactClass, "publish-failed");
  }
  closeArtifactDescriptor(descriptor, entry.artifactClass);
}

function ensurePreparedStage(entry: PreparedPublicationEntry, recovering: boolean): void {
  if (recoverLinkedStage(entry)) return;
  const stageExists = pathExists(entry.stagePath, entry.artifactClass);
  const targetExists = pathExists(entry.path, entry.artifactClass);
  if (targetExists) {
    if (
      !recovering ||
      !readExactPrivateFile(entry.path, entry.bytes, entry.artifactClass, entry.trustedRoot)
    ) {
      throw safeFileError(entry.artifactClass, recovering ? "recovery-conflict" : "target-exists");
    }
    return;
  }
  if (!stageExists) {
    createStage(entry);
    return;
  }
  if (!readExactPrivateFile(entry.stagePath, entry.bytes, entry.artifactClass, entry.trustedRoot)) {
    if (!recovering) throw safeFileError(entry.artifactClass, "recovery-conflict");
    removeVerifiedStage(entry);
    createStage(entry);
    return;
  }
  syncRecoveredStage(entry);
}

function orderedForCommit(
  entries: readonly PreparedPublicationEntry[],
  commitPath: string,
): readonly PreparedPublicationEntry[] {
  const resolvedCommit = resolve(commitPath);
  const commit = entries.find((entry) => entry.path === resolvedCommit);
  if (commit === undefined) return entries;
  return [...entries.filter((entry) => entry !== commit), commit];
}

function acceptRecoveredTarget(entry: PreparedPublicationEntry, recovering: boolean): void {
  if (!recovering) throw safeFileError(entry.artifactClass, "target-exists");
  if (
    pathExists(entry.stagePath, entry.artifactClass) &&
    samePathNode(entry.stagePath, entry.path) &&
    linkedRecoveryContentsMatch(entry)
  ) {
    return;
  }
  if (!readExactPrivateFile(entry.path, entry.bytes, entry.artifactClass, entry.trustedRoot)) {
    throw safeFileError(entry.artifactClass, "recovery-conflict");
  }
}

function finishGuardedLink(
  guards: readonly DirectoryGuard[],
  entry: PreparedPublicationEntry,
): void {
  if (!guards.every(directoryGuardStillMatches)) {
    throw safeFileError(entry.artifactClass, "target-mutated");
  }
  closeDirectoryGuards(guards, entry.artifactClass);
}

const UNSUPPORTED_HARD_LINK_CODES = new Set(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]);

function handleLinkFailure(
  error: unknown,
  entry: PreparedPublicationEntry,
  recovering: boolean,
  guards: readonly DirectoryGuard[],
): boolean {
  const code = errorCode(error);
  if (code === "EEXIST") {
    try {
      acceptRecoveredTarget(entry, recovering);
      finishGuardedLink(guards, entry);
      return false;
    } catch (recoveryError) {
      closeDirectoryGuardsIgnoringErrors(guards);
      throw recoveryError;
    }
  }
  closeDirectoryGuardsIgnoringErrors(guards);
  const kind =
    code !== undefined && UNSUPPORTED_HARD_LINK_CODES.has(code)
      ? "publish-unsupported"
      : "publish-failed";
  throw safeFileError(entry.artifactClass, kind);
}

function linkPreparedEntry(entry: PreparedPublicationEntry, recovering: boolean): boolean {
  const guards = captureDirectoryGuards(entry.trustedRoot, entry.path, entry.artifactClass);
  try {
    linkSync(entry.stagePath, entry.path);
    finishGuardedLink(guards, entry);
    return true;
  } catch (error) {
    if (error instanceof SafeArtifactFileError) {
      closeDirectoryGuardsIgnoringErrors(guards);
      throw error;
    }
    return handleLinkFailure(error, entry, recovering, guards);
  }
}

function publishPreparedEntry(entry: PreparedPublicationEntry, recovering: boolean): void {
  if (recovering && pathExists(entry.path, entry.artifactClass)) {
    acceptRecoveredTarget(entry, true);
    return;
  }
  if (!linkPreparedEntry(entry, recovering)) return;
  try {
    if (!samePathNode(entry.stagePath, entry.path) || !linkedRecoveryContentsMatch(entry)) {
      throw safeFileError(entry.artifactClass, "target-mutated");
    }
  } catch (error) {
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(entry.artifactClass, "publish-failed");
  }
}

function cleanupPublishedStage(entry: PreparedPublicationEntry): void {
  if (!pathExists(entry.stagePath, entry.artifactClass)) {
    if (readExactPrivateFile(entry.path, entry.bytes, entry.artifactClass, entry.trustedRoot))
      return;
    throw safeFileError(entry.artifactClass, "recovery-conflict");
  }
  if (!samePathNode(entry.stagePath, entry.path) || !linkedRecoveryContentsMatch(entry)) {
    throw safeFileError(entry.artifactClass, "recovery-conflict");
  }
  try {
    unlinkSync(entry.stagePath);
  } catch {
    restoreRecoveryMarker(entry, dirname(entry.stagePath));
    throw safeFileError(entry.artifactClass, "publish-failed");
  }
  if (!readExactPrivateFile(entry.path, entry.bytes, entry.artifactClass, entry.trustedRoot)) {
    throw safeFileError(entry.artifactClass, "recovery-conflict");
  }
}

function restoreRecoveryMarker(entry: PreparedPublicationEntry, parent: string): void {
  if (pathExists(entry.stagePath, entry.artifactClass)) return;
  try {
    linkSync(entry.path, entry.stagePath);
  } catch {
    throw safeFileError(entry.artifactClass, "durability-failed");
  }
  syncDirectory(parent, entry.trustedRoot, entry.artifactClass);
}

function combineDurabilityAssurance(
  ...assurances: readonly SafeArtifactDurabilityAssurance[]
): SafeArtifactDurabilityAssurance {
  return assurances.includes("directory-sync-unavailable")
    ? "directory-sync-unavailable"
    : "verified";
}

function cleanupPublishedStages(
  entries: readonly PreparedPublicationEntry[],
  parent: string,
): SafeArtifactDurabilityAssurance {
  const commit = entries.at(-1);
  if (commit === undefined) return "verified";
  for (const entry of entries.slice(0, -1)) cleanupPublishedStage(entry);
  const beforeCommitCleanup = syncDirectory(parent, commit.trustedRoot, commit.artifactClass);
  cleanupPublishedStage(commit);
  try {
    const afterCommitCleanup = syncDirectory(parent, commit.trustedRoot, commit.artifactClass);
    return combineDurabilityAssurance(beforeCommitCleanup, afterCommitCleanup);
  } catch (error) {
    restoreRecoveryMarker(commit, parent);
    throw error;
  }
}

function publicationHasPath(
  entries: readonly PreparedPublicationEntry[],
  field: "path" | "stagePath",
): boolean {
  return entries.some((entry) => pathExists(entry[field], entry.artifactClass));
}

function publicationArtifactClass(entries: readonly PreparedPublicationEntry[]): SafeArtifactClass {
  return entries[0]?.artifactClass ?? "manifest";
}

/**
 * Publishes related files without replacement; the designated commit artifact appears last.
 * Filesystems without same-directory hard links fail closed as `publish-unsupported`.
 * A complete target-only state after loss of the final marker remains intact but is deliberately
 * ambiguous and therefore fails `target-exists`; only a durable deterministic stage authorizes
 * automatic recovery.
 */
export function publishSafeArtifactFileSet(
  entries: readonly SafeArtifactPublicationEntry[],
  options: SafeArtifactPublicationOptions,
): SafeArtifactPublicationResult {
  validatePublication(entries, options);
  const prepared = preparePublicationEntries(entries, options.commitPath, options.trustedRoot);
  const recovering = publicationHasPath(prepared, "stagePath");
  if (!recovering && publicationHasPath(prepared, "path")) {
    throw safeFileError(publicationArtifactClass(prepared), "target-exists");
  }
  for (const entry of prepared) ensurePreparedStage(entry, recovering);
  const parent = dirname(resolve(options.commitPath));
  const preparedAssurance = syncDirectory(
    parent,
    options.trustedRoot,
    publicationArtifactClass(prepared),
  );
  const ordered = orderedForCommit(prepared, options.commitPath);
  for (const entry of ordered) {
    publishPreparedEntry(entry, recovering);
  }
  const publishedAssurance = syncDirectory(
    parent,
    options.trustedRoot,
    publicationArtifactClass(prepared),
  );
  const cleanupAssurance = cleanupPublishedStages(ordered, parent);
  const status = recovering ? "recovered" : "published";
  return {
    status,
    permissionAssurance: safeArtifactPermissionAssurance(),
    durabilityAssurance: combineDurabilityAssurance(
      preparedAssurance,
      publishedAssurance,
      cleanupAssurance,
    ),
  };
}

/**
 * Fails closed until Node exposes a portable descriptor-relative atomic replacement primitive.
 * Absolute-path rename cannot exclude a final ancestor substitution, even with verified guards.
 */
export function replaceSafeArtifactFile(
  _path: string,
  _contents: string | Uint8Array,
  options: ReplaceSafeArtifactFileOptions,
): void {
  throw safeFileError(options.artifactClass, "publish-unsupported");
}
