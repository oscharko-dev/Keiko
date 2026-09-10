import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { resolveGitdir } from "./gitHistory.js";
import { assertContainedRealPath, resolveExistingAllowedWorkspaceRealRoot } from "./realpath.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";

const MAX_INDEX_BYTES = 16_777_216;
export interface GitIndexTransaction {
  readonly temporaryIndexPath: string;
  readonly check: () => boolean;
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
  try {
    if (!check()) throw new Error("git-index-metadata-drift");
    await copyIndex(fs, base.path, temporaryIndexPath, () => {
      temporary.owned = true;
    });
    const result = await mutate({ temporaryIndexPath, check });
    if (accept(result)) {
      if (!check() || (await resolveGitdir(fs, workspaceRoot))?.path !== base.path)
        throw new Error("git-index-metadata-drift");
      if (!accept(result)) throw new Error("git-index-authority-denied");
      assertIndexFile(temporaryIndexPath);
      renameSync(temporaryIndexPath, join(base.path, "index"));
    }
    return result;
  } finally {
    cleanupIndexTransaction(base.path, directory, lock, descriptor, temporaryIndexPath, temporary);
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
): Promise<void> {
  const source = join(base, "index");
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
}

export interface GitStageFile {
  readonly path: string;
  readonly mode: "100644" | "100755" | "120000" | "0";
  readonly bytes: Uint8Array;
}
export interface GitStageReadOptions {
  readonly maxBytes?: number | undefined;
  // The port containment resolves through; the owned-root port admits a managed worktree below the
  // always-denied `.keiko` segment, the plain default keeps refusing it (2026-09-10).
  readonly fs?: WorkspaceFs | undefined;
}
/**
 * The most bytes one staged file may carry, and the most a whole stage candidate may sum to. Until
 * 2026-09-10 both were 64 KiB: a lockfile, a bundled asset or eight ordinary source files together
 * could not be staged by a governed run at all, and the refusal surfaced as a failed Git effect
 * (Coding Workbench run 13, owner review of PR #3452). The per-file bound equals the raw worktree
 * scan's content budget — a file the scan cannot read is never listed as a change, so nothing
 * admitted for staging can exceed it — and the candidate bound keeps a fifty-path selection's
 * resident bytes to what one local process can hold while it digests and writes them.
 */
export const GIT_STAGE_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const GIT_STAGE_CANDIDATE_MAX_BYTES = 32 * 1024 * 1024;
function stageReadSettings(options: GitStageReadOptions): {
  readonly fs: WorkspaceFs;
  readonly maxBytes: number;
} {
  return {
    fs: options.fs ?? nodeWorkspaceFs,
    maxBytes: options.maxBytes ?? GIT_STAGE_FILE_MAX_BYTES,
  };
}
/** Stable no-follow content read. A symlink contributes only its contained relative target bytes. */
export async function readGitStageFile(
  root: string,
  path: string,
  options: GitStageReadOptions = {},
): Promise<GitStageFile> {
  const { fs, maxBytes } = stageReadSettings(options);
  const canonical = resolveExistingAllowedWorkspaceRealRoot(fs, root);
  const absolute = resolveWithinWorkspace(canonical, path);
  if (isDenied(path) || relative(canonical, absolute).replaceAll("\\", "/") !== path)
    throw new Error("git-stage-path-denied");
  assertStageParent(fs, canonical, absolute);
  const before = lstatSync(absolute, { throwIfNoEntry: false });
  if (before === undefined) return { path, mode: "0", bytes: new Uint8Array() };
  if (before.isSymbolicLink()) return stageSymlink(fs, canonical, path, absolute, before);
  const expected = fs.stat(absolute);
  const bytes = await fs.readFileBytes?.(absolute, maxBytes, "reject", expected);
  if (bytes?.byteLength !== before.size) throw new Error("git-stage-file-incomplete");
  assertContainedRealPath(fs, canonical, absolute, "git-stage-file");
  return { path, mode: (before.mode & 0o111) === 0 ? "100644" : "100755", bytes };
}
function assertStageParent(fs: WorkspaceFs, root: string, absolute: string): void {
  let parent = dirname(absolute);
  while (parent !== root && !fs.exists(parent)) parent = dirname(parent);
  assertContainedRealPath(fs, root, parent, "git-stage-parent");
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
