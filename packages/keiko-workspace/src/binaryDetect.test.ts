import { describe, expect, it } from "vitest";
import {
  DEFAULT_BINARY_PROBE,
  decodeTextBytes,
  detectTextByteEncoding,
  looksBinary,
} from "./binaryDetect.js";

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

  it("returns true when NUL/control bytes dominate within the default probe range", () => {
    const bytes = new Uint8Array(64);
    bytes[3] = 0;
    expect(looksBinary(bytes)).toBe(true);
  });

  it("does not classify an otherwise textual file as binary for one embedded NUL", () => {
    const bytes = new Uint8Array(512);
    bytes.fill(0x41);
    bytes[511] = 0;
    expect(looksBinary(bytes)).toBe(false);
  });

  it("returns false when a NUL sits at byte 600 with default 512-byte probe", () => {
    const bytes = new Uint8Array(800);
    bytes.fill(0x41);
    bytes[600] = 0;
    expect(looksBinary(bytes)).toBe(false);
  });

  it("still treats high NUL density beyond the default probe as binary when the probe reaches it", () => {
    const bytes = new Uint8Array(800);
    bytes.fill(0x41);
    bytes.fill(0, 600, 700);
    expect(looksBinary(bytes, { maxProbeBytes: 700 })).toBe(true);
  });

  it("returns true for an all-NUL buffer", () => {
    expect(looksBinary(new Uint8Array(16))).toBe(true);
  });

  it("respects a probe smaller than the buffer length", () => {
    const bytes = new Uint8Array(20);
    bytes.fill(0x41);
    bytes.fill(0, 15, 20);
    expect(looksBinary(bytes, { maxProbeBytes: 8 })).toBe(false);
    expect(looksBinary(bytes, { maxProbeBytes: 16 })).toBe(true);
  });

  it("recognizes UTF-16LE source bytes with a BOM as text", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x65, 0x00, 0x78, 0x00, 0x70, 0x00]);
    expect(detectTextByteEncoding(bytes)).toBe("utf-16le");
    expect(looksBinary(bytes)).toBe(false);
    expect(decodeTextBytes(bytes)?.text).toBe("exp");
  });

  it("recognizes UTF-16BE source bytes without a BOM by NUL parity", () => {
    const bytes = new Uint8Array([0x00, 0x63, 0x00, 0x6c, 0x00, 0x61, 0x00, 0x73, 0x00, 0x73]);
    expect(detectTextByteEncoding(bytes)).toBe("utf-16be");
    expect(looksBinary(bytes)).toBe(false);
    expect(decodeTextBytes(bytes)?.text).toBe("class");
  });

  it("does not trim invalid trailing bytes unless the caller declares a capped read", () => {
    const bytes = new Uint8Array([0x65, 0x78, 0x70, 0xc3]);
    expect(decodeTextBytes(bytes)).toBeUndefined();
    expect(decodeTextBytes(bytes, "utf-8", { allowIncompleteTail: true })?.text).toBe("exp");
  });

  it("exposes a frozen default probe of 512 bytes", () => {
    expect(DEFAULT_BINARY_PROBE.maxProbeBytes).toBe(512);
  });
});
