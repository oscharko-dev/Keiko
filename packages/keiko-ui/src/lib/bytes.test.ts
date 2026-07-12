import { describe, expect, it } from "vitest";

import { decodeBase64ArrayBuffer, toExactArrayBuffer } from "./bytes";

describe("decodeBase64ArrayBuffer", () => {
  it("decodes empty and full-range byte payloads into exact ArrayBuffers", () => {
    expect(new Uint8Array(decodeBase64ArrayBuffer(""))).toEqual(new Uint8Array());
    const expected = Uint8Array.from({ length: 256 }, (_, index) => index);
    const encoded = btoa(String.fromCharCode(...expected));
    expect(new Uint8Array(decodeBase64ArrayBuffer(encoded))).toEqual(expected);
  });

  it("preserves the browser's fail-closed malformed-base64 behavior", () => {
    expect(() => decodeBase64ArrayBuffer("@@@not-base64@@@")).toThrow();
  });
});

describe("toExactArrayBuffer", () => {
  it("copies only the visible view without prefix or suffix bytes", () => {
    const source = Uint8Array.from([99, 1, 2, 3, 88]);
    const result = toExactArrayBuffer(source.subarray(1, 4));
    expect(new Uint8Array(result)).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("returns a detached copy for full and empty views", () => {
    const source = Uint8Array.from([4, 5, 6]);
    const full = toExactArrayBuffer(source);
    const empty = toExactArrayBuffer(source.subarray(2, 2));
    source[0] = 9;
    expect(new Uint8Array(full)).toEqual(Uint8Array.from([4, 5, 6]));
    expect(empty.byteLength).toBe(0);
  });

  it("copies SharedArrayBuffer-backed views into an ArrayBuffer when supported", () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const shared = new SharedArrayBuffer(3);
    const source = new Uint8Array(shared);
    source.set([7, 8, 9]);
    const result = toExactArrayBuffer(source);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(result)).toEqual(Uint8Array.from([7, 8, 9]));
  });
});
