import { crc32 } from "node:zlib";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = 0x49484452;
const IDAT = 0x49444154;
const IEND = 0x49454e44;
const HEADER_LENGTH = 13;
const CHUNK_OVERHEAD = 12;
const MAX_FIGMA_RENDER_PIXELS = 32 * 1024 * 1024;
export const MIN_FIGMA_PNG_BYTES = PNG_SIGNATURE.length + HEADER_LENGTH + CHUNK_OVERHEAD * 3;

const MAX_PNG_DIMENSION = 0x7fffffff;
// Legal IHDR bit depths per colour type (PNG specification, table 11.1).
const LEGAL_BIT_DEPTHS: ReadonlyMap<number, ReadonlySet<number>> = new Map([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);

function hasLegalHeaderFields(data: DataView, offset: number): boolean {
  const bitDepth = data.getUint8(offset + 16);
  const colorType = data.getUint8(offset + 17);
  const compression = data.getUint8(offset + 18);
  const filter = data.getUint8(offset + 19);
  const interlace = data.getUint8(offset + 20);
  return (
    LEGAL_BIT_DEPTHS.get(colorType)?.has(bitDepth) === true &&
    compression === 0 &&
    filter === 0 &&
    (interlace === 0 || interlace === 1)
  );
}

function hasValidPngHeader(data: DataView): boolean {
  const offset = PNG_SIGNATURE.length;
  if (data.getUint32(offset) !== HEADER_LENGTH || data.getUint32(offset + 4) !== IHDR) return false;
  const width = data.getUint32(offset + 8);
  const height = data.getUint32(offset + 12);
  return (
    width > 0 &&
    height > 0 &&
    width <= MAX_PNG_DIMENSION &&
    height <= MAX_PNG_DIMENSION &&
    width * height <= MAX_FIGMA_RENDER_PIXELS &&
    hasLegalHeaderFields(data, offset)
  );
}

function hasValidPngChunks(data: DataView, bytes: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.length;
  let hasImageData = false;
  while (offset + CHUNK_OVERHEAD <= bytes.length) {
    const length = data.getUint32(offset);
    const type = data.getUint32(offset + 4);
    const end = offset + length + CHUNK_OVERHEAD;
    if (
      end > bytes.length ||
      data.getUint32(end - 4) !== crc32(bytes.subarray(offset + 4, end - 4))
    ) {
      return false;
    }
    if (type === IEND) return hasImageData && length === 0 && end === bytes.length;
    if (type === IDAT && length > 0) hasImageData = true;
    offset = end;
  }
  return false;
}

/** Check PNG framing and checksums without decompressing provider-supplied image data. */
export function isFigmaRenderPng(bytes: Uint8Array): boolean {
  if (bytes.length < MIN_FIGMA_PNG_BYTES) return false;
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return false;

  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return hasValidPngHeader(data) && hasValidPngChunks(data, bytes);
}
