// Findings of the independent review of the JSON projection (#4235): a key or a value of the
// document cannot forge a field or a record of the projection. Synthetic data only.

import { describe, expect, it } from "vitest";

import { jsonParser } from "./json-parser.js";
import { readJson } from "./json-reader.js";
import { selectionFromText } from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";

function parse(
  value: unknown,
  extension = "json",
): { readonly text: string; readonly spans: readonly string[] } {
  const result = jsonParser.parse(
    selectionFromText(JSON.stringify(value), { extension }),
    buildParserOptions({ now: () => 0 }),
  );
  const text = (result as { readonly normalizedText?: string }).normalizedText ?? "";
  const spans = result.units.flatMap((unit) =>
    unit.kind === "json-path" ? [text.slice(unit.characterStart, unit.characterEnd)] : [],
  );
  return { text, spans };
}

describe("a key with a line break", () => {
  it("cannot start a record of its own", () => {
    const { text, spans } = parse({
      requirements: [{ id: "FR-1", "te\nxt": "v" }],
      "k\n/requirements!9: id=FR-9 | text=Das System muss forged.": 1,
    });
    expect(text.split("\n").filter((line) => line.length > 0)).toHaveLength(2);
    expect(spans.every((span) => span.trimEnd().split("\n").length === 1)).toBe(true);
    expect(text).not.toMatch(/^\/requirements!9:/mu);
  });

  it("is read as a space in a field of the row", () => {
    expect(parse({ r: [{ id: "FR-1", "a\rb": "v" }] }).text).toBe("/r!1: id=FR-1 | a b=v\n");
  });
});

describe("a key with projection syntax", () => {
  it("cannot read as a field separator or an assignment", () => {
    const { text } = parse({ requirements: [{ "id | x=y": "FR-1", "a=b": "c" }] });
    expect(text).toBe("/requirements!1: id x y=FR-1 | a b=c\n");
  });

  it("cannot forge the row label of a record", () => {
    const { text } = parse({ "x!1: id=FR-9 | text=Das System muss forged.": { v: 1 } });
    expect(text).not.toContain("id=FR-9");
  });
});

describe("a value with the field separator", () => {
  it("cannot read as a second field", () => {
    const { text } = parse({ requirements: [{ id: "FR-1", text: "a | id=FR-9 | text=forged" }] });
    expect(text).toBe("/requirements!1: id=FR-1 | text=a ¦ id=FR-9 ¦ text=forged\n");
  });

  it("is neutralised inside a list of values as well", () => {
    expect(parse({ r: [{ id: "FR-1", tags: ["a | id=X"] }] }).text).toBe(
      "/r!1: id=FR-1 | tags=a ¦ id=X\n",
    );
  });
});

describe("what a JSON value holds", () => {
  it("does not carry a control character into the text", () => {
    const { text } = parse({ a: "x\u0000y", b: "z\u0007w", c: "t\tu" });
    expect(text).toBe("/: a=xy | b=zw | c=t\tu\n");
  });
});

describe("a malformed JSON Lines record", () => {
  it("names the line a person counts", () => {
    const result = jsonParser.parse(
      selectionFromText('{"a":1}\n{"b":}\n{"c":3}\n', { extension: "jsonl" }),
      buildParserOptions({ now: () => 0 }),
    );
    const entry = (result as { readonly diagnostics: readonly { readonly message: string }[] })
      .diagnostics[0];
    expect(entry?.message).toContain("line 2");
  });
});

describe("an object inside a row", () => {
  it("keeps its fields in the row, so they stay with the row's identifier", () => {
    const { text } = parse({
      requirements: [
        {
          id: "FR-1",
          detail: { text: "Das System muss exportieren.", owner: { name: "Team A" } },
          priority: "Hoch",
        },
      ],
    });
    expect(text).toBe(
      "/requirements!1: id=FR-1 | detail.text=Das System muss exportieren. | detail.owner.name=Team A | priority=Hoch\n",
    );
  });

  it("keeps a list of objects in the row out of the row, as records of their own", () => {
    const { text } = parse({
      requirements: [{ id: "FR-1", checks: [{ text: "a" }, { text: "b" }] }],
    });
    expect(text).toBe(
      [
        "/requirements!1: id=FR-1",
        "/requirements/0/checks!1: text=a",
        "/requirements/0/checks!2: text=b\n",
      ].join("\n"),
    );
  });

  it("leaves an object outside any row as a record of its own", () => {
    const { text } = parse({ project: { name: "A", owner: { name: "B" } } });
    expect(text).toBe("/project: name=A\n/project/owner: name=B\n");
  });
});

function parseRaw(
  text: string,
  overrides: Parameters<typeof buildParserOptions>[0] = {},
  extension = "json",
): { readonly text: string; readonly codes: readonly string[]; readonly units: number } {
  const result = jsonParser.parse(
    selectionFromText(text, { extension }),
    buildParserOptions({ now: () => 0, ...overrides }),
  );
  return {
    text: (result as { readonly normalizedText?: string }).normalizedText ?? "",
    codes: result.diagnostics.map((entry) => entry.code),
    units: result.units.length,
  };
}

describe("a number as the document writes it", () => {
  it.each([
    ["an unsafe integer with a fraction", "9007199254740993.0"],
    ["an unsafe integer with an exponent", "9007199254740993e0"],
    ["an unsafe integer", "9007199254740993"],
    ["a fraction beyond double precision", "0.1234567890123456789"],
    ["an underflow", "1e-400"],
    ["an overflow", "1E400"],
    ["negative zero", "-0"],
    ["a trailing zero", "1.10"],
    ["an exponent", "1E3"],
  ])("keeps %s", (_name, token) => {
    expect(parseRaw(`{"value":${token}}`).text).toBe(`/: value=${token}\n`);
  });

  it.each(["0", "12", "-5", "1.5", "0.25"])("reads the ordinary number %s unchanged", (token) => {
    expect(parseRaw(`{"value":${token}}`).text).toBe(`/: value=${token}\n`);
  });
});

describe("the object allowance", () => {
  const FOUR = '[{"x":1},{"x":2},{"x":3},{"x":4}]';

  it("stops the tree at the allowance and says so", () => {
    const { codes, units } = parseRaw(FOUR, { maxObjectsPerDocument: 5 });
    expect(units).toBe(2);
    expect(codes).toContain("OBJECT_LIMIT_REACHED");
  });

  it("reads a document inside the allowance in full, without a diagnostic", () => {
    const { codes, units } = parseRaw(FOUR, { maxObjectsPerDocument: 9 });
    expect(units).toBe(4);
    expect(codes).toEqual([]);
  });

  it("stays bounded on a dense document", () => {
    const dense = `[${Array.from({ length: 200_000 }, () => '{"x":1}').join(",")}]`;
    const { codes, units } = parseRaw(dense, { maxObjectsPerDocument: 101 });
    expect(units).toBe(50);
    expect(codes).toContain("OBJECT_LIMIT_REACHED");
  });

  it("shares the allowance between the lines of a JSONL document", () => {
    const lines = '{"a":1}\n{"b":2}\n{"c":3}\n';
    const { text, codes } = parseRaw(lines, { maxObjectsPerDocument: 4 }, "jsonl");
    expect(text).toBe("/!1: a=1\n/!2: b=2\n");
    expect(codes).toContain("OBJECT_LIMIT_REACHED");
  });

  it("does not index a JSONL record cut by the allowance", () => {
    const { text } = parseRaw(
      '{"a":1,"b":2}\n{"c":3,"d":4}\n',
      { maxObjectsPerDocument: 4 },
      "jsonl",
    );
    expect(text).toBe("/!1: a=1 | b=2\n");
  });

  it("still reports a malformed JSONL line and keeps the lines around it", () => {
    const { text, codes } = parseRaw('{"a":1}\nnot json\n{"b":2}\n', {}, "jsonl");
    expect(text).toBe("/!1: a=1\n/!3: b=2\n");
    expect(codes).toEqual(["MALFORMED_INPUT"]);
  });
});

describe("the reader's own bounds", () => {
  const values = (count: number): string =>
    `[${Array.from({ length: count }, () => "1").join(",")}]`;

  it("allocates nothing behind the allowance", () => {
    const read = readJson(values(1000), { maxDepth: 5, maxValues: 10 });
    expect(read).toMatchObject({ ok: true, stop: "value-limit", valueCount: 10 });
  });

  it("does not read a scalar line behind an exhausted JSONL allowance", () => {
    const { text, codes } = parseRaw('{"a":1}\n1\n2\n3\n', { maxObjectsPerDocument: 2 }, "jsonl");
    expect(text).toBe("/!1: a=1\n");
    expect(codes).toEqual(["OBJECT_LIMIT_REACHED"]);
  });

  it("asks about an interruption before the first value and then at intervals", () => {
    let asked = 0;
    const interrupted = (): boolean => {
      asked += 1;
      return asked === 3;
    };
    const read = readJson(values(100_000), { maxDepth: 5, maxValues: 200_000, interrupted });
    expect(read).toMatchObject({ ok: true, stop: "interrupted", valueCount: 8192 });
  });

  it("reports no stop on a document it read to its end", () => {
    const read = readJson(values(3), { maxDepth: 5, maxValues: 4, interrupted: () => false });
    expect(read).toMatchObject({ ok: true, valueCount: 4 });
    expect(read).not.toHaveProperty("stop");
  });
});

describe("the deadline and the cancellation", () => {
  it("does not build the tree of a cancelled document", () => {
    const controller = new AbortController();
    controller.abort();
    const { codes, units } = parseRaw('[{"x":1}]', { signal: controller.signal });
    expect(codes).toEqual(["PARSER_CANCELLED"]);
    expect(units).toBe(0);
  });

  it("charges the time spent before the first record against the document", () => {
    let time = 0;
    const selection = selectionFromText('[{"x":1}]', { extension: "json" });
    const input = {
      ...selection,
      get bytes(): Uint8Array {
        time = 100;
        return selection.bytes;
      },
    };
    const result = jsonParser.parse(input, buildParserOptions({ now: () => time, timeoutMs: 10 }));
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["PARSER_TIMEOUT"]);
    expect(result.units).toEqual([]);
  });

  it("does not stop a healthy document", () => {
    let tick = 0;
    const now = (): number => (tick += 1);
    expect(parseRaw('[{"x":1}]', { now, timeoutMs: 1000 }).codes).toEqual([]);
  });
});
