import { describe, expect, it } from "vitest";

import { readJson, type JsonReadLimits, type JsonValue } from "./json-reader.js";

function limits(maxDepth: number): JsonReadLimits {
  return { maxDepth, maxValues: Number.MAX_SAFE_INTEGER };
}

function value(text: string): JsonValue {
  const result = readJson(text, limits(128));
  if (!result.ok) throw new Error(`unexpected failure: ${result.reason}`);
  return result.value;
}

describe("readJson", () => {
  it("reads every JSON value kind", () => {
    expect(value("null")).toBeNull();
    expect(value(" true ")).toBe(true);
    expect(value("false")).toBe(false);
    expect(value("-50")).toBe(-50);
    expect(value("-0.5")).toBe(-0.5);
    expect(value("-0.5e2")).toEqual({ kind: "exact-number", source: "-0.5e2" });
    expect(value('"a\\u00e4\\n\\"b"')).toBe('aä\n"b');
    expect(value("[1, [2], {}]")).toEqual({
      kind: "array",
      items: [1, { kind: "array", items: [2] }, { kind: "object", entries: [] }],
    });
  });

  it("keeps __proto__ as an ordinary key", () => {
    const parsed = value('{"__proto__":1}');
    expect(parsed).toEqual({ kind: "object", entries: [["__proto__", 1]] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keeps the literal of an unsafe integer and of a number beyond double range", () => {
    expect(value("9007199254740993")).toEqual({ kind: "exact-number", source: "9007199254740993" });
    expect(value("9007199254740991")).toBe(9007199254740991);
    expect(value("1e400")).toEqual({ kind: "exact-number", source: "1e400" });
  });

  it("counts repeated keys per object, not across objects", () => {
    const result = readJson('[{"a":1,"a":2,"a":3},{"a":1}]', limits(128));
    expect(result).toMatchObject({ ok: true, duplicateKeyCount: 2 });
  });

  it("locates a failure by line and column across line breaks", () => {
    expect(readJson('{\n  "a": 1,\n  "b": ]\n}', limits(128))).toEqual({
      ok: false,
      reason: "unexpected-token",
      line: 3,
      column: 8,
    });
  });

  it("reports truncation at the end of the text", () => {
    expect(readJson('{"a":', limits(128))).toMatchObject({ ok: false, reason: "unexpected-end" });
    expect(readJson('"abc', limits(128))).toMatchObject({ ok: false, reason: "unexpected-end" });
    expect(readJson("[1,", limits(128))).toMatchObject({ ok: false, reason: "unexpected-end" });
    expect(readJson("tru", limits(128))).toMatchObject({ ok: false });
  });

  it("refuses containers deeper than the limit and never recurses past the hard ceiling", () => {
    expect(readJson("[[[1]]]", limits(1))).toMatchObject({ ok: false, reason: "nesting-depth" });
    expect(readJson("[[[1]]]", limits(3))).toMatchObject({ ok: true });
    expect(readJson("[".repeat(500_000), limits(1_000_000))).toMatchObject({
      ok: false,
      reason: "nesting-depth",
    });
  });

  it("rejects what JSON.parse rejects", () => {
    for (const bad of ["{'a':1}", "[1 2]", '{"a" 1}', "{,}", "NaN", "+1", ".5", "1e", '"\\x"']) {
      expect(readJson(bad, limits(128)).ok, bad).toBe(false);
    }
  });
});
