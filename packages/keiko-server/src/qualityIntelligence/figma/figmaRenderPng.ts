import { crc32 } from "node:zlib";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = 0x49484452;
const IDAT = 0x49444154;
const IEND = 0x49454e44;
const HEADER_LENGTH = 13;
const CHUNK_OVERHEAD = 12;
const MAX_FIGMA_RENDER_PIXELS = 32 * 1024 * 1024;
export const MIN_FIGMA_PNG_BYTES = PNG_SIGNATURE.length + HEADER_LENGTH + CHUNK_OVERHEAD * 3;

function hasValidPngHeader(data: DataView): boolean {
  const offset = PNG_SIGNATURE.length;
  if (data.getUint32(offset) !== HEADER_LENGTH || data.getUint32(offset + 4) !== IHDR) return false;
  const width = data.getUint32(offset + 8);
  const height = data.getUint32(offset + 12);
  return width > 0 && height > 0 && width * height <= MAX_FIGMA_RENDER_PIXELS;
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
