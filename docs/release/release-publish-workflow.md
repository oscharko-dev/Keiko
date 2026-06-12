# Release / Publish Workflow

This repository now has a dedicated automated release workflow at [`.github/workflows/release.yml`](../../.github/workflows/release.yml).

## Triggering

- Tag pushes matching `v*` run the full release verification job.
- Manual `workflow_dispatch` runs the same verification job.
- Manual `workflow_dispatch` with `publish: true` enables the publish job, but only when the selected ref is a tag that starts with `v`.
- Manual publishes require an explicit npm dist-tag. The default is `beta`.

## Release-branch workflow

The release stabilization flow uses a dedicated branch for release-only hardening:

- Freeze features for `0.2` on `dev` and cut `release/0.2.0` from that point.
- Keep feature development open on `dev`.
- Land all beta/RC fixes through pull requests targeting `release/0.2.0`; direct commits to the
  release branch are blocked by branch protection.
- Require the same protected-branch quality gates as `dev` before release PRs can merge: strict
  status checks, CodeQL, dependency review, pinned-action verification, UI/build/smoke gates, signed
  commits, conversation resolution, and linear history.
- Run beta and RC validation from that branch and tag prereleases as `v0.2.0-beta.N`.
- When final verification is complete, merge `release/0.2.0` to `main` and tag `v0.2.0`.
- Immediately back-merge `release/0.2.0` into `dev` so next-cycle work can continue with stable fixes included.

## Gates

The verification job runs the current release gates in a conservative order:

1. `npm ci`
2. `npm run typecheck`
3. `npm run check:version-consistency`
4. `npm run lint`
5. `npm run arch:check`
6. `npm run arch:check:negative`
7. `npm run check:qi-supply-chain`
8. `npm test`
9. `npm run build`
10. `npm run prepare:bin`
11. `npm run build:ui`
12. `npm run prune:package-native-optionals`
13. `npm run check:package-surface`
14. `npm run smoke:install`
15. `npm run smoke:install:memory`
16. `npm audit --audit-level=high`
17. `npm sbom --sbom-format cyclonedx --omit dev`
18. `npm run check:workspace-supply-chain`
19. `npm sbom --sbom-format cyclonedx --omit dev --workspace @oscharko-dev/keiko-ui`

The workflow uploads the root and UI CycloneDX SBOMs as artifacts so release evidence stays attached to the run.

## Publish control

Publish is intentionally off by default. To publish, a maintainer must:

- run the workflow manually,
- select a tag ref that starts with `v`,
- set `publish` to `true`,
- keep `npm_dist_tag` at `beta` for prereleases such as `0.2.0-beta.0`,
- provide `NPM_TOKEN` in repository secrets.

The publish job uses `npm publish --access public --tag "$NPM_DIST_TAG"` after the verification job has completed successfully. Prerelease package versions are blocked from publishing with the `latest` dist-tag.
