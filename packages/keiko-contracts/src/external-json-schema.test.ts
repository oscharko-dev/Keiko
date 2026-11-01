import { describe, expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "./external-json-schema.js";

describe("untrusted external schema safety admission", () => {
  it("accepts bounded local acyclic references and treats default values as data", () => {
    expect(
      isBoundedExternalJsonSchema({
        type: "object",
        $defs: { value: { type: "string", pattern: "^[a-z]+$" } },
        properties: { a: { $ref: "#/$defs/value" }, b: { $ref: "#/$defs/value" } },
        default: { $ref: "ordinary-data" },
      }),
    ).toBe(true);
  });
  it.each(["^[a-z]+$", "^[a-zA-Z0-9_-]{1,120}$", "^\\d+$", "^[0-9]*$", "^[a-z]?$", "^[a-z]{2,}$"])(
    "allows the unchanged linear anchored character pattern %s",
    (pattern) => {
      expect(isBoundedExternalJsonSchema({ type: "string", pattern })).toBe(true);
    },
  );
  it.each(["^[a-z]+[a-z]+$", "^([a-z]+)+$", "^[z-a]+$", "^[a-z]+|b+$", "[a-z]+"])(
    "keeps unsafe or unsupported regex grammar closed: %s",
    (pattern) => {
      expect(isBoundedExternalJsonSchema({ type: "string", pattern })).toBe(false);
    },
  );
  it("rejects recursive references, unsafe regexes and remote resolution", () => {
    for (const schema of [
      { $ref: "#" },
      { $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } } },
      { properties: { x: { $ref: "https://synthetic.example.test/schema" } } },
      { properties: { x: { pattern: "(a+)+$" } } },
      { properties: { x: { format: "regex" } } },
      { patternProperties: { "(a+)+$": { type: "string" } } },
      { $dynamicRef: "#anything" },
    ])
      expect(isBoundedExternalJsonSchema(schema)).toBe(false);
  });
  it("bounds expanded reference work even when a small acyclic DAG shares schemas", () => {
    const $defs: Record<string, unknown> = { leaf: { type: "string" } };
    let previous = "leaf";
    for (let index = 0; index < 6; index++) {
      const current = `node${String(index)}`;
      $defs[current] = {
        anyOf: Array.from({ length: 8 }, () => ({ $ref: `#/$defs/${previous}` })),
      };
      previous = current;
    }
    expect(isBoundedExternalJsonSchema({ $defs, $ref: `#/$defs/${previous}` })).toBe(false);
  });
  it("bounds size, width and depth before compilation and does not evaluate accessors", () => {
    expect(isBoundedExternalJsonSchema({ description: "x".repeat(65_537) })).toBe(false);
    expect(isBoundedExternalJsonSchema({ enum: Array.from({ length: 129 }, (_, n) => n) })).toBe(
      false,
    );
    let deep: unknown = { type: "string" };
    for (let index = 0; index < 17; index++) deep = { items: deep };
    expect(isBoundedExternalJsonSchema(deep)).toBe(false);
    let called = false;
    const getter = Object.defineProperty({}, "type", {
      enumerable: true,
      get: () => {
        called = true;
        return "object";
      },
    });
    expect(isBoundedExternalJsonSchema(getter)).toBe(false);
    expect(called).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.properties = cycle;
    expect(isBoundedExternalJsonSchema(cycle)).toBe(false);
    expect(isBoundedExternalJsonSchema(JSON.parse('{"__proto__":{}}'))).toBe(false);
  });

  // REVIEW-3918-014: RFC 6901 reference decoding and traversal at the admission boundary.
  const defs = { "a~b": { type: "string" }, "a/b": { type: "number" }, "": { type: "boolean" } };
  it.each([
    ["an escaped tilde key", "#/$defs/a~0b", true],
    ["an escaped slash key", "#/$defs/a~1b", true],
    ["an empty key", "#/$defs/", true],
    ["a percent-encoded key", "#/$defs/a%7E0b", true],
    ["a boolean schema", "#/allOf/0", true],
    ["an object schema in a list", "#/allOf/1", true],
    ["an invalid ~2 escape", "#/$defs/a~2b", false],
    ["a trailing tilde", "#/$defs/a~", false],
    ["a missing key", "#/$defs/missing", false],
    ["the root's empty key", "#/", false],
    ["a number", "#/maxLength", false],
    ["an array", "#/allOf", false],
    ["an array length", "#/allOf/length", false],
    ["a relative pointer", "$defs/a~0b", false],
    ["a remote reference", "https://example.invalid/schema#/$defs/a~0b", false],
  ])("resolves a reference to %s as admitted=%s", (_name, $ref, admitted) => {
    const schema = {
      maxLength: 3,
      allOf: [true, { type: "null" }],
      $defs: defs,
      properties: { x: { $ref } },
    };
    expect(isBoundedExternalJsonSchema(schema)).toBe(admitted);
  });
  it("throws the opaque admission failure for a malformed percent-encoded reference", () => {
    expect(() =>
      isBoundedExternalJsonSchema({ properties: { x: { $ref: "#/%E0%A4%A" } } }),
    ).toThrow(new TypeError("Invalid external JSON schema"));
  });
});
