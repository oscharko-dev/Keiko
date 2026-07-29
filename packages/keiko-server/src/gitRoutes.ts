import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type {
  GitChangedFile,
  GitDiffScope,
  GitEditorBlameRequest,
  GitEditorBlameResponse,
  GitEditorDiffResponse,
  GitEditorDiffScope,
  GitRepositoryDiffResponse,
  GitRepositoryStatusResponse,
  GitStatusCode,
} from "@oscharko-dev/keiko-contracts";
import {
  GIT_EDITOR_BLAME_MAX_BYTES,
  GIT_EDITOR_BLAME_MAX_LINES,
  GIT_EDITOR_DIFF_MAX_BYTES,
  GIT_EDITOR_DIFF_MAX_FILES,
  GIT_EDITOR_SCHEMA_VERSION,
  GIT_REPOSITORY_SCHEMA_VERSION,
  isRootRelativeFileIdentifier,
  parseGitEditorBlameRequest,
} from "@oscharko-dev/keiko-contracts";
import {
  classifyGitFailure,
  containsPath,
  defaultGitProcessRunner,
  resolveGitMembership,
  type GitProcessOptions,
  type GitProcessResult,
  type GitProcessRunner,
} from "@oscharko-dev/keiko-git";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSummary,
} from "./diagnostics-log.js";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";
import {
  FilesError,
  metadataIsSafe,
  requiresManagedRootAuthority,
  resolveRequestRoot,
  runFilesHandler,
} from "./files.js";
import { DENIED_MESSAGE } from "./files-deny.js";
import { parseGitBlamePorcelain } from "./gitBlameParser.js";
import { parseGitEditorUnifiedDiff } from "./gitDiffParser.js";

// The git core moved to @oscharko-dev/keiko-git (shared with keiko-tools). Route modules and
// their tests keep importing the process surface from here so the BFF has one seam for it.
export {
  createGitProcessRunner,
  defaultGitNetworkProcessRunner,
  defaultGitProcessRunner,
  gitEnv,
  networkGitEnv,
} from "@oscharko-dev/keiko-git";
export type {
  GitProcessOptions,
  GitProcessResult,
  GitProcessRunner,
} from "@oscharko-dev/keiko-git";

const DEFAULT_STATUS_MAX_BYTES = 512 * 1024;
const DEFAULT_DIFF_MAX_BYTES = 128 * 1024;
const DEFAULT_MAX_CHANGES = 500;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface GitRouteOptions {
  readonly runner?: GitProcessRunner | undefined;
  readonly maxStatusBytes?: number | undefined;
  readonly maxDiffBytes?: number | undefined;
  readonly maxChanges?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  /** Optional deterministic observation seam for concurrent snapshot-read verification. */
  readonly snapshotReadObserver?: (() => Promise<void> | void) | undefined;
}

export interface NormalizedGitRouteOptions {
  readonly runner: GitProcessRunner;
  readonly maxStatusBytes: number;
  readonly maxDiffBytes: number;
  readonly maxChanges: number;
  readonly timeoutMs: number;
  readonly abortSignal?: AbortSignal | undefined;
  readonly snapshotReadObserver?: (() => Promise<void> | void) | undefined;
}

export interface RepositoryContext {
  readonly root: string;
  readonly realRoot: string;
  readonly repositoryRoot: string;
  readonly selectedRootPrefix: string;
}

export interface GitBranchListEntry {
  readonly name: string;
  readonly headRefHash: string;
  readonly current: boolean;
}

export interface GitBranchListResponse {
  readonly schemaVersion: typeof GIT_REPOSITORY_SCHEMA_VERSION;
  readonly root: string;
  readonly repositoryRoot?: string | undefined;
  readonly available: boolean;
  readonly state: "available" | "unavailable" | "unsafe";
  readonly reason?: GitRepositoryStatusResponse["reason"] | undefined;
  readonly message?: string | undefined;
  readonly branches: readonly GitBranchListEntry[];
  readonly truncated: boolean;
}

function genericUnavailable(
  root: string,
  reason: GitRepositoryStatusResponse["reason"],
  message?: string,
): GitRepositoryStatusResponse {
  return {
    schemaVersion: GIT_REPOSITORY_SCHEMA_VERSION,
    root,
    state: reason === "unsafe-repository" ? "unsafe" : "unavailable",
    available: false,
    reason,
    message,
    detached: false,
    clean: true,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    changes: [],
    truncated: false,
    maxChanges: DEFAULT_MAX_CHANGES,
  };
}

export function classifyFailure(result: GitProcessResult): GitRepositoryStatusResponse["reason"] {
  const reason = classifyGitFailure(result);
  // "timeout" is not part of the wire vocabulary; report it as the generic git error while the
  // precise classification stays available to server-side diagnostics via classifyGitFailure.
  return reason === "timeout" ? "git-error" : reason;
}

// eslint-disable-next-line complexity
export function optionsWithDefaults(
  options: GitRouteOptions | undefined,
): NormalizedGitRouteOptions {
  return {
    runner: options?.runner ?? defaultGitProcessRunner,
    maxStatusBytes: options?.maxStatusBytes ?? DEFAULT_STATUS_MAX_BYTES,
    maxDiffBytes: options?.maxDiffBytes ?? DEFAULT_DIFF_MAX_BYTES,
    maxChanges: options?.maxChanges ?? DEFAULT_MAX_CHANGES,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options?.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    ...(options?.snapshotReadObserver === undefined
      ? {}
      : { snapshotReadObserver: options.snapshotReadObserver }),
  };
}

/**
 * Purely lexical pre-check: does the RAW `root` query value name a path inside Keiko's managed
 * task-worktree root? No filesystem call, so it cannot itself leak existence. Returns false when no
 * managed root is composed or no root was requested — those fall through to the normal path.
 */
function requestsManagedRootAuthority(deps: UiHandlerDeps, requestedRoot: string | null): boolean {
  const managedRoot = deps.managedTaskWorkspaceRoot;
  if (managedRoot === undefined || requestedRoot === null || requestedRoot.length === 0) {
    return false;
  }
  return containsPath(resolve(managedRoot), resolve(requestedRoot));
}

function denyManagedRoot(): never {
  throw new FilesError(403, "DENIED", DENIED_MESSAGE);
}

async function resolveManagedCandidateDirectory(
  deps: UiHandlerDeps,
  requestedRoot: string,
): Promise<string> {
  if (!metadataIsSafe(requestedRoot, deps.redactor)) denyManagedRoot();
  let resolved: string;
  try {
    resolved = await realpath(requestedRoot);
    if (!(await stat(resolved)).isDirectory()) {
      throw new Error("managed Git root is not a directory");
    }
  } catch {
    throw new FilesError(400, "INVALID_DIRECTORY", "The directory does not exist.");
  }
  if (!metadataIsSafe(resolved, deps.redactor)) denyManagedRoot();
  return resolved;
}

/**
 * Admits a paired managed-worktree root spelling only after mapping its canonical target back to
 * the persisted WorkspaceInstance. This keeps trailing separators, dot segments, case aliases, and
 * repository subfolders usable without letting the `.keiko` deny-list become an authorization
 * bypass: the exact owning worktree still passes Files' managed-root identity gate first.
 */
async function resolveManagedRepositoryRequest(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  requestedRoot: string,
): Promise<{ readonly root: string; readonly realRoot: string }> {
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) denyManagedRoot();
  const managedRoot = deps.managedTaskWorkspaceRoot;
  if (managedRoot === undefined) denyManagedRoot();
  const realManagedRoot = await realpath(managedRoot).catch(() => denyManagedRoot());
  const realCandidate = await resolveManagedCandidateDirectory(deps, requestedRoot);
  if (!containsPath(realManagedRoot, realCandidate)) denyManagedRoot();
  const segments = relative(realManagedRoot, realCandidate)
    .split(/[\\/]/u)
    .filter((segment) => segment.length > 0);
  const repositoryId = segments[0];
  const workspaceId = segments[1];
  if (repositoryId === undefined || workspaceId === undefined) denyManagedRoot();
  const persistedRoot = await resolveRequestRoot(
    ctx,
    deps,
    join(managedRoot, repositoryId, workspaceId),
  );
  if (!containsPath(persistedRoot.realRoot, realCandidate)) denyManagedRoot();
  return { root: requestedRoot, realRoot: realCandidate };
}

async function resolveSelectedRepositoryRoot(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  requestedRoot: string | null,
): Promise<{ readonly root: string; readonly realRoot: string }> {
  if (requestsManagedRootAuthority(deps, requestedRoot)) {
    return resolveManagedRepositoryRequest(ctx, deps, requestedRoot ?? "");
  }
  return resolveRequestRoot(ctx, deps, requestedRoot, {
    managedRootAuthority: "defer-to-caller",
  });
}

async function isResolvedManagedRoot(
  managedRoot: string | undefined,
  resolvedTarget: string,
): Promise<boolean> {
  if (managedRoot === undefined) return false;
  const resolvedManagedRoot = await realpath(managedRoot).catch(() => resolve(managedRoot));
  return requiresManagedRootAuthority(resolvedManagedRoot, resolvedTarget);
}

async function lacksManagedRootReadAuthority(
  deps: UiHandlerDeps,
  ctx: RouteContext,
  resolvedTarget: string,
): Promise<boolean> {
  return (
    (await isResolvedManagedRoot(deps.managedTaskWorkspaceRoot, resolvedTarget)) &&
    resolveAppSessionReadAuthority(deps, ctx.req) === undefined
  );
}

export async function resolveRepository(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: NormalizedGitRouteOptions,
): Promise<RepositoryContext | GitRepositoryStatusResponse> {
  const requestedRoot = ctx.url.searchParams.get("root");
  // Classify the RAW input before touching the filesystem. `resolveRoot` throws for a missing or
  // invalid directory, so resolving first let an unpaired caller tell "exists under the managed
  // root" (content-free unavailable) from "does not exist" (a 400) — an existence oracle for
  // managed worktree paths, which is exactly what this gate exists to prevent. The post-realpath
  // check below stays as defence in depth for symlink and alias forms the raw prefix cannot see.
  if (
    requestsManagedRootAuthority(deps, requestedRoot) &&
    resolveAppSessionReadAuthority(deps, ctx.req) === undefined
  ) {
    return genericUnavailable(requestedRoot ?? "", "unknown");
  }
  // A launcher-paired request inside a managed worktree must use Files' persisted-identity
  // authorization path. Falling through to the arbitrary-folder resolver rejects the production
  // `<project>/.keiko/...` layout at the deny-list before the owning managed-root identity can be
  // proven. Canonicalization preserves Git's established trailing/dot/subfolder root semantics.
  const selectedRoot = await resolveSelectedRepositoryRoot(ctx, deps, requestedRoot);
  // Issue #2482 / ADR-0141 W1.9: any generic Git read whose RESOLVED root is inside Keiko's
  // managed task-worktree root requires the launcher-attested app session. Classifying after
  // resolveRoot closes trailing-separator, `.`-segment, and outside-symlink aliases of a managed
  // worktree. An unpaired, forged, revoked, or expired session receives the same schema-valid,
  // content-free unavailable projection as an unavailable repository; ordinary roots retain the
  // existing generic Git behavior. This is uniform content posture, not an OS read-authority claim.
  if (await lacksManagedRootReadAuthority(deps, ctx, selectedRoot.realRoot)) {
    return genericUnavailable(selectedRoot.root, "unknown");
  }
  const membership = await resolveGitMembership(selectedRoot.realRoot, options.runner, {
    timeoutMs: options.timeoutMs,
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  });
  if (!membership.ok) {
    const reason = classifyFailure(membership.result);
    return genericUnavailable(
      selectedRoot.root,
      reason,
      reason === "unsafe-repository"
        ? "Git blocked this repository because its ownership is unsafe."
        : "Git status is unavailable for this folder.",
    );
  }
  const rawRepositoryRoot = resolve(membership.membership.repositoryRoot);
  const repositoryRoot = await realpath(rawRepositoryRoot).catch(() => rawRepositoryRoot);
  // Membership and the selected-root prefix come from git itself (rev-parse --show-prefix), so a
  // letter-case or Unicode-normalization spelling difference between the stored root and the
  // on-disk path can no longer misclassify a valid subfolder. The containment check stays as
  // defense-in-depth only, with platform filesystem identity rules (see keiko-git containsPath).
  if (!containsPath(repositoryRoot, selectedRoot.realRoot)) {
    return genericUnavailable(
      selectedRoot.root,
      "repository-root-outside-root",
      "Git status is unavailable because the repository root is outside the selected folder.",
    );
  }
  return {
    root: selectedRoot.root,
    realRoot: selectedRoot.realRoot,
    repositoryRoot,
    selectedRootPrefix: membership.membership.prefix,
  };
}

const WHITESPACE = /\s/u;

// Strips a trailing whitespace-run-then-`[...]` tracking annotation (e.g. " [ahead 1]") by
// scanning for the first `[` immediately preceded by whitespace and cutting there. The regex
// equivalent, `/\s+\[.*$/`, pairs an unanchored `\s+` with a following literal it may not find,
// forcing the engine to retry the whitespace-run scan at every offset in the string — quadratic
// on adversarial input with no `[` at all (S8786). Each whitespace test here is single-character,
// so there is nothing left to backtrack.
function stripTrackingSuffix(value: string): string {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "[" && i > 0 && WHITESPACE.test(value[i - 1] ?? "")) {
      let start = i;
      while (start > 0 && WHITESPACE.test(value[start - 1] ?? "")) start--;
      return value.slice(0, start);
    }
  }
  return value;
}

function parseBranch(header: string): { readonly branch?: string; readonly detached: boolean } {
  if (header.includes("HEAD (no branch)") || header.includes("HEAD detached")) {
    return { detached: true };
  }
  const trimmed = header.replace(/^##\s*/u, "");
  const beforeTracking = trimmed.split("...")[0];
  const branch =
    beforeTracking === undefined ? undefined : stripTrackingSuffix(beforeTracking).trim();
  if (branch === undefined || branch.length === 0 || branch.startsWith("No commits yet on ")) {
    const unborn = branch?.replace(/^No commits yet on\s+/u, "");
    return unborn === undefined || unborn.length === 0
      ? { detached: false }
      : { branch: unborn, detached: false };
  }
  return { branch, detached: false };
}

function stripSelectedPrefix(path: string, prefix: string): string | null {
  if (prefix.length === 0 || prefix === ".") return path;
  if (path === prefix) return "";
  const start = `${prefix}/`;
  return path.startsWith(start) ? path.slice(start.length) : null;
}

function toStatusCode(value: string | undefined): GitStatusCode {
  if (value === undefined || value === "") return " ";
  // T (typechange: file↔symlink) is not part of the wire vocabulary; the closest truthful code
  // is a modification. Anything unknown degrades to " " so future porcelain codes cannot crash.
  if (value === "T") return "M";
  return [" ", "M", "A", "D", "R", "C", "U", "?", "!"].includes(value)
    ? (value as GitStatusCode)
    : " ";
}

interface ParsedStatusRecord {
  readonly path: string;
  readonly oldRawPath: string | undefined;
  readonly indexStatus: GitStatusCode;
  readonly worktreeStatus: GitStatusCode;
  readonly consumedOldPathRecord: boolean;
}

// Parses one non-branch porcelain record ("XY path", with an optional NUL-separated old-path
// field for renames/copies). Returns null when the record should be skipped entirely.
function parseStatusRecord(
  record: string,
  nextRecord: string | undefined,
  selectedRootPrefix: string,
): ParsedStatusRecord | null {
  if (record.length < 4) return null;
  const indexStatus = toStatusCode(record[0]);
  const worktreeStatus = toStatusCode(record[1]);
  const rawPath = record.slice(3);
  const path = stripSelectedPrefix(rawPath, selectedRootPrefix);
  if (path === null || path.length === 0) return null;
  // Renames/copies carry a NUL-separated original-path field. Since git 2.18 unstaged rename
  // detection can put R/C in the WORKTREE column too — that field must be skipped either way,
  // or the old path surfaces as a phantom change record.
  const hasOldPath =
    indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C";
  const oldRawPath = hasOldPath ? nextRecord : undefined;
  return {
    path,
    oldRawPath,
    indexStatus,
    worktreeStatus,
    consumedOldPathRecord: oldRawPath !== undefined,
  };
}

function isIgnoredStatus(indexStatus: GitStatusCode, worktreeStatus: GitStatusCode): boolean {
  return indexStatus === "!" && worktreeStatus === "!";
}

function isStagedStatus(indexStatus: GitStatusCode, ignored: boolean): boolean {
  return !ignored && indexStatus !== " " && indexStatus !== "?";
}

function isUnstagedStatus(worktreeStatus: GitStatusCode, ignored: boolean): boolean {
  return !ignored && worktreeStatus !== " " && worktreeStatus !== "?";
}

function isUntrackedStatus(indexStatus: GitStatusCode, worktreeStatus: GitStatusCode): boolean {
  return indexStatus === "?" && worktreeStatus === "?";
}

function isConflictedStatus(indexStatus: GitStatusCode, worktreeStatus: GitStatusCode): boolean {
  return (
    indexStatus === "U" ||
    worktreeStatus === "U" ||
    (indexStatus === "A" && worktreeStatus === "A") ||
    (indexStatus === "D" && worktreeStatus === "D")
  );
}

function buildChangedFile(parsed: ParsedStatusRecord, selectedRootPrefix: string): GitChangedFile {
  const { path, oldRawPath, indexStatus, worktreeStatus } = parsed;
  const oldPath =
    oldRawPath === undefined
      ? undefined
      : (stripSelectedPrefix(oldRawPath, selectedRootPrefix) ?? undefined);
  const ignored = isIgnoredStatus(indexStatus, worktreeStatus);
  return {
    path,
    oldPath,
    indexStatus,
    worktreeStatus,
    staged: isStagedStatus(indexStatus, ignored),
    unstaged: isUnstagedStatus(worktreeStatus, ignored),
    untracked: isUntrackedStatus(indexStatus, worktreeStatus),
    conflicted: isConflictedStatus(indexStatus, worktreeStatus),
  };
}

interface StatusCounts {
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
  readonly conflictedCount: number;
  readonly dirty: boolean;
}

function computeStatusCounts(changes: readonly GitChangedFile[]): StatusCounts {
  const stagedCount = changes.filter((change) => change.staged).length;
  const unstagedCount = changes.filter((change) => change.unstaged).length;
  const untrackedCount = changes.filter((change) => change.untracked).length;
  const conflictedCount = changes.filter((change) => change.conflicted).length;
  const dirty = changes.some(
    (change) => change.staged || change.unstaged || change.untracked || change.conflicted,
  );
  return { stagedCount, unstagedCount, untrackedCount, conflictedCount, dirty };
}

function computeStatusTruncated(
  processTruncated: boolean,
  recordCount: number,
  maxChanges: number,
  scopedPath: string | undefined,
  scopedChangeCount: number,
): boolean {
  return (
    processTruncated ||
    (scopedPath === undefined ? recordCount - 1 > maxChanges : scopedChangeCount > maxChanges)
  );
}

interface CollectedStatusChanges {
  readonly branch: string | undefined;
  readonly detached: boolean;
  readonly changes: GitChangedFile[];
  readonly scopedChangeCount: number;
}

// Walks the NUL-separated porcelain records once, splitting out the branch header from the
// per-file XY records (including the old-path lookahead for renames/copies).
function collectStatusChanges(
  records: readonly string[],
  selectedRootPrefix: string,
  maxChanges: number,
  scopedPath: string | undefined,
): CollectedStatusChanges {
  let branch: string | undefined;
  let detached = false;
  let scopedChangeCount = 0;
  const changes: GitChangedFile[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.startsWith("## ")) {
      const parsedBranch = parseBranch(record);
      branch = parsedBranch.branch;
      detached = parsedBranch.detached;
      continue;
    }
    const parsed = parseStatusRecord(record, records[index + 1], selectedRootPrefix);
    if (parsed === null) continue;
    if (parsed.consumedOldPathRecord) index += 1;
    if (scopedPath !== undefined && parsed.path !== scopedPath) continue;
    scopedChangeCount += 1;
    if (changes.length < maxChanges) {
      changes.push(buildChangedFile(parsed, selectedRootPrefix));
    }
  }
  return { branch, detached, changes, scopedChangeCount };
}

// Porcelain parsing is intentionally centralized so Git XY semantics stay audited in one place.
function parseStatus(
  stdout: string,
  root: string,
  repositoryRoot: string,
  selectedRootPrefix: string,
  maxChanges: number,
  processTruncated: boolean,
  scopedPath?: string,
): GitRepositoryStatusResponse {
  const records = stdout.split("\0").filter((record) => record.length > 0);
  const collected = collectStatusChanges(records, selectedRootPrefix, maxChanges, scopedPath);
  const counts = computeStatusCounts(collected.changes);
  return {
    schemaVersion: GIT_REPOSITORY_SCHEMA_VERSION,
    root,
    repositoryRoot,
    state: "available",
    available: true,
    branch: collected.branch,
    detached: collected.detached,
    clean: !counts.dirty,
    stagedCount: counts.stagedCount,
    unstagedCount: counts.unstagedCount,
    untrackedCount: counts.untrackedCount,
    conflictedCount: counts.conflictedCount,
    changes: collected.changes,
    truncated: computeStatusTruncated(
      processTruncated,
      records.length,
      maxChanges,
      scopedPath,
      collected.scopedChangeCount,
    ),
    maxChanges,
  };
}

function redacted<T>(deps: UiHandlerDeps, value: T): T {
  return deps.redactor(value) as T;
}

function unavailableBranchList(repo: GitRepositoryStatusResponse): GitBranchListResponse {
  return {
    schemaVersion: GIT_REPOSITORY_SCHEMA_VERSION,
    root: repo.root,
    available: false,
    state: repo.state === "error" ? "unavailable" : repo.state,
    reason: repo.reason,
    message: repo.message,
    branches: [],
    truncated: false,
  };
}

// Issue #2228 defect fix (Epic #2093 audit): GitEditorDiffResponse/GitEditorBlameResponse (unlike
// GitRepositoryStatusResponse/GitBranchListResponse) carry no "unavailable" state fields at all —
// they are pure success shapes. Membership failures are projected before these handlers run. If an
// admitted repository subsequently fails Git's unsafe-ownership check, the correct representation
// is a schema-valid zero-value response rather than a GitRepositoryStatusResponse. Operational
// failures such as a missing Git binary or timeout remain correlated 500s so the UI cannot mistake
// an incomplete read for a clean result.
function unavailableStructuredDiff(scope: GitEditorDiffScope): GitEditorDiffResponse {
  return {
    schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
    scope,
    files: [],
    truncated: false,
    totalFiles: 0,
    totalBytes: 0,
    maxBytes: GIT_EDITOR_DIFF_MAX_BYTES,
    maxFiles: GIT_EDITOR_DIFF_MAX_FILES,
  };
}

function unavailableBlame(request: GitEditorBlameRequest): GitEditorBlameResponse {
  return {
    schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
    path: request.path,
    startLine: request.startLine,
    lines: [],
    truncated: false,
    totalLines: 0,
    totalBytes: 0,
    maxBytes: GIT_EDITOR_BLAME_MAX_BYTES,
    maxLines: GIT_EDITOR_BLAME_MAX_LINES,
  };
}

function parseBranches(stdout: string): readonly GitBranchListEntry[] {
  const fields = stdout.split("\0");
  const branches: GitBranchListEntry[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const name = fields[index]?.trim() ?? "";
    const headRefHash = fields[index + 1]?.trim() ?? "";
    const headMarker = fields[index + 2]?.trim() ?? "";
    if (name.length === 0 || headRefHash.length === 0) continue;
    branches.push({ name, headRefHash, current: headMarker === "*" });
  }
  return branches;
}

function branchListFailure(
  repo: RepositoryContext,
  result: GitProcessResult,
): GitBranchListResponse {
  const reason = classifyFailure(result);
  return {
    schemaVersion: GIT_REPOSITORY_SCHEMA_VERSION,
    root: repo.root,
    repositoryRoot: repo.repositoryRoot,
    available: false,
    state: reason === "unsafe-repository" ? "unsafe" : "unavailable",
    reason,
    message: "Git branches are unavailable for this folder.",
    branches: [],
    truncated: result.truncated,
  };
}

export async function handleGitBranches(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  rawOptions?: GitRouteOptions,
): Promise<RouteResult> {
  return runFilesHandler(async () => {
    const options = optionsWithDefaults(rawOptions ?? deps.gitRouteOptions);
    const repo = await resolveRepository(ctx, deps, options);
    if ("available" in repo) {
      return { status: 200, body: redacted(deps, unavailableBranchList(repo)) };
    }
    const result = await options.runner(
      [
        "--no-pager",
        "--no-optional-locks",
        "-C",
        repo.repositoryRoot,
        "for-each-ref",
        "--format=%(refname:short)%00%(objectname)%00%(HEAD)%00",
        "refs/heads",
      ],
      {
        cwd: repo.repositoryRoot,
        maxBytes: options.maxStatusBytes,
        timeoutMs: options.timeoutMs,
        ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      },
    );
    if (result.exitCode !== 0) {
      return { status: 200, body: redacted(deps, branchListFailure(repo, result)) };
    }
    return {
      status: 200,
      body: redacted(deps, {
        schemaVersion: GIT_REPOSITORY_SCHEMA_VERSION,
        root: repo.root,
        repositoryRoot: repo.repositoryRoot,
        available: true,
        state: "available",
        branches: parseBranches(result.stdout),
        truncated: result.truncated,
      } satisfies GitBranchListResponse),
    };
  });
}

function validatePath(path: string | null): string | undefined {
  const trimmed = path?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  if (!isRootRelativeFileIdentifier(trimmed)) {
    throw new FilesError(400, "BAD_PATH", "The path must be relative to the selected root.");
  }
  return trimmed;
}

function requiredPath(path: string | null): string {
  const validated = validatePath(path);
  if (validated === undefined) {
    throw new FilesError(400, "BAD_PATH", "A path relative to the selected root is required.");
  }
  return validated;
}

function parseBooleanOption(value: string | null, name: string): boolean {
  if (value === null || value === "false") return false;
  if (value === "true") return true;
  throw new FilesError(400, "BAD_REQUEST", `${name} must be true or false.`);
}

function parsePositiveInteger(value: string | null, name: string): number {
  if (value === null || !/^[1-9]\d*$/u.test(value)) {
    throw new FilesError(400, "BAD_REQUEST", `${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new FilesError(400, "BAD_REQUEST", `${name} must be a safe positive integer.`);
  }
  return parsed;
}

async function nearestExistingPath(path: string, boundary: string): Promise<string> {
  let current = path;
  while (containsPath(boundary, current)) {
    const resolved = await realpath(current).catch(() => undefined);
    if (resolved !== undefined) return resolved;
    if (current === boundary) break;
    current = dirname(current);
  }
  return path;
}

async function assertContainedGitPath(repo: RepositoryContext, path: string): Promise<void> {
  const candidate = resolve(repo.realRoot, path);
  const resolved = await nearestExistingPath(candidate, repo.realRoot);
  if (!containsPath(repo.realRoot, resolved)) {
    throw new FilesError(400, "BAD_PATH", "The path must stay inside the selected root.");
  }
}

async function assertOptionalContainedGitPath(
  repo: RepositoryContext,
  path: string | undefined,
): Promise<void> {
  if (path !== undefined) await assertContainedGitPath(repo, path);
}

function gitPath(prefix: string, path: string | undefined): string | undefined {
  const normalizedPrefix = prefix === "." ? "" : prefix;
  if (path === undefined) return normalizedPrefix.length > 0 ? normalizedPrefix : undefined;
  const normalizedPath = platformGitPath(path, process.platform);
  return normalizedPrefix.length > 0 ? `${normalizedPrefix}/${normalizedPath}` : normalizedPath;
}

export function platformGitPath(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.replaceAll("\\", "/") : path;
}

function literalGitPathspec(path: string): string {
  return `:(literal)${path}`;
}

function parseScope(input: string | null): GitDiffScope {
  if (input === null || input.length === 0) return "all";
  if (input === "all" || input === "worktree" || input === "staged") return input;
  throw new FilesError(400, "BAD_REQUEST", "The diff scope must be all, worktree, or staged.");
}

function parseStructuredScope(input: string | null): GitEditorDiffScope {
  if (input === "staged" || input === "unstaged") return input;
  throw new FilesError(400, "BAD_REQUEST", "The diff scope must be staged or unstaged.");
}

function gitProcessOptions(
  repo: RepositoryContext,
  options: NormalizedGitRouteOptions,
  maxBytes: number,
): GitProcessOptions {
  return {
    cwd: repo.repositoryRoot,
    maxBytes,
    timeoutMs: options.timeoutMs,
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  };
}

function isExactUntrackedPath(result: GitProcessResult, path: string): boolean {
  return result.stdout.split("\0").includes(path);
}

interface UntrackedFileSnapshot {
  readonly bytes: Buffer;
  readonly mode: number;
  readonly truncated: boolean;
}

const NOFOLLOW_READ_FLAG = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

interface SnapshotReadable {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
}

export async function readBoundedSnapshotBytes(
  descriptor: SnapshotReadable,
  maxBytes: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const read = await descriptor.read(buffer, offset, buffer.length - offset, offset);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  return buffer.subarray(0, offset);
}

function sameOpenFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function staleUntrackedPath(): FilesError {
  return new FilesError(
    409,
    "STALE_PATH",
    "The file changed before its Git diff could be prepared.",
  );
}

const STALE_PATH_ERROR_CODES = new Set(["ENOENT", "ENOTDIR", "ESTALE"]);

function fileSystemErrorCode(error: unknown): string | undefined {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : undefined;
}

export function rethrowSnapshotPathError(error: unknown): never {
  if (STALE_PATH_ERROR_CODES.has(fileSystemErrorCode(error) ?? "")) {
    throw staleUntrackedPath();
  }
  throw error;
}

export function rethrowSnapshotRaceError(error: unknown): never {
  if (fileSystemErrorCode(error) === "ELOOP") throw staleUntrackedPath();
  return rethrowSnapshotPathError(error);
}

async function readOpenSnapshot(
  candidate: string,
  resolved: string,
  boundary: string,
  maxBytes: number,
  observer: (() => Promise<void> | void) | undefined,
): Promise<UntrackedFileSnapshot> {
  const descriptor = await open(resolved, constants.O_RDONLY | NOFOLLOW_READ_FLAG).catch(
    rethrowSnapshotRaceError,
  );
  try {
    const before = await descriptor.stat({ bigint: true });
    const current = await realpath(candidate).catch(rethrowSnapshotRaceError);
    if (!containsPath(boundary, current)) {
      throw new FilesError(400, "BAD_PATH", "The path must stay inside the selected root.");
    }
    const currentStats = await stat(current, { bigint: true }).catch(rethrowSnapshotRaceError);
    if (!sameOpenFile(before, currentStats)) throw staleUntrackedPath();
    const buffer = await readBoundedSnapshotBytes(descriptor, maxBytes);
    const after = await descriptor.stat({ bigint: true });
    if (!sameOpenFile(before, after)) throw staleUntrackedPath();
    await observer?.();
    const finalPath = await realpath(candidate).catch(rethrowSnapshotRaceError);
    if (!containsPath(boundary, finalPath)) {
      throw new FilesError(400, "BAD_PATH", "The path must stay inside the selected root.");
    }
    const finalStats = await stat(finalPath, { bigint: true }).catch(rethrowSnapshotRaceError);
    if (!sameOpenFile(after, finalStats)) throw staleUntrackedPath();
    return {
      bytes: buffer.subarray(0, Math.min(buffer.length, maxBytes)),
      mode: Number(before.mode & 0o777n),
      truncated: buffer.length > maxBytes,
    };
  } finally {
    await descriptor.close();
  }
}

async function readContainedUntrackedSnapshot(
  repo: RepositoryContext,
  path: string,
  maxBytes: number,
  observer: (() => Promise<void> | void) | undefined,
): Promise<UntrackedFileSnapshot> {
  const candidate = resolve(repo.realRoot, path);
  const resolved = await realpath(candidate).catch(rethrowSnapshotPathError);
  if (!containsPath(repo.realRoot, resolved)) {
    throw new FilesError(400, "BAD_PATH", "The path must stay inside the selected root.");
  }
  return readOpenSnapshot(candidate, resolved, repo.realRoot, maxBytes, observer);
}

function normalizeNoIndexDiff(
  result: GitProcessResult,
  sourceTruncated: boolean,
  abortSignal: AbortSignal | undefined,
): GitProcessResult {
  const expectedDifference =
    (result.exitCode === 1 || result.truncated) &&
    result.timedOut !== true &&
    abortSignal?.aborted !== true &&
    result.stderr.length === 0 &&
    result.stdout.startsWith("diff --git ");
  return expectedDifference
    ? { ...result, exitCode: 0, truncated: result.truncated || sourceTruncated }
    : result;
}

async function runSnapshotDiff(
  options: NormalizedGitRouteOptions,
  path: string,
  snapshot: UntrackedFileSnapshot,
  maxBytes: number,
): Promise<GitProcessResult> {
  const snapshotRoot = await mkdtemp(join(tmpdir(), "keiko-git-diff-"));
  try {
    const snapshotPath = resolve(snapshotRoot, ...path.split("/"));
    if (!containsPath(snapshotRoot, snapshotPath)) throw staleUntrackedPath();
    await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 });
    await writeFile(snapshotPath, snapshot.bytes, { flag: "wx", mode: 0o600 });
    await chmod(snapshotPath, snapshot.mode);
    const result = await options.runner(
      [
        "--no-pager",
        "--no-optional-locks",
        "-C",
        snapshotRoot,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-index",
        "--",
        "/dev/null",
        path,
      ],
      {
        cwd: snapshotRoot,
        maxBytes,
        timeoutMs: options.timeoutMs,
        ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      },
    );
    return normalizeNoIndexDiff(result, snapshot.truncated, options.abortSignal);
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }
}

async function runUntrackedDiff(
  repo: RepositoryContext,
  options: NormalizedGitRouteOptions,
  gitRelativePath: string,
  selectedPath: string,
  original: GitProcessResult,
  maxBytes: number,
): Promise<GitProcessResult> {
  const untracked = await options.runner(
    [
      "--no-pager",
      "--no-optional-locks",
      "-C",
      repo.repositoryRoot,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      literalGitPathspec(gitRelativePath),
    ],
    gitProcessOptions(repo, options, options.maxStatusBytes),
  );
  if (untracked.exitCode !== 0) return untracked;
  if (untracked.truncated) return { ...untracked, exitCode: 1, stdout: "" };
  if (!isExactUntrackedPath(untracked, gitRelativePath)) return original;
  const snapshot = await readContainedUntrackedSnapshot(
    repo,
    selectedPath,
    maxBytes,
    options.snapshotReadObserver,
  );
  return runSnapshotDiff(options, gitRelativePath, snapshot, maxBytes);
}

async function runDiff(
  repo: RepositoryContext,
  options: NormalizedGitRouteOptions,
  staged: boolean,
  path: string | undefined,
  maxBytes = options.maxDiffBytes,
): Promise<GitProcessResult> {
  const args = [
    "--no-pager",
    "--no-optional-locks",
    "-C",
    repo.repositoryRoot,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
  ];
  if (staged) args.push("--cached");
  const relativePath = gitPath(repo.selectedRootPrefix, path);
  if (relativePath !== undefined) args.push("--", literalGitPathspec(relativePath));
  const result = await options.runner(args, gitProcessOptions(repo, options, maxBytes));
  if (
    staged ||
    path === undefined ||
    relativePath === undefined ||
    result.exitCode !== 0 ||
    result.truncated ||
    result.stdout.length > 0
  ) {
    return result;
  }
  return runUntrackedDiff(repo, options, relativePath, path, result, maxBytes);
}

// eslint-disable-next-line max-lines-per-function
export async function handleGitStatus(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  rawOptions?: GitRouteOptions,
): Promise<RouteResult> {
  return runFilesHandler(
    // eslint-disable-next-line max-lines-per-function
    async () => {
      const options = optionsWithDefaults(rawOptions ?? deps.gitRouteOptions);
      const includeIgnored = parseBooleanOption(
        ctx.url.searchParams.get("includeIgnored"),
        "includeIgnored",
      );
      const path = validatePath(ctx.url.searchParams.get("path"));
      const repo = await resolveRepository(ctx, deps, options);
      if ("available" in repo) {
        const body = { ...repo, maxChanges: options.maxChanges };
        return { status: 200, body: redacted(deps, body) };
      }
      await assertOptionalContainedGitPath(repo, path);
      const relativePath = gitPath(repo.selectedRootPrefix, path);
      const status = await options.runner(
        [
          "--no-pager",
          "--no-optional-locks",
          "-C",
          repo.repositoryRoot,
          "status",
          "--porcelain=v1",
          "-z",
          "--branch",
          "--untracked-files=all",
          ...(includeIgnored ? ["--ignored=matching"] : []),
          "--",
          ...(relativePath === undefined ? [] : [literalGitPathspec(relativePath)]),
        ],
        {
          cwd: repo.repositoryRoot,
          maxBytes: options.maxStatusBytes,
          timeoutMs: options.timeoutMs,
          ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
        },
      );
      if (status.exitCode !== 0) {
        const reason = classifyFailure(status);
        const body = genericUnavailable(
          repo.root,
          reason,
          reason === "unsafe-repository"
            ? "Git blocked this repository because its ownership is unsafe."
            : "Git status is unavailable for this folder.",
        );
        return { status: 200, body: redacted(deps, { ...body, maxChanges: options.maxChanges }) };
      }
      const body = parseStatus(
        status.stdout,
        repo.root,
        repo.repositoryRoot,
        repo.selectedRootPrefix,
        options.maxChanges,
        status.truncated,
        path,
      );
      return { status: 200, body: redacted(deps, body) };
    },
  );
}

// eslint-disable-next-line max-lines-per-function
export async function handleGitDiff(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  rawOptions?: GitRouteOptions,
): Promise<RouteResult> {
  return runGitDiffHandler(
    ctx,
    deps,
    // eslint-disable-next-line max-lines-per-function
    async () => {
      const options = optionsWithDefaults(rawOptions ?? deps.gitRouteOptions);
      const scope = parseScope(ctx.url.searchParams.get("scope"));
      const path = validatePath(ctx.url.searchParams.get("path"));
      const repo = await resolveRepository(ctx, deps, options);
      if ("available" in repo) {
        const body: GitRepositoryDiffResponse = {
          schemaVersion: GIT_REPOSITORY_SCHEMA_VERSION,
          root: repo.root,
          state: repo.state,
          available: false,
          reason: repo.reason,
          path,
          scope,
          diff: "",
          truncated: false,
          maxBytes: options.maxDiffBytes,
        };
        return { status: 200, body: redacted(deps, body) };
      }
      await assertOptionalContainedGitPath(repo, path);

      const runs =
        scope === "all"
          ? await Promise.all([
              runDiff(repo, options, true, path),
              runDiff(repo, options, false, path),
            ])
          : [await runDiff(repo, options, scope === "staged", path)];
      const failed = runs.find((result) => result.exitCode !== 0);
      if (failed !== undefined) {
        const reason = classifyFailure(failed);
        if (reason === "unsafe-repository" || reason === "git-missing") {
          const body: GitRepositoryDiffResponse = {
            schemaVersion: GIT_REPOSITORY_SCHEMA_VERSION,
            root: repo.root,
            repositoryRoot: repo.repositoryRoot,
            state: reason === "unsafe-repository" ? "unsafe" : "unavailable",
            available: false,
            reason,
            path,
            scope,
            diff: "",
            truncated: failed.truncated,
            maxBytes: options.maxDiffBytes,
          };
          return { status: 200, body: redacted(deps, body) };
        }
        return {
          status: 500,
          body: gitReadErrorBody(
            ctx,
            deps,
            new GitRouteReadError("GIT_DIFF_FAILED"),
            "GIT_DIFF_FAILED",
            "Git diff is unavailable for this folder.",
            "The bounded diff read was unavailable.",
          ),
        };
      }
      const rawDiff = runs
        .map((result) => result.stdout)
        .filter((entry) => entry.length > 0)
        .join("\n");
      const rawDiffBytes = Buffer.byteLength(rawDiff, "utf8");
      const diff =
        rawDiffBytes > options.maxDiffBytes
          ? Buffer.from(rawDiff, "utf8").subarray(0, options.maxDiffBytes).toString("utf8")
          : rawDiff;
      const body: GitRepositoryDiffResponse = {
        schemaVersion: GIT_REPOSITORY_SCHEMA_VERSION,
        root: repo.root,
        repositoryRoot: repo.repositoryRoot,
        state: "available",
        available: true,
        path,
        scope,
        diff,
        truncated: runs.some((result) => result.truncated) || rawDiffBytes > options.maxDiffBytes,
        maxBytes: options.maxDiffBytes,
      };
      return { status: 200, body: redacted(deps, body) };
    },
  );
}

function boundedProcessOutput(
  result: GitProcessResult,
  maxBytes: number,
): { readonly text: string; readonly totalBytes: number; readonly truncated: boolean } {
  const bytes = Buffer.byteLength(result.stdout, "utf8");
  return {
    text:
      bytes <= maxBytes
        ? result.stdout
        : Buffer.from(result.stdout, "utf8").subarray(0, maxBytes).toString("utf8"),
    totalBytes: result.truncated ? Math.max(bytes, maxBytes + 1) : bytes,
    truncated: result.truncated || bytes > maxBytes,
  };
}

function isUnavailableReadFailure(result: GitProcessResult): boolean {
  return classifyGitFailure(result) === "unsafe-repository";
}

function correlatedGitError(ctx: RouteContext, code: string, message: string): RouteResult {
  return {
    status: 500,
    body: errorBody(code, message, ctx.correlationId ?? randomUUID()),
  };
}

class GitRouteReadError extends Error {
  public constructor(public readonly code: string) {
    super("Git read failed.");
    this.name = "GitRouteReadError";
  }
}

function gitReadErrorBody(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  error: unknown,
  code: string,
  message: string,
  summary: ServerDiagnosticSummary,
): ReturnType<typeof errorBody> {
  const correlationId = ctx.correlationId ?? randomUUID();
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId,
      operation: `GET ${ctx.url.pathname}`,
      source: "git-routes",
      error,
      summary,
      redact: (value): string => String(deps.redactor(value)),
    }),
  );
  return errorBody(code, message, correlationId);
}

async function runGitDiffHandler(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  work: () => Promise<RouteResult>,
): Promise<RouteResult> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof FilesError)) {
      return {
        status: 500,
        body: gitReadErrorBody(
          ctx,
          deps,
          error,
          "GIT_DIFF_FAILED",
          "Git diff is unavailable for this folder.",
          "The bounded diff read was unavailable.",
        ),
      };
    }
    const correlated = error.code === "BAD_PATH" || error.code === "STALE_PATH";
    return {
      status: error.status,
      body: correlated
        ? gitReadErrorBody(
            ctx,
            deps,
            error,
            error.code,
            error.message,
            "The bounded diff read was unavailable.",
          )
        : errorBody(error.code, error.message),
    };
  }
}

function structuredDiffBody(
  scope: GitEditorDiffScope,
  repo: RepositoryContext,
  result: GitProcessResult,
): GitEditorDiffResponse {
  const output = boundedProcessOutput(result, GIT_EDITOR_DIFF_MAX_BYTES);
  const parsed = parseGitEditorUnifiedDiff(output.text, {
    scope,
    selectedRootPrefix: repo.selectedRootPrefix,
    processTruncated: output.truncated,
  });
  return {
    schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
    scope,
    files: parsed.files,
    truncated: parsed.truncated,
    totalFiles: parsed.totalFiles,
    totalBytes: output.totalBytes,
    maxBytes: GIT_EDITOR_DIFF_MAX_BYTES,
    maxFiles: GIT_EDITOR_DIFF_MAX_FILES,
  };
}

export async function handleGitStructuredDiff(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  rawOptions?: GitRouteOptions,
): Promise<RouteResult> {
  return runGitDiffHandler(ctx, deps, async () => {
    const options = optionsWithDefaults(rawOptions ?? deps.gitRouteOptions);
    const scope = parseStructuredScope(ctx.url.searchParams.get("scope"));
    const path = validatePath(ctx.url.searchParams.get("path"));
    const repo = await resolveRepository(ctx, deps, options);
    if ("available" in repo) {
      return { status: 200, body: redacted(deps, unavailableStructuredDiff(scope)) };
    }
    if (path !== undefined) await assertContainedGitPath(repo, path);
    const result = await runDiff(
      repo,
      options,
      scope === "staged",
      path,
      GIT_EDITOR_DIFF_MAX_BYTES,
    );
    if (result.exitCode !== 0) {
      if (isUnavailableReadFailure(result)) {
        return { status: 200, body: redacted(deps, unavailableStructuredDiff(scope)) };
      }
      return correlatedGitError(ctx, "GIT_DIFF_FAILED", "Git diff is unavailable for this folder.");
    }
    return { status: 200, body: redacted(deps, structuredDiffBody(scope, repo, result)) };
  });
}

function parseBlameRequest(ctx: RouteContext): GitEditorBlameRequest {
  const request = {
    schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
    path: requiredPath(ctx.url.searchParams.get("path")),
    startLine: parsePositiveInteger(ctx.url.searchParams.get("startLine"), "startLine"),
    maxLines: parsePositiveInteger(ctx.url.searchParams.get("maxLines"), "maxLines"),
  };
  const parsed = parseGitEditorBlameRequest(request);
  if (!parsed.ok) {
    throw new FilesError(400, "BAD_REQUEST", "The blame range is invalid.");
  }
  if (parsed.value.startLine + parsed.value.maxLines - 1 > Number.MAX_SAFE_INTEGER) {
    throw new FilesError(400, "BAD_REQUEST", "The blame range is too large.");
  }
  return parsed.value;
}

async function runBlame(
  repo: RepositoryContext,
  options: NormalizedGitRouteOptions,
  request: GitEditorBlameRequest,
): Promise<GitProcessResult> {
  const endLine = request.startLine + request.maxLines - 1;
  const path = gitPath(repo.selectedRootPrefix, request.path) ?? request.path;
  return options.runner(
    [
      "--no-pager",
      "--no-optional-locks",
      "-C",
      repo.repositoryRoot,
      "blame",
      "--line-porcelain",
      "--no-textconv",
      "-L",
      `${String(request.startLine)},${String(endLine)}`,
      "--",
      path,
    ],
    {
      cwd: repo.repositoryRoot,
      maxBytes: GIT_EDITOR_BLAME_MAX_BYTES,
      timeoutMs: options.timeoutMs,
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    },
  );
}

function blameBody(
  request: GitEditorBlameRequest,
  result: GitProcessResult,
): GitEditorBlameResponse {
  const output = boundedProcessOutput(result, GIT_EDITOR_BLAME_MAX_BYTES);
  const parsed = parseGitBlamePorcelain(output.text, {
    maxLines: request.maxLines,
    processTruncated: output.truncated,
  });
  return {
    schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
    path: request.path,
    startLine: request.startLine,
    lines: parsed.lines,
    truncated: parsed.truncated,
    totalLines: parsed.totalLines,
    totalBytes: output.totalBytes,
    maxBytes: GIT_EDITOR_BLAME_MAX_BYTES,
    maxLines: GIT_EDITOR_BLAME_MAX_LINES,
  };
}

export async function handleGitBlame(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  rawOptions?: GitRouteOptions,
): Promise<RouteResult> {
  return runFilesHandler(async () => {
    const options = optionsWithDefaults(rawOptions ?? deps.gitRouteOptions);
    const request = parseBlameRequest(ctx);
    const repo = await resolveRepository(ctx, deps, options);
    if ("available" in repo) {
      return { status: 200, body: redacted(deps, unavailableBlame(request)) };
    }
    await assertContainedGitPath(repo, request.path);
    const result = await runBlame(repo, options, request);
    if (result.exitCode !== 0) {
      if (isUnavailableReadFailure(result)) {
        return { status: 200, body: redacted(deps, unavailableBlame(request)) };
      }
      return correlatedGitError(
        ctx,
        "GIT_BLAME_FAILED",
        "Git blame is unavailable for this folder.",
      );
    }
    return { status: 200, body: redacted(deps, blameBody(request, result)) };
  });
}
