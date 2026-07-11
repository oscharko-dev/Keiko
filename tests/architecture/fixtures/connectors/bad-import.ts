/**
 * INTENTIONAL ADR-0128 VIOLATION FIXTURE
 *
 * Deliberately violates the Atlassian connector boundary from ADR-0128 D1
 * (`keiko-connectors` may depend only on `keiko-contracts` and
 * `keiko-security`; it must NEVER import `keiko-model-gateway` — its
 * egress is an injected AtlassianHttpPort that keiko-server implements
 * with gatewayFetch). Exists only to prove the architecture gate fires
 * on real violations for the connectors boundary.
 *
 * Gate wiring:
 *   - rule `adr-0128-connectors-only-contracts-security` in
 *     `.dependency-cruiser.cjs` extends its `from.path` regex to include
 *     `tests/architecture/fixtures/connectors/` so this file is treated
 *     as if it were under the `keiko-connectors` boundary, and its
 *     `to.path` regex matches the relative import below.
 *   - `scripts/arch-check-negative.mjs` runs the gate against the
 *     fixtures and asserts that every expected rule fired by name.
 *
 * Toolchain exclusions (so this fixture does not break the normal
 * pipeline): root `tsconfig.json` `exclude`, `tsconfig.build.json`
 * `exclude`, and `eslint.config.js` `ignores` already cover
 * `tests/architecture/fixtures/**`.
 *
 * The relative import target resolves to a real file; dependency-cruiser
 * records the edge and the gate's `to.path` regex matches it and fires
 * the rule.
 */

import { gatewayFetch } from "../../../../packages/keiko-model-gateway/src/http.js";

export const violation: string =
  typeof gatewayFetch === "function"
    ? "intentional ADR-0128 violation fixture (connectors boundary)"
    : "unreachable";
