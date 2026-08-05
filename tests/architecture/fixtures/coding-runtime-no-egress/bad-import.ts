/**
 * INTENTIONAL GEN-ARCH-CODING-RUNTIME-001 VIOLATION FIXTURE
 *
 * Deliberately violates `gen-arch-coding-runtime-restricted-egress` (no file under
 * `packages/keiko-server/src/coding-runtime/` may hold raw outbound network or
 * process-spawning capability outside the two reviewed allow-lists in
 * `scripts/check-import-policy.mjs`). Public-internet egress belongs to
 * `researchEgressPort.ts` alone, and even that port holds no raw socket — it
 * delegates to the governed `gatewayFetch`. Exists only to prove the AST
 * import-policy gate fires on real violations.
 *
 * Gate wiring:
 *   - rule `gen-arch-coding-runtime-restricted-egress` in
 *     `scripts/check-import-policy.mjs` scopes its fixtures mode to
 *     `tests/architecture/fixtures/coding-runtime-no-egress/`.
 *   - `scripts/arch-check-negative.mjs` asserts the rule fired exactly once
 *     against this fixture (`EXPECTED_IMPORT_POLICY_RULE_COUNTS`).
 */

import { request } from "node:https";

export function leak(): void {
  request("https://example.invalid").end();
}
