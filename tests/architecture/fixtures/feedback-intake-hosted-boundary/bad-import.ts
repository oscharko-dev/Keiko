/**
 * INTENTIONAL ADR-0134 VIOLATION FIXTURE
 *
 * Proves the separately deployed feedback-intake service cannot import the local BFF plane.
 */
import { violationTarget } from "../../../../packages/keiko-server/src/index.js";

export const violation: string =
  typeof violationTarget === "string"
    ? violationTarget
    : "intentional ADR-0134 hosted feedback-intake boundary violation";
