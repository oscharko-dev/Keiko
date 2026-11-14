import { describe, expect, it } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { describeCatalogSchemaMismatch } from "./schema.js";
import { compileExternalCatalogSchema } from "./external-schema.js";
import { collectExpectations, expectationRule, EXPECTATIONS_MAX } from "./schema-expectation.js";

describe("the rule a schema states at one property", () => {
  it.each<[string, Record<string, unknown>, string | undefined]>([
    ["a string", { type: "string" }, "a string"],
    [
      "a string with format and bounds",
      { type: "string", format: "uri", minLength: 1, maxLength: 2048 },
      "a string, in uri format, 1 to 2048 characters",
    ],
    ["an integer with a range", { type: "integer", minimum: 0, maximum: 9 }, "an integer, 0 to 9"],
    ["a union with null", { type: ["string", "null"] }, "a string or null"],
    [
      "an array of objects",
      { type: "array", items: { type: "object" }, minItems: 1 },
      "an array of objects, at least 1 item",
    ],
    [
      "an object and its required names",
      { type: "object", required: ["a", "b"] },
      "an object with the required properties a, b",
    ],
    ["allowed values instead of the type", { type: "string", enum: ["x", "y"] }, 'one of "x", "y"'],
    ["a constant", { const: true }, "one of true"],
    [
      "a nullable property",
      { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
      "a string, at least 1 character or null",
    ],
    ["a short pattern", { type: "string", pattern: "^[A-Z]+$" }, "a string, matching ^[A-Z]+$"],
    ["a pattern too long to quote", { type: "string", pattern: "x".repeat(60) }, "a string"],
    [
      "too many allowed values to list",
      { enum: Array.from({ length: 9 }, (_, i) => i) },
      undefined,
    ],
    ["a keyword it does not know", { description: "free text" }, undefined],
  ])("states %s", (_label, node, rule) => {
    expect(expectationRule(node as never)).toBe(rule);
  });
  it("never quotes the description, and bounds one rule", () => {
    expect(expectationRule({ type: "string", description: "SECRET" })).toBe("a string");
    const long = expectationRule({
      type: "object",
      required: Array.from({ length: 8 }, (_, i) => `property${String(i).repeat(4)}`),
    });
    expect((long ?? "").length).toBeLessThanOrEqual(160);
  });
  it("lists distinct paths once, sorted and bounded", () => {
    const entries = Array.from({ length: EXPECTATIONS_MAX + 3 }, (_, i) => ({
      path: `p${String(EXPECTATIONS_MAX + 2 - i)}`,
      node: { type: "string" },
    }));
    const { expected, omittedCount } = collectExpectations([
      ...entries,
      { path: "p0", node: { type: "integer" } },
    ]);
    expect(expected).toHaveLength(EXPECTATIONS_MAX);
    // Eleven distinct paths were explained and eight are kept: the three left out are counted.
    expect(omittedCount).toBe(3);
    expect(expected.map((entry) => entry.path)).toEqual(
      [...expected.map((entry) => entry.path)].sort(),
    );
    // The first rule of a path wins.
    expect(expected.find((entry) => entry.path === "p0")?.rule).toBe("a string");
    expect(collectExpectations([{ path: "x", node: { description: "d" } }])).toEqual({
      expected: [],
      omittedCount: 0,
    });
  });
});

const EXTERNAL: CatalogJsonObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["name", "value"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 255 },
    value: {
      type: "object",
      required: ["iconUrl", "iconTitle"],
      properties: {
        iconUrl: { anyOf: [{ type: "string", minLength: 1, maxLength: 2048 }, { type: "null" }] },
        iconTitle: { anyOf: [{ type: "string", minLength: 1, maxLength: 255 }, { type: "null" }] },
        size: { type: "integer", minimum: 1, maximum: 5 },
      },
    },
  },
};

describe("every mismatching property is explained in one account", () => {
  it("an external schema states the rule of each rejected property, not only the first", () => {
    const schema = compileExternalCatalogSchema(EXTERNAL);
    const mismatch = describeCatalogSchemaMismatch(schema, {
      name: "",
      value: { iconUrl: "", iconTitle: "", size: 9 },
    });
    // The first-error account is unchanged: one path.
    expect(mismatch?.invalidPaths).toHaveLength(1);
    expect(mismatch?.expected).toEqual([
      { path: "name", rule: "a string, 1 to 255 characters" },
      { path: "value.iconTitle", rule: "a string, 1 to 255 characters or null" },
      { path: "value.iconUrl", rule: "a string, 1 to 2048 characters or null" },
      { path: "value.size", rule: "an integer, 1 to 5" },
    ]);
  });
  it("names a missing property by what the schema declares for it", () => {
    const schema = compileExternalCatalogSchema(EXTERNAL);
    const mismatch = describeCatalogSchemaMismatch(schema, { name: "n", value: {} });
    expect(mismatch?.expected).toEqual([
      { path: "value.iconTitle", rule: "a string, 1 to 255 characters or null" },
      { path: "value.iconUrl", rule: "a string, 1 to 2048 characters or null" },
    ]);
  });
  it("never carries the rejected value or a property name only the value used", () => {
    const schema = compileExternalCatalogSchema(EXTERNAL);
    const mismatch = describeCatalogSchemaMismatch(schema, {
      name: 12345,
      secretKeyOfTheValue: "TOPSECRET",
      value: { iconUrl: 7, iconTitle: null },
    });
    expect(JSON.stringify(mismatch?.expected)).not.toMatch(/TOPSECRET|secretKeyOfTheValue|12345/u);
  });
  it("a valid value has no account", () => {
    const schema = compileExternalCatalogSchema(EXTERNAL);
    expect(
      describeCatalogSchemaMismatch(schema, {
        name: "n",
        value: { iconUrl: null, iconTitle: "t" },
      }),
    ).toBeUndefined();
  });
  it("the closed managed dialect states the rule of every rejected property too", () => {
    const schema: CatalogJsonObject = {
      type: "object",
      required: ["title", "count"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 20 },
        count: { type: "integer", minimum: 1, maximum: 3 },
      },
    };
    const mismatch = describeCatalogSchemaMismatch(schema, { title: "", count: 9 });
    expect(mismatch?.expected).toEqual([
      { path: "count", rule: "an integer, 1 to 3" },
      { path: "title", rule: "a string, 1 to 20 characters" },
    ]);
  });
});
