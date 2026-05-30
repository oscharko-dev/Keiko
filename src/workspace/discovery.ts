// Recursive, bounded, deterministic file discovery and a single boundary-checked read path.
// Security invariants (ADR-0005 D2/D3):
//   - every directory descent and every read goes through resolveWithinWorkspace first;
//   - always-on DENY patterns are applied before the optional .gitignore subset;
//   - a symlink whose realpath escapes the root is skipped (never followed);
//   - recursion is capped by maxDepth and total results by maxFiles.

import { relative } from "node:path";
import {
  nodeWorkspaceFs,
  type WorkspaceDirEntry,
  type WorkspaceFs,
  type WorkspaceStat,
} from "./fs.js";
import { compileIgnore, isDenied, isIgnored, type IgnoreMatcher } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import { assertContainedRealPath } from "./realpath.js";
import { FileTooLargeError, PathDeniedError, WorkspaceReadError } from "./errors.js";
import { redact } from "../gateway/redaction.js";
import {
  DEFAULT_READ_OPTIONS,
  type DiscoveredFile,
  type DiscoveryOptions,
  type DiscoveryStats,
  type FileContent,
  type ReadOptions,
  type WorkspaceInfo,
} from "./types.js";

interface Walk {
  readonly fs: WorkspaceFs;
  readonly root: string;
  readonly matcher: IgnoreMatcher;
  readonly opts: DiscoveryOptions;
  readonly applyGitignore: boolean;
  readonly out: DiscoveredFile[];
  denied: number;
  ignored: number;
}

export interface DiscoveryResult {
  readonly files: readonly DiscoveredFile[];
  readonly stats: DiscoveryStats;
}

function toRelative(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split("\\").join("/");
}

function toRealRelative(fs: WorkspaceFs, root: string, absolutePath: string): string {
  try {
    return toRelative(fs.realPath(root), absolutePath);
  } catch {
    return toRelative(root, absolutePath);
  }
}

// Returns false when the entry must be skipped for any security or noise reason, recording
// which tier rejected it for the discovery stats.
function isAllowed(walk: Walk, relPath: string, isDir: boolean): boolean {
  if (isDenied(relPath)) {
    walk.denied += 1;
    return false;
  }
  if (walk.applyGitignore && isIgnored(walk.matcher, relPath, isDir)) {
    walk.ignored += 1;
    return false;
  }
  return true;
}

function childRelative(root: string, absoluteDir: string, name: string): string {
  const dirRel = toRelative(root, absoluteDir);
  return dirRel === "" ? name : `${dirRel}/${name}`;
}

function readDirSafe(walk: Walk, absoluteDir: string): readonly WorkspaceDirEntry[] {
  try {
    return walk.fs.readDir(absoluteDir);
  } catch {
    return [];
  }
}

function statSize(walk: Walk, absolutePath: string): number {
  try {
    return walk.fs.stat(absolutePath).size;
  } catch {
    return 0;
  }
}

function handleEntry(
  walk: Walk,
  absoluteDir: string,
  entry: WorkspaceDirEntry,
  depth: number,
): void {
  const childAbs = resolveWithinWorkspace(
    walk.root,
    childRelative(walk.root, absoluteDir, entry.name),
  );
  const relPath = toRelative(walk.root, childAbs);
  if (!isAllowed(walk, relPath, entry.isDirectory)) {
    return;
  }
  // Symlinks are skipped unconditionally (for safety/simplicity). A non-symlink entry that
  // reports neither isFile nor isDirectory is likewise treated as non-traversable noise.
  // Only genuine files and directories are walked.
  if (entry.isSymbolicLink) {
    return;
  }
  if (entry.isDirectory) {
    descend(walk, childAbs, depth + 1);
    return;
  }
  if (entry.isFile) {
    walk.out.push({ relativePath: relPath, sizeBytes: statSize(walk, childAbs) });
  }
}

function descend(walk: Walk, absoluteDir: string, depth: number): void {
  if (depth > walk.opts.maxDepth || walk.out.length >= walk.opts.maxFiles) {
    return;
  }
  const entries = [...readDirSafe(walk, absoluteDir)].sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (walk.out.length >= walk.opts.maxFiles) {
      return;
    }
    handleEntry(walk, absoluteDir, entry, depth);
  }
}

function runWalk(workspace: WorkspaceInfo, opts: DiscoveryOptions, fs: WorkspaceFs): Walk {
  const walk: Walk = {
    fs,
    root: workspace.root,
    matcher: compileIgnore(workspace.ignoreLines),
    opts,
    applyGitignore: opts.applyGitignore,
    out: [],
    denied: 0,
    ignored: 0,
  };
  descend(walk, resolveWithinWorkspace(workspace.root, "."), 0);
  return walk;
}

export function discoverFiles(
  workspace: WorkspaceInfo,
  opts: DiscoveryOptions,
  fs: WorkspaceFs = nodeWorkspaceFs,
): readonly DiscoveredFile[] {
  return runWalk(workspace, opts, fs).out;
}

export function discoverWithStats(
  workspace: WorkspaceInfo,
  opts: DiscoveryOptions,
  fs: WorkspaceFs = nodeWorkspaceFs,
): DiscoveryResult {
  const walk = runWalk(workspace, opts, fs);
  return {
    files: walk.out,
    stats: { discovered: walk.out.length, denied: walk.denied, ignored: walk.ignored },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function statFile(fs: WorkspaceFs, absolutePath: string, relPath: string): WorkspaceStat {
  try {
    return fs.stat(absolutePath);
  } catch (error) {
    throw new WorkspaceReadError(`cannot stat file: ${relPath} (${describe(error)})`, relPath);
  }
}

function assertNoHardLinkAlias(stats: WorkspaceStat, relPath: string): void {
  if (stats.hardLinkCount !== undefined && stats.hardLinkCount > 1) {
    throw new PathDeniedError(
      `refusing to read a hard-linked workspace alias: ${relPath}`,
      relPath,
    );
  }
}

function readContent(
  fs: WorkspaceFs,
  absolutePath: string,
  relPath: string,
  opts: ReadOptions,
): FileContent {
  let raw: string;
  try {
    raw = fs.readFileUtf8(absolutePath);
  } catch (error) {
    throw new WorkspaceReadError(`cannot read file: ${relPath} (${describe(error)})`, relPath);
  }
  const rawBytes = Buffer.byteLength(raw, "utf8");
  const truncated = rawBytes > opts.maxBytes;
  const text = truncated
    ? Buffer.from(raw, "utf8").subarray(0, opts.maxBytes).toString("utf8")
    : raw;
  return { relativePath: relPath, sizeBytes: rawBytes, text: redact(text), truncated };
}

// The single read path. Order: boundary -> deny -> realpath containment -> size cap -> read -> redact.
// Realpath containment is shared with the write/cwd paths via assertContainedRealPath: when the
// path does not exist, it validates the nearest existing parent and returns absolutePath, so a
// missing in-root file still surfaces as a WorkspaceReadError (not a false PathEscapeError).
export function readWorkspaceFile(
  workspace: WorkspaceInfo,
  relPath: string,
  opts: ReadOptions = DEFAULT_READ_OPTIONS,
  fs: WorkspaceFs = nodeWorkspaceFs,
): FileContent {
  const absolutePath = resolveWithinWorkspace(workspace.root, relPath);
  const normalizedRel = toRelative(workspace.root, absolutePath);
  if (isDenied(normalizedRel)) {
    throw new PathDeniedError(`refusing to read a denied path: ${normalizedRel}`, normalizedRel);
  }
  const resolvedPath = assertContainedRealPath(fs, workspace.root, absolutePath, normalizedRel);
  const resolvedRel = toRealRelative(fs, workspace.root, resolvedPath);
  if (isDenied(resolvedRel)) {
    throw new PathDeniedError(`refusing to read a denied path: ${normalizedRel}`, normalizedRel);
  }
  const stats = statFile(fs, resolvedPath, normalizedRel);
  assertNoHardLinkAlias(stats, normalizedRel);
  if (stats.size > opts.maxBytes) {
    throw new FileTooLargeError(
      `file exceeds the read cap: ${normalizedRel}`,
      normalizedRel,
      stats.size,
      opts.maxBytes,
    );
  }
  return readContent(fs, resolvedPath, normalizedRel, opts);
}
