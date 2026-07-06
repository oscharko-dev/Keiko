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

// Linear-time tag-start probe for `<title` (no backtracking); the tag body and content are then
// located with `indexOf`, so no polynomial regex ever runs on document input (js/polynomial-redos).
const TITLE_OPEN_RE = /<title[\s>]/iu;

const MAX_TITLE_CHARS = 200;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

// One entity token: a hex numeric reference, a decimal numeric reference, or a named reference.
const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|[a-z]+);/giu;

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function decodeEntityBody(body: string): string | undefined {
  const lower = body.toLowerCase();
  if (lower.startsWith("#")) {
    const isHex = lower.startsWith("#x");
    const code = Number.parseInt(lower.slice(isHex ? 2 : 1), isHex ? 16 : 10);
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) return undefined;
    try {
      return String.fromCodePoint(code);
    } catch {
      return undefined;
    }
  }
  return NAMED_ENTITIES[lower];
}

// Decode HTML entities in a SINGLE pass. `String.prototype.replace` scans the ORIGINAL string once
// and never re-scans replacement output, so an encoded sequence like `&amp;#x2f;` decodes to the
// literal text `&#x2f;`, never double-unescaped to `/` (js/double-escaping). Unknown entities are
// left verbatim.
function decodeAttributeEntities(value: string): string {
  return value.replace(ENTITY_RE, (match: string, body: string) => decodeEntityBody(body) ?? match);
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

// Locate the `<title>…</title>` content with linear scans only (no backtracking regex).
function extractRawTitle(html: string): string | null {
  const open = html.search(TITLE_OPEN_RE);
  if (open === -1) return null;
  const contentStart = html.indexOf(">", open);
  if (contentStart === -1) return null;
  const close = html.toLowerCase().indexOf("</title>", contentStart + 1);
  if (close === -1) return null;
  return html.slice(contentStart + 1, close);
}

// Extract a page's `<title>` text as a bounded, whitespace-collapsed string, or null when absent.
// The raw title stays internal; the browser-facing pod summary re-applies redaction downstream.
export function extractManualTitle(bytes: Uint8Array): string | null {
  const raw = extractRawTitle(decodeBytes(bytes));
  if (raw === null) return null;
  const title = decodeAttributeEntities(raw).replace(/\s+/gu, " ").trim();
  if (title.length === 0) return null;
  return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS) : title;
}
