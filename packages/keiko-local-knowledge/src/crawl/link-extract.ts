// Static HTML link extraction (Epic #1853, Issue #1872).
//
// Pure, allocation-bounded scan of a static HTML document's navigational links: `<a href>`,
// `<area href>`, `<frame src>`, `<iframe src>`, and `<link rel="canonical" href>`. It extracts raw
// attribute values only; resolution, canonicalisation, and scope enforcement are the guard's job
// (`scope-guard.ts`). It executes no JavaScript and interprets no DOM — this is the static ingestion
// boundary (ADR-0113): rendered capture is a separate, later, security-reviewed path.

// Attribute-value scan for href/src. Matches double-quoted, single-quoted, and bare forms. HTML is
// irregular, so this is intentionally a lexical scan of navigational attributes, not a full parse —
// URL parsing itself is delegated to the WHATWG URL parser in the guard.
const HREF_SRC_ATTR_RE = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/giu;

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/iu;

const MAX_TITLE_CHARS = 200;

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// Decode the small set of HTML entities that legitimately appear inside a URL attribute value.
function decodeAttributeEntities(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&#x2f;/giu, "/")
    .replace(/&#47;/gu, "/")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

// Extract up to `maxLinks` raw navigational link values from an HTML document. Empty values,
// pure fragments (`#…`), and non-navigational schemes are left for the guard to classify; this
// function only bounds the sample and de-duplicates identical raw strings.
export function extractManualLinks(bytes: Uint8Array, maxLinks: number): readonly string[] {
  if (maxLinks <= 0) return [];
  const html = decodeBytes(bytes);
  const seen = new Set<string>();
  const links: string[] = [];
  for (const match of html.matchAll(HREF_SRC_ATTR_RE)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    const value = decodeAttributeEntities(raw).trim();
    if (value.length === 0 || value.startsWith("#")) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    links.push(value);
    if (links.length >= maxLinks) break;
  }
  return links;
}

// Extract a page's `<title>` text as a bounded, whitespace-collapsed string, or null when absent.
// The raw title stays internal; the browser-facing pod summary re-applies redaction downstream.
export function extractManualTitle(bytes: Uint8Array): string | null {
  const match = TITLE_RE.exec(decodeBytes(bytes));
  if (match?.[1] === undefined) return null;
  const title = decodeAttributeEntities(match[1]).replace(/\s+/gu, " ").trim();
  if (title.length === 0) return null;
  return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS) : title;
}
