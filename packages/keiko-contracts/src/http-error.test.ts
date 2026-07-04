import { describe, expect, it } from "vitest";
import { CodedHttpError, httpStatusFor } from "./http-error.js";

// A concrete per-domain subclass that mirrors the intended usage: a code-literal union,
// a domain STATUS_MAP, and a subclass that derives its status from that map.
type SampleCode = "not-found" | "conflict" | "server-error";

const SAMPLE_STATUS_MAP: Readonly<Record<SampleCode, number>> = {
  "not-found": 404,
  conflict: 409,
  "server-error": 500,
};

class SampleHttpError extends CodedHttpError {
  readonly code: SampleCode;

  constructor(code: SampleCode, message: string) {
    super(message, httpStatusFor(SAMPLE_STATUS_MAP, code));
    this.code = code;
  }
}

describe("CodedHttpError (GEN-DUP-NEAR-008)", () => {
  it("derives status from the domain STATUS_MAP via httpStatusFor", () => {
    expect(new SampleHttpError("not-found", "missing").status).toBe(404);
    expect(new SampleHttpError("conflict", "clash").status).toBe(409);
    expect(new SampleHttpError("server-error", "boom").status).toBe(500);
  });

  it("exposes the concrete code and message", () => {
    const err = new SampleHttpError("conflict", "clash");
    expect(err.code).toBe("conflict");
    expect(err.message).toBe("clash");
  });

  it("is an instanceof Error and CodedHttpError with the subclass name", () => {
    const err = new SampleHttpError("server-error", "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CodedHttpError);
    expect(err.name).toBe("SampleHttpError");
  });

  it("httpStatusFor returns the mapped status", () => {
    expect(httpStatusFor(SAMPLE_STATUS_MAP, "not-found")).toBe(404);
  });
});
