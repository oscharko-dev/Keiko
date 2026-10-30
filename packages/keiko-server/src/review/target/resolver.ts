// The review target resolver (ADR-0182 D3, Issue #4133). Not a route: the review run calls it in
// its `preparing` phase.
//
// A pull request resolves to the base and head SHAs GitHub reports NOW (never a cached answer),
// then `refs/pull/<n>/head` is fetched with the hardened review runner into the private ref named
// for that head. The fetched object must BE that head: anything else means the pull request moved
// between the read and the fetch, and the target is refused as `target-changed` (the run settles
// `skipped`). A local range resolves both refs with `rev-parse --verify <ref>^{commit}`. The user's
// branches, HEAD, index, working tree, stash and FETCH_HEAD are never written; the only repository
// change is the private ref, which the retention sweep removes.

import type {
  ReviewTarget,
  ReviewTargetRefusalReason,
  ReviewTargetRequest,
} from "@oscharko-dev/keiko-contracts";
import { REVIEW_PULL_REQUEST_NUMBER_MAX } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { validateReviewTarget } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-validation";
import {
  isGitObjectId,
  isSafeGitRefName,
} from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import {
  createGitReviewRef,
  deleteGitReviewRef,
  fetchGitReviewCommit,
  fetchGitReviewPullRequestHead,
  gitReviewCommitExists,
  gitReviewLocalRangeRef,
  gitReviewPullRequestBaseRef,
  gitReviewPullRequestRef,
  resolveGitReviewCommit,
  type GitProcessRunner,
  type GitReviewOperationContext,
} from "@oscharko-dev/keiko-git";
import type { ReviewPullRequestDetail } from "@oscharko-dev/keiko-contracts";
import type { ServerLogSink } from "../../observability/index.js";
import { deriveRepositoryId } from "../../task-workspace/naming.js";
import {
  logReviewTargetRefused,
  logReviewTargetResolved,
  type ReviewTargetResolvedLine,
} from "../activity-log.js";
import type { ReviewPrivateRefRecord, ReviewRegistry } from "../worktree/registry.js";
import type { ReviewGitHubRepositoryPort } from "./pullRequestReads.js";
import { reviewRunLeaf } from "../worktree/leaf.js";
import { reportReviewFailure } from "../diagnostics.js";

/** The remote every pull request fetch uses; the GitHub port verifies it names a GitHub repository. */
export const REVIEW_FETCH_REMOTE = "origin";
const FETCH_TIMEOUT_MS = 120_000;

export type ReviewTargetResolution =
  | { readonly ok: true; readonly target: ReviewTarget; readonly privateRefs: readonly string[] }
  | { readonly ok: false; readonly reason: ReviewTargetRefusalReason };

export interface ReviewTargetResolverDeps {
  readonly github: ReviewGitHubRepositoryPort;
  /** Observed review runners: local operations and the credential-capable fetch. */
  readonly localRunner: (correlationId: string | undefined) => GitProcessRunner;
  readonly networkRunner: (correlationId: string | undefined) => GitProcessRunner;
  readonly registry: ReviewRegistry;
  readonly activityLog: ServerLogSink;
  readonly now: () => number;
}

export interface ReviewTargetResolveInput {
  readonly repositoryRoot: string;
  readonly runId: string;
  readonly request: ReviewTargetRequest;
  readonly correlationId?: string | undefined;
}

type ResolvedFacts = Omit<ReviewTargetResolvedLine, "durationMs">;

interface Resolved {
  readonly target: ReviewTarget;
  readonly refs: readonly string[];
  readonly facts: ResolvedFacts;
}

type Step<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ReviewTargetRefusalReason };

function refused<T>(reason: ReviewTargetRefusalReason): Step<T> {
  return { ok: false, reason };
}

function localContext(
  deps: ReviewTargetResolverDeps,
  correlationId: string | undefined,
): GitReviewOperationContext {
  return { runner: deps.localRunner(correlationId), timeoutMs: 30_000 };
}

async function recordRefs(
  deps: ReviewTargetResolverDeps,
  repositoryRoot: string,
  refs: readonly string[],
  pullRequestNumber?: number,
): Promise<void> {
  const createdAtMs = deps.now();
  const records: ReviewPrivateRefRecord[] = refs.map((ref) => ({
    ref,
    repositoryRoot,
    createdAtMs,
    ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
  }));
  await deps.registry.update((snapshot) => ({
    ...snapshot,
    refs: [
      ...snapshot.refs.filter(
        (entry) => !refs.includes(entry.ref) || entry.repositoryRoot !== repositoryRoot,
      ),
      ...records,
    ],
  }));
}

const DETAIL_REFUSALS: Readonly<Record<string, ReviewTargetRefusalReason>> = {
  "gh-unavailable": "gh-unavailable",
  "gh-unauthenticated": "gh-unauthenticated",
  "rate-limited": "rate-limited",
  failed: "fetch-failed",
};

async function readReportedPullRequest(
  deps: ReviewTargetResolverDeps,
  repositoryRoot: string,
  number: number,
  correlationId: string | undefined,
): Promise<Step<{ readonly ownerAndRepo: string; readonly detail: ReviewPullRequestDetail }>> {
  const ownerAndRepo = await deps.github.ownerAndRepo(repositoryRoot);
  if (ownerAndRepo === undefined) return refused("no-github-remote");
  const outcome = await deps.github
    .readerFor(repositoryRoot, correlationId)
    .readPullRequest(ownerAndRepo, number);
  if (outcome.availability !== "available") {
    return refused(DETAIL_REFUSALS[outcome.availability] ?? "fetch-failed");
  }
  if (outcome.pullRequest === null) return refused("not-found");
  return { ok: true, value: { ownerAndRepo, detail: outcome.pullRequest } };
}

async function fetchAndVerifyHead(
  deps: ReviewTargetResolverDeps,
  repositoryRoot: string,
  detail: ReviewPullRequestDetail,
  correlationId: string | undefined,
): Promise<Step<string>> {
  const network = { runner: deps.networkRunner(correlationId), timeoutMs: FETCH_TIMEOUT_MS };
  const fetched = await fetchGitReviewPullRequestHead(network, {
    cwd: repositoryRoot,
    remote: REVIEW_FETCH_REMOTE,
    number: detail.number,
    headSha: detail.headSha,
  });
  if (!fetched.ok) return refused("fetch-failed");
  const ref = gitReviewPullRequestRef(detail.number, detail.headSha);
  const local = localContext(deps, correlationId);
  const resolved = await resolveGitReviewCommit(local, { cwd: repositoryRoot, ref });
  if (resolved.ok && resolved.value === detail.headSha) return { ok: true, value: ref };
  // The ref is named for the reported head but holds another object: never leave it behind.
  await deleteGitReviewRef(local, { cwd: repositoryRoot, ref });
  return refused(resolved.ok ? "target-changed" : "fetch-failed");
}

async function ensureBaseCommit(
  deps: ReviewTargetResolverDeps,
  repositoryRoot: string,
  detail: ReviewPullRequestDetail,
  correlationId: string | undefined,
): Promise<Step<string | undefined>> {
  const local = localContext(deps, correlationId);
  const present = await gitReviewCommitExists(local, { cwd: repositoryRoot, sha: detail.baseSha });
  if (present.ok && present.value) return { ok: true, value: undefined };
  const network = { runner: deps.networkRunner(correlationId), timeoutMs: FETCH_TIMEOUT_MS };
  const fetched = await fetchGitReviewCommit(network, {
    cwd: repositoryRoot,
    remote: REVIEW_FETCH_REMOTE,
    number: detail.number,
    sha: detail.baseSha,
  });
  const ref = gitReviewPullRequestBaseRef(detail.number, detail.baseSha);
  const after = await resolveGitReviewCommit(local, { cwd: repositoryRoot, ref });
  if (fetched.ok && after.ok && after.value === detail.baseSha) return { ok: true, value: ref };
  return refused("fetch-failed");
}

function validatedTarget(candidate: ReviewTarget): Step<ReviewTarget> {
  const validation = validateReviewTarget(candidate);
  return validation.ok ? { ok: true, value: validation.value } : refused("ref-invalid");
}

async function resolvePullRequest(
  deps: ReviewTargetResolverDeps,
  input: ReviewTargetResolveInput,
  number: number,
): Promise<Step<Resolved>> {
  const reported = await readReportedPullRequest(
    deps,
    input.repositoryRoot,
    number,
    input.correlationId,
  );
  if (!reported.ok) return reported;
  const { detail } = reported.value;
  const fetchStartedMs = deps.now();
  const head = await fetchAndVerifyHead(deps, input.repositoryRoot, detail, input.correlationId);
  if (!head.ok) return head;
  const base = await ensureBaseCommit(deps, input.repositoryRoot, detail, input.correlationId);
  const refs = base.ok && base.value !== undefined ? [head.value, base.value] : [head.value];
  await recordRefs(deps, input.repositoryRoot, refs, detail.number);
  if (!base.ok) return base;
  const target = validatedTarget({
    kind: "pull-request",
    provider: "github",
    repositoryId: deriveRepositoryId(input.repositoryRoot),
    number: detail.number,
    baseSha: detail.baseSha,
    headSha: detail.headSha,
    baseRef: detail.baseRef,
    headRef: detail.headRef,
    isCrossRepository: detail.isCrossRepository,
  });
  if (!target.ok) return target;
  const facts: ResolvedFacts = {
    targetKind: "pull-request",
    baseSha: detail.baseSha,
    headSha: detail.headSha,
    isCrossRepository: detail.isCrossRepository,
    baseFetched: refs.length > 1,
    fetchDurationMs: Math.max(0, deps.now() - fetchStartedMs),
  };
  return { ok: true, value: { target: target.value, refs, facts } };
}

function resolvePullRequestNumber(
  deps: ReviewTargetResolverDeps,
  input: ReviewTargetResolveInput,
  number: number,
): Promise<Step<Resolved>> {
  if (!Number.isSafeInteger(number) || number < 1 || number > REVIEW_PULL_REQUEST_NUMBER_MAX) {
    return Promise.resolve(refused("not-found"));
  }
  return resolvePullRequest(deps, input, number);
}

function isLocalRefName(value: string): boolean {
  return !value.startsWith("refs/") && isSafeGitRefName(value);
}

async function resolveLocalRange(
  deps: ReviewTargetResolverDeps,
  input: ReviewTargetResolveInput,
  baseRef: string,
  headRef: string,
): Promise<Step<Resolved>> {
  if (!isLocalRefName(baseRef) || !isLocalRefName(headRef)) return refused("ref-invalid");
  const local = localContext(deps, input.correlationId);
  const base = await resolveGitReviewCommit(local, { cwd: input.repositoryRoot, ref: baseRef });
  const head = await resolveGitReviewCommit(local, { cwd: input.repositoryRoot, ref: headRef });
  if (!base.ok || !head.ok || !isGitObjectId(base.value) || !isGitObjectId(head.value)) {
    return refused("ref-invalid");
  }
  const ref = gitReviewLocalRangeRef(reviewRunLeaf(input.runId));
  const created = await createGitReviewRef(local, {
    cwd: input.repositoryRoot,
    ref,
    sha: head.value,
  });
  if (!created.ok) return refused("ref-invalid");
  await recordRefs(deps, input.repositoryRoot, [ref]);
  const target = validatedTarget({
    kind: "local-range",
    repositoryId: deriveRepositoryId(input.repositoryRoot),
    baseSha: base.value,
    headSha: head.value,
    baseRef,
    headRef,
  });
  if (!target.ok) return target;
  const facts: ResolvedFacts = {
    targetKind: "local-range",
    baseSha: base.value,
    headSha: head.value,
  };
  return { ok: true, value: { target: target.value, refs: [ref], facts } };
}

export async function resolveReviewTarget(
  deps: ReviewTargetResolverDeps,
  input: ReviewTargetResolveInput,
): Promise<ReviewTargetResolution> {
  const request = input.request;
  const startedMs = deps.now();
  let step: Step<Resolved>;
  try {
    step =
      request.kind === "pull-request"
        ? await resolvePullRequestNumber(deps, input, request.number)
        : await resolveLocalRange(deps, input, request.baseRef, request.headRef);
  } catch (error) {
    // A malformed operand (a GitReviewOperandError) or an unreadable repository: fail closed.
    reportReviewFailure("review.target.resolve", input.correlationId, error);
    step = refused(request.kind === "pull-request" ? "fetch-failed" : "ref-invalid");
  }
  if (!step.ok) {
    logReviewTargetRefused(deps.activityLog, input.correlationId, request.kind, step.reason);
    return { ok: false, reason: step.reason };
  }
  logReviewTargetResolved(deps.activityLog, input.correlationId, {
    ...step.value.facts,
    durationMs: Math.max(0, deps.now() - startedMs),
  });
  return { ok: true, target: step.value.target, privateRefs: step.value.refs };
}
