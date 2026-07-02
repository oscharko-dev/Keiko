// UTF-aware text/binary probe for repository source and document extraction. The old "any NUL
// byte means binary" rule rejected UTF-16 source files, so this module now sniffs BOM/patterned
// UTF-16 first and then falls back to a bounded control-byte ratio. Pure synchronous scan — no IO.

export interface BinaryProbeOptions {
  readonly maxProbeBytes: number;
}

export const DEFAULT_BINARY_PROBE: BinaryProbeOptions = {
  maxProbeBytes: 4096,
} as const;

export type TextByteEncoding = "utf-8" | "utf-16le" | "utf-16be";

export interface DecodedTextBytes {
  readonly encoding: TextByteEncoding;
  readonly text: string;
}

export interface DecodeTextBytesOptions {
  readonly allowIncompleteTail?: boolean | undefined;
}

function probeLimit(bytes: Uint8Array, options?: BinaryProbeOptions): number {
  return Math.min(bytes.length, options?.maxProbeBytes ?? DEFAULT_BINARY_PROBE.maxProbeBytes);
}

function hasUtf16LeBom(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
}

function hasUtf16BeBom(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
}

function isTextLikeByte(byte: number): boolean {
  return byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127);
}

interface Utf16PatternCounts {
  readonly pairCount: number;
  readonly leMatches: number;
  readonly beMatches: number;
}

function utf16PatternCounts(bytes: Uint8Array, limit: number): Utf16PatternCounts {
  const pairCount = Math.floor(limit / 2);
  let leMatches = 0;
  let beMatches = 0;
  for (let i = 0; i + 1 < limit; i += 2) {
    const first = bytes[i] ?? 0;
    const second = bytes[i + 1] ?? 0;
    if (second === 0 && first !== 0 && isTextLikeByte(first)) {
      leMatches += 1;
    }
    if (first === 0 && second !== 0 && isTextLikeByte(second)) {
      beMatches += 1;
    }
  }
  return { pairCount, leMatches, beMatches };
}

function utf16PatternEncoding(bytes: Uint8Array, limit: number): TextByteEncoding | undefined {
  const counts = utf16PatternCounts(bytes, limit);
  if (counts.pairCount < 2) {
    return undefined;
  }
  const threshold = Math.max(2, Math.ceil(counts.pairCount * 0.6));
  if (counts.leMatches >= threshold && counts.leMatches > counts.beMatches) {
    return "utf-16le";
  }
  if (counts.beMatches >= threshold && counts.beMatches > counts.leMatches) {
    return "utf-16be";
  }
  return undefined;
}

export function detectTextByteEncoding(
  bytes: Uint8Array,
  options?: BinaryProbeOptions,
): TextByteEncoding | undefined {
  if (hasUtf16LeBom(bytes)) {
    return "utf-16le";
  }
  if (hasUtf16BeBom(bytes)) {
    return "utf-16be";
  }
  const limit = probeLimit(bytes, options);
  return utf16PatternEncoding(bytes, limit);
}

function utf8LeadByteSeqLen(lead: number): number {
  if ((lead & 0x80) === 0x00) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 0;
}

function validUtf8PrefixLength(bytes: Uint8Array): number {
  const len = bytes.length;
  if (len === 0) return 0;
  let i = len - 1;
  const limit = Math.max(len - 4, -1);
  while (i > limit && ((bytes[i] ?? 0) & 0xc0) === 0x80) {
    i -= 1;
  }
  const seqLen = utf8LeadByteSeqLen(bytes[i] ?? 0);
  if (seqLen === 0) return i;
  return i + seqLen <= len ? len : i;
}

export function completeTextBytePrefix(bytes: Uint8Array, encoding: TextByteEncoding): Uint8Array {
  if (encoding === "utf-8") {
    return bytes.subarray(0, validUtf8PrefixLength(bytes));
  }
  return bytes.subarray(0, bytes.length - (bytes.length % 2));
}

export function decodeTextBytes(
  bytes: Uint8Array,
  encoding: TextByteEncoding = detectTextByteEncoding(bytes) ?? "utf-8",
  options?: DecodeTextBytesOptions,
): DecodedTextBytes | undefined {
  const complete =
    options?.allowIncompleteTail === true ? completeTextBytePrefix(bytes, encoding) : bytes;
  try {
    return {
      encoding,
      text: new TextDecoder(encoding, { fatal: true }).decode(complete),
    };
  } catch {
    return undefined;
  }
}

function isAllowedControlByte(byte: number): boolean {
  return byte === 9 || byte === 10 || byte === 13;
}

export function looksBinary(bytes: Uint8Array, options?: BinaryProbeOptions): boolean {
  const limit = probeLimit(bytes, options);
  if (limit === 0) {
    return false;
  }
  if (detectTextByteEncoding(bytes, options) !== undefined) {
    return false;
  }
  let nulCount = 0;
  let controlCount = 0;
  for (let i = 0; i < limit; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte === 0) {
      nulCount += 1;
      controlCount += 1;
    } else if (byte < 32 && !isAllowedControlByte(byte)) {
      controlCount += 1;
    }
  }
  return (nulCount > 1 && nulCount / limit > 0.02) || controlCount / limit > 0.3;
}
