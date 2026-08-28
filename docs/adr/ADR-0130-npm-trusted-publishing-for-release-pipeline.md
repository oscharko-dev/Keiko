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

1. **npm CLI version.** Trusted publishing requires npm CLI `>= 11.5.1`. Since the governed
   toolchain moved to Node 24.18 / npm 11.16.0, the repository-wide `packageManager` and
   `engines.npm` fields already satisfy that floor, and the publish job installs exactly that
   governed version (`EXPECTED_PACKAGE_MANAGER`) rather than a separately maintained pin — the
   two cannot drift apart again (amended 2026-08-10).
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
  run: npm install --global npm@11.16.0
```

The pinned version is exactly the governed `EXPECTED_PACKAGE_MANAGER` from
`scripts/check-runtime-toolchain.mjs` (`npm@11.16.0` as amended 2026-08-10, held in lockstep by
`scripts/__tests__/release-workflow-npm-pin.test.mjs`): prepack re-verifies the executed npm
against that same constant, so any other pin here kills every publish from the tag that freezes
it — the original hand pin (`11.18.0`) did exactly that to the 0.3.1 CI publish. The exact pin
still matches this repository's preference for reviewable pins over floating ranges rather than
`npm@latest`, which would let an unreviewed npm major version land silently in the one job that
talks to the public registry with write intent. The
pin equals the repository-wide governed npm, so the publish job runs the same CLI every
contributor and every other CI job already uses.

### D3 — The classic-token fallback is kept, narrowly, for dist-tag repair only

`createNpmEnvironment()` now also returns whether a token was configured (`hasToken`), threaded
through `publishPackage()` into `ensurePackageDistTag()`. A dist-tag mismatch right after a fresh
publish is usually the registry's own read replicas/CDN lagging the write, not a real problem — the
same reality `verifyPackage()` already retries for — so on the tokenless path
`ensurePackageDistTag()` retries the `npm view` read against the same `verifyAttempts`/
`waitForRegistryPropagation()` budget before drawing any conclusion. Only once that budget is
exhausted and the dist-tag still does not match the published version does the script fail, with an
explicit message naming the mismatch, stating that trusted publishing does not cover
`npm dist-tag add`, and telling the operator to supply `NODE_AUTH_TOKEN`/`NPM_TOKEN` for a one-off
manual correction — instead of letting an unauthenticated `npm dist-tag add` fail deep inside a
generic `run()` wrapper with a bare npm 401. This is the only place in the publish pipeline that
still has a legitimate reason to accept a classic token, and it is inert (no behavior change) in
the common fresh-publish case, which is proven by a dedicated regression test that publishes
successfully with zero registry credentials configured.

### D4 — One-time npmjs.com configuration, and secret retirement, are manual maintainer actions

Configuring the Trusted Publisher on npmjs.com (package Settings → Trusted Publishers → GitHub
Actions → this repository + the workflow filename **`release.yml`** — npm's form takes the
BASENAME, not the `.github/workflows/` path, and a full path entered there will not match the
OIDC claim — + the GitHub Actions **environment `npm-publish`**) is a one-time action on
npmjs.com's own UI. The
environment binding was added on 2026-08-02 (ADR-0170 D3): the workflow-dispatch API takes a
caller-chosen ref, so a dispatched candidate-branch `release.yml` variant could omit the
environment declaration and its human-approval gate entirely — with the publisher bound to the
environment, npm rejects the OIDC token of any run that did not pass through it, which closes
that path at the registry. A Trusted Publisher configured with repository and filename but
WITHOUT the environment is an incomplete provisioning state and, until corrected, a stated
fail-open window. Nothing in this repository or its CI can perform or verify the npm-side
setting — npm does not validate the configuration until the first real publish attempt. Retiring the
existing `NPM_TOKEN` GitHub Actions secret (rotating or deleting it, and optionally disallowing
classic tokens on the package per npm's own recommendation) is a separate manual follow-up once a
maintainer has confirmed a real trusted-publishing run succeeds; this ADR does not itself delete
that secret.

**Provisioning status: configured and verified (2026-08-16).** The Trusted Publisher entry exists on
npmjs.com for `@oscharko-dev/keiko` naming this repository, the basename `release.yml`, and the
`npm-publish` environment. The v0.3.8 publish ran as a `workflow_dispatch` on tag `v0.3.8` with the
`Publish to npm` job green and no registry token in the job, and npm holds a Sigstore publish
attestation for `@oscharko-dev/keiko@0.3.8` — the only artifact that evidences the OIDC exchange
from outside the run, and what closes the `ENEEDAUTH` failure of the 0.3.6 dispatch (issue #3088).
That run passed through the environment, so the incomplete-provisioning fail-open window described
above (repository and filename registered without the environment) is closed too.

**Secret retirement: done (2026-08-28).** The `NPM_TOKEN` GitHub Actions secret was deleted on the
release owner's decision once the verified trusted publish above made it redundant; no workflow read
it, and D5 pins that none starts to. No publish path lost anything: the governed local publish reads
its token from the operator's own environment, never from Actions, and the D3 dist-tag repair is a
manual run that exports one for itself. Optionally disallowing classic tokens on the package
entirely remains available to the release owner on npmjs.com.

### D5 — The repository half of the publisher binding is gated, not merely documented

The publisher entry names three identifiers this repository owns — the workflow basename
`release.yml`, the `npm-publish` environment, and a GitHub-hosted runner carrying `id-token: write`
— plus one negative condition: the publish step must supply no registry token, because an unset
`NODE_AUTH_TOKEN`/`NPM_TOKEN` is exactly what makes the npm CLI attempt the OIDC exchange (D1). npm
never re-validates a saved entry, so each of those drifts silently: CI stays green, and
authentication breaks only at the registry, in the middle of a release.

`scripts/__tests__/release-trusted-publishing-binding.test.mjs` pins all four, plus the two
structural changes that would break the OIDC claim without touching any of them — a `workflow_call`
indirection (the claim would carry the caller's identity) and a self-hosted runner (GitHub issues no
identity npm accepts there) — and asserts that no workflow consumes `secrets.NPM_TOKEN`, so D4's
retirement follow-up cannot be quietly reversed. The npm-side half stays unreadable from here, so a
rename must still be paired with the npmjs.com edit by hand; what the gate removes is the ability to
land that rename unnoticed.

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

- The workflow file `.github/workflows/release.yml` — registered with npm by its basename
  `release.yml` — **and the `npm-publish` environment name** are load-bearing identifiers: the
  publisher entry is bound to both (D4), so renaming or moving
  the file, wrapping the publish job behind `workflow_call`, or renaming the environment would
  silently break trusted publishing (npm does not re-validate the saved configuration; publishing
  would simply start failing auth). Changing either must come with updating the npmjs.com Trusted
  Publisher entry in the same change. The npm-side entry is still unreadable from this repository —
  the binding lives only in the npmjs.com publisher settings — but the repository-side identifiers
  are pinned by the D5 gate, so a rename or refactor now fails a test here instead of failing
  authentication mid-release.
- Provenance follows the path a version is published from, not this decision: only versions
  published through the Actions `publish` job carry a Sigstore publish attestation (of the 0.3.x
  line, only 0.3.8 does). The `npm-publish` environment requires the release owner's approval click
  (ADR-0170 D3), so a release that must complete without one publishes through the governed local
  path with an operator token, and that version carries no attestation. Trading the approval
  boundary away to buy provenance is not on the table — that boundary is what keeps a dispatched
  publish a person's decision — so this is a recorded gap for the release owner to weigh per
  release, not an oversight.
- Trusted publishing requires GitHub-hosted runners; self-hosted runners cannot use it. The
  `publish` job already runs on `ubuntu-latest`, so this is not a present constraint, only a
  future one to remember if that job is ever moved.
- The dist-tag repair path (D3) still depends on a classic token in the rare case it is needed.
  This is a deliberate, narrow, documented exception, not a silent gap: it fails closed with an
  actionable message rather than attempting an unauthenticated write.
- The pinned publish npm is a minor/patch line ahead of the npm this repository otherwise bundles;
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

- [ADR-0021](ADR-0021-publish-strategy-bundled-monorepo-product.md): publish strategy remains
  root-only; the root is assembled through isolated `file:` vendoring before this authentication
  path publishes it.
- `.github/workflows/release.yml`: the `publish` job implementing this decision.
- `scripts/release-publish.mjs`: `createNpmEnvironment()`, `publishPackage()`,
  `ensurePackageDistTag()`.
- `docs/release/release-publish-workflow.md`: operator-facing description of the npm
  authentication model and the one-time npmjs.com setup step.
- `scripts/__tests__/release-trusted-publishing-binding.test.mjs`: the D5 gate over the
  repository-side identifiers the publisher entry names.

## Revision Policy

If the classic-token fallback (D3) is later removed, widened, or replaced (for example if npm
extends trusted publishing to cover `npm dist-tag`), or if the pinned npm version changes for a
reason other than a routine bump, increment the version and record it below.

## Version History

| Version | Date       | Change                                                                 |
| ------- | ---------- | ----------------------------------------------------------------------- |
| 1.0     | 2026-07-11 | Accepted: npm Trusted Publishing adopted for the release `publish` job. |
| 1.1     | 2026-08-10 | Publish npm pin bound to the governed `EXPECTED_PACKAGE_MANAGER` (npm@11.16.0) with a lockstep test; stale 10.9.x/11.18.0 references removed. |
| 1.2     | 2026-08-28 | Provisioning recorded as configured and verified (v0.3.8 attestation); `NPM_TOKEN` Actions secret retired; repository-side binding enforced by a new gate (D5); provenance-by-publish-path consequence recorded. |
