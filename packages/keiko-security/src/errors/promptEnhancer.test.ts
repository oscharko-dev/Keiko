// Tests for the Prompt Enhancer safe-error taxonomy (Issue #1313). Confirms each error carries its
// stable code discriminant, redacts its message at construction, and surfaces structured metadata.

import { describe, it, expect } from "vitest";
import {
  AuthorityGrantError,
  PROMPT_ENHANCER_ERROR_CODES,
  PromptEnhancerError,
  PromptEnhancerEvidenceReadError,
  PromptEnhancerEvidenceWriteError,
  PromptEnhancerValidationError,
  PromptInjectionDetectedError,
  SecretDisclosureError,
  UnsafeCandidateError,
} from "./promptEnhancer.js";

describe("PromptEnhancer error taxonomy", () => {
  it("assigns the stable code discriminant to each error", () => {
    expect(new PromptEnhancerValidationError("x").code).toBe(
      PROMPT_ENHANCER_ERROR_CODES.VALIDATION_FAILED,
    );
    expect(new UnsafeCandidateError("x").code).toBe(PROMPT_ENHANCER_ERROR_CODES.UNSAFE_CANDIDATE);
    expect(new PromptInjectionDetectedError("x").code).toBe(
      PROMPT_ENHANCER_ERROR_CODES.INJECTION_DETECTED,
    );
    expect(new SecretDisclosureError("x").code).toBe(PROMPT_ENHANCER_ERROR_CODES.SECRET_DISCLOSURE);
    expect(new AuthorityGrantError("x").code).toBe(PROMPT_ENHANCER_ERROR_CODES.AUTHORITY_GRANT);
    expect(new PromptEnhancerEvidenceWriteError("x").code).toBe(
      PROMPT_ENHANCER_ERROR_CODES.EVIDENCE_WRITE,
    );
    expect(new PromptEnhancerEvidenceReadError("x").code).toBe(
      PROMPT_ENHANCER_ERROR_CODES.EVIDENCE_READ,
    );
  });

  it("is an instance of the abstract base and Error", () => {
    const error = new UnsafeCandidateError("x");
    expect(error).toBeInstanceOf(PromptEnhancerError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("UnsafeCandidateError");
  });

  it("redacts known secret shapes from the message at construction", () => {
    const error = new SecretDisclosureError("token leaked: sk-abcdefghij1234567890");
    expect(error.message).not.toContain("sk-abcdefghij1234567890");
    expect(error.message).toContain("[REDACTED]");
  });

  it("redacts caller-supplied literal secrets", () => {
    const error = new PromptInjectionDetectedError("context value was super-secret-literal", [
      "super-secret-literal",
    ]);
    expect(error.message).not.toContain("super-secret-literal");
  });

  it("carries the closed-vocabulary finding codes on a validation error", () => {
    const error = new PromptEnhancerValidationError("rejected", [
      "missing-authority-restriction",
      "capability-grant-claim",
    ]);
    expect(error.findingCodes).toEqual(["missing-authority-restriction", "capability-grant-claim"]);
  });

  it("defaults finding codes to an empty list", () => {
    expect(new PromptEnhancerValidationError("rejected").findingCodes).toEqual([]);
  });
});
