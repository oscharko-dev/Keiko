/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Deliberately violates the strict cli variant of ADR-0019 §"Required
 * Dependency Direction" rule 7 (`keiko-cli` may depend only on
 * `keiko-contracts`, `keiko-security`, `keiko-model-gateway`,
 * `keiko-workspace`, `keiko-tools`, `keiko-harness`, `keiko-workflows`,
 * `keiko-evidence`, and `keiko-server`). Exists only to prove the
 * architecture gate fires on real violations for the cli boundary.
 *
 * Gate wiring:
 *   - rule `adr-0019-direction-7a-cli-only-contracts-security-model-gateway-workspace-tools-harness-workflows-evidence-server`
 *     in `.dependency-cruiser.cjs` extends its `from.path` regex to include
 *     `tests/architecture/fixtures/cli/` so this file is treated as if
 *     it were under the `keiko-cli` boundary, and its `to.path` regex
 *     matches the relative import below.
 *   - `scripts/arch-check-negative.mjs` runs the gate against the fixtures
 *     and asserts that every expected rule fired by name.
 *
 * Toolchain exclusions (so this fixture does not break the normal pipeline):
 *   - root `tsconfig.json` `exclude` (kept out of the type-check program)
 *   - `tsconfig.build.json` `exclude` (kept out of the published build)
 *   - `eslint.config.js` `ignores` (kept out of the lint pass)
 *
 * `keiko-ui` is chosen as the violation target because it is the only
 * extracted workspace package the strict 7a variant forbids: the browser
 * tier must not be reached from the cli command surface.
 */
import { violationTarget } from "../../../../packages/keiko-ui/src/index.js";

export const violation: string =
  typeof violationTarget === "string"
    ? violationTarget
    : "intentional ADR-0019 violation fixture (cli boundary)";
