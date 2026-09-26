/**
 * ONE owner for how the release-owner allowlist resolves. `.github/workflows/release.yml`
 * injects `KEIKO_RELEASE_OWNER_GITHUB_LOGINS` into CI publishes, but a local operator shell does
 * not carry it — and the approval verifier refuses EVERY approval over an empty allowlist, so
 * without this resolution the documented local publish and the public-release producer both
 * deterministically abort (0.3.1 operator outages, Codex finding on #3054). When the environment
 * does not provide the value, the same repository variable the workflow reads answers.
 */

function parsedVariableValue(stdout) {
  try {
    const { value } = JSON.parse(String(stdout ?? ""));
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param configured the environment-provided allowlist, if any
 * @param repository `owner/name`
 * @param runGh      (args) => {status, stdout, error} — the caller's gh seam
 * @returns the resolved allowlist string, or undefined when it does not resolve
 */
export function resolveReleaseOwnerAllowlist({ configured, repository, runGh }) {
  if (typeof configured === "string" && configured.trim() !== "") return configured;
  const result = runGh([
    "api",
    `repos/${repository}/actions/variables/KEIKO_RELEASE_OWNER_GITHUB_LOGINS`,
  ]);
  if (result?.error !== undefined || result?.status !== 0) return undefined;
  return parsedVariableValue(result.stdout);
}
