import type { ParsedUnit } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import { jsonParser } from "./json-parser.js";
import {
  JSON_FLAT,
  JSON_NESTED,
  encode,
  selectionFromBytes,
  selectionFromText,
} from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";

function pointers(units: readonly ParsedUnit[]): readonly string[] {
  return units.map((unit) => {
    if (unit.kind !== "json-path") throw new Error(`expected json-path unit, got ${unit.kind}`);
    return unit.jsonPointer;
  });
}

function nestedJson(depth: number): string {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i += 1) {
    value = { child: value };
  }
  return JSON.stringify(value);
}

describe("jsonParser", () => {
  it("matches by extension and media type", () => {
    expect(jsonParser.capability.matches(selectionFromText("{}", { extension: "json" }))).toBe(
      true,
    );
    expect(
      jsonParser.capability.matches(
        selectionFromText("{}", { extension: "", mediaType: "application/json" }),
      ),
    ).toBe(true);
    expect(jsonParser.capability.matches(selectionFromText("hi", { extension: "txt" }))).toBe(
      false,
    );
  });

  it("emits one unit per leaf for a flat object", () => {
    const result = jsonParser.parse(
      selectionFromText(JSON_FLAT, { extension: "json" }),
      buildParserOptions({ now: () => 0 }),
    );
    expect(pointers(result.units)).toEqual(["/name", "/count", "/active"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("descends into nested arrays and objects with RFC 6901 pointers", () => {
    const result = jsonParser.parse(
      selectionFromText(JSON_NESTED, { extension: "json" }),
      buildParserOptions({ now: () => 0 }),
    );
    expect(pointers(result.units)).toEqual([
      "/meta/id",
      "/meta/version",
      "/items/0/sku",
      "/items/0/price",
      "/items/1/sku",
      "/items/1/price",
    ]);
  });

  it("escapes ~ and / in object keys per RFC 6901", () => {
    const obj = JSON.stringify({ "a/b": 1, "c~d": 2 });
    const result = jsonParser.parse(
      selectionFromText(obj, { extension: "json" }),
      buildParserOptions({ now: () => 0 }),
    );
    expect(pointers(result.units)).toEqual(["/a~1b", "/c~0d"]);
  });

  it("escapes keys that contain both ~ and / per RFC 6901", () => {
    // Key "a~/b" must become "a~0~1b" — tilde escaped first, slash second.
    const obj = JSON.stringify({ "a~/b": 1 });
    const result = jsonParser.parse(
      selectionFromText(obj, { extension: "json" }),
      buildParserOptions({ now: () => 0 }),
    );
    expect(pointers(result.units)).toEqual(["/a~0~1b"]);
  });

  it("emits a single root-pointer leaf for a primitive root", () => {
    const result = jsonParser.parse(
      selectionFromText('"hello"', { extension: "json" }),
      buildParserOptions({ now: () => 0 }),
    );
    expect(pointers(result.units)).toEqual([""]);
  });

  it("aligns leaf offsets to bounded normalized leaf text", () => {
    const result = jsonParser.parse(
      selectionFromText(JSON.stringify({ a: "first", b: "second" }), { extension: "json" }),
      buildParserOptions({ now: () => 0 }),
    );
    const normalizedText = (result as { readonly normalizedText?: string }).normalizedText;
    expect(normalizedText).toBe('/a: "first"\n/b: "second"\n');
    expect(result.units).toHaveLength(2);
    const first = result.units[0];
    const second = result.units[1];
    if (first === undefined || second === undefined) throw new Error("expected two JSON leaves");
    if (first.kind !== "json-path" || second.kind !== "json-path") {
      throw new Error("expected JSON path units");
    }
    expect(first.characterStart).toBe(0);
    expect(first.characterEnd).toBe('/a: "first"\n'.length);
    expect(second.characterStart).toBe(first.characterEnd);
    expect(second.characterEnd).toBe(normalizedText?.length);
  });

  it("treats empty arrays and empty objects as leaves", () => {
    const obj = JSON.stringify({ empties: [], empty: {} });
    const result = jsonParser.parse(
      selectionFromText(obj, { extension: "json" }),
      buildParserOptions({ now: () => 0 }),
    );
    expect(pointers(result.units)).toEqual(["/empties", "/empty"]);
  });

  it("emits MALFORMED_INPUT error on invalid JSON", () => {
    const result = jsonParser.parse(
      selectionFromText("{ broken", { extension: "json" }),
      buildParserOptions({ now: () => 0 }),
    );
    expect(result.units).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("MALFORMED_INPUT");
    expect(result.diagnostics[0]?.severity).toBe("error");
  });

  it("does not echo document content in the parse-error diagnostic (#189 audit)", () => {
    // Modern Node embeds a fragment of the surrounding text in JSON.parse error messages. A
    // secret near the parse error must not leak into the persisted, UI-surfaced diagnostic.
    const secret = "AKIA-LIVE-SECRET-9F8E7D6C";
    const result = jsonParser.parse(
      selectionFromText(`{ "token": "${secret}" broken`, { extension: "json" }),
      buildParserOptions({ now: () => 0 }),
    );
    expect(result.diagnostics[0]?.code).toBe("MALFORMED_INPUT");
    expect(result.diagnostics[0]?.message ?? "").not.toContain(secret);
  });

  it("refuses oversize files", () => {
    const big = encode("0".repeat(100));
    const result = jsonParser.parse(
      selectionFromBytes(big, { extension: "json", mediaType: "application/json" }),
      buildParserOptions({ now: () => 0, maxBytes: 10 }),
    );
    expect(result.units).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("OVERSIZED_FILE");
  });

  it("truncates with UNIT_LIMIT_REACHED when there are more leaves than allowed", () => {
    const obj = JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5 });
    const result = jsonParser.parse(
      selectionFromText(obj, { extension: "json" }),
      buildParserOptions({ now: () => 0, maxUnitsPerDocument: 2 }),
    );
    expect(result.units.length).toBeLessThanOrEqual(2);
    expect(result.diagnostics.some((d) => d.code === "UNIT_LIMIT_REACHED")).toBe(true);
  });

  it("fails deep JSON traversal before exceeding the nesting limit", () => {
    const result = jsonParser.parse(
      selectionFromText(nestedJson(5), { extension: "json" }),
      buildParserOptions({ now: () => 0, maxNestingDepth: 3 }),
    );
    expect(result.units).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({
      code: "NESTING_LIMIT_REACHED",
      severity: "error",
    });
  });

  it("emits PARSER_CANCELLED when the signal is already aborted", () => {
    const ac = new AbortController();
    ac.abort();
    const result = jsonParser.parse(
      selectionFromText(JSON_NESTED, { extension: "json" }),
      buildParserOptions({ now: () => 0, signal: ac.signal }),
    );
    expect(result.diagnostics.some((d) => d.code === "PARSER_CANCELLED")).toBe(true);
  });
});
