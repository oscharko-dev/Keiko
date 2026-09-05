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
import { nodeWorkspaceFs } from "./fs.js";
import { resolveGitdir } from "./gitHistory.js";
import { assertContainedRealPath, resolveExistingAllowedWorkspaceRealRoot } from "./realpath.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";

const MAX_INDEX_BYTES = 16_777_216;
export interface GitIndexTransaction {
  readonly temporaryIndexPath: string;
  readonly check: () => boolean;
}

/** Holds Git's own index.lock across the exact-candidate check and the atomic replacement. */
export async function withGitIndexTransaction<T>(
  workspaceRoot: string,
  mutate: (transaction: GitIndexTransaction) => Promise<T>,
  accept: (result: T) => boolean,
): Promise<T> {
  const base = await resolveGitdir(nodeWorkspaceFs, workspaceRoot);
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
    await copyIndex(base.path, temporaryIndexPath, () => {
      temporary.owned = true;
    });
    const result = await mutate({ temporaryIndexPath, check });
    if (accept(result)) {
      if (!check() || (await resolveGitdir(nodeWorkspaceFs, workspaceRoot))?.path !== base.path)
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
async function copyIndex(base: string, target: string, onCreated: () => void): Promise<void> {
  const source = join(base, "index");
  assertIndexFile(source);
  const stat = nodeWorkspaceFs.stat(source);
  const bytes = await nodeWorkspaceFs.readFileBytes?.(source, MAX_INDEX_BYTES, "reject", stat);
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
/** Stable no-follow content read. A symlink contributes only its contained relative target bytes. */
export async function readGitStageFile(
  root: string,
  path: string,
  maxBytes = 65_536,
): Promise<GitStageFile> {
  const canonical = resolveExistingAllowedWorkspaceRealRoot(nodeWorkspaceFs, root);
  const absolute = resolveWithinWorkspace(canonical, path);
  if (isDenied(path) || relative(canonical, absolute).replaceAll("\\", "/") !== path)
    throw new Error("git-stage-path-denied");
  assertStageParent(canonical, absolute);
  const before = lstatSync(absolute, { throwIfNoEntry: false });
  if (before === undefined) return { path, mode: "0", bytes: new Uint8Array() };
  if (before.isSymbolicLink()) return stageSymlink(canonical, path, absolute, before);
  const expected = nodeWorkspaceFs.stat(absolute);
  const bytes = await nodeWorkspaceFs.readFileBytes?.(absolute, maxBytes, "reject", expected);
  if (bytes?.byteLength !== before.size) throw new Error("git-stage-file-incomplete");
  assertContainedRealPath(nodeWorkspaceFs, canonical, absolute, "git-stage-file");
  return { path, mode: (before.mode & 0o111) === 0 ? "100644" : "100755", bytes };
}
function assertStageParent(root: string, absolute: string): void {
  let parent = dirname(absolute);
  while (parent !== root && !nodeWorkspaceFs.exists(parent)) parent = dirname(parent);
  assertContainedRealPath(nodeWorkspaceFs, root, parent, "git-stage-parent");
}

function stageSymlink(
  root: string,
  path: string,
  absolute: string,
  before: NonNullable<ReturnType<typeof lstatSync>>,
): GitStageFile {
  const target = readlinkSync(absolute);
  const resolved = resolve(dirname(absolute), target);
  const targetPath = relative(root, resolved).replaceAll("\\", "/");
  if (target.startsWith("/") || isDenied(targetPath)) throw new Error("git-stage-link-denied");
  assertContainedRealPath(nodeWorkspaceFs, root, resolved, "git-stage-link");
  const after = lstatSync(absolute);
  if (
    after.ino !== before.ino ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  )
    throw new Error("git-stage-link-drift");
  return { path, mode: "120000", bytes: Buffer.from(target) };
}
