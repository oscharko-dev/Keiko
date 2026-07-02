// Binary/text classifier for repository search. UTF-16/UTF-32 BOMs and the common alternating-NUL
// UTF-16 shape are treated as text; otherwise a bounded control-byte ratio is used instead of a
// first-NUL shortcut so Windows/.NET source is not silently dropped.

export interface BinaryProbeOptions {
  readonly maxProbeBytes: number;
}

export const DEFAULT_BINARY_PROBE: BinaryProbeOptions = {
  maxProbeBytes: 4096,
} as const;

const UNICODE_TEXT_BOMS: readonly (readonly number[])[] = [
  [0xff, 0xfe],
  [0xfe, 0xff],
  [0xff, 0xfe, 0x00, 0x00],
  [0x00, 0x00, 0xfe, 0xff],
] as const;
const BINARY_CONTROL_BYTE_RATIO = 0.08;

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function hasUnicodeTextBom(bytes: Uint8Array): boolean {
  return UNICODE_TEXT_BOMS.some(
    (prefix) => bytes.length >= prefix.length && startsWithBytes(bytes, prefix),
  );
}

function looksLikeUtf16WithoutBom(bytes: Uint8Array, limit: number): boolean {
  if (limit < 8) {
    return false;
  }
  let evenNuls = 0;
  let oddNuls = 0;
  let pairs = 0;
  for (let i = 0; i + 1 < limit; i += 2) {
    pairs += 1;
    if (bytes[i] === 0x00) evenNuls += 1;
    if (bytes[i + 1] === 0x00) oddNuls += 1;
  }
  const evenRatio = evenNuls / pairs;
  const oddRatio = oddNuls / pairs;
  if (evenRatio > 0.3 && oddRatio > 0.3) {
    return false;
  }
  return evenRatio > 0.6 || oddRatio > 0.6;
}

function isSuspiciousControl(byte: number): boolean {
  return byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c;
}

function controlByteRatio(bytes: Uint8Array, limit: number): number {
  let controlBytes = 0;
  for (let i = 0; i < limit; i += 1) {
    const byte = bytes[i] ?? 0;
    if (isSuspiciousControl(byte)) {
      controlBytes += 1;
    }
  }
  return controlBytes / limit;
}

export function looksBinary(bytes: Uint8Array, options?: BinaryProbeOptions): boolean {
  const limit = Math.min(
    bytes.length,
    options?.maxProbeBytes ?? DEFAULT_BINARY_PROBE.maxProbeBytes,
  );
  if (limit === 0 || hasUnicodeTextBom(bytes) || looksLikeUtf16WithoutBom(bytes, limit)) {
    return false;
  }
  return controlByteRatio(bytes, limit) > BINARY_CONTROL_BYTE_RATIO;
}
