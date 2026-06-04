/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Deliberately violates direction rule 9: the root product facade may compose through package
 * public surfaces, but must not deep-import sibling package source.
 */
import { violationTarget } from "../../../../packages/keiko-tools/src/index.js";

export const violation: string =
  typeof violationTarget === "string"
    ? violationTarget
    : "intentional ADR-0019 violation fixture (root facade)";
