/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Proves browser-visible UI code must not import model-gateway internals directly.
 */
import { violationTarget } from "../../../../packages/keiko-model-gateway/src/gateway.js";

export const violation: string =
  typeof violationTarget === "string"
    ? violationTarget
    : "intentional ADR-0019 violation fixture (ui gateway internals)";
