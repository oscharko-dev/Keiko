// Contract tests for buildBffHeaders (RB-6 / GEN-OBS-CORRELATION-601), shared by the ./http BFF
// fetch scaffold and the ./api desktop chat stream client.
//
// #3241 review — `HeadersInit` has three legal runtime shapes (plain record, `Headers` instance,
// tuple array). The former implementation only handled the record shape correctly: spreading a
// `Headers` instance onto a plain object copies no own enumerable properties, so every caller
// header silently vanished, and spreading a tuple array produced numeric-indexed junk instead of
// header names. These tests pin that all three shapes are preserved, and that a caller-supplied
// correlation id still wins over the generated one.

import { describe, expect, it } from "vitest";
import { buildBffHeaders, CORRELATION_HEADER } from "./bff-correlation";

// The production return value is the plain record every fetch consumer reads; the shape tests read
// it through `Headers` so the assertions are case-insensitive, the way the wire is.
function build(init: RequestInit | undefined, correlationId: string): Headers {
  return new Headers(buildBffHeaders(init, correlationId));
}

describe("buildBffHeaders — HeadersInit shape preservation", () => {
  it("preserves a caller header supplied as a plain record", () => {
    const headers = build({ headers: { "X-Test": "record-value" } }, "gen-id");
    expect(headers.get("X-Test")).toBe("record-value");
  });

  it("preserves a caller header supplied as a Headers instance", () => {
    const callerHeaders = new Headers([["X-Test", "headers-value"]]);
    const headers = build({ headers: callerHeaders }, "gen-id");
    expect(headers.get("X-Test")).toBe("headers-value");
  });

  it("preserves a caller header supplied as a tuple array", () => {
    const headers = build({ headers: [["X-Test", "tuple-value"]] }, "gen-id");
    expect(headers.get("X-Test")).toBe("tuple-value");
  });

  it("lets a caller-supplied X-Keiko-Correlation-Id win over the generated id, for all three shapes", () => {
    const record = build({ headers: { [CORRELATION_HEADER]: "caller-id" } }, "gen-id");
    const headersInstance = build(
      { headers: new Headers([[CORRELATION_HEADER, "caller-id"]]) },
      "gen-id",
    );
    const tupleArray = build({ headers: [[CORRELATION_HEADER, "caller-id"]] }, "gen-id");

    expect(record.get(CORRELATION_HEADER)).toBe("caller-id");
    expect(headersInstance.get(CORRELATION_HEADER)).toBe("caller-id");
    expect(tupleArray.get(CORRELATION_HEADER)).toBe("caller-id");
  });
});

describe("buildBffHeaders — computed defaults", () => {
  it("sends only Accept + the generated correlation id on a plain GET", () => {
    const headers = build(undefined, "gen-id");
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get(CORRELATION_HEADER)).toBe("gen-id");
    expect(headers.has("Content-Type")).toBe(false);
    expect(headers.has("X-Keiko-CSRF")).toBe(false);
  });

  it("adds Content-Type and CSRF on a state-changing method even without a body", () => {
    const headers = build({ method: "DELETE" }, "gen-id");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Keiko-CSRF")).toBe("1");
  });

  it("adds Content-Type (but not CSRF) when a body is present on a non-state-changing method", () => {
    const headers = build({ method: "GET", body: "{}" }, "gen-id");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.has("X-Keiko-CSRF")).toBe(false);
  });

  it("lets a caller override a computed default, e.g. a non-JSON Accept", () => {
    const headers = build({ headers: { Accept: "application/pdf" } }, "gen-id");
    expect(headers.get("Accept")).toBe("application/pdf");
  });
});

describe("buildBffHeaders — plain-record contract", () => {
  it("returns a plain record that keeps the caller's key casing and the computed defaults", () => {
    const record = buildBffHeaders({ method: "POST", headers: { "X-Test": "v" } }, "gen-id");
    expect(record).toEqual({
      Accept: "application/json",
      [CORRELATION_HEADER]: "gen-id",
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
      "X-Test": "v",
    });
  });

  it("replaces a computed default when the caller supplies it under a different casing", () => {
    // A `Headers` instance iterates lower-cased names; the default must be REPLACED, not left beside
    // the override as a second, conflicting entry.
    const record = buildBffHeaders(
      { method: "POST", headers: new Headers({ "content-type": "text/plain" }) },
      "gen-id",
    );
    expect(Object.keys(record).filter((k) => k.toLowerCase() === "content-type")).toEqual([
      "content-type",
    ]);
    expect(record["content-type"]).toBe("text/plain");
  });
});
