# Next 16 and ESLint UI Migration Verification

Status: Issue #862 migration evidence, refreshed during the post-#2665 audit on 2026-07-22 and
again for the ESLint 10 adoption (issue #2777) on 2026-08-28. The ESLint sections below are the
single source of truth for which ESLint major this repository runs and why.

## Migration decisions

- `packages/keiko-ui` uses the reviewed `next` and `eslint-config-next` baseline, held exactly aligned with each other (`16.2.12` when #862 was verified; `16.3.1` since PR #3290). The consolidated dependency review verified the aligned refresh with the UI lint, test, build, and Chromium smoke gates.
- Issue #2293 deliberately retained React `18.3.1`; the subsequent, independently verified React 19
  migration is recorded in [React 19 UI and editor migration](react19-ui-editor-migration.md).
- The root package and UI workspace run ESLint 10 on one installed binary. The ESLint 9 lane held here until 2026-08-27 and the earlier rejections of ESLint 10.7.0 and 10.8.0 (recorded in [the #2293 decision matrix](release/2293-dependency-update-decision-matrix.md)) were superseded by the evidence under [ESLint 10 adoption](#eslint-10-adoption-issue-2777-2026-08-28).
- The lint entry point is now `eslint . --max-warnings=0`; `next lint` is no longer used.
- `packages/keiko-ui/.eslintrc.json` was replaced by `packages/keiko-ui/eslint.config.mjs`, based on the ESLint-10-compatible subset of `eslint-config-next/core-web-vitals` plus the strict flat `jsx-a11y` rules.
- `eslint-config-next` still bundles React, import, and JSX-a11y plugins whose published peer ranges do not name ESLint 10 (unchanged in `16.3.1`); its parser layer, `typescript-eslint`, does accept ESLint 10 (`^8.57.0 || ^9.0.0 || ^10.0.0`) and is not part of the constraint. The UI config reuses Next's own `@next/next`, React Hooks, TypeScript, and JSX-a11y plugin objects, but filters out the React/import rule layer and avoids Next's Babel parser shim.
- The flat config keeps the React Hooks rule level equivalent to the previous Next 15 lint baseline. React Hooks v7 adds compiler-oriented rules that were not part of the prior gate and surfaced existing application-code findings outside the allowed Issue #862 scope.

## ESLint 10 adoption (issue #2777, 2026-08-28)

ESLint 10 reached `dev` on 2026-08-27 through PR #3290, a twelve-bump Dependabot rollup that raised
the root to `eslint@^10.8.1` and `packages/keiko-ui` to `eslint@10.8.1`. The rollup did not reference
issue #2777 and did not carry the migration's other obligations, so `dev` was left mid-migration in
three ways that no gate reported:

1. `@eslint/js` stayed on `^9.39.5`. The root flat config extends `js.configs.recommended`
   (`eslint.config.js:95`), so the repository ran the ESLint 10 engine against ESLint 9's
   recommended rule set and silently never enabled `no-unassigned-vars`, `no-useless-assignment`,
   or `preserve-caught-error`.
2. `npm ls eslint` exited `1`. `eslint-config-next@16.3.1` bundles `eslint-plugin-import@2.32.0`,
   `eslint-plugin-jsx-a11y@6.10.2`, and `eslint-plugin-react@7.37.5`, whose published peer ranges
   end at ESLint 9, so the installed graph was peer-invalid — the exact condition the ESLint 9 lane
   had been retained to avoid.
3. Root `^10.8.1` resolved to 10.9.1 while the workspace pin stayed at `10.8.1`, so npm installed a
   second ESLint under `packages/keiko-ui/node_modules/eslint`. The workspace lint script executes
   `../../node_modules/eslint/bin/eslint.js`, so that copy never ran and the two declarations were
   free to drift a whole major apart unnoticed.

### Live upstream re-check (2026-08-28)

`eslint-config-next@16.3.1` now declares `eslint: ">=9.0.0"` and `eslint-plugin-react-hooks@7.1.1`
declares `^10.0.0`, so both accept ESLint 10. The remaining three plugins do not, and none has
published a release since:

| Bundled by `eslint-config-next@16.3.1` | Latest published | `eslint` peer range           |
| -------------------------------------- | ---------------- | ----------------------------- |
| `eslint-plugin-react`                  | `7.37.5`         | `^3 \|\| … \|\| ^8 \|\| ^9.7` |
| `eslint-plugin-jsx-a11y`               | `6.10.2`         | `^3 \|\| … \|\| ^8 \|\| ^9`   |
| `eslint-plugin-import`                 | `2.32.0`         | `^2 \|\| … \|\| ^8 \|\| ^9`   |

The rule surface those ranges describe is already not what this repository loads. Since #862,
`packages/keiko-ui/eslint.config.mjs` has taken only Next's already-instantiated `@next/next`,
`react-hooks`, and `jsx-a11y` plugin objects and filtered `eslint-plugin-react` and
`eslint-plugin-import` rules out entirely, and the root config never loaded them at all. Of the
three, only `jsx-a11y` is executed, and it executes correctly under ESLint 10.

### Decision

Reverting an already-integrated ESLint 10 to restore a green `npm ls` was rejected: it would
downgrade working, verified code to satisfy a stale document, and Dependabot would re-propose the
same bump. The peer ranges are stale upstream metadata, not an observed incompatibility, so the
acceptance is recorded where a reviewer sees it — three `overrides` entries in the root
`package.json` binding those plugins' `eslint` peer to the root's own `$eslint` spec. The override
changes no resolution: adding it produced a byte-identical lockfile tree, and `npm ls eslint` moved
from exit `1` to exit `0` with a single `eslint@10.9.1` node.

That acceptance is bounded rather than open-ended:

- `npm run check:eslint-lane` (`npm ls eslint`, wired into the required `ci` context) fails closed on
  any peer edge in the ESLint lane that the reviewed overrides do not cover. That is the whole of
  what it answers, and it is deliberately all it is credited with: npm stays the authority on peer
  validity and the gate asks it rather than restating its resolution rules.
- `npm run check:dependency-hygiene` owns the single-lane invariant, at both layers, because npm
  owns neither. It fails closed when a workspace declares an `eslint` range that differs from the
  root's — the manifest-level cause of the duplicate install above — and, separately, when a second
  `eslint` is actually installed under a workspace's own `node_modules`.

  It also fails closed when `@eslint/js` and `eslint` are declared a major apart. That is the
  defect above that actually silenced rules, and it is the one npm can least help with:
  `@eslint/js@9` declared no peer on `eslint` at all, and `@eslint/js@10`'s peer is marked
  optional, so no resolver will ever object. `@eslint/js` ships the rule set `eslint` runs — their
  majors move together or this gate fails.

  The installed-duplicate check is not redundant with the manifest one either, and it is not
  something `npm ls` could do. `npm ls` raises a problem only for a missing, invalid, or extraneous
  edge (npm's `lib/commands/ls.js`, `getProblems`); a nested copy that satisfies its own declared
  range is a valid node, so `npm ls eslint` prints both copies and exits `0`. Reproduced against the
  exact PR #3290 tree: `npm ls eslint` → `0`, `check:dependency-hygiene` → `1`. The `npm ls eslint`
  exit `1` seen on `dev` came entirely from the peer-invalid plugin edges, never from the duplicate.

When `eslint-plugin-react`, `eslint-plugin-jsx-a11y`, or `eslint-plugin-import` publishes an
ESLint 10 peer range, delete the matching override; `check:eslint-lane` stays green either way, so
the override register is trimmed on the next `eslint-config-next` bump rather than on a schedule.

### What this change carried

- `@eslint/js` `^9.39.5` → `^10.0.1`, which is what actually activates ESLint 10's `recommended`
  set (64 rules, up from 61).
- The 11 findings the three newly enabled rules reported: 10 × `no-useless-assignment` and
  1 × `preserve-caught-error`, across 10 files — 8 in 4 packages, 2 under `scripts/`. Every one was
  a real
  defect — a dead initializer that hid which branch produced the value, or a thrown symptom error
  that dropped its cause. All were repaired at the site; none was suppressed or downgraded.
  `no-unassigned-vars` reported none.
- `packages/keiko-ui` moved from `eslint: "10.8.1"` to the root's own `^10.8.1` range, and the
  duplicate `packages/keiko-ui/node_modules/eslint` node was removed from the lockfile.

## Turbopack and package surface

`packages/keiko-ui/next.config.mjs` now sets `turbopack.root` to the repository root and removes the package-scoped `outputFileTracingRoot`. This lets Turbopack resolve workspace packages during the static export.

The package-surface concern that motivated the previous tracing pin remains covered by `npm run check:package-surface`. The verification run for this migration passed after a Turbopack `build:ui`, with `dist/ui/static` present and `dist/ui/csp-hashes.json` matching the generated static HTML inline scripts.

## PostCSS advisory remediation

The repository has a root `overrides.postcss` value of `8.5.23`; clean lockfile normalization makes
Next, Vite, and Autoprefixer use that reviewed version instead of retaining stale nested PostCSS
entries.

Verified outcome:

- `npm ls postcss --workspace @oscharko-dev/keiko-ui --all` reports `next@16.2.12 -> postcss@8.5.23 deduped`.
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
