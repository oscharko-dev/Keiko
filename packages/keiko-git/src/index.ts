// @oscharko-dev/keiko-git — shared git core primitives (ADR: governed git core consolidation).
// One hardened process runner + env, one repository-membership resolution, one failure
// classification. keiko-server consumes these instead of keeping private copies that drift
// apart. keiko-tools imports only the remote-failure classification (its own governed spawn
// surface is a Non-goal per ADR-0115) and keiko-workspace stays spawn-free by design.

export { KEIKO_GIT_VERSION } from "./version.js";

export { gitEnv, networkGitEnv } from "./env.js";
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
