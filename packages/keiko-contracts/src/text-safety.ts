// Shared text-safety primitive (Epic #177/#189 grounding hardening, GRD-001).
//
// Removes Unicode code points that are invisible or that can reorder a display surface's
// reading order ("Trojan-source" class) plus C0/C1/DEL control characters. Untrusted
// repository / document evidence flows into (a) the LLM prompt — where reordered or hidden
// instructions can subvert the answer — and (b) the browser-rendered answer/citation wire —
// where React escapes HTML but NOT bidi reordering. Stripping at the surface chokepoints
// (excerpt → prompt/wire) neutralises both without touching persisted offsets.
//
// Whitespace policy: TAB (U+0009), LF (U+000A), and CR (U+000D) are preserved so legitimate
// formatting of evidence survives; every other control code point is removed.
//
// This lives in keiko-contracts (the base layer) so both keiko-local-knowledge and
// keiko-server can compose it; it mirrors the QI-domain `stripUnsafeFormatChars` without
// creating a dependency on the QI package.

const POSIX_ABSOLUTE_PATH_PATTERN =
  /(^|[^A-Za-z0-9._~:/-])\/(?!\/)(?=[^\n\r"'`<>]*\/)[^\n\r"'`<>]+/gu;
const WINDOWS_DRIVE_ABSOLUTE_PATH_PATTERN =
  /(^|[^A-Za-z0-9._~:/-])[A-Za-z]:[\\/](?=[^\n\r"'`<>]*[\\/])[^\n\r"'`<>]+/gu;
const WINDOWS_UNC_ABSOLUTE_PATH_PATTERN =
  /(^|[^A-Za-z0-9._~:/-])(?:\\\\|\/\/)(?=[^\n\r"'`<>]*[\\/])[^\n\r"'`<>]+/gu;
const CHAT_ROLE_MARKERS = ["user", "assistant", "system"] as const;

// True for an invisible / text-reordering code point: bidi override/embedding/isolate,
// zero-width joiners, BOM, LRM/RLM, the Arabic letter mark, and the U+2060..U+206F block
// (word joiner, invisible math operators, and the deprecated format characters). The last
// range makes this canonical stripper a true superset of the keiko-tools git-ref sanitizer
// (GEN-DUP-NEAR-003 case B); it is additive — it can only remove more. Numeric scan keeps the
// set auditable and avoids embedding invisible literals in the source.
function isBidiOrZeroWidthCodePoint(cp: number): boolean {
  return (
    cp === 0x061c ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

// True for a C0 control (0x00–0x1F) or DEL/C1 control (0x7F–0x9F), EXCEPT TAB/LF/CR which
// are legitimate whitespace and preserved.
function isStrippableControlCodePoint(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
}

/**
 * Remove Unicode bidi/zero-width/BOM/format spoofing code points and C0/C1/DEL control
 * characters from `value`, preserving TAB/LF/CR. Pure; returns the input unchanged (a no-op,
 * byte-identical) when it contains no unsafe code points.
 */
export function stripUnsafeFormatChars(value: string): string {
  // Fast path: scan once; only allocate a rebuilt string if something must be removed.
  let needsStrip = false;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isBidiOrZeroWidthCodePoint(cp) || isStrippableControlCodePoint(cp)) {
      needsStrip = true;
      break;
    }
  }
  if (!needsStrip) return value;
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isBidiOrZeroWidthCodePoint(cp) || isStrippableControlCodePoint(cp)) continue;
    out += ch;
  }
  return out;
}

/**
 * Redact filesystem-looking absolute paths, including paths whose directory names contain spaces.
 * This intentionally favours over-redaction after an absolute path over leaking a private path tail.
 */
export function redactAbsolutePaths(value: string): string {
  return value
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, (_match, prefix: string) => `${prefix}[REDACTED_PATH]`)
    .replace(
      WINDOWS_DRIVE_ABSOLUTE_PATH_PATTERN,
      (_match, prefix: string) => `${prefix}[REDACTED_PATH]`,
    )
    .replace(
      WINDOWS_UNC_ABSOLUTE_PATH_PATTERN,
      (_match, prefix: string) => `${prefix}[REDACTED_PATH]`,
    );
}

export function containsAbsolutePath(value: string): boolean {
  return redactAbsolutePaths(value) !== value;
}

export function containsPseudoRoleMarker(value: string): boolean {
  let lineStart = 0;
  for (let cursor = 0; cursor <= value.length; cursor += 1) {
    const isLineEnd = cursor === value.length || value[cursor] === "\n" || value[cursor] === "\r";
    if (!isLineEnd) continue;
    if (lineContainsPseudoRoleMarker(value, lineStart, cursor)) return true;
    if (value[cursor] === "\r" && value[cursor + 1] === "\n") cursor += 1;
    lineStart = cursor + 1;
  }
  return false;
}

function lineContainsPseudoRoleMarker(value: string, start: number, end: number): boolean {
  let cursor = skipInlineWhitespace(value, start, end);
  if (hasDirectRoleMarker(value, cursor, end)) return true;
  if (!startsWithAsciiInsensitive(value, cursor, end, "role")) return false;

  cursor = skipInlineWhitespace(value, cursor + "role".length, end);
  if (cursor >= end || value[cursor] !== ":") return false;
  cursor = skipInlineWhitespace(value, cursor + 1, end);

  return CHAT_ROLE_MARKERS.some(
    (role) =>
      startsWithAsciiInsensitive(value, cursor, end, role) &&
      hasAsciiWordBoundary(value, cursor + role.length, end),
  );
}

function hasDirectRoleMarker(value: string, start: number, end: number): boolean {
  return CHAT_ROLE_MARKERS.some((role) => {
    if (!startsWithAsciiInsensitive(value, start, end, role)) return false;
    const cursor = skipInlineWhitespace(value, start + role.length, end);
    return cursor < end && value[cursor] === ":";
  });
}

function skipInlineWhitespace(value: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end) {
    const ch = value[cursor];
    if (ch !== " " && ch !== "\t" && ch !== "\f" && ch !== "\v") break;
    cursor += 1;
  }
  return cursor;
}

function startsWithAsciiInsensitive(
  value: string,
  start: number,
  end: number,
  prefix: string,
): boolean {
  if (start + prefix.length > end) return false;
  return value.slice(start, start + prefix.length).toLowerCase() === prefix;
}

function hasAsciiWordBoundary(value: string, cursor: number, end: number): boolean {
  if (cursor >= end) return true;
  const code = value.charCodeAt(cursor);
  return (
    !(code >= 48 && code <= 57) &&
    !(code >= 65 && code <= 90) &&
    code !== 95 &&
    !(code >= 97 && code <= 122)
  );
}
