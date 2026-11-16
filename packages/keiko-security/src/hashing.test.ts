import { describe, expect, it } from "vitest";
import { canonicalise as sharedCanonicalise } from "@oscharko-dev/keiko-contracts/runtime/canonical-json";
import { canonicalise, sha256Base64, sha256Hex } from "./hashing.js";

describe("canonicalise", () => {
  it("preserves the Security API as the exact browser-safe Contracts function", () => {
    expect(canonicalise).toBe(sharedCanonicalise);
    const value = { z: [undefined, { b: "ü", a: 1 }], "2": true, "10": null, omitted: undefined };
    expect(canonicalise(value)).toBe('{"10":null,"2":true,"z":[null,{"a":1,"b":"ü"}]}');
  });

  it("sorts object keys recursively", () => {
    expect(canonicalise({ b: 1, a: 2 })).toBe(`{"a":2,"b":1}`);
    expect(canonicalise({ outer: { z: 1, a: 2 } })).toBe(`{"outer":{"a":2,"z":1}}`);
  });

  it("preserves array order", () => {
    expect(canonicalise([3, 1, 2])).toBe("[3,1,2]");
  });

  it("omits undefined object values (JSON.stringify semantics)", () => {
    expect(canonicalise({ a: 1, b: undefined })).toBe(`{"a":1}`);
  });

  it("serialises bare undefined to 'null' (so it never crashes a top-level call)", () => {
    expect(canonicalise(undefined)).toBe("null");
  });

  it("renders primitives via JSON.stringify", () => {
    expect(canonicalise(null)).toBe("null");
    expect(canonicalise(0)).toBe("0");
    expect(canonicalise("x")).toBe(`"x"`);
    expect(canonicalise(true)).toBe("true");
  });

  it("produces byte-identical output for two structurally equal objects with different key order", () => {
    const left = { a: { c: 1, b: 2 }, x: [1, 2] };
    const right = { x: [1, 2], a: { b: 2, c: 1 } };
    expect(canonicalise(left)).toBe(canonicalise(right));
  });
});

describe("sha256Hex", () => {
  it("hashes a known string to its published SHA-256 hex digest", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("returns 64 hex characters", () => {
    expect(sha256Hex("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sha256Base64", () => {
  it("hashes 'abc' to the SHA-256 base64 digest", () => {
    expect(sha256Base64("abc")).toBe("ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
  });

  it("returns the same hash for the same input on every call", () => {
    const input = "deterministic-input";
    expect(sha256Base64(input)).toBe(sha256Base64(input));
  });
});

it.each([
  new Date(0),
  new Map([["a", 1]]),
  new Set([1]),
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  (): undefined => undefined,
  Symbol("synthetic"),
  1n,
])("refuses unsupported canonical digest inputs instead of lossy JSON projection: %s", (value) => {
  expect(() => canonicalise(value)).toThrow(TypeError);
  expect(() => canonicalise({ nested: value })).toThrow(TypeError);
  expect(() => canonicalise([value])).toThrow(TypeError);
});

it("rejects cycles and accessors without executing caller code", () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(() => canonicalise(cyclic)).toThrow(TypeError);
  let reads = 0;
  const accessor = Object.defineProperty({}, "synthetic", {
    enumerable: true,
    get: (): string => {
      reads++;
      return "secret";
    },
  });
  expect(() => canonicalise(accessor)).toThrow(TypeError);
  expect(reads).toBe(0);
  expect(() => canonicalise({ [Symbol("synthetic")]: 1 })).toThrow(TypeError);
});

it("preserves JSON normalization and permits repeated acyclic data references", () => {
  const shared = { z: 1, a: undefined };
  expect(canonicalise([shared, shared, -0, undefined])).toBe('[{"z":1},{"z":1},0,null]');
  expect(canonicalise(new Array(2))).toBe("[null,null]");
});
