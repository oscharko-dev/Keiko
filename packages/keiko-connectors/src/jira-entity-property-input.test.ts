import { describe, expect, it, vi } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { decodeJiraPropertyInput as decode } from "./jira-entity-property-input.js";
import { JIRA_PROPERTY_VALUE_MAX_BYTES, jiraPropertyValue } from "./jira-entity-property-values.js";

function value(nodes: unknown): CatalogJsonValue {
  const result = decode(nodes);
  if (!result.ok) throw new TypeError(`Expected admitted property input: ${result.reason}`);
  return result.value;
}
const NULL = { path: "", kind: "null" };

describe("inverse native entity-property projection", () => {
  it.each([
    null,
    false,
    true,
    0,
    1.5,
    -17,
    Number.MAX_SAFE_INTEGER,
    "",
    'literal {"enabled":false}',
    [],
    {},
    { "": null, "slash/key": false, "tilde~key": 0, children: ["", {}, []] },
  ] satisfies readonly CatalogJsonValue[])(
    "round-trips the existing typed projection without a second JSON interpretation: %j",
    (native) => {
      const projected = jiraPropertyValue(native);
      if (!projected.ok) throw new TypeError("Invalid positive projection fixture");
      expect(value(projected.items)).toEqual(native);
    },
  );

  it("requires complete preorder children while preserving empty keys, escaped tokens and container types", () => {
    const nodes = [
      { path: "", kind: "object", childCount: 3 },
      { path: "/", kind: "string", textValue: "" },
      { path: "/a~1b~0c", kind: "array", childCount: 2 },
      { path: "/a~1b~0c/0", kind: "boolean", booleanValue: false },
      { path: "/a~1b~0c/1", kind: "object", childCount: 0 },
      { path: "/~01", kind: "number", numberValue: 0 },
    ];
    expect(value(nodes)).toEqual({ "": "", "a/b~c": [false, {}], "~1": 0 });
  });

  it("defines dangerous-looking names as own data fields without assigning a prototype", () => {
    const decoded = value([
      { path: "", kind: "object", childCount: 3 },
      { path: "/__proto__", kind: "object", childCount: 1 },
      { path: "/__proto__/polluted", kind: "boolean", booleanValue: true },
      { path: "/constructor", kind: "string", textValue: "data" },
      { path: "/prototype", kind: "null" },
    ]);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
      throw new TypeError("Expected object property");
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(decoded, "__proto__")?.value).toEqual({
      polluted: true,
    });
    expect(Object.getOwnPropertyDescriptor(decoded, "constructor")?.value).toBe("data");
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    const projected = jiraPropertyValue(decoded);
    expect(projected.ok).toBe(true);
  });

  it.each(
    [
      [],
      [NULL, NULL],
      [{ ...NULL, path: "/" }],
      [{ ...NULL, path: "#" }],
      [{ path: "", kind: "array", childCount: 1 }],
      [
        { path: "", kind: "object", childCount: 0 },
        { path: "/extra", kind: "null" },
      ],
      [
        { path: "", kind: "object", childCount: 2 },
        { path: "/a", kind: "null" },
        { path: "/a", kind: "null" },
      ],
      [
        { path: "", kind: "object", childCount: 1 },
        { path: "/a/b", kind: "null" },
      ],
      [
        { path: "", kind: "object", childCount: 1 },
        { path: "/a~2", kind: "null" },
      ],
      [
        { path: "", kind: "object", childCount: 1 },
        { path: "/a~", kind: "null" },
      ],
      [
        { path: "", kind: "array", childCount: 1 },
        { path: "/00", kind: "null" },
      ],
      [
        { path: "", kind: "array", childCount: 1 },
        { path: "/1", kind: "null" },
      ],
      [
        { path: "", kind: "array", childCount: 1 },
        { path: "/-", kind: "null" },
      ],
      [
        { path: "", kind: "array", childCount: 1 },
        { path: "/+0", kind: "null" },
      ],
      [
        { path: "", kind: "object", childCount: 2 },
        { path: "/a", kind: "array", childCount: 1 },
        { path: "/b", kind: "null" },
        { path: "/a/0", kind: "null" },
      ],
    ].map((nodes) => ({ nodes })),
  )("refuses missing, duplicate, extra or noncanonical preorder structure: %j", ({ nodes }) => {
    expect(decode(nodes)).toEqual({ ok: false, reason: "invalid-input" });
  });

  it.each([
    { kind: "null" },
    { path: "" },
    { ...NULL, value: null },
    { ...NULL, childCount: 0 },
    { path: "", kind: "boolean", booleanValue: "false" },
    { path: "", kind: "boolean", booleanValue: false, textValue: "false" },
    { path: "", kind: "number", numberValue: "0" },
    { path: "", kind: "string", textValue: null },
    { path: "", kind: "object", childCount: -1 },
    { path: "", kind: "array", childCount: 1.5 },
    { path: "", kind: "object", childCount: "0" },
    { path: "", kind: "array", childCount: 0, items: [] },
    { path: "", kind: "unknown" },
  ])("refuses fields outside the exact typed-node contract: %j", (node) => {
    expect(decode([node])).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("does not invoke node or collection accessors", () => {
    const getter = vi.fn(() => "secret-like data");
    const node = { path: "", kind: "string" };
    Object.defineProperty(node, "textValue", { enumerable: true, get: getter });
    expect(decode([node])).toEqual({ ok: false, reason: "invalid-input" });
    const nodes: unknown[] = [NULL];
    Object.defineProperty(nodes, "0", { enumerable: true, get: getter });
    expect(decode(nodes)).toEqual({ ok: false, reason: "invalid-input" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("refuses inherited, hidden, symbol-bearing, sparse and augmented input fields", () => {
    const inherited: unknown = Object.create({ path: "", kind: "null" });
    expect(decode([inherited])).toEqual({ ok: false, reason: "invalid-input" });
    const hidden = { ...NULL };
    Object.defineProperty(hidden, "extra", { value: true, enumerable: false });
    expect(decode([hidden])).toEqual({ ok: false, reason: "invalid-input" });
    expect(decode([{ ...NULL, [Symbol("extra")]: true }])).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(decode(sparse)).toEqual({ ok: false, reason: "invalid-input" });
    const augmented: unknown[] = [NULL];
    Object.defineProperty(augmented, "extra", { value: true });
    expect(decode(augmented)).toEqual({ ok: false, reason: "invalid-input" });
    const symbolArray: unknown[] = [NULL];
    Object.defineProperty(symbolArray, Symbol("extra"), { value: true });
    expect(decode(symbolArray)).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("accepts immutable and null-prototype own data nodes without changing caller data", () => {
    const node: Record<string, unknown> = Object.fromEntries([
      ["path", ""],
      ["kind", "null"],
    ]);
    Object.setPrototypeOf(node, null);
    Object.freeze(node);
    const nodes = Object.freeze([node]);
    expect(decode(nodes)).toEqual({ ok: true, value: null });
    expect(Object.getPrototypeOf(node)).toBeNull();
    expect(Object.isFrozen(nodes)).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "reuses the existing native JSON-number boundary: %s",
    (numberValue) => {
      expect(decode([{ path: "", kind: "number", numberValue }])).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    },
  );
  it.each([Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1, 1.5e300])(
    "preserves the native numeric admission refusal: %s",
    (numberValue) => {
      expect(decode([{ path: "", kind: "number", numberValue }])).toEqual({
        ok: false,
        reason: "bounds-exceeded",
      });
    },
  );
  it.each(["ordinary", "界", "\t\n\r", "\ud800", "\u0001"])(
    "keeps string Unicode/control rules aligned with the existing projector: %j",
    (textValue) => {
      const projected = jiraPropertyValue(textValue);
      expect(decode([{ path: "", kind: "string", textValue }])).toEqual(
        projected.ok
          ? { ok: true, value: textValue }
          : {
              ok: false,
              reason: projected.reason === "bounds-exceeded" ? "bounds-exceeded" : "invalid-input",
            },
      );
    },
  );
  it.each(["界", "\ud800", "\u0001", "", "/", "~"])(
    "keeps decoded object-key Unicode rules aligned with the existing projector: %j",
    (key) => {
      const native = Object.fromEntries([[key, null]]);
      const projected = jiraPropertyValue(native);
      const path = `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      expect(
        decode([
          { path: "", kind: "object", childCount: 1 },
          { path, kind: "null" },
        ]),
      ).toEqual(
        projected.ok
          ? { ok: true, value: native }
          : {
              ok: false,
              reason: projected.reason === "bounds-exceeded" ? "bounds-exceeded" : "invalid-input",
            },
      );
    },
  );

  it("reuses the native UTF-8 JSON-byte boundary rather than counting UTF-16 characters", () => {
    expect(
      decode([
        { path: "", kind: "string", textValue: "x".repeat(JIRA_PROPERTY_VALUE_MAX_BYTES - 2) },
      ]).ok,
    ).toBe(true);
    expect(
      decode([
        { path: "", kind: "string", textValue: "x".repeat(JIRA_PROPERTY_VALUE_MAX_BYTES - 1) },
      ]),
    ).toEqual({ ok: false, reason: "bounds-exceeded" });
    expect(decode([{ path: "", kind: "string", textValue: "界".repeat(12000) }])).toEqual({
      ok: false,
      reason: "bounds-exceeded",
    });
  });
  it("retains the established catalog node, container and depth ceilings", () => {
    expect(
      decode(Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, () => NULL)),
    ).toEqual({ ok: false, reason: "bounds-exceeded" });
    expect(
      decode([{ path: "", kind: "object", childCount: TOOL_CATALOG_LIMITS.maxObjectKeys + 1 }]),
    ).toEqual({ ok: false, reason: "bounds-exceeded" });
    expect(
      decode([{ path: "", kind: "array", childCount: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }]),
    ).toEqual({ ok: false, reason: "bounds-exceeded" });
    const deep = Array.from({ length: TOOL_CATALOG_LIMITS.maxSchemaDepth + 2 }, (_, index) => ({
      path: "/a".repeat(index),
      kind: "object",
      childCount: 1,
    }));
    expect(decode([...deep, { path: "/a".repeat(deep.length), kind: "null" }])).toEqual({
      ok: false,
      reason: "bounds-exceeded",
    });
  });
});
