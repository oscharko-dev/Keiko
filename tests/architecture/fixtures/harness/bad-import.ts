/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Deliberately violates the strict harness variant of ADR-0019 §"Required
 * Dependency Direction" rule 4 (`keiko-harness` may depend only on
 * `keiko-contracts`, `keiko-security`, `keiko-model-gateway`,
 * `keiko-workspace`, `keiko-tools`, and `keiko-evidence`). Exists only
 * to prove the architecture gate fires on real violations for the harness
 * boundary.
 *
 * Gate wiring:
 *   - rule `adr-0019-direction-4a-harness-only-contracts-security-model-gateway-workspace-tools-evidence`
 *     in `.dependency-cruiser.cjs` extends its `from.path` regex to include
 *     `tests/architecture/fixtures/harness/` so this file is treated as if
 *     it were under the `keiko-harness` boundary, and its `to.path` regex
 *     matches the relative import below.
 *   - `scripts/arch-check-negative.mjs` runs the gate against the fixtures
 *     and asserts that every expected rule fired by name.
 *
 * Toolchain exclusions (so this fixture does not break the normal pipeline):
 *   - root `tsconfig.json` `exclude` (kept out of the type-check program)
 *   - `tsconfig.build.json` `exclude` (kept out of the published build)
 *   - `eslint.config.js` `ignores` (kept out of the lint pass)
 *
 * The relative import target file does not exist on disk; dependency-cruiser
 * still records the edge with a `couldNotResolve: true` marker and the literal
 * import string preserved as the dependency module path. The gate's `to.path`
 * regex matches that path string and fires the rule. `keiko-workflows` is
 * chosen as the violation target because it is NOT yet extracted into a
 * physical package, so the unresolved-import dance is required for the rule
 * to fire on a literal path that the strict variant forbids.
 */

import { violationTarget } from "../../../../packages/keiko-workflows/src/index.js";

export const violation: string =
  typeof violationTarget === "string"
    ? violationTarget
    : "intentional ADR-0019 violation fixture (harness boundary)";
