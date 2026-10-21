import { describe, expect, it, vi } from "vitest";
import { buildRedactor } from "./deps.js";
import { promptFitRedactor } from "./grounded-prompt-redactor.js";

describe("operation-local prompt redaction reuse", () => {
  it("keeps real redaction byte-identical for code, text and clipped candidates", () => {
    const redact = buildRedactor({});
    const observed = vi.fn(redact);
    const fit = promptFitRedactor(observed, 16_384);
    for (const value of [
      "export function value(): number { return 42; }",
      "public class Value { public int value() { return 42; } }",
      '{"value":42}',
      "export function value(): number {",
      "plain text",
      "",
    ]) {
      expect(fit(value)).toEqual(redact(value));
      expect(fit(value)).toEqual(redact(value));
      expect(observed.mock.calls.filter(([input]) => input === value)).toHaveLength(1);
    }
  });

  it("charges both UTF-8 keys and results and delegates when the byte grant is exhausted", () => {
    const redact = vi.fn((value: unknown): unknown => value);
    const fit = promptFitRedactor(redact, 4);
    expect(fit("é")).toBe("é");
    expect(fit("é")).toBe("é");
    expect(fit("x")).toBe("x");
    expect(fit("x")).toBe("x");
    expect(redact).toHaveBeenCalledTimes(3);
  });

  it("bounds entry count even for tiny distinct values", () => {
    const redact = vi.fn((value: unknown): unknown => value);
    const fit = promptFitRedactor(redact, 100_000);
    for (let index = 0; index < 129; index++) fit(String(index));
    fit("0");
    fit("128");
    expect(redact).toHaveBeenCalledTimes(130);
  });

  it("does not share results across operations or redaction policies", () => {
    const first = vi.fn(() => "first policy");
    const second = vi.fn(() => "second policy");
    expect(promptFitRedactor(first, 1024)("value")).toBe("first policy");
    expect(promptFitRedactor(first, 1024)("value")).toBe("first policy");
    expect(promptFitRedactor(second, 1024)("value")).toBe("second policy");
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("delegates unknown values and non-string results without caching mutable objects", () => {
    const result = { value: "redacted" };
    const redact = vi.fn(() => result);
    const fit = promptFitRedactor(redact, 1024);
    for (const input of [result, result, "text", "text"]) expect(fit(input)).toBe(result);
    expect(redact).toHaveBeenCalledTimes(4);
  });

  it("propagates exceptions without storing failed redactions", () => {
    const redact = vi.fn(() => {
      throw new Error("redaction unavailable");
    });
    const fit = promptFitRedactor(redact, 1024);
    expect(() => fit("value")).toThrow("redaction unavailable");
    expect(() => fit("value")).toThrow("redaction unavailable");
    expect(redact).toHaveBeenCalledTimes(2);
  });
});
