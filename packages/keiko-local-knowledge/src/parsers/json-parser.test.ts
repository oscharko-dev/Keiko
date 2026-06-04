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
