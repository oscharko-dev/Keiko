// Regression pins for #4235: the shared decode, binary-evidence and format-selection rules of the
// text-like parsers (html, json, code, text) and the OCR pipeline. Synthetic bytes only.

import { describe, expect, it } from "vitest";

import { MAX_TEXT_DECODE_BYTES, decodeBytes } from "./_internal.js";
import { codeParser } from "./code-parser.js";
import { createDefaultParserRegistry } from "./index.js";
import { htmlParser } from "./html-parser.js";
import { jsonParser } from "./json-parser.js";
import { createOcrPipelineParser } from "./ocr/ocr-pipeline-parser.js";
import { nullOcrAdapter } from "./ocr/null-ocr-adapter.js";
import { buildParserOptions } from "./registry.js";
import { encode, selectionFromBytes, selectionFromText } from "./parser-test-fixtures.js";
import { textParser } from "./text-parser.js";
import type { InternalParserResult, ParserAdapter, ParserSelectionInput } from "./types.js";

const OPTIONS = buildParserOptions({ now: () => 0 });

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function parseWith(adapter: ParserAdapter, input: ParserSelectionInput): InternalParserResult {
  return adapter.parse(input, OPTIONS);
}

function resolveAndParse(input: ParserSelectionInput): {
  readonly parserId: string;
  readonly result: InternalParserResult;
} {
  const registry = createDefaultParserRegistry({ ocrAdapter: nullOcrAdapter });
  const resolution = registry.resolve(input);
  if (resolution.kind !== "matched") throw new Error("expected a matched adapter");
  return {
    parserId: resolution.adapter.capability.parserId,
    result: parseWith(resolution.adapter, input),
  };
}

describe("decodeBytes: mixed and mis-declared encodings (#4235 F7)", () => {
  const UTF8_BODY = "Größe Straße Übersicht ".repeat(200);

  it("decodes a mostly UTF-8 document with one stray byte without corrupting the rest", () => {
    const bytes = concat(encode(UTF8_BODY), Uint8Array.of(0xe4), encode(" Ende"));
    const decoded = decodeBytes(bytes);
    expect(decoded.text.startsWith("Größe Straße Übersicht")).toBe(true);
    expect(decoded.text).not.toContain("Ã");
    expect(decoded.text.endsWith("ä Ende")).toBe(true);
    expect(decoded.repairedBytes).toBe(1);
  });

  it("ignores a declared UTF-8 label for bytes that are not UTF-8 and reports the real codec", () => {
    const bytes = Uint8Array.of(0x47, 0x72, 0xf6, 0xdf, 0x65); // "Gr" + ö ß + "e" in windows-1252
    const decoded = decodeBytes(bytes, "utf-8");
    expect(decoded.text).toBe("Größe");
    expect(decoded.codec).toBe("windows-1252");
  });

  it("still honours a declared non-UTF-8 charset the runtime supports", () => {
    const bytes = Uint8Array.of(0x82, 0xa0); // Shift_JIS hiragana A
    const decoded = decodeBytes(bytes, "shift_jis");
    expect(decoded.text).toBe("あ");
    expect(decoded.codec).toBe("shift_jis");
  });

  it("leaves valid UTF-8 untouched and reports no repair", () => {
    const decoded = decodeBytes(encode("Größe"));
    expect(decoded.text).toBe("Größe");
    expect(decoded.repairedBytes).toBeUndefined();
  });
});

describe("html parser reports a charset that the bytes contradict (#4235 F7)", () => {
  it("emits HTML_CHARSET_MISMATCH for a declared UTF-8 page that holds windows-1252 bytes", () => {
    const html = concat(
      encode('<html><head><meta charset="utf-8"></head><body><p>Gr'),
      Uint8Array.of(0xf6, 0xdf),
      encode("e</p></body></html>"),
    );
    const result = parseWith(htmlParser, selectionFromBytes(html, { extension: "html" }));
    expect(result.normalizedText).toContain("Größe");
    expect(result.diagnostics.map((entry) => entry.code)).toContain("HTML_CHARSET_MISMATCH");
  });

  it("reports repaired stray bytes of an otherwise UTF-8 text file", () => {
    const bytes = concat(encode("Größe und Maße ".repeat(50)), Uint8Array.of(0xfc), encode("x"));
    const result = parseWith(textParser, selectionFromBytes(bytes, { extension: "txt" }));
    expect(result.normalizedText).not.toContain("Ã");
    const codes = result.diagnostics.map((entry) => entry.code);
    expect(codes).toContain("ENCODING_REPAIRED");
    expect(JSON.stringify(result.diagnostics)).not.toContain("Größe");
  });
});

describe("binary content is not indexed as text (#4235 F12)", () => {
  const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d);
  const ZIP = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0);
  const PDF = encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n");

  it.each([
    ["txt", PNG, "image-not-supported"],
    ["txt", ZIP, "archive-not-decompressed"],
    ["html", PDF, "pdf-not-implemented"],
    ["md", PNG, "image-not-supported"],
  ])("refuses a .%s file whose bytes are %#", (extension, bytes, reason) => {
    const { result } = resolveAndParse(selectionFromBytes(bytes, { extension }));
    expect(result.units).toEqual([
      { kind: "unsupported-media", documentId: result.documentId, reason },
    ]);
    expect(result.normalizedText).toBeUndefined();
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["UNSUPPORTED_FORMAT"]);
  });

  it.each([
    ["text", textParser, "txt"],
    ["html", htmlParser, "html"],
    ["json", jsonParser, "json"],
    ["code", codeParser, "py"],
  ])("the %s parser refuses NUL-bearing binary content on its own", (_name, adapter, extension) => {
    const bytes = concat(encode("header "), Uint8Array.of(0, 1, 2, 0, 0), encode(" tail"));
    const result = parseWith(adapter, selectionFromBytes(bytes, { extension }));
    expect(result.units.map((unit) => unit.kind)).toEqual(["unsupported-media"]);
    expect(result.normalizedText).toBeUndefined();
  });

  it("reads on past a NUL inside markup, as the HTML standard does", () => {
    const bytes = encode("\uFEFF \n<p>a\u0000b</p>");
    const result = parseWith(htmlParser, selectionFromBytes(bytes, { extension: "html" }));

    expect(result.units.map((unit) => unit.kind)).not.toContain("unsupported-media");
    expect(result.normalizedText).toBe("a b");
  });

  it("still refuses mostly control bytes that merely begin with a tag", () => {
    const bytes = concat(encode("<a>"), new Uint8Array(40));
    const result = parseWith(htmlParser, selectionFromBytes(bytes, { extension: "html" }));

    expect(result.units.map((unit) => unit.kind)).toEqual(["unsupported-media"]);
  });

  it("does not mistake UTF-16 text (NUL bytes by construction) for binary", () => {
    const bom = Uint8Array.of(0xff, 0xfe);
    const body = new Uint8Array(Array.from("Anforderung").flatMap((c) => [c.charCodeAt(0), 0]));
    const result = parseWith(
      textParser,
      selectionFromBytes(concat(bom, body), { extension: "txt" }),
    );
    expect(result.normalizedText).toBe("Anforderung");
  });

  it("keeps ordinary text with a UTF-8 BOM and CRLF line ends as text", () => {
    const bytes = concat(Uint8Array.of(0xef, 0xbb, 0xbf), encode("a\r\nb\r\n"));
    const result = parseWith(textParser, selectionFromBytes(bytes, { extension: "txt" }));
    expect(result.units[0]?.kind).toBe("section");
  });
});

describe("OCR magic bytes do not hijack text files (#4235 F4)", () => {
  it.each([
    ["md", "BMW-Anforderungen\nREQ-1: Der Wagen muss fahren.\n"],
    ["txt", "BMI-Rechner: Das Ergebnis wird angezeigt.\n"],
    ["py", "BMS = 1\nGIF8 = 2\n"],
    ["txt", "GIF8 ist kein Bild.\n"],
  ])("routes a .%s file that starts with image-like letters to its text parser", (ext, text) => {
    const { parserId, result } = resolveAndParse(selectionFromText(text, { extension: ext }));
    expect(parserId).not.toBe("ocr-pipeline");
    expect(result.units.every((unit) => unit.kind !== "unsupported-media")).toBe(true);
    expect(result.normalizedText).toBe(text);
  });

  it("does not take two ASCII letters for a bitmap even without an extension", () => {
    const capability = createOcrPipelineParser(nullOcrAdapter).capability;
    expect(capability.matches(selectionFromBytes(encode("BMW-Anforderungen\n")))).toBe(false);
    expect(capability.matches(selectionFromBytes(encode("GIF8 ist kein Bild")))).toBe(false);
  });

  it("still recognises a real bitmap header, a real GIF and a PNG without an extension", () => {
    const capability = createOcrPipelineParser(nullOcrAdapter).capability;
    const bmp = new Uint8Array(32);
    bmp.set([0x42, 0x4d, 0x20, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, 0x28, 0, 0, 0]);
    expect(capability.matches(selectionFromBytes(bmp))).toBe(true);
    expect(capability.matches(selectionFromBytes(encode("GIF89a\x01\x00\x01\x00")))).toBe(true);
    expect(
      capability.matches(
        selectionFromBytes(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
      ),
    ).toBe(true);
  });

  it("keeps a text-looking prefix away from the unsupported sentinel too", () => {
    const registry = createDefaultParserRegistry();
    const text = registry.resolve(selectionFromBytes(encode("BMW-Anforderungen\n")));
    expect(text.kind === "matched" ? text.adapter.capability.parserId : "none").not.toBe(
      "unsupported",
    );
  });
});

describe("well-known files without an extension are text (#4235 F15)", () => {
  function named(text: string, fileName: string): ParserSelectionInput {
    return { ...selectionFromText(text, { extension: "", mediaType: "" }), fileName };
  }

  it.each(["README", "LICENSE", "Makefile", "Dockerfile", "readme", "CODEOWNERS"])(
    "accepts %s content as text",
    (name) => {
      const text = `${name}\nbuild:\n\tmake all\n`;
      const { parserId, result } = resolveAndParse(named(text, name));
      expect(parserId).toBe("text");
      expect(result.normalizedText).toBe(text);
    },
  );

  it.each([".gitignore", ".env", ".npmrc", "id_rsa", "data"])(
    "does not claim the arbitrary extension-less file %s",
    (name) => {
      const registry = createDefaultParserRegistry();
      expect(registry.resolve(named("key=value\n", name)).kind).toBe("unsupported");
    },
  );

  it("does not claim a named file whose bytes are binary", () => {
    const registry = createDefaultParserRegistry();
    const input = {
      ...selectionFromBytes(Uint8Array.of(1, 2, 0, 0, 3, 4, 0, 5), { extension: "" }),
      fileName: "README",
    };
    const resolution = registry.resolve(input);
    expect(
      resolution.kind === "matched" ? resolution.adapter.capability.parserId : "none",
    ).not.toBe("text");
  });

  it("does not claim an extension-less file the caller could not name", () => {
    const registry = createDefaultParserRegistry();
    const resolution = registry.resolve(
      selectionFromText("text\n", { extension: "", mediaType: "" }),
    );
    expect(resolution.kind).toBe("unsupported");
  });
});

describe("input too large for one string is refused, not thrown (#4235)", () => {
  // The guard reads `byteLength` only, so a small buffer with a spoofed length proves it without
  // allocating half a gigabyte.
  function oversized(byteLength: number, extension: string): ParserSelectionInput {
    const bytes = encode("x");
    Object.defineProperty(bytes, "byteLength", { value: byteLength });
    return selectionFromBytes(bytes, { extension });
  }

  // JSON has a ceiling of its own (256 MiB) below the engine's string length.
  const limitOf = (name: string): number =>
    name === "json" ? 256 * 1024 * 1024 : MAX_TEXT_DECODE_BYTES;

  it.each([
    ["text", textParser, "txt"],
    ["html", htmlParser, "html"],
    ["json", jsonParser, "json"],
    ["code", codeParser, "py"],
  ])("the %s parser refuses an input beyond the engine's string length", (_name, adapter, ext) => {
    const options = buildParserOptions({ now: () => 0, maxBytes: Number.MAX_SAFE_INTEGER });
    const result = adapter.parse(oversized(MAX_TEXT_DECODE_BYTES + 1, ext), options);
    expect(result.units).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("OVERSIZED_FILE");
    expect(result.diagnostics[0]?.message).toContain(String(limitOf(_name)));
  });

  it("refuses JSON beyond its own ceiling while text of that size is still read", () => {
    const options = buildParserOptions({ now: () => 0, maxBytes: Number.MAX_SAFE_INTEGER });
    const size = 300 * 1024 * 1024;
    expect(jsonParser.parse(oversized(size, "json"), options).diagnostics[0]?.code).toBe(
      "OVERSIZED_FILE",
    );
    expect(
      textParser.parse(oversized(size, "txt"), options).diagnostics.map((d) => d.code),
    ).not.toContain("OVERSIZED_FILE");
  });
});

describe("a unit cap that drops content is a warning (#4235)", () => {
  const capped = buildParserOptions({ now: () => 0, maxUnitsPerDocument: 2 });

  it.each([
    ["html", htmlParser, "html", "<p>a</p><p>b</p><p>c</p><p>d</p>"],
    ["markdown", textParser, "md", "# a\n\n# b\n\n# c\n\n# d\n"],
    [
      "code",
      codeParser,
      "ts",
      "function a(): void {}\nfunction b(): void {}\nfunction c(): void {}\n",
    ],
  ])("the %s parser reports UNIT_LIMIT_REACHED as a warning", (_name, adapter, extension, text) => {
    const result = adapter.parse(selectionFromText(text, { extension }), capped);
    const entry = result.diagnostics.find((item) => item.code === "UNIT_LIMIT_REACHED");
    expect(entry?.severity).toBe("warning");
  });
});
