import { detectPromptInjectionSignals } from "@oscharko-dev/keiko-security";

import type { RejectionReason } from "./errors.js";
import { classifyDeniedCategory } from "./classify-denied-category.js";
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
  const hardDenial = memoryTextSecretEgressRejectionReason(trimmed, policy);
  if (hardDenial !== null) {
    return hardDenial;
  }
  if (policy.defaultSensitivity === "restricted") {
    return "restricted-sensitivity";
  }
  const sensitivity = classifySensitivity(trimmed, policy.defaultSensitivity);
  return sensitivity === "public" ? null : "sensitive-memory-requires-approval";
}

export function memoryTextSecretEgressRejectionReason(
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
  return classifyDeniedCategory(trimmed, policy.deniedCategoryMatchers ?? []);
}

// What may become a memory. A person's clear statement is their decision, but it cannot make a
// memory out of an instruction to drop the assistant's rules. Reading stored text is a different
// question and stays with the secret check above.
export function memoryTextCaptureRejectionReason(
  text: string,
  policy: CapturePolicyOptions = {},
): RejectionReason | null {
  const secretReason = memoryTextSecretEgressRejectionReason(text, policy);
  if (secretReason !== null) {
    return secretReason;
  }
  const overridesRules = detectPromptInjectionSignals(text).some(
    (signal) => signal.code === "instruction-override",
  );
  return overridesRules ? "instruction-override" : null;
}
