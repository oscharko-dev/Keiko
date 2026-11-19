import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { isFigmaRenderPng } from "../figmaRenderPng.js";

interface Header {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly compression: number;
  readonly filter: number;
  readonly interlace: number;
}

const LEGAL: Header = {
  width: 1,
  height: 1,
  bitDepth: 8,
  colorType: 0,
  compression: 0,
  filter: 0,
  interlace: 0,
};

function chunk(name: string, data: Uint8Array): Buffer {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length);
  bytes.write(name, 4, "ascii");
  bytes.set(data, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
  return bytes;
}

// A PNG with a valid frame and checksums whose IHDR carries exactly the given field values.
function pngWith(header: Header): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(header.width, 0);
  ihdr.writeUInt32BE(header.height, 4);
  ihdr.writeUInt8(header.bitDepth, 8);
  ihdr.writeUInt8(header.colorType, 9);
  ihdr.writeUInt8(header.compression, 10);
  ihdr.writeUInt8(header.filter, 11);
  ihdr.writeUInt8(header.interlace, 12);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Uint8Array.of(0, 0))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const LEGAL_COMBINATIONS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [0, 4],
  [0, 8],
  [0, 16],
  [2, 8],
  [2, 16],
  [3, 1],
  [3, 2],
  [3, 4],
  [3, 8],
  [4, 8],
  [4, 16],
  [6, 8],
  [6, 16],
];

describe("isFigmaRenderPng IHDR fields", () => {
  it("accepts the legal control", () => {
    expect(isFigmaRenderPng(pngWith(LEGAL))).toBe(true);
  });

  it.each(LEGAL_COMBINATIONS)("accepts color type %i with bit depth %i", (colorType, bitDepth) => {
    expect(isFigmaRenderPng(pngWith({ ...LEGAL, colorType, bitDepth }))).toBe(true);
  });

  it.each([
    [0, 0],
    [0, 3],
    [2, 1],
    [2, 4],
    [3, 16],
    [4, 4],
    [6, 2],
    [1, 8],
    [5, 8],
    [7, 8],
    [0, 255],
  ])("rejects color type %i with bit depth %i", (colorType, bitDepth) => {
    expect(isFigmaRenderPng(pngWith({ ...LEGAL, colorType, bitDepth }))).toBe(false);
  });

  it.each([
    ["compression method", { compression: 1 }],
    ["filter method", { filter: 1 }],
    ["interlace method", { interlace: 2 }],
    ["zero width", { width: 0 }],
    ["zero height", { height: 0 }],
    ["width above 2^31-1", { width: 0x80000000 }],
    ["height above 2^31-1", { height: 0x80000000 }],
  ] satisfies readonly (readonly [string, Partial<Header>])[])(
    "rejects an illegal %s",
    (_name, override) => {
      expect(isFigmaRenderPng(pngWith({ ...LEGAL, ...override }))).toBe(false);
    },
  );

  it("accepts Adam7 interlacing", () => {
    expect(isFigmaRenderPng(pngWith({ ...LEGAL, interlace: 1 }))).toBe(true);
  });
});
