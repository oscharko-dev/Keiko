import { describe, expect, it } from "vitest";
import { providerToolSchema } from "./provider-tool-schema.js";

const ONE_OF = {
  type: "object",
  oneOf: [
    {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { id: { type: "string" }, key: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  ],
};

describe("providerToolSchema", () => {
  it("returns a schema without top-level alternatives unchanged", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const result = providerToolSchema(schema, "Reads a.");
    expect(result.parameters).toBe(schema);
    expect(result.description).toBe("Reads a.");
  });

  it("keeps every value of a discriminator the alternatives fix differently (#4335)", () => {
    const schema = {
      type: "object",
      oneOf: [
        {
          type: "object",
          properties: { kind: { type: "string", const: "issue" }, key: { type: "string" } },
          required: ["kind", "key"],
        },
        {
          type: "object",
          properties: { kind: { type: "string", const: "project" }, name: { type: "string" } },
          required: ["kind", "name"],
        },
        {
          type: "object",
          properties: { kind: { type: "string", enum: ["issue", "board"] } },
          required: ["kind"],
        },
      ],
    };
    const properties = providerToolSchema(schema, "d").parameters.properties;
    expect(properties).toMatchObject({
      kind: { type: "string", enum: ["issue", "project", "board"] },
      key: { type: "string" },
      name: { type: "string" },
    });
    expect(properties).not.toHaveProperty("kind.const");
  });

  it.each(["oneOf", "anyOf"])(
    "offers every differing definition of one property under a root %s as a nested anyOf",
    (key) => {
      const schema = {
        type: "object",
        [key]: [
          { properties: { target: { type: "string", description: "issue key" } } },
          { properties: { target: { type: "integer", minimum: 1 } } },
          { properties: { target: { type: "string", description: "issue key" } } },
        ],
      };
      const parameters = providerToolSchema(schema, "d").parameters;
      expect(parameters).not.toHaveProperty(key);
      expect(parameters.properties).toEqual({
        target: {
          anyOf: [
            { type: "string", description: "issue key" },
            { type: "integer", minimum: 1 },
          ],
        },
      });
    },
  );

  it("flattens a root oneOf and a root anyOf together, keeping what each requires (#4335)", () => {
    const schema = {
      type: "object",
      oneOf: [
        { properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
        { properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      ],
      anyOf: [
        {
          properties: { fields: { type: "array" } },
          required: ["fields", "mode"],
          additionalProperties: false,
        },
        {
          properties: { expand: { type: "string" } },
          required: ["mode"],
          additionalProperties: false,
        },
      ],
    };
    const before = JSON.stringify(schema);
    const result = providerToolSchema(schema, "Reads one issue.");
    expect(JSON.stringify(schema)).toBe(before);
    expect(result.parameters).not.toHaveProperty("oneOf");
    expect(result.parameters).not.toHaveProperty("anyOf");
    expect(result.parameters).toEqual({
      type: "object",
      properties: {
        key: { type: "string" },
        id: { type: "string" },
        fields: { type: "array" },
        expand: { type: "string" },
      },
      required: ["mode"],
      additionalProperties: false,
    });
    expect(result.description).toBe(
      "Reads one issue. Provide exactly one of these argument sets: key; or id. " +
        "Also provide one of these argument sets: fields + mode; or mode.",
    );
  });

  it("leaves the schema as it is when either root list cannot be flattened", () => {
    const schema = { oneOf: [{ required: ["a"] }], anyOf: [{ type: "string" }] };
    expect(providerToolSchema(schema, "d")).toEqual({ parameters: schema, description: "d" });
  });

  it("never widens a base property with an alternative's fixed value", () => {
    const result = providerToolSchema(
      {
        properties: { kind: { type: "string", const: "issue" } },
        oneOf: [{ properties: { kind: { type: "string", const: "project" } } }],
      },
      "d",
    );
    expect(result.parameters.properties).toEqual({ kind: { type: "string", const: "issue" } });
  });

  it("does not touch alternatives nested below the top level", () => {
    const schema = {
      type: "object",
      properties: { a: { oneOf: [{ type: "string" }, { type: "number" }] } },
    };
    expect(providerToolSchema(schema, "d").parameters).toBe(schema);
  });

  it("flattens a top-level oneOf into one object and names the argument sets", () => {
    const result = providerToolSchema(ONE_OF, "Reads one issue.");
    expect(result.parameters).not.toHaveProperty("oneOf");
    expect(result.parameters).toMatchObject({
      type: "object",
      properties: { key: { type: "string" }, id: { type: "string" } },
      additionalProperties: false,
    });
    // Only an argument every alternative requires stays required.
    expect(result.parameters).not.toHaveProperty("required");
    expect(result.description).toBe(
      "Reads one issue. Provide exactly one of these argument sets: key; or id.",
    );
  });

  it("flattens anyOf, keeps shared required names and base properties, and never mutates the input", () => {
    const schema = {
      type: "object",
      properties: { base: { type: "string" } },
      required: ["base"],
      anyOf: [
        { properties: { x: { type: "string" } }, required: ["shared", "x"] },
        { properties: { y: { type: "string" } }, required: ["shared"] },
        {},
      ],
    };
    const before = JSON.stringify(schema);
    const result = providerToolSchema(schema, "");
    expect(JSON.stringify(schema)).toBe(before);
    expect(result.parameters).not.toHaveProperty("anyOf");
    expect(result.parameters).toMatchObject({
      properties: { base: {}, x: {}, y: {} },
      required: ["base"],
    });
    // The empty alternative requires nothing, so no name is shared by all three.
    expect(result.description).toBe(
      "Provide exactly one of these argument sets: shared + x; or shared; or no arguments.",
    );
  });

  it("keeps required names that every alternative shares", () => {
    const result = providerToolSchema(
      { oneOf: [{ required: ["a", "b"] }, { required: ["a", "c"] }] },
      "d",
    );
    expect(result.parameters).toMatchObject({ type: "object", required: ["a"] });
    expect(result.parameters).not.toHaveProperty("additionalProperties");
  });

  it("lets the base properties win over an alternative's property of the same name", () => {
    const result = providerToolSchema(
      {
        properties: { key: { type: "string", description: "base" } },
        oneOf: [{ properties: { key: { type: "number" } } }],
      },
      "d",
    );
    expect(result.parameters).toMatchObject({
      properties: { key: { type: "string", description: "base" } },
    });
  });

  it.each([
    ["an empty alternatives list", { oneOf: [] }],
    ["a non-object alternative", { oneOf: [{ type: "string" }] }],
    ["a malformed alternative", { anyOf: [null, 3] }],
    ["array properties", { oneOf: [{ properties: [] }] }],
    ["alternatives that are not an array", { oneOf: "nope" }],
  ])("leaves a schema with %s as it is", (_name, schema) => {
    const result = providerToolSchema(schema, "d");
    expect(result.parameters).toBe(schema);
    expect(result.description).toBe("d");
  });

  it("ignores malformed required entries", () => {
    const result = providerToolSchema(
      { oneOf: [{ required: ["a", 7, null] }, { required: "a" }] },
      "",
    );
    expect(result.description).toBe(
      "Provide exactly one of these argument sets: a; or no arguments.",
    );
  });
});
