// Direct unit tests for the binary export assembly helpers (Epic #711, Issue #721).
//
// Covers the properties the route-level tests cannot reach precisely: PDF pagination (the whole
// body is rendered, not a single truncated page), WinAnsi single-byte encoding of non-ASCII
// (German umlauts / euro sign render correctly, not as UTF-8 mojibake), ZIP entry-name containment
// (no traversal), parsed ZIP central-directory contents, and byte-determinism of both formats.
//
// Issue #721 mutation-proof additions cover:
//   A) ZIP full round-trip: EOCD→CD→local-header→content, CRC32 verified against node:zlib oracle
//   B) PDF xref offset resolution: every object offset in the xref table resolves to the correct obj
//   C) PDF multi-page /Length: ALL stream /Length declarations match actual byte distances
//   D) ZIP STORE method: method field == 0 in both local header and central directory

import { describe, expect, it } from "vitest";
import { crc32 as zlibCrc32 } from "node:zlib";
import { assemblePdf, assembleZipBundle, safeZipEntryName } from "../exportAssembly.js";

const ENC = new TextEncoder();

/** True when `haystack` contains the byte run `needle`. */
function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Extract central-directory file names from a STORE (uncompressed) ZIP. */
function zipCentralNames(bytes: Uint8Array): string[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names: string[] = [];
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (dv.getUint32(i, true) !== 0x02014b50) continue;
    const nameLen = dv.getUint16(i + 28, true);
    const extraLen = dv.getUint16(i + 30, true);
    const commentLen = dv.getUint16(i + 32, true);
    names.push(new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + nameLen)));
    i += 46 + nameLen + extraLen + commentLen - 1;
  }
  return names;
}

// ─── PDF ────────────────────────────────────────────────────────────────────────

describe("assemblePdf", () => {
  it("produces a valid PDF header and EOF marker", () => {
    const pdf = assemblePdf("Hello world", "qi-run-1");
    expect(new TextDecoder().decode(pdf.subarray(0, 8))).toBe("%PDF-1.4");
    expect(new TextDecoder().decode(pdf.subarray(-6))).toBe("%%EOF\n");
  });

  it("declares the WinAnsi font encoding so non-ASCII glyphs map correctly", () => {
    const pdf = assemblePdf("body", "qi-run-1");
    expect(includesBytes(pdf, ENC.encode("/BaseFont /Courier /Encoding /WinAnsiEncoding"))).toBe(
      true,
    );
  });

  it("encodes German umlauts, ß and the euro sign as single WinAnsi bytes (no UTF-8 mojibake)", () => {
    const pdf = assemblePdf("ä ö ü Ä Ö Ü ß kostet 5€", "qi-run-1");
    // WinAnsi single bytes: ä=0xE4 ö=0xF6 ü=0xFC Ä=0xC4 Ö=0xD6 Ü=0xDC ß=0xDF €=0x80.
    for (const b of [0xe4, 0xf6, 0xfc, 0xc4, 0xd6, 0xdc, 0xdf, 0x80]) {
      expect(pdf.includes(b)).toBe(true);
    }
    // The raw UTF-8 lead byte 0xC3 for Latin-1 letters must NOT appear in a correctly-encoded stream.
    expect(includesBytes(pdf, new Uint8Array([0xc3, 0x9c]))).toBe(false); // Ü in UTF-8
  });

  it("renders the ENTIRE body across multiple pages (no truncation)", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `LINE-${String(i).padStart(4, "0")}`);
    const pdf = assemblePdf(lines.join("\n"), "qi-run-long");
    // A marker well beyond the old 4000-char / single-page cap must still be present.
    expect(includesBytes(pdf, ENC.encode("LINE-0299"))).toBe(true);
    // 302 lines (header + blank + 300) at 52 lines/page → 6 pages.
    expect(includesBytes(pdf, ENC.encode("/Count 6"))).toBe(true);
    const kids = /\/Kids \[([^\]]*)\]/u.exec(new TextDecoder().decode(pdf))?.[1] ?? "";
    expect(kids.match(/\d+ 0 R/gu)?.length).toBe(6);
  });

  it("keeps a single page for short content", () => {
    const pdf = assemblePdf("one line", "qi-run-1");
    expect(includesBytes(pdf, ENC.encode("/Count 1"))).toBe(true);
  });

  it("is byte-deterministic for identical input", () => {
    const a = assemblePdf("same body\nwith €", "qi-run-x");
    const b = assemblePdf("same body\nwith €", "qi-run-x");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("declares each content stream /Length equal to its actual stream byte length", () => {
    const pdf = assemblePdf("Maßnahme €€€", "qi-run-1");
    const text = new TextDecoder("latin1").decode(pdf);
    const m = /\/Length (\d+) >>\nstream\n/u.exec(text);
    expect(m).not.toBeNull();
    const declared = Number(m?.[1]);
    const streamStart = (m?.index ?? 0) + (m?.[0].length ?? 0);
    const streamEnd = text.indexOf("\nendstream", streamStart);
    expect(streamEnd - streamStart).toBe(declared);
  });

  it("escapes PDF-special characters in the body", () => {
    const pdf = assemblePdf("a (paren) and a \\backslash", "qi-run-1");
    const text = new TextDecoder("latin1").decode(pdf);
    expect(text).toContain("\\(paren\\)");
    expect(text).toContain("\\\\backslash");
  });
});

// ─── ZIP ────────────────────────────────────────────────────────────────────────

describe("assembleZipBundle", () => {
  const entries = [
    { name: "run-1.csv", bytes: ENC.encode("a,b\n1,2") },
    { name: "run-1.md", bytes: ENC.encode("# md") },
    { name: "run-1.txt", bytes: ENC.encode("text") },
  ];

  it("produces a ZIP with the PK local-file signature", () => {
    const zip = assembleZipBundle(entries);
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
  });

  it("lists exactly the supplied entries in the central directory", () => {
    const zip = assembleZipBundle(entries);
    expect(zipCentralNames(zip)).toEqual(["run-1.csv", "run-1.md", "run-1.txt"]);
  });

  it("contains no path-separator or traversal token in any entry name", () => {
    const zip = assembleZipBundle([
      { name: "../../etc/passwd", bytes: ENC.encode("x") },
      { name: "a/b/c.csv", bytes: ENC.encode("y") },
      { name: "..\\..\\win.txt", bytes: ENC.encode("z") },
    ]);
    for (const name of zipCentralNames(zip)) {
      expect(name).not.toContain("/");
      expect(name).not.toContain("\\");
      expect(name).not.toContain("..");
    }
  });

  it("reduces a traversal entry name to its basename", () => {
    const zip = assembleZipBundle([{ name: "../../etc/passwd", bytes: ENC.encode("x") }]);
    expect(zipCentralNames(zip)).toEqual(["passwd"]);
  });

  it("is byte-deterministic for identical input", () => {
    const a = assembleZipBundle(entries);
    const b = assembleZipBundle(entries);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

// ─── safeZipEntryName ────────────────────────────────────────────────────────────

describe("safeZipEntryName", () => {
  it.each([
    ["normal.csv", "normal.csv"],
    ["../../etc/passwd", "passwd"],
    ["a/b/c.csv", "c.csv"],
    ["..\\..\\win.txt", "win.txt"],
    ["qi-run-c268.md", "qi-run-c268.md"],
  ])("maps %s → %s", (input, expected) => {
    expect(safeZipEntryName(input)).toBe(expected);
  });

  it("falls back to export.bin for an empty result", () => {
    expect(safeZipEntryName("///")).toBe("export.bin");
    expect(safeZipEntryName("")).toBe("export.bin");
  });
});

// ─── Issue #721: ZIP full round-trip + CRC-vs-content (mutation-proof) ──────────
//
// These tests parse the assembled ZIP bytes the same way a real extractor does:
//   EOCD → central directory → local header → raw content bytes → CRC32 check.
// The CRC oracle is `node:zlib`'s `crc32`, which is independent of the production
// implementation (different polynomial init path). A mutation to the production CRC
// polynomial, a wrong data-start offset, or a wrong size field all cause failures.

/**
 * Read a little-endian uint16 from a DataView at the given absolute offset.
 * Named helper to make test parsing code self-documenting.
 */
function dvu16(dv: DataView, offset: number): number {
  return dv.getUint16(offset, true);
}

/**
 * Read a little-endian uint32 from a DataView at the given absolute offset.
 */
function dvu32(dv: DataView, offset: number): number {
  return dv.getUint32(offset, true);
}

/**
 * Parse a STORE (no-compression) ZIP buffer and return per-entry integrity facts.
 * Throws if any structural invariant is violated (wrong signature, truncated data).
 *
 * Returns one record per central-directory entry:
 *   - name: entry name decoded as UTF-8
 *   - cdCrc: CRC32 stored in the central-directory record
 *   - localCrc: CRC32 stored in the matching local-file header
 *   - compressedSize: compressed size from CD record
 *   - uncompressedSize: uncompressed size from CD record
 *   - method: compression method from CD record (0 = STORE)
 *   - localMethod: compression method from local header
 *   - content: the raw bytes extracted by following the local header offset
 */
function parseZipEntries(bytes: Uint8Array): {
  name: string;
  cdCrc: number;
  localCrc: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localMethod: number;
  content: Uint8Array;
}[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // ── Locate the End-Of-Central-Directory record ──
  // The EOCD signature is 0x06054b50.  Scan backwards from the last 22 bytes.
  let eocdPos = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dvu32(dv, i) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) throw new Error("EOCD signature not found");

  const entryCount = dvu16(dv, eocdPos + 10); // total entries
  const cdOffset = dvu32(dv, eocdPos + 16); // offset of central directory

  // ── Walk the central directory ──
  const results: ReturnType<typeof parseZipEntries> = [];
  let cdPos = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (dvu32(dv, cdPos) !== 0x02014b50) {
      throw new Error(`Expected central-dir signature at offset ${String(cdPos)}`);
    }
    const method = dvu16(dv, cdPos + 10);
    const cdCrc = dvu32(dv, cdPos + 16);
    const compressedSize = dvu32(dv, cdPos + 20);
    const uncompressedSize = dvu32(dv, cdPos + 24);
    const nameLen = dvu16(dv, cdPos + 28);
    const extraLen = dvu16(dv, cdPos + 30);
    const commentLen = dvu16(dv, cdPos + 32);
    const localOffset = dvu32(dv, cdPos + 42);
    const name = new TextDecoder().decode(bytes.subarray(cdPos + 46, cdPos + 46 + nameLen));

    // ── Follow the local header ──
    if (dvu32(dv, localOffset) !== 0x04034b50) {
      throw new Error(
        `Expected local-file signature (PK\\x03\\x04) at offset ${String(localOffset)} for entry "${name}"`,
      );
    }
    const localMethod = dvu16(dv, localOffset + 8);
    const localCrc = dvu32(dv, localOffset + 14);
    const localNameLen = dvu16(dv, localOffset + 26);
    const localExtraLen = dvu16(dv, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const content = bytes.slice(dataStart, dataStart + compressedSize);

    results.push({
      name,
      cdCrc,
      localCrc,
      compressedSize,
      uncompressedSize,
      method,
      localMethod,
      content,
    });
    cdPos += 46 + nameLen + extraLen + commentLen;
  }
  return results;
}

/**
 * Compute CRC32 over `bytes` using the `node:zlib` implementation as an
 * independent oracle. The production code uses its own hand-rolled CRC32 table;
 * using a different implementation makes the test mutation-proof against:
 *   - wrong polynomial / init / final-xor in the production function
 *   - accidental no-op CRC (always returning 0 or 0xffffffff)
 */
function referenceCrc32(bytes: Uint8Array): number {
  return zlibCrc32(Buffer.from(bytes)) >>> 0;
}

/** Indexed array access that throws instead of yielding `undefined` (noUncheckedIndexedAccess-safe). */
function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) throw new Error(`index ${String(index)} is out of bounds`);
  return value;
}

/** Run a regex against `text` and return the match, throwing if it does not match. */
function execOrThrow(re: RegExp, text: string): RegExpExecArray {
  const match = re.exec(text);
  if (match === null) throw new Error(`pattern ${re.source} did not match`);
  return match;
}

/** Read a capture group (or index 0) from a match, throwing if it is undefined. */
function matchGroup(match: RegExpExecArray, index: number): string {
  const group = match[index];
  if (group === undefined) throw new Error(`capture group ${String(index)} is undefined`);
  return group;
}

describe("assembleZipBundle — Issue #721 full round-trip integrity", () => {
  // ── Fixture A: the existing 3-entry ASCII fixture ──
  const asciiEntries = [
    { name: "run-1.csv", bytes: ENC.encode("a,b\n1,2") },
    { name: "run-1.md", bytes: ENC.encode("# md") },
    { name: "run-1.txt", bytes: ENC.encode("text") },
  ];

  // ── Fixture B: non-ASCII UTF-8 bytes + comma-in-field ──
  // "Maßnahme €" in UTF-8 (multi-byte sequences for ß and €).
  // The comma ensures CSV-field boundaries are not mistaken for ZIP structure.
  const utf8Entries = [
    { name: "report.csv", bytes: ENC.encode('Maßnahme €,"field,with,commas"') },
    { name: "summary.txt", bytes: ENC.encode("Inhalt: äöü") },
  ];

  it("(A) EOCD entry count equals the number of supplied entries", () => {
    // Kills mutation: entry count written as 0, or off-by-one in the EOCD.
    const zip = assembleZipBundle(asciiEntries);
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // Find EOCD by scanning backwards for 0x06054b50.
    let eocdPos = -1;
    for (let i = zip.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocdPos = i;
        break;
      }
    }
    expect(eocdPos).toBeGreaterThanOrEqual(0);
    const totalEntries = dv.getUint16(eocdPos + 10, true);
    expect(totalEntries).toBe(asciiEntries.length);
  });

  it("(A) every central-directory entry carries a PK\\x01\\x02 signature at the CD offset", () => {
    // Kills mutation: wrong centralStart offset stored in EOCD; off-by-one in CD accumulation.
    const zip = assembleZipBundle(asciiEntries);
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let eocdPos = -1;
    for (let i = zip.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocdPos = i;
        break;
      }
    }
    const cdOffset = dv.getUint32(eocdPos + 16, true);
    // First CD entry must start exactly at cdOffset.
    expect(dv.getUint32(cdOffset, true)).toBe(0x02014b50);
  });

  it("(A) each local-file header has PK\\x03\\x04 signature at its CD-declared offset", () => {
    // Kills mutation: wrong localOffset written into CD; data interleaved in wrong order.
    const entries = parseZipEntries(assembleZipBundle(asciiEntries));
    // parseZipEntries throws if the signature is wrong — this it() is the explicit assertion.
    expect(entries).toHaveLength(asciiEntries.length);
  });

  it("(A) extracted content bytes equal the original input for each entry", () => {
    // Kills mutation: content written before header, or data pointer shifted by nameLen.
    const zip = assembleZipBundle(asciiEntries);
    const parsed = parseZipEntries(zip);
    for (let i = 0; i < asciiEntries.length; i++) {
      const expected = at(asciiEntries, i).bytes;
      const actual = at(parsed, i).content;
      expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
    }
  });

  it("(A) compressed size == uncompressed size == original byte length (STORE method, no compression)", () => {
    // Kills mutation: sizes swapped, or one field written from the other post-encoding.
    const zip = assembleZipBundle(asciiEntries);
    const parsed = parseZipEntries(zip);
    for (let i = 0; i < asciiEntries.length; i++) {
      const originalLen = at(asciiEntries, i).bytes.length;
      expect(at(parsed, i).compressedSize).toBe(originalLen);
      expect(at(parsed, i).uncompressedSize).toBe(originalLen);
    }
  });

  it("(A) CRC32 in central directory equals independent oracle CRC32 of the content", () => {
    // Kills mutation: wrong CRC polynomial, wrong init (e.g. 0 instead of 0xffffffff),
    // wrong final-xor, or CRC computed over wrong bytes.
    const zip = assembleZipBundle(asciiEntries);
    const parsed = parseZipEntries(zip);
    for (let i = 0; i < asciiEntries.length; i++) {
      const oracleCrc = referenceCrc32(at(asciiEntries, i).bytes);
      expect(at(parsed, i).cdCrc).toBe(oracleCrc);
    }
  });

  it("(A) CRC32 in local header equals the CRC32 in the central directory", () => {
    // Kills mutation: CRC written to CD but not copied to local header (or vice versa).
    const zip = assembleZipBundle(asciiEntries);
    const parsed = parseZipEntries(zip);
    for (const entry of parsed) {
      expect(entry.localCrc).toBe(entry.cdCrc);
    }
  });

  it("(A) CRC32 in local header equals independent oracle CRC32 of the extracted content", () => {
    // Kills mutation: CRC stored in local header is stale or computed before content is finalized.
    const zip = assembleZipBundle(asciiEntries);
    const parsed = parseZipEntries(zip);
    for (const entry of parsed) {
      const oracleCrc = referenceCrc32(entry.content);
      expect(entry.localCrc).toBe(oracleCrc);
    }
  });

  it("(B) UTF-8 multi-byte entry: extracted content bytes equal the original input", () => {
    // Kills mutation: name-length field corrupted by a multi-byte name → wrong data start offset.
    const zip = assembleZipBundle(utf8Entries);
    const parsed = parseZipEntries(zip);
    expect(parsed).toHaveLength(utf8Entries.length);
    for (let i = 0; i < utf8Entries.length; i++) {
      const expected = at(utf8Entries, i).bytes;
      const actual = at(parsed, i).content;
      expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
    }
  });

  it("(B) UTF-8 multi-byte entry: CRC32 in both headers equals oracle CRC32 of content", () => {
    // Kills mutation: CRC computed over the name bytes instead of content bytes.
    const zip = assembleZipBundle(utf8Entries);
    const parsed = parseZipEntries(zip);
    for (let i = 0; i < utf8Entries.length; i++) {
      const oracleCrc = referenceCrc32(at(utf8Entries, i).bytes);
      expect(at(parsed, i).cdCrc).toBe(oracleCrc);
      expect(at(parsed, i).localCrc).toBe(oracleCrc);
    }
  });

  it("(D) compression method is 0 (STORE) in both central-directory and local headers", () => {
    // Kills mutation: method field written as 8 (DEFLATE) or any non-zero value.
    const zip = assembleZipBundle(asciiEntries);
    const parsed = parseZipEntries(zip);
    for (const entry of parsed) {
      expect(entry.method).toBe(0);
      expect(entry.localMethod).toBe(0);
    }
  });
});

// ─── Issue #721: PDF xref offset resolution (mutation-proof) ────────────────────
//
// Parses the assembled PDF as the Acrobat spec mandates: locate `startxref`,
// jump to that offset, parse the xref table, and for every non-free entry verify
// that the stored byte offset points exactly at the corresponding `N 0 obj` token.
// A wrong offset, a wrong /Size, or a malformed row width all trip an assertion.

describe("assemblePdf — Issue #721 xref offset resolution", () => {
  // Use the 300-line multi-page fixture (6 pages, 16 objects) for maximum coverage.
  const MULTI_PAGE_BODY = Array.from(
    { length: 300 },
    (_, i) => `LINE-${String(i).padStart(4, "0")}`,
  ).join("\n");

  it("(B) bytes at startxref offset are 'xref'", () => {
    // Kills mutation: xrefOffset written as xrefOffset ± 1, or as a wrong value.
    const pdf = assemblePdf(MULTI_PAGE_BODY, "qi-run-long");
    const text = new TextDecoder("latin1").decode(pdf);

    const sxIdx = text.lastIndexOf("startxref\n");
    expect(sxIdx).toBeGreaterThanOrEqual(0);
    const lineEnd = text.indexOf("\n", sxIdx + "startxref\n".length);
    const xrefOffset = parseInt(text.slice(sxIdx + "startxref\n".length, lineEnd), 10);

    expect(Number.isFinite(xrefOffset)).toBe(true);
    expect(text.slice(xrefOffset, xrefOffset + 4)).toBe("xref");
  });

  it("(B) every xref entry's stored offset points exactly at its 'N 0 obj' token", () => {
    // Kills mutation: any single object's offset is wrong by even 1 byte.
    const pdf = assemblePdf(MULTI_PAGE_BODY, "qi-run-long");
    const text = new TextDecoder("latin1").decode(pdf);

    const sxIdx = text.lastIndexOf("startxref\n");
    const lineEnd = text.indexOf("\n", sxIdx + "startxref\n".length);
    const xrefOffset = parseInt(text.slice(sxIdx + "startxref\n".length, lineEnd), 10);

    const xrefText = text.slice(xrefOffset);
    const headerMatch = execOrThrow(/^xref\n0 (\d+)\n/u, xrefText);
    const N = parseInt(matchGroup(headerMatch, 1), 10);

    // Skip the "xref\n0 N\n" header line and the free-head entry (20 bytes each).
    const rowsStart = matchGroup(headerMatch, 0).length + 20; // past free head

    for (let i = 1; i < N; i++) {
      // Each row is 19 chars + '\n' = 20 bytes in the decoded latin1 string.
      const rowIdx = rowsStart + (i - 1) * 20;
      const row = xrefText.slice(rowIdx, rowIdx + 20);
      const objOffset = parseInt(row.slice(0, 10), 10);

      // The token at that byte offset must be "i 0 obj".
      expect(text.slice(objOffset, objOffset + `${String(i)} 0 obj`.length)).toBe(
        `${String(i)} 0 obj`,
      );
    }
  });

  it("(B) trailer /Size equals the total object count (N-including-free-head)", () => {
    // Kills mutation: /Size off by one (e.g. maxObjNum instead of maxObjNum + 1).
    const pdf = assemblePdf(MULTI_PAGE_BODY, "qi-run-long");
    const text = new TextDecoder("latin1").decode(pdf);

    // Parse N from the xref header.
    const xrefIdx = text.lastIndexOf("\nxref\n") + 1;
    const headerMatch = execOrThrow(/^xref\n0 (\d+)\n/u, text.slice(xrefIdx));
    const N = parseInt(matchGroup(headerMatch, 1), 10);

    // /Size in the trailer must equal N.
    const trailerMatch = execOrThrow(/\/Size (\d+)/u, text);
    expect(parseInt(matchGroup(trailerMatch, 1), 10)).toBe(N);
  });

  it("(B) every xref entry row is exactly 20 bytes (19 chars + LF) ending with a newline", () => {
    // Kills mutation: row format uses CR+LF (21 bytes) or omits trailing space (19 bytes).
    const pdf = assemblePdf(MULTI_PAGE_BODY, "qi-run-long");
    const text = new TextDecoder("latin1").decode(pdf);

    const xrefIdx = text.lastIndexOf("\nxref\n") + 1;
    const xrefText = text.slice(xrefIdx);
    const headerMatch = execOrThrow(/^xref\n0 (\d+)\n/u, xrefText);
    const N = parseInt(matchGroup(headerMatch, 1), 10);
    const rowsStart = matchGroup(headerMatch, 0).length; // points at free head
    // N rows total (1 free + N-1 real).
    for (let i = 0; i < N; i++) {
      const row = xrefText.slice(rowsStart + i * 20, rowsStart + i * 20 + 20);
      expect(row).toHaveLength(20);
      expect(row[19]).toBe("\n");
    }
  });

  it("(B) single-page PDF also has correct xref offset resolving to '1 0 obj'", () => {
    // Kills mutation: offset logic correct for multi-page but broken for single-page edge case.
    const pdf = assemblePdf("one line", "qi-run-1");
    const text = new TextDecoder("latin1").decode(pdf);

    const sxIdx = text.lastIndexOf("startxref\n");
    const lineEnd = text.indexOf("\n", sxIdx + "startxref\n".length);
    const xrefOffset = parseInt(text.slice(sxIdx + "startxref\n".length, lineEnd), 10);

    expect(text.slice(xrefOffset, xrefOffset + 4)).toBe("xref");

    // Object 1 must reside at the offset declared in xref row 1.
    const xrefText = text.slice(xrefOffset);
    const headerMatch = execOrThrow(/^xref\n0 (\d+)\n/u, xrefText);
    const rowsStart = matchGroup(headerMatch, 0).length + 20; // skip free head
    const firstRow = xrefText.slice(rowsStart, rowsStart + 20);
    const obj1Offset = parseInt(firstRow.slice(0, 10), 10);
    expect(text.slice(obj1Offset, obj1Offset + "1 0 obj".length)).toBe("1 0 obj");
  });
});

// ─── Issue #721: PDF multi-page /Length verification (mutation-proof) ───────────
//
// The existing test "declares each content stream /Length equal to its actual
// stream byte length" only checks the FIRST regex match. These tests explicitly
// iterate ALL matches so pages 2+ are verified, and so any single-page /Length
// discrepancy causes a failure.

describe("assemblePdf — Issue #721 multi-page /Length consistency", () => {
  it("(C) ALL stream /Length declarations match the actual byte distance to endstream", () => {
    // Kills mutation: /Length wrong for any page after page 1 (first-match-only blind spot).
    // Also kills: off-by-one in buildPageContent's accumulated length.
    const lines = Array.from({ length: 300 }, (_, i) => `LINE-${String(i).padStart(4, "0")}`).join(
      "\n",
    );
    const pdf = assemblePdf(lines, "qi-run-long");
    const text = new TextDecoder("latin1").decode(pdf);

    const re = /\/Length (\d+) >>\nstream\n/gu;
    let m: RegExpExecArray | null;
    const mismatches: { page: number; declared: number; actual: number }[] = [];
    let pageIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const declared = parseInt(matchGroup(m, 1), 10);
      const streamStart = m.index + matchGroup(m, 0).length;
      const streamEnd = text.indexOf("\nendstream", streamStart);
      expect(streamEnd).toBeGreaterThan(streamStart); // endstream must exist
      const actual = streamEnd - streamStart;
      if (actual !== declared) {
        mismatches.push({ page: pageIndex, declared, actual });
      }
      pageIndex++;
    }
    // At least 6 pages must exist in the 300-line fixture.
    expect(pageIndex).toBeGreaterThanOrEqual(6);
    // Every page's /Length must be exact.
    expect(mismatches).toEqual([]);
  });

  it("(C) single-page /Length is correct (baseline)", () => {
    // Complements the multi-page test; ensures the test itself is not vacuously passing.
    const pdf = assemblePdf("Maßnahme €€€", "qi-run-1");
    const text = new TextDecoder("latin1").decode(pdf);

    const re = /\/Length (\d+) >>\nstream\n/gu;
    const m = execOrThrow(re, text);
    const declared = parseInt(matchGroup(m, 1), 10);
    const streamStart = m.index + matchGroup(m, 0).length;
    const streamEnd = text.indexOf("\nendstream", streamStart);
    expect(streamEnd - streamStart).toBe(declared);

    // Confirm there is only one stream in a single-page document.
    expect(re.exec(text)).toBeNull();
  });

  it("(C) two-page PDF has both pages' /Length correct", () => {
    // Specifically targets pages 2+ being mutation-blind in the existing single-match test.
    // 53 lines → 1 page (52 lines/page) + 1 overflow line on page 2.
    const body = Array.from({ length: 53 }, (_, i) => `L${String(i)}`).join("\n");
    const pdf = assemblePdf(body, "qi-run-2p");
    const text = new TextDecoder("latin1").decode(pdf);

    const re = /\/Length (\d+) >>\nstream\n/gu;
    const matches: { declared: number; actual: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const declared = parseInt(matchGroup(m, 1), 10);
      const streamStart = m.index + matchGroup(m, 0).length;
      const streamEnd = text.indexOf("\nendstream", streamStart);
      matches.push({ declared, actual: streamEnd - streamStart });
    }
    expect(matches).toHaveLength(2);
    for (const { declared, actual } of matches) {
      expect(actual).toBe(declared);
    }
  });
});
