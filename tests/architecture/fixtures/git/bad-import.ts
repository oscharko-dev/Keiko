/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Deliberately violates ADR-0019 §"Required Dependency Direction" rule 2b (the
 * `keiko-git` package may only depend on `keiko-contracts`, so it stays a leaf next
 * to `keiko-security` and can never pull server/tool/provider code into the spawn
 * path). Exists only to prove the architecture gate fires on real violations for the
 * git boundary.
 *
 * Gate wiring:
 *   - rule `adr-0019-direction-2b-git-only-contracts` in `.dependency-cruiser.cjs`
 *     extends its `from.path` regex to include `tests/architecture/fixtures/git/` so
 *     this file is treated as if it were under the `keiko-git` boundary, and its
 *     `to.path` regex matches the relative import below.
 *   - `scripts/arch-check-negative.mjs` runs the gate against the fixtures and
 *     asserts a non-zero exit code, and that the rule fires exactly once
 *     (`EXPECTED_DEPCRUISER_RULE_COUNTS`).
 *   - `tests/architecture/severity-gate.test.ts` lists variant `2b` in
 *     `STRICT_DIRECTION_VARIANTS` so the rule cannot be softened below
 *     `severity: "error"` in a future change.
 *
 * Toolchain exclusions (so this fixture does not break the normal pipeline):
 *   - root `tsconfig.json` `exclude` (kept out of the type-check program)
 *   - `tsconfig.build.json` `exclude` (kept out of the published build)
 *   - `eslint.config.js` `ignores` (kept out of the lint pass)
 *
 * The relative import target is a real, existing forbidden sibling package
 * (`keiko-server` — the exact direction rule 2b exists to prevent, since it would
 * pull server code into the git spawn path). dependency-cruiser records the edge and
 * the gate's `to.path` regex matches it.
 */

import { violationTarget } from "../../../../packages/keiko-server/src/index.js";

export const violation: string =
  typeof violationTarget === "string"
    ? violationTarget
    : "intentional ADR-0019 violation fixture (git boundary)";
