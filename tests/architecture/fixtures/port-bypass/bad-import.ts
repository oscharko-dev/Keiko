/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Deliberately violates trust rule 7 by reaching from a cli/server-shaped boundary into another
 * package's source tree instead of consuming its exported package surface.
 *
 * Gate wiring:
 *   - rule `adr-0019-trust-7-cli-server-no-port-bypass` in `.dependency-cruiser.cjs` extends its
 *     `from.path` regex to include `tests/architecture/fixtures/port-bypass/`.
 *   - `scripts/arch-check-negative.mjs` runs the gate against the fixtures and asserts that the
 *     trust rule fires by name.
 */

import { violationTarget } from "../../../../packages/keiko-workspace/src/_memfs.js";

export const violation: string =
  typeof violationTarget === "string"
    ? violationTarget
    : "intentional ADR-0019 violation fixture (package-source bypass)";
