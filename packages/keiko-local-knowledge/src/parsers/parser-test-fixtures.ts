// Synthetic byte fixtures for the parser adapters (Epic #189, Issue #266). Pure strings
// only — no FS, no shell, no network. Kept in a `*-fixtures.ts` (NOT `_support`) file so the
// architecture rules treat it as production source but the trust-8 rule still excludes it
// from publication when callers stick to the `parsers/index.ts` barrel.

import type { DocumentId } from "@oscharko-dev/keiko-contracts";

import type { ParserSelectionInput } from "./types.js";

export const FIXTURE_DOCUMENT_ID = "doc-fixture" as DocumentId;

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function selectionFromText(
  text: string,
  overrides: Partial<ParserSelectionInput> = {},
): ParserSelectionInput {
  const base: ParserSelectionInput = {
    documentId: FIXTURE_DOCUMENT_ID,
    bytes: encode(text),
    extension: overrides.extension ?? "txt",
    mediaType: overrides.mediaType ?? "text/plain",
  };
  return overrides.languageHint !== undefined
    ? { ...base, languageHint: overrides.languageHint }
    : base;
}

export function selectionFromBytes(
  bytes: Uint8Array,
  overrides: Partial<ParserSelectionInput> = {},
): ParserSelectionInput {
  const base: ParserSelectionInput = {
    documentId: FIXTURE_DOCUMENT_ID,
    bytes,
    extension: overrides.extension ?? "",
    mediaType: overrides.mediaType ?? "",
  };
  return overrides.languageHint !== undefined
    ? { ...base, languageHint: overrides.languageHint }
    : base;
}

// ─── Format fixtures ─────────────────────────────────────────────────────────

export const TEXT_PLAIN = "Hello, world.\nSecond paragraph here.\n";

export const MARKDOWN_DOC = [
  "# Title",
  "",
  "Intro paragraph.",
  "",
  "## Subhead A",
  "",
  "Body of A.",
  "",
  "### Deep heading",
  "",
  "Deep body.",
  "",
  "## Subhead B",
  "",
  "Body of B.",
  "",
].join("\n");

export const JSON_FLAT = '{"name":"alpha","count":3,"active":true}';

export const JSON_NESTED = JSON.stringify({
  meta: { id: "doc-1", version: 2 },
  items: [
    { sku: "A1", price: 10 },
    { sku: "B2", price: 20 },
  ],
});

export const CSV_SIMPLE = "a,b,c\n1,2,3\n4,5,6\n";

// RFC 4180 adversarial fixture — quoted comma, embedded quote escape, embedded newline.
export const CSV_QUOTED = 'a,b,c\n"x,1","y""2","z\n3"\n';

export const TSV_SIMPLE = "a\tb\tc\n1\t2\t3\n";

export const HTML_HEADINGS = [
  "<!DOCTYPE html>",
  "<html><body>",
  "<h1>Top</h1>",
  "<p>Intro text.</p>",
  "<h2>Sub</h2>",
  "<p>Sub body.</p>",
  "<h3>Deeper</h3>",
  "<p>Deeper body.</p>",
  "</body></html>",
].join("\n");

export const HTML_DANGEROUS = [
  "<html><body>",
  "<h1>Safe</h1>",
  "<script>alert('pwn');</script>",
  "<style>body{display:none}</style>",
  "<noscript>fallback</noscript>",
  "<p>After script.</p>",
  "</body></html>",
].join("\n");

// Synthetic PDF marker — only the leading magic bytes are required for sniffing.
export const PDF_MAGIC: Uint8Array = encode("%PDF-1.4\n%binary marker\n");

// Synthetic zip marker — PK\x03\x04 prefix. We never decompress this.
export const ZIP_MAGIC: Uint8Array = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00,
]);

// Synthetic gzip marker — 0x1f 0x8b prefix.
export const GZIP_MAGIC: Uint8Array = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);

// Synthetic PNG marker.
export const PNG_MAGIC: Uint8Array = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
