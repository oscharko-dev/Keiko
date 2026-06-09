// Direct unit tests for the binary export assembly helpers (Epic #711, Issue #721).
//
// Covers the properties the route-level tests cannot reach precisely: PDF pagination (the whole
// body is rendered, not a single truncated page), WinAnsi single-byte encoding of non-ASCII
// (German umlauts / euro sign render correctly, not as UTF-8 mojibake), ZIP entry-name containment
// (no traversal), parsed ZIP central-directory contents, and byte-determinism of both formats.

import { describe, expect, it } from "vitest";
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
