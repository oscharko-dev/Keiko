/**
 * ONE owner for resolving `owner/repo`. `scripts/release-publish.mjs` carried this derivation
 * privately; `scripts/check-release-alignment.mjs` needs the exact same precedence (a GitHub
 * Actions job's `GITHUB_REPOSITORY`, falling back to the `origin` git remote for a local
 * operator run) so the alignment gate reads the same repository the publish path publishes to.
 * Extracted so neither script grows its own copy (AGENTS.md section 5: reuse first).
 */

function githubRepositoryFromRemote(remoteUrl) {
  const trimmed = remoteUrl.trim();
  const httpsMatch = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/u.exec(trimmed);
  if (httpsMatch !== null) return httpsMatch[1];
  const sshMatch = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/u.exec(trimmed);
  if (sshMatch !== null) return sshMatch[1];
  return undefined;
}

/**
 * @param env    process.env-like object
 * @param runGit (args) => {status, stdout, ...} — the caller's git seam
 * @returns `owner/repo`, or undefined when neither source resolves
 */
export function resolveGithubRepository({ env, runGit }) {
  if (typeof env.GITHUB_REPOSITORY === "string" && env.GITHUB_REPOSITORY.includes("/")) {
    return env.GITHUB_REPOSITORY;
  }
  const remote = runGit(["remote", "get-url", "origin"]);
  if (remote?.status === 0) {
    const repository = githubRepositoryFromRemote(remote.stdout);
    if (repository !== undefined) return repository;
  }
  return undefined;
}
