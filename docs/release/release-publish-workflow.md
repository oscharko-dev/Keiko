# Release / Publish Workflow

This repository now has a dedicated automated release workflow at [`.github/workflows/release.yml`](../../.github/workflows/release.yml).

## Operator contract

When a maintainer says "ship a new release", the release operator must run the scripted path
below. Do not publish packages and then manually remember the rest of the cleanup.

1. Land the release PR into the active release branch (`release/0.2`).
2. Tag the reviewed merge commit as `v<package.json version>` and push the tag.
3. Check out the tag locally or dispatch the Release workflow on that tag.
4. Run:

   ```sh
   npm run release:publish -- --tag latest
   ```

`scripts/release-publish.mjs` is the source of truth for the final publish. After the npm
registry install smoke passes, it creates or updates the matching GitHub Release and marks
stable `latest` publishes as GitHub's `Latest` release. If the GitHub Release is missing
after `release:publish` exits successfully, treat that as a script defect, not a manual
follow-up.

Release-impact metadata is governed by the [release-impact runbook](release-impact-runbook.md) and
validated from [`release-impact.catalog.json`](../../release-impact.catalog.json). Publish metadata
must be reviewed by a release owner before it is used for a stable package release. GitHub Release
notes are generated from that same structured catalog, so the updater can keep consuming metadata
without parsing prose.

Portable archive layout, launcher, and manifest rules are documented in
[Portable Runtime Artifact Contract](portable-runtime-artifact-contract.md).
Portable artifact signing verification is owned by `scripts/verify-portable-runtime-signing.mjs`
and the `npm run portable:verify-signing` wrapper. It updates only redacted sidecar
manifest/evidence fields and fails closed for `--policy production`; `--policy development` and
`--policy pull-request` may record unsigned non-production artifacts but must not present them as
portable-complete release assets.

Portable GitHub Release Assets are published by the same `scripts/release-publish.mjs` path, not by
a second release process. Stable `latest` publishes must provide `--portable-assets-manifest` or
`KEIKO_PORTABLE_ASSETS_MANIFEST`; beta, next, plan-only, and dry-run executions do not require real
portable files unless a manifest is supplied. When supplied, the manifest is validated before npm
publish starts, so a broken portable asset set cannot produce a package release without matching
GitHub Release Assets.

The portable assets manifest is a content-free operator input:

```json
{
  "schemaVersion": 1,
  "artifacts": [
    {
      "platformTarget": "windows-x64",
      "archivePath": "artifacts/windows-x64/keiko-windows-x64.zip",
      "manifestPath": "artifacts/windows-x64/manifest/portable-manifest.json"
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
`sidecarRuntimes[]` through the portable manifest contract. After the GitHub Release exists, it
uploads the three archives plus target-prefixed manifest/checksum/SBOM/license/provenance/signing
evidence assets with `gh release upload --clobber`, verifies GitHub reports non-zero asset ids and
HTTPS `browser_download_url` values, and performs unauthenticated ranged download smoke checks for
every uploaded portable asset. Generated archives and evidence remain release artifacts; they are
not committed to Git.

Optional coding sidecar runtime payloads are release inputs, not customer-installed tools.
`scripts/stage-portable-runtime.mjs` may receive controlled local sidecar specs through
`--sidecar-runtime-spec`; those specs can name a local `sourceRoot`, but only contained relative
payload paths, digests, size, license/SBOM evidence, adapter compatibility, platform target, and
signing/notarization status are written to portable manifests/evidence. A sidecar refresh requires a
Keiko release decision and regenerated Windows x64, macOS arm64, and macOS x64 artifacts. It must
not be implemented as a customer-side download during install, first run, app launch, or update.
Sidecar execution authority remains deferred to later Coding Workbench runtime-adapter work.

## Triggering

- Tag pushes matching `v*` run the full release verification job.
- Manual `workflow_dispatch` with `publish: false` runs the same verification job.
- Manual `workflow_dispatch` with `publish: true` enables the publish job only when the selected ref is a tag that starts with `v` and the same tag/SHA already has a successful tag-push release verification run.
- Manual publishes require an explicit npm dist-tag. The default is `beta`.

## Release-branch workflow

The release stabilization flow uses a dedicated branch for release-only hardening:

- Freeze features for `0.2` on `dev` and cut or update `release/0.2` from that point.
- Keep feature development open on `dev`.
- Land all beta/RC fixes through pull requests targeting `release/0.2`; direct commits to the
  release branch are blocked by branch protection.
- Require the same protected-branch quality gates as `dev` before release PRs can merge: strict
  status checks, CodeQL, dependency review, pinned-action verification, UI/build/smoke gates, signed
  commits, conversation resolution, and linear history.
- Run beta and RC validation from that branch and tag prereleases as `v0.2.0-beta.N`.
- When final verification is complete, merge `release/0.2` to the appropriate stable branch and
  tag `v<version>`.
- Immediately back-merge `release/0.2` into `dev` so next-cycle work can continue with stable
  fixes included.

## Gates

The tag verification job is dependency-free after checkout and Node setup:

1. Validate that the tag name matches `package.json`.
2. Verify required GitHub checks for the tagged SHA.
3. Run `npm run release:plan -- --tag beta`.

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
- keep `npm_dist_tag` at `beta` for prereleases such as `0.2.0-beta.0`,
- provide `portable_assets_manifest` when publishing the stable `latest` release,
- provide `NPM_TOKEN` in repository secrets.

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
- verifies non-zero asset ids, HTTPS `browser_download_url` values, and unauthenticated ranged
  downloads after upload,
- generates GitHub Release notes from reviewed release-impact metadata,
- requires `HEAD` to match `v<package.json version>` for stable `latest` publishes,
- rejects `--allow-untagged` when `--tag latest` is selected,
- rejects credential-bearing registry URLs before logging or release-note generation,
- requires publish-time release-impact approval evidence to resolve to an approved GitHub PR review from `KEIKO_RELEASE_OWNER_GITHUB_LOGINS`,
- requires a clean tracked working tree,
- runs the `prepack` release gate,
- publishes or reuses the root package only; private runtime workspaces are bundled inside it,
- verifies the root npm package version and selected dist-tag,
- runs the registry install smoke,
- creates or updates the matching GitHub Release with generated release-impact notes,
- marks stable `--tag latest` publishes as GitHub `Latest`.

Prerelease package versions are blocked from publishing with the `latest` dist-tag, and the
selected tag must exactly match `v<package.json version>`.

The `prepack` and `prepublishOnly` gates also run `npm run check:workspace-supply-chain` and
`npm run check:release-impact`, so a publish cannot bypass SBOM/license verification or missing,
duplicated, contradictory, unreviewed, unbundled, or version-mismatched release-impact metadata.

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
