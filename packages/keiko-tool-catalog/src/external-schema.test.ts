import { describe, expect, it } from "vitest";
import { compileExternalCatalogSchema } from "./external-schema.js";
import {
  compileCatalogSchema,
  describeCatalogSchemaMismatch,
  matchesCatalogSchema,
} from "./schema.js";
import { createToolDescriptor } from "./descriptor.js";
import { createToolCatalog, gatewayToolDefinitions } from "./index.js";
import { declaration, profile } from "./__fixtures__/catalog.js";

const external = {
  type: "object",
  title: "Synthetic issue input",
  $defs: {
    user: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  properties: {
    title: { type: "string", default: "Untitled", minLength: 1 },
    assignee: { anyOf: [{ $ref: "#/$defs/user" }, { type: "null" }] },
    labels: { type: "array", items: { type: "string" } },
    metadata: { type: "object", additionalProperties: { type: "integer" } },
    date: { type: "string", format: "date" },
  },
};

describe("external JSON Schema catalog dialect", () => {
  it("preserves exact MCP constraints, defaults, references and open-object semantics", () => {
    const compiled = compileExternalCatalogSchema(external);
    expect(compiled).toEqual({
      ...external,
      $schema: "https://json-schema.org/draft/2020-12/schema",
    });
    expect(createToolDescriptor({ ...declaration(), inputSchema: compiled }).inputSchema).toEqual(
      compiled,
    );
    const value = {
      assignee: { id: "synthetic-user" },
      labels: ["one"],
      metadata: { count: 7 },
      date: "2024-02-29",
      extra: true,
    };
    expect(matchesCatalogSchema(compiled, value)).toBe(true);
    expect(value).not.toHaveProperty("title");
    expect(value.extra).toBe(true);
    const descriptor = createToolDescriptor({ ...declaration(), inputSchema: compiled });
    const catalog = createToolCatalog(
      { descriptors: [descriptor], profiles: [profile(descriptor)], compatibility: [] },
      { referenceTimeMs: 0 },
    );
    expect(gatewayToolDefinitions(catalog, { id: "fixture", version: 1 })[0]?.parameters).toEqual(
      compiled,
    );
    expect(matchesCatalogSchema(compiled, { assignee: null })).toBe(true);
    expect(matchesCatalogSchema(compiled, { assignee: { id: "ok", extra: true } })).toBe(false);
    expect(matchesCatalogSchema(compiled, { metadata: { count: "7" } })).toBe(false);
    expect(matchesCatalogSchema(compiled, { date: "2023-02-29" })).toBe(false);
  });
  it.each([
    [{ type: ["string", "null"] }, null, 7],
    [{ oneOf: [{ type: "number" }, { type: "integer" }] }, 1.5, 1],
    [{ allOf: [{ type: "number", minimum: 1 }, { maximum: 3 }] }, 2, 4],
    [{ type: "array", prefixItems: [{ type: "string" }], items: false }, ["ok"], ["ok", "extra"]],
  ])("applies the standard semantics of %j", (schema, accepted, rejected) => {
    const compiled = compileExternalCatalogSchema(schema);
    expect(matchesCatalogSchema(compiled, accepted)).toBe(true);
    expect(matchesCatalogSchema(compiled, rejected)).toBe(false);
  });
  it.each([
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2019-09/schema",
  ])("honors explicitly supported dialect %s", ($schema) => {
    const compiled = compileExternalCatalogSchema({
      $schema,
      type: "object",
      properties: { n: { type: "number" } },
    });
    expect(compiled.$schema).toBe($schema);
    expect(matchesCatalogSchema(compiled, { n: 1 })).toBe(true);
    expect(matchesCatalogSchema(compiled, { n: "1" })).toBe(false);
  });
  it("leaves the existing internal closed-dialect rejection pins unchanged", () => {
    for (const schema of [
      { anyOf: [{ type: "string" }] },
      { type: ["string", "null"] },
      { type: "string", default: "x" },
    ])
      expect(() => compileCatalogSchema(schema)).toThrow();
  });
  it.each([
    { type: "string", pattern: "^(a+)+$" },
    { type: "object", patternProperties: { "(a+)+": { type: "string" } } },
    { type: "string", $ref: "https://synthetic.example.test/schema" },
    { $defs: { cycle: { $ref: "#/$defs/cycle" } }, $ref: "#/$defs/cycle" },
    { $ref: "#/missing" },
    { $id: "https://synthetic.example.test/schema", type: "object" },
    { $schema: "https://synthetic.example.test/dialect", type: "object" },
    { type: "string", format: "regex" },
    { type: "string", format: "unknown-vendor-format" },
    { type: "string", unknownAssertion: true },
  ])("refuses unsupported or dangerous external semantics before compilation: %j", (schema) => {
    expect(() => compileExternalCatalogSchema(schema)).toThrow();
  });
  it("reports only schema-owned mismatch paths and counts, never extra keys or values", () => {
    const compiled = compileExternalCatalogSchema({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
    expect(describeCatalogSchemaMismatch(compiled, {})).toMatchObject({
      missingRequired: ["name"],
    });
    const mismatch = describeCatalogSchemaMismatch(compiled, {
      name: "ok",
      "private-extra-key": "private-extra-value",
    });
    expect(mismatch?.unexpectedPropertyCount).toBe(1);
    expect(JSON.stringify(mismatch)).not.toContain("private-extra");
  });
});
