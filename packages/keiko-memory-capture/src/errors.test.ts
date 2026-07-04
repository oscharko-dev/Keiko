import { describe, expect, it } from "vitest";

import { RedactingError } from "@oscharko-dev/keiko-security/errors/base";
import { CaptureRejection, type RejectionReason } from "./errors.js";

// A secret shape redact() scrubs (OpenAI-style key). Split so the literal is never contiguous in
// source and long enough to satisfy the >= 16-char key pattern.
const SECRET = "sk-" + "test0ABC123DEF456GHI789";

describe("CaptureRejection", () => {
  it("carries the typed reason class on the error instance", () => {
    const error = new CaptureRejection("credential-shape", "matched a credential shape");
    expect(error.reason).toBe<RejectionReason>("credential-shape");
    expect(error.name).toBe("CaptureRejection");
    expect(error.message).toBe("matched a credential shape");
    expect(error).toBeInstanceOf(Error);
  });

  it("preserves each rejection reason as a discrete brand", () => {
    // Mutation witness: dropping or renaming a reason in the union breaks this assertion
    // because TypeScript would no longer accept the literal at the typed slot.
    const reasons: readonly RejectionReason[] = [
      "credential-shape",
      "private-credential-path",
      "provider-base-url",
      "raw-log-content",
      "customer-identifier",
      "empty-content",
      "exceeds-length-limit",
      "ambiguous-forget",
      "ambiguous-update",
      "restricted-sensitivity",
      "scope-not-resolvable",
    ];
    expect(reasons).toHaveLength(11);
  });

  // GEN-MAINT-COUPLING-003/004 guard: CaptureRejection is a thrown error, so it now extends the
  // shared RedactingError base — its `.message` is scrubbed of secret shapes by construction while
  // `.reason` (and its `.code` mirror) stay the domain discriminator, and `.name` is unchanged.
  describe("shared RedactingError base (COUPLING-003/004)", () => {
    it("is an instanceof RedactingError and mirrors reason under .code", () => {
      const error = new CaptureRejection("credential-shape", "matched a credential shape");
      expect(error).toBeInstanceOf(RedactingError);
      expect(error.code).toBe<RejectionReason>("credential-shape");
      expect(error.reason).toBe<RejectionReason>("credential-shape");
      expect(error.name).toBe("CaptureRejection");
    });

    it("redacts a known secret shape from .message at construction", () => {
      const error = new CaptureRejection("raw-log-content", `caller passed ${SECRET} here`);
      expect(error.message).not.toContain(SECRET);
      expect(error.message).toContain("[REDACTED]");
    });
  });
});
