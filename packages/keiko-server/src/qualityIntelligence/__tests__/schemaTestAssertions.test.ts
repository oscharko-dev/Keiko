import { describe, expect, it } from "vitest";
import { requireRecord } from "./schemaTestAssertions.js";

describe("requireRecord", () => {
  it("accepts ordinary and null-prototype records", () => {
    const ordinary = { type: "object" };
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      type: "object",
    });

    expect(requireRecord(ordinary, "schema")).toBe(ordinary);
    expect(requireRecord(nullPrototype, "schema")).toBe(nullPrototype);
  });

  it.each([undefined, null, [], new Date(0), new Map<string, unknown>()])(
    "rejects non-record input %#",
    (value) => {
      expect(() => requireRecord(value, "schema")).toThrow(TypeError);
    },
  );
});
