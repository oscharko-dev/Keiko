/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Proves browser-visible UI code must not import credential-bearing model-gateway config.
 */
import { violationTarget } from "../../../../packages/keiko-model-gateway/src/config.js";

export const violation: string =
  typeof violationTarget === "string"
    ? violationTarget
    : "intentional ADR-0019 violation fixture (ui provider config)";
