// Git-history adapter (Epic #177, Issue #180). Reads `.git/HEAD` and `.git/logs/HEAD` directly
// via the WorkspaceFs port — never spawns `git` and never imports `child_process`. The shared
// always-on deny list refuses `.git`; this adapter is the SOLE legitimate consumer of those
// paths and therefore goes through the lower-level `fs.readFileUtf8` after `assertContainedRealPath`,
// applies an explicit stat-based size cap, and redacts the contents. v1 surfaces the presence
// of a reflog as a single EvidenceAtom referencing `.git/HEAD`; per-file granularity deferred.
// Stays within ADR-0019 rule 3b: imports only @oscharko-dev/keiko-contracts, sibling workspace
// modules, and Node stdlib (node:crypto). Limitation: unavailable when scope.relativePaths is
// non-empty because git-history is a repo-level signal that cannot meaningfully scope to a
// sub-folder.

import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { redact } from "@oscharko-dev/keiko-security";
import type { WorkspaceFs } from "./fs.js";
import { resolveWithinWorkspace } from "./paths.js";
import { assertContainedRealPath } from "./realpath.js";
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

function isAllowedExternalGitdir(candidate: string): boolean {
  return candidate.replace(/\\/g, "/").includes("/.git/worktrees/");
}

function containsParentTraversal(candidate: string): boolean {
  return candidate.split(/[\\/]+/).includes("..");
}

async function readGuardedAbsolute(
  fs: WorkspaceFs,
  base: string,
  absolutePath: string,
  label: string,
  maxBytes: number,
): Promise<string | undefined> {
  try {
    assertContainedRealPath(fs, base, absolutePath, label);
  } catch {
    return undefined;
  }
  if (!fs.exists(absolutePath)) {
    return undefined;
  }
  const stat = fs.stat(absolutePath);
  if (!stat.isFile) {
    return undefined;
  }
  if (stat.hardLinkCount !== undefined && stat.hardLinkCount > 1) {
    return undefined;
  }
  // Enforce the size cap BEFORE reading to avoid loading multi-megabyte files into memory
  // (matches the probeBinary pattern from repoSearchScan.ts).
  if (stat.size > maxBytes) {
    if (fs.readFileBytes !== undefined) {
      let bytes: Uint8Array;
      try {
        bytes = await fs.readFileBytes(absolutePath, maxBytes);
      } catch {
        return undefined;
      }
      return redact(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
    }
    return undefined;
  }
  let raw: string;
  try {
    raw = fs.readFileUtf8(absolutePath);
  } catch {
    return undefined;
  }
  return redact(raw);
}

function statOrUndefined(
  fs: WorkspaceFs,
  abs: string,
):
  | { size: number; isFile: boolean; isDirectory: boolean; hardLinkCount?: number | undefined }
  | undefined {
  try {
    const stat = fs.stat(abs);
    return {
      size: stat.size,
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
      hardLinkCount: stat.hardLinkCount,
    };
  } catch {
    return undefined;
  }
}

async function readSmallUtf8File(
  fs: WorkspaceFs,
  abs: string,
  maxBytes: number,
): Promise<string | undefined> {
  const stat = statOrUndefined(fs, abs);
  if (!stat?.isFile) {
    return undefined;
  }
  if (stat.hardLinkCount !== undefined && stat.hardLinkCount > 1) {
    return undefined;
  }
  if (stat.size > maxBytes) {
    return undefined;
  }
  if (fs.readFileBytes !== undefined) {
    try {
      const bytes = await fs.readFileBytes(abs, maxBytes);
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      return undefined;
    }
  }
  try {
    return fs.readFileUtf8(abs);
  } catch {
    return undefined;
  }
}

async function readWorktreePointerTarget(
  fs: WorkspaceFs,
  dotGit: string,
): Promise<string | undefined> {
  const raw = await readSmallUtf8File(fs, dotGit, GIT_POINTER_MAX_BYTES);
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

function containedPathIfPresent(
  fs: WorkspaceFs,
  base: string,
  abs: string,
  label: string,
): string | undefined {
  try {
    const contained = assertContainedRealPath(fs, base, abs, label);
    if (!fs.exists(contained)) {
      return undefined;
    }
    return contained;
  } catch {
    return undefined;
  }
}

function isContainedAndPresent(fs: WorkspaceFs, base: string, abs: string, label: string): boolean {
  return containedPathIfPresent(fs, base, abs, label) !== undefined;
}

function resolvePointedGitdir(
  fs: WorkspaceFs,
  root: string,
  target: string,
  candidate: string,
): string | undefined {
  if (!isAbsolute(target)) {
    try {
      return assertContainedRealPath(fs, root, candidate, ".git pointer");
    } catch {
      return undefined;
    }
  }
  if (containsParentTraversal(target)) {
    return undefined;
  }
  const contained = containedPathIfPresent(fs, root, candidate, ".git pointer");
  if (contained !== undefined) {
    return contained;
  }
  let canonical: string;
  try {
    canonical = fs.realPath(candidate);
  } catch {
    return undefined;
  }
  return isAllowedExternalGitdir(canonical) ? canonical : undefined;
}

// Find the first 10-digit run that is not preceded by '<'. Avoids regex backtracking.
function firstUnixTimestamp(line: string): number | undefined {
  let i = 0;
  const len = line.length;
  while (i < len) {
    const code = line.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      let j = i;
      while (j < len && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) {
        j += 1;
      }
      if (j - i === 10) {
        const prev = i === 0 ? "" : line.charAt(i - 1);
        if (prev !== "<") {
          return Number.parseInt(line.slice(i, j), 10);
        }
      }
      i = j;
    } else {
      i += 1;
    }
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

// Resolve the gitdir root: for a plain repo it is `workspace.root/.git/`; for a worktree
// it is the path pointed at by the `.git` pointer file. Returns undefined when unavailable.
// Strategy: check whether HEAD lives directly at `.git/HEAD` first (covers the normal case AND
// the memFs directory simulation where only child keys are recorded); fall back to treating
// `.git` as a worktree-pointer file only when that leaf check fails.
async function resolveGitdir(fs: WorkspaceFs, root: string): Promise<string | undefined> {
  const dotGit = resolveWithinWorkspace(root, ".git");
  const headDirect = `${dotGit}/HEAD`;
  // Fast path: HEAD exists directly under .git — this is the standard directory layout.
  // We do NOT require .git itself to appear as a stat entry (some WorkspaceFs impls, notably
  // the test memFs, only record leaf file paths, not implicit parent directories).
  if (isContainedAndPresent(fs, root, headDirect, ".git/HEAD")) {
    return dotGit;
  }
  // Slow path: .git must be a regular file (worktree pointer). It must exist AND be readable.
  if (!isContainedAndPresent(fs, root, dotGit, ".git")) {
    return undefined;
  }
  const s = statOrUndefined(fs, dotGit);
  if (!s?.isFile) {
    return undefined;
  }
  // Worktree-pointer: read the `gitdir: <path>` value, validate containment once.
  const target = await readWorktreePointerTarget(fs, dotGit);
  if (target === undefined) {
    return undefined;
  }
  const candidate = isAbsolute(target) ? normalize(target) : resolveWithinWorkspace(root, target);
  // Real git worktrees usually point outside the checkout root to `.git/worktrees/<name>`.
  // Allow that one narrow shape, but still constrain the actual reads to files whose realpaths
  // stay inside the resolved gitdir itself.
  const gitdir = resolvePointedGitdir(fs, root, target, candidate);
  if (gitdir === undefined) {
    return undefined;
  }
  const pointedHead = `${gitdir}/HEAD`;
  if (!isContainedAndPresent(fs, gitdir, pointedHead, ".git-pointer/HEAD")) {
    return undefined;
  }
  return gitdir;
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
  const headAbs = `${gitdir}/HEAD`;
  return isContainedAndPresent(fs, gitdir, headAbs, ".git/HEAD");
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
    limits: SearchLimits,
    fs: WorkspaceFs,
    deps?: StructuralAdapterDeps,
  ): Promise<readonly EvidenceAtom[]> => {
    void limits;
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
    const head = await readGuardedAbsolute(
      fs,
      gitdir,
      `${gitdir}/HEAD`,
      ".git/HEAD",
      HEAD_MAX_BYTES,
    );
    if (head === undefined) {
      return [];
    }
    const reflog = await readGuardedAbsolute(
      fs,
      gitdir,
      `${gitdir}/logs/HEAD`,
      ".git/logs/HEAD",
      REFLOG_MAX_BYTES,
    );
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
