import { describe, expect, it } from "vitest";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { copyCatalogJson, catalogBytes } from "./json.js";
import {
  compileCatalogSchema,
  describeCatalogSchemaMismatch,
  matchesCatalogSchema,
} from "./schema.js";
import { createToolDescriptor, createToolCatalog, compileToolProjection } from "./index.js";
import { declaration, profile } from "./__fixtures__/catalog.js";

function nested(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 1; index < depth; index += 1) value = { child: value };
  return value;
}
describe("bounded hostile declaration capture", () => {
  it.each([
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol("private"),
    (): number => 1,
    new Date(),
    /x/u,
    new Map(),
    new Set(),
  ])("rejects non-JSON input %s", (value) => {
    expect(() => copyCatalogJson(value)).toThrow();
  });
  it("rejects accessors without invoking their getter", () => {
    let calls = 0;
    const value = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        calls += 1;
        return "secret-body";
      },
    });
    expect(() => copyCatalogJson(value)).toThrow("invalid-shape");
    expect(calls).toBe(0);
    const array = Object.defineProperty([0], "0", {
      enumerable: true,
      get: () => {
        calls += 1;
        return 1;
      },
    });
    expect(() => copyCatalogJson(array)).toThrow("invalid-shape");
    expect(calls).toBe(0);
  });
  it("rejects inherited, hidden, symbolic and pollution keys and cycles", () => {
    const cycle: Record<string, unknown> = {};
    cycle.child = cycle;
    const array: unknown[] = [];
    array.push(array);
    const values = [
      cycle,
      array,
      Object.create({ authority: true }),
      Object.defineProperty({}, "hidden", { value: 1 }),
      { [Symbol("key")]: 1 },
      JSON.parse('{"__proto__":{"allowed":true}}'),
      { constructor: 1 },
      { prototype: 1 },
      Object.assign(new Array<unknown>(2), { 1: 1 }),
      Object.assign([1], { extra: true }),
    ];
    for (const value of values) expect(() => copyCatalogJson(value)).toThrow("invalid-shape");
    const same = { safe: 1 };
    expect(copyCatalogJson([same, same])).toEqual([same, same]);
  });
  it("enforces root-one depth on scalar leaves as well as containers", () => {
    expect(copyCatalogJson(nested(TOOL_CATALOG_LIMITS.maxSchemaDepth))).toEqual(nested(16));
    expect(() => copyCatalogJson(nested(TOOL_CATALOG_LIMITS.maxSchemaDepth + 1))).toThrow(
      "input-bound",
    );
  });
  it("enforces byte, string, width and array limits before canonicalization", () => {
    expect(copyCatalogJson("é", 4)).toBe("é");
    expect(() => copyCatalogJson("é", 3)).toThrow("input-bound");
    expect(() => copyCatalogJson("é".repeat(32769))).toThrow("input-bound");
    expect(() =>
      copyCatalogJson(
        Object.fromEntries(Array.from({ length: 129 }, (_, index) => [String(index), 0])),
      ),
    ).toThrow("input-bound");
    expect(() => copyCatalogJson(Array.from({ length: 1001 }, () => 0))).toThrow("input-bound");
    expect(() =>
      copyCatalogJson(["x".repeat(65536), "x".repeat(65536), "x".repeat(65536), "x".repeat(65536)]),
    ).toThrow("input-bound");
    for (const limit of [0, -1, NaN, Infinity, 1.5, 262145])
      expect(() => copyCatalogJson({}, limit)).toThrow("input-bound");
    expect(catalogBytes(copyCatalogJson({ text: "é" }))).toBe(13);
  });
  it("contains foreign reflective failures without leaking declaration bodies", () => {
    const value = new Proxy(
      {},
      {
        ownKeys: (): never => {
          throw new Error("private-customer-body");
        },
      },
    );
    expect(() => copyCatalogJson(value)).toThrow("tool catalog invalid-shape");
  });
});

describe("closed lossless schema core", () => {
  it("rejects OpenCode stripping a closed object boundary", () => {
    const descriptor = createToolDescriptor(declaration());
    const catalog = createToolCatalog(
      {
        descriptors: [descriptor],
        profiles: [profile(descriptor, "managed-runtime-json-schema")],
        compatibility: [],
      },
      { referenceTimeMs: 0 },
    );
    expect(() => compileToolProjection(catalog, { id: "fixture", version: 1 })).toThrow(
      "unrepresentable-projection",
    );
  });
  it.each([
    { type: "string", $ref: "https://private.example/schema" },
    { type: ["string", "null"] },
    { type: "string", default: "x" },
    { anyOf: [{ type: "string" }] },
    { type: "object", properties: {}, required: [], additionalProperties: "unsupported" },
    { type: "object", properties: {}, required: ["missing"], additionalProperties: false },
    {
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x", "x"],
      additionalProperties: false,
    },
    { type: "array" },
    { type: "string", minLength: 3, maxLength: 2 },
    { type: "string", minLength: -1 },
    { type: "array", items: { type: "boolean" }, maxItems: 0.5 },
    { type: "number", minimum: "0" },
    { type: "string", enum: ["x", "x"] },
    { type: "string", enum: [] },
    { type: "integer", enum: [1.5] },
    { type: "boolean", const: "false" },
    { type: "string", const: "x", enum: ["y"] },
    // #3414 AC1: `pattern` is now a supported string keyword (schema.ts), but only as a
    // syntactically valid ECMA regex source; an unclosed group must still be rejected the same
    // way every other unsupported/inconsistent shape above is.
    { type: "string", pattern: "(" },
    { type: "string", pattern: 1 },
  ])("rejects unsupported or inconsistent schema %j", (schema) => {
    expect(() => compileCatalogSchema(schema)).toThrow();
  });
  it.each([
    [{ type: "string", minLength: 1, maxLength: 1 }, "😀", "xx"],
    // #3414 AC1: `pattern` is enforced both at compile time (schema.ts's `stringSchema`) and at
    // match time (`stringMatches`), the same closed-dialect guarantee every other string keyword
    // already gets — never a silently-dropped, advisory-only keyword (ADR-0175 D3).
    [{ type: "string", pattern: "^[a-f0-9]{64}$" }, "a".repeat(64), "not-hex"],
    [{ type: "number", minimum: -2, maximum: 4 }, 1.5, 5],
    [{ type: "integer" }, 2, 1.5],
    [{ type: "boolean", const: false }, false, true],
    [{ type: "null" }, null, false],
    [{ type: "string", enum: ["b", "a"] }, "a", "c"],
    [{ type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 }, ["a"], [1]],
    [
      {
        type: "object",
        properties: { x: { type: "string" } },
        required: ["x"],
        additionalProperties: false,
      },
      { x: "a" },
      { x: "a", y: 1 },
    ],
    [
      { type: "object", properties: {}, required: [], additionalProperties: { type: "integer" } },
      { x: 1 },
      { x: "a" },
    ],
  ])("validates accepted and rejected result shapes %j", (schema, valid, invalid) => {
    const compiled = compileCatalogSchema(schema);
    expect(matchesCatalogSchema(compiled, copyCatalogJson(valid))).toBe(true);
    expect(matchesCatalogSchema(compiled, copyCatalogJson(invalid))).toBe(false);
  });
  it("accepts an explicitly open nested managed schema without silently changing declared constraints", () => {
    const nested = {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: { flag: { type: "boolean" } },
            required: ["flag"],
            additionalProperties: true,
          },
        },
      },
      required: ["entries"],
      additionalProperties: true,
    };
    const descriptor = createToolDescriptor({ ...declaration(), inputSchema: nested });
    const catalog = createToolCatalog(
      {
        descriptors: [descriptor],
        profiles: [profile(descriptor, "managed-runtime-json-schema")],
        compatibility: [],
      },
      { referenceTimeMs: 0 },
    );
    const projection = compileToolProjection(catalog, { id: "fixture", version: 1 });
    expect(projection.tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: { type: "object", properties: { flag: { type: "boolean" } }, required: ["flag"] },
        },
      },
      required: ["entries"],
    });
    const schema = compileCatalogSchema(nested);
    expect(matchesCatalogSchema(schema, { entries: [], extra: "bounded" })).toBe(true);
    expect(matchesCatalogSchema(schema, {})).toBe(false);
  });
  it("normalizes source insertion order throughout repeated property permutations", () => {
    const fields = Object.entries(declaration());
    const expected = createToolDescriptor(declaration());
    for (let shift = 0; shift < fields.length; shift += 1) {
      const permuted = [...fields.slice(shift), ...fields.slice(0, shift)].reverse();
      expect(createToolDescriptor(Object.fromEntries(permuted))).toEqual(expected);
    }
    expect(compileCatalogSchema({ type: "string", enum: ["z", "a"] })).toEqual(
      compileCatalogSchema({ enum: ["a", "z"], type: "string" }),
    );
  });
  it("rejects nested lossy managed projections and undeclared native tool collisions", () => {
    const schema = {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: { optional: { type: "boolean" } },
            required: [],
            additionalProperties: false,
          },
        },
      },
      required: ["entries"],
      additionalProperties: false,
    };
    const descriptor = createToolDescriptor({ ...declaration(), inputSchema: schema });
    const input = {
      descriptors: [descriptor],
      profiles: [profile(descriptor, "managed-runtime-json-schema")],
      compatibility: [],
    };
    const catalog = createToolCatalog(input, { referenceTimeMs: 0 });
    expect(() => compileToolProjection(catalog, { id: "fixture", version: 1 })).toThrow(
      "unrepresentable-projection",
    );
    expect(() =>
      createToolCatalog(
        {
          ...input,
          profiles: [
            {
              ...profile(descriptor, "managed-runtime-json-schema", "question"),
              nativeExtensions: [{ alias: "question", contractVersion: 1 }],
            },
          ],
        },
        { referenceTimeMs: 0 },
      ),
    ).toThrow("duplicate-identity");
  });
});

// One walk serves the boolean match and the body-free mismatch account, so the two cannot drift:
// a value matches exactly when the account is empty.
describe("schema mismatch account", () => {
  const schema = compileCatalogSchema({
    type: "object",
    properties: {
      changeset: {
        type: "object",
        properties: {
          patch: { type: "string", minLength: 1 },
          mode: { type: "string", enum: ["literal", "regex"] },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: { file: { type: "string" } },
              required: ["file"],
              additionalProperties: false,
            },
          },
        },
        required: ["patch", "files", "mode"],
        additionalProperties: false,
      },
    },
    required: ["changeset"],
    additionalProperties: false,
  });

  it("names declared paths only, counts undeclared properties, and is empty for a match", () => {
    const secret = "SENTINEL_PRIVATE_ARGUMENT";
    const value = copyCatalogJson({
      changeset: {
        patch: "",
        mode: "fuzzy",
        files: [{ file: 1 }, { [secret]: true }],
      },
      [secret]: secret,
    });
    const mismatch = describeCatalogSchemaMismatch(schema, value);
    expect(mismatch).toEqual({
      missingRequired: ["changeset.files[].file"],
      invalidPaths: ["changeset.files[].file", "changeset.mode", "changeset.patch"],
      unexpectedPropertyCount: 2,
      droppedPathCount: 0,
    });
    expect(JSON.stringify(mismatch)).not.toContain(secret);
    expect(matchesCatalogSchema(schema, value)).toBe(false);

    const matching = copyCatalogJson({
      changeset: { patch: "--- a\n", mode: "literal", files: [{ file: "a.ts" }] },
    });
    expect(describeCatalogSchemaMismatch(schema, matching)).toBeUndefined();
    expect(matchesCatalogSchema(schema, matching)).toBe(true);
  });

  // PR #3452 review: the account listed one entry per offending VALUE, capped at sixteen, so twenty
  // malformed items of one array filled the list and a distinct violation reached later in the walk
  // was dropped from the log line and from the correction the model received -- the model fixed what
  // it was told and was rejected again for a defect it was never informed of. Paths are distinct
  // now, and what the cap drops is counted.
  it("collapses identical violations from many array items and still names a distinct later one", () => {
    const value = copyCatalogJson({
      changeset: {
        // `files` is walked before `patch`: the distinct violation comes AFTER the repeated ones.
        files: Array.from({ length: 20 }, () => ({})),
        mode: "literal",
        patch: 5,
      },
    });
    expect(describeCatalogSchemaMismatch(schema, value)).toEqual({
      missingRequired: ["changeset.files[].file"],
      invalidPaths: ["changeset.patch"],
      unexpectedPropertyCount: 0,
      droppedPathCount: 0,
    });
    expect(matchesCatalogSchema(schema, value)).toBe(false);
  });

  it("reports a wrong root type and caps every list", () => {
    expect(describeCatalogSchemaMismatch(schema, copyCatalogJson("text"))).toEqual({
      missingRequired: [],
      invalidPaths: ["$"],
      unexpectedPropertyCount: 0,
      droppedPathCount: 0,
    });
    const wide = compileCatalogSchema({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`p${String(index)}`, { type: "string" }]),
      ),
      required: Array.from({ length: 40 }, (_, index) => `p${String(index)}`),
      additionalProperties: false,
    });
    const account = describeCatalogSchemaMismatch(wide, copyCatalogJson({}));
    expect(account?.missingRequired).toHaveLength(16);
    // The sixteen listed are the first of the SORTED distinct set (deterministic), and the twenty-four
    // the cap left out are counted, not lost.
    expect(account?.missingRequired).toEqual(
      Array.from({ length: 40 }, (_, index) => `p${String(index)}`)
        .sort()
        .slice(0, 16),
    );
    expect(account?.droppedPathCount).toBe(24);
    expect(matchesCatalogSchema(wide, copyCatalogJson({}))).toBe(false);
  });
});
