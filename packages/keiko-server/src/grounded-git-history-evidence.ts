// File-scoped git-history evidence for grounded retrieval. Git execution remains server-side behind
// the existing fixed-argv, capped process runner; the workspace package still never spawns Git.
// Output is content-free: per-file recency/churn metrics only, filtered back to the selected root.

import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  isValidScopePath,
  type EvidenceAtom,
  type RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import {
  containedRealPathInfo,
  evidenceAtomStableId,
  isDenied,
  resolveWithinWorkspace,
  type SearchScope,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { defaultGitProcessRunner, isContained, type GitProcessRunner } from "./gitRoutes.js";

const GIT_HISTORY_RECORD_SEP = "\x1e";
const GIT_HISTORY_COMMIT_LIMIT = 200;
const GIT_HISTORY_MAX_BYTES = 512 * 1024;
const GIT_HISTORY_TIMEOUT_MS = 5_000;
const GIT_HISTORY_MAX_FILES = 128;
const SECONDS_PER_DAY = 86_400;
const RECENCY_HALF_LIFE_DAYS = 30;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/u;

export interface GitFileHistoryEvidenceInputs {
  readonly searchScope: SearchScope;
  readonly query: RetrievalQuery;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly signal?: AbortSignal | undefined;
  readonly runner?: GitProcessRunner | undefined;
  readonly maxFiles?: number | undefined;
}

export type GitFileHistoryEvidenceProvider = (
  inputs: GitFileHistoryEvidenceInputs,
) => Promise<readonly EvidenceAtom[]>;

interface GitRepositoryForHistory {
  readonly repositoryRoot: string;
  readonly selectedRootPrefix: string;
}

interface FileHistoryStats {
  readonly scopePath: string;
  commitCount: number;
  lastCommitUnix: number;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CancelledError("git history evidence cancelled");
  }
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

function queryFingerprint(query: RetrievalQuery): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "git-file-history",
        queryKind: query.kind,
        text: query.text,
        caseSensitive: query.caseSensitive,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function scoreFingerprint(recency: number, churn: number, stats: FileHistoryStats): string {
  const recencyBucket = Math.round(recency * 1_000);
  const churnBucket = Math.round(churn * 1_000);
  return `git:${String(stats.lastCommitUnix)}:${String(stats.commitCount)}:${String(
    recencyBucket,
  )}:${String(churnBucket)}`;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function recencyScore(lastCommitUnix: number, nowMs: number): number {
  const nowUnix = Math.floor(nowMs / 1_000);
  const ageDays = Math.max(0, nowUnix - lastCommitUnix) / SECONDS_PER_DAY;
  return clampUnit(1 / (1 + ageDays / RECENCY_HALF_LIFE_DAYS));
}

function churnScore(commitCount: number, maxCommitCount: number): number {
  const denominator = Math.log1p(Math.max(3, maxCommitCount));
  return clampUnit(Math.log1p(Math.max(0, commitCount)) / denominator);
}

function combinedScore(recency: number, churn: number): number {
  return clampUnit(recency * 0.7 + churn * 0.3);
}

function stripSelectedPrefix(repoPath: string, prefix: string): string | undefined {
  if (prefix.length === 0 || prefix === ".") {
    return repoPath;
  }
  if (repoPath === prefix) {
    return undefined;
  }
  const start = `${prefix}/`;
  return repoPath.startsWith(start) ? repoPath.slice(start.length) : undefined;
}

function normalizeGitPath(raw: string): string | undefined {
  let normalized = raw.replace(/\r$/u, "").replaceAll("\\", "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    WINDOWS_DRIVE_RE.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return undefined;
  }
  return normalized;
}

function isWithinSelectedScope(searchScope: SearchScope, scopePath: string): boolean {
  if (searchScope.relativePaths.length === 0) {
    return true;
  }
  return searchScope.relativePaths.some(
    (entry) => scopePath === entry || scopePath.startsWith(`${entry}/`),
  );
}

function fileExistsInScope(searchScope: SearchScope, fs: WorkspaceFs, scopePath: string): boolean {
  if (
    !isValidScopePath(scopePath, { mustBeRelative: true }) ||
    !isWithinSelectedScope(searchScope, scopePath) ||
    isDenied(scopePath)
  ) {
    return false;
  }
  try {
    const abs = resolveWithinWorkspace(searchScope.workspace.root, scopePath);
    const contained = containedRealPathInfo(fs, searchScope.workspace.root, abs);
    return fs.stat(contained.path).isFile;
  } catch {
    return false;
  }
}

async function resolveGitRepositoryForHistory(
  inputs: GitFileHistoryEvidenceInputs,
  runner: GitProcessRunner,
): Promise<GitRepositoryForHistory | undefined> {
  let selectedRoot: string;
  try {
    selectedRoot = inputs.fs.realPath(inputs.searchScope.workspace.root);
  } catch {
    return undefined;
  }
  const revParse = await runner(
    ["--no-pager", "--no-optional-locks", "-C", selectedRoot, "rev-parse", "--show-toplevel"],
    { cwd: selectedRoot, maxBytes: 16 * 1024, timeoutMs: GIT_HISTORY_TIMEOUT_MS },
  );
  if (revParse.exitCode !== 0) {
    return undefined;
  }
  const rawRepositoryRoot = revParse.stdout.split(/\r?\n/u)[0]?.trim();
  if (rawRepositoryRoot === undefined || rawRepositoryRoot.length === 0) {
    return undefined;
  }
  const repositoryRoot = isAbsolute(rawRepositoryRoot)
    ? resolve(rawRepositoryRoot)
    : resolve(selectedRoot, rawRepositoryRoot);
  let realRepositoryRoot: string;
  try {
    realRepositoryRoot = inputs.fs.realPath(repositoryRoot);
  } catch {
    realRepositoryRoot = repositoryRoot;
  }
  if (!isContained(realRepositoryRoot, selectedRoot)) {
    return undefined;
  }
  return {
    repositoryRoot: realRepositoryRoot,
    selectedRootPrefix: toPosix(relative(realRepositoryRoot, selectedRoot)),
  };
}

function gitHistoryArgs(repositoryRoot: string): readonly string[] {
  return [
    "--no-pager",
    "--no-optional-locks",
    "-C",
    repositoryRoot,
    "-c",
    "core.quotepath=false",
    "log",
    "--no-color",
    "--no-renames",
    `--max-count=${String(GIT_HISTORY_COMMIT_LIMIT)}`,
    `--format=${GIT_HISTORY_RECORD_SEP}%ct`,
    "--name-only",
    "--",
  ];
}

function recordTimestamp(lines: readonly string[]): number | undefined {
  const timestamp = Number.parseInt(lines[0]?.trim() ?? "", 10);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
}

function scopePathForHistoryLine(
  rawPath: string,
  repo: GitRepositoryForHistory,
  inputs: GitFileHistoryEvidenceInputs,
): string | undefined {
  const repoPath = normalizeGitPath(rawPath);
  if (repoPath === undefined) {
    return undefined;
  }
  const scopePath = stripSelectedPrefix(repoPath, repo.selectedRootPrefix);
  if (scopePath === undefined || !fileExistsInScope(inputs.searchScope, inputs.fs, scopePath)) {
    return undefined;
  }
  return scopePath;
}

function recordFileHistory(
  byPath: Map<string, FileHistoryStats>,
  scopePath: string,
  timestamp: number,
): void {
  const existing = byPath.get(scopePath);
  if (existing === undefined) {
    byPath.set(scopePath, { scopePath, commitCount: 1, lastCommitUnix: timestamp });
    return;
  }
  existing.commitCount += 1;
  existing.lastCommitUnix = Math.max(existing.lastCommitUnix, timestamp);
}

function parseGitHistoryStats(
  stdout: string,
  repo: GitRepositoryForHistory,
  inputs: GitFileHistoryEvidenceInputs,
): readonly FileHistoryStats[] {
  const byPath = new Map<string, FileHistoryStats>();
  for (const record of stdout.split(GIT_HISTORY_RECORD_SEP)) {
    if (record.length === 0) {
      continue;
    }
    const lines = record.split("\n");
    const timestamp = recordTimestamp(lines);
    if (timestamp === undefined) {
      continue;
    }
    const seenInCommit = new Set<string>();
    for (const rawPath of lines.slice(1)) {
      const scopePath = scopePathForHistoryLine(rawPath, repo, inputs);
      if (scopePath === undefined || seenInCommit.has(scopePath)) {
        continue;
      }
      seenInCommit.add(scopePath);
      recordFileHistory(byPath, scopePath, timestamp);
    }
  }
  return [...byPath.values()];
}

function compareStats(
  nowMs: number,
  maxCommitCount: number,
): (a: FileHistoryStats, b: FileHistoryStats) => number {
  return (a, b) => {
    const scoreA = combinedScore(
      recencyScore(a.lastCommitUnix, nowMs),
      churnScore(a.commitCount, maxCommitCount),
    );
    const scoreB = combinedScore(
      recencyScore(b.lastCommitUnix, nowMs),
      churnScore(b.commitCount, maxCommitCount),
    );
    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }
    if (b.lastCommitUnix !== a.lastCommitUnix) {
      return b.lastCommitUnix - a.lastCommitUnix;
    }
    if (b.commitCount !== a.commitCount) {
      return b.commitCount - a.commitCount;
    }
    return a.scopePath.localeCompare(b.scopePath);
  };
}

function historyAtom(
  inputs: GitFileHistoryEvidenceInputs,
  fingerprint: string,
  stats: FileHistoryStats,
  maxCommitCount: number,
): EvidenceAtom {
  const emittedAtMs = inputs.nowMs();
  const recency = recencyScore(stats.lastCommitUnix, emittedAtMs);
  const churn = churnScore(stats.commitCount, maxCommitCount);
  const score = combinedScore(recency, churn);
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: evidenceAtomStableId({
      scopeId: inputs.searchScope.scopeId,
      scopePath: stats.scopePath,
      lineRange: undefined,
      evidenceFingerprint: scoreFingerprint(recency, churn, stats),
      provenanceKind: "git-history",
      provenanceTool: "git-file-history",
      queryFingerprint: fingerprint,
    }),
    scopePath: stats.scopePath,
    lineRange: undefined,
    score,
    provenance: {
      kind: "git-history",
      tool: "git-file-history",
      queryFingerprint: fingerprint,
    },
    metrics: { gitRecency: recency, gitChurn: churn },
    redactionState: "redacted",
    emittedAtMs,
    ledgerRef: undefined,
  };
}

export const defaultGitFileHistoryEvidenceProvider: GitFileHistoryEvidenceProvider = async (
  inputs,
) => {
  const runner = inputs.runner ?? defaultGitProcessRunner;
  throwIfCancelled(inputs.signal);
  const repo = await resolveGitRepositoryForHistory(inputs, runner);
  if (repo === undefined) {
    return [];
  }
  throwIfCancelled(inputs.signal);
  const result = await runner(gitHistoryArgs(repo.repositoryRoot), {
    cwd: repo.repositoryRoot,
    maxBytes: GIT_HISTORY_MAX_BYTES,
    timeoutMs: GIT_HISTORY_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    return [];
  }
  throwIfCancelled(inputs.signal);
  const stats = parseGitHistoryStats(result.stdout, repo, inputs);
  if (stats.length === 0) {
    return [];
  }
  const maxCommitCount = Math.max(...stats.map((entry) => entry.commitCount));
  const maxFiles = Math.max(
    0,
    Math.min(inputs.maxFiles ?? GIT_HISTORY_MAX_FILES, GIT_HISTORY_MAX_FILES),
  );
  const fingerprint = queryFingerprint(inputs.query);
  return [...stats]
    .sort(compareStats(inputs.nowMs(), maxCommitCount))
    .slice(0, maxFiles)
    .map((entry) => historyAtom(inputs, fingerprint, entry, maxCommitCount));
};
