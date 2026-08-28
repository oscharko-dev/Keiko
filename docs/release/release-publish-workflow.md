# Release / Publish Workflow

This repository now has a dedicated automated release workflow at [`.github/workflows/release.yml`](../../.github/workflows/release.yml).

## Operator contract

When a maintainer says "ship a new release", the release operator must run the scripted path
below. Do not publish packages and then manually remember the rest of the cleanup.

1. Land the release PR into the active release branch (`release/0.3`).
2. Tag the reviewed merge commit as `v<package.json version>` and push the tag.
3. Check out the tag locally or dispatch the Release workflow on that tag.
4. Run:

   ```sh
   npm run release:publish -- --tag latest
   ```

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
Production provider trust, protected-environment configuration, credential hygiene, and the native
signing/verifier handoff are governed by the
[Portable Production Signing Contract](portable-production-signing-contract.md).
The user/operator launch and first-run setup journey is documented in
[Portable Launch And Setup Guide](portable-launch-setup-guide.md).
Portable artifact signing verification is owned by `scripts/verify-portable-runtime-signing.mjs`
and the `npm run portable:verify-signing` wrapper. It updates only redacted sidecar
manifest/evidence fields and fails closed for `--policy production`; `--policy development` and
`--policy pull-request` may record unsigned non-production artifacts but must not present them as
portable-complete release assets.

Portable GitHub Release Assets are published by the same `scripts/release-publish.mjs` path, not by
a second release process. A stable `latest` publish must end with all four downloads
(`keiko-windows-x64.zip`, `keiko-macos-arm64.zip`, `keiko-macos-x64.zip`, and
`keiko-windows-x64-setup.exe`) present on the GitHub Release; the publisher verifies that against
the release itself and fails closed **before** npm learns the dist-tag. Two ways satisfy it: supply
`--portable-assets-manifest` / `KEIKO_PORTABLE_ASSETS_MANIFEST` and this run uploads them, or the
governed evaluation lane already published them onto the tag and this run only promotes it. Beta,
next, plan-only, and dry-run executions do not require real portable files unless a manifest is
supplied. When supplied, the manifest is validated before npm publish starts: for stable `latest`
the publisher creates or updates the GitHub Release, uploads and verifies the three zero-id portable
candidates, binds the uploaded manifest copies to the actual GitHub release id and archive asset
ids, uploads the evidence assets, and verifies unauthenticated full-download bytes by size and
SHA-256.

Publishing that evaluation release is a prerequisite, not an implicit step. Run it from a clean
checkout AT the built commit, and dispatch the evaluation build from the ACTIVE release source
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

When the downloads were already published by the governed evaluation lane, the publisher verifies
them instead of uploading them: the release must carry
`keiko-portable-evaluation-manifest.json`, whose declared tag, source commit, workflow path and
per-asset digests are validated, whose named workflow run must be a successful run of the canonical
portable-assets workflow at that commit. The declared digests are then checked against the
artifacts that run actually produced — workflow artifacts cannot be rewritten after the run, so the
evidence sitting next to the assets is never its own provenance — and only then are the four
downloads re-fetched over the same unauthenticated URL a customer uses and matched byte for byte. Either way npm publication happens
only afterwards, so a broken or unevidenced portable asset set cannot produce a stable package
release.

The portable assets manifest is a content-free operator input:

```json
{
  "schemaVersion": 1,
  "artifacts": [
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

The publisher requires exactly those three platform targets. For each target it validates the
production portable manifest, archive name, archive size, SHA-256 digest, manifest/evidence file
containment, checksums binding, signing/notarization verification state, and optional
`sidecarRuntimes[]` through the portable manifest contract. Archive, manifest, and evidence paths
must resolve to regular non-symlink files under the target's portable stage root. After the GitHub
Release exists, it uploads the three archives plus target-prefixed manifest/checksum/SBOM/license/
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

The schema-v2 OpenCode approval binds version `1.17.17` to commit
`474abdd7ee60f4b67476cfcef7e5311beff4a824` and HTTP/SSE compatibility to the raw bytes of
`packages/sdk/openapi.json` at that commit (SHA-256
`7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de`). Reformatted JSON does not
satisfy this provenance. Codex is not an approved payload or support claim: pending redistribution
or subscription-auth approval yields `redistribution-unapproved`, with no global-install fallback.

## Automated portable asset staging

The `Portable assets` workflow (`.github/workflows/portable-assets.yml`) automates the
build-and-test half of the portable release path. On every `v*` tag push (and on manual dispatch)
it:

1. Validates the committed approved runtime inputs with `npm run check:portable-approvals`.
2. Downloads and digest-verifies the approved coding sidecar payloads with
   `npm run portable:prepare-sidecars` on each native target runner.
3. Stages all three portable targets from those approvals with
   `scripts/run-portable-assets-stage.mjs` (Windows x64 on a Windows runner, both macOS targets on
   a macOS runner, native launcher compiled in place).
4. Re-downloads the final archives on fresh native runners. Windows re-verifies the Public Trust
   Authenticode chain, reviewed subscriber EKU, and RFC 3161 timestamp. Both macOS runners re-verify
   architecture, Developer ID identity/team, hardened runtime, timestamp, stapling, and Gatekeeper
   over extracted final bytes, then run the terminal payload smoke without credential or Actions
   file-command authority.
   The Windows production job also builds `keiko-windows-x64-setup.exe` from the already-finalized
   ZIP, signs that companion through the same protected identity, verifies its Authenticode chain,
   re-extracts it to prove the embedded script and ZIP digests, and carries it beside the Windows
   archive into the reviewed release bundle.
5. Assembles the exact-three, digest-cross-checked `portable-release-assets` bundle (with
   `portable-assets.json`) via `scripts/assemble-portable-release-assets.mjs` in exactly the layout
   the Release workflow consumes through `portable_assets_run_id`.

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
`portable-release-assets` bundle, and cannot be promoted. Production signing is restricted to
protected native-runner jobs triggered by a reviewed stable tag, with separate event, tag-shape,
exact `v<package.json.version>`, digest, and signing-identity guards. Only their
`verified-production` outputs may enter the reviewed-candidate bundle. The Ubuntu assembler
validates those outputs but cannot generate or upgrade signing-verification booleans. `release.yml`
still requires an operator dispatch with `portable_assets_run_id` pointing at the resulting green
`Portable assets` run.

## Triggering

- Stable tag pushes (`v<version>`, no prerelease suffix) run the full release verification job.
- An EXACT tag over the current package version (`v<package.json version>`, including npm
  prerelease versions such as `v0.3.0-rc.1` over `0.3.0-rc.1`) runs the full verification —
  exact npm prereleases publish through this workflow.
- Governed PORTABLE beta tag pushes (`v<version>-beta.<n>` layered over the package version,
  cut by `scripts/release-portable-prerelease.mjs`) run the SAME full verification — no step is
  skipped. Their assets carry the prerelease lane's own checks in addition (built-commit
  version match, checksums, macOS seal — ADR-0163 D9). Any other hyphenated `v*` tag (a
  non-exact RC, a foreign version, malformed) fails the tag validation.
- Manual `workflow_dispatch` with `publish: false` runs the same verification job.
- Manual `workflow_dispatch` with `publish: true` enables the publish job only when the selected ref is a tag that starts with `v` and the same tag/SHA already has a successful tag-push release verification run.
- Manual publishes require an explicit npm dist-tag. The default is `beta`.
- Stable `latest` publishes require the four downloads to be present on the GitHub Release when the
  run finishes; a reviewed portable asset bundle is how this run uploads them, and is not required
  when the governed evaluation lane already published them onto the tag. In GitHub Actions, provide
  `portable_assets_run_id`, `portable_assets_run_attempt`, and the canonical
  `portable_assets_artifact_name` value `portable-release-assets`; the workflow first verifies that
  the run is a successful stable-tag push of `.github/workflows/portable-assets.yml` for the exact
  repository, SHA, tag, and attempt and contains one nonexpired canonical artifact, then downloads it
  with `gh run download` before resolving `portable_assets_manifest`. If
  `portable_assets_manifest` is empty in that mode, it defaults to
  `.portable-release-assets/portable-assets.json`. The manifest input is interpreted only as a
  relative path inside the downloaded artifact bundle; absolute paths, parent traversal, symlinked
  manifests, and non-file manifests are rejected before publish starts.

## Release-branch workflow

The release stabilization flow uses a dedicated branch for release-only hardening:

- Freeze features for `0.3` on `dev` and cut or update `release/0.3` from that point.
- Keep feature development open on `dev`.
- Land all beta/RC fixes through pull requests targeting `release/0.3`; direct commits to the
  release branch are blocked by branch protection.
- Require the same protected-branch quality gates as `dev` before release PRs can merge: strict
  status checks, CodeQL, dependency review, pinned-action verification, UI/build/smoke gates, signed
  commits, conversation resolution, and linear history.
- Run beta and RC validation from that branch and tag prereleases as `v0.3.0-beta.N`.
- When final verification is complete, merge `release/0.3` to the appropriate stable branch and
  tag `v<version>`.
- Immediately back-merge `release/0.3` into `dev` so next-cycle work can continue with stable
  fixes included.

## Gates

The tag verification job is dependency-free after checkout and Node setup:

1. Validate that the tag name matches `package.json` (exact match, or the governed portable
   beta format `v<version>-beta.<n>` layered over the package version).
2. Verify required GitHub checks for the tagged SHA.
3. Run `npm run release:plan -- --tag beta`.

Every step runs for EVERY accepted tag, governed portable betas included: the required-check
lookup resolves its contexts from `RELEASE_REQUIRED_CHECKS` (set at workflow level) rather than
from branch protection, so it evaluates them directly on the tagged SHA — a dev-based
prerelease commit included. A green `Release verification` therefore attests the same thing for
a beta tag as for a stable one.

The release plan validates version consistency, publish manifests, and release-impact metadata
without relying on `node_modules`, so the tag job can fail fast on metadata drift. It also prints
the generated GitHub Release notes as a non-publishing preview so maintainers can review the
customer-readable bullets before dispatching a live publish.

The release workflow relies on the protected required checks for full build, test, SBOM, smoke,
and supply-chain evidence. The tag verification job verifies those checks on the release SHA before
planning or publishing.

## Publish control

Publish is intentionally off by default. To publish, a maintainer must:

- run the workflow manually,
- select a tag ref that starts with `v`,
- set `publish` to `true`,
- keep `npm_dist_tag` at `beta` for prereleases such as `0.3.0-beta.0`,
- provide `portable_assets_run_id` and `portable_assets_artifact_name` for the reviewed portable
  asset bundle when this run is the one uploading the stable `latest` downloads; omit them when the
  governed evaluation lane already published the four downloads onto the tag (the publisher
  verifies their evidence and re-downloads every byte either way),
- provide the exact `portable_assets_run_attempt` recorded by that successful tag-push run when you
  supply a bundle,
- optionally set `portable_assets_manifest` to the manifest path inside that bundle; otherwise it
  defaults to `portable-assets.json`.

No `NPM_TOKEN` is required for a normal publish — see [npm authentication](#npm-authentication-trusted-publishing)
below. The npm Trusted Publisher is configured for this package on npmjs.com and was verified by the
v0.3.8 dispatch publish on 2026-08-16.

For the first stable handoff, the release owner records only the reviewed tag/SHA, portable-assets
run id/attempt, canonical artifact name, three target statuses, and manifest/archive digests. Do not
copy provider logs, certificate bodies, credentials, private paths, or raw tool output. If run
resolution, fresh native qualification, assembly, upload, remote binding, or full-byte verification
fails, leave npm and its dist-tags unchanged. Recover by fixing the producer input or protected
configuration, rerunning the stable-tag portable-assets workflow, and using the new exact run
id/attempt; never reuse an expired artifact, edit a candidate manifest, fabricate positive ids, or
promote a partial target set.

The publish job runs `npm run release:publish -- --tag "$NPM_DIST_TAG"` after confirming
that the tag-push release verification already completed successfully for the same commit.
The script:

- checks version and publish-manifest consistency,
- checks workspace SBOM/license policy through the `check:workspace-supply-chain` gate in `prepack`,
- checks release-impact metadata for the current package version,
- requires portable production artifacts to carry verified signing/notarization sidecar status
  before they may be treated as portable-complete release assets,
- requires stable `latest` publishes to attach exactly three first-class portable GitHub Release
  Assets: `keiko-windows-x64.zip`, `keiko-macos-arm64.zip`, and `keiko-macos-x64.zip`,
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
- requires publish-time release-impact approval evidence to resolve through GitHub to an artifact authored by `KEIKO_RELEASE_OWNER_GITHUB_LOGINS` — either an approved PR review (`github-pr-review:`) or, for the solo-owner case where GitHub refuses self-approval, an owner-authored issue comment (`github-issue-comment:`) carrying the version-bound `Approved-for-publish:` phrase on a line of its own (see the release-impact runbook for both forms),
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
  own environment or a local `.env`, and the dist-tag repair below exports one for that single run.
- **Scope limitation**: trusted publishing authorizes `npm publish` only, not `npm dist-tag add`.
  A fresh publish is unaffected, because `npm publish --tag <tag>` sets the dist-tag atomically as
  part of that same authenticated call; `ensurePackageDistTag` in `scripts/release-publish.mjs`
  retries the follow-up `npm view` read (reusing the same attempt/delay settings as the post-publish
  registry verification) before concluding anything is actually wrong, so ordinary registry CDN
  propagation lag on a successful publish never fails the release. The only path that still needs a
  registry-write credential is repairing a _genuinely_ stale dist-tag on an idempotent re-run over a
  partially completed prior attempt. If that repair is ever needed, export `NODE_AUTH_TOKEN` (or
  `NPM_TOKEN`) for that one-off manual run; the script fails with an explicit, actionable error once
  its retry budget is exhausted and no token is configured, rather than an opaque npm 401.

The `prepack` and `prepublishOnly` gates also run `npm run check:workspace-supply-chain` and
`npm run check:release-impact`, so a publish cannot bypass SBOM/license verification or missing,
duplicated, contradictory, unreviewed, unbundled, or version-mismatched release-impact metadata.

### Which publish path a release uses

Both paths run the same `scripts/release-publish.mjs` and the same gates. They differ in who has to
click, and in what the published version carries afterwards:

| Path                                                                                                     | Registry authentication                                                           | Human step                                                                      | Provenance attestation | `npm-publish` deployment                                |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------- |
| Actions dispatch — `gh workflow run release.yml --ref v<version> -f publish=true -f npm_dist_tag=latest` | OIDC trusted publishing; no stored secret                                         | the `npm-publish` environment's required reviewer approves before any step runs | yes                    | written by GitHub for the environment                   |
| Governed local publish — `npm run release:publish -- --tag latest`                                       | `NODE_AUTH_TOKEN`/`NPM_TOKEN` from the operator's own environment or local `.env` | none beyond starting the run                                                    | no                     | written by the script itself since 0.3.17 (issue #3252) |

Prefer the Actions dispatch whenever the release owner is available to approve: it publishes with no
standing credential and leaves a Sigstore publish attestation on the registry. The governed local
publish exists for releases that must complete without an approval click. When a version ships that
way, record that it carries no publish attestation — of the 0.3.x line only 0.3.8 does.

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

The approval requirement on the `npm-publish` environment is a deliberate control (ADR-0170 D3):
`actions: write` anywhere in this repository is otherwise enough to dispatch a production publish.
Do not remove it to make the Actions path unattended.

### Release-owner allowlist in an operator shell

Both paths verify the publish-time release-impact approval against `KEIKO_RELEASE_OWNER_GITHUB_LOGINS`,
and an unresolved allowlist refuses **every** approval — the shape of the 0.3.1 operator outage. In
Actions the workflow injects it from the repository variable of the same name. Locally
`scripts/lib/release-owner-allowlist.mjs` resolves the same repository variable through `gh`, so no
export is normally needed; export it by hand only when `gh` cannot read repository variables in that
shell. It holds GitHub logins, and the author of the `Approved-for-publish:` comment must be one of
them — that is the release owner's own login, which need not equal the repository account name.

## GitHub Release and required checks

The tag-push release verification waits only for checks emitted on the release commit. Dependency
Review remains a required PR gate, but it is not listed in `RELEASE_REQUIRED_CHECKS` because it is
`pull_request`-only and GitHub does not emit it on the tagged squash commit. This avoids the
manual commit-status mirroring that previously made patch releases slow and error-prone.

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
that same version. An unreadable source counts as a divergence, never a pass.
