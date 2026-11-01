// Synthetic byte fixtures for the parser adapters (Epic #189, Issue #266). Pure strings
// only — no FS, no shell, no network. Kept in a `*-fixtures.ts` (NOT `_support`) file so the
// architecture rules treat it as production source but the trust-8 rule still excludes it
// from publication when callers stick to the `parsers/index.ts` barrel.

import type { DocumentId } from "@oscharko-dev/keiko-contracts";
import { Buffer } from "node:buffer";
import { deflateRawSync } from "node:zlib";

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
  return {
    ...base,
    ...(overrides.languageHint !== undefined ? { languageHint: overrides.languageHint } : {}),
    ...(overrides.pageNumber !== undefined ? { pageNumber: overrides.pageNumber } : {}),
  };
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
  return {
    ...base,
    ...(overrides.languageHint !== undefined ? { languageHint: overrides.languageHint } : {}),
    ...(overrides.pageNumber !== undefined ? { pageNumber: overrides.pageNumber } : {}),
  };
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

export const PDF_NO_TEXT_LAYER: Uint8Array = encode(
  `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R >> endobj
4 0 obj << /Length 0 >> stream

endstream endobj
xref
0 5
0000000000 65535 f
0000000010 00000 n
0000000063 00000 n
0000000122 00000 n
0000000210 00000 n
trailer << /Root 1 0 R /Size 5 >>
startxref
260
%%EOF`,
);

export const DOCX_SIMPLE_BASE64 =
  "UEsDBBQAAAAIAC28xFzXeYTq8QAAALgBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QzU7DMBCE730Ky9cqccoBIZSkB36OwKE8wMreJFb9J69b2rdn00KREOVozXwz62nXB+/EHjPZGDq5qhspMOhobBg7+b55ru6koALBgIsBO3lEkut+0W6OCUkwHKiTUynpXinSE3qgOiYMrAwxeyj8zKNKoLcworppmlulYygYSlXmDNkvhGgfcYCdK+LpwMr5loyOpHg4e+e6TkJKzmoorKt9ML+Kqq+SmsmThyabaMkGqa6VzOL1jh/0lSfK1qB4g1xewLNRfcRslIl65xmu/0/649o4DFbjhZ/TUo4aiXh77+qL4sGG71+06jR8/wlQSwMEFAAAAAgALbzEXCAbhuqyAAAALgEAAAsAAABfcmVscy8ucmVsc43Puw6CMBQG4J2naM4uBQdjDIXFmLAafICmPZRGeklbL7y9HRzEODie23fyN93TzOSOIWpnGdRlBQStcFJbxeAynDZ7IDFxK/nsLDJYMELXFs0ZZ57yTZy0jyQjNjKYUvIHSqOY0PBYOo82T0YXDE+5DIp6Lq5cId1W1Y6GTwPagpAVS3rJIPSyBjIsHv/h3ThqgUcnbgZt+vHlayPLPChMDB4uSCrf7TKzQHNKuorZvgBQSwMEFAAAAAgALbzEXGJ/vc/pAAAA5wEAABEAAAB3b3JkL2RvY3VtZW50LnhtbJWRwU7DMAyG73uKKPc13Q4IVU2mgTRxnAQ8QEjNWimxoySs9O1JWtAmDhOc8lv+f/uT0+4+nWVnCHEglHxT1ZwBGuoGPEn++nJY33MWk8ZOW0KQfILId2rVjk1H5sMBJpYnYGxGyfuUfCNEND04HSvygLn3TsHplMtwEiOFzgcyEGNe4KzY1vWdcHpArlaM5alv1E1FzoVf1KKPQZXnOU0W2NictZX8CXQh3XChWrF4LonZn9SR7GCm0k6z6dsy+682XQJ763vNCkh1nfod+Bva9hbaI2EKZOM/4B4g3WIrYjlhUT9fpL4AUEsBAhQDFAAAAAgALbzEXNd5hOrxAAAAuAEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACAAtvMRcIBuG6rIAAAAuAQAACwAAAAAAAAAAAAAAgAEiAQAAX3JlbHMvLnJlbHNQSwECFAMUAAAACAAtvMRcYn+9z+kAAADnAQAAEQAAAAAAAAAAAAAAgAH9AQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAAFQMAAAAA";

export const DOCX_SIMPLE: Uint8Array = Uint8Array.from(Buffer.from(DOCX_SIMPLE_BASE64, "base64"));

export const DOCX_WITH_PREAMBLE_BASE64 =
  "UEsDBBQAAAAIANACxVxn4XsRxAAAAHcBAAATABwAW0NvbnRlbnRfVHlwZXNdLnhtbFVUCQADp/ohaqf6IWp1eAsAAQT1AQAABBQAAAB9kLkOwjAMhneeosqKqBEDA6IswAoMvICVum1ELsXmentSrgEBo/0fn+X5/hqJi4uznivVicQZAOuOHHIZIvmsNCE5lDymFiLqA7YEk/F4Cjp4IS8j6TvUYr6iBo9WivUlr9kEX6lEllWxfBh7VqUwRms0Stbh5OsPyuhJKHPy7uHORB5mg4KvhF75DXjmtidKydRU7DDJBl12wTmkGuqgjy4ny/81X+4MTWM0vfN9W0xBE7PxrbPlW3Fo/Ot+uL97MbgBUEsDBAoAAAAAANACxVwAAAAAAAAAAAAAAAAGABwAX3JlbHMvVVQJAAOn+iFqp/ohanV4CwABBPUBAAAEFAAAAFBLAwQUAAAACADQAsVcJnghCIsAAADzAAAACwAcAF9yZWxzLy5yZWxzVVQJAAOn+iFqp/ohanV4CwABBPUBAAAEFAAAAI3PPQ4CIRAF4N5TEA6ws1pYGKCy2XbjBQjMAnH5yYBRby+FxWosLGfe5HsZMeOqW8ip+lAqe8Q1Vcl9a+UEUI3HqOuQC6aeLJmibn0kB0Wbq3YIh3E8Am0NrsTWZJOVnCa75+zyLPiPnZclGDxnc4uY2o+Kr4sua3LYJL9nsmDf66GzHJSAjxfV7gVQSwMECgAAAAAA0ALFXAAAAAAAAAAAAAAAAAUAHAB3b3JkL1VUCQADp/ohaqf6IWp1eAsAAQT1AQAABBQAAABQSwMEFAAAAAgA0ALFXNON7KHUAAAAWAEAABEAHAB3b3JkL2RvY3VtZW50LnhtbFVUCQADp/ohaqf6IWp1eAsAAQT1AQAABBQAAAB1kE1PwzAMhu/7FZHvLN0OCFVtd0PsNgn4ASYxbaUkjpyw0n9PsvEhJLi8Vuwnrz+6w7t36kySZg497LYNKAqG7RzGHp6f7m/uQKWMwaLjQD2slOAwbLqltWzePIWsikNI7dLDlHNstU5mIo9py5FCqb2yeMzlKaNeWGwUNpRSaeCd3jfNrfY4BxiK5QvbtcZYRark4RiysIooOArGqdM1WVUuGr/5eLr8iI95daSW9oyuhwfCusoO9JW+Mp/WJ3azWf93/IWpOtwfrP4aW/+cZNh8AFBLAQIeAxQAAAAIANACxVxn4XsRxAAAAHcBAAATABgAAAAAAAEAAACkgQAAAABbQ29udGVudF9UeXBlc10ueG1sVVQFAAOn+iFqdXgLAAEE9QEAAAQUAAAAUEsBAh4DCgAAAAAA0ALFXAAAAAAAAAAAAAAAAAYAGAAAAAAAAAAQAO1BEQEAAF9yZWxzL1VUBQADp/ohanV4CwABBPUBAAAEFAAAAFBLAQIeAxQAAAAIANACxVwmeCEIiwAAAPMAAAALABgAAAAAAAEAAACkgVEBAABfcmVscy8ucmVsc1VUBQADp/ohanV4CwABBPUBAAAEFAAAAFBLAQIeAwoAAAAAANACxVwAAAAAAAAAAAAAAAAFABgAAAAAAAAAEADtQSECAAB3b3JkL1VUBQADp/ohanV4CwABBPUBAAAEFAAAAFBLAQIeAxQAAAAIANACxVzTjeyh1AAAAFgBAAARABgAAAAAAAEAAACkgWACAAB3b3JkL2RvY3VtZW50LnhtbFVUBQADp/ohanV4CwABBPUBAAAEFAAAAFBLBQYAAAAABQAFAJgBAAB/AwAAAAA=";

export const DOCX_WITH_PREAMBLE: Uint8Array = Uint8Array.from(
  Buffer.from(DOCX_WITH_PREAMBLE_BASE64, "base64"),
);

export const XLSX_SIMPLE_BASE64 =
  "UEsDBBQAAAAIAAAAAADBChDqgQAAAKQAAAAPAAAAeGwvd29ya2Jvb2sueG1sNY7BDoMwDEN/pcoHLLDDDohy2S58RgfpWkEblARtnz80jZPtZ1ly/2ZZnsyL+5S1aicektnWIeqUqAS98Eb16CJLCXZEeSHHmCd68LQXqobXprmh0Bosc9WUN4Wh10Rk+ldXQyEPd64mvCq4Hx1nDy046fJhZJxbwKHHc4jns+ELUEsDBBQAAAAIAAAAAAAHfok7RgAAAGgAAAAaAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHOzCUrNSSzJzM8rzsgsKLazQeYqeKbYKhV5phgqKYRUFqTaKpXnF2UXZ6SmlgAFEovSU0uQhIr1wZShXkVujpK+nY0+qsEAUEsDBBQAAAAIAAAAAACCf1VtQAAAAGwAAAAUAAAAeGwvc2hhcmVkU3RyaW5ncy54bWyzKS4usbMpzrSzKbHzTq200Qfy9EFciFBYYk5pKrqgc35eSVF+jq6hObqMa15yUWVBiUJSYnJ2aUExQlofZA0AUEsDBBQAAAAIAAAAAAA2I5L5hAAAAPoAAAAYAAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1ssynPL8ouzkhNLbGzAVMuiSWJdjZF+eUKRbZKhkp2NskghqOhkkKJrVIxkF9mZ2CjX2Zno58MlXNCljOEy+kDzYAbZAQ3yAhJsRGaQchyxqhyzhC5zLyczLzU4JIioJrMYjubErtAEwW1xNwCa4XE0pTMEht9oD/0QTIIJ+gj+Usf4V0AUEsBAhQAFAAAAAgAAAAAAMEKEOqBAAAApAAAAA8AAAAAAAAAAAAAAAAAAAAAAHhsL3dvcmtib29rLnhtbFBLAQIUABQAAAAIAAAAAAAHfok7RgAAAGgAAAAaAAAAAAAAAAAAAAAAAK4AAAB4bC9fcmVscy93b3JrYm9vay54bWwucmVsc1BLAQIUABQAAAAIAAAAAACCf1VtQAAAAGwAAAAUAAAAAAAAAAAAAAAAACwBAAB4bC9zaGFyZWRTdHJpbmdzLnhtbFBLAQIUABQAAAAIAAAAAAA2I5L5hAAAAPoAAAAYAAAAAAAAAAAAAAAAAJ4BAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWxQSwUGAAAAAAQABAANAQAAWAIAAAAA";

export const XLSX_SIMPLE: Uint8Array = Uint8Array.from(Buffer.from(XLSX_SIMPLE_BASE64, "base64"));

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

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipTextEntry {
  readonly name: string;
  readonly content: string;
}

// Builds a minimal deflate-compressed zip from text entries so OOXML parsers can be exercised
// with a synthetic package whose every part the test controls.
export function zipTextEntries(entries: readonly ZipTextEntry[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const filename = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.content, "utf8");
    const compressed = deflateRawSync(raw);
    const checksum = crc32(raw);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.byteLength, 18);
    localHeader.writeUInt32LE(raw.byteLength, 22);
    localHeader.writeUInt16LE(filename.byteLength, 26);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.byteLength, 20);
    centralHeader.writeUInt32LE(raw.byteLength, 24);
    centralHeader.writeUInt16LE(filename.byteLength, 28);
    centralHeader.writeUInt32LE(localOffset, 42);

    localParts.push(localHeader, filename, compressed);
    centralParts.push(centralHeader, filename);
    localOffset += localHeader.byteLength + filename.byteLength + compressed.byteLength;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Uint8Array.from(Buffer.concat([...localParts, ...centralParts, end]));
}

/**
 * A password-protected Office file: the OLE2 compound-file header Office wraps around an
 * encrypted package, followed by filler. The bytes are not a ZIP archive and hold no slide text.
 */
export function oleEncryptedPackage(): Uint8Array {
  const bytes = new Uint8Array(512);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  return bytes;
}

// ─── PDF builder ─────────────────────────────────────────────────────────────

function pdfStringLiteral(text: string): string {
  return text.replaceAll(/[\\()]/gu, (match) => `\\${match}`);
}

export interface TextPdfOptions {
  /** Adds a standard-security-handler /Encrypt dictionary that no empty password opens. */
  readonly encrypted?: boolean;
}

const FIRST_PAGE_OBJECT = 4;

function pdfPageObjects(pages: readonly string[]): readonly string[] {
  return pages.flatMap((text, index) => {
    const content = `BT /F1 18 Tf 72 700 Td (${pdfStringLiteral(text)}) Tj ET`;
    const contentNumber = FIRST_PAGE_OBJECT + index * 2 + 1;
    return [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${String(contentNumber)} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    ];
  });
}

// Builds a valid text-layer PDF with one page per entry and a byte-exact cross-reference table, so
// the fixture needs neither a recovery pass nor a canned blob. With `encrypted`, the trailer
// references an /Encrypt dictionary whose owner and user entries do not authenticate the empty
// password, which is how a document that requires a password reaches the parser.
export function buildTextPdf(pages: readonly string[], options: TextPdfOptions = {}): Uint8Array {
  const kids = pages.map((_, index) => `${String(FIRST_PAGE_OBJECT + index * 2)} 0 R`).join(" ");
  const bodies: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${String(pages.length)} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pdfPageObjects(pages),
  ];
  const encryptEntries: readonly string[] =
    options.encrypted === true
      ? [
          `/Encrypt ${String(bodies.length + 1)} 0 R`,
          "/ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]",
        ]
      : [];
  if (options.encrypted === true) {
    bodies.push(
      `<< /Filter /Standard /V 1 /R 2 /P -4 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> >>`,
    );
  }
  let document = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, body] of bodies.entries()) {
    offsets.push(document.length);
    document += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  }
  const size = bodies.length + 1;
  const entries = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`);
  const trailer = [`/Size ${String(size)}`, "/Root 1 0 R", ...encryptEntries].join(" ");
  const xref = `xref\n0 ${String(size)}\n0000000000 65535 f \n${entries.join("")}`;
  return encode(
    `${document}${xref}trailer\n<< ${trailer} >>\nstartxref\n${String(document.length)}\n%%EOF\n`,
  );
}
