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

The script fails closed on eight checks:

1. No source file under `src/`, `scripts/`, or `packages/*/{src,test}` imports `@oscharko-dev/test-intelligence` or the `@oscharko-dev/ti-*` namespace (including the dynamic template-literal evasion form).
2. The root `package.json` does not declare forbidden Test Intelligence packages in `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`, or `bundleDependencies`.
3. No workspace `package.json` declares those forbidden packages in any dependency section (incl. `optionalDependencies`).
4. The Quality Intelligence dependency decision matrix exists and matches the live manifests: `approved-runtime` rows are present where expected, and `denied` **and** `defer-to-decision` rows are absent (a deferred row is machine-enforced as denied until a follow-up PR promotes it).
5. No package manifest declares `preinstall`, `install`, or `postinstall` lifecycle hooks.
6. No manifest introduces telemetry or analytics dependency substrings covered by the deny set (scanned across all dependency sections, incl. `optionalDependencies`).
7. **Completeness (fail-closed on unapproved deps).** Every external dependency that ships in the published `@oscharko-dev/keiko` runtime graph — the `dependencies`/`optionalDependencies` of the root manifest and of every `bundleDependencies` workspace package — maps to an `approved-runtime` decision-matrix row. Workspace `@oscharko-dev/*` packages (governed by the bundle contract) and `@types/*` declaration-only stubs are exempt. A new permissively-licensed runtime dependency added without a matrix row fails the gate.
8. **License declared (Issue #287 AC1).** Every `approved-runtime`/`approved-dev` row declares a non-empty license; the matrix table carries a `license` column for this.

Native-addon coverage: the generic native-addon backstop (`*.node` binaries must not ship) lives in the companion `check-package-surface.mjs` gate (rule set in `scripts/package-surface-rules.mjs`), since it inspects the packed tarball rather than the manifests.

## Companion gates

This gate is intentionally narrower than the broader package and supply-chain checks:

- `npm run check:package-surface` protects the packed public runtime artifact (incl. the generic `*.node` native-addon block).
- `npm run check:workspace-supply-chain` covers SBOM generation and license allow-list enforcement.
- `npm run smoke:install` proves the packed artifact installs and executes.
- `npm run arch:check` / `npm run arch:check:negative` protect package-boundary rules.

## Maintenance rule

When Quality Intelligence work adds or removes an approved dependency, update the decision matrix in
the same change — including the dependency's `license` column. The gate is designed to reject
manifest drift immediately: a new shipping dependency without an `approved-runtime` row, or an
approved row missing a license, fails closed.
