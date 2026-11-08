import { Buffer } from "node:buffer";

/** Decode only the exact encodeURIComponent representation of one UTF-8 segment.
 * This is syntax validation, not admission of a path, entity key or destination.
 * Buffer's nonfatal decoding cannot throw on malformed UTF-8; the round trip
 * rejects replacement decoding while preserving an actually encoded U+FFFD.
 */
export function decodeCanonicalUriSegment(encoded: string | undefined): string | undefined {
  if (encoded === undefined || !/^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-F]{2})*$/u.test(encoded)) return undefined;
  const decoded = encoded.replace(/(?:%[0-9A-F]{2})+/gu, (bytes) =>
    Buffer.from(bytes.replaceAll("%", ""), "hex").toString("utf8"));
  // Unescaped characters are ASCII and Buffer emits well-formed UTF-16, so
  // encodeURIComponent cannot encounter a lone surrogate here.
  return encodeURIComponent(decoded) === encoded ? decoded : undefined;
}
