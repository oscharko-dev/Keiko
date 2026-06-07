/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Proves leaf/domain packages that are not approved callers cannot import keiko-evidence.
 */
import { violationTarget } from "../../../../packages/keiko-evidence/src/index.js";

export const violation: string =
  typeof violationTarget === "string"
    ? violationTarget
    : "intentional ADR-0019 violation fixture (evidence allowed callers)";
