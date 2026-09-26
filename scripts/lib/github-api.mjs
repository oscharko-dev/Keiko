// The one read primitive every release-automation module shares (release-candidate.mjs,
// release-automation.mjs). It lives here, not in either of them, so those modules can depend on each
// other without a cycle.

class GithubApiError extends Error {}

function fail(message) {
  throw new GithubApiError(`github-api: ${message}`);
}

// Why a read failed, in terms a report may carry: the child's error code (ENOBUFS when the answer
// outgrew the output buffer, ETIMEDOUT), else the HTTP status gh names, else its exit status. The
// 1.1.9 release request failed as a bare "could not be read" for an ENOBUFS nobody could see.
function failureReason(result) {
  if (typeof result?.error?.code === "string") return result.error.code;
  const status = /\bHTTP (\d{3})\b/u.exec(String(result?.stderr ?? ""))?.[1];
  return status === undefined ? `exit ${String(result?.status)}` : `HTTP ${status}`;
}

export function readGithub(runGh, path) {
  const result = runGh(["api", path]);
  if (result?.error === undefined && result?.status === 0) {
    try {
      return { kind: "found", value: JSON.parse(String(result.stdout)) };
    } catch {
      return { kind: "error", reason: "unparseable answer" };
    }
  }
  return /\bHTTP 404\b/u.test(String(result?.stderr ?? ""))
    ? { kind: "missing" }
    : { kind: "error", reason: failureReason(result) };
}

/** A GitHub API read that must succeed; any failure, a 404 included, fails closed. */
export function readFound(runGh, path, label) {
  const read = readGithub(runGh, path);
  if (read.kind === "missing") fail(`${label} could not be read (HTTP 404).`);
  if (read.kind === "error") fail(`${label} could not be read (${read.reason}).`);
  return read.value;
}
