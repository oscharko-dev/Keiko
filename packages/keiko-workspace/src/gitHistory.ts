// Git-history adapter (Epic #177, Issue #180). Reads `.git/HEAD` and `.git/logs/HEAD` directly
// via the WorkspaceFs port — never spawns `git` and never imports `child_process`. The shared
// always-on deny list refuses `.git`; this adapter is the SOLE legitimate consumer of those
// paths and therefore goes through the lower-level `fs.readFileUtf8` after `assertContainedRealPath`,
// applies an explicit stat-based size cap, and redacts the contents. v1 surfaces the presence
// of a reflog as a single EvidenceAtom referencing `.git/HEAD`; per-file granularity deferred.
// Worktree pointer files (`.git: gitdir: <path>`) are validated through the same realpath gate
// and rejected if they escape the workspace boundary.

import { createHash } from "node:crypto";
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
const REFLOG_MAX_BYTES = 1_048_576;
const REFLOG_MAX_LINES = 10_000;

function readGuarded(
  fs: WorkspaceFs,
  root: string,
  relativePath: string,
  maxBytes: number,
): string | undefined {
  const abs = resolveWithinWorkspace(root, relativePath);
  try {
    assertContainedRealPath(fs, root, abs, relativePath);
  } catch {
    return undefined;
  }
  if (!fs.exists(abs)) {
    return undefined;
  }
  const stat = fs.stat(abs);
  if (!stat.isFile) {
    return undefined;
  }
  let raw: string;
  try {
    raw = fs.readFileUtf8(abs);
  } catch {
    return undefined;
  }
  const capped = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
  return redact(capped);
}

function statOrUndefined(
  fs: WorkspaceFs,
  abs: string,
): { isFile: boolean; isDirectory: boolean } | undefined {
  try {
    const stat = fs.stat(abs);
    return { isFile: stat.isFile, isDirectory: stat.isDirectory };
  } catch {
    return undefined;
  }
}

function readWorktreePointerTarget(fs: WorkspaceFs, dotGit: string): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileUtf8(dotGit);
  } catch {
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

function isContainedAndPresent(fs: WorkspaceFs, root: string, abs: string, label: string): boolean {
  try {
    assertContainedRealPath(fs, root, abs, label);
  } catch {
    return false;
  }
  return fs.exists(abs);
}

function isWorktreePointerValid(fs: WorkspaceFs, root: string, dotGit: string): boolean {
  const target = readWorktreePointerTarget(fs, dotGit);
  if (target === undefined) {
    return false;
  }
  const candidate = target.startsWith("/") ? target : resolveWithinWorkspace(root, target);
  return isContainedAndPresent(fs, root, candidate, ".git pointer");
}

function isGitDirPresent(fs: WorkspaceFs, root: string): boolean {
  const dotGit = resolveWithinWorkspace(root, ".git");
  if (!isContainedAndPresent(fs, root, dotGit, ".git")) {
    return false;
  }
  const stat = statOrUndefined(fs, dotGit);
  if (stat === undefined) {
    return false;
  }
  if (stat.isDirectory) {
    return true;
  }
  if (!stat.isFile) {
    return false;
  }
  return isWorktreePointerValid(fs, root, dotGit);
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

function isAvailableForScope(scope: SearchScope, fs: WorkspaceFs): boolean {
  // Direct check on .git/HEAD comes FIRST. Some FS implementations (notably the test memFs)
  // do not surface implicit parent directories via fs.exists(); checking the leaf file is
  // both stricter (we need HEAD anyway) and more portable across port implementations.
  const head = resolveWithinWorkspace(scope.workspace.root, ".git/HEAD");
  if (isContainedAndPresent(fs, scope.workspace.root, head, ".git/HEAD")) {
    return true;
  }
  // Fallback: validate .git as a directory or as a valid worktree-pointer file.
  return isGitDirPresent(fs, scope.workspace.root);
}

export const gitHistoryAdapter: StructuralAdapter = {
  name: "git-history",
  isAvailable: (scope: SearchScope, fs: WorkspaceFs): Promise<boolean> => {
    try {
      return Promise.resolve(isAvailableForScope(scope, fs));
    } catch {
      return Promise.resolve(false);
    }
  },
  lookup: (
    scope: SearchScope,
    query: RetrievalQuery,
    limits: SearchLimits,
    fs: WorkspaceFs,
    deps?: StructuralAdapterDeps,
  ): Promise<readonly EvidenceAtom[]> => {
    void limits;
    const nowMs = deps?.nowMs ?? Date.now;
    const head = readGuarded(fs, scope.workspace.root, ".git/HEAD", HEAD_MAX_BYTES);
    if (head === undefined) {
      return Promise.resolve([]);
    }
    const reflog = readGuarded(fs, scope.workspace.root, ".git/logs/HEAD", REFLOG_MAX_BYTES);
    if (reflog === undefined || reflog.length === 0) {
      return Promise.resolve([]);
    }
    const timestamps = extractTimestamps(reflog);
    if (timestamps.length === 0) {
      return Promise.resolve([]);
    }
    return Promise.resolve([gitHeadAtom(scope, queryFingerprint(query), nowMs())]);
  },
};
