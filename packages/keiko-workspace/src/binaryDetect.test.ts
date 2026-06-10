import { describe, expect, it } from "vitest";
import { DEFAULT_BINARY_PROBE, looksBinary } from "./binaryDetect.js";

describe("looksBinary", () => {
  it("returns false on empty input", () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });

  it("returns false on a single text byte", () => {
    expect(looksBinary(new TextEncoder().encode("A"))).toBe(false);
  });

  it("returns false on UTF-8 multi-byte content", () => {
    expect(looksBinary(new TextEncoder().encode("é"))).toBe(false);
  });

  it("returns false on plain ASCII text", () => {
    expect(looksBinary(new TextEncoder().encode("hello world\nsecond line\n"))).toBe(false);
  });

  it("returns true when a NUL appears within the default probe range", () => {
    const bytes = new Uint8Array(64);
    bytes[3] = 0;
    expect(looksBinary(bytes)).toBe(true);
  });

  it("returns true when a NUL sits at byte 511 with default options", () => {
    const bytes = new Uint8Array(512);
    bytes.fill(0x41);
    bytes[511] = 0;
    expect(looksBinary(bytes)).toBe(true);
  });

  it("returns false when a NUL sits at byte 600 with default 512-byte probe", () => {
    const bytes = new Uint8Array(800);
    bytes.fill(0x41);
    bytes[600] = 0;
    expect(looksBinary(bytes)).toBe(false);
  });

  it("returns true when the same byte-600 NUL is reached by a 700-byte probe", () => {
    const bytes = new Uint8Array(800);
    bytes.fill(0x41);
    bytes[600] = 0;
    expect(looksBinary(bytes, { maxProbeBytes: 700 })).toBe(true);
  });

  it("returns true for an all-NUL buffer", () => {
    expect(looksBinary(new Uint8Array(16))).toBe(true);
  });

  it("respects a probe smaller than the buffer length", () => {
    const bytes = new Uint8Array(20);
    bytes.fill(0x41);
    bytes[15] = 0;
    expect(looksBinary(bytes, { maxProbeBytes: 8 })).toBe(false);
    expect(looksBinary(bytes, { maxProbeBytes: 16 })).toBe(true);
  });

  it("exposes a frozen default probe of 512 bytes", () => {
    expect(DEFAULT_BINARY_PROBE.maxProbeBytes).toBe(512);
  });
});
