// The one read primitive every release-automation module shares (release-candidate.mjs,
// release-automation.mjs). It lives here, not in either of them, so those modules can depend on each
// other without a cycle.

class GithubApiError extends Error {}

function fail(message) {
  throw new GithubApiError(`github-api: ${message}`);
}

export function readGithub(runGh, path) {
  const result = runGh(["api", path]);
  if (result?.error === undefined && result?.status === 0) {
    try {
      return { kind: "found", value: JSON.parse(String(result.stdout)) };
    } catch {
      return { kind: "error" };
    }
  }
  return /\bHTTP 404\b/u.test(String(result?.stderr ?? ""))
    ? { kind: "missing" }
    : { kind: "error" };
}

/** A GitHub API read that must succeed; any failure, a 404 included, fails closed. */
export function readFound(runGh, path, label) {
  const read = readGithub(runGh, path);
  if (read.kind !== "found") fail(`${label} could not be read.`);
  return read.value;
}
