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

  it("returns false when a single embedded NUL appears in otherwise textual content", () => {
    const bytes = new Uint8Array(64);
    bytes.fill(0x41);
    bytes[3] = 0;
    expect(looksBinary(bytes)).toBe(false);
  });

  it("does not classify a sparse NUL at byte 511 as binary", () => {
    const bytes = new Uint8Array(512);
    bytes.fill(0x41);
    bytes[511] = 0;
    expect(looksBinary(bytes)).toBe(false);
  });

  it("does not classify a sparse NUL at byte 600 as binary", () => {
    const bytes = new Uint8Array(800);
    bytes.fill(0x41);
    bytes[600] = 0;
    expect(looksBinary(bytes)).toBe(false);
  });

  it("still treats dense control bytes as binary", () => {
    const bytes = new Uint8Array(100);
    bytes.fill(0x41);
    for (let i = 0; i < 9; i += 1) {
      bytes[i] = 0;
    }
    expect(looksBinary(bytes)).toBe(true);
  });

  it("applies the control-byte ratio only inside the configured probe", () => {
    const bytes = new Uint8Array(800);
    bytes.fill(0x41);
    for (let i = 600; i < 700; i += 1) {
      bytes[i] = 0;
    }
    expect(looksBinary(bytes, { maxProbeBytes: 512 })).toBe(false);
    expect(looksBinary(bytes, { maxProbeBytes: 700 })).toBe(true);
  });

  it("returns true for an all-NUL buffer", () => {
    expect(looksBinary(new Uint8Array(16))).toBe(true);
  });

  it("respects a probe smaller than the buffer length", () => {
    const bytes = new Uint8Array(20);
    bytes.fill(0x41);
    for (let i = 12; i < 20; i += 1) {
      bytes[i] = 0;
    }
    expect(looksBinary(bytes, { maxProbeBytes: 8 })).toBe(false);
    expect(looksBinary(bytes, { maxProbeBytes: 16 })).toBe(true);
  });

  it("exposes a frozen default probe of 4096 bytes", () => {
    expect(DEFAULT_BINARY_PROBE.maxProbeBytes).toBe(4096);
  });

  it("treats UTF-16LE text with BOM as text despite NUL bytes", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x63, 0x00, 0x6c, 0x00, 0x61, 0x00, 0x73, 0x00]);
    expect(looksBinary(bytes)).toBe(false);
  });

  it("treats UTF-16LE-shaped text without BOM as text", () => {
    const bytes = new Uint8Array([0x63, 0x00, 0x6c, 0x00, 0x61, 0x00, 0x73, 0x00, 0x73, 0x00]);
    expect(looksBinary(bytes)).toBe(false);
  });
});
