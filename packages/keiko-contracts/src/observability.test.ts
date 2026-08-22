import { describe, expect, it } from "vitest";

import { ERROR_KIND_PATTERN, classifyErrorKind, isErrorKind } from "./observability.js";

describe("ERROR_KIND_PATTERN (ADR-0173 D11)", () => {
  it("accepts an identifier, a taxonomy code, and a constructor name", () => {
    expect(ERROR_KIND_PATTERN.test("PROXY_BLOCKED_BY_POLICY")).toBe(true);
    expect(ERROR_KIND_PATTERN.test("ECONNREFUSED")).toBe(true);
    expect(ERROR_KIND_PATTERN.test("TypeError")).toBe(true);
    expect(ERROR_KIND_PATTERN.test("http-error")).toBe(true);
  });

  it("rejects a sentence, which is where a provider's rejected input hides", () => {
    expect(ERROR_KIND_PATTERN.test("Setting {'encoding_format': 'float'} is not supported")).toBe(
      false,
    );
    expect(ERROR_KIND_PATTERN.test("token sk-proj-abc is invalid")).toBe(false);
  });

  it("rejects an empty string and a value not starting with a letter", () => {
    expect(ERROR_KIND_PATTERN.test("")).toBe(false);
    expect(ERROR_KIND_PATTERN.test("9NOTANIDENTIFIER")).toBe(false);
    expect(ERROR_KIND_PATTERN.test("_leading-underscore")).toBe(false);
  });

  it("accepts exactly 64 characters and rejects a longer run that could hide a payload", () => {
    expect(ERROR_KIND_PATTERN.test(`E${"x".repeat(63)}`)).toBe(true);
    expect(ERROR_KIND_PATTERN.test(`E${"x".repeat(64)}`)).toBe(false);
  });
});

describe("isErrorKind", () => {
  it("narrows a conforming string and rejects a non-conforming one", () => {
    expect(isErrorKind("RangeError")).toBe(true);
    expect(isErrorKind("not an identifier!")).toBe(false);
  });

  it("rejects every non-string value", () => {
    expect(isErrorKind(42)).toBe(false);
    expect(isErrorKind(undefined)).toBe(false);
    expect(isErrorKind(null)).toBe(false);
    expect(isErrorKind({ code: "AbortError" })).toBe(false);
  });
});

describe("classifyErrorKind", () => {
  it("returns the value unchanged when it conforms", () => {
    expect(classifyErrorKind("AbortError")).toBe("AbortError");
  });

  it("returns undefined for a non-conforming or non-string value", () => {
    expect(classifyErrorKind("a whole sentence of prose")).toBeUndefined();
    expect(classifyErrorKind(123)).toBeUndefined();
    expect(classifyErrorKind(undefined)).toBeUndefined();
  });
});
