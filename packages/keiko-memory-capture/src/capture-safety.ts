import type { RejectionReason } from "./errors.js";
import { classifySensitivity } from "./policy.js";
import { scanForSecrets } from "./secret-patterns.js";
import type { CapturePolicyOptions } from "./types.js";

export function memoryTextEgressRejectionReason(
  text: string,
  policy: CapturePolicyOptions = {},
): RejectionReason | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const secretReason = scanForSecrets(trimmed, policy.customerIdentifierMatchers ?? []);
  if (secretReason !== null) {
    return secretReason;
  }
  if (policy.defaultSensitivity === "restricted") {
    return "restricted-sensitivity";
  }
  const sensitivity = classifySensitivity(trimmed, policy.defaultSensitivity);
  return sensitivity === "public" ? null : "sensitive-memory-requires-approval";
}
