// Recursive, bounded, deterministic file discovery and a single boundary-checked read path.
// Security invariants (ADR-0005 D2/D3):
//   - every directory descent and every read goes through resolveWithinWorkspace first;
//   - always-on DENY patterns are applied before the optional .gitignore subset;
//   - a symlink whose realpath escapes the root is skipped (never followed);
//   - recursion is capped by maxDepth and total results by maxFiles.

import { relative } from "node:path";
import { nodeWorkspaceFs, type WorkspaceDirEntry, type WorkspaceFs } from "./fs.js";
import { compileIgnore, isDenied, isIgnored, type IgnoreMatcher } from "./ignore.js";
import { isWithinWorkspace, resolveWithinWorkspace } from "./paths.js";
import { FileTooLargeError, PathDeniedError, PathEscapeError, WorkspaceReadError } from "./errors.js";
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

function statBytes(fs: WorkspaceFs, absolutePath: string, relPath: string): number {
  try {
    return fs.stat(absolutePath).size;
  } catch (error) {
    throw new WorkspaceReadError(`cannot stat file: ${relPath} (${describe(error)})`, relPath);
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
  const text = truncated ? Buffer.from(raw, "utf8").subarray(0, opts.maxBytes).toString("utf8") : raw;
  return { relativePath: relPath, sizeBytes: rawBytes, text: redact(text), truncated };
}

// Resolves absolutePath to its real path and asserts it stays within root.
// When the path does not yet exist, realPath throws — we return absolutePath unchanged and let
// statBytes surface the missing-file error as a WorkspaceReadError (no false PathEscapeError).
// We also resolve root to guard against platform symlinks (e.g. macOS /var -> /private/var).
function resolveRealPath(
  fs: WorkspaceFs,
  root: string,
  absolutePath: string,
  relPath: string,
): string {
  let real: string;
  try { real = fs.realPath(absolutePath); } catch { return absolutePath; }
  let realRoot = root;
  try { realRoot = fs.realPath(root); } catch { /* fall back to lexical root */ }
  if (!isWithinWorkspace(realRoot, real)) {
    throw new PathEscapeError(`path escapes the workspace boundary via symlink: ${relPath}`, relPath);
  }
  return real;
}

// The single read path. Order: boundary -> deny -> realpath containment -> size cap -> read -> redact.
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
  const resolvedPath = resolveRealPath(fs, workspace.root, absolutePath, normalizedRel);
  const size = statBytes(fs, resolvedPath, normalizedRel);
  if (size > opts.maxBytes) {
    throw new FileTooLargeError(
      `file exceeds the read cap: ${normalizedRel}`,
      normalizedRel,
      size,
      opts.maxBytes,
    );
  }
  return readContent(fs, resolvedPath, normalizedRel, opts);
}
