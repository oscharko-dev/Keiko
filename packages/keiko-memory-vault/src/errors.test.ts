import { describe, expect, it } from "vitest";

import { RedactingError } from "@oscharko-dev/keiko-security/errors/base";
import {
  MemoryStorageError,
  MemoryStorageValidationError,
  type MemoryStorageErrorCode,
} from "./errors.js";

// A secret shape redact() scrubs (OpenAI-style key). Split so the literal is never contiguous in
// source and long enough to satisfy the >= 16-char key pattern.
const SECRET = "sk-" + "test0ABC123DEF456GHI789";

describe("MemoryStorageError", () => {
  it("preserves discriminated code and name", () => {
    const err = new MemoryStorageError("not-found", "no such memory");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MemoryStorageError);
    expect(err.code).toBe<MemoryStorageErrorCode>("not-found");
    expect(err.name).toBe("MemoryStorageError");
  });

  it("supports every documented error code", () => {
    const codes: readonly MemoryStorageErrorCode[] = [
      "invalid-path",
      "invalid-input",
      "not-found",
      "constraint-violation",
      "schema-mismatch",
      "internal",
    ];
    for (const code of codes) {
      const err = new MemoryStorageError(code, `code ${code}`);
      expect(err.code).toBe(code);
    }
  });

  // GEN-MAINT-COUPLING-003/004 guard: the root now extends the shared RedactingError base so a raw
  // path, SQL fragment, or credential can never reach `.message` even if a call-site forgets to
  // sanitise. This is the redaction-by-construction invariant for the whole memory taxonomy.
  describe("shared RedactingError base (COUPLING-003/004)", () => {
    it("is an instanceof RedactingError and exposes .code", () => {
      const err = new MemoryStorageError("internal", "boom");
      expect(err).toBeInstanceOf(RedactingError);
      expect(err.code).toBe("internal");
    });

    it("redacts a known secret shape from .message at construction", () => {
      const err = new MemoryStorageError("internal", `leaked ${SECRET} value`);
      expect(err.message).not.toContain(SECRET);
      expect(err.message).toContain("[REDACTED]");
    });

    it("redacts a caller-supplied additional secret", () => {
      const err = new MemoryStorageError("invalid-path", "path /srv/hunter2/db failed", [
        "hunter2",
      ]);
      expect(err.message).not.toContain("hunter2");
    });
  });
});

describe("MemoryStorageValidationError", () => {
  it("preserves the failures array and is a MemoryStorageError with invalid-input code", () => {
    const failures = [
      { path: ["content"], message: "required" },
      { path: ["scope", "kind"], message: "invalid" },
    ];
    const err = new MemoryStorageValidationError("validation failed", failures);
    expect(err).toBeInstanceOf(MemoryStorageError);
    expect(err).toBeInstanceOf(RedactingError);
    expect(err.name).toBe("MemoryStorageValidationError");
    expect(err.code).toBe("invalid-input");
    expect(err.failures).toEqual(failures);
  });

  it("redacts a secret shape from the validator message while keeping .failures intact", () => {
    const failures = [{ path: ["token"], message: "looks like a credential" }];
    const err = new MemoryStorageValidationError(`validator saw ${SECRET}`, failures);
    expect(err.message).not.toContain(SECRET);
    expect(err.failures).toEqual(failures);
  });
});
