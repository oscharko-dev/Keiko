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
 * Assembles a deterministic STORE (no-compression) ZIP from the given entries.
 * DOS date/time fields are zeroed for byte-stable output across runs.
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
    const nameBytes = TEXT_ENC.encode(entry.name);
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

function pdfStr(s: string): Uint8Array {
  return TEXT_ENC.encode(s);
}

function escapePdf(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdfTextOps(runId: string, body: string): string[] {
  const escaped = escapePdf(body.slice(0, 4000));
  const rawLines = escaped.split("\n");
  const textOps: string[] = [];
  let first = true;
  for (const line of rawLines) {
    if (first) {
      textOps.push(`(${line}) Tj`);
      first = false;
    } else {
      textOps.push(`T* (${line}) Tj`);
    }
  }
  return [
    `BT`,
    `/F1 10 Tf`,
    `50 750 Td`,
    `14 TL`,
    `(Run: ${escapePdf(runId)}) Tj`,
    `T*`,
    ...textOps,
    `ET`,
  ];
}

/**
 * Assembles a deterministic minimal text-only PDF from the given plain-text body.
 * No /CreationDate, no Producer, no Author — only what is needed for a valid PDF
 * structure. Byte-stable across identical runs.
 */
export function assemblePdf(body: string, runId: string): Uint8Array {
  const contentOps = buildPdfTextOps(runId, body).join("\n");
  const contentStream = pdfStr(contentOps);

  const obj1 = pdfStr("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const obj2 = pdfStr("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  const obj3 = pdfStr(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]" +
      " /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
  );
  const obj4header = pdfStr(`4 0 obj\n<< /Length ${String(contentStream.length)} >>\nstream\n`);
  const obj4footer = pdfStr("\nendstream\nendobj\n");
  const obj5 = pdfStr("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n");
  const header = pdfStr("%PDF-1.4\n");

  const off1 = header.length;
  const off2 = off1 + obj1.length;
  const off3 = off2 + obj2.length;
  const off4 = off3 + obj3.length;
  const off5 = off4 + obj4header.length + contentStream.length + obj4footer.length;
  const xrefOffset = off5 + obj5.length;

  const xref = buildPdfXref([off1, off2, off3, off4, off5]);
  const trailer = pdfStr(
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`,
  );
  return concatBytes([
    header,
    obj1,
    obj2,
    obj3,
    obj4header,
    contentStream,
    obj4footer,
    obj5,
    xref,
    trailer,
  ]);
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
