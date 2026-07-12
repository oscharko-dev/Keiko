# Next 16 and ESLint UI Migration Verification

Status: Issue #862 migration evidence, refreshed by issue #2293 on 2026-07-11.

## Migration decisions

- `packages/keiko-ui` uses `next@16.2.10` and `eslint-config-next@16.2.10`, the latest stable Next 16 patch available during this run.
- Issue #2293 deliberately retained React `18.3.1`; the subsequent, independently verified React 19
  migration is recorded in [React 19 UI and editor migration](react19-ui-editor-migration.md).
- The root package and UI workspace use `eslint@9.39.5`, the latest release accepted by every active Next plugin peer range. ESLint 10.7.0 was evaluated and rejected because `eslint-plugin-import`, `eslint-plugin-jsx-a11y`, and `eslint-plugin-react` still publish ESLint <=9 peer ranges; accepting npm's override would make `npm ls` invalid.
- The lint entry point is now `eslint . --max-warnings=0`; `next lint` is no longer used.
- `packages/keiko-ui/.eslintrc.json` was replaced by `packages/keiko-ui/eslint.config.mjs`, based on the ESLint-10-compatible subset of `eslint-config-next/core-web-vitals` plus the strict flat `jsx-a11y` rules.
- `eslint-config-next@16.2.10` still bundles React, import, JSX-a11y, and parser pieces whose published peer ranges or rule APIs are not fully ESLint-10-ready. The UI config therefore reuses Next's own `@next/next`, React Hooks, TypeScript, and JSX-a11y plugin objects, but filters out the incompatible React/import rule layer and avoids Next's Babel parser shim.
- The flat config keeps the React Hooks rule level equivalent to the previous Next 15 lint baseline. React Hooks v7 adds compiler-oriented rules that were not part of the prior gate and surfaced existing application-code findings outside the allowed Issue #862 scope.

## Turbopack and package surface

`packages/keiko-ui/next.config.mjs` now sets `turbopack.root` to the repository root and removes the package-scoped `outputFileTracingRoot`. This lets Turbopack resolve workspace packages during the static export.

The package-surface concern that motivated the previous tracing pin remains covered by `npm run check:package-surface`. The verification run for this migration passed after a Turbopack `build:ui`, with `dist/ui/static` present and `dist/ui/csp-hashes.json` matching the generated static HTML inline scripts.

## PostCSS advisory remediation

The repository has a root `overrides.postcss` value of `8.5.16`; clean lockfile normalization makes
Next, Vite, and Autoprefixer use that reviewed version instead of retaining stale nested PostCSS
entries.

Verified outcome:

- `npm ls postcss --workspace @oscharko-dev/keiko-ui --all` reports `next@16.2.10 -> postcss@8.5.16 deduped`.
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
