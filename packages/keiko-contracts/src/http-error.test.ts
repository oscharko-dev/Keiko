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

  constructor(code: SampleCode, message: string, options?: ErrorOptions) {
    super(message, httpStatusFor(SAMPLE_STATUS_MAP, code), options);
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

  it("retains an optional internal cause without changing the public message", () => {
    const cause = new Error("operator-only detail");
    const err = new SampleHttpError("server-error", "operation failed", { cause });

    expect(err.message).toBe("operation failed");
    expect(err.cause).toBe(cause);
  });

  // KEIKO-0859: the doc-comment claim that this helper prevents a silent undefined only holds if
  // the runtime path actually rejects an unknown code. An `as C` bypass at the caller or a hand-
  // maintained map with a forgotten key must fail loud, not coerce undefined into the response.
  it("throws when the code is missing from the map (KEIKO-0859)", () => {
    expect(() => httpStatusFor(SAMPLE_STATUS_MAP, "does-not-exist" as SampleCode)).toThrow(
      /httpStatusFor: unknown code/,
    );
    // Prototype-chain reads must fail: `map["constructor"]` and `map["toString"]` used to return
    // undefined (via the prototype) and be coerced to NaN in status arithmetic.
    expect(() => httpStatusFor(SAMPLE_STATUS_MAP, "constructor" as SampleCode)).toThrow(TypeError);
    expect(() => httpStatusFor(SAMPLE_STATUS_MAP, "toString" as SampleCode)).toThrow(TypeError);
  });
});
