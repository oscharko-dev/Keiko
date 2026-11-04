// Findings of the independent review of the JSON projection (#4235): a key or a value of the
// document cannot forge a field or a record of the projection. Synthetic data only.

import { describe, expect, it } from "vitest";

import { jsonParser } from "./json-parser.js";
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
