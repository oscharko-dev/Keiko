/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Proves production source must not import test-only helpers.
 */
import { violationTarget } from "../../../../packages/keiko-quality-intelligence/src/__tests__/_fixtureLoader.js";

export const violation: string =
  typeof violationTarget === "string"
    ? violationTarget
    : "intentional ADR-0019 violation fixture (no test helpers in production)";
