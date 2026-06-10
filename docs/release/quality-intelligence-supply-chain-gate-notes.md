# Quality Intelligence supply-chain gate

This document describes the current Quality Intelligence release gate. It is current-state guidance,
not PR-scoped release notes.

## Gate entrypoint

- Command: `npm run check:qi-supply-chain`
- Script: [`scripts/check-quality-intelligence-supply-chain.mjs`](../../scripts/check-quality-intelligence-supply-chain.mjs)
- Default decision matrix: [`quality-intelligence-dependency-decision-matrix.md`](./quality-intelligence-dependency-decision-matrix.md)
- Lifecycle hooks: runs in both `prepack` and `prepublishOnly`
- CI coverage: runs in the `ci` workflow before a publishable artifact is accepted

## What the gate enforces

The script fails closed on six checks:

1. No source file under `src/`, `scripts/`, or `packages/*/{src,test}` imports `@oscharko-dev/test-intelligence` or the `@oscharko-dev/ti-*` namespace.
2. The root `package.json` does not declare forbidden Test Intelligence packages in `dependencies`, `devDependencies`, or `bundleDependencies`.
3. No workspace `package.json` declares those forbidden packages in dependency sections.
4. The Quality Intelligence dependency decision matrix exists and matches the live manifests: approved rows are present where expected and denied rows are absent.
5. No package manifest declares `preinstall`, `install`, or `postinstall` lifecycle hooks.
6. No manifest introduces telemetry or analytics dependency substrings covered by the deny set.

## Companion gates

This gate is intentionally narrower than the broader package and supply-chain checks:

- `npm run check:package-surface` protects the packed public runtime artifact.
- `npm run check:workspace-supply-chain` covers SBOM generation and license allow-list enforcement.
- `npm run smoke:install` proves the packed artifact installs and executes.
- `npm run arch:check` / `npm run arch:check:negative` protect package-boundary rules.

## Maintenance rule

When Quality Intelligence work adds or removes an approved dependency, update the decision matrix in
the same change. The gate is designed to reject manifest drift immediately.
