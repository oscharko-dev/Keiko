/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Deliberately violates direction rule 8: the browser-tier UI package must not value-import
 * Node-only domain packages. The target is keiko-tools because it is Node-only and does not also
 * trigger the UI model-gateway trust rules.
 */
import { violationTarget } from "../../../../packages/keiko-tools/src/index.js";

export const violation: string =
  typeof violationTarget === "string"
    ? violationTarget
    : "intentional ADR-0019 violation fixture (ui browser boundary)";
