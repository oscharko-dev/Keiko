import { describe, expect, it } from "vitest";
import {
  AUDIT_CODES,
  AuditError,
  EvidenceReadError,
  EvidenceSchemaError,
  EvidenceWriteError,
  InvalidRunIdError,
} from "./audit.js";

describe("audit errors", () => {
  it("redacts the message at construction", () => {
    const secret = "sk-" + "u".repeat(24);
    const error = new EvidenceWriteError(`failed to write ${secret}`);
    expect(error.message).not.toContain(secret);
    expect(error.message).toContain("[REDACTED]");
  });

  it("carries stable codes", () => {
    expect(new InvalidRunIdError("m").code).toBe(AUDIT_CODES.INVALID_RUN_ID);
    expect(new EvidenceWriteError("m").code).toBe(AUDIT_CODES.WRITE);
    expect(new EvidenceReadError("m").code).toBe(AUDIT_CODES.READ);
    expect(new EvidenceSchemaError("m", "0").code).toBe(AUDIT_CODES.SCHEMA);
  });

  it("EvidenceSchemaError carries foundVersion", () => {
    expect(new EvidenceSchemaError("m", "99").foundVersion).toBe("99");
  });

  it("subclasses are AuditError and real Error", () => {
    expect(new InvalidRunIdError("m")).toBeInstanceOf(AuditError);
    expect(new InvalidRunIdError("m")).toBeInstanceOf(Error);
  });
});
