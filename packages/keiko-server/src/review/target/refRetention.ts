// Retention of the private review refs (ADR-0182 D3, ADR-0098, Issue #4133).
//
// `refs/keiko-review/<n>/<headSha>` (and `.../base-<baseSha>`, `refs/keiko-review/local/<leaf>`)
// keep the reviewed objects available after the worktree is gone. A ref is deleted when its pull
// request is closed, when no retained run references it, or after 30 days, whichever comes first.
// The sweep runs at server start and daily, only in repositories the registry names, and only on
// refs under `refs/keiko-review/` (keiko-git refuses any other ref before a spawn).

import { existsSync } from "node:fs";
import { REVIEW_PRIVATE_REF_RETENTION_MS } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import {
  deleteGitReviewRef,
  listGitReviewRefs,
  type GitProcessRunner,
} from "@oscharko-dev/keiko-git";
import type { ServerLogSink } from "../../observability/index.js";
import { logReviewRefsSwept, type ReviewRefSweepTrigger } from "../activity-log.js";
import type { ReviewPrivateRefRecord, ReviewRegistry } from "../worktree/registry.js";
import { reportReviewFailure } from "../diagnostics.js";

export interface ReviewRefRetentionDeps {
  readonly registry: ReviewRegistry;
  readonly runner: (correlationId: string | undefined) => GitProcessRunner;
  readonly activityLog: ServerLogSink;
  readonly now: () => number;
  /** Refs a live worktree or a retained review run still needs, per repository root. */
  readonly retainedRefs: (repositoryRoot: string) => ReadonlySet<string>;
  /** Open pull request numbers when known completely; `undefined` skips the closed-PR criterion. */
  readonly openPullRequests: (repositoryRoot: string) => Promise<ReadonlySet<number> | undefined>;
}

export interface ReviewRefSweepResult {
  readonly deleted: number;
  readonly retained: number;
  readonly failed: number;
}

const PULL_REQUEST_REF = /^refs\/keiko-review\/(\d+)\//u;

function pullRequestNumber(ref: string): number | undefined {
  const digits = PULL_REQUEST_REF.exec(ref)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

interface RepositoryFacts {
  readonly retained: ReadonlySet<string>;
  readonly open: ReadonlySet<number> | undefined;
  readonly records: ReadonlyMap<string, ReviewPrivateRefRecord>;
  readonly nowMs: number;
}

/** Whether one private ref must be deleted now. Exported for the retention rule's unit tests. */
export function reviewRefExpired(ref: string, facts: RepositoryFacts): boolean {
  if (!facts.retained.has(ref)) return true;
  const record = facts.records.get(ref);
  if (record !== undefined && facts.nowMs - record.createdAtMs > REVIEW_PRIVATE_REF_RETENTION_MS) {
    return true;
  }
  const number = pullRequestNumber(ref);
  return number !== undefined && facts.open !== undefined && !facts.open.has(number);
}

/** The closed-pull-request rule is skipped, never guessed, when the open list cannot be read. */
async function openPullRequestsOrUnknown(
  deps: ReviewRefRetentionDeps,
  repositoryRoot: string,
  correlationId: string | undefined,
): Promise<ReadonlySet<number> | undefined> {
  try {
    return await deps.openPullRequests(repositoryRoot);
  } catch (error) {
    reportReviewFailure("review.target.provider-read", correlationId, error);
    return undefined;
  }
}

interface RepositorySweep {
  readonly deleted: number;
  /** Registry records to drop: deleted refs and refs that no longer exist. */
  readonly dropped: readonly string[];
  readonly retained: number;
  readonly failed: number;
}

async function sweepRepository(
  deps: ReviewRefRetentionDeps,
  repositoryRoot: string,
  records: readonly ReviewPrivateRefRecord[],
  correlationId: string | undefined,
): Promise<RepositorySweep> {
  if (!existsSync(repositoryRoot)) {
    return { deleted: 0, dropped: records.map((record) => record.ref), retained: 0, failed: 0 };
  }
  const ctx = { runner: deps.runner(correlationId), timeoutMs: 30_000 };
  const listed = await listGitReviewRefs(ctx, { cwd: repositoryRoot });
  if (!listed.ok) return { deleted: 0, dropped: [], retained: 0, failed: 1 };
  const facts: RepositoryFacts = {
    retained: deps.retainedRefs(repositoryRoot),
    open: await openPullRequestsOrUnknown(deps, repositoryRoot, correlationId),
    records: new Map(records.map((record) => [record.ref, record])),
    nowMs: deps.now(),
  };
  const deleted: string[] = [];
  let failed = 0;
  for (const ref of listed.value.filter((candidate) => reviewRefExpired(candidate, facts))) {
    const outcome = await deleteGitReviewRef(ctx, { cwd: repositoryRoot, ref });
    if (outcome.ok) deleted.push(ref);
    else failed += 1;
  }
  const stale = records
    .filter((record) => !listed.value.includes(record.ref))
    .map((record) => record.ref);
  return {
    deleted: deleted.length,
    dropped: [...deleted, ...stale],
    retained: listed.value.length - deleted.length - failed,
    failed,
  };
}

export async function sweepReviewRefs(
  deps: ReviewRefRetentionDeps,
  trigger: ReviewRefSweepTrigger,
  correlationId?: string,
): Promise<ReviewRefSweepResult> {
  const snapshot = await deps.registry.read();
  const repositories = new Set(
    [...snapshot.refs, ...snapshot.worktrees].map((entry) => entry.repositoryRoot),
  );
  const removedRecords = new Set<string>();
  let deleted = 0;
  let retained = 0;
  let failed = 0;
  for (const repositoryRoot of repositories) {
    const records = snapshot.refs.filter((record) => record.repositoryRoot === repositoryRoot);
    const result = await sweepRepository(deps, repositoryRoot, records, correlationId);
    for (const ref of result.dropped) removedRecords.add(`${repositoryRoot}\n${ref}`);
    deleted += result.deleted;
    retained += result.retained;
    failed += result.failed;
  }
  await deps.registry.update((current) => ({
    ...current,
    refs: current.refs.filter(
      (record) => !removedRecords.has(`${record.repositoryRoot}\n${record.ref}`),
    ),
  }));
  logReviewRefsSwept(deps.activityLog, correlationId, {
    trigger,
    deletedCount: deleted,
    retainedCount: retained,
    failedCount: failed,
  });
  return { deleted, retained, failed };
}
