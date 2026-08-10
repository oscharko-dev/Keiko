/**
 * ONE owner for the release-publish preflight decisions. `scripts/release-publish.mjs` only ever
 * runs as a spawned CLI, so every branch that lives there is untested by construction — the
 * decisions themselves belong here, where in-process tests can prove both sides of every guard
 * (the 0.3.1 outages: a hardcoded `--provenance` outside OIDC and an allowlist only CI carried
 * each aborted a documented operator publish).
 */

import { resolveReleaseOwnerAllowlist } from "./release-owner-allowlist.mjs";

/**
 * npm can attest provenance only where an OIDC provider exists — GitHub Actions announces its
 * id-token endpoint through these environment values. Everywhere else the flag makes
 * `npm publish` fail outright. A token publish simply carries no provenance attestation,
 * exactly like every release before attestation existed. The identity exchange needs BOTH
 * values GitHub Actions issues under `id-token: write`; the request URL alone cannot mint a
 * token (CodeRabbit finding on #3055).
 */
export function oidcTrustedPublishingAvailable(env) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  return typeof url === "string" && url.length > 0 && typeof token === "string" && token.length > 0;
}

export function provenancePublishArgs(env) {
  return oidcTrustedPublishingAvailable(env) ? ["--provenance"] : [];
}

/**
 * A live publish that would only discover a missing npm auth path AFTER the twenty-minute gate
 * chain wastes the whole run — this answers the auth question at preflight time. The dot-env
 * fallback is a thunk so a dry run never touches the operator's `.env` file at all.
 *
 * @returns the refusal message, or undefined when an auth path exists
 */
export function npmAuthPreflightFailure({ dryRun, env, dotEnvToken }) {
  if (dryRun || oidcTrustedPublishingAvailable(env)) return undefined;
  // Falsy precedence, not nullish: a CI job exporting an unset secret yields an empty string,
  // which must fall through to the next auth source instead of stopping the chain as a false
  // refusal (CodeRabbit finding on #3063).
  if (env.NODE_AUTH_TOKEN || env.NPM_TOKEN || dotEnvToken()) return undefined;
  return (
    "no npm auth path is available: set NODE_AUTH_TOKEN or NPM_TOKEN (or a local .env), " +
    "or run in CI where OIDC trusted publishing authenticates."
  );
}

/**
 * The publish-time approval verifier refuses every approval over an empty allowlist; the child
 * environment must carry the resolved value and a repository identity before it runs, so a local
 * operator publish does not abort on an environment value only CI used to carry (the 0.3.1
 * outage).
 *
 * @returns `{ env }` ready for the release-impact child, or `{ failure }` when unresolved
 */
export function releaseOwnerPublishEnv({ baseEnv, allowlist, repository }) {
  if (allowlist === undefined) {
    return {
      failure:
        "the release-owner allowlist did not resolve: set KEIKO_RELEASE_OWNER_GITHUB_LOGINS " +
        "or grant this checkout a gh login that can read the repository variable.",
    };
  }
  const env = { ...baseEnv, KEIKO_RELEASE_OWNER_GITHUB_LOGINS: allowlist };
  env.GITHUB_REPOSITORY = env.GITHUB_REPOSITORY ?? repository;
  return { env };
}

/**
 * The complete preflight for the release-impact child: a plan-only run carries the environment
 * unchanged, everything else resolves the owner allowlist (environment first, then the same
 * repository variable the workflow reads, through the caller's gh seam) and answers the auth
 * question before any gate runs.
 *
 * @param tools `{ gh, githubRepository, loadDotEnvToken }` — the caller's process seams
 * @returns `{ env }` ready for the child, or `{ failure }` with the refusal message
 */
export function releaseImpactChildEnv(options, baseEnv, tools) {
  if (options.planOnly) return { env: { ...baseEnv } };
  const repository = tools.githubRepository();
  const resolved = releaseOwnerPublishEnv({
    baseEnv,
    allowlist: resolveReleaseOwnerAllowlist({
      configured: baseEnv.KEIKO_RELEASE_OWNER_GITHUB_LOGINS,
      repository,
      runGh: tools.gh,
    }),
    repository,
  });
  if (resolved.env === undefined) return resolved;
  const failure = npmAuthPreflightFailure({
    dryRun: options.dryRun,
    env: baseEnv,
    dotEnvToken: tools.loadDotEnvToken,
  });
  return failure === undefined ? resolved : { failure };
}

/**
 * The verdict over a streamed artifact download: the transfer must have exited cleanly AND the
 * landed bytes must respect the same archive ceiling every portable input honors — a stalled or
 * oversized transfer refuses instead of handing corrupt or unbounded bytes to extraction.
 */
export function artifactDownloadOutcome({ spawnError, exitStatus, landedBytes, maxBytes }) {
  if (spawnError !== undefined || exitStatus !== 0) return { status: 1 };
  if (landedBytes > maxBytes) return { status: 1 };
  return { status: 0 };
}
