import { describe, expect, it } from "vitest";
import { decodeUtf8, decodeXmlEntities } from "./_internal.js";

// UTF-16 LE/BE byte builders for ASCII text (each code unit is 2 bytes).
function utf16le(text: string, withBom = true): Uint8Array {
  const out: number[] = withBom ? [0xff, 0xfe] : [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    out.push(cp & 0xff, (cp >> 8) & 0xff);
  }
  return Uint8Array.from(out);
}
function utf16be(text: string, withBom = true): Uint8Array {
  const out: number[] = withBom ? [0xfe, 0xff] : [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    out.push((cp >> 8) & 0xff, cp & 0xff);
  }
  return Uint8Array.from(out);
}

describe("decodeUtf8 (GRD-012)", () => {
  it("decodes UTF-16 LE (BOM FF FE) instead of producing mojibake", () => {
    const decoded = decodeUtf8(utf16le("hello"));
    expect(decoded.text).toBe("hello");
    expect(decoded.bomBytes).toBe(2);
  });

  it("decodes UTF-16 BE (BOM FE FF)", () => {
    const decoded = decodeUtf8(utf16be("Geschäft"));
    expect(decoded.text).toBe("Geschäft");
    expect(decoded.bomBytes).toBe(2);
  });

  it("does NOT misread UTF-32 LE (FF FE 00 00) as UTF-16 LE", () => {
    // 'A' (0x41) in UTF-32 LE with BOM. Must not be decoded as UTF-16 LE (which would yield
    // 'A' + a NUL). Falls through to the UTF-8 path here; the key assertion is no UTF-16 claim.
    const bytes = Uint8Array.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]);
    const decoded = decodeUtf8(bytes);
    expect(decoded.bomBytes).not.toBe(2);
  });

  it("still strips a UTF-8 BOM and decodes plain UTF-8", () => {
    // TextDecoder('utf-8') consumes the BOM itself, so the visible text is BOM-free.
    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    expect(decodeUtf8(withBom).text).toBe("hi");
    const plain = new TextEncoder().encode("für 日本語");
    expect(decodeUtf8(plain)).toEqual({ text: "für 日本語", bomBytes: 0 });
  });
});

describe("decodeXmlEntities (GRD-027)", () => {
  it("decodes decimal and hex numeric character references", () => {
    expect(decodeXmlEntities("don&#8217;t")).toBe("don\u2019t");
    expect(decodeXmlEntities("caf&#xE9;")).toBe("caf\u00e9");
    expect(decodeXmlEntities("&#x2014;")).toBe("\u2014");
  });

  it("still decodes the five named references", () => {
    expect(decodeXmlEntities("a &lt;b&gt; &quot;c&quot; &apos;d&apos; &amp; e")).toBe(
      "a <b> \"c\" 'd' & e",
    );
  });

  it("does not re-interpret an escaped ampersand as a numeric reference (&amp; decoded last)", () => {
    expect(decodeXmlEntities("&amp;#65;")).toBe("&#65;");
  });

  it("leaves a malformed or out-of-range reference as literal text (never throws)", () => {
    expect(decodeXmlEntities("&#xZZ;")).toBe("&#xZZ;");
    expect(decodeXmlEntities("&#999999999;")).toBe("&#999999999;");
    // A lone surrogate code point is invalid → left literal.
    expect(decodeXmlEntities("&#xD800;")).toBe("&#xD800;");
  });
});
