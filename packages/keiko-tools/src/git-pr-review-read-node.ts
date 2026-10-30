// Node implementation of the read-only pull request list and detail (Issue #4133, ADR-0086).
//
// Runs through the same governed no-shell spawn boundary (`runCommand`) on the governed REMOTE
// lane as the pull request adapter, with its own command rules, and refuses before the spawn any
// argument vector that is not one of the two fixed GraphQL reads (`isGitReviewPullRequestReadArgv`).
// Raw output never leaves this module: callers receive the projected, bounded pull request facts
// and a closed availability state.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type {
  ReviewPullRequestAvailability,
  ReviewPullRequestDetail,
  ReviewPullRequestSummary,
} from "@oscharko-dev/keiko-contracts";
import { REVIEW_PULL_REQUEST_MAX_PAGES } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { Buffer } from "node:buffer";
import { CommandDeniedError } from "./errors.js";
import {
  nodeSpawnFn,
  runCommand,
  type CommandTerminationEvidence,
  type RunCommandDeps,
  type ExecutableResolver,
  type HomeProvider,
  type SpawnFn,
} from "./exec.js";
import {
  buildPrDetailGraphqlArgv,
  buildPrListOpenGraphqlArgv,
  GIT_REVIEW_PULL_REQUEST_COMMAND_RULES,
  isGitReviewPullRequestReadArgv,
  isValidPrDetailRequest,
  isValidPrListRequest,
  parseReviewPullRequestDetail,
  parseReviewPullRequestListPage,
} from "./git-pr-review-read.js";
import { gitRemoteReadWasRedacted } from "./git-remote-read-context.js";
import { GOVERNED_GIT_REMOTE_SANDBOX_POLICY, type CommandResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 1024 * 1024;

export interface NodeGitReviewPullRequestReaderDeps {
  readonly workspace: WorkspaceInfo;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => number) | undefined;
  readonly spawn?: SpawnFn | undefined;
  readonly resolveExecutable?: ExecutableResolver | undefined;
  readonly home?: HomeProvider | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  // The termination-evidence port for every runCommand of this reader (RunCommandDeps deps-level
  // seam, exec.ts): a timed-out or cancelled `gh` leaves its termination on the caller's log.
  readonly onTerminated?: ((evidence: CommandTerminationEvidence) => void) | undefined;
  /** Receives the cause of every read that ends in a closed failure state (body-free evidence). */
  readonly failureSink?: GitReviewPrReadFailureSink | undefined;
}

export interface GitReviewPrReadFailureSink {
  record(failure: GitReviewPrReadFailure, error: unknown): void;
}

export type GitReviewPrReadFailure = Exclude<
  ReviewPullRequestAvailability,
  "available" | "no-github-remote"
>;

export type GitReviewPrListOutcome =
  | {
      readonly availability: "available";
      readonly pullRequests: readonly ReviewPullRequestSummary[];
      readonly truncated: boolean;
      readonly pages: number;
      readonly rejectedCount: number;
    }
  | { readonly availability: GitReviewPrReadFailure; readonly pages: number };

export type GitReviewPrDetailOutcome =
  | { readonly availability: "available"; readonly pullRequest: ReviewPullRequestDetail | null }
  | { readonly availability: GitReviewPrReadFailure };

export interface GitReviewPullRequestReader {
  listOpenPullRequests(ownerAndRepo: string): Promise<GitReviewPrListOutcome>;
  readPullRequest(ownerAndRepo: string, number: number): Promise<GitReviewPrDetailOutcome>;
}

const UNAUTHENTICATED =
  /gh auth login|HTTP 401|bad credentials|authentication required|not logged in/iu;
const RATE_LIMITED = /rate limit|HTTP 429|RATE_LIMITED|secondary rate|abuse detection/iu;
const PULL_REQUEST_NOT_FOUND = /could not resolve to a pullrequest/iu;

function failureFromError(error: Error): GitReviewPrReadFailure {
  if (error instanceof CommandDeniedError && error.message.includes("not found on PATH")) {
    return "gh-unavailable";
  }
  return "failed";
}

function failureFromResult(result: CommandResult): GitReviewPrReadFailure {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode === 4 || UNAUTHENTICATED.test(output)) return "gh-unauthenticated";
  if (RATE_LIMITED.test(output)) return "rate-limited";
  return "failed";
}

type ReadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly failure: GitReviewPrReadFailure; readonly notFound: boolean };

function parseOutput(deps: NodeGitReviewPullRequestReaderDeps, result: CommandResult): ReadResult {
  if (gitRemoteReadWasRedacted(result) || result.truncated || result.timedOut) {
    return { ok: false, failure: "failed", notFound: false };
  }
  if (result.exitCode !== 0) {
    const notFound = PULL_REQUEST_NOT_FOUND.test(`${result.stdout}\n${result.stderr}`);
    return { ok: false, failure: failureFromResult(result), notFound };
  }
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_PAGE_BYTES) {
    return { ok: false, failure: "failed", notFound: false };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) as unknown };
  } catch (error) {
    deps.failureSink?.record("failed", error);
    return { ok: false, failure: "failed", notFound: false };
  }
}

function runDeps(deps: NodeGitReviewPullRequestReaderDeps): RunCommandDeps {
  return {
    workspace: deps.workspace,
    policy: { ...GOVERNED_GIT_REMOTE_SANDBOX_POLICY, outputScrub: "credentials-only" },
    commandRules: GIT_REVIEW_PULL_REQUEST_COMMAND_RULES,
    spawn: deps.spawn ?? nodeSpawnFn,
    processEnv: deps.processEnv ?? process.env,
    now: deps.now ?? Date.now,
    ...(deps.resolveExecutable === undefined ? {} : { resolveExecutable: deps.resolveExecutable }),
    ...(deps.home === undefined ? {} : { home: deps.home }),
  };
}

async function runRead(
  deps: NodeGitReviewPullRequestReaderDeps,
  argv: readonly string[] | undefined,
): Promise<ReadResult> {
  // The exact-argv guard is the allowlist for this lane: nothing but the two fixed reads spawns.
  if (argv === undefined || !isGitReviewPullRequestReadArgv(argv)) {
    return { ok: false, failure: "failed", notFound: false };
  }
  const input = {
    command: "gh",
    args: argv,
    cwd: undefined,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: deps.signal ?? new AbortController().signal,
  };
  try {
    const commandDeps: RunCommandDeps = {
      ...runDeps(deps),
      ...(deps.onTerminated === undefined ? {} : { onTerminated: deps.onTerminated }),
    };
    return parseOutput(deps, await runCommand(input, commandDeps));
  } catch (error) {
    const failure = error instanceof Error ? failureFromError(error) : "failed";
    deps.failureSink?.record(failure, error);
    return { ok: false, failure, notFound: false };
  }
}

interface ListState {
  readonly pullRequests: ReviewPullRequestSummary[];
  pages: number;
  rejectedCount: number;
}

async function listOpen(
  deps: NodeGitReviewPullRequestReaderDeps,
  ownerAndRepo: string,
): Promise<GitReviewPrListOutcome> {
  const state: ListState = { pullRequests: [], pages: 0, rejectedCount: 0 };
  let cursor: string | undefined;
  while (state.pages < REVIEW_PULL_REQUEST_MAX_PAGES) {
    const request = { ownerAndRepo, cursor };
    const read = await runRead(
      deps,
      isValidPrListRequest(request) ? buildPrListOpenGraphqlArgv(request) : undefined,
    );
    state.pages += 1;
    if (!read.ok) return { availability: read.failure, pages: state.pages };
    const page = parseReviewPullRequestListPage(read.value);
    if (page === undefined) return { availability: "failed", pages: state.pages };
    state.pullRequests.push(...page.pullRequests);
    state.rejectedCount += page.rejectedCount;
    cursor = page.nextCursor;
    if (cursor === undefined) return { availability: "available", truncated: false, ...state };
  }
  return { availability: "available", truncated: true, ...state };
}

async function readDetail(
  deps: NodeGitReviewPullRequestReaderDeps,
  ownerAndRepo: string,
  number: number,
): Promise<GitReviewPrDetailOutcome> {
  const request = { ownerAndRepo, number };
  const read = await runRead(
    deps,
    isValidPrDetailRequest(request) ? buildPrDetailGraphqlArgv(request) : undefined,
  );
  if (!read.ok) {
    return read.notFound
      ? { availability: "available", pullRequest: null }
      : { availability: read.failure };
  }
  const pullRequest = parseReviewPullRequestDetail(read.value);
  if (pullRequest === undefined) return { availability: "failed" };
  if (pullRequest !== null && pullRequest.number !== number) return { availability: "failed" };
  return { availability: "available", pullRequest };
}

export function createNodeGitReviewPullRequestReader(
  deps: NodeGitReviewPullRequestReaderDeps,
): GitReviewPullRequestReader {
  const frozen = Object.freeze({ ...deps });
  return {
    listOpenPullRequests: (ownerAndRepo) => listOpen(frozen, ownerAndRepo),
    readPullRequest: (ownerAndRepo, number) => readDetail(frozen, ownerAndRepo, number),
  };
}
