/**
 * Inline base64 data URLs carried by an OpenAI-compatible content part (#3897 S14, #3906): the one
 * owner of their syntax, shared by the image and the PDF document part modules. Only a canonical,
 * non-empty base64 payload within the caller's byte bound is admitted; the caller decides which
 * media types its part may carry.
 */

const DATA_URL_SCHEME = "data:";
const BASE64_MARKER = "base64";
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]+={0,2}$/u;

export interface InlineDataUrl {
  readonly mediaType: string;
  readonly payload: string;
}

export type InlineDataUrlResult =
  | { readonly kind: "ok"; readonly value: InlineDataUrl }
  /** Not a data URL at all: a remote or file reference Keiko never dereferences. */
  | { readonly kind: "not-inline" }
  | { readonly kind: "invalid" }
  | { readonly kind: "too-large" };

function paddingLength(payload: string): number {
  if (payload.endsWith("==")) return 2;
  return payload.endsWith("=") ? 1 : 0;
}

/** The decoded size of a canonical base64 payload. */
export function decodedBase64Bytes(payload: string): number {
  return (payload.length / 4) * 3 - paddingLength(payload);
}

function splitBase64DataUrl(url: string): InlineDataUrl | undefined {
  const comma = url.indexOf(",");
  if (comma < 0) return undefined;
  const [mediaType, encoding, ...extra] = url.slice(DATA_URL_SCHEME.length, comma).split(";");
  if (mediaType === undefined || encoding !== BASE64_MARKER || extra.length > 0) return undefined;
  return { mediaType, payload: url.slice(comma + 1) };
}

/** Parses `data:<media type>;base64,<payload>` whose decoded payload is at most `maxBytes`. */
export function parseInlineDataUrl(url: string, maxBytes: number): InlineDataUrlResult {
  if (!url.startsWith(DATA_URL_SCHEME)) return { kind: "not-inline" };
  const split = splitBase64DataUrl(url);
  if (split === undefined) return { kind: "invalid" };
  const { payload } = split;
  // A canonical base64 string of `maxBytes` bytes: four characters per three bytes.
  if (payload.length > 4 * Math.ceil(maxBytes / 3)) return { kind: "too-large" };
  if (payload.length % 4 !== 0 || !BASE64_PAYLOAD.test(payload)) return { kind: "invalid" };
  if (decodedBase64Bytes(payload) > maxBytes) return { kind: "too-large" };
  return { kind: "ok", value: split };
}
