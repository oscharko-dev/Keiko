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
import { GIT_HISTORY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-history";
import { GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-repository-summary";
import {
  classifyFailure,
  optionsWithDefaults,
  resolveRepository,
  selectedRootPathspecArgs,
  type GitProcessResult,
  type GitRouteOptions,
  type NormalizedGitRouteOptions,
  type RepositoryContext,
} from "./gitRoutes.js";
import { containsPath, GIT_BASE_ARGS } from "@oscharko-dev/keiko-git";
import { parsePorcelainV2Branch } from "./gitPorcelainStatus.js";
import { isCapTerminatedTruncation, stderrHoldsOnlyGitWarnings } from "./gitProcessActivity.js";
import {
  logBoundedHistory,
  settleCapCutStatus,
  type BoundedStatusLog,
} from "./gitStatusBounded.js";
import { processServerLogSink } from "./process-log-sink.js";
import { FilesError, runFilesHandler } from "./files.js";
import type { RouteContext, RouteResult } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";

type UnavailableReason = GitUnavailableReason | "unsafe-repository" | "git-error";

// Header fields are NUL-separated: git never emits NUL inside an author, subject or ref, so no
// commit metadata can shift a field, and the same delimiter is what `-z` uses for paths.
const HISTORY_PRETTY_FORMAT = "format:%H%x00%h%x00%P%x00%an%x00%aI%x00%D%x00%s";
const HISTORY_LEADING_FIELDS = 6;
const HISTORY_LIMIT_DEFAULT = 50;
const HISTORY_LIMIT_MAX = 200;
const HISTORY_SKIP_MAX = 100_000;
const GIT_SUMMARY_CACHE_TTL_MS = 2_000;

interface GitSummaryCacheEntry {
  readonly expiresAt: number;
  readonly value: Promise<RouteResult>;
}

// Keyed on the request deps object; `object` so a mutation path holding a narrower view of the same
// deps can drop its entries (invalidateGitSummaryCache).
const gitSummaryCache = new WeakMap<object, Map<string, GitSummaryCacheEntry>>();
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

function gitSummaryCacheKey(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: NormalizedGitRouteOptions,
): string {
  // Issue #2640: partition the cache by app-session read authority. Without the sessionId leg an
  // unpaired caller within the TTL could read a summary populated by a paired one — the paired
  // projection is content-bearing, the unpaired one is content-free, so they must never share a
  // cache entry. Empty string is the deliberate namespace for "no session" and cannot collide
  // with a real session id (SESSION_ID_PATTERN in sessionRegistry.ts pins them to `sess_` + 24
  // hex).
  const session = resolveAppSessionReadAuthority(deps, ctx.req);
  return JSON.stringify({
    root: ctx.url.searchParams.get("root") ?? "",
    // `runnerIdentity`, never `runner`: the normalized `runner` is a per-request observation
    // wrapper (see NormalizedGitRouteOptions), so keying on it would mint a fresh cache key for
    // every request and turn this cache into a permanent miss. The identity that must partition
    // the cache is the UNDERLYING runner — which is what two tests with different fakes differ in.
    runner: gitRunnerCacheId(options.runnerIdentity),
    maxStatusBytes: options.maxStatusBytes,
    timeoutMs: options.timeoutMs,
    sessionId: session?.sessionId ?? "",
  });
}

// A cache hit runs no git, so it writes no `git.process.*` line — and must not: those lines report
// a PROCESS outcome, and the route tests pin that a request which never reaches the runner leaves
// none. Synthesising one for a replayed answer would say a git command failed when none ran.
//
// That would have left a real gap, because the cache stores FAILURE bodies too: a second request
// receiving a replayed `available: false` projection would have had no joinable cause anywhere in
// its own timeline. Rather than fake a line, `storeGitSummary` below drops an unavailable entry as
// soon as it resolves, so the next request recomputes and records its own failure under its own
// correlation id. The cache keeps doing its job for the healthy, high-frequency case it exists for.
function cachedGitSummary(deps: UiHandlerDeps, key: string): GitSummaryCacheEntry | undefined {
  const byKey = gitSummaryCache.get(deps);
  const cached = byKey?.get(key);
  if (cached === undefined) return undefined;
  if (cached.expiresAt > Date.now()) return cached;
  byKey?.delete(key);
  return undefined;
}

/**
 * Drops every cached summary of these deps. A finished Git action changes what a summary reports
 * (ahead/behind, branch, remote state); a summary cached before it would replay the pre-action
 * state for up to GIT_SUMMARY_CACHE_TTL_MS, and the Git window's refresh right after the action
 * would show it (#3644).
 */
export function invalidateGitSummaryCache(deps: object): void {
  gitSummaryCache.delete(deps);
}

function storeGitSummary(deps: UiHandlerDeps, key: string, value: Promise<RouteResult>): void {
  const byKey = gitSummaryCache.get(deps) ?? new Map<string, GitSummaryCacheEntry>();
  const now = Date.now();
  // Opportunistic sweep on write. Reads only expire the exact key they look up, so partitioning
  // the cache by session (issue #2640) — which multiplies key cardinality — would otherwise let
  // one-shot entries linger past their TTL until the deps instance dies. The sweep is bounded by
  // the current map size and only ever runs on the write path, so it stays proportional to real
  // traffic.
  for (const [existingKey, entry] of byKey) {
    if (entry.expiresAt <= now) byKey.delete(existingKey);
  }
  byKey.set(key, { expiresAt: now + GIT_SUMMARY_CACHE_TTL_MS, value });
  gitSummaryCache.set(deps, byKey);
  // An UNAVAILABLE answer is evicted the moment it resolves. Replaying one would serve a later
  // request a failure projection whose cause lives on an earlier request's timeline, under an
  // earlier correlation id — unreconstructible from that request's own line (AGENTS.md §8 Rule 1).
  // Recomputing instead costs one bounded git read on a repository that is already failing, and
  // only for the request that actually asks; the healthy path this cache exists for is untouched.
  // Best-effort: a rejected promise is left to the existing catch in `handleGitSummary`.
  //
  // WHY THIS IS RACE-FREE FOR A GENUINELY LATER REQUEST: the eviction `.then()` below is the
  // FIRST reaction registered on `value` (attached synchronously here, before `handleGitSummary`
  // returns it to its own caller), so when `value` settles, Node drains every microtask reaction
  // on it — this one included — before the event loop proceeds to its next macrotask. A later,
  // genuinely separate HTTP request is processed as a macrotask, so it can never observe the Map
  // between "value settled" and "this callback ran": those are the same turn of the event loop.
  // Verified empirically (a controlled resolve + `setImmediate` probe), not asserted from theory.
  //
  // WHAT THIS DOES NOT COVER: two requests that are ALREADY concurrent when the first one misses
  // the cache share the SAME in-flight promise by design — that is the cache's actual job, and
  // running the same git command twice for two requests 5ms apart would be worse. Both receive an
  // ACCURATE (never stale) response, but only one `git.process.failed` line exists, stamped with
  // whichever request's correlation id started the computation. That is not a replay of a stale
  // entry; it is one real git run two requests legitimately shared. See the pinned test below.
  void value
    .then((result) => {
      if (!isUnavailableSummaryBody(result.body)) return;
      if (gitSummaryCache.get(deps)?.get(key)?.value === value) byKey.delete(key);
    })
    .catch(() => undefined);
}

// The content-free unavailable projection every failing read path in this module returns.
function isUnavailableSummaryBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "available" in body &&
    (body as { readonly available?: unknown }).available === false
  );
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

// The `(fetch)`/`(push)` marker is a fixed literal at the very end of the line, so `endsWith` finds
// it in constant time; walking backwards over the remaining whitespace with plain character checks
// finds the URL/separator split without ever re-scanning a run more than once. A single
// `(\S+)\t(.+?)\s+\(...\)$` regex — or even an isolated `\s+\(...\)$` search — is unanchored at the
// front, so a long non-matching run forces the engine to retry the same O(n) backtrack at every
// position in that run: O(n^2) overall (S8786).
const REMOTE_LINE_KIND_SUFFIXES: readonly { kind: "fetch" | "push"; suffix: string }[] = [
  { kind: "fetch", suffix: "(fetch)" },
  { kind: "push", suffix: "(push)" },
];

function isWhitespaceChar(char: string): boolean {
  return /\s/u.test(char);
}

// The URL/separator boundary within `beforeSuffix` (everything between the tab and the fixed
// `(fetch)`/`(push)` marker): walk back over trailing whitespace, then fall back to a 1-character
// URL when the whole gap turned out to be whitespace (`.+?` still needs at least one character).
function remoteUrlEnd(beforeSuffix: string): number {
  let separatorStart = beforeSuffix.length;
  while (separatorStart > 0 && isWhitespaceChar(beforeSuffix[separatorStart - 1] ?? "")) {
    separatorStart -= 1;
  }
  return separatorStart === 0 && beforeSuffix.length >= 2 ? 1 : separatorStart;
}

function parseRemoteLine(
  line: string,
): { name: string; url: string; kind: "fetch" | "push" } | undefined {
  const tabIndex = line.indexOf("\t");
  if (tabIndex <= 0) return undefined;
  const name = line.slice(0, tabIndex);
  if (/\s/u.test(name)) return undefined;
  const rest = line.slice(tabIndex + 1);
  const suffix = REMOTE_LINE_KIND_SUFFIXES.find((candidate) => rest.endsWith(candidate.suffix));
  if (suffix === undefined) return undefined;
  const beforeSuffix = rest.slice(0, rest.length - suffix.suffix.length);
  const urlEnd = remoteUrlEnd(beforeSuffix);
  if (urlEnd === 0 || urlEnd === beforeSuffix.length) return undefined;
  return { name, url: beforeSuffix.slice(0, urlEnd), kind: suffix.kind };
}

// `git remote -v` emits `name\turl (fetch|push)` lines; fetch/push URLs are deduplicated by name.
export function parseRemotes(stdout: string): readonly GitRemoteSummary[] {
  const byName = new Map<string, { name: string; fetchUrl?: string; pushUrl?: string }>();
  const order: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const parsed = parseRemoteLine(line.trim());
    if (parsed === undefined) continue;
    const { name, url, kind } = parsed;
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
  expectedTruncation = false,
): Promise<GitProcessResult> {
  return options.runner([...GIT_BASE_ARGS, "-C", repo.repositoryRoot, ...args], {
    cwd: repo.repositoryRoot,
    maxBytes: options.maxStatusBytes,
    timeoutMs: options.timeoutMs,
    ...(expectedTruncation ? { expectedTruncation: true } : {}),
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
    const lastFetchAtMs = Math.round(info.mtimeMs);
    // Codex P2 (thread 3788736980): a pre-epoch mtime (a restored archive, or `touch -d
    // 1960-01-01`) makes Node report a NEGATIVE mtimeMs, which Math.round preserves -- and the
    // wire contract declares lastFetchAtMs a non-negative integer
    // (git-repository-summary.ts's isGitLastSyncMetadata, pinned by its own test asserting
    // lastFetchAtMs: -1 is rejected). Reconciled on the producer side, not by loosening that
    // validator: a pre-epoch mtime is a filesystem artifact, not a meaningful "last synced at"
    // signal, so it is omitted here the same way every other "cannot determine" case above is,
    // rather than forwarding a value the contract then fails a legitimate local repository on.
    if (lastFetchAtMs < 0) return undefined;
    return { lastFetchAtMs };
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
    // A cut status proves at least the records it shows; an unseen remainder is not "clean".
    clean: !parsed.dirty && !status.truncated,
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
    const options = optionsWithDefaults(rawOptions ?? deps.gitRouteOptions, ctx.correlationId);
    const cacheKey = gitSummaryCacheKey(ctx, deps, options);
    const cached = cachedGitSummary(deps, cacheKey);
    if (cached !== undefined) return cached.value;
    const value = computeGitSummary(ctx, deps, options, {
      sink: (rawOptions ?? deps.gitRouteOptions)?.activityLog ?? processServerLogSink(),
      correlationId: ctx.correlationId,
    }).catch((error: unknown) => {
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
  log: BoundedStatusLog,
): Promise<RouteResult> {
  const repo = await resolveRepository(ctx, deps, options);
  if (isUnavailable(repo)) {
    const body = unavailableSummary(repo.root, repo.repositoryRoot, repo.reason);
    return { status: 200, body: redacted(deps, body) };
  }
  const [statusRun, remotesResult, lastSync] = await Promise.all([
    runGit(
      repo,
      options,
      ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
      true,
    ),
    runGit(repo, options, ["remote", "-v"]),
    readLastSync(repo, options),
  ]);
  // A cap-terminated status is a bounded, truncated summary, not an unavailable repository (#4113).
  const status = settleCapCutStatus(statusRun, {
    format: "v2",
    surface: "summary",
    maxBytes: options.maxStatusBytes,
    log,
  });
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
    const options = optionsWithDefaults(rawOptions ?? deps.gitRouteOptions, ctx.correlationId);
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

// `changedFileCount` is the number of paths `git log --name-only -z` lists for a commit: the same
// "N files changed" figure `--shortstat` reports for a commit (a rename is listed once, a merge lists
// none), but without reading and diffing every blob to count inserted and deleted lines, which made
// the page take seconds on a large repository.
//
// ASSUMED `-z` LAYOUT, per commit (the format puts NUL between header fields, the subject last):
//   <f1> NUL <f2> NUL ... NUL <subject> "\n" (<path> NUL)+ NUL      when the commit lists paths
//   <f1> NUL <f2> NUL ... NUL <subject> NUL                         when it lists none (a merge, an
//                                                                   empty commit)
// Split on NUL, a record is exactly six leading header tokens, then a seventh token holding the
// subject (a path-listing commit carries its FIRST path after the subject's "\n"), then one token per
// further path, then an empty token ending a path-listing commit. Header tokens are consumed by
// COUNT, so an empty ref or parent list is just an empty token, and a path (never empty, never
// holding NUL) can only be read where a path-listing header has just ended. A record boundary is
// therefore recognised only where a path cannot start: file names holding separators, newlines or a
// forged header can never create or split a record, and no header field can shift another.
interface HistoryRecord {
  readonly fields: readonly string[];
  readonly count: number;
  readonly tail: string;
}

interface HistoryScan {
  readonly records: HistoryRecord[];
  leading: string[];
  open: { fields: readonly string[]; count: number; tail: string } | undefined;
}

// Reads the token that closes a record's leading header: the subject, and a path-listing commit's
// first path after the subject's newline.
function openHistoryRecord(scan: HistoryScan, token: string): void {
  const newline = token.indexOf("\n");
  const subject = newline === -1 ? token : token.slice(0, newline);
  const tail = newline === -1 ? "" : token.slice(newline + 1);
  const fields = [...scan.leading, subject];
  scan.leading = [];
  if (tail.length === 0) scan.records.push({ fields, count: 0, tail });
  else scan.open = { fields, count: 1, tail };
}

function scanHistoryToken(scan: HistoryScan, token: string): void {
  if (scan.open !== undefined) {
    if (token.length > 0) {
      scan.open.count += 1;
      return;
    }
    scan.records.push(scan.open);
    scan.open = undefined;
  } else if (scan.leading.length < HISTORY_LEADING_FIELDS) {
    scan.leading.push(token);
  } else {
    openHistoryRecord(scan, token);
  }
}

function historyRecords(stdout: string): readonly HistoryRecord[] {
  const scan: HistoryScan = { records: [], leading: [], open: undefined };
  for (const token of stdout.split("\0")) scanHistoryToken(scan, token);
  if (scan.open !== undefined) scan.records.push(scan.open);
  return scan.records;
}

// Only the single-commit fallback below still reads a `--shortstat` line ("N files changed"; merge
// and empty commits omit it, so 0). Digit/whitespace runs are bounded (S8786): an unbounded
// `\d+`/`\s+` pair is unanchored here, so a non-matching remainder with a long digit or whitespace
// run forces the engine to retry the same unbounded consume-then-backtrack at every position in that
// run, which is quadratic in the run length. A real file count and the single-space separators git
// emits both fit comfortably inside the bounds.
function parseChangedFileCount(remainder: string): number {
  const match = /(\d{1,9})\s{1,8}files?\s{1,8}changed/u.exec(remainder);
  return match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
}

const HISTORY_SHA_PATTERN = /^[0-9a-f]{40,64}$/u;

function parseHistoryEntry(
  fields: readonly string[],
  changedFileCount: number,
): GitHistoryEntry | undefined {
  const [sha, shortSha, parents, author, date, refs, subject] = fields;
  if (sha === undefined || shortSha === undefined || !HISTORY_SHA_PATTERN.test(sha)) {
    return undefined;
  }
  return {
    sha,
    shortSha,
    subject: subject ?? "",
    author: author ?? "",
    date: date ?? "",
    refs: (refs ?? "")
      .split(", ")
      .map((ref) => ref.trim())
      .filter((ref) => ref.length > 0),
    parentCount: (parents ?? "").split(/\s+/u).filter((entry) => entry.length > 0).length,
    changedFileCount,
  };
}

/** The parsed entries, and whether every record in the stream could be read. */
interface HistoryPage {
  readonly entries: readonly GitHistoryEntry[];
  readonly complete: boolean;
  /** Records left unread from the first unreadable one on; 0 when `complete`. */
  readonly unreadableRecordCount: number;
}

// Entries stop at the FIRST record that cannot be read. Skipping it and returning the later ones
// would shorten the page without moving the continuation: the UI asks for the next page from
// `skip + entries.length`, so a commit would be shown twice. Stopping there keeps the continuation
// pointing exactly at the unreadable commit, and `complete: false` lets the caller say so.
function toPage(
  records: readonly HistoryRecord[],
  countOf: (record: HistoryRecord) => number,
): HistoryPage {
  const entries: GitHistoryEntry[] = [];
  for (const record of records) {
    const entry = parseHistoryEntry(record.fields, countOf(record));
    if (entry === undefined) {
      return { entries, complete: false, unreadableRecordCount: records.length - entries.length };
    }
    entries.push(entry);
  }
  return { entries, complete: true, unreadableRecordCount: 0 };
}

function parseHistoryPage(stdout: string, truncated: boolean): HistoryPage {
  const records = [...historyRecords(stdout)];
  // A read the byte cap ended may stop anywhere inside its last record, and a path list cut short
  // would be counted as if it were whole. That record is never returned: the page reports
  // `truncated` and the UI asks for the next page from the number of entries it received.
  if (truncated) records.pop();
  return toPage(records, (record) => record.count);
}

export function parseHistory(
  stdout: string,
  options: { readonly truncated?: boolean } = {},
): readonly GitHistoryEntry[] {
  return parseHistoryPage(stdout, options.truncated === true).entries;
}

// The `--shortstat` fallback reads ONE commit without `-z`: its tail is the blank line and summary.
function parseShortstatPage(stdout: string): HistoryPage {
  return toPage(historyRecords(stdout).slice(0, 1), (record) => parseChangedFileCount(record.tail));
}

export function parseShortstatHistory(stdout: string): readonly GitHistoryEntry[] {
  return parseShortstatPage(stdout).entries;
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

// History is a read OF THE SELECTED ROOT, exactly like status and diff: `git log` runs with `-C
// <repositoryRoot>`, so without a pathspec it answers for the whole repository and a user who
// selected a subfolder sees commits that never touched it. The selected-root pathspec is empty at
// the repository root, so that case keeps its existing unscoped arguments byte for byte.
// `--name-only` honours the same pathspec, so `changedFileCount` counts the files each commit
// changed INSIDE the selected root rather than across the repository.
// A page of 50 commits of a large repository lists well over the status cap in paths alone (about
// 590 KB measured on a 10,000-file clone), so history reads under a larger multiple of that cap; the
// bound stays, it just fits an ordinary page.
export const HISTORY_CAP_FACTOR = 16;
const HISTORY_NAME_ONLY_ARGS: readonly string[] = ["--name-only", "-z"];
const HISTORY_SHORTSTAT_ARGS: readonly string[] = ["--shortstat"];

function historyArgs(
  repo: RepositoryContext,
  limit: number,
  skip: number,
  countArgs: readonly string[] = HISTORY_NAME_ONLY_ARGS,
): readonly string[] {
  return [
    // A repo-local `i18n.logOutputEncoding` (UTF-16 would put NUL bytes inside every field) must not
    // change the bytes the parser reads.
    "-c",
    "i18n.logOutputEncoding=UTF-8",
    "log",
    "--no-color",
    // A repo-local `log.showSignature` would print verification lines ahead of each signed commit.
    "--no-show-signature",
    `--max-count=${String(limit)}`,
    `--skip=${String(skip)}`,
    `--pretty=${HISTORY_PRETTY_FORMAT}`,
    ...countArgs,
    ...selectedRootPathspecArgs(repo.selectedRootPrefix),
  ];
}

type HistoryRead =
  | { readonly kind: "failed"; readonly result: GitProcessResult }
  | { readonly kind: "unreadable" }
  | { readonly kind: "page"; readonly entries: readonly GitHistoryEntry[]; readonly cut: boolean };

// The byte cap ending the read is a bounded page, not a failure: the path lists of a very large
// commit can outgrow it.
function isBoundedHistoryCut(result: GitProcessResult): boolean {
  return (
    isCapTerminatedTruncation(result) &&
    result.refusal === undefined &&
    stderrHoldsOnlyGitWarnings(result.stderr)
  );
}

function noteEarlyHistoryEnd(
  log: BoundedStatusLog,
  page: HistoryPage,
  cut: boolean,
  maxBytes: number,
): void {
  if (!cut && page.complete) return;
  logBoundedHistory(log, {
    shownRecordCount: page.entries.length,
    partialRecordDropped: cut,
    unreadableRecordCount: page.unreadableRecordCount,
    maxBytes,
  });
}

async function readHistoryPage(
  repo: RepositoryContext,
  routeOptions: NormalizedGitRouteOptions,
  limit: number,
  skip: number,
  log: BoundedStatusLog,
): Promise<HistoryRead> {
  const options = {
    ...routeOptions,
    maxStatusBytes: routeOptions.maxStatusBytes * HISTORY_CAP_FACTOR,
  };
  const result = await runGit(repo, options, historyArgs(repo, limit, skip), true);
  const cut = isBoundedHistoryCut(result);
  if (result.exitCode !== 0 && !cut) return { kind: "failed", result };
  const page = parseHistoryPage(result.stdout, cut);
  noteEarlyHistoryEnd(log, page, cut, options.maxStatusBytes);
  // An unreadable record ends the page early: it is reported truncated, never skipped.
  if (page.entries.length > 0)
    return { kind: "page", entries: page.entries, cut: cut || !page.complete };
  if (!cut)
    return page.complete ? { kind: "page", entries: [], cut: false } : { kind: "unreadable" };
  // The first commit alone outgrew the cap. Its file count is still owed, so read just that commit
  // with `--shortstat`, whose output is one short line however many files it names.
  const single = await runGit(repo, options, historyArgs(repo, 1, skip, HISTORY_SHORTSTAT_ARGS));
  if (single.exitCode !== 0) return { kind: "failed", result: single };
  const first = parseShortstatPage(single.stdout);
  if (!first.complete) return { kind: "unreadable" };
  return { kind: "page", entries: first.entries, cut: true };
}

export async function handleGitHistory(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  rawOptions?: GitRouteOptions,
): Promise<RouteResult> {
  return runFilesHandler(async () => {
    const options = optionsWithDefaults(rawOptions ?? deps.gitRouteOptions, ctx.correlationId);
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
    const log = {
      sink: (rawOptions ?? deps.gitRouteOptions)?.activityLog ?? processServerLogSink(),
      correlationId: ctx.correlationId,
    };
    const read = await readHistoryPage(repo, options, limit, skip, log);
    if (read.kind === "failed") {
      if (isEmptyRepository(read.result)) {
        return {
          status: 200,
          body: redacted(deps, availableHistory(repo, [], limit, skip, false)),
        };
      }
      const reason = classifyFailure(read.result);
      const body = unavailableHistory(repo.root, repo.repositoryRoot, reason, limit, skip);
      return { status: 200, body: redacted(deps, body) };
    }
    if (read.kind === "unreadable") {
      const body = unavailableHistory(repo.root, repo.repositoryRoot, undefined, limit, skip);
      return { status: 200, body: redacted(deps, body) };
    }
    const truncated = read.cut || read.entries.length === limit;
    const body = availableHistory(repo, read.entries, limit, skip, truncated);
    return { status: 200, body: redacted(deps, body) };
  });
}
