// Synthetic byte fixtures for the parser adapters (Epic #189, Issue #266). Pure strings
// only — no FS, no shell, no network. Kept in a `*-fixtures.ts` (NOT `_support`) file so the
// architecture rules treat it as production source but the trust-8 rule still excludes it
// from publication when callers stick to the `parsers/index.ts` barrel.

import type { DocumentId } from "@oscharko-dev/keiko-contracts";
import { Buffer } from "node:buffer";

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

export const PDF_TEXT_LAYER: Uint8Array = encode(
  `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 24 Tf 72 72 Td (Hello PDF) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f 
0000000010 00000 n 
0000000063 00000 n 
0000000122 00000 n 
0000000248 00000 n 
0000000342 00000 n 
trailer << /Root 1 0 R /Size 6 >>
startxref
412
%%EOF`,
);

export const DOCX_SIMPLE_BASE64 =
  "UEsDBBQAAAAIAC28xFzXeYTq8QAAALgBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QzU7DMBCE730Ky9cqccoBIZSkB36OwKE8wMreJFb9J69b2rdn00KREOVozXwz62nXB+/EHjPZGDq5qhspMOhobBg7+b55ru6koALBgIsBO3lEkut+0W6OCUkwHKiTUynpXinSE3qgOiYMrAwxeyj8zKNKoLcworppmlulYygYSlXmDNkvhGgfcYCdK+LpwMr5loyOpHg4e+e6TkJKzmoorKt9ML+Kqq+SmsmThyabaMkGqa6VzOL1jh/0lSfK1qB4g1xewLNRfcRslIl65xmu/0/649o4DFbjhZ/TUo4aiXh77+qL4sGG71+06jR8/wlQSwMEFAAAAAgALbzEXCAbhuqyAAAALgEAAAsAAABfcmVscy8ucmVsc43Puw6CMBQG4J2naM4uBQdjDIXFmLAafICmPZRGeklbL7y9HRzEODie23fyN93TzOSOIWpnGdRlBQStcFJbxeAynDZ7IDFxK/nsLDJYMELXFs0ZZ57yTZy0jyQjNjKYUvIHSqOY0PBYOo82T0YXDE+5DIp6Lq5cId1W1Y6GTwPagpAVS3rJIPSyBjIsHv/h3ThqgUcnbgZt+vHlayPLPChMDB4uSCrf7TKzQHNKuorZvgBQSwMEFAAAAAgALbzEXGJ/vc/pAAAA5wEAABEAAAB3b3JkL2RvY3VtZW50LnhtbJWRwU7DMAyG73uKKPc13Q4IVU2mgTRxnAQ8QEjNWimxoySs9O1JWtAmDhOc8lv+f/uT0+4+nWVnCHEglHxT1ZwBGuoGPEn++nJY33MWk8ZOW0KQfILId2rVjk1H5sMBJpYnYGxGyfuUfCNEND04HSvygLn3TsHplMtwEiOFzgcyEGNe4KzY1vWdcHpArlaM5alv1E1FzoVf1KKPQZXnOU0W2NictZX8CXQh3XChWrF4LonZn9SR7GCm0k6z6dsy+682XQJ763vNCkh1nfod+Bva9hbaI2EKZOM/4B4g3WIrYjlhUT9fpL4AUEsBAhQDFAAAAAgALbzEXNd5hOrxAAAAuAEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACAAtvMRcIBuG6rIAAAAuAQAACwAAAAAAAAAAAAAAgAEiAQAAX3JlbHMvLnJlbHNQSwECFAMUAAAACAAtvMRcYn+9z+kAAADnAQAAEQAAAAAAAAAAAAAAgAH9AQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAAFQMAAAAA";

export const DOCX_SIMPLE: Uint8Array = Uint8Array.from(
  Buffer.from(DOCX_SIMPLE_BASE64, "base64"),
);

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
