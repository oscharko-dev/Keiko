# ADR-0130: npm Trusted Publishing for the Release Pipeline

## Status

Accepted (2026-07-11). Allocated after refreshing `origin/dev` (highest existing ADR: 0129) and
checking open pull requests; no in-flight ADR claims 0130.

## Context

`.github/workflows/release.yml`'s `publish` job (the only job that calls `npm publish`) has
authenticated to the npm registry with a classic long-lived access token stored as the GitHub
Actions secret `NPM_TOKEN`, injected as `NODE_AUTH_TOKEN` for the "Publish package" step and
consumed by `scripts/release-publish.mjs`'s `createNpmEnvironment()`. A long-lived registry token
is a standing secret: it does not expire on its own, it is usable from anywhere it leaks to, and
compromising it is enough to publish arbitrary versions of `@oscharko-dev/keiko` to every
developer who installs or updates it — exactly the kind of supply-chain risk this repository's
existing controls (pinned action SHAs, SBOM gates, provenance, the workspace-supply-chain check)
are already built to reduce elsewhere.

npm shipped OIDC-based [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) as
generally available in July 2025: a GitHub Actions job with `id-token: write` permission can
exchange a short-lived, workflow-scoped OIDC token for a just-in-time npm credential, with no
stored secret at all. The `publish` job already carried `id-token: write` (added earlier for
`npm publish --provenance`, which needs it independently for Sigstore-signed build provenance),
so the missing piece was purely: stop supplying `NODE_AUTH_TOKEN`, and satisfy trusted
publishing's own prerequisites.

Two prerequisites are not automatic:

1. **npm CLI version.** Trusted publishing requires npm CLI `>= 11.5.1`. `actions/setup-node`
   with `node-version: "22.x"` does not bundle a new-enough npm, and this repository's root
   `packageManager`/`engines.npm` fields (`npm@10.9.8` / `>=10.9.0`) are older still. Bumping those
   repo-wide fields would force every contributor and every other CI job onto a newer npm major
   for a requirement that only the `publish` job actually has.
2. **npm dist-tag operations are out of scope for trusted publishing.** npm's own documentation is
   explicit that the OIDC-derived credential authorizes `npm publish` (and `npm stage publish`)
   only; `npm dist-tag add`, `npm deprecate`, `npm unpublish`, and other registry-mutating commands
   still require a classic token. `scripts/release-publish.mjs`'s `ensurePackageDistTag()` calls
   `npm dist-tag add` after every publish attempt as a correctness check-and-fix; in the normal
   fresh-publish case this is a no-op (`npm publish --tag <tag>` already sets the dist-tag
   atomically as part of the same call), but the documented idempotent-re-run path — re-running
   `release:publish` over an already-published version whose dist-tag was never confirmed — can
   still need a real write. Removing `NPM_TOKEN` outright would turn that rare repair path into an
   unauthenticated 401 buried inside a generic command-failure message.

## Decision

### D1 — Trusted Publishing authenticates `npm publish`; no token is supplied in CI

The "Publish package" step in the `publish` job no longer sets `NODE_AUTH_TOKEN` (or `NPM_TOKEN`).
`createNpmEnvironment()` in `scripts/release-publish.mjs` already only writes a registry
`_authToken` line into its temporary, process-scoped `.npmrc` when a token is actually present in
the environment (or a local `.env`); leaving the env var unset in CI is precisely what allows the
npm CLI to attempt the OIDC exchange instead of an anonymous request. No script change was needed
for the publish call itself.

### D2 — npm CLI is pinned to an exact `>= 11.5.1` version, scoped to the `publish` job only

The `publish` job gains one step, immediately after `actions/setup-node` and before `npm ci`:

```yaml
- name: Ensure npm supports OIDC trusted publishing
  run: npm install --global npm@11.18.0
```

`11.18.0` is pinned exactly (the latest npm 11.x release as of this decision), matching this
repository's existing preference for exact, reviewable pins over floating ranges (the GitHub
Actions SHA-pinning convention) rather than `npm@latest`, which would let an unreviewed npm major
version land silently in the one job that talks to the public registry with write intent. The
root `packageManager` and `engines.npm` fields are deliberately left unchanged — every other job
and every contributor's local npm 10.9.x continues to work; only the publish job's own runner
needs the newer CLI, and only for the duration of that job.

### D3 — The classic-token fallback is kept, narrowly, for dist-tag repair only

`createNpmEnvironment()` now also returns whether a token was configured (`hasToken`), threaded
through `publishPackage()` into `ensurePackageDistTag()`. When the resolved dist-tag does not
match the published version and no token is configured, the script fails immediately with an
explicit message naming the mismatch, stating that trusted publishing does not cover
`npm dist-tag add`, and telling the operator to supply `NODE_AUTH_TOKEN`/`NPM_TOKEN` for a one-off
manual correction — instead of letting an unauthenticated `npm dist-tag add` fail deep inside a
generic `run()` wrapper with a bare npm 401. This is the only place in the publish pipeline that
still has a legitimate reason to accept a classic token, and it is inert (no behavior change) in
the common fresh-publish case, which is proven by a dedicated regression test that publishes
successfully with zero registry credentials configured.

### D4 — One-time npmjs.com configuration, and secret retirement, are manual maintainer actions

Configuring the Trusted Publisher on npmjs.com (package Settings → Trusted Publishers → GitHub
Actions → this repository + the exact workflow filename `.github/workflows/release.yml`) is a
one-time action on npmjs.com's own UI. Nothing in this repository or its CI can perform or verify
it — npm does not validate the configuration until the first real publish attempt. Retiring the
existing `NPM_TOKEN` GitHub Actions secret (rotating or deleting it, and optionally disallowing
classic tokens on the package per npm's own recommendation) is a separate manual follow-up once a
maintainer has confirmed a real trusted-publishing run succeeds; this ADR does not itself delete
that secret.

## Consequences

### Positive

- No standing, long-lived npm credential exists in GitHub Actions secrets for the common publish
  path; a leaked Actions log or compromised dependency in the publish job's execution can no
  longer exfiltrate a reusable registry credential, only a token already scoped to one job run.
- Published packages carry provenance tied to the exact repository, workflow file, and run that
  produced them, independent of any secret material.
- No new package or subsystem: the change is confined to one workflow step, one script function's
  return shape, and documentation.

### Negative / Neutral

- The workflow filename `.github/workflows/release.yml` is now a load-bearing identifier: renaming
  or moving it, or wrapping the publish job behind `workflow_call`, would silently break trusted
  publishing (npm does not re-validate the saved configuration; publishing would simply start
  failing auth). Renaming that file must come with updating the npmjs.com Trusted Publisher entry
  in the same change.
- Trusted publishing requires GitHub-hosted runners; self-hosted runners cannot use it. The
  `publish` job already runs on `ubuntu-latest`, so this is not a present constraint, only a
  future one to remember if that job is ever moved.
- The dist-tag repair path (D3) still depends on a classic token in the rare case it is needed.
  This is a deliberate, narrow, documented exception, not a silent gap: it fails closed with an
  actionable message rather than attempting an unauthenticated write.
- npm CLI `11.18.0` is a minor/patch line ahead of the `10.9.8` this repository otherwise targets;
  it is scoped to one job specifically to avoid introducing an untested npm major version into
  every other CI job and every contributor's local environment.

## Alternatives Considered

### Alternative 1: Status quo — keep `NPM_TOKEN`

- **Pros**: No change; no new prerequisite (npmjs.com configuration, npm version pin).
- **Cons**: Leaves the exact long-lived-secret exposure this decision exists to remove.
- **Why rejected**: Directly contradicts the goal; npm's own guidance is to move off classic
  tokens for CI publishing wherever trusted publishing is available.

### Alternative 2: Automation-rotated short-lived granular npm token

- **Pros**: Bounded credential lifetime without depending on OIDC/trusted-publishing scope
  limits (would also cover `npm dist-tag add`).
- **Cons**: Still a secret that must be minted, stored, and rotated by *something* (a separate
  privileged process with its own credentials to protect); adds an operational subsystem to build
  and maintain for a problem OIDC already solves for the primary `npm publish` path.
- **Why rejected**: Trades one long-lived secret for a rotation pipeline that is itself a new
  trust boundary, to close a gap (`dist-tag`) that D3's narrow, fail-closed fallback already
  handles without new infrastructure.

### Alternative 3: Restructure to avoid ever needing `npm dist-tag add`

- **Pros**: Would let the publish pipeline drop the classic-token fallback entirely.
- **Cons**: The alternatives (`npm unpublish` and republish, or always publishing a new patch
  version to force the tag) carry their own registry policy restrictions (time-windowed unpublish)
  or user-visible version-numbering side effects, and would only matter for a scenario
  (idempotent retry over a partially completed prior attempt) that is already rare and already
  fails closed.
- **Why rejected**: Higher complexity and user-visible cost for a rare recovery path, versus D3's
  narrow, explicit, already-tested fallback.

## Related

- [ADR-0021](ADR-0021-publish-strategy-bundled-monorepo-product.md): publish strategy this
  authentication change does not alter (still root-only, `bundleDependencies`).
- `.github/workflows/release.yml`: the `publish` job implementing this decision.
- `scripts/release-publish.mjs`: `createNpmEnvironment()`, `publishPackage()`,
  `ensurePackageDistTag()`.
- `docs/release/release-publish-workflow.md`: operator-facing description of the npm
  authentication model and the one-time npmjs.com setup step.

## Revision Policy

If the classic-token fallback (D3) is later removed, widened, or replaced (for example if npm
extends trusted publishing to cover `npm dist-tag`), or if the pinned npm version changes for a
reason other than a routine bump, increment the version and record it below.

## Version History

| Version | Date       | Change                                                                 |
| ------- | ---------- | ----------------------------------------------------------------------- |
| 1.0     | 2026-07-11 | Accepted: npm Trusted Publishing adopted for the release `publish` job. |
