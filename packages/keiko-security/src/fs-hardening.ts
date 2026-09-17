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
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
  "support-bundle",
  "support-integrity",
  "replay-fixture",
  "manifest",
  "integrity-artifact",
] as const;

export type SafeArtifactClass = (typeof SAFE_ARTIFACT_CLASSES)[number];
export type SafeArtifactOpenMode = "append-existing-or-create" | "exclusive-create" | "read";
export type SafeArtifactFileFailureKind =
  | "invalid-publication"
  | "open-failed"
  | "permission-failed"
  | "permission-unsafe"
  | "publish-failed"
  | "publish-unsupported"
  | "read-failed"
  | "recovery-conflict"
  | "replace-failed"
  | "target-exists"
  | "target-mutated"
  | "unsafe-target"
  | "write-failed";

/** A closed, body-free filesystem failure safe to project into diagnostics. */
export class SafeArtifactFileError extends Error {
  public override readonly name = "SafeArtifactFileError";

  public constructor(
    public readonly artifactClass: SafeArtifactClass,
    public readonly kind: SafeArtifactFileFailureKind,
  ) {
    super(`safe artifact ${artifactClass} failed: ${kind}`);
  }
}

export interface OpenSafeArtifactFileOptions {
  readonly artifactClass: SafeArtifactClass;
  readonly mode: SafeArtifactOpenMode;
}

function safeFileError(
  artifactClass: SafeArtifactClass,
  kind: SafeArtifactFileFailureKind,
): SafeArtifactFileError {
  return new SafeArtifactFileError(artifactClass, kind);
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
  const create = constants.O_WRONLY | constants.O_CREAT;
  return mode === "exclusive-create" ? create | constants.O_EXCL : create | constants.O_APPEND;
}

function permissionIsPrivate(mode: number): boolean {
  return process.platform === "win32" || (mode & 0o077) === 0;
}

function verifyDescriptorIdentity(
  descriptor: number,
  path: string,
  artifactClass: SafeArtifactClass,
): Stats {
  let opened: Stats;
  try {
    opened = fstatSync(descriptor);
  } catch {
    throw safeFileError(artifactClass, "open-failed");
  }
  if (!opened.isFile() || opened.nlink !== 1) {
    throw safeFileError(artifactClass, "unsafe-target");
  }
  let pathname: ReturnType<typeof lstatSync>;
  try {
    pathname = lstatSync(path);
  } catch {
    throw safeFileError(artifactClass, "target-mutated");
  }
  if (
    pathname.isSymbolicLink() ||
    !pathname.isFile() ||
    pathname.nlink !== 1 ||
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
  artifactClass: SafeArtifactClass,
): void {
  const opened = verifyDescriptorIdentity(descriptor, path, artifactClass);
  if (!permissionIsPrivate(opened.mode)) {
    throw safeFileError(artifactClass, "permission-unsafe");
  }
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

/** Opens without following the final symlink and verifies the descriptor before any caller write. */
export function openSafeArtifactFile(path: string, options: OpenSafeArtifactFileOptions): number {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const nonBlocking = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  if (noFollow === 0) refuseSymlinkFallback(path, options.artifactClass);
  let descriptor: number;
  try {
    descriptor = openSync(path, openFlags(options.mode) | noFollow | nonBlocking, FILE_MODE);
  } catch (error) {
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(options.artifactClass, mapOpenError(error));
  }
  try {
    verifyDescriptorIdentity(descriptor, path, options.artifactClass);
    if (options.mode !== "read") tightenDescriptor(descriptor, options.artifactClass);
    verifySafeArtifactFileDescriptor(descriptor, path, options.artifactClass);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export interface SafeArtifactPublicationEntry {
  readonly path: string;
  readonly contents: string | Uint8Array;
  readonly artifactClass: SafeArtifactClass;
}

export interface SafeArtifactPublicationOptions {
  readonly commitPath: string;
}

export interface SafeArtifactPublicationResult {
  readonly status: "published" | "recovered";
}

export interface ReplaceSafeArtifactFileOptions {
  readonly artifactClass: SafeArtifactClass;
}

interface PreparedPublicationEntry {
  readonly path: string;
  readonly stagePath: string;
  readonly bytes: Buffer;
  readonly artifactClass: SafeArtifactClass;
}

function publicationId(
  entries: readonly SafeArtifactPublicationEntry[],
  commitPath: string,
): string {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(resolve(entry.path)).update("\0");
  hash.update(resolve(commitPath));
  return hash.digest("hex").slice(0, 24);
}

function preparePublicationEntries(
  entries: readonly SafeArtifactPublicationEntry[],
  commitPath: string,
): readonly PreparedPublicationEntry[] {
  const parent = dirname(resolve(commitPath));
  const id = publicationId(entries, commitPath);
  return entries.map((entry, index) => ({
    path: resolve(entry.path),
    stagePath: join(parent, `.keiko-publish-${id}-${String(index)}.stage`),
    bytes:
      typeof entry.contents === "string"
        ? Buffer.from(entry.contents, "utf8")
        : Buffer.from(entry.contents),
    artifactClass: entry.artifactClass,
  }));
}

function validatePublication(
  entries: readonly SafeArtifactPublicationEntry[],
  commitPath: string,
): void {
  const fallbackClass = entries[0]?.artifactClass ?? "manifest";
  const resolvedCommit = resolve(commitPath);
  const paths = entries.map((entry) => resolve(entry.path));
  const parents = new Set(paths.map(dirname));
  if (
    entries.length === 0 ||
    !paths.includes(resolvedCommit) ||
    new Set(paths).size !== paths.length ||
    parents.size !== 1
  ) {
    throw safeFileError(fallbackClass, "invalid-publication");
  }
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

function createStage(entry: PreparedPublicationEntry): void {
  const descriptor = openSafeArtifactFile(entry.stagePath, {
    artifactClass: entry.artifactClass,
    mode: "exclusive-create",
  });
  try {
    writeAll(descriptor, entry.bytes, entry.artifactClass);
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(entry.artifactClass, "write-failed");
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string, artifactClass: SafeArtifactClass): void {
  if (process.platform === "win32") return;
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const directory = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow | directory);
    if (!fstatSync(descriptor).isDirectory()) throw safeFileError(artifactClass, "publish-failed");
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(artifactClass, "publish-failed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readExactPrivateFile(
  path: string,
  expected: Buffer,
  artifactClass: SafeArtifactClass,
): boolean {
  const descriptor = openSafeArtifactFile(path, { artifactClass, mode: "read" });
  try {
    const buffer = Buffer.alloc(expected.length + 1);
    const read = readSync(descriptor, buffer, 0, buffer.length, 0);
    return read === expected.length && buffer.subarray(0, read).equals(expected);
  } catch (error) {
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(artifactClass, "read-failed");
  } finally {
    closeSync(descriptor);
  }
}

function samePathNode(left: string, right: string): boolean {
  try {
    const leftStat = lstatSync(left);
    const rightStat = lstatSync(right);
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
  if (!samePathNode(entry.stagePath, entry.path)) {
    throw safeFileError(entry.artifactClass, "recovery-conflict");
  }
  try {
    unlinkSync(entry.stagePath);
  } catch {
    throw safeFileError(entry.artifactClass, "publish-failed");
  }
  if (!readExactPrivateFile(entry.path, entry.bytes, entry.artifactClass)) {
    throw safeFileError(entry.artifactClass, "recovery-conflict");
  }
  return true;
}

function ensurePreparedStage(entry: PreparedPublicationEntry, recovering: boolean): void {
  if (recoverLinkedStage(entry)) return;
  const stageExists = pathExists(entry.stagePath, entry.artifactClass);
  const targetExists = pathExists(entry.path, entry.artifactClass);
  if (targetExists) {
    if (!recovering || !readExactPrivateFile(entry.path, entry.bytes, entry.artifactClass)) {
      throw safeFileError(entry.artifactClass, recovering ? "recovery-conflict" : "target-exists");
    }
    return;
  }
  if (!stageExists) {
    createStage(entry);
    return;
  }
  if (!readExactPrivateFile(entry.stagePath, entry.bytes, entry.artifactClass)) {
    throw safeFileError(entry.artifactClass, "recovery-conflict");
  }
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

function publishPreparedEntry(entry: PreparedPublicationEntry, parent: string): void {
  if (pathExists(entry.path, entry.artifactClass)) return;
  try {
    linkSync(entry.stagePath, entry.path);
  } catch (error) {
    const kind = errorCode(error) === "EXDEV" ? "publish-unsupported" : "publish-failed";
    throw safeFileError(entry.artifactClass, kind);
  }
  try {
    if (!samePathNode(entry.stagePath, entry.path)) {
      throw safeFileError(entry.artifactClass, "target-mutated");
    }
    syncDirectory(parent, entry.artifactClass);
    unlinkSync(entry.stagePath);
    if (!readExactPrivateFile(entry.path, entry.bytes, entry.artifactClass)) {
      throw safeFileError(entry.artifactClass, "target-mutated");
    }
  } catch (error) {
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(entry.artifactClass, "publish-failed");
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

/** Publishes related files without replacement; the designated commit artifact appears last. */
export function publishSafeArtifactFileSet(
  entries: readonly SafeArtifactPublicationEntry[],
  options: SafeArtifactPublicationOptions,
): SafeArtifactPublicationResult {
  validatePublication(entries, options.commitPath);
  const prepared = preparePublicationEntries(entries, options.commitPath);
  const recovering = publicationHasPath(prepared, "stagePath");
  if (!recovering && publicationHasPath(prepared, "path")) {
    throw safeFileError(publicationArtifactClass(prepared), "target-exists");
  }
  for (const entry of prepared) ensurePreparedStage(entry, recovering);
  const parent = dirname(resolve(options.commitPath));
  syncDirectory(parent, publicationArtifactClass(prepared));
  for (const entry of orderedForCommit(prepared, options.commitPath)) {
    publishPreparedEntry(entry, parent);
  }
  syncDirectory(parent, publicationArtifactClass(prepared));
  const status = recovering ? "recovered" : "published";
  return { status };
}

function replacementStagePath(path: string): string {
  const id = createHash("sha256").update(resolve(path)).digest("hex").slice(0, 24);
  return join(dirname(resolve(path)), `.keiko-replace-${id}.stage`);
}

function writeReplacementStage(
  path: string,
  contents: string | Uint8Array,
  artifactClass: SafeArtifactClass,
): string {
  const stagePath = replacementStagePath(path);
  if (pathExists(stagePath, artifactClass)) {
    throw safeFileError(artifactClass, "recovery-conflict");
  }
  const bytes =
    typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents);
  createStage({ path: resolve(path), stagePath, bytes, artifactClass });
  return stagePath;
}

function assertSafeReplacementTarget(path: string, artifactClass: SafeArtifactClass): void {
  const descriptor = openSafeArtifactFile(path, { artifactClass, mode: "read" });
  closeSync(descriptor);
}

/** Atomically replaces an existing, verified private file; unsupported on Windows. */
export function replaceSafeArtifactFile(
  path: string,
  contents: string | Uint8Array,
  options: ReplaceSafeArtifactFileOptions,
): void {
  if (process.platform === "win32") {
    throw safeFileError(options.artifactClass, "publish-unsupported");
  }
  assertSafeReplacementTarget(path, options.artifactClass);
  const stagePath = writeReplacementStage(path, contents, options.artifactClass);
  const parent = dirname(resolve(path));
  try {
    syncDirectory(parent, options.artifactClass);
    assertSafeReplacementTarget(path, options.artifactClass);
    renameSync(stagePath, path);
    assertSafeReplacementTarget(path, options.artifactClass);
    syncDirectory(parent, options.artifactClass);
  } catch (error) {
    if (error instanceof SafeArtifactFileError) throw error;
    throw safeFileError(options.artifactClass, "replace-failed");
  }
}
