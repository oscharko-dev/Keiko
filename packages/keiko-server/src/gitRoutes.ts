import { Buffer } from "node:buffer";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  GitChangedFile,
  GitDiffScope,
  GitRepositoryDiffResponse,
  GitRepositoryStatusResponse,
  GitStatusCode,
} from "@oscharko-dev/keiko-contracts";
import {
  GIT_REPOSITORY_SCHEMA_VERSION,
  isRootRelativeFileIdentifier,
} from "@oscharko-dev/keiko-contracts";
import {
  classifyGitFailure,
  containsPath,
  defaultGitProcessRunner,
  resolveGitMembership,
  type GitProcessResult,
  type GitProcessRunner,
} from "@oscharko-dev/keiko-git";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { FilesError, resolveRoot, runFilesHandler } from "./files.js";

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
}

export interface NormalizedGitRouteOptions {
  readonly runner: GitProcessRunner;
  readonly maxStatusBytes: number;
  readonly maxDiffBytes: number;
  readonly maxChanges: number;
  readonly timeoutMs: number;
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
  };
}

export async function resolveRepository(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: NormalizedGitRouteOptions,
): Promise<RepositoryContext | GitRepositoryStatusResponse> {
  const selectedRoot = await resolveRoot(
    deps.store,
    ctx.url.searchParams.get("root"),
    deps.redactor,
  );
  const membership = await resolveGitMembership(selectedRoot.realRoot, options.runner, {
    timeoutMs: options.timeoutMs,
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

function parseBranch(header: string): { readonly branch?: string; readonly detached: boolean } {
  if (header.includes("HEAD (no branch)") || header.includes("HEAD detached")) {
    return { detached: true };
  }
  const trimmed = header.replace(/^##\s*/u, "");
  const branch = trimmed
    .split("...")[0]
    ?.replace(/\s+\[.*$/u, "")
    .trim();
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

// Porcelain parsing is intentionally centralized so Git XY semantics stay audited in one place.
// eslint-disable-next-line max-lines-per-function, complexity
function parseStatus(
  stdout: string,
  root: string,
  repositoryRoot: string,
  selectedRootPrefix: string,
  maxChanges: number,
  processTruncated: boolean,
): GitRepositoryStatusResponse {
  const records = stdout.split("\0").filter((record) => record.length > 0);
  let branch: string | undefined;
  let detached = false;
  const changes: GitChangedFile[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.startsWith("## ")) {
      const parsed = parseBranch(record);
      branch = parsed.branch;
      detached = parsed.detached;
      continue;
    }
    if (record.length < 4) continue;
    const indexStatus = toStatusCode(record[0]);
    const worktreeStatus = toStatusCode(record[1]);
    const rawPath = record.slice(3);
    const path = stripSelectedPrefix(rawPath, selectedRootPrefix);
    if (path === null || path.length === 0) continue;
    // Renames/copies carry a NUL-separated original-path field. Since git 2.18 unstaged rename
    // detection can put R/C in the WORKTREE column too — that field must be skipped either way,
    // or the old path surfaces as a phantom change record.
    const hasOldPath =
      indexStatus === "R" ||
      indexStatus === "C" ||
      worktreeStatus === "R" ||
      worktreeStatus === "C";
    const oldRawPath = hasOldPath ? records[index + 1] : undefined;
    if (oldRawPath !== undefined) index += 1;
    if (changes.length < maxChanges) {
      const oldPath =
        oldRawPath === undefined
          ? undefined
          : (stripSelectedPrefix(oldRawPath, selectedRootPrefix) ?? undefined);
      changes.push({
        path,
        oldPath,
        indexStatus,
        worktreeStatus,
        staged: indexStatus !== " " && indexStatus !== "?",
        unstaged: worktreeStatus !== " " && worktreeStatus !== "?",
        untracked: indexStatus === "?" && worktreeStatus === "?",
        conflicted:
          indexStatus === "U" ||
          worktreeStatus === "U" ||
          (indexStatus === "A" && worktreeStatus === "A") ||
          (indexStatus === "D" && worktreeStatus === "D"),
      });
    }
  }
  const stagedCount = changes.filter((change) => change.staged).length;
  const unstagedCount = changes.filter((change) => change.unstaged).length;
  const untrackedCount = changes.filter((change) => change.untracked).length;
  const conflictedCount = changes.filter((change) => change.conflicted).length;
  return {
    schemaVersion: GIT_REPOSITORY_SCHEMA_VERSION,
    root,
    repositoryRoot,
    state: "available",
    available: true,
    branch,
    detached,
    clean: changes.length === 0,
    stagedCount,
    unstagedCount,
    untrackedCount,
    conflictedCount,
    changes,
    truncated: processTruncated || records.length - 1 > maxChanges,
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
      { cwd: repo.repositoryRoot, maxBytes: options.maxStatusBytes, timeoutMs: options.timeoutMs },
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

function gitPath(prefix: string, path: string | undefined): string | undefined {
  const normalizedPrefix = prefix === "." ? "" : prefix;
  if (path === undefined) return normalizedPrefix.length > 0 ? normalizedPrefix : undefined;
  return normalizedPrefix.length > 0 ? `${normalizedPrefix}/${path}` : path;
}

function literalGitPathspec(path: string): string {
  return `:(literal)${path}`;
}

function parseScope(input: string | null): GitDiffScope {
  if (input === null || input.length === 0) return "all";
  if (input === "all" || input === "worktree" || input === "staged") return input;
  throw new FilesError(400, "BAD_REQUEST", "The diff scope must be all, worktree, or staged.");
}

async function runDiff(
  repo: RepositoryContext,
  options: NormalizedGitRouteOptions,
  staged: boolean,
  path: string | undefined,
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
  return options.runner(args, {
    cwd: repo.repositoryRoot,
    maxBytes: options.maxDiffBytes,
    timeoutMs: options.timeoutMs,
  });
}

// eslint-disable-next-line max-lines-per-function
export async function handleGitStatus(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  rawOptions?: GitRouteOptions,
): Promise<RouteResult> {
  return runFilesHandler(async () => {
    const options = optionsWithDefaults(rawOptions ?? deps.gitRouteOptions);
    const repo = await resolveRepository(ctx, deps, options);
    if ("available" in repo) {
      const body = { ...repo, maxChanges: options.maxChanges };
      return { status: 200, body: redacted(deps, body) };
    }
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
        "--",
        ...(repo.selectedRootPrefix.length > 0 && repo.selectedRootPrefix !== "."
          ? [literalGitPathspec(repo.selectedRootPrefix)]
          : []),
      ],
      { cwd: repo.repositoryRoot, maxBytes: options.maxStatusBytes, timeoutMs: options.timeoutMs },
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
    );
    return { status: 200, body: redacted(deps, body) };
  });
}

// eslint-disable-next-line max-lines-per-function
export async function handleGitDiff(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  rawOptions?: GitRouteOptions,
): Promise<RouteResult> {
  return runFilesHandler(
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
          body: errorBody("GIT_DIFF_FAILED", "Git diff is unavailable for this folder."),
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
