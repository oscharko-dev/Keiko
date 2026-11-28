import {
  constants,
  closeSync,
  type Stats,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  nodeWorkspaceFs,
  WorkspaceDescriptorReadError,
  type WorkspaceFileReader,
  type WorkspaceFs,
} from "./fs.js";
import { resolveGitdir } from "./gitHistory.js";
import { assertContainedRealPath, resolveExistingAllowedWorkspaceRealRoot } from "./realpath.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";

const MAX_INDEX_BYTES = 16_777_216;
/**
 * A private object directory for candidate objects Git writes by path: nothing in it is visible to
 * the repository until the transaction publishes the objects into the live store once every check
 * passed (`publish` is idempotent and only for that moment and for tests), so
 * bytes that were refused never become readable Git objects. It lives inside the live `objects`
 * directory (as Git's own receive quarantine does), so publishing is a rename on one filesystem.
 */
export interface GitObjectQuarantine {
  readonly directory: string;
  readonly liveDirectory: string;
  readonly publish: () => void;
}
export interface GitIndexTransaction {
  readonly temporaryIndexPath: string;
  readonly check: () => boolean;
  // `hashLength` is the repository's object-id length (40 or 64): it fixes the one loose-object and
  // pack name shape the quarantine may hold. The objects are published by the transaction itself,
  // right before the index is promoted, after every check passed; a refused or failed transaction
  // never publishes anything.
  readonly openObjectQuarantine: (hashLength: number) => GitObjectQuarantine;
}

/**
 * Holds Git's own index.lock across the exact-candidate check and the atomic replacement.
 *
 * `fs` is the port the metadata base resolves through: a managed task worktree below the always-denied
 * `.keiko` segment is admitted only by the owned-root port the prover bound to it, while the plain
 * default keeps refusing such a root (2026-09-10).
 */
export async function withGitIndexTransaction<T>(
  workspaceRoot: string,
  mutate: (transaction: GitIndexTransaction) => Promise<T>,
  accept: (result: T) => boolean,
  fs: WorkspaceFs = nodeWorkspaceFs,
): Promise<T> {
  const base = await resolveGitdir(fs, workspaceRoot);
  if (base === undefined) throw new Error("git-index-metadata-unavailable");
  const directory = lstatSync(base.path);
  const lock = join(base.path, "index.lock");
  const descriptor = openSync(
    lock,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  const temporaryIndexPath = join(base.path, `.keiko-index-${randomUUID()}`);
  const check = (): boolean => sameDirectory(base.path, directory) && sameLock(lock, descriptor);
  const temporary = { owned: false };
  const quarantines: GitObjectQuarantine[] = [];
  try {
    if (!check()) throw new Error("git-index-metadata-drift");
    const indexExisted = await copyIndex(fs, base.path, temporaryIndexPath, () => {
      temporary.owned = true;
    });
    const result = await mutate({
      temporaryIndexPath,
      check,
      openObjectQuarantine: (hashLength) =>
        openObjectQuarantine(base.path, hashLength, quarantines),
    });
    if (accept(result)) {
      if (!check() || (await resolveGitdir(fs, workspaceRoot))?.path !== base.path)
        throw new Error("git-index-metadata-drift");
      if (!accept(result)) throw new Error("git-index-authority-denied");
      for (const quarantine of quarantines) quarantine.publish();
      promoteIndex(base.path, temporaryIndexPath, indexExisted);
    }
    return result;
  } finally {
    removeQuarantines(quarantines);
    cleanupIndexTransaction(base.path, directory, lock, descriptor, temporaryIndexPath, temporary);
  }
}
// Every quarantine goes on every outcome; what was published already lives in the store.
function removeQuarantines(quarantines: readonly GitObjectQuarantine[]): void {
  for (const quarantine of quarantines)
    rmSync(quarantine.directory, { recursive: true, force: true });
}
const LOOSE_FAN_OUT = /^[0-9a-f]{2}$/u;
// The live object directory a gitdir writes to: a linked worktree shares its main repository's.
function liveObjectsOf(gitdir: string): string {
  const live = join(branchRefsBase(gitdir), "objects");
  if (!lstatSync(live).isDirectory()) throw new Error("git-object-store-unavailable");
  return live;
}
function openObjectQuarantine(
  gitdir: string,
  hashLength: number,
  owned: GitObjectQuarantine[],
): GitObjectQuarantine {
  if (hashLength !== 40 && hashLength !== 64) throw new Error("git-object-quarantine-invalid");
  const liveDirectory = liveObjectsOf(gitdir);
  const directory = join(liveDirectory, `incoming-keiko-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  const quarantine: GitObjectQuarantine = {
    directory,
    liveDirectory,
    publish: (): void => {
      publishQuarantine(directory, liveDirectory, hashLength);
    },
  };
  owned.push(quarantine);
  return quarantine;
}
interface QuarantinedFile {
  readonly source: string;
  readonly target: string;
}
function regularFile(path: string): boolean {
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink();
}
// The loose objects of the quarantine: `xx/<hashLength - 2 hex characters>`, regular files only.
function looseObjectsOf(
  directory: string,
  liveDirectory: string,
  hashLength: number,
): readonly QuarantinedFile[] {
  const rest = new RegExp(`^[0-9a-f]{${String(hashLength - 2)}}$`, "u");
  const files: QuarantinedFile[] = [];
  for (const fanOut of readdirSync(directory).filter((name) => name !== "pack")) {
    const source = join(directory, fanOut);
    if (!LOOSE_FAN_OUT.test(fanOut) || !lstatSync(source).isDirectory())
      throw new Error("git-object-quarantine-invalid");
    for (const name of readdirSync(source)) {
      if (!rest.test(name) || !regularFile(join(source, name)))
        throw new Error("git-object-quarantine-invalid");
      files.push({ source: join(source, name), target: join(liveDirectory, fanOut, name) });
    }
  }
  return files;
}
const PACK_PART_ORDER = ["pack", "rev", "idx"] as const;
// A file Git above `core.bigFileThreshold` wrote as a pack: `pack-<id>.pack`, optionally `.rev`, and
// `.idx`. Readers find a pack through its index, so the index is published last. A pack without its
// index or an index without its pack, or any other name, is refused.
function packFilesOf(
  directory: string,
  liveDirectory: string,
  hashLength: number,
): readonly QuarantinedFile[] {
  const packs = join(directory, "pack");
  if (lstatSync(packs, { throwIfNoEntry: false }) === undefined) return [];
  const name = new RegExp(`^pack-[0-9a-f]{${String(hashLength)}}\\.(pack|rev|idx)$`, "u");
  const names = readdirSync(packs);
  const stems = new Set(names.map((entry) => entry.slice(0, entry.lastIndexOf("."))));
  const ordered = [...stems].flatMap((stem) =>
    PACK_PART_ORDER.map((part) => `${stem}.${part}`).filter((entry) => names.includes(entry)),
  );
  const complete = [...stems].every(
    (stem) => names.includes(`${stem}.pack`) && names.includes(`${stem}.idx`),
  );
  if (
    !lstatSync(packs).isDirectory() ||
    !complete ||
    ordered.length !== names.length ||
    !names.every((entry) => name.test(entry) && regularFile(join(packs, entry)))
  )
    throw new Error("git-object-quarantine-invalid");
  return ordered.map((entry) => ({
    source: join(packs, entry),
    target: join(liveDirectory, "pack", entry),
  }));
}
// Moves the quarantine into the live store. The whole tree is validated before the first rename, so
// an invalid entry never leaves a partial publication. An object that is already there (an earlier
// write, or a concurrent writer of the same object) is the same content under the same name and is
// left alone.
function publishQuarantine(directory: string, liveDirectory: string, hashLength: number): void {
  const plan = [
    ...looseObjectsOf(directory, liveDirectory, hashLength),
    ...packFilesOf(directory, liveDirectory, hashLength),
  ];
  for (const file of plan) {
    mkdirSync(dirname(file.target), { recursive: true });
    moveIfAbsent(file);
  }
}
// An existing target counts only as the object a concurrent writer already published: a regular
// file. A link, a directory or anything else where the object belongs is refused.
function publishedAlready(target: string): boolean {
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined) return false;
  if (!stat.isFile()) throw new Error("git-object-quarantine-invalid");
  return true;
}
function moveIfAbsent(file: QuarantinedFile): void {
  if (publishedAlready(file.target)) return;
  try {
    renameSync(file.source, file.target);
  } catch (error) {
    // A concurrent writer of the same object may win the race; Windows then reports EEXIST or EPERM
    // for a rename onto an existing file. Only that case is success; every other error is rethrown.
    const code = (error as NodeJS.ErrnoException).code;
    const raced = code === "EEXIST" || code === "EPERM" || code === "EACCES";
    if (!raced || !publishedAlready(file.target)) throw error;
  }
}
// The private copy replaces the live index. An index that was absent under Git's own lock is still
// absent: nothing wrote it meanwhile.
function promoteIndex(gitdir: string, temporaryIndexPath: string, indexExisted: boolean): void {
  assertIndexFile(temporaryIndexPath);
  const index = join(gitdir, "index");
  if (!indexExisted && lstatSync(index, { throwIfNoEntry: false }) !== undefined)
    throw new Error("git-index-metadata-drift");
  renameSync(temporaryIndexPath, index);
}

/** The message of the failure thrown when another process holds the branch ref lock (EEXIST). */
export const GIT_REF_LOCK_HELD = "git-ref-lock-held";

/** The message of the failure thrown when a branch ref lock cannot be created for another reason. */
export const GIT_REF_LOCK_UNAVAILABLE = "git-ref-lock-unavailable";

// The directory that holds `refs/heads`: the repository's own gitdir, or the common directory a
// linked worktree's gitdir (`<repo>/.git/worktrees/<name>`) shares.
function branchRefsBase(gitdir: string): string {
  return basename(dirname(gitdir)) === "worktrees" ? dirname(dirname(gitdir)) : gitdir;
}

function branchLockPath(heads: string, branch: string): string | undefined {
  const parts = branch.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\")))
    return undefined;
  const target = join(heads, ...parts);
  return relative(heads, target).startsWith("..") ? undefined : `${target}.lock`;
}

/**
 * Holds Git's own `<ref>.lock` for each named local branch while `run` executes. Git refuses every
 * update of a branch whose lock exists, so a state read inside `run` stays true until the write that
 * follows it: a commit or branch created by another process meanwhile fails on the lock instead of
 * being overwritten. A branch whose parent directory does not exist yet (a nested new name) is NOT
 * locked: there is no directory to hold a lock in, and another process can create that directory
 * and the ref between the caller's proof and its write. That window is a known residual gap, not a
 * guarantee. The caller narrows it by proving the state again right before its write, but cannot
 * close it. A lock that cannot be created fails closed.
 */
export async function withGitBranchRefLocks<T>(
  workspaceRoot: string,
  branches: readonly string[],
  run: () => Promise<T>,
  fs: WorkspaceFs = nodeWorkspaceFs,
): Promise<T> {
  const base = await resolveGitdir(fs, workspaceRoot);
  if (base === undefined) throw new Error("git-index-metadata-unavailable");
  const heads = join(branchRefsBase(base.path), "refs", "heads");
  const held: { path: string; descriptor: number }[] = [];
  try {
    for (const branch of branches) {
      const path = branchLockPath(heads, branch);
      if (path === undefined) throw new Error(GIT_REF_LOCK_UNAVAILABLE);
      const parent = lstatSync(dirname(path), { throwIfNoEntry: false });
      if (parent === undefined) continue;
      if (!parent.isDirectory() || parent.isSymbolicLink())
        throw new Error(GIT_REF_LOCK_UNAVAILABLE);
      held.push({ path, descriptor: openRefLock(path) });
    }
    return await run();
  } finally {
    for (const lock of held.reverse()) releaseRefLock(lock);
  }
}

function openRefLock(path: string): number {
  try {
    return openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    // Only an existing lock file is a lock another process holds; a permission, space or
    // read-only failure says nothing about a competing writer.
    const held = (error as NodeJS.ErrnoException).code === "EEXIST";
    throw new Error(held ? GIT_REF_LOCK_HELD : GIT_REF_LOCK_UNAVAILABLE, { cause: error });
  }
}

function releaseRefLock(lock: { readonly path: string; readonly descriptor: number }): void {
  try {
    if (sameLock(lock.path, lock.descriptor)) rmSync(lock.path);
  } finally {
    closeSync(lock.descriptor);
  }
}

function cleanupIndexTransaction(
  base: string,
  directory: NonNullable<ReturnType<typeof lstatSync>>,
  lock: string,
  descriptor: number,
  temporaryIndexPath: string,
  temporary: { readonly owned: boolean },
): void {
  try {
    if (!sameDirectory(base, directory)) return;
    if (temporary.owned) rmSync(temporaryIndexPath, { force: true });
    if (sameLock(lock, descriptor)) rmSync(lock);
  } finally {
    closeSync(descriptor);
  }
}
function sameDirectory(path: string, before: NonNullable<ReturnType<typeof lstatSync>>): boolean {
  const after = lstatSync(path, { throwIfNoEntry: false });
  return (
    after?.isDirectory() === true &&
    !after.isSymbolicLink() &&
    after.dev === before.dev &&
    after.ino === before.ino
  );
}
function sameLock(path: string, descriptor: number): boolean {
  const after = lstatSync(path, { throwIfNoEntry: false });
  const before = fstatSync(descriptor);
  return (
    after !== undefined &&
    after.isFile() &&
    after.nlink === 1 &&
    after.dev === before.dev &&
    after.ino === before.ino
  );
}
function assertIndexFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_INDEX_BYTES)
    throw new Error("git-index-file-invalid");
}
async function copyIndex(
  fs: WorkspaceFs,
  base: string,
  target: string,
  onCreated: () => void,
): Promise<boolean> {
  const source = join(base, "index");
  // A repository whose index was never written (a fresh `git init` before its first stage) has no
  // index file; Git reads an absent GIT_INDEX_FILE as the empty index and creates it on its first
  // write. Under the held lock nothing else can create it, so the private copy simply starts absent
  // and the owner of the copy is still recorded so a failed run removes whatever Git wrote.
  if (lstatSync(source, { throwIfNoEntry: false }) === undefined) {
    onCreated();
    return false;
  }
  assertIndexFile(source);
  const stat = fs.stat(source);
  const bytes = await fs.readFileBytes?.(source, MAX_INDEX_BYTES, "reject", stat);
  if (bytes?.byteLength !== stat.size) throw new Error("git-index-read-incomplete");
  const descriptor = openSync(
    target,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    onCreated();
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
  return true;
}

export interface GitStageFile {
  readonly path: string;
  readonly mode: "100644" | "100755" | "120000" | "0";
  readonly bytes: Uint8Array;
}
/**
 * The identity of a regular file as the one lstat saw it. A streamed or Git-side read is accepted
 * only while the file still has exactly this identity, so a file that changes (or is swapped for a
 * link) while it is read fails closed instead of being staged as a mix of two states.
 */
export interface GitStageFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}
/**
 * A regular file whose bytes are never held in memory: the status and staging paths stream it
 * (`streamGitStageFile`) or hand its path to Git, and verify its identity afterwards. Only its size
 * and identity are known up front.
 */
export interface GitStageLargeFile {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly size: number;
  readonly identity: GitStageFileIdentity;
}
export type GitStageContent = GitStageFile | GitStageLargeFile;
export function isGitStageLargeFile(content: GitStageContent): content is GitStageLargeFile {
  return !("bytes" in content);
}
/** Closed failure codes a stage-file read throws (the `Error` message is the code). */
export const GIT_STAGE_FILE_TOO_LARGE = "git-stage-file-too-large";
export const GIT_STAGE_FILE_CHANGED = "git-stage-file-changed";
// Permanent: the entry is not a regular file (a directory, a device, a FIFO) or has several hard
// links, which the stage lane never reads. Retrying cannot cure either, unlike a change mid-read.
export const GIT_STAGE_FILE_NOT_REGULAR = "git-stage-file-not-regular";
export const GIT_STAGE_FILE_HARD_LINKED = "git-stage-file-hard-linked";
export const GIT_STAGE_READ_CANCELLED = "git-stage-read-cancelled";
export interface GitStageReadOptions {
  readonly maxBytes?: number | undefined;
  // The port containment resolves through; the owned-root port admits a managed worktree below the
  // always-denied `.keiko` segment, the plain default keeps refusing it (2026-09-10).
  readonly fs?: WorkspaceFs | undefined;
  /**
   * `contained` (the default, and the only mode the staging write path uses) refuses a symlink whose
   * target is absolute, denied or outside the workspace. `read-only` is for status comparison: the
   * link contributes its raw `readlink` bytes, exactly what Git stores in the blob, and the target
   * is neither resolved nor followed, so an unchanged link to `/usr/share/x` or `../shared` reads as
   * the unchanged entry it is instead of failing the whole status read.
   */
  readonly symlinks?: "contained" | "read-only" | undefined;
  // Checked between the chunks of a streamed read: a cancelled run stops reading a multi-gigabyte
  // file at the next chunk instead of finishing the pass.
  readonly signal?: AbortSignal | undefined;
}
export interface GitStageInspectOptions extends GitStageReadOptions {
  /**
   * A regular file above this size is returned as a `GitStageLargeFile` instead of being read into
   * memory. The default is the governed Git stdin contract (a file's bytes travel on stdin only up
   * to 64 KiB); a caller that only compares content raises it to what it is willing to hold.
   */
  readonly inlineMaxBytes?: number | undefined;
}
/**
 * The most bytes one in-memory stage read may carry. A file above it is never read whole by the
 * status and staging paths (`inspectGitStageFile` streams it); the bound only protects the memory
 * of a caller that explicitly needs every byte at once through `readGitStageFile`.
 */
export const GIT_STAGE_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const GIT_STAGE_INLINE_MAX_BYTES = 64 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;
function stageReadSettings(options: GitStageReadOptions): {
  readonly fs: WorkspaceFs;
  readonly maxBytes: number;
} {
  return {
    fs: options.fs ?? nodeWorkspaceFs,
    maxBytes: options.maxBytes ?? GIT_STAGE_FILE_MAX_BYTES,
  };
}
interface StageTarget {
  readonly fs: WorkspaceFs;
  readonly canonical: string;
  readonly absolute: string;
  readonly before: Stats | undefined;
}
function stageTarget(root: string, path: string, fs: WorkspaceFs): StageTarget {
  const canonical = resolveExistingAllowedWorkspaceRealRoot(fs, root);
  const absolute = resolveWithinWorkspace(canonical, path);
  if (isDenied(path) || relative(canonical, absolute).replaceAll("\\", "/") !== path)
    throw new Error("git-stage-path-denied");
  assertStageParent(fs, canonical, absolute);
  return { fs, canonical, absolute, before: lstatSync(absolute, { throwIfNoEntry: false }) };
}
function stageFileMode(before: Stats): "100644" | "100755" {
  return (before.mode & 0o111) === 0 ? "100644" : "100755";
}
function stageIdentity(path: string): GitStageFileIdentity {
  const stat = lstatSync(path, { bigint: true });
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}
function assertSameIdentity(absolute: string, file: GitStageLargeFile): void {
  const stat = lstatSync(absolute, { bigint: true, throwIfNoEntry: false });
  const expected = file.identity;
  if (
    stat?.isFile() !== true ||
    stat.dev !== expected.dev ||
    stat.ino !== expected.ino ||
    stat.size !== expected.size ||
    stat.mtimeNs !== expected.mtimeNs ||
    stat.ctimeNs !== expected.ctimeNs
  )
    throw new Error(GIT_STAGE_FILE_CHANGED);
}
/** Stable no-follow content read. A symlink contributes only its contained relative target bytes. */
export async function readGitStageFile(
  root: string,
  path: string,
  options: GitStageReadOptions = {},
): Promise<GitStageFile> {
  const { fs, maxBytes } = stageReadSettings(options);
  const target = stageTarget(root, path, fs);
  const early = nonRegularStageFile(target, path, options);
  if (early !== undefined) return early;
  const { before, absolute, canonical } = target;
  if (before === undefined || before.size > maxBytes) throw new Error(GIT_STAGE_FILE_TOO_LARGE);
  const bytes = await readRegularBytes(target, maxBytes);
  assertContainedRealPath(fs, canonical, absolute, "git-stage-file");
  return { path, mode: stageFileMode(before), bytes };
}
async function readRegularBytes(target: StageTarget, maxBytes: number): Promise<Uint8Array> {
  const { fs, absolute, before } = target;
  const expected = fs.stat(absolute);
  let bytes: Uint8Array | undefined;
  try {
    bytes = await fs.readFileBytes?.(absolute, maxBytes, "reject", expected);
  } catch (error) {
    throw changedOrOriginal(error);
  }
  if (bytes === undefined || bytes.byteLength !== before?.size)
    throw new Error(GIT_STAGE_FILE_CHANGED);
  return bytes;
}
// A missing path (`mode: "0"`) or a symlink; `undefined` for a regular file.
function nonRegularStageFile(
  target: StageTarget,
  path: string,
  options: GitStageReadOptions,
): GitStageFile | undefined {
  const { before, fs, canonical, absolute } = target;
  if (before === undefined) return { path, mode: "0", bytes: new Uint8Array() };
  if (before.isSymbolicLink()) return stageLink(options, fs, canonical, path, absolute, before);
  return undefined;
}
/**
 * The same checks as `readGitStageFile`, but a regular file above `inlineMaxBytes` is returned as a
 * `GitStageLargeFile` (size and identity only) instead of being read, so no file size ever makes
 * the read fail and no large file is ever held whole in memory.
 */
export async function inspectGitStageFile(
  root: string,
  path: string,
  options: GitStageInspectOptions = {},
): Promise<GitStageContent> {
  const { fs, maxBytes } = stageReadSettings(options);
  const inlineMax = Math.min(options.inlineMaxBytes ?? GIT_STAGE_INLINE_MAX_BYTES, maxBytes);
  const target = stageTarget(root, path, fs);
  const early = nonRegularStageFile(target, path, options);
  if (early !== undefined) return early;
  const { before, absolute, canonical } = target;
  if (before === undefined) throw new Error(GIT_STAGE_FILE_CHANGED);
  if (before.size > inlineMax) {
    assertContainedRealPath(fs, canonical, absolute, "git-stage-file");
    if (!before.isFile()) throw new Error(GIT_STAGE_FILE_NOT_REGULAR);
    if (before.nlink > 1) throw new Error(GIT_STAGE_FILE_HARD_LINKED);
    const identity = stageIdentity(absolute);
    if (identity.size !== BigInt(before.size)) throw new Error(GIT_STAGE_FILE_CHANGED);
    return { path, mode: stageFileMode(before), size: before.size, identity };
  }
  const bytes = await readRegularBytes(target, inlineMax);
  assertContainedRealPath(fs, canonical, absolute, "git-stage-file");
  return { path, mode: stageFileMode(before), bytes };
}
/**
 * Streams a large file's bytes to `visit` in bounded chunks through the workspace port's validated
 * descriptor reader (no-follow, hard-link policy, descriptor snapshot checked around every range),
 * so memory holds one chunk, never the file. The file must still have the identity `inspect` saw,
 * both before the first and after the last chunk, or the read fails closed as
 * `git-stage-file-changed`.
 */
export async function streamGitStageFile(
  root: string,
  file: GitStageLargeFile,
  options: GitStageReadOptions,
  visit: (chunk: Uint8Array) => void,
): Promise<void> {
  const { fs } = stageReadSettings(options);
  const { canonical, absolute } = stageTarget(root, file.path, fs);
  assertSameIdentity(absolute, file);
  const openReader = fs.openFileReader;
  if (openReader === undefined) throw new Error("git-stage-file-unreadable");
  const reader = await readerOrChanged(openReader, fs, absolute);
  try {
    let offset = 0;
    while (offset < file.size) {
      if (options.signal?.aborted === true) throw new Error(GIT_STAGE_READ_CANCELLED);
      const length = Math.min(STREAM_CHUNK_BYTES, file.size - offset);
      const chunk = await rangeOrChanged(reader, offset, length); // NOSONAR typescript:S9382 -- chunks are read in order, one in memory at a time
      if (chunk.byteLength === 0) break;
      visit(chunk);
      offset += chunk.byteLength;
    }
    if (offset !== file.size) throw new Error(GIT_STAGE_FILE_CHANGED);
  } finally {
    await reader.close();
  }
  assertContainedRealPath(fs, canonical, absolute, "git-stage-file");
  assertSameIdentity(absolute, file);
}
async function readerOrChanged(
  open: NonNullable<WorkspaceFs["openFileReader"]>,
  fs: WorkspaceFs,
  absolute: string,
): Promise<WorkspaceFileReader> {
  try {
    return await open.call(fs, absolute, "reject", fs.stat(absolute));
  } catch (error) {
    throw changedOrOriginal(error);
  }
}
async function rangeOrChanged(
  reader: WorkspaceFileReader,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  try {
    return await reader.readRange(offset, length);
  } catch (error) {
    throw changedOrOriginal(error);
  }
}
function changedOrOriginal(error: unknown): unknown {
  return error instanceof WorkspaceDescriptorReadError && error.reason === "changed"
    ? new Error(GIT_STAGE_FILE_CHANGED)
    : error;
}
/**
 * Confirms that a large file is still exactly what `inspectGitStageFile` saw, after Git itself read
 * it by path: the identity (including ctime) is unchanged and the path still resolves inside the
 * workspace. A swap for a link or another file fails closed as `git-stage-file-changed`.
 */
export function assertGitStageFileUnchanged(
  root: string,
  file: GitStageLargeFile,
  options: GitStageReadOptions = {},
): void {
  const { fs } = stageReadSettings(options);
  const { canonical, absolute } = stageTarget(root, file.path, fs);
  assertSameIdentity(absolute, file);
  assertContainedRealPath(fs, canonical, absolute, "git-stage-file");
}
function assertStageParent(fs: WorkspaceFs, root: string, absolute: string): void {
  let parent = dirname(absolute);
  while (parent !== root && !fs.exists(parent)) parent = dirname(parent);
  assertContainedRealPath(fs, root, parent, "git-stage-parent");
}

function stageLink(
  options: GitStageReadOptions,
  fs: WorkspaceFs,
  root: string,
  path: string,
  absolute: string,
  before: NonNullable<ReturnType<typeof lstatSync>>,
): GitStageFile {
  return options.symlinks === "read-only"
    ? readSymlinkBytes(path, absolute, before)
    : stageSymlink(fs, root, path, absolute, before);
}
function readSymlinkBytes(
  path: string,
  absolute: string,
  before: NonNullable<ReturnType<typeof lstatSync>>,
): GitStageFile {
  const target = readlinkSync(absolute);
  const after = lstatSync(absolute);
  if (after.ino !== before.ino || after.ctimeMs !== before.ctimeMs)
    throw new Error("git-stage-link-drift");
  return { path, mode: "120000", bytes: Buffer.from(target) };
}

function stageSymlink(
  fs: WorkspaceFs,
  root: string,
  path: string,
  absolute: string,
  before: NonNullable<ReturnType<typeof lstatSync>>,
): GitStageFile {
  const target = readlinkSync(absolute);
  const resolved = resolve(dirname(absolute), target);
  const targetPath = relative(root, resolved).replaceAll("\\", "/");
  if (target.startsWith("/") || isDenied(targetPath)) throw new Error("git-stage-link-denied");
  assertContainedRealPath(fs, root, resolved, "git-stage-link");
  const after = lstatSync(absolute);
  if (
    after.ino !== before.ino ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  )
    throw new Error("git-stage-link-drift");
  return { path, mode: "120000", bytes: Buffer.from(target) };
}
