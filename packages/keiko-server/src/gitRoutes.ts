import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
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
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { FilesError, resolveRoot, runFilesHandler } from "./files.js";

const DEFAULT_STATUS_MAX_BYTES = 512 * 1024;
const DEFAULT_DIFF_MAX_BYTES = 128 * 1024;
const DEFAULT_MAX_CHANGES = 500;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface GitProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface GitProcessOptions {
  readonly cwd: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

export type GitProcessRunner = (
  args: readonly string[],
  options: GitProcessOptions,
) => Promise<GitProcessResult>;

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

function devNullPath(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

// Local-read env: fully config-isolated. HOME/XDG/global+system config are neutralized so a read
// can never load a user `~/.gitconfig`, a credential helper, or an SSH identity. Correct for the
// local status/diff/branches/summary/history/remotes reads, which never authenticate to a remote.
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNullPath(),
    GIT_OPTIONAL_LOCKS: "0",
  };
  if (process.platform === "win32") {
    env.SystemRoot = process.env.SystemRoot ?? "";
    env.WINDIR = process.env.WINDIR ?? "";
  } else {
    env.HOME = "/nonexistent";
    env.XDG_CONFIG_HOME = "/nonexistent";
  }
  return env;
}

// Network-sync env: a fetch/pull MUST be able to authenticate to a private/SSH remote, so it
// inherits the real environment (the user's global `~/.gitconfig` credential.helper, the macOS
// osxkeychain helper, and the real `~/.ssh` identities). It still never prompts — GIT_TERMINAL_PROMPT
// is forced off and SSH runs in BatchMode — so it fails closed if no stored credential satisfies the
// remote rather than hanging on an interactive prompt. Used ONLY for the actual fetch/pull command;
// local reads keep the hardened, config-isolated `gitEnv` above.
export function networkGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0", // never prompt — fail closed
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    // No SSH credential prompt and no implicit first-use trust. Unknown or changed host keys fail
    // closed and are surfaced by the sync outcome classifier.
    GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes",
  };
}

// Factory: the runner owns process lifecycle state, byte caps, timeout, and spawn-error mapping
// together. `buildEnv` is the only seam — the local reads pass the hardened `gitEnv`, network sync
// passes the credential-capable `networkGitEnv`; everything else is identical.
// eslint-disable-next-line max-lines-per-function
export function createGitProcessRunner(buildEnv: () => NodeJS.ProcessEnv): GitProcessRunner {
  // eslint-disable-next-line max-lines-per-function
  return (args, options) =>
    // eslint-disable-next-line max-lines-per-function
    new Promise((resolveResult) => {
      const child = spawn("git", args, {
        cwd: options.cwd,
        env: buildEnv(),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let settled = false;
      const timer = setTimeout(() => {
        truncated = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);

      const capture = (chunks: Buffer[], currentBytes: number, chunk: Buffer): number => {
        const remaining = options.maxBytes - currentBytes;
        if (remaining <= 0) {
          truncated = true;
          child.kill("SIGTERM");
          return currentBytes;
        }
        if (chunk.byteLength > remaining) {
          chunks.push(chunk.subarray(0, remaining));
          truncated = true;
          child.kill("SIGTERM");
          return options.maxBytes;
        }
        chunks.push(chunk);
        return currentBytes + chunk.byteLength;
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes = capture(stdoutChunks, stdoutBytes, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes = capture(stderrChunks, stderrBytes, chunk);
      });
      child.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({
          exitCode: 127,
          signal: null,
          stdout: "",
          stderr: "git executable unavailable",
          truncated,
        });
      });
      child.on("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({
          exitCode,
          signal,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          truncated,
        });
      });
    });
}

// Local reads use the hardened, config-isolated env; network sync needs the user's credential
// configuration but must still never prompt (fail-closed) — see networkGitEnv.
export const defaultGitProcessRunner: GitProcessRunner = createGitProcessRunner(gitEnv);

export const defaultGitNetworkProcessRunner: GitProcessRunner =
  createGitProcessRunner(networkGitEnv);

export function isContained(root: string, target: string): boolean {
  const rootCmp = process.platform === "win32" ? root.toLowerCase() : root;
  const targetCmp = process.platform === "win32" ? target.toLowerCase() : target;
  const rel = relative(rootCmp, targetCmp);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
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
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.exitCode === 127) return "git-missing";
  if (text.includes("dubious ownership") || text.includes("safe.directory")) {
    return "unsafe-repository";
  }
  if (text.includes("not a git repository")) {
    return "not-a-repository";
  }
  return "git-error";
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
  const revParse = await options.runner(
    [
      "--no-pager",
      "--no-optional-locks",
      "-C",
      selectedRoot.realRoot,
      "rev-parse",
      "--show-toplevel",
    ],
    { cwd: selectedRoot.realRoot, maxBytes: 16 * 1024, timeoutMs: options.timeoutMs },
  );
  if (revParse.exitCode !== 0) {
    const reason = classifyFailure(revParse);
    return genericUnavailable(
      selectedRoot.root,
      reason,
      reason === "unsafe-repository"
        ? "Git blocked this repository because its ownership is unsafe."
        : "Git status is unavailable for this folder.",
    );
  }
  const rawRepositoryRoot = resolve(revParse.stdout.split(/\r?\n/u)[0]?.trim() ?? "");
  const repositoryRoot = await realpath(rawRepositoryRoot).catch(() => rawRepositoryRoot);
  if (!isContained(repositoryRoot, selectedRoot.realRoot)) {
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
    selectedRootPrefix: toPosix(relative(repositoryRoot, selectedRoot.realRoot)),
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
    const oldRawPath = indexStatus === "R" || indexStatus === "C" ? records[index + 1] : undefined;
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
          ? [await runDiff(repo, options, true, path), await runDiff(repo, options, false, path)]
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
