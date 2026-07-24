import { describe, expect, it } from "vitest";
import { parsedRequestedMode } from "./autonomyPolicyRequest.js";

describe("parsedRequestedMode", () => {
  it("accepts each product mode the contracts define", (): void => {
    expect(parsedRequestedMode('{"requestedMode":"governed-assist"}')).toBe("governed-assist");
    expect(parsedRequestedMode('{"requestedMode":"supervised-coding"}')).toBe("supervised-coding");
    expect(parsedRequestedMode('{"requestedMode":"autonomous-delivery"}')).toBe(
      "autonomous-delivery",
    );
  });

  it.each([
    ["an absent body", null],
    ["invalid JSON", "{requestedMode:"],
    ["a JSON primitive", '"governed-assist"'],
    ["a JSON array", '["governed-assist"]'],
    ["JSON null", "null"],
    ["a missing mode", "{}"],
    ["an unknown mode", '{"requestedMode":"root-access"}'],
    ["a non-string mode", '{"requestedMode":42}'],
    ["a case-shifted mode", '{"requestedMode":"Governed-Assist"}'],
  ])("refuses %s", (_label, payload): void => {
    expect(parsedRequestedMode(payload)).toBeNull();
  });
});
