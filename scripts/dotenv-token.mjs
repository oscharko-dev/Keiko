// Local-`.env` NODE_AUTH_TOKEN/NPM_TOKEN line parsing for the release-publish pipeline
// (scripts/release-publish.mjs). Split out as a side-effect-free module — release-publish.mjs
// runs its whole publish flow unconditionally at import time, so its own tests exercise it only
// as a subprocess; this tiny pure helper needs to be importable directly for regression coverage.

const DOTENV_TOKEN_KEYS = new Set(["NODE_AUTH_TOKEN", "NPM_TOKEN"]);

/**
 * Parses one already-trimmed, non-blank, non-comment `.env` line for a NODE_AUTH_TOKEN/NPM_TOKEN
 * assignment, returning the unquoted value, or `undefined` when the line does not assign one of
 * those two keys.
 *
 * Previously a single regex, `/^(NODE_AUTH_TOKEN|NPM_TOKEN)\s*=\s*(.*)$/u` (flagged by SonarCloud
 * S8786 as a super-linear-backtracking shape). That anchored pattern only ever attempts a single
 * match position and was empirically linear in practice, but is replaced here with plain string
 * operations — indexOf/slice/trim can't backtrack at all — rather than relying on the anchoring
 * guarantee, per the repository's regex-safety remediation policy.
 */
export function parseDotEnvTokenLine(trimmedLine) {
  const equalsIndex = trimmedLine.indexOf("=");
  if (equalsIndex === -1) return undefined;
  const key = trimmedLine.slice(0, equalsIndex).trim();
  if (!DOTENV_TOKEN_KEYS.has(key)) return undefined;
  let value = trimmedLine.slice(equalsIndex + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}
