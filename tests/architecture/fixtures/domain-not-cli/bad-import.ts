/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Proves domain packages must not import from keiko-cli.
 */
import { violationTarget } from "../../../../packages/keiko-cli/src/index.js";

export const violation: string =
  typeof violationTarget === "string"
    ? violationTarget
    : "intentional ADR-0019 violation fixture (domain not cli)";
