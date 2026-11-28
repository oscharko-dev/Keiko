import {
  GitRawWorktreeReadError,
  readGitRawChangesAtHead,
  readGitRemoteAliases,
  readGitBaseState,
  gitCommitMessageDigest,
  gitHeadStateObjectId,
  sameGitHeadState,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { readVerifiedRepositoryIdentity } from "./verifiedRepositoryIdentity.js";
import { gitDeliveryTerminationHandler, type GitDeliveryExecutionSeams } from "./execution.js";
import {
  logDeniedPathExclusion,
  logLargeFilesStreamed,
  withStagedConversion,
} from "./runtimeGitRead.js";
import {
  VERIFIED_COMMIT_BLOCKING_PATHS_MAX,
  type VerifiedCommitBlockingPaths,
  type VerifiedCommitFacts,
  type VerifiedCommitRunContext,
} from "./verifiedCommitTypes.js";

function cleanCandidate(context: VerifiedCommitRunContext, raw: VerifiedRawRead): boolean {
  return (
    context.buffersClean() &&
    // A nested repository is an untracked entry Git reports as one directory: it never expands into
    // `changes`, yet it lies outside the reviewed candidate exactly as an untracked file does.
    raw.opaqueUntrackedCount === 0 &&
    !raw.changes.some((file) => file.unstaged || file.untracked) &&
    context.stillAuthorized()
  );
}

// The paths that keep the candidate from being clean. The two lists are cut at
// VERIFIED_COMMIT_BLOCKING_PATHS_MAX; the counts stay exact.
function blockingPathsOf(raw: VerifiedRawRead): VerifiedCommitBlockingPaths {
  const unstaged = raw.changes.filter((file) => file.unstaged && !file.untracked);
  const untracked = [
    ...raw.changes.filter((file) => file.untracked).map((file) => file.path),
    ...raw.opaqueUntrackedPaths,
  ];
  return {
    unstagedCount: unstaged.length,
    untrackedCount: untracked.length,
    unstaged: unstaged.slice(0, VERIFIED_COMMIT_BLOCKING_PATHS_MAX).map((file) => file.path),
    untracked: untracked.slice(0, VERIFIED_COMMIT_BLOCKING_PATHS_MAX),
  };
}

// Full access commits the staged candidate while untracked files lie outside it, as a plain `git
// commit` does (owner decision 2026-10-30, #3907): the parity lane's own `npm install` had left an
// untracked package-lock.json, and the model, which rightly kept it out of the commit, read
// candidate-not-staged until the run's deadline. Unstaged changes and unsaved buffers still refuse.
// The push of that commit re-reads the same facts and admits the same files (lab T17, round I).
export function untrackedOutsideCandidate(
  context: VerifiedCommitRunContext,
  facts: VerifiedCommitFacts,
): boolean {
  const blocking = facts.blocking;
  return (
    !facts.clean &&
    blocking?.unstagedCount === 0 &&
    blocking.untrackedCount > 0 &&
    context.buffersClean()
  );
}

export function verifiedCommitMessageDigest(message: string): string {
  return gitCommitMessageDigest(message);
}

export type VerifiedRawRead = Awaited<ReturnType<typeof readGitRawChangesAtHead>>;

/** The facts together with the raw read they were derived from. */
export interface VerifiedCommitRead {
  readonly facts: VerifiedCommitFacts;
  readonly raw: VerifiedRawRead;
}

export async function readVerifiedCommitFacts(
  context: VerifiedCommitRunContext,
  seams: GitDeliveryExecutionSeams,
): Promise<VerifiedCommitFacts> {
  return (await readVerifiedCommitRead(context, seams)).facts;
}

/**
 * The facts together with the raw read they were derived from, so a caller that also answers from
 * the raw changes (the runtime `status` action) reuses this one scan instead of running a second
 * (#4491, W-4: a second scan doubled the Git process count of every status).
 */
export async function readVerifiedCommitRead(
  context: VerifiedCommitRunContext,
  seams: GitDeliveryExecutionSeams,
): Promise<VerifiedCommitRead> {
  if (!context.stillAuthorized() || context.signal?.aborted === true)
    throw new Error("verified-commit-authority-unavailable");
  const readBase = {
    workspace: context.workspace,
    processEnv: seams.processEnv,
    signal: context.signal,
    onTerminated: gitDeliveryTerminationHandler(seams, context.correlationId),
    ...(context.readSession === undefined ? {} : { readSession: context.readSession }),
  };
  const deps = withStagedConversion(readBase, seams, context.correlationId);
  // ONE raw read supplies the facts AND an unclean candidate's blocking paths, so the paths can never
  // contradict the refusal they ride on. They used to come from a second read taken after this one,
  // with no cross-check (review finding on PR #3452).
  const raw = await readGitRawChangesAtHead(deps);
  if (raw.truncated) throw new GitRawWorktreeReadError("git-raw-snapshot-incomplete");
  logDeniedPathExclusion(seams, context.correlationId, raw.deniedPathCount);
  logLargeFilesStreamed(seams, context.correlationId, "status", raw);
  const base = await readGitBaseState(deps, context.baseRef, raw.head);
  if (raw.branch !== context.headRef) throw new Error("verified-commit-repository-drift");
  const { digest: repositoryDigest } = await readVerifiedRepositoryIdentity(
    deps,
    context.workspaceDigest,
    await readGitRemoteAliases(deps),
  );
  if (repositoryDigest !== context.repositoryDigest)
    throw new Error("verified-commit-repository-drift");
  const clean = cleanCandidate(context, raw);
  return {
    raw,
    facts: {
      head: raw.head,
      base,
      stagedTreeDigest: raw.stagedTreeDigest,
      repositoryDigest,
      clean,
      ...(clean ? {} : { blocking: blockingPathsOf(raw) }),
    },
  };
}

export function sameVerifiedCommitFacts(a: VerifiedCommitFacts, b: VerifiedCommitFacts): boolean {
  return (
    a.clean &&
    b.clean &&
    sameGitHeadState(a.head, b.head) &&
    sameGitHeadState(a.base, b.base) &&
    a.stagedTreeDigest === b.stagedTreeDigest &&
    a.repositoryDigest === b.repositoryDigest
  );
}

// A persisted binding records a head as one object id: the commit, or the all-zero id of an unborn
// branch. These are the only conversions from the explicit state to that string.
export function verifiedHeadObjectId(facts: Pick<VerifiedCommitFacts, "head">): string {
  return gitHeadStateObjectId(facts.head);
}
export function verifiedBaseObjectId(facts: Pick<VerifiedCommitFacts, "base">): string {
  return gitHeadStateObjectId(facts.base);
}
