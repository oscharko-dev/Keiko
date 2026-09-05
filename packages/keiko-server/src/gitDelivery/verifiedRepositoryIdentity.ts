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
