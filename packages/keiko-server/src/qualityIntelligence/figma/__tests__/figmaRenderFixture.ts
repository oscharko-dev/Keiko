import { crc32, deflateSync } from "node:zlib";

function chunk(name: string, data: Uint8Array): Buffer {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length);
  bytes.write(name, 4, "ascii");
  bytes.set(data, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
  return bytes;
}

/** Synthetic grayscale image with one pixel and deterministic compressed bytes. */
export function fixturePng(pixel = 0): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.writeUInt8(8, 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Uint8Array.of(0, pixel))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Valid PNG padded with an ancillary text chunk so its total size is at least `minBytes`. */
export function fixturePngOfSize(minBytes: number, pixel = 0): Buffer {
  const base = fixturePng(pixel);
  const padLength = Math.max(0, minBytes - base.length - 12);
  const iend = base.subarray(base.length - 12);
  const beforeIend = base.subarray(0, base.length - 12);
  return Buffer.concat([beforeIend, chunk("tEXt", Buffer.alloc(padLength, 0x61)), iend]);
}
