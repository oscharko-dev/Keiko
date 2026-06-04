/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Deliberately violates the local-knowledge strict variant of ADR-0019
 * §"Required Dependency Direction" rule 3 (`keiko-local-knowledge` may
 * depend only on `keiko-contracts`). Exists only to prove the
 * architecture gate fires on real violations for the local-knowledge
 * boundary.
 *
 * Gate wiring:
 *   - rule `adr-0019-direction-3e-local-knowledge-only-contracts`
 *     in `.dependency-cruiser.cjs` extends its `from.path` regex to
 *     include `tests/architecture/fixtures/local-knowledge/` so this
 *     file is treated as if it were under the `keiko-local-knowledge`
 *     boundary, and its `to.path` regex matches the relative import
 *     below.
 *   - `scripts/arch-check-negative.mjs` runs the gate against the
 *     fixtures and asserts that every expected rule fired by name.
 *
 * Toolchain exclusions (so this fixture does not break the normal
 * pipeline):
 *   - root `tsconfig.json` `exclude` (kept out of the type-check
 *     program)
 *   - `tsconfig.build.json` `exclude` (kept out of the published build)
 *   - `eslint.config.js` `ignores` (kept out of the lint pass)
 *
 * The relative import target file does not exist on disk; dependency-
 * cruiser still records the edge with a `couldNotResolve: true` marker
 * and the literal import string preserved as the dependency module
 * path. The gate's `to.path` regex matches that path string and fires
 * the rule.
 */

import { violationTarget } from "../../../../packages/keiko-evidence/src/index.js";

export const violation: string =
  typeof violationTarget === "string"
    ? violationTarget
    : "intentional ADR-0019 violation fixture (local-knowledge boundary)";
