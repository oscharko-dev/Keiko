// File-scoped git-history evidence for grounded retrieval. Git execution remains server-side behind
// the existing fixed-argv, capped process runner; the workspace package still never spawns Git.
// Output is content-free: per-file recency/churn metrics only, filtered back to the selected root.

import { createHash } from "node:crypto";
import { relative } from "node:path";
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
  type WorkspaceStat,
} from "@oscharko-dev/keiko-workspace";
import { isCanonicalAllowedContainedPath } from "@oscharko-dev/keiko-workspace/internal/realpath-policy";
import {
  containsPath,
  defaultGitProcessRunner,
  GIT_BASE_ARGS,
  resolveGitMembership,
  type GitProcessResult,
  type GitProcessRunner,
} from "@oscharko-dev/keiko-git";
import { observedGitRunner } from "./gitProcessActivity.js";
import {
  AbortDeadlineRaceError,
  raceAbortDeadline,
  type AbortDeadlineContext,
} from "./abort-race.js";
import type { ServerLogSink } from "./observability/index.js";
import { processServerLogSink } from "./process-log-sink.js";

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
  // Optional request-wide absolute deadline. The orchestrator owns the elapsed budget; this seam
  // lets both bounded Git subprocesses use only the time that remains instead of starting a fresh
  // five-second timeout near the end of the request.
  readonly deadlineAtMs?: number | undefined;
  /**
   * The grounded ask's own correlation id, threaded from `RouteContext.correlationId` through
   * `OrchestratorDeps` and `SearchInputs` (ADR-0173 D5). Required for the activity-log lines below
   * to be worth anything: a git failure recorded here belongs to ONE ask, and a line stamped with
   * the `UNKNOWN_CORRELATION_ID` fallback could not be joined back to the answer it degraded —
   * which is the only question an operator asks of it.
   */
  readonly correlationId?: string | undefined;
  /**
   * Activity-log sink, defaulting to the shared process log. A test seam in exactly the same sense
   * as `runner` above; production omits it.
   */
  readonly activityLog?: ServerLogSink | undefined;
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

function gitHistoryDeadlineReached(inputs: GitFileHistoryEvidenceInputs): boolean {
  return inputs.deadlineAtMs !== undefined && inputs.nowMs() >= inputs.deadlineAtMs;
}

function boundedGitHistoryInputs(
  inputs: GitFileHistoryEvidenceInputs,
): GitFileHistoryEvidenceInputs {
  const localDeadlineAtMs = inputs.nowMs() + GIT_HISTORY_TIMEOUT_MS;
  const parentDeadlineAtMs = inputs.deadlineAtMs;
  const deadlineAtMs =
    parentDeadlineAtMs === undefined || !Number.isFinite(parentDeadlineAtMs)
      ? localDeadlineAtMs
      : Math.min(parentDeadlineAtMs, localDeadlineAtMs);
  return { ...inputs, deadlineAtMs };
}

async function runGitHistoryStage<T>(
  inputs: GitFileHistoryEvidenceInputs,
  operation: (context: AbortDeadlineContext) => Promise<T>,
): Promise<T | undefined> {
  try {
    return await raceAbortDeadline(operation, {
      deadlineAtMs: inputs.deadlineAtMs ?? inputs.nowMs(),
      nowMs: inputs.nowMs,
      ...(inputs.signal === undefined ? {} : { signal: inputs.signal }),
    });
  } catch (error) {
    if (!(error instanceof AbortDeadlineRaceError)) throw error;
    if (error.reason === "aborted") {
      throw new CancelledError("git history evidence cancelled");
    }
    return undefined;
  }
}

function fileExistsInScope(inputs: GitFileHistoryEvidenceInputs, scopePath: string): boolean {
  const { searchScope, fs } = inputs;
  throwIfCancelled(inputs.signal);
  if (
    gitHistoryDeadlineReached(inputs) ||
    !isValidScopePath(scopePath, { mustBeRelative: true }) ||
    !isWithinSelectedScope(searchScope, scopePath) ||
    isDenied(scopePath)
  ) {
    return false;
  }
  try {
    throwIfCancelled(inputs.signal);
    const abs = resolveWithinWorkspace(searchScope.workspace.root, scopePath);
    const contained = containedRealPathInfo(fs, searchScope.workspace.root, abs);
    throwIfCancelled(inputs.signal);
    if (!isCanonicalAllowedContainedPath(contained, searchScope.workspace.root, scopePath)) {
      return false;
    }
    if (gitHistoryDeadlineReached(inputs)) {
      return false;
    }
    throwIfCancelled(inputs.signal);
    const stat = fs.stat(contained.path);
    throwIfCancelled(inputs.signal);
    // The metadata read itself can consume the last of the budget. Re-read the clock after it:
    // admitting a path on a `stat` that only returned once the deadline had already passed would
    // record evidence the request is no longer allowed to produce.
    if (gitHistoryDeadlineReached(inputs)) {
      return false;
    }
    return isSafeRegularFile(stat);
  } catch {
    throwIfCancelled(inputs.signal);
    return false;
  }
}

function isSafeRegularFile(stat: WorkspaceStat): boolean {
  return (
    stat.isFile &&
    !stat.isSymbolicLink &&
    (stat.hardLinkCount === undefined || stat.hardLinkCount <= 1)
  );
}

async function resolveGitRepositoryForHistory(
  inputs: GitFileHistoryEvidenceInputs,
  runner: GitProcessRunner,
): Promise<GitRepositoryForHistory | undefined> {
  throwIfCancelled(inputs.signal);
  if (gitHistoryDeadlineReached(inputs)) {
    return undefined;
  }
  let selectedRoot: string;
  try {
    selectedRoot = inputs.fs.realPath(inputs.searchScope.workspace.root);
  } catch {
    throwIfCancelled(inputs.signal);
    return undefined;
  }
  throwIfCancelled(inputs.signal);
  if (gitHistoryDeadlineReached(inputs)) {
    return undefined;
  }
  // KEIKO-0516: reuse the shared resolveGitMembership primitive instead of hand-rolling
  // a rev-parse. It ships the same call with --show-prefix in one round trip so we get
  // the selected root's prefix without a separate relative()-of-realPath computation,
  // and it centralises the ownership/toplevel-parsing hardening.
  const membership = await runGitHistoryStage(inputs, ({ signal, timeoutMs }) =>
    resolveGitMembership(selectedRoot, runner, { timeoutMs, abortSignal: signal }),
  );
  if (membership === undefined || !membership.ok || gitHistoryDeadlineReached(inputs)) {
    return undefined;
  }
  const repositoryRoot = membership.membership.repositoryRoot;
  let realRepositoryRoot: string;
  throwIfCancelled(inputs.signal);
  try {
    realRepositoryRoot = inputs.fs.realPath(repositoryRoot);
  } catch {
    throwIfCancelled(inputs.signal);
    if (gitHistoryDeadlineReached(inputs)) {
      return undefined;
    }
    realRepositoryRoot = repositoryRoot;
  }
  throwIfCancelled(inputs.signal);
  if (!containsPath(realRepositoryRoot, selectedRoot)) {
    return undefined;
  }
  // The prefix is derived from the resolved paths rather than read off
  // membership.prefix: resolveGitMembership applies `.trim()` to the --show-prefix line,
  // which mangles a directory name that legitimately begins or ends with whitespace, and
  // stripSelectedPrefix would then fail to match any returned filename (leaving history
  // evidence silently empty). relative() is byte-exact and costs no extra process — the
  // shared resolver is still what buys us the single bounded round trip and the hardened
  // toplevel/ownership parsing this call site previously hand-rolled.
  return {
    repositoryRoot: realRepositoryRoot,
    selectedRootPrefix: toPosix(relative(realRepositoryRoot, selectedRoot)),
  };
}

function remainingGitHistoryTimeMs(inputs: GitFileHistoryEvidenceInputs): number {
  if (inputs.deadlineAtMs === undefined) {
    return GIT_HISTORY_TIMEOUT_MS;
  }
  return Math.max(
    0,
    Math.min(GIT_HISTORY_TIMEOUT_MS, Math.floor(inputs.deadlineAtMs - inputs.nowMs())),
  );
}

// Path-scope the log so the GIT_HISTORY_COMMIT_LIMIT cap is spent inside the selected
// root rather than repo-wide, which starved subfolder scopes in busy monorepos
// (issue #2901 / KEIKO-0421). Empty prefix maps explicitly to "." — git treats an
// empty-string pathspec differently from omitting one. A non-empty prefix is wrapped in
// `:(literal)` so a directory whose name looks like a git pathspec magic word (e.g.
// `feature-*` or `:(exclude)docs`) cannot be re-read as a glob or a magic signature.
// Mirrors gitRoutes.ts's literalGitPathspec used by every other keiko-server git read.
function gitHistoryArgs(repositoryRoot: string, selectedRootPrefix: string): readonly string[] {
  const pathspec = selectedRootPrefix.length > 0 ? `:(literal)${selectedRootPrefix}` : ".";
  return [
    ...GIT_BASE_ARGS,
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
    pathspec,
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
  if (scopePath === undefined || !fileExistsInScope(inputs, scopePath)) {
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

// Returns false once the request deadline trips while validating this commit's paths, so the
// caller can discard the lane instead of keeping what happened to be validated first.
function collectCommitFileHistory(
  byPath: Map<string, FileHistoryStats>,
  rawPaths: readonly string[],
  timestamp: number,
  repo: GitRepositoryForHistory,
  inputs: GitFileHistoryEvidenceInputs,
): boolean {
  const seenInCommit = new Set<string>();
  for (const rawPath of rawPaths) {
    throwIfCancelled(inputs.signal);
    if (gitHistoryDeadlineReached(inputs)) {
      return false;
    }
    const scopePath = scopePathForHistoryLine(rawPath, repo, inputs);
    if (scopePath === undefined || seenInCommit.has(scopePath)) {
      continue;
    }
    seenInCommit.add(scopePath);
    recordFileHistory(byPath, scopePath, timestamp);
  }
  return true;
}

/**
 * Parses the bounded `git log --name-only` output into per-file stats, or returns the stopped
 * sentinel `undefined` when the request deadline trips anywhere inside parsing.
 *
 * Stopping is deliberately terminal for the whole lane rather than a loop `break`. Path validation
 * performs metadata I/O, so the deadline can expire between two records — or inside the `stat` that
 * admitted the last path. Returning the partially built map would hand ranking a set whose
 * membership depends on where the clock ran out, and those atoms would then be emitted after the
 * request deadline: exactly the outcome the all-or-empty post-subprocess check in the provider
 * below exists to prevent. Discarding the lane keeps both paths on one rule.
 */
function parseGitHistoryStats(
  stdout: string,
  repo: GitRepositoryForHistory,
  inputs: GitFileHistoryEvidenceInputs,
): readonly FileHistoryStats[] | undefined {
  const byPath = new Map<string, FileHistoryStats>();
  for (const record of stdout.split(GIT_HISTORY_RECORD_SEP)) {
    throwIfCancelled(inputs.signal);
    if (gitHistoryDeadlineReached(inputs)) {
      return undefined;
    }
    if (record.length === 0) {
      continue;
    }
    const lines = record.split("\n");
    const timestamp = recordTimestamp(lines);
    if (timestamp === undefined) {
      continue;
    }
    if (!collectCommitFileHistory(byPath, lines.slice(1), timestamp, repo, inputs)) {
      return undefined;
    }
  }
  // The final record's last path validation can expire the clock with no later iteration left to
  // observe it, so the lane is re-checked once after the loop.
  return gitHistoryDeadlineReached(inputs) ? undefined : [...byPath.values()];
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

async function readGitHistoryResult(
  inputs: GitFileHistoryEvidenceInputs,
  runner: GitProcessRunner,
  repo: GitRepositoryForHistory,
): Promise<GitProcessResult | undefined> {
  if (remainingGitHistoryTimeMs(inputs) <= 0) return undefined;
  return runGitHistoryStage(inputs, ({ signal, timeoutMs }) =>
    runner(gitHistoryArgs(repo.repositoryRoot, repo.selectedRootPrefix), {
      cwd: repo.repositoryRoot,
      maxBytes: GIT_HISTORY_MAX_BYTES,
      timeoutMs,
      abortSignal: signal,
    }),
  );
}

function rankedHistoryAtoms(
  inputs: GitFileHistoryEvidenceInputs,
  repo: GitRepositoryForHistory,
  stdout: string,
): readonly EvidenceAtom[] {
  const stats = parseGitHistoryStats(stdout, repo, inputs);
  // `undefined` is the stopped sentinel: the deadline tripped during parsing, so there is no
  // ranking to do — the lane is discarded whole rather than emitted from a partial map.
  if (stats === undefined || stats.length === 0) return [];
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
}

export const defaultGitFileHistoryEvidenceProvider: GitFileHistoryEvidenceProvider = async (
  inputs,
) => {
  const boundedInputs = boundedGitHistoryInputs(inputs);
  // Both git reads below — the membership resolution inside `resolveGitRepositoryForHistory` and
  // the history read itself — answer a failure by returning no evidence. That is the right ANSWER
  // (a grounded pack degrades rather than fails), but on its own it left no trace at all: an ask
  // whose git-history ring silently went empty was indistinguishable in the log from one where the
  // repository simply had no matching history. Observing the runner reports both without either
  // call site opting in, and reuses the routes' own helper rather than growing a second mechanism
  // (AGENTS.md §5, §8 Rule 1).
  const runner = observedGitRunner(
    boundedInputs.runner ?? defaultGitProcessRunner,
    boundedInputs.activityLog ?? processServerLogSink(),
    boundedInputs.correlationId,
  );
  throwIfCancelled(boundedInputs.signal);
  if (remainingGitHistoryTimeMs(boundedInputs) <= 0) return [];
  const repo = await resolveGitRepositoryForHistory(boundedInputs, runner);
  if (repo === undefined) return [];
  throwIfCancelled(boundedInputs.signal);
  const result = await readGitHistoryResult(boundedInputs, runner, repo);
  if (result?.exitCode !== 0) return [];
  throwIfCancelled(boundedInputs.signal);
  // A completed subprocess does not widen the request's absolute deadline. Ranking and evidence
  // emission after the deadline would make the outcome depend on event-loop timer ordering.
  if (gitHistoryDeadlineReached(boundedInputs)) return [];
  return rankedHistoryAtoms(boundedInputs, repo, result.stdout);
};
