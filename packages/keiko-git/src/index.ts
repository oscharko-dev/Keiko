// @oscharko-dev/keiko-git — shared git core primitives (ADR: governed git core consolidation).
// One hardened process runner + env, one repository-membership resolution, one failure
// classification. keiko-server consumes these instead of keeping private copies that drift
// apart. keiko-tools imports only the remote-failure classification (its own governed spawn
// surface is a Non-goal per ADR-0115) and keiko-workspace stays spawn-free by design.

export { KEIKO_GIT_VERSION } from "./version.js";

export { gitEnv, gitReviewEnv, networkGitEnv, networkGitReviewEnv } from "./env.js";
export { resolveGitExecutable } from "./git-executable.js";
export {
  GIT_BASE_ARGS,
  createGitProcessRunner,
  defaultGitProcessRunner,
  defaultGitNetworkProcessRunner,
  gitSubcommand,
} from "./runner.js";
export type {
  GitProcessOptions,
  GitProcessResult,
  GitProcessRunner,
  GitRefusalClass,
} from "./types.js";
export {
  comparablePath,
  containsPath,
  isSafeGitPositional,
  resolveGitMembership,
  type GitMembershipFailure,
  type GitMembershipResolution,
  type GitMembershipSuccess,
  type GitRepositoryMembership,
} from "./resolve.js";
export {
  GIT_REMOTE_FAILURE_REASONS,
  classifyGitFailure,
  classifyGitRemoteFailure,
  type GitFailureReason,
  type GitRemoteFailureReason,
} from "./classify.js";
export {
  GIT_REVIEW_HARDENING_CONFIG,
  createGitReviewNetworkProcessRunner,
  createGitReviewProcessRunner,
  gitReviewFilterNeutralizationArgs,
  gitReviewFixedArgs,
  isSafeGitFilterDriverName,
  type GitReviewRunnerOptions,
} from "./review-runner.js";
export {
  GIT_REVIEW_PRIVATE_REF_PREFIX,
  GIT_REVIEW_WORKTREE_LOCK_REASON,
  GitReviewOperandError,
  addGitReviewWorktree,
  checkoutGitReviewWorktree,
  createGitReviewRef,
  deleteGitReviewRef,
  fetchGitReviewCommit,
  fetchGitReviewPullRequestHead,
  gitReviewCommitExists,
  gitReviewLocalRangeRef,
  gitReviewPullRequestBaseRef,
  gitReviewPullRequestRef,
  isGitReviewPrivateRef,
  listGitReviewBinaryPaths,
  listGitReviewConfiguredFilterDrivers,
  listGitReviewRefs,
  listGitReviewTree,
  listGitReviewWorktrees,
  readGitReviewBlob,
  readGitReviewTreeIntoIndex,
  removeGitReviewWorktree,
  resolveGitReviewCommit,
  showGitReviewFile,
  skipGitReviewWorktreePaths,
  unlockGitReviewWorktree,
  type GitReviewFetchRequest,
  type GitReviewOperationContext,
  type GitReviewOperationResult,
  type GitReviewTreeEntry,
  type GitReviewWorktreeListEntry,
} from "./review-operations.js";
