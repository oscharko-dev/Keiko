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

  // A provider refuses a function whose parameters carry oneOf, anyOf, allOf, enum, const or not at
  // the top level (HTTP 400 for jira.set-issue-property: a root allOf holding a oneOf).
  const ROOT_KEYWORDS = ["oneOf", "anyOf", "allOf", "enum", "const", "not"] as const;

  function expectPlainObject(parameters: Record<string, unknown>): void {
    expect(parameters.type).toBe("object");
    for (const key of ROOT_KEYWORDS) expect(parameters).not.toHaveProperty(key);
  }

  const SET_PROPERTY = {
    type: "object",
    properties: {
      issueKey: { type: "string" },
      propertyKey: { type: "string" },
      expectedValueNodes: { type: "array" },
      expectAbsent: { type: "boolean" },
    },
    required: ["issueKey", "propertyKey"],
    additionalProperties: false,
    allOf: [{ oneOf: [{ required: ["expectedValueNodes"] }, { required: ["expectAbsent"] }] }],
  };

  it("folds a root allOf holding a oneOf and names the exclusive required sets", () => {
    const before = JSON.stringify(SET_PROPERTY);
    const result = providerToolSchema(SET_PROPERTY, "Sets a property.");
    expect(JSON.stringify(SET_PROPERTY)).toBe(before);
    expectPlainObject(result.parameters);
    expect(result.parameters).toEqual({
      type: "object",
      properties: SET_PROPERTY.properties,
      required: ["issueKey", "propertyKey"],
      additionalProperties: false,
    });
    expect(result.description).toBe(
      "Sets a property. Provide exactly one of these argument sets: expectedValueNodes; or expectAbsent.",
    );
  });

  it("folds the properties and required names of every allOf member into the root", () => {
    const result = providerToolSchema(
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        allOf: [
          { properties: { b: { type: "integer" }, a: { type: "number" } }, required: ["b"] },
          { pattern: "^x" },
        ],
      },
      "d",
    );
    expectPlainObject(result.parameters);
    // The base definition of a property wins over a member's.
    expect(result.parameters.properties).toEqual({ a: { type: "string" }, b: { type: "integer" } });
    expect(result.parameters.required).toEqual(["a", "b"]);
    expect(result.description).toBe("d");
  });

  it("drops a root not and names the combination it forbids", () => {
    const result = providerToolSchema(
      {
        type: "object",
        properties: {
          key: { type: "string" },
          startAt: { type: "integer" },
          maxResults: { type: "integer" },
        },
        not: { anyOf: [{ required: ["key", "startAt"] }, { required: ["key", "maxResults"] }] },
      },
      "Lists properties.",
    );
    expectPlainObject(result.parameters);
    expect(result.description).toBe(
      "Lists properties. Do not provide any of these combinations: key + startAt; or key + maxResults.",
    );
  });

  it.each([
    [{ required: ["a", "b"] }, "Do not provide all of these together: a + b."],
    [{ required: ["a"] }, "Do not provide a."],
  ])("states a single forbidden set in words (%j)", (not, sentence) => {
    const result = providerToolSchema({ type: "object", properties: {}, not }, "d");
    expectPlainObject(result.parameters);
    expect(result.description).toBe(`d ${sentence}`);
  });

  it("describes an alternative that must leave an argument out", () => {
    const result = providerToolSchema(
      {
        type: "object",
        properties: { active: { type: "boolean" }, acceptUnverifiedAccess: { type: "boolean" } },
        allOf: [
          { anyOf: [{ not: { required: ["active"] } }, { required: ["acceptUnverifiedAccess"] }] },
        ],
      },
      "Updates a user.",
    );
    expectPlainObject(result.parameters);
    expect(result.description).toContain("without active; or acceptUnverifiedAccess");
  });

  it.each([
    ["an enum", { type: "object", enum: [{ a: 1 }], properties: { a: { type: "integer" } } }],
    ["a const", { type: "object", const: { a: 1 }, properties: { a: { type: "integer" } } }],
    ["a root type list", { type: ["object", "null"], properties: { a: { type: "integer" } } }],
  ])("projects %s at the root to a plain object", (_name, schema) => {
    const result = providerToolSchema(schema, "d");
    expectPlainObject(result.parameters);
    expect(result.parameters.properties).toEqual({ a: { type: "integer" } });
  });

  it("is a fixed point: a projected schema is projected to itself", () => {
    const once = providerToolSchema(SET_PROPERTY, "d");
    const twice = providerToolSchema(once.parameters, once.description);
    expect(twice.parameters).toBe(once.parameters);
    expect(twice.description).toBe(once.description);
  });

  it("keeps the sentence bounded when a schema forbids very many combinations", () => {
    const sets = Array.from({ length: 40 }, (_unused, index) => ({
      required: [`a${String(index)}`, `b${String(index)}`],
    }));
    const result = providerToolSchema(
      { type: "object", properties: {}, not: { anyOf: sets } },
      "d",
    );
    expect(result.description.split("; or ")).toHaveLength(8);
  });

  it("leaves a schema whose allOf cannot be folded as it is", () => {
    const schema = { type: "object", allOf: [{ type: "object" }, "not an object"] };
    expect(providerToolSchema(schema, "d")).toEqual({ parameters: schema, description: "d" });
  });
});
