// Prompt Enhancer safe-error taxonomy (Epic #1307, Issue #1313; ADR-0044 §1/§5).
// Mirrors the gateway/tools/audit taxonomies: errors carry a stable `code` discriminant; callers
// switch on `code`, never parse `message`. Every message is redacted at construction so an enhancer
// error is always safe to log, persist as evidence, or surface across a trust boundary — it can never
// carry a secret, raw user input, untrusted-evidence text, or a provider/deployment endpoint.

import { RedactingError } from "./base.js";

export const PROMPT_ENHANCER_ERROR_CODES = {
  // A generated prompt or candidate failed safety validation (the validate stage rejected it).
  VALIDATION_FAILED: "PROMPT_ENHANCER_VALIDATION_FAILED",
  // A candidate did not preserve the safety floor or carried prohibited content; it was rejected.
  UNSAFE_CANDIDATE: "PROMPT_ENHANCER_UNSAFE_CANDIDATE",
  // Untrusted content attempted prompt injection / instruction override.
  INJECTION_DETECTED: "PROMPT_ENHANCER_INJECTION_DETECTED",
  // Content requested secrets, credentials, or system-prompt disclosure.
  SECRET_DISCLOSURE: "PROMPT_ENHANCER_SECRET_DISCLOSURE",
  // A trusted section attempted to grant tool/file/network/secret authority.
  AUTHORITY_GRANT: "PROMPT_ENHANCER_AUTHORITY_GRANT",
  // Persisting prompt-enhancement evidence failed.
  EVIDENCE_WRITE: "PROMPT_ENHANCER_EVIDENCE_WRITE",
  // Reading prompt-enhancement evidence failed (missing, corrupt, or schema-invalid).
  EVIDENCE_READ: "PROMPT_ENHANCER_EVIDENCE_READ",
} as const;

export type PromptEnhancerErrorCode =
  (typeof PROMPT_ENHANCER_ERROR_CODES)[keyof typeof PROMPT_ENHANCER_ERROR_CODES];

export abstract class PromptEnhancerError extends RedactingError {
  abstract override readonly code: PromptEnhancerErrorCode;
}

// The validate stage rejected a generated prompt. `findingCodes` are the closed-vocabulary safety
// violation codes that drove the rejection (no free text — safe to surface).
export class PromptEnhancerValidationError extends PromptEnhancerError {
  readonly code = PROMPT_ENHANCER_ERROR_CODES.VALIDATION_FAILED;
  readonly findingCodes: readonly string[];

  constructor(
    message: string,
    findingCodes: readonly string[] = [],
    secrets: readonly string[] = [],
  ) {
    super(message, secrets);
    this.findingCodes = findingCodes;
  }
}

export class UnsafeCandidateError extends PromptEnhancerError {
  readonly code = PROMPT_ENHANCER_ERROR_CODES.UNSAFE_CANDIDATE;
}

export class PromptInjectionDetectedError extends PromptEnhancerError {
  readonly code = PROMPT_ENHANCER_ERROR_CODES.INJECTION_DETECTED;
}

export class SecretDisclosureError extends PromptEnhancerError {
  readonly code = PROMPT_ENHANCER_ERROR_CODES.SECRET_DISCLOSURE;
}

export class AuthorityGrantError extends PromptEnhancerError {
  readonly code = PROMPT_ENHANCER_ERROR_CODES.AUTHORITY_GRANT;
}

export class PromptEnhancerEvidenceWriteError extends PromptEnhancerError {
  readonly code = PROMPT_ENHANCER_ERROR_CODES.EVIDENCE_WRITE;
}

export class PromptEnhancerEvidenceReadError extends PromptEnhancerError {
  readonly code = PROMPT_ENHANCER_ERROR_CODES.EVIDENCE_READ;
}
