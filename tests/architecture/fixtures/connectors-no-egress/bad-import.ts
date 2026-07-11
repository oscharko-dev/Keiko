/**
 * INTENTIONAL ADR-0128 VIOLATION FIXTURE
 *
 * Deliberately violates `adr-0128-connectors-no-direct-egress`
 * (`keiko-connectors` has no concrete network capability — ADR-0128 D1
 * mirrors the keiko-local-knowledge trust-9 no-egress posture; outbound
 * HTTP arrives only through the injected AtlassianHttpPort implemented
 * by keiko-server over gatewayFetch). Exists only to prove the AST
 * import-policy gate fires on real violations.
 *
 * Gate wiring:
 *   - rule `adr-0128-connectors-no-direct-egress` in
 *     `scripts/check-import-policy.mjs` scopes its fixtures mode to
 *     `tests/architecture/fixtures/connectors-no-egress/`.
 *   - `scripts/arch-check-negative.mjs` asserts the rule fired exactly
 *     once against this fixture.
 */

import { request } from "node:https";

export function leak(): void {
  request("https://example.invalid").end();
}
