import { describe, expect, it } from "vitest";

import { RedactingError } from "@oscharko-dev/keiko-security/errors/base";
import { RetrievalError, type RetrievalErrorCode } from "./errors.js";

// A secret shape redact() scrubs (OpenAI-style key). Split so the literal is never contiguous in
// source and long enough to satisfy the >= 16-char key pattern.
const SECRET = "sk-" + "test0ABC123DEF456GHI789";

describe("RetrievalError", () => {
  it("preserves discriminated code and message", () => {
    const err = new RetrievalError("empty-scopes", "scopes must not be empty");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RetrievalError);
    expect(err.code).toBe<RetrievalErrorCode>("empty-scopes");
    expect(err.message).toBe("scopes must not be empty");
    expect(err.name).toBe("RetrievalError");
  });

  it("propagates cause when provided", () => {
    const root = new Error("port down");
    const err = new RetrievalError("port-failure", "listByScope threw", { cause: root });
    expect(err.cause).toBe(root);
  });

  it("supports every documented error code", () => {
    const codes: readonly RetrievalErrorCode[] = [
      "empty-scopes",
      "invalid-budget",
      "invalid-threshold",
      "invalid-weight",
      "port-failure",
    ];
    for (const code of codes) {
      const err = new RetrievalError(code, `code ${code}`);
      expect(err.code).toBe(code);
    }
  });

  // GEN-MAINT-COUPLING-003/004 guard: the class now extends the shared RedactingError base, so a
  // secret can never reach `.message`. The `cause` (preserved above) is NOT redacted — only the
  // human-readable `.message` crosses the boundary.
  describe("shared RedactingError base (COUPLING-003/004)", () => {
    it("is an instanceof RedactingError and exposes .code", () => {
      const err = new RetrievalError("empty-scopes", "boom");
      expect(err).toBeInstanceOf(RedactingError);
      expect(err.code).toBe("empty-scopes");
    });

    it("redacts a known secret shape from .message at construction", () => {
      const err = new RetrievalError("port-failure", `leaked ${SECRET} value`);
      expect(err.message).not.toContain(SECRET);
      expect(err.message).toContain("[REDACTED]");
    });

    it("preserves the un-redacted cause alongside the redacted message", () => {
      const root = new Error(`root ${SECRET}`);
      const err = new RetrievalError("port-failure", `wrap ${SECRET}`, { cause: root });
      expect(err.message).not.toContain(SECRET);
      // The cause is kept verbatim for programmatic inspection; it does not cross a log boundary.
      expect(err.cause).toBe(root);
    });
  });
});
