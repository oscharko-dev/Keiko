// Git-history adapter (Epic #177, Issue #180). Reads `.git/HEAD` and `.git/logs/HEAD` directly
// via the WorkspaceFs port — never spawns `git` and never imports `child_process`. The shared
// always-on deny list refuses `.git`; this adapter is the SOLE legitimate consumer of those paths.
// It authorizes the canonical `<workspace>/.git` base, an allowed contained pointer target, or an
// exact external `.git/worktrees/<name>` gitdir. Reads stay constrained to HEAD and logs/HEAD, with
// a size cap and redaction. This adapter stays repo-level; grounded chat adds per-file evidence in
// the server layer where spawning bounded `git log` commands is already governed.
// Stays within ADR-0019 rule 3b: imports only @oscharko-dev/keiko-contracts, sibling workspace
// modules, and Node stdlib (node:crypto). Limitation: unavailable when scope.relativePaths is
// non-empty because git-history is a repo-level signal that cannot meaningfully scope to a
// sub-folder.

import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, normalize, relative } from "node:path";
import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { redact } from "@oscharko-dev/keiko-security";
import type { WorkspaceDescriptorReadCompleteness, WorkspaceFs } from "./fs.js";
import { resolveWithinWorkspace } from "./paths.js";
import {
  assertContainedRealPath,
  containedRealPathInfo,
  isCanonicalAllowedContainedPath,
  resolveExistingAllowedWorkspaceRealRoot,
} from "./realpath.js";
import { buildAtom } from "./repoSearchScan.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import type { StructuralAdapter, StructuralAdapterDeps } from "./structuralAdapters.js";

function queryFingerprint(query: RetrievalQuery): string {
  const canonical = JSON.stringify({ kind: query.kind, text: query.text });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

const GIT_DIR_PREFIX = "gitdir:";
const HEAD_MAX_BYTES = 256;
const GIT_POINTER_MAX_BYTES = 4096;
const REFLOG_MAX_BYTES = 1_048_576;
const REFLOG_MAX_LINES = 10_000;

interface AuthorizedGitMetadataBase {
  readonly path: string;
}

interface CanonicalWorkspaceGitLocation {
  readonly dotGit: string;
  readonly workspaceRoot: string;
}

const AUTHORIZED_GIT_METADATA_FILES = new Set(["HEAD", "gitdir", "logs/HEAD"]);

function normalizedPath(path: string): string {
  return normalize(path).replaceAll("\\", "/");
}

function sameCanonicalPath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function isCanonicalWorktreeGitdir(candidate: string): boolean {
  if (!isAbsolute(candidate) || candidate.includes("\u0000")) return false;
  const segments = normalizedPath(candidate)
    .split("/")
    .filter((segment) => segment.length > 0);
  return (
    segments.length >= 3 &&
    segments.at(-3) === ".git" &&
    segments.at(-2) === "worktrees" &&
    (segments.at(-1)?.length ?? 0) > 0
  );
}

function worktreeRepositoryRoot(candidate: string): string {
  return dirname(dirname(dirname(candidate)));
}

function containsParentTraversal(candidate: string): boolean {
  return candidate.split(/[\\/]+/).includes("..");
}

function readGuardedContainedRaw(
  fs: WorkspaceFs,
  base: string,
  relativePath: string,
  maxBytes: number,
  completeness: WorkspaceDescriptorReadCompleteness,
): string | undefined {
  const read = fs.readFileUtf8WithinRootSameDescriptor;
  if (read === undefined) return undefined;
  try {
    const absolutePath = resolveWithinWorkspace(base, relativePath);
    return read.call(fs, base, absolutePath, maxBytes, "reject", completeness).rawText;
  } catch {
    return undefined;
  }
}

function readGuardedGitMetadata(
  fs: WorkspaceFs,
  base: AuthorizedGitMetadataBase,
  relativePath: string,
  maxBytes: number,
  completeness: WorkspaceDescriptorReadCompleteness,
): string | undefined {
  const normalizedRelative = relativePath.replaceAll("\\", "/");
  if (!AUTHORIZED_GIT_METADATA_FILES.has(normalizedRelative)) return undefined;
  const raw = readGuardedContainedRaw(fs, base.path, normalizedRelative, maxBytes, completeness);
  return raw === undefined ? undefined : redact(raw);
}

function canonicalWorkspaceDotGit(
  fs: WorkspaceFs,
  workspaceRoot: string,
): CanonicalWorkspaceGitLocation | undefined {
  try {
    const canonicalRoot = resolveExistingAllowedWorkspaceRealRoot(fs, workspaceRoot);
    const requested = resolveWithinWorkspace(workspaceRoot, ".git");
    const canonical = assertContainedRealPath(fs, canonicalRoot, requested, ".git metadata base");
    const expected = resolveWithinWorkspace(canonicalRoot, ".git");
    return sameCanonicalPath(canonical, expected)
      ? { dotGit: canonical, workspaceRoot: canonicalRoot }
      : undefined;
  } catch {
    return undefined;
  }
}

function singleAbsolutePath(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed.length > 0 &&
    !trimmed.includes("\n") &&
    !trimmed.includes("\u0000") &&
    isAbsolute(trimmed)
    ? normalize(trimmed)
    : undefined;
}

function hasReciprocalWorktreePointer(
  fs: WorkspaceFs,
  base: AuthorizedGitMetadataBase,
  workspaceRoot: string,
  canonicalDotGit: string,
): boolean {
  const raw = readGuardedContainedRaw(fs, base.path, "gitdir", GIT_POINTER_MAX_BYTES, "complete");
  if (raw === undefined) return false;
  const target = singleAbsolutePath(raw);
  if (target === undefined) return false;
  const lexicalDotGit = resolveWithinWorkspace(workspaceRoot, ".git");
  return sameCanonicalPath(target, lexicalDotGit) || sameCanonicalPath(target, canonicalDotGit);
}

function authorizeWorktreeGitdir(
  fs: WorkspaceFs,
  candidate: string,
  workspaceRoot: string,
  canonicalDotGit: string,
): AuthorizedGitMetadataBase | undefined {
  try {
    const requested = normalize(candidate);
    if (!isCanonicalWorktreeGitdir(requested)) return undefined;
    const repositoryRoot = worktreeRepositoryRoot(requested);
    const canonicalRepositoryRoot = resolveExistingAllowedWorkspaceRealRoot(fs, repositoryRoot);
    const expected = resolveWithinWorkspace(
      canonicalRepositoryRoot,
      `.git/worktrees/${basename(requested)}`,
    );
    const canonical = fs.realPath(requested);
    if (!sameCanonicalPath(canonical, expected)) return undefined;
    const contained = assertContainedRealPath(
      fs,
      canonicalRepositoryRoot,
      canonical,
      ".git/worktrees metadata base",
    );
    if (!sameCanonicalPath(contained, canonical)) return undefined;
    const stat = fs.stat(canonical);
    if (!stat.isDirectory || stat.isSymbolicLink) return undefined;
    const base = { path: canonical };
    return hasReciprocalWorktreePointer(fs, base, workspaceRoot, canonicalDotGit)
      ? base
      : undefined;
  } catch {
    return undefined;
  }
}

function authorizeContainedGitdir(
  fs: WorkspaceFs,
  workspaceRoot: string,
  candidate: string,
): AuthorizedGitMetadataBase | undefined {
  try {
    const requested = resolveWithinWorkspace(workspaceRoot, candidate);
    const requestedRelative = relative(normalize(workspaceRoot), requested).replaceAll("\\", "/");
    if (requestedRelative.length === 0) return undefined;
    const contained = containedRealPathInfo(fs, workspaceRoot, requested);
    if (!isCanonicalAllowedContainedPath(contained, workspaceRoot, requestedRelative)) {
      return undefined;
    }
    const stat = fs.stat(contained.path);
    return stat.isDirectory && !stat.isSymbolicLink ? { path: contained.path } : undefined;
  } catch {
    return undefined;
  }
}

function statOrUndefined(
  fs: WorkspaceFs,
  abs: string,
):
  | {
      size: number;
      isFile: boolean;
      isDirectory: boolean;
      isSymbolicLink: boolean;
      hardLinkCount?: number | undefined;
    }
  | undefined {
  try {
    const stat = fs.stat(abs);
    return {
      size: stat.size,
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
      isSymbolicLink: stat.isSymbolicLink,
      hardLinkCount: stat.hardLinkCount,
    };
  } catch {
    return undefined;
  }
}

function readWorktreePointerTarget(
  fs: WorkspaceFs,
  workspaceRoot: string,
  dotGit: string,
): string | undefined {
  const raw = readGuardedContainedRaw(
    fs,
    workspaceRoot,
    relative(workspaceRoot, dotGit),
    GIT_POINTER_MAX_BYTES,
    "complete",
  );
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith(GIT_DIR_PREFIX)) {
    return undefined;
  }
  const target = trimmed.slice(GIT_DIR_PREFIX.length).trim();
  if (target.length === 0 || target.includes("\n")) {
    return undefined;
  }
  return target;
}

function resolvePointedGitdir(
  fs: WorkspaceFs,
  root: string,
  canonicalDotGit: string,
  target: string,
  candidate: string,
): AuthorizedGitMetadataBase | undefined {
  const contained = authorizeContainedGitdir(fs, root, candidate);
  if (contained !== undefined) return contained;
  if (containsParentTraversal(target)) return undefined;
  return authorizeWorktreeGitdir(fs, candidate, root, canonicalDotGit);
}

function pointedGitdirCandidate(root: string, target: string): string | undefined {
  try {
    return isAbsolute(target) ? normalize(target) : resolveWithinWorkspace(root, target);
  } catch {
    return undefined;
  }
}

function isAsciiDigitCode(code: number): boolean {
  return code >= 48 && code <= 57;
}

// Scan forward from `start` while characters are ASCII digits; returns the exclusive end index
// of the digit run (equal to `start` when `line.charAt(start)` is not itself a digit).
function scanDigitRunEnd(line: string, start: number): number {
  let j = start;
  const len = line.length;
  while (j < len && isAsciiDigitCode(line.codePointAt(j) ?? 0)) {
    j += 1;
  }
  return j;
}

// A candidate timestamp is a run of exactly 10 digits that is not immediately preceded by '<'
// (which would indicate it is part of an email address like `<user@1234567890.example>`).
function isUnprefixedTenDigitRun(line: string, start: number, end: number): boolean {
  if (end - start !== 10) {
    return false;
  }
  const prev = start === 0 ? "" : line.charAt(start - 1);
  return prev !== "<";
}

// Find the first 10-digit run that is not preceded by '<'. Avoids regex backtracking.
function firstUnixTimestamp(line: string): number | undefined {
  let i = 0;
  const len = line.length;
  while (i < len) {
    if (!isAsciiDigitCode(line.codePointAt(i) ?? 0)) {
      i += 1;
      continue;
    }
    const end = scanDigitRunEnd(line, i);
    if (isUnprefixedTenDigitRun(line, i, end)) {
      return Number.parseInt(line.slice(i, end), 10);
    }
    i = end;
  }
  return undefined;
}

function extractTimestamps(reflog: string): readonly number[] {
  const out: number[] = [];
  let lineCount = 0;
  for (const line of reflog.split("\n")) {
    if (lineCount >= REFLOG_MAX_LINES) {
      break;
    }
    lineCount += 1;
    if (line.length === 0) {
      continue;
    }
    const ts = firstUnixTimestamp(line);
    if (ts !== undefined) {
      out.push(ts);
    }
  }
  return out;
}

function gitHeadAtom(scope: SearchScope, fingerprint: string, nowMs: number): EvidenceAtom {
  return buildAtom({
    scopeId: scope.scopeId,
    scopePath: ".git/HEAD",
    lineRange: undefined,
    provenanceKind: "git-history",
    tool: "git-reflog",
    queryFingerprint: fingerprint,
    score: 1.0,
    emittedAtMs: nowMs,
  });
}

function standardGitdir(fs: WorkspaceFs, dotGit: string): AuthorizedGitMetadataBase | undefined {
  const stat = statOrUndefined(fs, dotGit);
  if (stat?.isDirectory !== true || stat.isSymbolicLink) return undefined;
  return { path: dotGit };
}

function pointedGitdir(
  fs: WorkspaceFs,
  root: string,
  location: CanonicalWorkspaceGitLocation,
): AuthorizedGitMetadataBase | undefined {
  const { dotGit, workspaceRoot } = location;
  const stat = statOrUndefined(fs, dotGit);
  if (stat?.isFile !== true || stat.isSymbolicLink) return undefined;
  const target = readWorktreePointerTarget(fs, workspaceRoot, dotGit);
  if (target === undefined) return undefined;
  const candidate = pointedGitdirCandidate(root, target);
  if (candidate === undefined) return undefined;
  return resolvePointedGitdir(fs, root, dotGit, target, candidate);
}

// Resolve the gitdir root: for a plain repo it is `workspace.root/.git/`; for a worktree
// it is the path pointed at by the `.git` pointer file. Returns undefined when unavailable.
// Strategy: check whether HEAD lives directly at `.git/HEAD` first (covers the normal case AND
// the memFs directory simulation where only child keys are recorded); fall back to treating
// `.git` as a worktree-pointer file only when that leaf check fails.
export function resolveGitdir(
  fs: WorkspaceFs,
  root: string,
): Promise<AuthorizedGitMetadataBase | undefined> {
  const location = canonicalWorkspaceDotGit(fs, root);
  return Promise.resolve(
    location === undefined
      ? undefined
      : (standardGitdir(fs, location.dotGit) ?? pointedGitdir(fs, root, location)),
  );
}

async function isAvailableForScope(scope: SearchScope, fs: WorkspaceFs): Promise<boolean> {
  // Finding 8: git-history is a repo-level signal; sub-folder scoping is meaningless and
  // would require reading outside the user-selected boundary.
  if (scope.relativePaths.length > 0) {
    return false;
  }
  const root = scope.workspace.root;
  const gitdir = await resolveGitdir(fs, root);
  if (gitdir === undefined) {
    return false;
  }
  // HEAD must exist inside the resolved gitdir.
  return readGuardedGitMetadata(fs, gitdir, "HEAD", HEAD_MAX_BYTES, "complete") !== undefined;
}

export const gitHistoryAdapter: StructuralAdapter = {
  name: "git-history",
  isAvailable: async (scope: SearchScope, fs: WorkspaceFs): Promise<boolean> => {
    try {
      return await isAvailableForScope(scope, fs);
    } catch {
      return false;
    }
  },
  lookup: async (
    scope: SearchScope,
    query: RetrievalQuery,
    _limits: SearchLimits,
    fs: WorkspaceFs,
    deps?: StructuralAdapterDeps,
  ): Promise<readonly EvidenceAtom[]> => {
    const nowMs = deps?.nowMs ?? Date.now;
    // Finding 8: early-out when scope has sub-paths (matches isAvailable contract).
    if (scope.relativePaths.length > 0) {
      return [];
    }
    const root = scope.workspace.root;
    // Finding 7: resolve the real gitdir so worktree-pointer layouts work end-to-end.
    const gitdir = await resolveGitdir(fs, root);
    if (gitdir === undefined) {
      return [];
    }
    const head = readGuardedGitMetadata(fs, gitdir, "HEAD", HEAD_MAX_BYTES, "complete");
    if (head === undefined) {
      return [];
    }
    const reflog = readGuardedGitMetadata(fs, gitdir, "logs/HEAD", REFLOG_MAX_BYTES, "prefix");
    if (reflog === undefined || reflog.length === 0) {
      return [];
    }
    const timestamps = extractTimestamps(reflog);
    if (timestamps.length === 0) {
      return [];
    }
    return [gitHeadAtom(scope, queryFingerprint(query), nowMs())];
  },
};
