# Release / Publish Workflow

This repository has a dedicated, human-authorized release workflow at
[`.github/workflows/release.yml`](../../.github/workflows/release.yml). It is the release button.

## Operator contract

A stable release is one press of the release button, on a `dev` that carries a reviewed
release-impact entry for whatever version comes next (ADR-0177 D9):

1. `release-impact.catalog.json` carries a reviewed entry for the version to release, written ahead
   of time as part of the normal review of the change that needs it (KEIKO-0118) — never as a
   separate release-time step. On each green `dev` push whose current version is approved and not yet
   published, `release-candidate.yml` points `v<version>` at that commit through the release tag
   GitHub App, and the tag push builds the stable portable assets beside CI.
2. Press the button: `npm run release`, or **Actions → Release → Run workflow** on `dev`. Nothing
   else is supplied. The run's `request` job authorizes exactly the `dev` commit it was started on.
   - If the current version is not yet published, it points `v<version>` at that commit. It fails at
     once, naming the reason, when that commit cannot be released: a version that is not approved, or
     a publish of the tag that is still running.
   - If the current version is already published, there is nothing to request yet: the job moves the
     checkout to the lowest stable version the catalog already carries a reviewed entry for
     (`scripts/set-version.mjs`, run mechanically — no operator command), opens a
     `release/bump-<version>` pull request to `dev` as the release App, and arms native auto-merge,
     instead of failing. It fails only when no reviewed entry exists yet for a newer version.
3. Nothing after that is manual. If step 2 opened a version-bump pull request, its merge (once CI is
   green) is recognized as the same button press across that one merge — a version-bump PR can only
   have been opened by the release App's own identity, from this same owner-gated job, targeting
   `dev` from the reserved branch prefix, carrying exactly the one mechanical commit
   `set-version.mjs` produces. `release-advance.yml` runs whenever the request, the tag build, or a
   release-required check workflow completes, and dispatches `release.yml` on the tag as soon as the
   requested commit is built and every release-required check is green. Its `authorize` job accepts
   that dispatch only for a commit an allowlisted owner requested, and the publish job releases the
   exact stable build to npm and the GitHub Release and verifies both. Nothing polls and no step
   waits on a clock: whichever prerequisite finishes last starts the publish.

Merges that land on `dev` after the button was pressed do not move the tag; they belong to the next
release. A failed tag build or required check stops the release; re-running the failed workflow
continues it, and a fix that needs a new `dev` commit needs a new press. A failed publish is never
retried automatically: press the button again. The `npm-publish` environment scopes credentials but
has no reviewer rule; the owner's request is the authorization. An allowlisted owner may still
dispatch `release.yml` directly on a tag, and cutting the tag by hand (`git tag -s v<version>` on the
reviewed commit) remains the fallback while the App is unavailable. Do not publish packages and then
manually remember the rest of the cleanup.

`scripts/release-publish.mjs` is the source of truth for the final publish. A stable `latest`
release is created or updated BEFORE npm publishes, so its downloads can be verified while the
dist-tag is still private; every other dist-tag creates or updates its GitHub Release after the
mandatory npm and Yarn registry install smokes pass. Stable `latest` publishes are marked as GitHub's `Latest`
release. If the GitHub Release is missing
after `release:publish` exits successfully, treat that as a script defect, not a manual
follow-up.

Release-impact metadata is governed by the [release-impact runbook](release-impact-runbook.md) and
validated from [`release-impact.catalog.json`](../../release-impact.catalog.json). Publish metadata
must be reviewed by a release owner before it is used for a stable package release. GitHub Release
notes are generated from that same structured catalog, so the updater can keep consuming metadata
without parsing prose.

Portable archive layout, launcher, and manifest rules are documented in
[Portable Runtime Artifact Contract](portable-runtime-artifact-contract.md).
Platform-neutral release trust is governed by ADR-0121 D7. The protected `npm-publish` environment
holds `KEIKO_PORTABLE_RELEASE_SIGNING_KEY`; the corresponding public key is bundled with Keiko.
Optional native provider signing is documented in the
[Optional Native Platform Signing Contract](portable-production-signing-contract.md).
The user/operator launch and first-run setup journey is documented in
[Portable Launch And Setup Guide](portable-launch-setup-guide.md).
Optional native signing verification remains owned by
`scripts/verify-portable-runtime-signing.mjs`. Stable installability is instead established when
`scripts/release-publish.mjs` signs the final API-bound manifest with Ed25519 and immediately
revalidates it through the same trust module the installed updater uses.
Before its first side effect the publisher signs and verifies a probe with the configured key
through that same trust module, so a key the bundled trust roots reject stops the run before a
GitHub release, an upload, or an npm publication exists.

Portable GitHub Release Assets are published by the same `scripts/release-publish.mjs` path, not by
a second release process. The repository has GitHub immutable releases enabled, which refuses every
asset change once a release is published and never lets a deleted immutable release's tag name be
reused. The publisher therefore creates the release as a draft, uploads the archives, API-binds and
signs the evidence, uploads it, and checks every asset by name, size, and GitHub's SHA-256 digest
while it is still a draft; it re-reads the tag and publishes the draft only then. An already
published release is verified, never uploaded into; one that lacks its downloads stops the run,
because only the next patch version can repair it (v1.0.0 was lost to a create-then-upload publish
on 2026-09-14). A production stable `latest` publish must end with all five downloads
(`keiko-linux-x64.zip`, `keiko-windows-x64.zip`, `keiko-macos-arm64.zip`,
`keiko-macos-x64.zip`, and `keiko-windows-x64-setup.exe`) present on the GitHub Release; the publisher
verifies that against the release itself and fails closed **before** npm learns the dist-tag. A
production run must supply `--portable-assets-manifest` / `KEIKO_PORTABLE_ASSETS_MANIFEST` and
uploads that exact-four archive set plus the Windows companion; prepublished evaluation assets are
not release-trust inputs. Beta, next, plan-only, and dry-run executions do not require real portable
files unless a manifest is supplied. When supplied, the manifest is validated before npm publish
starts: for stable `latest`,
the publisher creates or updates the GitHub Release, uploads and verifies the four zero-id portable
candidates, binds the uploaded manifest copies to the actual GitHub release id and archive asset
ids, signs that final binding with the protected Keiko release key, uploads the evidence assets,
and verifies unauthenticated full-download bytes by size and SHA-256.

The evaluation prerelease command remains available for testing and release rehearsal, but its
output cannot be promoted to stable `latest` without a fresh portable release-trust bundle. Run it
from a clean checkout AT the built commit, and dispatch the evaluation build from the ACTIVE release source
branch — `RELEASE_BASE_BRANCH` from `release.yml` when that branch exists, otherwise the
repository default branch (`dev` today, which is why the example says `dev`):

```sh
node scripts/release-portable-prerelease.mjs --ref dev --public-release
```

Once release-only fixes land on a live `RELEASE_BASE_BRANCH`, pass that branch as `--ref`
instead; a `dev` build would then either fail the containment check below or build the wrong
commit. It refuses before minting anything unless the checkout is the built commit and clean, the
commit is contained in that same resolved release source branch, every required check has passed
on that exact commit, and the release owner's approval verifies live. It then publishes the four downloads plus
`keiko-portable-evaluation-manifest.json` at `v<version>` as the Latest release, with both the
first-launch instructions and the governed catalog notes in its body.

Stable npm publication happens only after the supplied bundle has been validated, uploaded, signed,
and re-downloaded over the same unauthenticated URL a customer uses. A broken or unevidenced
portable asset set therefore cannot produce a stable package release.

The portable assets manifest is a content-free operator input:

```json
{
  "schemaVersion": 1,
  "artifacts": [
    {
      "platformTarget": "linux-x64",
      "archivePath": "artifacts/linux-x64/keiko-linux-x64.zip",
      "manifestPath": "artifacts/linux-x64/manifest/portable-manifest.json"
    },
    {
      "platformTarget": "windows-x64",
      "archivePath": "artifacts/windows-x64/keiko-windows-x64.zip",
      "manifestPath": "artifacts/windows-x64/manifest/portable-manifest.json",
      "setupPath": "artifacts/windows-x64/keiko-windows-x64-setup.exe",
      "setupSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "setupSizeBytes": 48234496
    },
    {
      "platformTarget": "macos-arm64",
      "archivePath": "artifacts/macos-arm64/keiko-macos-arm64.zip",
      "manifestPath": "artifacts/macos-arm64/manifest/portable-manifest.json"
    },
    {
      "platformTarget": "macos-x64",
      "archivePath": "artifacts/macos-x64/keiko-macos-x64.zip",
      "manifestPath": "artifacts/macos-x64/manifest/portable-manifest.json"
    }
  ]
}
```

The publisher requires exactly those four platform targets. For each target it validates the
release-trust-required portable manifest, archive name, archive size, SHA-256 digest,
manifest/evidence file containment, checksums binding, honest native-verification state, and optional
`sidecarRuntimes[]` through the portable manifest contract. Archive, manifest, and evidence paths
must resolve to regular non-symlink files under the target's portable stage root. After the GitHub
Release exists, it uploads the four archives plus target-prefixed manifest/checksum/SBOM/license/
provenance/signing evidence assets with `gh release upload --clobber`, verifies GitHub reports
non-zero asset ids and HTTPS `browser_download_url` values, and performs unauthenticated full-byte
digest checks for every uploaded portable asset. Generated archives and evidence remain
release artifacts; they are not committed to Git.

The Windows entry also requires `setupPath`, `setupSha256`, and `setupSizeBytes` from the generated
reviewed release bundle. The digest and size values above illustrate the required JSON shape; an
operator must use the values emitted for the exact setup companion bytes rather than copying the
example values. Before upload, the publisher also verifies the setup companion's GitHub build-
provenance attestation against this repository, the portable-assets workflow, and the exact source
commit. It then binds the uploaded setup asset's GitHub identity, digest, and size into the
published Windows manifest. Changing both the local setup bytes and their bundle metadata therefore
cannot substitute an unqualified executable at the final publish boundary.

Optional coding sidecar runtime payloads are release inputs, not customer-installed tools.
`scripts/stage-portable-runtime.mjs` may receive controlled local sidecar specs through
`--sidecar-runtime-spec`; those specs can name a local `sourceRoot`, but only contained relative
payload paths, digests, size, license/SBOM evidence, immutable upstream and raw protocol-schema
provenance, adapter compatibility, release approval, platform target, and signing/notarization
status are written to portable manifests/evidence. A sidecar refresh requires a Keiko release
decision and regenerated Windows x64, macOS arm64, and macOS x64 artifacts. It must not be
implemented as a customer-side download during install, first run, app launch, or update, or as a
global install, self-update, or independently promoted sidecar. Whole-product crash-safe promotion
is the only promotion path and preserves the current complete install on failure.
Sidecar execution authority is owned by the Coding Workbench runtime manager under ADR-0124: the
manager launches only manifest-verified sidecar payloads from the attested managed install root.

The schema-v2 OpenCode approval binds version `1.18.30` to commit
`3104c1428ec91f809e5ab86631300de41eb6952e` and HTTP/SSE compatibility to the raw bytes of
`packages/sdk/openapi.json` at that commit (SHA-256
`00502bd13e9c86f3ca9e765e99a57e06fa9f434ca16f2a714766d1444f8d37f3`). Reformatted JSON does not
satisfy this provenance. Codex is not an approved payload or support claim: pending redistribution
or subscription-auth approval yields `redistribution-unapproved`, with no global-install fallback.

## Automated portable asset staging

The `Portable assets` workflow (`.github/workflows/portable-assets.yml`) automates the
build-and-test half of the portable release path. On every `v*` tag push (and on manual dispatch)
it:

1. Validates the committed approved runtime inputs with `npm run check:portable-approvals`.
2. Downloads and digest-verifies the approved coding sidecar payloads with
   `npm run portable:prepare-sidecars` on each native target runner.
3. Stages all four production portable targets from those approvals with
   `scripts/run-portable-assets-stage.mjs` (Linux x64 on Linux, Windows x64 on Windows, and both
   macOS targets on native runners, with each native launcher compiled in place). Manual dispatch
   can smoke the same targets but cannot reach assembly or publication.
4. Runs the real launch/setup, USearch, and secure-read smoke on each native target. Linux binds an
   OIDC-attested qualification receipt and reruns the namespace-gateway proof on a fresh runner
   without token authority. The Windows job builds `keiko-windows-x64-setup.exe` from the finalized
   ZIP and verifies its embedded script and ZIP digest. No Apple or Microsoft signing service is
   required or contacted.
5. Validates each complete staged tree, then assembles a compact exact-four,
   digest-cross-checked `portable-release-assets` bundle (with `portable-assets.json`) containing
   only the archives, setup companion, manifests, and publish-required evidence. Expanded payload
   trees and the downloaded `portable-stage-*` inputs stay outside the handoff artifact. GitHub
   attestations are supplementary provenance; the publisher later adds mandatory Keiko release
   trust.

A push to `dev` uses the shared release-candidate planner
([ADR-0177](../adr/ADR-0177-rehearse-the-stable-release-on-every-dev-push.md)). Its
`rehearsal-readiness` job assigns one owner. An approved unpublished SHA belongs only to the
`stable-tag` build; an already-published version may run the full `dev-rehearsal`; stale,
unapproved, or publish-blocked SHAs run no expensive portable jobs. A rehearsal runs every step
above for `v<package.json version>` except tag identity and tagged-commit required-check
verification. Its Linux job runs in the `portable-release-rehearsal` environment and signs
the qualification receipt as `portable-assets.yml@refs/heads/dev`, an identity production discovery
never accepts, and its bundle is uploaded as `portable-rehearsal-assets`, which the Release workflow
refuses. A newer `dev` push cancels an older rehearsal; tag runs and manual dispatches are never
cancelled.

Version approval is a pull request: [`portable-runtime-approvals.json`](../../portable-runtime-approvals.json)
pins the Node.js runtime version and each coding sidecar's immutable upstream commit, raw protocol
schema, archive, executable-tree, license, redistribution, and subscription-auth evidence.
`npm run portable:approve-runtimes -- --node-version <v> --opencode-version <v>` may regenerate
mechanical archive inputs, but it cannot independently approve new OpenCode protocol provenance or
Codex redistribution. Reviewing and merging the complete approval diff is the release approval act.
The staging pipeline never downloads unpinned or `latest` inputs.

Publishing remains a human decision. Secret-free `workflow_dispatch`, prerelease, development, and
pull-request staging never selects `portable-release-signing`, requests Azure OIDC, or receives Apple
secrets; those artifacts intentionally remain staging/non-production, do not emit the canonical
`portable-release-assets` bundle, and cannot be promoted. The `dev` release rehearsal builds the
stable lanes but cannot be promoted either: it signs only under its own identity and never emits
the canonical bundle. Production signing is restricted to
protected native-runner jobs triggered by a reviewed stable tag, with separate event, tag-shape,
exact `v<package.json.version>`, digest, and signing-identity guards. Only their
`verified-production` outputs may enter the reviewed-candidate bundle. The Ubuntu assembler
validates those outputs but cannot generate or upgrade signing-verification booleans. `release.yml`
publishes only the green `Portable assets` tag run its `authorize` job resolves for the exact tag and
commit. `release-advance.yml` dispatches that publish with the workflow token after an allowlisted
owner requested the commit with the release button, and `authorize` accepts the resulting
`github-actions[bot]` dispatch only because that owner's request run exists for exactly this commit.

## Moving the version

`npm run set-version -- <version>` moves the product version everywhere it lives mechanically: the
root and every workspace `package.json`, every dependency pin one workspace package holds on
another, the exported `KEIKO_*_VERSION` constants, and the lockfile through
`npm install --package-lock-only`. It ends by running `check:version-consistency`, which also
refuses a lockfile entry or pin left behind: the 1.0.0 cut was written by hand and left
`package-lock.json`'s 26 workspace entries at 0.3.17 while every manifest said 1.0.0. The
release-impact catalog entry, `docs/PUBLIC_API_SURFACE.md` and the regenerated evidence documents
stay reviewed work.

## Triggering

- The release button (ADR-0177 D9): an allowlisted owner runs `release.yml` on `dev`
  (`npm run release`). Its `request` job runs only when `github.triggering_actor` is not a bot and
  that exact login is in the JSON-array repository variable `KEIKO_RELEASE_OWNER_GITHUB_LOGINS`.
- On a `dev` push whose version is approved for every portable target and not yet published,
  `release-candidate.yml` points `v<version>` at that commit through the release tag GitHub App
  (ADR-0177 D8), unless an owner's release request holds the tag at the commit it was pressed on.
  The tag push runs the stable portable build beside the commit's CI.
- Stable tag pushes build portable assets but do not trigger `release.yml` directly;
  `release-advance.yml` dispatches it on the tag once the requested commit is built and green.
- Governed portable beta tags remain owned by `scripts/release-portable-prerelease.mjs`; they are not
  accepted by the stable publish.
- `release.yml` has no inputs. On a tag, `authorize` accepts a dispatch by an allowlisted owner, or by
  `github-actions[bot]` for a commit an owner requested with the button, and refuses every other
  actor before any job with credentials starts. The publish job then re-verifies the
  release-required checks for that tag's commit.
- The npm dist-tag is `latest`: the button releases stable versions only.
- Production stable `latest` publishes require the four archives plus the Windows setup companion
  to be present on the GitHub Release when the run finishes; a reviewed portable asset bundle is how
  this run uploads them. Evaluation artifacts are never release-trust inputs. `authorize` hands the
  publish job the newest successful stable-tag run of `.github/workflows/portable-assets.yml` for the
  exact tag and commit, with its attempt and the canonical artifact `portable-release-assets`; the
  workflow verifies that the run is a successful stable-tag push for the exact repository, SHA, tag,
  and attempt and contains one nonexpired canonical artifact, then downloads it with
  `gh run download` and resolves `.portable-release-assets/portable-assets.json`. Absolute paths,
  parent traversal, symlinked manifests, and non-file manifests are rejected before publish starts.

### One-time setup for the release candidate

The candidate workflow needs a credential that may change tags. Only the repository owner can create
it, because each step is a security setting:

1. Create a GitHub App owned by the repository owner, with no webhook, installable only on that
   account, and exactly one repository permission: **Contents: Read and write**.
2. Install it on `oscharko-dev/Keiko` only, and generate a private key.
3. Create the environment `release-tagging` with a deployment branch policy that allows `dev` only.
   Add the environment secret `KEIKO_RELEASE_TAG_APP_PRIVATE_KEY` (the private key) and the environment
   variable `KEIKO_RELEASE_TAG_APP_CLIENT_ID` (the App's client ID).
4. Add the App to the bypass list of the tag ruleset "Owner-only tag changes".

Until then, `release-candidate.yml` still decides every candidate; an eligible one fails in its tag
job, and a tag can be cut by the owner as before.

## Release-branch workflow

The release stabilization flow uses a dedicated branch for release-only hardening:

- Freeze features for `1.0` on `dev` and cut or update `release/1.0` from that point.
- Keep feature development open on `dev`.
- Land all beta/RC fixes through pull requests targeting `release/1.0`; direct commits to the
  release branch are blocked by branch protection.
- Require the same protected-branch quality gates as `dev` before release PRs can merge: strict
  status checks, CodeQL, dependency review, pinned-action verification, UI/build/smoke gates, signed
  commits, conversation resolution, and linear history.
- Run beta and RC validation from that branch and tag prereleases as `v1.0.0-beta.N`.
- When final verification is complete, merge `release/1.0` to the appropriate stable branch and
  tag `v<version>`.
- Immediately back-merge `release/1.0` into `dev` so next-cycle work can continue with stable
  fixes included.

`release/1.0` branch protection is an operational part of that contract. Its required checks are
`ci`, `workflow hygiene`, `Analyze (actions)`, `Analyze (javascript-typescript)`, `Build, scan,
SBOM, smoke`, `ui`, and `Review dependency diff (dev/main)`, each bound to the GitHub Actions app.
It also requires an up-to-date head, signed commits, resolved conversations, and linear history;
force pushes and branch deletion remain disabled. Do not derive this list from the tag workflow:
the dependency-diff check runs only for pull requests and must remain protected on every release
branch even though a tag cannot emit it.

## Gates

`release-advance.yml` starts a publish only when the six release-required checks on the exact
requested SHA succeeded. The publish job independently verifies those checks again, validates that
the tag still identifies its immutable workflow SHA, resolves the exact successful portable run and
attempt, and then executes the full release plan and publish gates.

The release plan validates version consistency, publish manifests, release-impact metadata, full
build/test/SBOM/smoke evidence, and supply-chain policy. It also prints the generated GitHub Release
notes before any publication side effect. Governed portable beta tags remain on the separate
prerelease orchestration path and are never accepted as stable `latest` publishes.

## Publish control

Nothing publishes until an allowlisted release owner presses the button (`npm run release`, or
**Actions → Release → Run workflow** on `dev`). The press authorizes the exact `dev` commit it was
started on; `release-advance.yml` and `authorize` can only carry out that authorization, never widen
it to another commit.

`KEIKO_RELEASE_OWNER_GITHUB_LOGINS` must be a valid JSON array of exact GitHub logins, for example
`["release-owner"]`. A malformed, missing, or empty value makes the button's job condition, the
event-driven start and the publish authorization fail closed.

No `NPM_TOKEN` is required for a normal publish — see [npm authentication](#npm-authentication-trusted-publishing)
below. The npm Trusted Publisher is configured for this package on npmjs.com and was verified by the
v0.3.8 dispatch publish on 2026-08-16.

The run summaries record the reviewed tag/SHA, portable-assets run id/attempt, canonical artifact
name, four target statuses, and manifest/archive digests. Do not copy provider logs, certificate
bodies, credentials, private paths, or raw tool output. If run resolution, fresh native
qualification, assembly, upload, remote binding, or full-byte verification fails, npm and its
dist-tags stay unchanged. Recover by fixing the producer input or protected configuration and
rerunning the stable-tag portable-assets workflow; its completion starts the publish again when the
request is still open. Never reuse an expired artifact, edit a candidate manifest, fabricate positive
ids, or promote a partial target set.

### Built-in updater qualification (#3403/#3405)

Artifact signing, fresh archive verification, and the launch/setup smoke do not by themselves prove
an installed application can replace itself. Before advertising production one-click updates, the
release owner must attach native N−1→N canary evidence for Windows x64, macOS arm64, and macOS x64
using two immutable Keiko-signed eligible releases. Each run must exercise the assembled
application's real BFF/CLI/native path, prove orderly same-port process transfer, exact target
startup and durable outcome, reconstruct the canonical activity timeline, and restart again while
retaining N. Record target, source/target versions, exact artifact digests and run identities, and
bounded results; never include provider material, private control capsules, or raw command output.

Secret-free deterministic PR qualification must separately cover the trust, resource, cancellation,
crash/recovery, and UI outage boundaries specified by #3405. Route mocks, fake processes, injected
version verifiers, and payload `--version` smoke are not substitutes for real native execution.
Required-lane reachability and all three actual target results must be recorded, not inferred from
workflow YAML or a skipped job.

If two Keiko-signed release versions or their three target-native canary results are unavailable,
keep that production-qualification limitation explicit on the issue/epic and in release guidance.
Code review may proceed with the stated limit; a production one-click claim may not. Evaluation
releases, including 0.3.17, remain manual-only and require a deliberate manual transition to the
first release-trusted build. Do not retroactively change their trust scope or treat fixture evidence
as a canary. Apple/Microsoft provider access is not a prerequisite and this updater repair grants no
publish approval.

The publish job runs `npm run release:publish -- --tag "$NPM_DIST_TAG"` once `authorize` accepted its
dispatch — either a direct tag dispatch by an allowlisted owner, or the `github-actions[bot]`
dispatch from `release-advance.yml` for a commit a successful owner release request authorized — and
after it re-verifies the release-required checks of the commit it was dispatched for and validates
the green `Portable assets` run of that commit as its input.
The script:

- checks version and publish-manifest consistency,
- checks workspace SBOM/license policy through the `check:workspace-supply-chain` gate in `prepack`,
- checks release-impact metadata for the current package version,
- requires portable production artifacts to carry valid Keiko release trust and truthful native
  platform-evidence status, plus Linux runtime qualification, before they may be treated as
  portable-complete release assets,
- requires production stable `latest` publishes to attach exactly four first-class portable GitHub
  Release Assets: `keiko-linux-x64.zip`, `keiko-windows-x64.zip`, `keiko-macos-arm64.zip`, and
  `keiko-macos-x64.zip`,
- rejects portable artifacts with sidecar payload metadata that is unverified, wrong-platform,
  checksum-mismatched, missing executable/license/SBOM evidence, or not contained under
  `runtime/sidecars/<runtime-name>`,
- uploads target-prefixed portable manifests, checksums, SBOM/license evidence, provenance, and
  signing verification summaries as GitHub Release Assets,
- binds real positive release/asset ids only from the GitHub API snapshot, then verifies HTTPS
  `browser_download_url` values and complete unauthenticated download size/SHA-256 after upload,
- publishes stable `latest` portable ZIPs and evidence before npm publication, so the primary
  user journey is download once, click the bundled launcher, and keep npm as a developer and
  compatibility path,
- keeps `npm run smoke:portable-launch-setup` green for deterministic launch/setup evidence and
  validates staged target directories when `--stage-root` is supplied,
- generates GitHub Release notes from reviewed release-impact metadata,
- requires `HEAD` to match `v<package.json version>` for stable `latest` publishes,
- rejects `--allow-untagged` when `--tag latest` is selected,
- rejects credential-bearing registry URLs before logging or release-note generation,
- requires reviewed, version-bound release-impact metadata whose approval reference remains a
  durable audit link; the protected merge and the allowlisted owner's release-button press are the
  executable authorization boundaries,
- requires a clean tracked working tree,
- runs the `prepack` release gate,
- stages and publishes or reuses the root package only; private runtime workspaces ship as
  tarball-local `file:` archives under `vendor/` and are never resolved from the registry,
- verifies the root npm package version and selected dist-tag,
- runs mandatory npm and Yarn registry install smokes,
- creates or updates the matching GitHub Release with generated release-impact notes,
- marks stable `--tag latest` publishes as GitHub `Latest`.

Prerelease package versions are blocked from publishing with the `latest` dist-tag, and the
selected tag must exactly match `v<package.json version>`.

## npm authentication (Trusted Publishing)

The `publish` job authenticates to the npm registry with [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
(OIDC) instead of a long-lived `NPM_TOKEN` secret ([ADR-0130](../adr/ADR-0130-npm-trusted-publishing-for-release-pipeline.md)):

- The job's `id-token: write` permission lets the npm CLI exchange a short-lived, workflow-scoped
  GitHub Actions OIDC token for registry access. The "Publish package" step deliberately sets no
  `NODE_AUTH_TOKEN` / `NPM_TOKEN`; `scripts/release-publish.mjs` only writes a registry auth line
  into its temporary `.npmrc` when one of those env vars (or a local `.env`) is actually present,
  so leaving them unset in CI is what lets the npm CLI attempt the OIDC exchange.
- npm CLI `>= 11.5.1` is required. The workflow pins an exact npm version with
  `npm install --global npm@<pinned>` right after `actions/setup-node`, where `<pinned>` is the
  governed `EXPECTED_PACKAGE_MANAGER` constant in `scripts/check-runtime-toolchain.mjs`
  (`scripts/__tests__/release-workflow-npm-pin.test.mjs` compares the workflow line against
  that constant, so the two cannot drift; this document deliberately does not restate the
  number and become a third copy). Node 24.18.0 already
  bundles npm 11.16.0, so the pin is not about clearing that floor: it holds the publish npm at
  the exact governed version, because a drifted hand-maintained pin is what broke the 0.3.1
  publish and a tag freezes whatever it captured.
- **The one-time npmjs.com setup is done (issue #3088).** The package's Settings → Trusted
  Publishers page names this repository, the workflow filename `release.yml`, and the `npm-publish`
  environment. It was verified by the v0.3.8 dispatch publish on 2026-08-16: the `Publish to npm`
  job ran with no registry token and npm holds a Sigstore publish attestation for
  `@oscharko-dev/keiko@0.3.8`. Before that, the 0.3.6 dispatch failed with `ENEEDAUTH` because no
  publisher entry existed yet.
- **Three values identify the publisher entry** and are case-sensitive: the repository, the
  workflow basename `release.yml` (basename only, extension included — never the
  `.github/workflows/` path), and the environment `npm-publish`. npm never re-validates a saved
  entry, so renaming the workflow file or the environment breaks authentication only at the next
  publish.
- **Four further conditions must hold in the workflow itself** for the OIDC exchange to happen and
  match that entry: no `workflow_call` indirection (the claim would carry the caller's identity), a
  GitHub-hosted runner, `id-token: write` on the publish job, and no `NODE_AUTH_TOKEN`/`NPM_TOKEN`
  reaching the publish step from any env scope. All three values and all four conditions are pinned
  by `scripts/__tests__/release-trusted-publishing-binding.test.mjs` (ADR-0130 D5), which proves
  rejection against weakened copies of the live workflow rather than only asserting the current
  file; the npmjs.com side still has to be edited by hand in the same change.
- **No `NPM_TOKEN` Actions secret exists any more** (retired 2026-08-28, ADR-0130 D4): nothing in CI
  can publish with a classic token. The governed local publish reads its token from the operator's
  own environment or a local `.env`; no workflow should reintroduce that credential.
- **Scope limitation**: trusted publishing authorizes `npm publish` only, not `npm dist-tag add`.
  A fresh publish is unaffected, because `npm publish --tag <tag>` sets the dist-tag atomically as
  part of that same authenticated call; `ensurePackageDistTag` in `scripts/release-publish.mjs`
  verifies the version-specific registry endpoint and then the dist-tag with the same attempt/delay
  settings as post-publish registry verification. The Actions workflow uses 30 total reads with one
  minute between reads because npm Trusted Publishing can quarantine an OIDC/provenance publish
  after the CLI reports success; v1.0.3 took roughly 14 minutes. Retryable HTTP and transport
  failures consume that same budget. Before publishing, a separate three-probe check distinguishes
  a real 404 from transient registry uncertainty and refuses to mutate when existence is unknown.
  If the post-publish budget is exhausted, do not add a registry token to the workflow and do not
  edit deployment state by hand. Wait until
  `https://registry.npmjs.org/@oscharko-dev/keiko/<version>` returns HTTP 200 and re-run the governed
  verification. If the version is visible but the dist-tag remains stale, run the full release
  orchestrator from the exact tagged commit with an operator-held npm token and the original
  qualified portable inputs; deployment success is recorded only after all verification passes.

The `prepack` and `prepublishOnly` gates also run `npm run check:workspace-supply-chain` and
`npm run check:release-impact`, so a publish cannot bypass SBOM/license verification or missing,
duplicated, contradictory, unreviewed, unbundled, or version-mismatched release-impact metadata.

### Which publish path a release uses

Both paths run the same `scripts/release-publish.mjs` and the same gates. They differ in who has to
click, and in what the published version carries afterwards:

| Path                                                               | Registry authentication                                                           | Human step                                                       | Provenance attestation | `npm-publish` deployment                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------- | ------------------------------------------------------- |
| Release button — `npm run release` (`release.yml` on `dev`)        | OIDC trusted publishing; no stored secret                                         | an allowlisted non-bot owner presses the button once             | yes                    | written by GitHub for the environment                   |
| Governed local publish — `npm run release:publish -- --tag latest` | `NODE_AUTH_TOKEN`/`NPM_TOKEN` from the operator's own environment or local `.env` | an operator deliberately starts the exact tagged release locally | no                     | written by the script itself since 0.3.17 (issue #3252) |

Prefer the release button: it publishes with no standing credential and leaves a Sigstore publish
attestation on the registry. The governed local publish is a recovery path when the OIDC workflow
cannot complete. When a version ships that way, record that it carries no publish attestation — of
the 0.3.x line only 0.3.8 does.

The local publish must run on **Linux**: the publish gates re-check editor bundle evidence whose
gzip sizes are Linux-anchored, and a macOS run fails it for platform reasons alone. Any Linux host
with Node, `gh`, and the credentials below works directly. The `gates` container
(`docker/gates/docker-compose.yml`) is the closest ready-made Linux userland, but it is a gate
image, not a release image, so a publish from it needs three things added in the same
`docker compose run` invocation:

- **`gh`**, which the publisher shells out to for the owner allowlist, the GitHub Release, the
  deployment record, and the alignment check. The image does not ship it and Debian does not package
  it, so install a pinned `gh` release binary into a writable path (`$HOME/bin` — the container runs
  as non-root and `/usr/local/bin` is read-only).
- **Credentials and the allowlist, forwarded explicitly**: the Compose service declares none, so
  pass `-e GH_TOKEN -e NPM_TOKEN -e KEIKO_RELEASE_OWNER_GITHUB_LOGINS` from the operator's shell.
- **A container-local clone of the tag**, not the bind-mounted checkout: `git clone --depth 1
--branch v<version>` into a path under `/tmp`, then `npm ci` and `npm run provision:usearch`
  there. A checkout mounted from a git worktree carries a `.git` _file_ pointing at a main
  repository that is not mounted, and every git-reading gate fails on it.

The `npm-publish` environment has no required-reviewer protection rule. Do not describe it as an
approval gate. Human control is the release button: its `request` job runs only for an allowlisted
non-bot triggering actor in the exact JSON-array owner guard, and `authorize` accepts a publish
dispatch only from such an owner directly on the tag, or from `github-actions[bot]` for the exact
commit a successful owner request authorized. The environment scopes credentials and OIDC identity.
Do not grant the stable build `actions: write`: `release-advance.yml` is the only workflow that
dispatches a publish.

### Release-owner allowlist in an operator shell

The Actions job parses `KEIKO_RELEASE_OWNER_GITHUB_LOGINS` as a JSON array and tests exact membership;
substring matches are not authorization. Local release tooling resolves the same repository variable
through `gh` when it needs the release-owner configuration, so no export is normally needed. Export
it only when `gh` cannot read repository variables in that shell, preserving the JSON-array format.

## GitHub Release and required checks

The event-driven publish start and the publish verification consider only checks emitted on the
release commit. Dependency Review remains a required PR gate, but it is not listed in
`RELEASE_REQUIRED_CHECKS` because it is `pull_request`-only and GitHub does not emit it on the tagged
squash commit. This avoids manual commit-status mirroring.

This exception is limited to tag verification. `release/1.0` PR branch protection must continue to
require `Review dependency diff (dev/main)` before a hotfix can merge.

The GitHub Release entry is owned by `scripts/release-publish.mjs`; do not create it manually as
a separate step. Default user-facing bullets omit issue and PR numbers. Catalog ids, approval
references, source issue/PR references, affected state stores, remediation, registry, and dist-tag
details are retained in a collapsed technical metadata section for entries that are public by
default. Non-observable `internal-only` entries stay out of the public GitHub Release body.
Release-note generation fails closed when public notes contain obvious local filesystem paths,
private key material, or common secret-token patterns. Re-running `npm run release:publish -- --tag
latest` is idempotent for already published packages: it verifies npm versions/dist-tags, reruns the
registry smoke, and updates the GitHub Release metadata from the already-rendered notes snapshot.

## Release alignment (issue #3252)

Version, tag, GitHub Latest release, npm `latest`, and the `npm-publish` deployment record must
never diverge silently. 0.3.12-0.3.15 published through the governed-container path, which creates
no GitHub deployment, so the Deployments panel kept showing v0.3.11 while npm `latest` was already
0.3.15 — nothing read all five sources together. A real `--tag latest` publish now records a
`npm-publish` GitHub Deployment itself (skipped only inside the Actions `publish` job, which GitHub
already deploys for; `scripts/lib/npm-publish-deployment.mjs`) and then runs the alignment gate
before reporting PASS, failing the publish on any divergence instead of leaving a stale panel.

Run the same check standalone at any time:

```sh
npm run check:release-alignment
```

It reads the checkout version, the newest `v*` tag, the GitHub Latest release, npm `latest`, and
the newest `npm-publish` deployment ref, and passes only when the checkout equals npm `latest` or
is exactly one patch/minor release ahead of it (a cut pending) and the other four sources all name
that same version. An unreadable source fails the check without an alignment result, never a
pass. The CLI exits 0 when
aligned, 1 for a divergence every source answered, and 2 when a source could not answer at all (a
failed command or unparseable output); an empty tag or deployment list is an answer, not an
unreadable source.

The `Release alignment` workflow (`.github/workflows/release-alignment.yml`) asks the same
question every night and on manual dispatch, so a release left half-finished between two publishes
no longer waits for someone to run the check by hand. A divergence files or updates one
`Release alignment diverged` tracking issue and fails the lane; the first aligned run closes that
issue. Exit 2 fails the lane without filing anything, because no alignment result exists. The lane
only detects: finishing or repairing a release stays a maintainer action.
