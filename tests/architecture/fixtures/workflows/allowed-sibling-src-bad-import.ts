/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Deliberately violates the workflows boundary by reaching into an allow-listed sibling package's
 * source tree through a filesystem path instead of consuming the package export surface.
 *
 * Gate wiring:
 *   - rule `adr-0019-direction-5a-workflows-only-contracts-security-model-gateway-workspace-tools-harness-evidence`
 *     in `.dependency-cruiser.cjs` extends its `from.path` regex to include
 *     `tests/architecture/fixtures/workflows/`.
 *   - `scripts/arch-check-negative.mjs` runs the gate against the fixtures and asserts that this
 *     rule fires twice: once for the non-allow-listed sibling fixture and once for this
 *     allow-listed sibling package-source bypass.
 */

import { violationTarget } from "../../../../packages/keiko-workspace/src/index.js";

export const violation: string =
  typeof violationTarget === "string"
    ? violationTarget
    : "intentional ADR-0019 violation fixture (workflows sibling package-source bypass)";
