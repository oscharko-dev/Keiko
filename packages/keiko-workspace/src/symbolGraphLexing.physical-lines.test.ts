import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import {
  CALL_REGEX,
  IDENTIFIER_REGEX,
  collectDefinitions,
  collectIdentifiers,
} from "./symbolGraphLexing.js";

describe("symbol lexing physical-line provenance", () => {
  it.each([
    { text: "", locations: [] },
    { text: "\n\n", locations: [] },
    { text: "const true return undefined", locations: [] },
    { text: "alpha", locations: [["alpha", 1, 0]] },
    { text: "\nalpha", locations: [["alpha", 2, 0]] },
    { text: "alpha\n", locations: [["alpha", 1, 0]] },
    { text: "\n\nalpha", locations: [["alpha", 3, 0]] },
    {
      text: "alpha beta",
      locations: [
        ["alpha", 1, 0],
        ["beta", 1, 1],
      ],
    },
    {
      text: "alpha\nbeta",
      locations: [
        ["alpha", 1, 0],
        ["beta", 2, 1],
      ],
    },
    {
      text: "alpha\r\nbeta",
      locations: [
        ["alpha", 1, 0],
        ["beta", 2, 1],
      ],
    },
    {
      text: "alpha\rbeta",
      locations: [
        ["alpha", 1, 0],
        ["beta", 1, 1],
      ],
    },
    {
      text: "alpha\u2028beta",
      locations: [
        ["alpha", 1, 0],
        ["beta", 1, 1],
      ],
    },
    {
      text: "🤖alpha\nbeta",
      locations: [
        ["alpha", 1, 0],
        ["beta", 2, 1],
      ],
    },
    {
      text: "/*\nalpha\n*/\nbeta",
      locations: [
        ["alpha", 2, 0],
        ["beta", 4, 1],
      ],
    },
    {
      text: "// alpha\nconst beta=gamma;",
      locations: [
        ["alpha", 1, 0],
        ["beta", 2, 1],
        ["gamma", 2, 2],
      ],
    },
    {
      text: "alpha\nreturn beta\nalpha",
      locations: [
        ["alpha", 1, 0],
        ["beta", 2, 1],
        ["alpha", 3, 2],
      ],
    },
    {
      text: "_alpha alpha123",
      locations: [
        ["_alpha", 1, 0],
        ["alpha123", 1, 1],
      ],
    },
    { text: "\r\n\r\nlast", locations: [["last", 3, 0]] },
  ])("preserves complete identifier arrays for $text", ({ text, locations }) => {
    expect(
      collectIdentifiers(text, IDENTIFIER_REGEX).map((hit) => [hit.symbol, hit.line, hit.ordinal]),
    ).toEqual(locations);
  });

  it("resets physical-line and regex cursors between identifier and call scans", () => {
    const text = "alpha()\n  beta (\n gamma()";
    const expected = [
      ["alpha", 1, 0],
      ["beta", 2, 1],
      ["gamma", 3, 2],
    ];
    expect(
      collectIdentifiers(text, CALL_REGEX).map((hit) => [hit.symbol, hit.line, hit.ordinal]),
    ).toEqual(expected);
    expect(
      collectIdentifiers(text, IDENTIFIER_REGEX).map((hit) => [hit.symbol, hit.line, hit.ordinal]),
    ).toEqual(expected);
    expect(collectIdentifiers("last()", CALL_REGEX)).toEqual([
      { symbol: "last", line: 1, ordinal: 0 },
    ]);
  });

  it("preserves definition sorting, pattern ordinals and leading-whitespace coordinates", () => {
    expect(
      collectDefinitions("export const first = 1;\n\nfunction second() {}\nclass Third {}"),
    ).toEqual([
      { symbol: "first", line: 1, ordinal: 2, definitionKind: "variable" },
      { symbol: "second", line: 2, ordinal: 0, definitionKind: "function" },
      { symbol: "Third", line: 4, ordinal: 1, definitionKind: "class" },
    ]);
  });

  it("collects a 10,000-line structural source within a generous CPU regression bound", () => {
    const text = Array.from(
      { length: 10_000 },
      (_, index) =>
        `export function physicalLine${String(index)}() { return value${String(index)} + peer${String(index)}(); }`,
    ).join("\n");
    const started = performance.now();
    const hits = collectIdentifiers(text, IDENTIFIER_REGEX);
    const elapsed = performance.now() - started;
    expect(hits).toHaveLength(30_000);
    expect(hits[0]).toEqual({ symbol: "physicalLine0", line: 1, ordinal: 0 });
    expect(hits.at(-1)).toEqual({ symbol: "peer9999", line: 10_000, ordinal: 29_999 });
    expect(elapsed).toBeLessThan(1_000);
  }, 60_000);
});
