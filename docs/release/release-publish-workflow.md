# Release / Publish Workflow

This repository now has a dedicated automated release workflow at [`.github/workflows/release.yml`](../../.github/workflows/release.yml).

## Triggering

- Releases are started manually with `workflow_dispatch`.
- Select a tag ref that starts with `v`.
- The tag must match the root `package.json` version, for example `v0.2.0-beta.3`.
- The selected tag must point at `origin/main`.
- Manual `workflow_dispatch` with `publish: true` enables the publish step.
- Manual publishes require an explicit npm dist-tag. The default is `beta`.

## Quality Gates

Full quality gates run on pull requests targeting `dev` before a change can be promoted to `main`.
The release workflow does not re-run the dev gate suite. In particular, it does not run the
workspace typecheck, lint, architecture checks, tests, install smokes, audit, or SBOM generation.

## Release Guardrails

The release workflow keeps only the checks needed to prevent publishing from the wrong source:

1. Verify that the run uses a tag ref.
2. Verify that the tag name equals `v${package.json.version}`.
3. Verify that the tagged commit equals `origin/main`.
4. Reject unsupported npm dist-tags.
5. Reject prerelease versions published with `latest`.

## Publish Preparation

The publish job installs dependencies once with lifecycle scripts disabled and builds the publish
artifact explicitly:

1. `npm ci --ignore-scripts`
2. `npm run clean`
3. `npm run build`
4. `npm run prepare:bin`
5. `npm run build:ui`
6. `npm run prune:package-native-optionals`

## Publish control

Publish is intentionally off by default. To publish, a maintainer must:

- run the workflow manually,
- select a tag ref that starts with `v`,
- set `publish` to `true`,
- keep `npm_dist_tag` at `beta` for prereleases such as `0.2.0-beta.0`,
- provide `NPM_TOKEN` in repository secrets.

The publish step uses `npm publish --access public --tag "$NPM_DIST_TAG" --ignore-scripts`.
`--ignore-scripts` is required so npm lifecycle hooks such as `prepublishOnly` cannot re-run the
heavy dev gates during release publication.
