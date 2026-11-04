// Regression pins for #4235: the JSON projection reads like the document, loses no digit or key
// silently, and every diagnostic is body-free. Synthetic data only.

import { describe, expect, it } from "vitest";

import { jsonParser } from "./json-parser.js";
import { selectionFromText } from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";

function textOf(result: unknown): string {
  return (result as { readonly normalizedText?: string }).normalizedText ?? "";
}

function run(
  text: string,
  extension = "json",
  overrides: Parameters<typeof buildParserOptions>[0] = {},
): ReturnType<typeof jsonParser.parse> {
  return jsonParser.parse(
    selectionFromText(text, { extension }),
    buildParserOptions({ now: () => 0, ...overrides }),
  );
}

describe("jsonParser projection (#4235)", () => {
  it("projects a string scalar as its value, so an identifier is readable", () => {
    const result = run('[{"id":"FA-KRED-001","titel":"Antrag erfassen","muss":true,"n":2}]');
    expect(textOf(result)).toBe("/0: id=FA-KRED-001 | titel=Antrag erfassen | muss=true | n=2\n");
  });

  it("keeps a string array readable and null distinguishable from an empty string", () => {
    expect(textOf(run('{"leer":"","nichts":null}'))).toBe("/: leer= | nichts=null\n");
    expect(textOf(run('["a","b"]'))).toBe("/: [a, b]\n");
    expect(textOf(run('{"tags":["a","b"],"kurz":"x"}'))).toBe("/: kurz=x\n/tags: [a, b]\n");
  });

  it("keeps a multi-line string on one projection line so the text stays line-aligned", () => {
    const result = run('{"kriterien":"AK1 a\\nAK2 b\\r\\nAK3 c"}');
    expect(textOf(result)).toBe("/: kriterien=AK1 a AK2 b AK3 c\n");
  });

  it("keeps an integer beyond 2^53 digit for digit", () => {
    const result = run('{"id":12345678901234567890,"small":7,"neg":-9007199254740993}');
    expect(textOf(result)).toBe("/: id=12345678901234567890 | small=7 | neg=-9007199254740993\n");
  });

  it("keeps a number outside the double range instead of writing null", () => {
    expect(textOf(run('{"x":1e999}'))).toBe("/: x=1e999\n");
  });

  it("keeps both values of a duplicated key and reports the count", () => {
    const result = run('{"id":"FA-1","id":"FA-2","name":"x"}');
    expect(textOf(result)).toBe("/: id=FA-1 | id=FA-2 | name=x\n");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "JSON_DUPLICATE_KEY", severity: "warning" }),
    ]);
    expect(result.diagnostics[0]?.message).toContain("1");
    expect(result.diagnostics[0]?.message).not.toContain("FA-");
  });

  it("detects a duplicate in a large object as well as a small one", () => {
    const fields = Array.from({ length: 20 }, (_, index) => `"k${String(index)}":${String(index)}`);
    const result = run(`{${fields.join(",")},"k3":99}`);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["JSON_DUPLICATE_KEY"]);
  });

  it("does not report duplicates for the same key in different objects", () => {
    expect(run('[{"id":1},{"id":2}]').diagnostics).toEqual([]);
  });
});

describe("jsonParser diagnostics (#4235)", () => {
  it("names the position and a closed reason of a parse failure without echoing content", () => {
    const secret = "AKIA-LIVE-SECRET-9F8E7D6C";
    const result = run(`{\n  "token": "${secret}",\n  "x": oops\n}`);
    const [entry] = result.diagnostics;
    expect(entry).toMatchObject({ code: "MALFORMED_INPUT", severity: "error" });
    expect(entry?.message).toContain("line 3");
    expect(entry?.message).toContain("column 8");
    expect(entry?.message).toContain("unexpected-token");
    expect(entry?.message).not.toContain(secret);
    expect(entry?.message).not.toContain("oops");
  });

  it.each([
    ["", "unexpected-end"],
    ['{"a":1', "unexpected-end"],
    ['{"a":1} x', "trailing-content"],
    ['{"a":01}', "unexpected-token"],
    ['{"a":"\\u12"}', "invalid-string"],
    ['{"a":1.}', "invalid-number"],
    ['{"a":-}', "invalid-number"],
    ['{"a":"line\nbreak"}', "invalid-string"],
    ["[1,]", "unexpected-token"],
  ])("classifies %j as %s", (text, reason) => {
    expect(run(text).diagnostics[0]?.message).toContain(reason);
  });

  it("does not put a document key into the nesting-limit diagnostic", () => {
    const result = run('{"geheimerSchluessel":{"b":{"c":{"d":{"e":1}}}}}', "json", {
      maxNestingDepth: 2,
    });
    const entry = result.diagnostics.find((d) => d.code === "NESTING_LIMIT_REACHED");
    expect(entry?.severity).toBe("error");
    expect(entry?.message).toContain("maxNestingDepth=2");
    expect(entry?.message).not.toContain("geheimerSchluessel");
  });

  it("does not echo a key through the walk-time nesting limit either", () => {
    const result = run('{"geheimerSchluessel":{"b":[{"c":1}]}}', "json", { maxNestingDepth: 2 });
    const entry = result.diagnostics.find((d) => d.code === "NESTING_LIMIT_REACHED");
    expect(entry).toBeDefined();
    expect(entry?.message).not.toContain("geheimerSchluessel");
  });

  it("reports a record cap honestly: warning severity, the cap and the omitted record count", () => {
    const records = Array.from({ length: 10 }, (_, index) => ({ id: index }));
    const result = run(JSON.stringify(records), "json", { maxUnitsPerDocument: 4 });
    expect(result.units).toHaveLength(4);
    const entry = result.diagnostics.find((d) => d.code === "UNIT_LIMIT_REACHED");
    expect(entry?.severity).toBe("warning");
    expect(entry?.message).toContain("maxUnitsPerDocument=4");
    expect(entry?.message).toContain("6 further");
  });

  it("applies the same honest cap to JSON Lines", () => {
    const lines = Array.from({ length: 8 }, (_, index) => `{"n":${String(index)}}`).join("\n");
    const result = run(lines, "jsonl", { maxUnitsPerDocument: 3 });
    expect(result.units).toHaveLength(3);
    const entry = result.diagnostics.find((d) => d.code === "UNIT_LIMIT_REACHED");
    expect(entry?.severity).toBe("warning");
    expect(entry?.message).toContain("5 further");
  });

  it("locates a malformed JSONL line by position and keeps the rest", () => {
    const result = run('{"a":1}\n{"b":}\n{"c":3}\n', "jsonl");
    const entry = result.diagnostics.find((d) => d.code === "MALFORMED_INPUT");
    expect(entry?.message).toContain("line 1");
    expect(entry?.message).toContain("column 6");
    expect(textOf(result)).toContain("/2: c=3");
  });

  it("refuses a very deep document without exhausting the stack", () => {
    const result = run("[".repeat(200_000), "json", { maxNestingDepth: 100_000 });
    expect(result.diagnostics[0]?.code).toBe("NESTING_LIMIT_REACHED");
  });
});
