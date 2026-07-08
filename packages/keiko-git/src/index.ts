// @oscharko-dev/keiko-git — shared git core primitives (ADR: governed git core consolidation).
// One hardened process runner + env, one repository-membership resolution, one failure
// classification. keiko-server, keiko-tools, and keiko-workspace consume these instead of
// keeping private copies that drift apart.

export { gitEnv, networkGitEnv } from "./env.js";
export {
  GIT_BASE_ARGS,
  createGitProcessRunner,
  defaultGitProcessRunner,
  defaultGitNetworkProcessRunner,
} from "./runner.js";
export type { GitProcessOptions, GitProcessResult, GitProcessRunner } from "./types.js";
export {
  containsPath,
  isSafeGitPositional,
  resolveGitMembership,
  type GitMembershipFailure,
  type GitMembershipResolution,
  type GitMembershipSuccess,
  type GitRepositoryMembership,
} from "./resolve.js";
export { classifyGitFailure, type GitFailureReason } from "./classify.js";
