// Quality Intelligence — untrusted content normalisation (Epic #270, Issue #278).
//
// Pure deterministic primitives that prepare free-text payloads (Figma node text,
// connector document snippets, human-context strings) for safe transit through the
// QI evidence-atom + envelope contracts. No IO. No network. No `node:fs`. No clock
// reads. No randomness. The functions never throw on inputs they choose to clamp —
// callers may layer a typed error on top.
//
// Structurally inspired by Test Intelligence reference (TI) multi-source text
// normalisation pipelines, but rewritten to consume the Keiko contracts surface and
// match the audit-ledger's NFKC + control-char rules already encoded in
// `validateQualityIntelligenceIdString` (@oscharko-dev/keiko-contracts, ids.ts).

const DEFAULT_MAX_BYTES = 64 * 1024;
const CLAMP_SUFFIX = "…";

/** Options governing clamp behaviour. */
export interface NormaliseUntrustedContentOptions {
  /** Maximum UTF-8 byte length to retain. Defaults to 64 KiB. */
  readonly maxBytes?: number;
}

export interface NormaliseUntrustedContentResult {
  readonly value: string;
  readonly clamped: boolean;
  readonly normalisedFromControlChars: boolean;
  readonly markdownInjectionEscapes: number;
}

// Markdown-injection vectors we escape (not strip) so the audit ledger retains the
// surrounding text. Escape with a leading backslash; the rendered text is byte-stable.
const HEADING_LINE = /^(#{1,6})/gmu;
const FENCED_CODE = /```/gu;
const IMAGE_OPEN = /!\[/gu;

const isControlCodePoint = (code: number): boolean => {
  // TAB (0x09), LF (0x0A), and CR (0x0D) are C0 code points but are legitimate
  // text whitespace: stripping them would collapse multi-line content (e.g. a
  // code block or a multi-line document excerpt) into a single run-on line. They
  // must survive normalisation. This mirrors the prompt-boundary scrubber and the
  // single-file binary guard (keiko-server isControlChar), so every layer treats
  // the same code points as text.
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  // C0 controls 0x00–0x1F, DEL 0x7F, C1 controls 0x80–0x9F.
  if (code <= 0x1f) return true;
  if (code === 0x7f) return true;
  if (code >= 0x80 && code <= 0x9f) return true;
  return false;
};

const stripControlCharacters = (value: string): { value: string; stripped: boolean } => {
  let out = "";
  let stripped = false;
  for (let i = 0; i < value.length; i += 1) {
    // `i` is always a valid position (bounded by the loop condition), so
    // `codePointAt` always resolves to a code point here.
    const code = value.codePointAt(i) ?? -1;
    if (isControlCodePoint(code)) {
      stripped = true;
      continue;
    }
    out += value.charAt(i);
  }
  return { value: out, stripped };
};

interface EscapeOutcome {
  readonly value: string;
  readonly count: number;
}

const OPEN_BRACKET = 0x5b; // "["
const CLOSE_BRACKET = 0x5d; // "]"
const OPEN_PAREN = 0x28; // "("
const BANG = 0x21; // "!"

// For every index, the index of the nearest "]" at or after it (or -1 if none remains). Computed
// once with a single backward pass so each "[" lookup below is an O(1) array read instead of a
// fresh forward scan — see `escapeLinkOpens` for why that matters.
function nextCloseBracketIndex(value: string): readonly number[] {
  const table = new Array<number>(value.length + 1).fill(-1);
  for (let idx = value.length - 1; idx >= 0; idx -= 1) {
    table[idx] = value.codePointAt(idx) === CLOSE_BRACKET ? idx : (table[idx + 1] ?? -1);
  }
  return table;
}

function isUnescapedOpenBracket(value: string, index: number): boolean {
  return (
    value.codePointAt(index) === OPEN_BRACKET &&
    (index === 0 || value.codePointAt(index - 1) !== BANG)
  );
}

// Escape a markdown link-open `[text](`, skipping image syntax `![text](` (a "[" preceded by
// "!"). Previously a single regex, `/(?<!!)\[([^\]]*)\]\(/gu`. That pattern's negated class
// `[^\]]*` only has one valid match length per "[" (it must stop at the very next "]"), but an
// unanchored global search retries the full failed match at EVERY "[" when no "]" (or no "]("
// pair) follows nearby — quadratic in input length on content with many unmatched "["
// (SonarCloud S8786, confirmed empirically: ~860ms at 32k characters before the fix). Precomputing
// "the nearest ']' at or after index i" once turns each "[" lookup into an O(1) array read,
// making the whole pass linear regardless of how many brackets are unmatched.
const escapeLinkOpens = (value: string): EscapeOutcome => {
  const nextCloseBracket = nextCloseBracketIndex(value);
  let result = "";
  let count = 0;
  let i = 0;
  while (i < value.length) {
    const closeIdx = isUnescapedOpenBracket(value, i) ? (nextCloseBracket[i + 1] ?? -1) : -1;
    const isLinkOpen = closeIdx !== -1 && value.codePointAt(closeIdx + 1) === OPEN_PAREN;
    if (!isLinkOpen) {
      result += value.charAt(i);
      i += 1;
      continue;
    }
    result += String.raw`\[${value.slice(i + 1, closeIdx)}\](`;
    count += 1;
    i = closeIdx + 2;
  }
  return { value: result, count };
};

const escapeMarkdownInjection = (value: string): EscapeOutcome => {
  let count = 0;
  const headingEscaped = value.replace(HEADING_LINE, (hashes: string): string => {
    count += 1;
    return `\\${hashes}`;
  });
  const codeEscaped = headingEscaped.replaceAll(FENCED_CODE, (): string => {
    count += 1;
    return "\\`\\`\\`";
  });
  const imageEscaped = codeEscaped.replaceAll(IMAGE_OPEN, (): string => {
    count += 1;
    return "\\!\\[";
  });
  const links = escapeLinkOpens(imageEscaped);
  return { value: links.value, count: count + links.count };
};

const clampToBytes = (value: string, maxBytes: number): { value: string; clamped: boolean } => {
  if (maxBytes <= 0) {
    return { value: "", clamped: value.length > 0 };
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) {
    return { value, clamped: false };
  }
  let truncatedBytes = bytes.slice(0, maxBytes);
  // Trim trailing partial UTF-8 sequence (continuation bytes 0x80–0xBF without a starter).
  while (truncatedBytes.length > 0) {
    const last = truncatedBytes[truncatedBytes.length - 1] ?? 0;
    if ((last & 0xc0) === 0x80) {
      truncatedBytes = truncatedBytes.slice(0, -1);
    } else {
      // If this is itself a multi-byte starter (>= 0xC0), drop it too: it has no continuation.
      if (last >= 0xc0) {
        truncatedBytes = truncatedBytes.slice(0, -1);
      }
      break;
    }
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return { value: `${decoder.decode(truncatedBytes)}${CLAMP_SUFFIX}`, clamped: true };
};

/**
 * Normalise an untrusted free-text payload:
 *   1. NFKC normalise.
 *   2. Strip C0/C1/DEL control characters (keeping TAB/LF/CR text whitespace).
 *   3. Escape Markdown-injection vectors (heading, fenced code, image, link).
 *   4. Clamp to `maxBytes` UTF-8 bytes (default 64 KiB).
 *
 * Pure: no IO, no clock, no randomness.
 */
export const normaliseUntrustedContent = (
  raw: string,
  options: NormaliseUntrustedContentOptions = {},
): NormaliseUntrustedContentResult => {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const normalised = raw.normalize("NFKC");
  const stripped = stripControlCharacters(normalised);
  const escaped = escapeMarkdownInjection(stripped.value);
  const clamped = clampToBytes(escaped.value, maxBytes);
  return {
    value: clamped.value,
    clamped: clamped.clamped,
    normalisedFromControlChars: stripped.stripped,
    markdownInjectionEscapes: escaped.count,
  };
};

export const UNTRUSTED_CONTENT_DEFAULT_MAX_BYTES = DEFAULT_MAX_BYTES;
