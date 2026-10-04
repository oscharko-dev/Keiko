// UTF-aware text/binary probe for repository source and document extraction. The old "any NUL
// byte means binary" rule rejected UTF-16 source files, so this module now sniffs BOM/patterned
// UTF-16 first and then falls back to a bounded control-byte ratio. Pure synchronous scan — no IO.

import { WorkspaceReadError } from "@oscharko-dev/keiko-security/errors/workspace";

export interface BinaryProbeOptions {
  readonly maxProbeBytes: number;
}

export const DEFAULT_BINARY_PROBE: BinaryProbeOptions = {
  maxProbeBytes: 4096,
} as const;

// Canonical codec names are obtained from the platform decoder, never guessed from arbitrary bytes.
export type TextByteEncoding = TextDecoder["encoding"];

export interface DecodedTextBytes {
  readonly encoding: TextByteEncoding;
  readonly text: string;
}

export interface DecodeTextBytesOptions {
  readonly scopePath?: string | undefined;
  readonly allowIncompleteTail?: boolean | undefined;
  readonly requireSupportedEncoding?: boolean | undefined;
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
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (hasUtf16LeBom(bytes)) {
    return "utf-16le";
  }
  if (hasUtf16BeBom(bytes)) {
    return "utf-16be";
  }
  const limit = probeLimit(bytes, options);
  return utf16PatternEncoding(bytes, limit);
}

interface HtmlAttributeCursor {
  readonly tag: string;
  offset: number;
}

function skipHtmlAttributeSeparators(cursor: HtmlAttributeCursor, slash = false): void {
  const separator = slash ? /[\t\n\f\r /]/u : /[\t\n\f\r ]/u;
  while (cursor.offset < cursor.tag.length && separator.test(cursor.tag.charAt(cursor.offset)))
    cursor.offset += 1;
}

function htmlAttributeName(cursor: HtmlAttributeCursor): string {
  const start = cursor.offset;
  while (
    cursor.offset < cursor.tag.length &&
    !/[\t\n\f\r />=]/u.test(cursor.tag.charAt(cursor.offset))
  )
    cursor.offset += 1;
  return cursor.tag.slice(start, cursor.offset).toLowerCase();
}

function htmlAttributeValue(cursor: HtmlAttributeCursor): string | undefined {
  skipHtmlAttributeSeparators(cursor);
  const quote = cursor.tag.charAt(cursor.offset);
  if (quote === '"' || quote === "'") {
    const start = cursor.offset + 1;
    const end = cursor.tag.indexOf(quote, start);
    cursor.offset = end < 0 ? cursor.tag.length : end + 1;
    return end < 0 ? undefined : cursor.tag.slice(start, end);
  }
  const start = cursor.offset;
  while (
    cursor.offset < cursor.tag.length &&
    !/[\t\n\f\r >]/u.test(cursor.tag.charAt(cursor.offset))
  )
    cursor.offset += 1;
  // Preserve the existing compact self-closing declaration tolerance only at the tag terminator.
  // Interior slashes belong to the unquoted value, including text/html in http-equiv content.
  const end =
    cursor.tag.charAt(cursor.offset) === ">" && cursor.tag.charAt(cursor.offset - 1) === "/"
      ? cursor.offset - 1
      : cursor.offset;
  return end === start ? undefined : cursor.tag.slice(start, end);
}

function htmlMetaTagEnd(prefix: string, offset: number): number | undefined {
  const cursor = { tag: prefix, offset };
  while (cursor.offset < prefix.length) {
    skipHtmlAttributeSeparators(cursor, true);
    if (prefix.charAt(cursor.offset) === ">") return cursor.offset + 1;
    const name = htmlAttributeName(cursor);
    skipHtmlAttributeSeparators(cursor);
    if (prefix.charAt(cursor.offset) === "=") {
      cursor.offset += 1;
      htmlAttributeValue(cursor);
    } else if (name === "") cursor.offset += 1;
  }
  return undefined;
}

function* htmlMetaTags(prefix: string): Generator<string> {
  const folded = prefix.toLowerCase();
  let offset = 0;
  while (offset < prefix.length) {
    const start = folded.indexOf("<meta", offset);
    if (start < 0) return;
    offset = start + 5;
    if (!/[\t\n\f\r />]/u.test(prefix.charAt(offset))) continue;
    const end = htmlMetaTagEnd(prefix, offset);
    if (end === undefined) return;
    offset = end;
    yield prefix.slice(start, end);
  }
}

function htmlMetaAttributes(tag: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  const cursor = { tag, offset: 5 };
  while (cursor.offset < tag.length) {
    skipHtmlAttributeSeparators(cursor, true);
    if (tag.charAt(cursor.offset) === ">") break;
    const name = htmlAttributeName(cursor);
    skipHtmlAttributeSeparators(cursor);
    if (tag.charAt(cursor.offset) !== "=") {
      if (name === "") cursor.offset += 1;
      continue;
    }
    cursor.offset += 1;
    const value = htmlAttributeValue(cursor);
    if (name !== "" && value !== undefined && !attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

function htmlMetaCharset(tag: string): string | undefined {
  const attributes = htmlMetaAttributes(tag);
  const direct = attributes.get("charset");
  if (direct !== undefined) return direct;
  if (attributes.get("http-equiv")?.toLowerCase() !== "content-type") return undefined;
  return /\bcharset\s*=\s*([a-z0-9_-]+)/iu.exec(attributes.get("content") ?? "")?.[1];
}

function supportedDeclaredHtmlEncoding(charset: string): TextByteEncoding | false {
  try {
    return new TextDecoder(charset, { fatal: true }).encoding;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function declaredHtmlEncoding(
  bytes: Uint8Array,
  scopePath: string | undefined,
): TextByteEncoding | false | undefined {
  if (scopePath === undefined || !/\.(?:html?|xhtml)$/iu.test(scopePath)) return undefined;
  const prefix = new TextDecoder("windows-1252")
    .decode(bytes.subarray(0, 1024))
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, "");
  for (const tag of htmlMetaTags(prefix)) {
    const charset = htmlMetaCharset(tag)?.trim().toLowerCase();
    if (charset === undefined) continue;
    return supportedDeclaredHtmlEncoding(charset);
  }
  return undefined;
}

function selectedTextEncoding(
  bytes: Uint8Array,
  encoding: TextByteEncoding | undefined,
  options: DecodeTextBytesOptions | undefined,
): TextByteEncoding | undefined {
  const selected =
    encoding ??
    detectTextByteEncoding(bytes) ??
    declaredHtmlEncoding(bytes, options?.scopePath) ??
    "utf-8";
  if (selected !== false) return selected;
  if (options?.requireSupportedEncoding === true)
    throw new WorkspaceReadError("declared text encoding is unavailable", options.scopePath ?? "");
  return undefined;
}

export function decodeTextBytes(
  bytes: Uint8Array,
  encoding?: TextByteEncoding,
  options?: DecodeTextBytesOptions,
): DecodedTextBytes | undefined {
  const selected = selectedTextEncoding(bytes, encoding, options);
  if (selected === undefined) return undefined;
  try {
    return {
      encoding: selected,
      text: new TextDecoder(selected, { fatal: true }).decode(bytes, {
        stream: options?.allowIncompleteTail === true,
      }),
    };
  } catch {
    return undefined;
  }
}

function isAllowedControlByte(byte: number): boolean {
  return byte === 9 || byte === 10 || byte === 13;
}

function exceedsBinaryControlThreshold(
  firstByte: number,
  nulCount: number,
  controlCount: number,
  limit: number,
): boolean {
  if (firstByte === 0) {
    return true;
  }
  if (nulCount > 1 && nulCount / limit > 0.02) {
    return true;
  }
  return controlCount / limit > 0.3;
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
  return exceedsBinaryControlThreshold(bytes[0] ?? 0, nulCount, controlCount, limit);
}

function decodedTextLooksBinary(text: string): boolean {
  if (text.length === 0) return false;
  let controls = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index) ?? 0;
    if (code < 32 && !isAllowedControlByte(code)) controls += 1;
  }
  return exceedsBinaryControlThreshold(text.codePointAt(0) ?? 0, 0, controls, text.length);
}

/** Classify the complete, size-admitted file consistently for search and source reads. */
export function decodeTextFileBytes(
  bytes: Uint8Array,
  options?: DecodeTextBytesOptions,
): DecodedTextBytes | undefined {
  const decoded = decodeTextBytes(bytes, undefined, options);
  return decoded === undefined ||
    decoded.text.includes("\0") ||
    decodedTextLooksBinary(decoded.text) ||
    looksBinary(bytes, { maxProbeBytes: bytes.length })
    ? undefined
    : decoded;
}
