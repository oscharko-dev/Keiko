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
- provide `NPM_TOKEN` in repository secrets.

The publish job runs `npm run release:publish -- --tag "$NPM_DIST_TAG"` after confirming
that the tag-push release verification already completed successfully for the same commit.
The script:

- checks version and publish-manifest consistency,
- checks release-impact metadata for the current package version,
- generates GitHub Release notes from reviewed release-impact metadata,
- requires `HEAD` to match `v<package.json version>` for stable `latest` publishes,
- rejects `--allow-untagged` when `--tag latest` is selected,
- rejects credential-bearing registry URLs before logging or release-note generation,
- requires publish-time release-impact approval evidence to resolve to an approved GitHub PR review from `KEIKO_RELEASE_OWNER_GITHUB_LOGINS`,
- requires a clean tracked working tree,
- runs the `prepack` release gate,
- publishes or reuses every publishable workspace package and the root package,
- verifies every npm package version and selected dist-tag,
- runs the registry install smoke,
- creates or updates the matching GitHub Release with generated release-impact notes,
- marks stable `--tag latest` publishes as GitHub `Latest`.

Prerelease package versions are blocked from publishing with the `latest` dist-tag, and the
selected tag must exactly match `v<package.json version>`.

The `prepack` and `prepublishOnly` gates also run `npm run check:release-impact`, so a publish
cannot bypass missing, duplicated, contradictory, unreviewed, unbundled, or version-mismatched
release-impact metadata.

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
