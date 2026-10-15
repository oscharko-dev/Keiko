// Shared character-reference decoding for admitted document text; never executes markup.

// GRD-027: decode an XML numeric character reference body (the part between `&#` and `;`),
// e.g. "8217" (decimal) or "xE9" / "x2019" (hex). Returns undefined for malformed or
// out-of-range references (incl. surrogates) so the caller leaves the literal text intact —
// String.fromCodePoint throws on those, which must never crash the parser.
// Valid Unicode scalar value: in range and not a lone surrogate (String.fromCodePoint throws
// on surrogates / out-of-range).
function isValidScalarCodePoint(cp: number): boolean {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return false;
  return cp < 0xd800 || cp > 0xdfff;
}

function decodeNumericCharacterReference(body: string): string | undefined {
  const isHex = body.startsWith("x") || body.startsWith("X");
  const digits = isHex ? body.slice(1) : body;
  if (digits.length === 0) return undefined;
  if (!(isHex ? /^[0-9a-fA-F]+$/ : /^\d+$/).test(digits)) return undefined;
  const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
  return isValidScalarCodePoint(codePoint) ? String.fromCodePoint(codePoint) : undefined;
}

// Shared OOXML/HTML entity decoder for docx/xlsx text runs. Decodes numeric references first
// (decimal `&#8217;` and hex `&#xE9;` — smart quotes, accents), then the five named refs, with
// `&amp;` LAST so an escaped ampersand (`&amp;#65;`) is not re-interpreted as a numeric ref.
export function decodeXmlEntities(value: string): string {
  const withNumeric = value.replace(
    /&#(x?[0-9a-fA-F]+);/g,
    (match: string, body: string): string => decodeNumericCharacterReference(body) ?? match,
  );
  return withNumeric
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
