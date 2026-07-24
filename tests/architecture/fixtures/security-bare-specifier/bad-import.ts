/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE - bare-specifier variant (issue #2627)
 *
 * Deliberately violates ADR-0019 §"Required Dependency Direction" rule 2 (the
 * `keiko-security` package may only depend on `keiko-contracts`), but through a
 * BARE-SPECIFIER import that resolves via the workspace `exports` map, not through
 * a relative-path import into a sibling `packages/<pkg>/src/` tree. This is the
 * exact shape of a real cross-package violation in production code - a shape the
 * Wave-2 pre-merge audit of epic #2285 (issue #2627) found the gate previously
 * blind to, because the dependency-cruiser `includeOnly` regex scoped the graph
 * to source directories only and dropped edges resolving into `packages/<pkg>/dist`.
 *
 * Companion fixture: `tests/architecture/fixtures/security/bad-import.ts` covers
 * the relative-path variant of the same rule. This fixture stays here to guarantee
 * the visibility restoration is not silently regressed by a future config edit -
 * if the includeOnly regex is narrowed back to source directories only, THIS
 * fixture's rule count drops from 1 to 0 and `scripts/arch-check-negative.mjs`
 * fails loudly.
 *
 * Gate wiring:
 *   - rule `adr-0019-direction-2-security-only-contracts` in `.dependency-cruiser.cjs`
 *     extends its `from.path` regex to include
 *     `tests/architecture/fixtures/security-bare-specifier/` so this file is treated
 *     as if it were under the `keiko-security` boundary, and its `to.path` regex
 *     matches `packages/keiko-harness/dist/index.js` - the resolved destination the
 *     bare specifier resolves to through the workspace `exports` map.
 *   - `scripts/arch-check-negative.mjs` runs the gate against the fixtures and
 *     asserts a non-zero exit code plus rule counts. The expected count for
 *     `adr-0019-direction-2-security-only-contracts` is bumped from 1 to 2 to cover
 *     both the relative-path fixture and this bare-specifier fixture.
 *
 * Toolchain exclusions (so this fixture does not break the normal pipeline):
 *   - root `tsconfig.json` `exclude` (kept out of the type-check program)
 *   - `tsconfig.build.json` `exclude` (kept out of the published build)
 *   - `eslint.config.js` `ignores` (kept out of the lint pass)
 *
 * The resolved target file MUST exist on disk for this fixture to fire - the whole
 * point is that `@oscharko-dev/keiko-harness` resolves through the package `exports`
 * map to `packages/keiko-harness/dist/index.js`. `scripts/arch-check-negative.mjs`
 * enforces this prerequisite via `REQUIRED_DIST_ENTRYPOINTS`: it refuses to run and
 * emits a clear "run `npm run build:packages` first" error when dist is missing,
 * turning the harness's implicit ordering requirement into an explicit preflight.
 */

// eslint-disable-next-line import-x/no-extraneous-dependencies
import { violationTarget } from "@oscharko-dev/keiko-harness";

export const violation: string =
  typeof violationTarget === "string"
    ? violationTarget
    : "intentional ADR-0019 violation fixture (security boundary, bare-specifier variant)";
