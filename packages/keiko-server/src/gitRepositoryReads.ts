// Read-only Git repository summary / history / remotes BFF (Issue #1573, Epic #1572). Git execution
// stays server-side with fixed args/env, selected-root containment, unsafe-owner surfacing, and
// bounded output. Reuses the hardened runner + containment from gitRoutes.ts and the shared
// porcelain-v2 parser; every response body is content-free (counts, typed codes, branch/remote
// names, ISO dates) and passes through `deps.redactor`.

import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
  GitHistoryEntry,
  GitHistoryResponse,
  GitLastSyncMetadata,
  GitRemoteSummary,
  GitRepositorySummary,
  GitRemotesResponse,
  GitRepositoryState,
  GitRepositoryStatusResponse,
  GitUnavailableReason,
} from "@oscharko-dev/keiko-contracts";
import {
  GIT_HISTORY_SCHEMA_VERSION,
  GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts";
import {
  classifyFailure,
  optionsWithDefaults,
  resolveRepository,
  type GitProcessResult,
  type GitRouteOptions,
  type NormalizedGitRouteOptions,
  type RepositoryContext,
} from "./gitRoutes.js";
import { containsPath } from "@oscharko-dev/keiko-git";
import { parsePorcelainV2Branch } from "./gitPorcelainStatus.js";
import { FilesError, runFilesHandler } from "./files.js";
import type { RouteContext, RouteResult } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";

type UnavailableReason = GitUnavailableReason | "unsafe-repository" | "git-error";

const HISTORY_RECORD_SEP = "\x1e";
const HISTORY_FIELD_SEP = "\x1f";
const HISTORY_PRETTY_FORMAT = `format:${HISTORY_RECORD_SEP}%H${HISTORY_FIELD_SEP}%h${HISTORY_FIELD_SEP}%P${HISTORY_FIELD_SEP}%an${HISTORY_FIELD_SEP}%aI${HISTORY_FIELD_SEP}%D${HISTORY_FIELD_SEP}%s`;
const HISTORY_LIMIT_DEFAULT = 50;
const HISTORY_LIMIT_MAX = 200;
const HISTORY_SKIP_MAX = 100_000;
const GIT_SUMMARY_CACHE_TTL_MS = 2_000;

interface GitSummaryCacheEntry {
  readonly expiresAt: number;
  readonly value: Promise<RouteResult>;
}

const gitSummaryCache = new WeakMap<UiHandlerDeps, Map<string, GitSummaryCacheEntry>>();
const gitRunnerCacheIds = new WeakMap<NormalizedGitRouteOptions["runner"], number>();
let nextGitRunnerCacheId = 1;

function gitRunnerCacheId(runner: NormalizedGitRouteOptions["runner"]): number {
  const existing = gitRunnerCacheIds.get(runner);
  if (existing !== undefined) return existing;
  const id = nextGitRunnerCacheId;
  nextGitRunnerCacheId += 1;
  gitRunnerCacheIds.set(runner, id);
  return id;
}

function gitSummaryCacheKey(ctx: RouteContext, options: NormalizedGitRouteOptions): string {
  return JSON.stringify({
    root: ctx.url.searchParams.get("root") ?? "",
    runner: gitRunnerCacheId(options.runner),
    maxStatusBytes: options.maxStatusBytes,
    timeoutMs: options.timeoutMs,
  });
}

function cachedGitSummary(deps: UiHandlerDeps, key: string): GitSummaryCacheEntry | undefined {
  const byKey = gitSummaryCache.get(deps);
  const cached = byKey?.get(key);
  if (cached === undefined) return undefined;
  if (cached.expiresAt > Date.now()) return cached;
  byKey?.delete(key);
  return undefined;
}

function storeGitSummary(deps: UiHandlerDeps, key: string, value: Promise<RouteResult>): void {
  const byKey = gitSummaryCache.get(deps) ?? new Map<string, GitSummaryCacheEntry>();
  byKey.set(key, { expiresAt: Date.now() + GIT_SUMMARY_CACHE_TTL_MS, value });
  gitSummaryCache.set(deps, byKey);
}

function redacted<T>(deps: UiHandlerDeps, value: T): T {
  return deps.redactor(value) as T;
}

function unavailableState(reason: UnavailableReason): GitRepositoryState {
  return reason === "unsafe-repository" ? "unsafe" : "unavailable";
}

function isUnavailable(
  repo: RepositoryContext | GitRepositoryStatusResponse,
): repo is GitRepositoryStatusResponse {
  return "available" in repo;
}

// --- remotes ----------------------------------------------------------------

// `git remote -v` emits `name\turl (fetch|push)` lines; fetch/push URLs are deduplicated by name.
export function parseRemotes(stdout: string): readonly GitRemoteSummary[] {
  const byName = new Map<string, { name: string; fetchUrl?: string; pushUrl?: string }>();
  const order: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^(\S+)\t(.+?)\s+\((fetch|push)\)$/u.exec(line.trim());
    if (match === null) continue;
    const [, name, url, kind] = match;
    if (name === undefined || url === undefined) continue;
    if (!byName.has(name)) {
      byName.set(name, { name });
      order.push(name);
    }
    const entry = byName.get(name);
    if (entry === undefined) continue;
    if (kind === "fetch") entry.fetchUrl = url;
    else entry.pushUrl = url;
  }
  return order.map((name) => {
    const entry = byName.get(name) ?? { name };
    return { name: entry.name, fetchUrl: entry.fetchUrl, pushUrl: entry.pushUrl };
  });
}

function runGit(
  repo: RepositoryContext,
  options: NormalizedGitRouteOptions,
  args: readonly string[],
): Promise<GitProcessResult> {
  return options.runner(["--no-pager", "--no-optional-locks", "-C", repo.repositoryRoot, ...args], {
    cwd: repo.repositoryRoot,
    maxBytes: options.maxStatusBytes,
    timeoutMs: options.timeoutMs,
  });
}

// --- last sync (FETCH_HEAD mtime) -------------------------------------------

async function readLastSync(
  repo: RepositoryContext,
  options: NormalizedGitRouteOptions,
): Promise<GitLastSyncMetadata | undefined> {
  try {
    const result = await runGit(repo, options, ["rev-parse", "--git-path", "FETCH_HEAD"]);
    if (result.exitCode !== 0) return undefined;
    const rawPath = result.stdout.split(/\r?\n/u)[0]?.trim();
    if (rawPath === undefined || rawPath.length === 0) return undefined;
    // Defence-in-depth: `--git-path` resolves relative to the repository root, but verify the
    // resolved path is contained under it before stat-ing so a manipulated rev-parse result can
    // never stat an out-of-tree file. Containment failure ⇒ omit lastSync (metadata stays optional).
    const path = isAbsolute(rawPath) ? rawPath : resolve(repo.repositoryRoot, rawPath);
    if (!containsPath(repo.repositoryRoot, path)) return undefined;
    const info = await stat(path);
    return { lastFetchAtMs: Math.round(info.mtimeMs) };
  } catch {
    return undefined;
  }
}

// --- summary ----------------------------------------------------------------

// `GitRemotesResponse` IS the shared unavailable envelope head; the summary spreads it and adds the
// zeroed status fields, so both responses stay byte-identical for the common fields.
function unavailableRemotes(
  root: string,
  repositoryRoot: string | undefined,
  reason: UnavailableReason | undefined,
): GitRemotesResponse {
  return {
    schemaVersion: GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION,
    root,
    repositoryRoot,
    state: reason === undefined ? "unavailable" : unavailableState(reason),
    available: false,
    reason,
    remotes: [],
    truncated: false,
  };
}

function unavailableSummary(
  root: string,
  repositoryRoot: string | undefined,
  reason: UnavailableReason | undefined,
): GitRepositorySummary {
  return {
    ...unavailableRemotes(root, repositoryRoot, reason),
    detached: false,
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    clean: true,
  };
}

function buildSummary(
  repo: RepositoryContext,
  status: GitProcessResult,
  remotes: readonly GitRemoteSummary[],
  lastSync: GitLastSyncMetadata | undefined,
): GitRepositorySummary {
  const parsed = parsePorcelainV2Branch(status.stdout);
  const remoteAliases = remotes.map((remote) => ({ name: remote.name }));
  return {
    schemaVersion: GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION,
    root: repo.root,
    repositoryRoot: repo.repositoryRoot,
    state: "available",
    available: true,
    branch: parsed.branch,
    detached: parsed.detached,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    stagedCount: parsed.stagedCount,
    unstagedCount: parsed.unstagedCount,
    untrackedCount: parsed.untrackedCount,
    conflictedCount: parsed.conflictedCount,
    clean: !parsed.dirty,
    remotes: remoteAliases,
    lastSync,
    truncated: status.truncated,
  };
}

export async function handleGitSummary(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  rawOptions?: GitRouteOptions,
): Promise<RouteResult> {
  return runFilesHandler(async () => {
    const options = optionsWithDefaults(rawOptions ?? deps.gitRouteOptions);
    const cacheKey = gitSummaryCacheKey(ctx, options);
    const cached = cachedGitSummary(deps, cacheKey);
    if (cached !== undefined) return cached.value;
    const value = computeGitSummary(ctx, deps, options).catch((error: unknown) => {
      gitSummaryCache.get(deps)?.delete(cacheKey);
      throw error;
    });
    storeGitSummary(deps, cacheKey, value);
    return value;
  });
}

async function computeGitSummary(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: NormalizedGitRouteOptions,
): Promise<RouteResult> {
  const repo = await resolveRepository(ctx, deps, options);
  if (isUnavailable(repo)) {
    const body = unavailableSummary(repo.root, repo.repositoryRoot, repo.reason);
    return { status: 200, body: redacted(deps, body) };
  }
  const [status, remotesResult, lastSync] = await Promise.all([
    runGit(repo, options, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]),
    runGit(repo, options, ["remote", "-v"]),
    readLastSync(repo, options),
  ]);
  if (status.exitCode !== 0) {
    const reason = classifyFailure(status);
    return {
      status: 200,
      body: redacted(deps, unavailableSummary(repo.root, repo.repositoryRoot, reason)),
    };
  }
  const remotes = remotesResult.exitCode === 0 ? parseRemotes(remotesResult.stdout) : [];
  return { status: 200, body: redacted(deps, buildSummary(repo, status, remotes, lastSync)) };
}

// --- remotes route ----------------------------------------------------------

export async function handleGitRemotes(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  rawOptions?: GitRouteOptions,
): Promise<RouteResult> {
  return runFilesHandler(async () => {
    const options = optionsWithDefaults(rawOptions ?? deps.gitRouteOptions);
    const repo = await resolveRepository(ctx, deps, options);
    if (isUnavailable(repo)) {
      const body = unavailableRemotes(repo.root, repo.repositoryRoot, repo.reason);
      return { status: 200, body: redacted(deps, body) };
    }
    const result = await runGit(repo, options, ["remote", "-v"]);
    if (result.exitCode !== 0) {
      const reason = classifyFailure(result);
      const body = unavailableRemotes(repo.root, repo.repositoryRoot, reason);
      return { status: 200, body: redacted(deps, { ...body, truncated: result.truncated }) };
    }
    return {
      status: 200,
      body: redacted(deps, {
        schemaVersion: GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION,
        root: repo.root,
        repositoryRoot: repo.repositoryRoot,
        state: "available",
        available: true,
        remotes: parseRemotes(result.stdout),
        truncated: result.truncated,
      } satisfies GitRemotesResponse),
    };
  });
}

// --- history ----------------------------------------------------------------

function parseInteger(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim().length === 0) return fallback;
  if (!/^-?\d+$/u.test(raw.trim())) {
    throw new FilesError(400, "BAD_REQUEST", "The limit and skip parameters must be integers.");
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// The `--shortstat` summary line carries "N files changed"; merge/empty commits omit it (⇒ 0).
function parseChangedFileCount(remainder: string): number {
  const match = /(\d+)\s+files?\s+changed/u.exec(remainder);
  return match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
}

function parseHistoryEntry(record: string): GitHistoryEntry | undefined {
  const newline = record.indexOf("\n");
  const head = newline === -1 ? record : record.slice(0, newline);
  const remainder = newline === -1 ? "" : record.slice(newline + 1);
  const fields = head.split(HISTORY_FIELD_SEP);
  const [sha, shortSha, parents, author, date, refs] = fields;
  if (sha === undefined || shortSha === undefined || sha.length === 0) return undefined;
  const subject = fields.slice(6).join(HISTORY_FIELD_SEP);
  return {
    sha,
    shortSha,
    subject,
    author: author ?? "",
    date: date ?? "",
    refs: (refs ?? "")
      .split(", ")
      .map((ref) => ref.trim())
      .filter((ref) => ref.length > 0),
    parentCount: (parents ?? "").split(/\s+/u).filter((entry) => entry.length > 0).length,
    changedFileCount: parseChangedFileCount(remainder),
  };
}

export function parseHistory(stdout: string): readonly GitHistoryEntry[] {
  return stdout
    .split(HISTORY_RECORD_SEP)
    .filter((record) => record.length > 0)
    .map(parseHistoryEntry)
    .filter((entry): entry is GitHistoryEntry => entry !== undefined);
}

// An empty repository (no commits yet) makes `git log` exit non-zero; treat that as empty history.
function isEmptyRepository(result: GitProcessResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    text.includes("does not have any commits yet") ||
    text.includes("bad default revision 'head'") ||
    text.includes("bad revision 'head'")
  );
}

function unavailableHistory(
  root: string,
  repositoryRoot: string | undefined,
  reason: UnavailableReason | undefined,
  limit: number,
  skip: number,
): GitHistoryResponse {
  return {
    schemaVersion: GIT_HISTORY_SCHEMA_VERSION,
    root,
    repositoryRoot,
    state: reason === undefined ? "unavailable" : unavailableState(reason),
    available: false,
    reason,
    entries: [],
    limit,
    skip,
    truncated: false,
  };
}

function availableHistory(
  repo: RepositoryContext,
  entries: readonly GitHistoryEntry[],
  limit: number,
  skip: number,
  truncated: boolean,
): GitHistoryResponse {
  return {
    schemaVersion: GIT_HISTORY_SCHEMA_VERSION,
    root: repo.root,
    repositoryRoot: repo.repositoryRoot,
    state: "available",
    available: true,
    entries,
    limit,
    skip,
    truncated,
  };
}

function historyArgs(limit: number, skip: number): readonly string[] {
  return [
    "log",
    "--no-color",
    `--max-count=${String(limit)}`,
    `--skip=${String(skip)}`,
    `--pretty=${HISTORY_PRETTY_FORMAT}`,
    "--shortstat",
  ];
}

export async function handleGitHistory(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  rawOptions?: GitRouteOptions,
): Promise<RouteResult> {
  return runFilesHandler(async () => {
    const options = optionsWithDefaults(rawOptions ?? deps.gitRouteOptions);
    const limit = parseInteger(
      ctx.url.searchParams.get("limit"),
      HISTORY_LIMIT_DEFAULT,
      1,
      HISTORY_LIMIT_MAX,
    );
    const skip = parseInteger(ctx.url.searchParams.get("skip"), 0, 0, HISTORY_SKIP_MAX);
    const repo = await resolveRepository(ctx, deps, options);
    if (isUnavailable(repo)) {
      const body = unavailableHistory(repo.root, repo.repositoryRoot, repo.reason, limit, skip);
      return { status: 200, body: redacted(deps, body) };
    }
    const result = await runGit(repo, options, historyArgs(limit, skip));
    if (result.exitCode !== 0) {
      if (isEmptyRepository(result)) {
        return {
          status: 200,
          body: redacted(deps, availableHistory(repo, [], limit, skip, false)),
        };
      }
      const reason = classifyFailure(result);
      const body = unavailableHistory(repo.root, repo.repositoryRoot, reason, limit, skip);
      return { status: 200, body: redacted(deps, body) };
    }
    const entries = parseHistory(result.stdout);
    const truncated = result.truncated || entries.length === limit;
    const body = availableHistory(repo, entries, limit, skip, truncated);
    return { status: 200, body: redacted(deps, body) };
  });
}
