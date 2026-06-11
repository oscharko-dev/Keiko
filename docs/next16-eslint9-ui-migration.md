# Next 16 and ESLint 9 UI Migration Verification

Status: Issue #862 migration evidence, captured on 2026-06-11.

## Migration decisions

- `packages/keiko-ui` uses `next@16.2.9` and `eslint-config-next@16.2.9`, the latest stable Next 16 line available during this run.
- React remains on `18.3.1`; `next@16.2.9` supports React 18 and the migration did not require a React 19 upgrade.
- The UI workspace uses `eslint@9.39.4` because it satisfies `eslint-config-next@16.2.9` while staying inside `eslint-plugin-jsx-a11y@6.10.2`'s peer range.
- The lint entry point is now `eslint . --max-warnings=0`; `next lint` is no longer used.
- `packages/keiko-ui/.eslintrc.json` was replaced by `packages/keiko-ui/eslint.config.mjs`, based on `eslint-config-next/core-web-vitals` plus the strict flat `jsx-a11y` rules.
- The flat config keeps the React Hooks rule level equivalent to the previous Next 15 lint baseline. React Hooks v7 adds compiler-oriented rules that were not part of the prior gate and surfaced existing application-code findings outside the allowed Issue #862 scope.

## Turbopack and package surface

`packages/keiko-ui/next.config.mjs` now sets `turbopack.root` to the repository root and removes the package-scoped `outputFileTracingRoot`. This lets Turbopack resolve workspace packages during the static export.

The package-surface concern that motivated the previous tracing pin remains covered by `npm run check:package-surface`. The verification run for this migration passed after a Turbopack `build:ui`, with `dist/ui/static` present and `dist/ui/csp-hashes.json` matching the generated static HTML inline scripts.

## PostCSS advisory remediation

`next@16.2.9` declares `postcss@8.4.31`, which is in the advisory range for GHSA-qx2v-qp2m-jg93. The repository already has a root `overrides.postcss` value of `8.5.15`; a clean lockfile normalization is required so npm hoists and dedupes Next's PostCSS edge to that override instead of retaining the stale nested `packages/keiko-ui/node_modules/next/node_modules/postcss@8.4.31` entry.

Verified outcome:

- `npm ls postcss --workspace @oscharko-dev/keiko-ui --all` reports `next@16.2.9 -> postcss@8.5.15 deduped`.
- `npm audit --audit-level=moderate --workspace @oscharko-dev/keiko-ui` passes with zero vulnerabilities.
- `npm sbom --sbom-format cyclonedx --omit dev --workspace @oscharko-dev/keiko-ui` emits successfully.

## Local verification summary

The migration branch passed:

- UI gates: lint, typecheck, test, and Turbopack `next build`.
- Root gates: typecheck, lint, test, architecture check, and negative architecture fixtures.
- Supply-chain gates: UI moderate audit, root high audit, root SBOM, UI SBOM, workspace SBOM/license aggregation, and Quality Intelligence supply-chain check.
- Artifact gates: `build:ui`, `check:package-surface`, `smoke:install`, and `smoke:install:memory`.
- PWA/BFF gates: focused service-worker and PWA UI tests, server installability/CSP/static tests, and runtime BFF checks for `/`, `/api/health`, `/manifest.webmanifest`, `/sw.js`, one `/_next/static/` chunk, and the CSP header.

Runtime evidence: the rebuilt BFF served the Keiko workspace shell with 10 Next static scripts, linked the manifest, returned no browser console errors, and served a CSP header containing the 37 generated inline-script hashes from `dist/ui/csp-hashes.json`.
