// Binary export assembly helpers (Epic #711).
//
// Produces deterministic binary artifacts — a minimal text-only PDF and a STORE
// (no-compression) ZIP — with zero new runtime dependencies. Both formats are
// assembled by hand to guarantee byte-stable output: no /CreationDate, no UUIDs,
// no timestamps, no Math.random.
//
// PDF determinism: fixed object offsets, static trailer, no metadata objects.
// ZIP determinism: DOS date/time zeroed, STORE method (no compression), CRC32
// computed from content bytes, central directory built from the same metadata.

// ─── Shared ───────────────────────────────────────────────────────────────────

const TEXT_ENC = new TextEncoder();

// ─── CRC32 ────────────────────────────────────────────────────────────────────

const CRC32_TABLE: Uint32Array = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (CRC32_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ─── Little-endian integer helpers ───────────────────────────────────────────

function u16le(n: number): readonly [number, number] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

function u32le(n: number): readonly [number, number, number, number] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

// ─── ZIP assembly ─────────────────────────────────────────────────────────────

const ZIP_LOCAL_HEADER_SIG = [0x50, 0x4b, 0x03, 0x04] as const;
const ZIP_CENTRAL_SIG = [0x50, 0x4b, 0x01, 0x02] as const;
const ZIP_EOCD_SIG = [0x50, 0x4b, 0x05, 0x06] as const;

function buildLocalHeader(name: Uint8Array, size: number, crc: number): number[] {
  return [
    ...ZIP_LOCAL_HEADER_SIG,
    ...u16le(20), // version needed
    ...u16le(0), // flags
    ...u16le(0), // STORE method
    ...u16le(0), // last mod time (zeroed)
    ...u16le(0), // last mod date (zeroed)
    ...u32le(crc),
    ...u32le(size), // compressed size
    ...u32le(size), // uncompressed size
    ...u16le(name.length),
    ...u16le(0), // extra field length
    ...name,
  ];
}

function buildCentralEntry(name: Uint8Array, size: number, crc: number, offset: number): number[] {
  return [
    ...ZIP_CENTRAL_SIG,
    ...u16le(20), // version made by
    ...u16le(20), // version needed
    ...u16le(0), // flags
    ...u16le(0), // STORE method
    ...u16le(0), // last mod time (zeroed)
    ...u16le(0), // last mod date (zeroed)
    ...u32le(crc),
    ...u32le(size), // compressed size
    ...u32le(size), // uncompressed size
    ...u16le(name.length),
    ...u16le(0), // extra field length
    ...u16le(0), // file comment length
    ...u16le(0), // disk number start
    ...u16le(0), // internal attributes
    ...u32le(0), // external attributes
    ...u32le(offset),
    ...name,
  ];
}

/**
 * Reduce an entry name to a contained, single-segment file name. Defense-in-depth: the run id is
 * already brand-validated (no "/", "\\", ".." — see keiko-contracts ids.ts) before it reaches this
 * helper, but the ZIP writer must not depend on its caller for containment. Strips any directory
 * component, collapses traversal dot-runs, and rejects an empty result.
 */
export function safeZipEntryName(name: string): string {
  const base = name
    .replace(/^.*[\\/]/u, "") // drop any directory prefix (POSIX or Windows separators)
    .replace(/\.{2,}/gu, "."); // collapse ".." (and longer dot-runs) so no traversal token survives
  return base.length > 0 ? base : "export.bin";
}

/**
 * Assembles a deterministic STORE (no-compression) ZIP from the given entries.
 * DOS date/time fields are zeroed for byte-stable output across runs. Entry names are reduced to a
 * contained basename so a bundle can never write outside its own archive root.
 */
export function assembleZipBundle(
  entries: readonly { readonly name: string; readonly bytes: Uint8Array }[],
): Uint8Array {
  const localHeaders: number[][] = [];
  const centralEntries: number[][] = [];
  const dataChunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = TEXT_ENC.encode(safeZipEntryName(entry.name));
    const crc = crc32(entry.bytes);
    const local = buildLocalHeader(nameBytes, entry.bytes.length, crc);
    offsets.push(offset);
    localHeaders.push(local);
    dataChunks.push(entry.bytes);
    offset += local.length + entry.bytes.length;
    centralEntries.push(buildCentralEntry(nameBytes, entry.bytes.length, crc, offsets.at(-1) ?? 0));
  }

  const centralStart = offset;
  const centralFlat = centralEntries.flatMap((e) => e);
  const eocd = [
    ...ZIP_EOCD_SIG,
    ...u16le(0), // disk number
    ...u16le(0), // central dir start disk
    ...u16le(entries.length), // entries on disk
    ...u16le(entries.length), // total entries
    ...u32le(centralFlat.length),
    ...u32le(centralStart),
    ...u16le(0), // comment length
  ];
  return concatZipBytes(localHeaders, dataChunks, centralFlat, eocd);
}

// Interleave [localHeader, data] pairs, then the central directory and EOCD, into one buffer.
function concatZipBytes(
  localHeaders: readonly number[][],
  dataChunks: readonly Uint8Array[],
  centralFlat: readonly number[],
  eocd: readonly number[],
): Uint8Array {
  const totalLen =
    localHeaders.reduce((s, h) => s + h.length, 0) +
    dataChunks.reduce((s, d) => s + d.length, 0) +
    centralFlat.length +
    eocd.length;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (let i = 0; i < localHeaders.length; i++) {
    const hdr = localHeaders[i];
    const dat = dataChunks[i];
    if (hdr === undefined || dat === undefined) continue;
    out.set(hdr, pos);
    pos += hdr.length;
    out.set(dat, pos);
    pos += dat.length;
  }
  out.set(centralFlat, pos);
  pos += centralFlat.length;
  out.set(eocd, pos);
  return out;
}

// ─── PDF assembly ─────────────────────────────────────────────────────────────
//
// A minimal, dependency-free, multi-page text PDF. The whole candidate body is rendered (no
// arbitrary truncation): lines are wrapped to the page width and paginated across as many A4 pages
// as needed. Text is encoded as single-byte WinAnsi (CP1252) and the Courier font declares
// /Encoding /WinAnsiEncoding, so German umlauts (ä ö ü Ä Ö Ü ß), the euro sign, and common
// typographic punctuation render correctly instead of as UTF-8 mojibake. No /CreationDate,
// no Producer, no random — byte-stable across identical runs.

const PDF_FONT_SIZE = 10;
const PDF_LEADING = 14;
const PDF_MARGIN_X = 50;
const PDF_TOP_Y = 792; // 842 page height − 50 top margin
const PDF_BOTTOM_Y = 56; // keep the last baseline above the bottom margin
const PDF_MAX_CHARS = 80; // Courier @10pt is 6pt/glyph → ~82 glyphs fit in 495pt; 80 leaves a margin
const PDF_LINES_PER_PAGE = Math.floor((PDF_TOP_Y - PDF_BOTTOM_Y) / PDF_LEADING); // 52

function pdfStr(s: string): Uint8Array {
  return TEXT_ENC.encode(s);
}

function escapePdf(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// WinAnsi (CP1252) bytes for the code points that differ from Latin-1 in the 0x80–0x9F window.
const CP1252_HIGH: Readonly<Record<number, number>> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};
// Best-effort ASCII fold for common punctuation outside CP1252, so they degrade legibly (not to '?').
const PDF_ASCII_FOLD: Readonly<Record<number, number>> = {
  0x2010: 0x2d,
  0x2011: 0x2d,
  0x2012: 0x2d, // hyphen/figure/non-breaking dashes → '-'
  0x00a0: 0x20,
  0x2007: 0x20,
  0x202f: 0x20, // no-break / figure / narrow spaces → ' '
};

function winAnsiByte(cp: number): number {
  if (cp === 0x09) return 0x20; // tab → space
  if (cp < 0x20) return 0x3f; // other C0 controls → '?'
  if (cp <= 0x7e) return cp; // printable ASCII
  if (cp === 0x7f) return 0x3f; // DEL
  if (cp >= 0xa0 && cp <= 0xff) return cp; // Latin-1 printable (umlauts, ß, accented letters)
  return CP1252_HIGH[cp] ?? PDF_ASCII_FOLD[cp] ?? 0x3f;
}

function winAnsiEncode(text: string): Uint8Array {
  const codePoints = Array.from(text); // iterate by code point (surrogate-safe)
  const out = new Uint8Array(codePoints.length);
  for (let i = 0; i < codePoints.length; i++) {
    out[i] = winAnsiByte(codePoints[i]?.codePointAt(0) ?? 0x3f);
  }
  return out;
}

// Greedy word-aware wrap to `maxChars`; a single over-long token is hard-broken. Preserves blanks.
function wrapText(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const out: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    if (word.length > maxChars) {
      if (current.length > 0) out.push(current);
      let rest = word;
      while (rest.length > maxChars) {
        out.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      current = rest;
      continue;
    }
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > maxChars) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) out.push(current);
  return out.length > 0 ? out : [""];
}

function wrapBody(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split(/\r\n|\r|\n/u)) {
    for (const wrapped of wrapText(line, PDF_MAX_CHARS)) out.push(wrapped);
  }
  return out;
}

function paginate(lines: readonly string[], perPage: number): string[][] {
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) {
    pages.push(lines.slice(i, i + perPage));
  }
  return pages.length > 0 ? pages : [[""]];
}

// Build one page's content stream: position the text cursor, then emit each (escaped, WinAnsi) line.
function buildPageContent(lines: readonly string[]): Uint8Array {
  const chunks: Uint8Array[] = [
    pdfStr(`BT\n/F1 ${String(PDF_FONT_SIZE)} Tf\n${String(PDF_LEADING)} TL\n`),
    pdfStr(`${String(PDF_MARGIN_X)} ${String(PDF_TOP_Y)} Td\n`),
  ];
  let first = true;
  for (const line of lines) {
    chunks.push(pdfStr(first ? "(" : "T* ("));
    chunks.push(winAnsiEncode(escapePdf(line)));
    chunks.push(pdfStr(") Tj\n"));
    first = false;
  }
  chunks.push(pdfStr("ET"));
  return concatBytes(chunks);
}

/**
 * Assembles a deterministic, multi-page, text-only PDF from the given plain-text body. The entire
 * body is rendered across as many pages as needed (no truncation). Byte-stable across identical runs.
 */
export function assemblePdf(body: string, runId: string): Uint8Array {
  const rawLines = [`Run: ${runId}`, "", ...wrapBody(body)];
  const pages = paginate(rawLines, PDF_LINES_PER_PAGE);
  const pageObjNums = pages.map((_, i) => 4 + 2 * i);
  const maxObjNum = 3 + 2 * pages.length;

  const objects: Uint8Array[] = [
    pdfStr("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    pdfStr(
      `2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map((n) => `${String(n)} 0 R`).join(" ")}]` +
        ` /Count ${String(pages.length)} >>\nendobj\n`,
    ),
    pdfStr(
      "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier" +
        " /Encoding /WinAnsiEncoding >>\nendobj\n",
    ),
  ];
  pages.forEach((pageLines, i) => {
    const pageNum = 4 + 2 * i;
    const contentNum = pageNum + 1;
    objects.push(
      pdfStr(
        `${String(pageNum)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]` +
          ` /Contents ${String(contentNum)} 0 R` +
          ` /Resources << /Font << /F1 3 0 R >> >> >>\nendobj\n`,
      ),
    );
    const content = buildPageContent(pageLines);
    objects.push(
      concatBytes([
        pdfStr(`${String(contentNum)} 0 obj\n<< /Length ${String(content.length)} >>\nstream\n`),
        content,
        pdfStr("\nendstream\nendobj\n"),
      ]),
    );
  });

  const header = pdfStr("%PDF-1.4\n");
  const offsets: number[] = [];
  let pos = header.length;
  for (const obj of objects) {
    offsets.push(pos);
    pos += obj.length;
  }
  const xrefOffset = pos;
  const xref = buildPdfXref(offsets);
  const trailer = pdfStr(
    `trailer\n<< /Size ${String(maxObjNum + 1)} /Root 1 0 R >>\n` +
      `startxref\n${String(xrefOffset)}\n%%EOF\n`,
  );
  return concatBytes([header, ...objects, xref, trailer]);
}

// Build the PDF cross-reference table for the given object byte-offsets (object 0 is the free head).
function buildPdfXref(offsets: readonly number[]): Uint8Array {
  const rows = offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `);
  const lines = ["xref", `0 ${String(offsets.length + 1)}`, "0000000000 65535 f ", ...rows];
  return pdfStr(lines.join("\n") + "\n");
}

// Concatenate byte chunks into a single buffer.
function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}
