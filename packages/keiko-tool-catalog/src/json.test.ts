import { describe, expect, it } from "vitest";
import {
  copyCatalogJson,
  isCatalogJsonArray,
  readBoundCatalogToolCall,
  readCatalogToolCall,
} from "./json.js";

const CALL = { id: "call-1", name: "read_file", arguments: { path: "a.txt" } };
const BOUND = { ...CALL, invocation: { kind: "bound" } };

describe("readCatalogToolCall", () => {
  it("reads an exact call and keeps the copy's key order", () => {
    const copy = copyCatalogJson(CALL);
    const call = readCatalogToolCall(copy);
    expect(call).toEqual(CALL);
    expect(JSON.stringify(call)).toBe(JSON.stringify(copy));
  });

  it("accepts an empty name, which the provider parser emits for a missing name", () => {
    expect(readCatalogToolCall(copyCatalogJson({ ...CALL, name: "" }))?.name).toBe("");
  });

  it.each([
    ["an extra key", { ...CALL, extra: 1 }],
    ["a bound invocation", BOUND],
    ["no arguments", { id: "call-1", name: "read_file" }],
    ["a numeric id", { ...CALL, id: 7 }],
    ["a null name", { ...CALL, name: null }],
    ["array arguments", { ...CALL, arguments: ["a.txt"] }],
    ["null arguments", { ...CALL, arguments: null }],
    ["string arguments", { ...CALL, arguments: "{}" }],
  ])("returns undefined for %s", (_label, value) => {
    expect(readCatalogToolCall(copyCatalogJson(value))).toBeUndefined();
  });

  it.each([
    ["an array", [CALL]],
    ["a string", "call"],
    ["null", null],
  ])("returns undefined for %s", (_label, value) => {
    expect(readCatalogToolCall(copyCatalogJson(value))).toBeUndefined();
  });
});

describe("readBoundCatalogToolCall", () => {
  it("reads an exact bound call and keeps the copy's key order", () => {
    const copy = copyCatalogJson(BOUND);
    const call = readBoundCatalogToolCall(copy);
    expect(call).toEqual(BOUND);
    expect(JSON.stringify(call)).toBe(JSON.stringify(copy));
  });

  it.each([
    ["no invocation", CALL],
    ["an extra key", { ...BOUND, extra: 1 }],
    ["string arguments", { ...BOUND, arguments: "{}" }],
    ["a numeric name", { ...BOUND, name: 3 }],
  ])("returns undefined for %s", (_label, value) => {
    expect(readBoundCatalogToolCall(copyCatalogJson(value))).toBeUndefined();
  });
});

describe("isCatalogJsonArray", () => {
  it("separates arrays from objects and scalars", () => {
    expect(isCatalogJsonArray(copyCatalogJson([1]))).toBe(true);
    expect(isCatalogJsonArray(copyCatalogJson({ 0: 1 }))).toBe(false);
    expect(isCatalogJsonArray(undefined)).toBe(false);
  });
});
