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
const LINK_OPEN = /(?<!!)\[([^\]]*)\]\(/gu;

const isControlCodePoint = (code: number): boolean => {
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
    const code = value.charCodeAt(i);
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

const escapeMarkdownInjection = (value: string): EscapeOutcome => {
  let count = 0;
  const headingEscaped = value.replace(HEADING_LINE, (hashes: string): string => {
    count += 1;
    return `\\${hashes}`;
  });
  const codeEscaped = headingEscaped.replace(FENCED_CODE, (): string => {
    count += 1;
    return "\\`\\`\\`";
  });
  const imageEscaped = codeEscaped.replace(IMAGE_OPEN, (): string => {
    count += 1;
    return "\\!\\[";
  });
  const linkEscaped = imageEscaped.replace(LINK_OPEN, (_match: string, inner: string): string => {
    count += 1;
    return `\\[${inner}\\](`;
  });
  return { value: linkEscaped, count };
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
 *   2. Strip C0/C1/DEL control characters.
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
