import {
  readGitRemoteAliases,
  readGitRemoteUrl,
  type NodeGitWorktreeReaderDeps,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { sha256Hex } from "@oscharko-dev/keiko-security";
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
  const remoteUrl = await readGitRemoteUrl(deps, "origin");
  const remote = githubOwnerAndRepoFromRemoteUrl(remoteUrl);
  if (remote !== undefined) {
    return { kind: "github-origin", digest: codingWorkbenchRemoteDigest(remote) };
  }
  // #3565 Observation 18: an `origin` on any other host — a customer's own Git server — is a
  // repository the Workbench can run in. It carries no GitHub identity, so issue binding and
  // GitHub delivery stay unavailable, but a local coding run must start. This used to throw
  // `verified-commit-remote-unsupported`, and every customer whose code is not on github.com saw
  // the generic authority failure on their first run.
  return { kind: "foreign-origin", digest: foreignOriginDigest(remoteUrl) };
}

/**
 * The identity digest of a non-GitHub origin: the remote's scheme, host and path, never its
 * credentials, query or fragment, so the same repository yields the same digest whether the
 * checkout embeds a token in its remote URL or not, and the token itself never feeds a digest.
 * A URL the parser refuses (an scp-like `git@host:path`) is digested as written: without URL
 * syntax there is no query or fragment, so `?` and `#` stay part of the path.
 */
export function foreignOriginDigest(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  if (URL.canParse(trimmed)) {
    const parsed = new URL(trimmed);
    return sha256Hex(`origin/${parsed.protocol}//${parsed.host}${parsed.pathname}`);
  }
  // Not a URL the WHATWG parser accepts: an scp-like `git@host:path`, or a malformed URL such as
  // one with an invalid port. Credentials, query and fragment are stripped by hand so a malformed
  // remote can never smuggle a token into the digest either.
  return sha256Hex(`origin/${withoutCredentialsQueryAndFragment(trimmed)}`);
}

function withoutCredentialsQueryAndFragment(remote: string): string {
  const cut = remote.search(/[?#]/u);
  const withoutQuery = cut < 0 ? remote : remote.slice(0, cut);
  const schemeEnd = withoutQuery.indexOf("://");
  // No scheme before the first `?`/`#`: an scp-like remote, where both are path characters.
  if (schemeEnd < 0) return remote;
  const authorityStart = schemeEnd + 3;
  const authorityEnd = withoutQuery.indexOf("/", authorityStart);
  const authority = withoutQuery.slice(
    authorityStart,
    authorityEnd < 0 ? withoutQuery.length : authorityEnd,
  );
  const at = authority.lastIndexOf("@");
  if (at < 0) return withoutQuery;
  const rest = authorityEnd < 0 ? "" : withoutQuery.slice(authorityEnd);
  return `${withoutQuery.slice(0, authorityStart)}${authority.slice(at + 1)}${rest}`;
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
