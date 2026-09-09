import {
  readGitRemoteAliases,
  readGitRemoteUrl,
  type NodeGitWorktreeReaderDeps,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { codingWorkbenchRemoteDigest } from "../coding-context/githubIssueResolution.js";
import type { CodingRuntimeTrustedContext } from "../coding-runtime/runtimeAuthorityService.js";
import { githubOwnerAndRepoFromRemoteUrl } from "./branchProtectionPreflight.js";

export type VerifiedRepositoryIdentity = NonNullable<
  CodingRuntimeTrustedContext["repositoryIdentity"]
>;

/** One origin identity producer for both admission and every subsequent live Git boundary. */
export async function readVerifiedRepositoryIdentity(
  deps: NodeGitWorktreeReaderDeps,
  localDigest: string,
  aliases?: readonly string[],
): Promise<VerifiedRepositoryIdentity> {
  const configured = aliases ?? (await readGitRemoteAliases(deps));
  if (!configured.includes("origin")) return { kind: "local", digest: localDigest };
  const remote = githubOwnerAndRepoFromRemoteUrl(await readGitRemoteUrl(deps, "origin"));
  if (remote === undefined) throw new Error("verified-commit-remote-unsupported");
  return { kind: "github-origin", digest: codingWorkbenchRemoteDigest(remote) };
}

/**
 * Resolves the workspace's own live `owner/repo` from its `origin` remote, or `undefined` when no
 * GitHub-shaped origin is configured. Read-only, and — unlike `readVerifiedRepositoryIdentity`
 * above — never falls back to a caller-supplied identity: a Git-delivery mutation route binding a
 * client-supplied `ownerAndRepo` to the workspace's real remote (#3384 B5-8) has nothing legitimate
 * to bind to when the workspace carries no verifiable GitHub origin, so that case must read as "no
 * match", never as an accepted local identity.
 */
export async function readVerifiedGitHubOwnerAndRepo(
  deps: NodeGitWorktreeReaderDeps,
): Promise<string | undefined> {
  const aliases = await readGitRemoteAliases(deps);
  if (!aliases.includes("origin")) return undefined;
  return githubOwnerAndRepoFromRemoteUrl(await readGitRemoteUrl(deps, "origin"));
}
