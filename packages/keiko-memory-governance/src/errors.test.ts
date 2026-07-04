import { describe, expect, it } from "vitest";

import { RedactingError } from "@oscharko-dev/keiko-security/errors/base";
import { GovernanceError, type GovernanceErrorCode } from "./errors.js";

// A secret shape redact() scrubs (OpenAI-style key). Split so the literal is never contiguous in
// source and long enough to satisfy the >= 16-char key pattern.
const SECRET = "sk-" + "test0ABC123DEF456GHI789";

describe("GovernanceError", () => {
  it("preserves code and message on the instance", () => {
    const err = new GovernanceError("envelope-validation-failed", "bad envelope");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GovernanceError);
    expect(err.code).toBe("envelope-validation-failed");
    expect(err.name).toBe("GovernanceError");
    expect(err.message).toContain("envelope-validation-failed");
    expect(err.message).toContain("bad envelope");
  });

  it("carries optional details when provided", () => {
    const err = new GovernanceError("illegal-status-transition", "no go", [
      "from: forgotten",
      "to: accepted",
    ]);
    expect(err.details).toEqual(["from: forgotten", "to: accepted"]);
  });

  it("omits details when not provided", () => {
    const err = new GovernanceError("idempotent-noop", "already pinned");
    expect(err.details).toBeUndefined();
  });

  it("admits every documented error code at the type level", () => {
    const codes: readonly GovernanceErrorCode[] = [
      "envelope-validation-failed",
      "illegal-status-transition",
      "invalid-resolution",
      "invalid-threshold",
      "invalid-validity-window",
      "idempotent-noop",
      "unsupported-selector",
      "invalid-selector-input",
      "memory-not-eligible",
    ];
    for (const code of codes) {
      const err = new GovernanceError(code, "test");
      expect(err.code).toBe(code);
    }
  });

  // GEN-MAINT-COUPLING-003/004 guard: the class now extends the shared RedactingError base, so a
  // secret can never reach `.message` even if a call-site forgets to sanitise. Preserving the
  // `GovernanceError(code): ...` prefix and `.code` is asserted above; this locks in redaction.
  describe("shared RedactingError base (COUPLING-003/004)", () => {
    it("is an instanceof RedactingError and exposes .code", () => {
      const err = new GovernanceError("envelope-validation-failed", "boom");
      expect(err).toBeInstanceOf(RedactingError);
      expect(err.code).toBe("envelope-validation-failed");
    });

    it("redacts a known secret shape from .message at construction", () => {
      const err = new GovernanceError("invalid-selector-input", `leaked ${SECRET} value`);
      expect(err.message).not.toContain(SECRET);
      expect(err.message).toContain("[REDACTED]");
      // The human-readable prefix survives redaction.
      expect(err.message).toContain("GovernanceError(invalid-selector-input)");
    });
  });
});
