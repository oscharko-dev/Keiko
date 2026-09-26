// Recursive, bounded, deterministic file discovery and a single boundary-checked read path.
// Security invariants (ADR-0005 D2/D3):
//   - every directory descent and every read goes through resolveWithinWorkspace first;
//   - always-on DENY patterns are applied before the optional .gitignore subset;
//   - a symlink whose realpath escapes the root is skipped (never followed);
//   - recursion is capped by maxDepth and total results by maxFiles;
//   - every directory read is capped, so one huge directory cannot be materialized in full.

import { relative } from "node:path";
import {
  nodeWorkspaceFs,
  WorkspaceDescriptorReadError,
  type WorkspaceDirEntry,
  type WorkspaceDescriptorUtf8Read,
  type WorkspaceFs,
  type WorkspaceStat,
} from "./fs.js";
import { compileIgnore, isDenied, isIgnored, type IgnoreMatcher } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import {
  containedRealPathInfo,
  isAllowedContainedPathParent,
  isCanonicalAllowedContainedPath,
  resolveExistingAllowedWorkspaceRealRoot,
  workspaceFsBoundToCanonicalRoot,
} from "./realpath.js";
import {
  FileTooLargeError,
  PathDeniedError,
  PathEscapeError,
  WorkspaceReadError,
} from "./errors.js";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { redact } from "@oscharko-dev/keiko-security";
import {
  DEFAULT_READ_OPTIONS,
  type DiscoveredFile,
  type DiscoveryOptions,
  type DiscoveryStats,
  type FileContent,
  type ReadOptions,
  type WorkspaceInfo,
} from "./types.js";
import {
  StructuralExecutionStoppedError,
  structuralExecutionStopped,
  type StructuralExecutionControl,
} from "./structuralExecution.js";
import {
  workspaceDirectoryFingerprint,
  type WorkspaceDirectorySnapshot,
} from "./workspaceDirectorySnapshot.js";

interface Walk {
  readonly fs: WorkspaceFs;
  readonly root: string;
  readonly realRoot: string | undefined;
  readonly matcher: IgnoreMatcher;
  readonly opts: DiscoveryOptions;
  readonly applyGitignore: boolean;
  readonly out: DiscoveredFile[];
  readonly directories: string[];
  readonly directorySnapshots: Map<string, WorkspaceDirectorySnapshot>;
  readonly skippedSymbolicLinks: string[];
  readonly failOnReadError: boolean;
  readonly entryLimit?: number | undefined;
  readonly executionControl?: StructuralExecutionControl | undefined;
  entriesVisited: number;
  denied: number;
  ignored: number;
  depthPruned: number;
  maxFilesPruned: number;
}

function unavailableWalkRoot(error: unknown, failOnReadError: boolean): undefined {
  if (error instanceof PathDeniedError || error instanceof StructuralExecutionStoppedError) {
    throw error;
  }
  if (failOnReadError) throw new WorkspaceReadError("cannot resolve workspace root", ".");
  return undefined;
}

function resolveWalkRoot(
  fs: WorkspaceFs,
  root: string,
  failOnReadError: boolean,
): string | undefined {
  try {
    return resolveExistingAllowedWorkspaceRealRoot(fs, root);
  } catch (error) {
    unavailableWalkRoot(error, failOnReadError);
    return undefined;
  }
}

interface AsyncWalkState {
  entriesSinceYield: number;
}

const ASYNC_DISCOVERY_YIELD_EVERY_ENTRIES = 32;

export interface DiscoveryResult {
  readonly files: readonly DiscoveredFile[];
  readonly directories: readonly string[];
  readonly stats: DiscoveryStats;
}

function toRelative(root: string, absolutePath: string): string {
  return relative(root, absolutePath).replaceAll("\\", "/");
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

function childRelative(relativeDir: string, name: string): string {
  return relativeDir === "" ? name : `${relativeDir}/${name}`;
}

function currentContainedDirectory(
  walk: Walk,
  absoluteDir: string,
  relativeDir: string,
): string | undefined {
  const lexicalPath = resolveWithinWorkspace(walk.root, relativeDir);
  let contained: ReturnType<typeof containedRealPathInfo>;
  try {
    contained = containedRealPathInfo(walk.fs, walk.root, lexicalPath);
  } catch (error) {
    rejectContainedEntry(walk, relativeDir, error);
    return undefined;
  }
  const realRelative = contained.realRelative.replaceAll("\\", "/");
  if (contained.realBase !== walk.realRoot) {
    rejectContainedEntry(walk, relativeDir, new Error("workspace root changed during discovery"));
    return undefined;
  }
  if (isDenied(realRelative)) {
    walk.denied += 1;
    return undefined;
  }
  if (
    contained.path !== absoluteDir ||
    !isCanonicalAllowedContainedPath(contained, walk.root, relativeDir)
  ) {
    recordSkippedSymbolicLink(walk, relativeDir);
    return undefined;
  }
  return contained.path;
}

function failedDirectoryRead(
  walk: Walk,
  relativeDir: string,
  error: unknown,
): readonly WorkspaceDirEntry[] {
  if (error instanceof PathDeniedError || error instanceof StructuralExecutionStoppedError) {
    throw error;
  }
  if (!walk.failOnReadError) return [];
  if (error instanceof PathEscapeError || error instanceof WorkspaceReadError) throw error;
  throw new WorkspaceReadError(
    `cannot read directory: ${relativeDir || "."} (${describe(error)})`,
    relativeDir,
  );
}

// #3347 (owner P1): a single directory must never be materialized (and then sorted) in full before
// a budget can stop the walk. The port's bounded `readDir(path, maxEntries)` (ADR-0005 D1) exists
// for exactly that, but public discovery passed `undefined` and so allocated every entry of one
// attacker-controlled directory — synchronously, which the async walk cannot yield through. Every
// read is capped now.
//
// The cap is a per-directory MEMORY bound and is deliberately NOT derived from `maxFiles`:
// subdirectories are entries too and do not consume the file budget, so a maxFiles-derived bound
// would abort a legitimate walk whose directory merely holds more children than the caller wants
// files. The traversal entry budget of `discoverCandidateInventory` still applies on top when it is
// the tighter of the two. The `+ 1` is a sentinel: reading one entry more than the bound proves the
// directory overflows without enumerating the rest of it.
const MAX_DIRECTORY_ENTRIES = 10_000;

interface DirectoryReadCap {
  readonly limit: number;
  /** True when the walk's traversal entry budget, not the memory bound, set this limit. */
  readonly fromEntryBudget: boolean;
}

function directoryReadCap(walk: Walk): DirectoryReadCap {
  const memoryLimit = MAX_DIRECTORY_ENTRIES + 1;
  if (walk.entryLimit === undefined) return { limit: memoryLimit, fromEntryBudget: false };
  const remaining = Math.max(0, walk.entryLimit - walk.entriesVisited) + 1;
  return remaining <= memoryLimit
    ? { limit: remaining, fromEntryBudget: true }
    : { limit: memoryLimit, fromEntryBudget: false };
}

function readDirSafe(
  walk: Walk,
  absoluteDir: string,
  relativeDir: string,
): readonly WorkspaceDirEntry[] {
  try {
    const current = currentContainedDirectory(walk, absoluteDir, relativeDir);
    if (current === undefined) return [];
    const cap = directoryReadCap(walk);
    const entries = walk.fs.readDir(current, cap.limit);
    if (entries.length >= cap.limit) {
      // A capped directory read is in filesystem order, so consuming its arbitrary prefix would make
      // retrieval nondeterministic across platforms. Reject the whole overflowing directory and mark
      // the inventory truncated. Only a spent traversal entry budget ends the walk; a directory that
      // merely exceeds the memory bound is skipped and its siblings are still visited.
      walk.maxFilesPruned += entries.length;
      if (cap.fromEntryBudget) walk.entriesVisited = walk.entryLimit ?? walk.entriesVisited;
      return [];
    }
    // The shared code-unit comparator (issue #2723), not `localeCompare`: the directory
    // fingerprint recorded below must be identical across platforms and locales.
    const ordered = [...entries].sort((a, b) => compareStrings(a.name, b.name));
    const after = currentContainedDirectory(walk, current, relativeDir);
    if (after === undefined) return [];
    walk.directorySnapshots.set(relativeDir, {
      scopePath: relativeDir,
      fingerprint: workspaceDirectoryFingerprint(ordered),
    });
    return ordered;
  } catch (error) {
    return failedDirectoryRead(walk, relativeDir, error);
  }
}

function entryBudgetExhausted(walk: Walk): boolean {
  return walk.entryLimit !== undefined && walk.entriesVisited >= walk.entryLimit;
}

function currentEntryStat(
  walk: Walk,
  absolutePath: string,
  relativePath: string,
): WorkspaceStat | undefined {
  try {
    return walk.fs.stat(absolutePath);
  } catch (error) {
    if (error instanceof PathDeniedError || error instanceof StructuralExecutionStoppedError) {
      throw error;
    }
    if (walk.failOnReadError) {
      throw new WorkspaceReadError(
        `cannot stat discovered path: ${relativePath} (${describe(error)})`,
        relativePath,
      );
    }
    return undefined;
  }
}

function recordSkippedSymbolicLink(walk: Walk, relPath: string): void {
  if (walk.skippedSymbolicLinks.length >= walk.opts.maxFiles) {
    walk.maxFilesPruned += 1;
  } else {
    walk.skippedSymbolicLinks.push(relPath);
  }
}

interface CurrentEntry {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly stat: WorkspaceStat;
}

function rejectContainedEntry(walk: Walk, relativePath: string, error: unknown): undefined {
  if (error instanceof PathDeniedError || error instanceof StructuralExecutionStoppedError) {
    throw error;
  }
  if (walk.failOnReadError) {
    if (error instanceof PathEscapeError) throw error;
    throw new WorkspaceReadError(
      `cannot contain discovered path: ${relativePath} (${describe(error)})`,
      relativePath,
    );
  }
  walk.denied += 1;
  return undefined;
}

function currentContainedEntry(walk: Walk, relativePath: string): CurrentEntry | undefined {
  const lexicalPath = resolveWithinWorkspace(walk.root, relativePath);
  let contained: ReturnType<typeof containedRealPathInfo>;
  try {
    contained = containedRealPathInfo(walk.fs, walk.root, lexicalPath);
  } catch (error) {
    rejectContainedEntry(walk, relativePath, error);
    return undefined;
  }
  if (contained.realBase !== walk.realRoot) {
    rejectContainedEntry(walk, relativePath, new Error("workspace root changed during discovery"));
    return undefined;
  }
  const realRelative = contained.realRelative.replaceAll("\\", "/");
  if (isDenied(realRelative)) {
    walk.denied += 1;
    return undefined;
  }
  if (!isCanonicalAllowedContainedPath(contained, walk.root, relativePath)) {
    recordSkippedSymbolicLink(walk, relativePath);
    return undefined;
  }
  const stat = currentEntryStat(walk, contained.path, relativePath);
  if (stat === undefined) return undefined;
  if (stat.isSymbolicLink) {
    recordSkippedSymbolicLink(walk, relativePath);
    return undefined;
  }
  return { absolutePath: contained.path, relativePath, stat };
}

function handleEntry(
  walk: Walk,
  relativeDir: string,
  entry: WorkspaceDirEntry,
  depth: number,
): void {
  const relPath = childRelative(relativeDir, entry.name);
  if (!isAllowed(walk, relPath, entry.isDirectory)) {
    return;
  }
  // Symlinks are skipped unconditionally (for safety/simplicity). A non-symlink entry that
  // reports neither isFile nor isDirectory is likewise treated as non-traversable noise.
  // Only genuine files and directories are walked.
  if (entry.isSymbolicLink) {
    recordSkippedSymbolicLink(walk, relPath);
    return;
  }
  const current = currentContainedEntry(walk, relPath);
  if (current === undefined) return;
  if (
    current.stat.isDirectory !== entry.isDirectory &&
    !isAllowed(walk, relPath, current.stat.isDirectory)
  ) {
    return;
  }
  if (current.stat.isDirectory) {
    descend(walk, current.absolutePath, relPath, depth + 1);
    return;
  }
  if (current.stat.isFile) {
    if (walk.out.length >= walk.opts.maxFiles) {
      walk.maxFilesPruned += 1;
      return;
    }
    walk.out.push({ relativePath: relPath, sizeBytes: current.stat.size });
  }
}

function descend(walk: Walk, absoluteDir: string, relativeDir: string, depth: number): void {
  if (depth > walk.opts.maxDepth) {
    walk.depthPruned += 1;
    return;
  }
  if (walk.out.length >= walk.opts.maxFiles) {
    walk.maxFilesPruned += 1;
    return;
  }
  if (entryBudgetExhausted(walk)) {
    walk.maxFilesPruned += 1;
    return;
  }
  walk.directories.push(relativeDir);
  const entries = [...readDirSafe(walk, absoluteDir, relativeDir)].sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  for (const [index, entry] of entries.entries()) {
    if (
      entryBudgetExhausted(walk) ||
      (walk.executionControl !== undefined && structuralExecutionStopped(walk.executionControl))
    ) {
      walk.maxFilesPruned += entries.length - index;
      break;
    }
    walk.entriesVisited += 1;
    handleEntry(walk, relativeDir, entry, depth);
  }
}

function yieldToEventLoop(state: AsyncWalkState): Promise<void> | undefined {
  state.entriesSinceYield += 1;
  return state.entriesSinceYield % ASYNC_DISCOVERY_YIELD_EVERY_ENTRIES === 0
    ? new Promise((resolve) => setImmediate(resolve))
    : undefined;
}

async function handleEntryAsync(
  walk: Walk,
  state: AsyncWalkState,
  relativeDir: string,
  entry: WorkspaceDirEntry,
  depth: number,
): Promise<void> {
  await yieldToEventLoop(state);
  const relPath = childRelative(relativeDir, entry.name);
  if (!isAllowed(walk, relPath, entry.isDirectory)) return;
  if (entry.isSymbolicLink) {
    recordSkippedSymbolicLink(walk, relPath);
    return;
  }
  const current = currentContainedEntry(walk, relPath);
  if (current === undefined) return;
  if (
    current.stat.isDirectory !== entry.isDirectory &&
    !isAllowed(walk, relPath, current.stat.isDirectory)
  ) {
    return;
  }
  if (current.stat.isDirectory) {
    await descendAsync(walk, state, current.absolutePath, relPath, depth + 1);
  } else if (current.stat.isFile) {
    if (walk.out.length >= walk.opts.maxFiles) {
      walk.maxFilesPruned += 1;
      return;
    }
    walk.out.push({ relativePath: relPath, sizeBytes: current.stat.size });
  }
}

async function descendAsync(
  walk: Walk,
  state: AsyncWalkState,
  absoluteDir: string,
  relativeDir: string,
  depth: number,
): Promise<void> {
  if (depth > walk.opts.maxDepth) {
    walk.depthPruned += 1;
    return;
  }
  if (walk.out.length >= walk.opts.maxFiles) {
    walk.maxFilesPruned += 1;
    return;
  }
  if (entryBudgetExhausted(walk)) {
    walk.maxFilesPruned += 1;
    return;
  }
  walk.directories.push(relativeDir);
  const entries = [...readDirSafe(walk, absoluteDir, relativeDir)].sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  for (const [index, entry] of entries.entries()) {
    if (
      entryBudgetExhausted(walk) ||
      (walk.executionControl !== undefined && structuralExecutionStopped(walk.executionControl))
    ) {
      walk.maxFilesPruned += entries.length - index;
      break;
    }
    walk.entriesVisited += 1;
    await handleEntryAsync(walk, state, relativeDir, entry, depth);
  }
}

function createWalk(
  workspace: WorkspaceInfo,
  opts: DiscoveryOptions,
  fs: WorkspaceFs,
  failOnReadError: boolean,
  executionControl?: StructuralExecutionControl,
  entryLimit?: number,
): Walk {
  const realRoot = resolveWalkRoot(fs, workspace.root, failOnReadError);
  return {
    fs: realRoot === undefined ? fs : workspaceFsBoundToCanonicalRoot(fs, realRoot),
    root: realRoot ?? workspace.root,
    realRoot,
    matcher: compileIgnore(workspace.ignoreLines),
    opts,
    applyGitignore: opts.applyGitignore,
    out: [],
    directories: [],
    directorySnapshots: new Map<string, WorkspaceDirectorySnapshot>(),
    skippedSymbolicLinks: [],
    failOnReadError,
    ...(entryLimit === undefined ? {} : { entryLimit: Math.max(1, Math.floor(entryLimit)) }),
    ...(executionControl === undefined ? {} : { executionControl }),
    entriesVisited: 0,
    denied: 0,
    ignored: 0,
    depthPruned: 0,
    maxFilesPruned: 0,
  };
}

function runWalk(
  workspace: WorkspaceInfo,
  opts: DiscoveryOptions,
  fs: WorkspaceFs,
  failOnReadError = false,
  executionControl?: StructuralExecutionControl,
  entryLimit?: number,
): Walk {
  const walk = createWalk(workspace, opts, fs, failOnReadError, executionControl, entryLimit);
  if (walk.realRoot !== undefined) descend(walk, walk.realRoot, "", 0);
  return walk;
}

async function runWalkAsync(
  workspace: WorkspaceInfo,
  opts: DiscoveryOptions,
  fs: WorkspaceFs,
  failOnReadError = false,
  executionControl?: StructuralExecutionControl,
  entryLimit?: number,
): Promise<Walk> {
  const walk = createWalk(workspace, opts, fs, failOnReadError, executionControl, entryLimit);
  if (walk.realRoot !== undefined) {
    await descendAsync(walk, { entriesSinceYield: 0 }, walk.realRoot, "", 0);
  }
  return walk;
}

function discoveryResult(walk: Walk): DiscoveryResult {
  return {
    files: walk.out,
    directories: [...new Set(walk.directories)].sort(compareStrings),
    stats: {
      discovered: walk.out.length,
      denied: walk.denied,
      ignored: walk.ignored,
      depthPruned: walk.depthPruned,
      maxFilesPruned: walk.maxFilesPruned,
    },
  };
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
  return discoveryResult(runWalk(workspace, opts, fs));
}

export interface CandidateDiscoveryResult extends DiscoveryResult {
  readonly skippedSymbolicLinks: readonly string[];
  readonly directorySnapshots: readonly WorkspaceDirectorySnapshot[];
}

/**
 * Internal repository-search inventory. Symlink names stay out of ordinary discovery responses,
 * but structural adapters need them to distinguish a genuinely missing convention from a path
 * omitted at the trust boundary without probing every nonexistent candidate.
 */
export function discoverCandidateInventory(
  workspace: WorkspaceInfo,
  opts: DiscoveryOptions,
  fs: WorkspaceFs = nodeWorkspaceFs,
  executionControl?: StructuralExecutionControl,
): CandidateDiscoveryResult {
  const entryLimit = Math.max(opts.maxFiles * 2, opts.maxFiles + opts.maxDepth + 1);
  const walk = runWalk(workspace, opts, fs, true, executionControl, entryLimit);
  return candidateDiscoveryResult(walk);
}

/** The candidate inventory's existing guard chain with cooperative 32-entry scheduling. */
export async function discoverCandidateInventoryAsync(
  workspace: WorkspaceInfo,
  opts: DiscoveryOptions,
  fs: WorkspaceFs = nodeWorkspaceFs,
  executionControl?: StructuralExecutionControl,
): Promise<CandidateDiscoveryResult> {
  const entryLimit = Math.max(opts.maxFiles * 2, opts.maxFiles + opts.maxDepth + 1);
  const walk = await runWalkAsync(workspace, opts, fs, true, executionControl, entryLimit);
  return candidateDiscoveryResult(walk);
}

function candidateDiscoveryResult(walk: Walk): CandidateDiscoveryResult {
  return {
    ...discoveryResult(walk),
    skippedSymbolicLinks: [...new Set(walk.skippedSymbolicLinks)].sort(compareStrings),
    directorySnapshots: [...walk.directorySnapshots.values()].sort((a, b) =>
      compareStrings(a.scopePath, b.scopePath),
    ),
  };
}

// Uses the same WorkspaceFs port and filtering rules as discoverWithStats, but yields after bounded
// entry batches so the BFF can serve unrelated requests while a large workspace is being scanned.
export async function discoverWithStatsAsync(
  workspace: WorkspaceInfo,
  opts: DiscoveryOptions,
  fs: WorkspaceFs = nodeWorkspaceFs,
): Promise<DiscoveryResult> {
  return discoveryResult(await runWalkAsync(workspace, opts, fs));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function statFile(fs: WorkspaceFs, absolutePath: string, relPath: string): WorkspaceStat {
  try {
    return fs.stat(absolutePath);
  } catch (error) {
    if (error instanceof StructuralExecutionStoppedError) throw error;
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

// ─── The read-lane boundary (the ONE switch that decides redaction) ─────────────────────────────
//
// Two reads, one security chain, deliberately incompatible result types:
//
//   * `readWorkspaceFile` is the EVIDENCE lane. Its `text` is redacted at the IO boundary, so
//     nothing it returns can carry a secret into a context pack, a retrieval answer, an evidence
//     atom, the workspace index, a manifest, an audit export, or a diagnostic. Everything that
//     feeds any of those MUST keep using it. It is the only read on the package's public barrel.
//
//   * `readWorkspaceFileForEditing` is the EDITOR lane. It runs the SAME chain (boundary -> deny
//     -> realpath containment -> hard-link alias -> size cap) and then returns the RAW bytes. It
//     exists because a surface that WRITES the file back — workspace search & replace — has to
//     derive its match ranges, its base-content hash, and its replacement text from the same bytes
//     the write preflight reads. Deriving them from redacted text made every replace on a file
//     containing secret-shaped text fail as a false write-conflict (nothing was ever written), and
//     highlighted the wrong text in the diff the human approved.
//
// The raw result is `RawFileContent`, whose payload field is `rawText` — NOT `text`. A raw read can
// therefore never be passed where a redacted `FileContent` is expected, and `.text` on a raw read
// does not compile. Outside this package the raw read is reachable only through the
// `./internal/editor-read` export subpath, so an evidence-lane caller cannot pick it by accident.

/** Which lane a workspace content read belongs to. See the boundary note above. */
export type WorkspaceContentLane = "evidence" | "editor";

/**
 * RAW, UNREDACTED workspace bytes for the editor lane.
 *
 * Structurally distinct from `FileContent` on purpose: the payload lives on `rawText`, so it cannot
 * be substituted for a redacted read. Never persist it, never log it, never embed it in evidence,
 * a manifest, or a grounded answer — redact at the surface that emits, not here.
 */
export interface RawFileContent {
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly rawText: string;
  readonly truncated: boolean;
}

export interface InternalWorkspaceByteRead {
  readonly bytes: Uint8Array;
  readonly stat: WorkspaceStat;
  readonly complete: boolean;
}

export interface InternalWorkspaceTextRead {
  readonly content: string;
  readonly sizeBytes: number;
  readonly stat: WorkspaceStat;
}

interface StableRawFileContent extends RawFileContent {
  readonly stat: WorkspaceStat;
}

interface ReadableWorkspaceFile {
  readonly resolvedPath: string;
  readonly normalizedRel: string;
  readonly realBase: string;
  readonly realRelative: string;
  readonly stat: WorkspaceStat;
}

function mapDescriptorReadError(
  error: WorkspaceDescriptorReadError,
  target: ReadableWorkspaceFile,
  maxBytes: number,
): never {
  if (error.reason === "too-large") {
    const sizeBytes = error.sizeBytes ?? target.stat.size;
    throw new FileTooLargeError(
      `file exceeds the read cap: ${target.normalizedRel}`,
      target.normalizedRel,
      sizeBytes,
      maxBytes,
    );
  }
  if (
    error.reason === "hard-link" ||
    error.reason === "not-regular" ||
    error.reason === "symbolic-link"
  ) {
    throw new PathDeniedError(
      `refusing to read an unsafe workspace alias: ${target.normalizedRel}`,
      target.normalizedRel,
    );
  }
  throw new WorkspaceReadError(
    `file changed during read: ${target.normalizedRel}`,
    target.normalizedRel,
  );
}

// Bounded primitive present -> use it; absent -> the read is unavailable. Never fall back to the
// unbounded `readFileUtf8`, which would materialize the whole file before the size cap below ever
// runs (the class of bug this function exists to close — see the read-lane boundary note above).
function readDescriptor(
  fs: WorkspaceFs,
  target: ReadableWorkspaceFile,
  opts: ReadOptions,
): WorkspaceDescriptorUtf8Read {
  if (fs.readFileUtf8SameDescriptor === undefined) {
    throw new WorkspaceReadError(
      `bounded same-descriptor read is unavailable: ${target.normalizedRel}`,
      target.normalizedRel,
    );
  }
  try {
    return fs.readFileUtf8SameDescriptor(target.resolvedPath, opts.maxBytes, "reject", target.stat);
  } catch (error) {
    if (error instanceof StructuralExecutionStoppedError) throw error;
    if (error instanceof WorkspaceDescriptorReadError) {
      mapDescriptorReadError(error, target, opts.maxBytes);
    }
    throw new WorkspaceReadError(
      `cannot read file: ${target.normalizedRel} (${describe(error)})`,
      target.normalizedRel,
    );
  }
}

function sameFileSnapshot(left: WorkspaceStat, right: WorkspaceStat): boolean {
  const sameWhenKnown = (a: unknown, b: unknown): boolean =>
    a === undefined || b === undefined || a === b;
  return (
    left.size === right.size &&
    sameWhenKnown(left.fileIdentity, right.fileIdentity) &&
    sameWhenKnown(left.hardLinkCount, right.hardLinkCount) &&
    sameWhenKnown(left.mtimeNs ?? left.mtimeMs, right.mtimeNs ?? right.mtimeMs) &&
    sameWhenKnown(left.ctimeNs ?? left.ctimeMs, right.ctimeNs ?? right.ctimeMs)
  );
}

function postReadStat(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  target: ReadableWorkspaceFile,
): WorkspaceStat {
  const contained = containedRealPathInfo(fs, workspace.root, target.resolvedPath);
  const realRelative = contained.realRelative.replaceAll("\\", "/");
  if (
    contained.realBase !== target.realBase ||
    contained.path !== target.resolvedPath ||
    realRelative !== target.realRelative ||
    !isCanonicalAllowedContainedPath(contained, workspace.root, target.normalizedRel)
  ) {
    throw new PathDeniedError(
      `workspace path changed during read: ${target.normalizedRel}`,
      target.normalizedRel,
    );
  }
  return statFile(fs, contained.path, target.normalizedRel);
}

function readRawContent(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  target: ReadableWorkspaceFile,
  opts: ReadOptions,
): StableRawFileContent {
  const read = readDescriptor(fs, target, opts);
  const after = postReadStat(workspace, fs, target);
  assertNoHardLinkAlias(after, target.normalizedRel);
  if (!sameFileSnapshot(target.stat, read.stat) || !sameFileSnapshot(read.stat, after)) {
    throw new WorkspaceReadError(
      `file identity changed during read: ${target.normalizedRel}`,
      target.normalizedRel,
    );
  }
  if (read.sizeBytes > opts.maxBytes) {
    throw new FileTooLargeError(
      `file exceeds the read cap: ${target.normalizedRel}`,
      target.normalizedRel,
      read.sizeBytes,
      opts.maxBytes,
    );
  }
  return {
    relativePath: target.normalizedRel,
    sizeBytes: read.sizeBytes,
    rawText: read.rawText,
    truncated: false,
    stat: after,
  };
}

function resolvePrefixReadableWorkspaceFile(
  workspace: WorkspaceInfo,
  relPath: string,
  maxBytes: number,
  fs: WorkspaceFs,
): ReadableWorkspaceFile {
  return resolveReadableWorkspaceFile(workspace, relPath, { maxBytes }, fs, false);
}

function assertStablePrefixRead(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  target: ReadableWorkspaceFile,
): WorkspaceStat {
  const after = postReadStat(workspace, fs, target);
  assertNoHardLinkAlias(after, target.normalizedRel);
  if (!sameFileSnapshot(target.stat, after)) {
    throw new WorkspaceReadError(
      `file identity changed during prefix read: ${target.normalizedRel}`,
      target.normalizedRel,
    );
  }
  return after;
}

function mapPrefixReadFailure(
  error: unknown,
  target: ReadableWorkspaceFile,
  maxBytes: number,
): never {
  if (error instanceof WorkspaceDescriptorReadError) {
    mapDescriptorReadError(error, target, maxBytes);
  }
  if (error instanceof Error && !("code" in error)) throw error;
  throw new WorkspaceReadError(
    `cannot read file prefix: ${target.normalizedRel} (${describe(error)})`,
    target.normalizedRel,
  );
}

/** Internal raw-byte prefix seam for repository search. Never expose it from the public barrel. */
export async function readWorkspaceFileBytesPrefixForInternalUse(
  workspace: WorkspaceInfo,
  relPath: string,
  maxBytes: number,
  fs: WorkspaceFs,
): Promise<InternalWorkspaceByteRead> {
  const target = resolvePrefixReadableWorkspaceFile(workspace, relPath, maxBytes, fs);
  const readBytes = fs.readFileBytes;
  if (readBytes === undefined) {
    throw new WorkspaceReadError(
      `bounded byte reads are unavailable: ${target.normalizedRel}`,
      target.normalizedRel,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(target.resolvedPath, maxBytes, "reject", target.stat);
  } catch (error) {
    mapPrefixReadFailure(error, target, maxBytes);
  }
  const stat = assertStablePrefixRead(workspace, fs, target);
  if (bytes.byteLength > maxBytes) {
    throw new WorkspaceReadError(
      `filesystem exceeded the prefix cap: ${target.normalizedRel}`,
      target.normalizedRel,
    );
  }
  return { bytes, stat, complete: bytes.byteLength === stat.size };
}

/** Internal redacted prefix seam for oversized code-intelligence sources. */
export function readWorkspaceFilePrefixForEvidence(
  workspace: WorkspaceInfo,
  relPath: string,
  maxBytes: number,
  fs: WorkspaceFs,
): string | undefined {
  const readPrefix = fs.readFileUtf8Prefix;
  if (readPrefix === undefined) return undefined;
  const target = resolvePrefixReadableWorkspaceFile(workspace, relPath, maxBytes, fs);
  let rawText: string;
  try {
    rawText = readPrefix(target.resolvedPath, maxBytes, "reject", target.stat);
  } catch (error) {
    mapPrefixReadFailure(error, target, maxBytes);
  }
  assertStablePrefixRead(workspace, fs, target);
  return redact(rawText);
}

/** Internal text seam that keeps stable read metadata attached until index persistence. */
export function readWorkspaceFileTextForInternalUse(
  workspace: WorkspaceInfo,
  relPath: string,
  opts: ReadOptions,
  fs: WorkspaceFs,
  lane: WorkspaceContentLane,
): InternalWorkspaceTextRead {
  const target = resolveReadableWorkspaceFile(workspace, relPath, opts, fs);
  const raw = readRawContent(workspace, fs, target, opts);
  return {
    content: lane === "editor" ? raw.rawText : redact(raw.rawText),
    sizeBytes: raw.sizeBytes,
    stat: raw.stat,
  };
}

// The shared guard chain both lanes run. Order: boundary -> deny -> realpath containment ->
// hard-link alias -> size cap -> same-descriptor read -> containment and identity revalidation.
// Realpath containment is shared with the write/cwd paths via assertContainedRealPath: when the path
// does not exist, it validates the nearest existing parent and returns absolutePath, so a missing
// in-root file still surfaces as a WorkspaceReadError (not a false PathEscapeError).
function isCanonicalOrSafelyMissingWorkspacePath(
  contained: ReturnType<typeof containedRealPathInfo>,
  workspaceRoot: string,
  normalizedRel: string,
  fs: WorkspaceFs,
): boolean {
  if (isCanonicalAllowedContainedPath(contained, workspaceRoot, normalizedRel)) return true;
  return (
    isAllowedContainedPathParent(contained, workspaceRoot, normalizedRel) &&
    !fs.exists(contained.path)
  );
}

function containedReadableWorkspacePath(
  workspaceRoot: string,
  normalizedRel: string,
  absolutePath: string,
  fs: WorkspaceFs,
): ReturnType<typeof containedRealPathInfo> {
  try {
    return containedRealPathInfo(fs, workspaceRoot, absolutePath);
  } catch (error) {
    if (
      error instanceof PathDeniedError ||
      error instanceof PathEscapeError ||
      error instanceof StructuralExecutionStoppedError
    ) {
      throw error;
    }
    throw new WorkspaceReadError(`cannot resolve workspace path: ${normalizedRel}`, normalizedRel);
  }
}

function resolveReadableWorkspaceFile(
  workspace: WorkspaceInfo,
  relPath: string,
  opts: ReadOptions,
  fs: WorkspaceFs,
  requireComplete = true,
): ReadableWorkspaceFile {
  const absolutePath = resolveWithinWorkspace(workspace.root, relPath);
  const normalizedRel = toRelative(workspace.root, absolutePath);
  if (isDenied(normalizedRel)) {
    throw new PathDeniedError(`refusing to read a denied path: ${normalizedRel}`, normalizedRel);
  }
  const contained = containedReadableWorkspacePath(workspace.root, normalizedRel, absolutePath, fs);
  // Deny a benign-named root symlink that resolves into a protected location (e.g. "~/docs" ->
  // "~/.aws"): the deny checks here only see the path relative to the realpath'd root, so a denied
  // segment in the ROOT itself is invisible to them and the file would read through. Only the symlink
  // case is added — see realRootIsDeniedViaSymlink — so existing non-symlink reads are unchanged.
  if (!isCanonicalOrSafelyMissingWorkspacePath(contained, workspace.root, normalizedRel, fs)) {
    throw new PathDeniedError(`refusing to read a denied path: ${normalizedRel}`, normalizedRel);
  }
  const resolvedPath = contained.path;
  const resolvedRel = contained.realRelative.replaceAll("\\", "/");
  const stats = statFile(fs, resolvedPath, normalizedRel);
  if (!stats.isFile || stats.isSymbolicLink) {
    throw new PathDeniedError(
      `refusing to read a non-regular workspace file: ${normalizedRel}`,
      normalizedRel,
    );
  }
  assertNoHardLinkAlias(stats, normalizedRel);
  if (requireComplete && stats.size > opts.maxBytes) {
    throw new FileTooLargeError(
      `file exceeds the read cap: ${normalizedRel}`,
      normalizedRel,
      stats.size,
      opts.maxBytes,
    );
  }
  return {
    resolvedPath,
    normalizedRel,
    realBase: contained.realBase,
    realRelative: resolvedRel,
    stat: stats,
  };
}

// The evidence-lane read: the guard chain, then redact() at the IO boundary.
export function readWorkspaceFile(
  workspace: WorkspaceInfo,
  relPath: string,
  opts: ReadOptions = DEFAULT_READ_OPTIONS,
  fs: WorkspaceFs = nodeWorkspaceFs,
): FileContent {
  const raw = readRawContent(
    workspace,
    fs,
    resolveReadableWorkspaceFile(workspace, relPath, opts, fs),
    opts,
  );
  return {
    relativePath: raw.relativePath,
    sizeBytes: raw.sizeBytes,
    text: redact(raw.rawText),
    truncated: raw.truncated,
  };
}

// The editor-lane read: the SAME guard chain, no redaction. Editor-owned, NON-evidence callers
// only — see the read-lane boundary note above and `./internal/editor-read`.
export function readWorkspaceFileForEditing(
  workspace: WorkspaceInfo,
  relPath: string,
  opts: ReadOptions = DEFAULT_READ_OPTIONS,
  fs: WorkspaceFs = nodeWorkspaceFs,
): RawFileContent {
  const target = resolveReadableWorkspaceFile(workspace, relPath, opts, fs);
  const raw = readRawContent(workspace, fs, target, opts);
  return {
    relativePath: raw.relativePath,
    sizeBytes: raw.sizeBytes,
    rawText: raw.rawText,
    truncated: raw.truncated,
  };
}
