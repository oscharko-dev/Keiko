import {
  parseManagedLspActivationInput,
  resolveManagedLspActivation,
  type ManagedLspActivationResolution,
} from "@oscharko-dev/keiko-contracts";

// Keep the server policy seam deliberately thin: ADR-0131's fixed contract resolver is the one
// precedence implementation. This wrapper accepts hostile/persisted input and never throws, so a
// caller cannot accidentally bypass the contract parser by constructing a typed-looking object.
export function evaluateManagedLspActivation(value: unknown): ManagedLspActivationResolution {
  const parsed = parseManagedLspActivationInput(value);
  return parsed.ok
    ? resolveManagedLspActivation(parsed.value)
    : { ok: false, state: "disabled", reasonCode: "INVALID_INPUT", policyResult: "denied" };
}
