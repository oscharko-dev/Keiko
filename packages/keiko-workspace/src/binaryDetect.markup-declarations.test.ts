import { describe, expect, it } from "vitest";
import { decodeTextFileBytes } from "./binaryDetect.js";

function decodedLegacy(
  markup: string,
  scopePath = "manual.html",
): ReturnType<typeof decodeTextFileBytes> {
  return decodeTextFileBytes(Buffer.from(markup, "latin1"), {
    scopePath,
    requireSupportedEncoding: true,
  });
}

describe("bounded actual markup encoding declarations", () => {
  it.each(["windows-1252", "ISO-8859-1", "latin1"])(
    "decodes an XHTML XML declaration using %s",
    (label) => {
      const text = `<?xml version="1.0" encoding="${label}"?>\n<html><p>Ölwechsel 937</p></html>`;
      expect(decodedLegacy(text, "manual.xhtml")).toEqual({ encoding: "windows-1252", text });
    },
  );

  it.each([
    "<script>const sample = '<meta charset=\"utf-8\">';</script>",
    '<SCRIPT type="text/javascript">const sample = \'<meta charset="unknown-codec">\';</SCRIPT>',
    "<style>body::before { content: '<meta charset=\"utf-8\">'; }</style>",
    '<textarea><meta charset="utf-8"></textarea>',
    '<title>Example <meta charset="utf-8"></title>',
    "<div title='<meta charset=\"utf-8\">'>Example</div>",
    "<div title=\"<meta charset='unknown-codec'>\">Example</div>",
    '<div title="<!--" data-example=\'<meta charset="utf-8">\'>Example</div>',
  ])("ignores pseudo metadata before the actual declaration (%#)", (prefix) => {
    const text = `${prefix}\n<meta charset="windows-1252">\n<p>Ölwechsel 937</p>`;
    expect(decodedLegacy(text)).toEqual({ encoding: "windows-1252", text });
  });

  it.each([
    '<!-- <meta charset="unknown-codec"> -->',
    '<![CDATA[<meta charset="unknown-codec">]]>',
    "<script>const sample = '<meta charset=\"unknown-codec\">';</script>",
    "<div title='<meta charset=\"unknown-codec\">'>Example</div>",
  ])("preserves default UTF-8 when no actual declaration exists (%#)", (prefix) => {
    const text = `${prefix}\n<p>Ölwechsel 中文</p>`;
    expect(decodeTextFileBytes(Buffer.from(text), { scopePath: "manual.xhtml" })).toEqual({
      encoding: "utf-8",
      text,
    });
  });

  it("keeps the XHTML XML declaration ahead of contradictory HTML metadata", () => {
    const text = '<?xml version="1.0" encoding="windows-1252"?><meta charset="utf-8">Öl';
    expect(decodedLegacy(text, "manual.xhtml")).toEqual({ encoding: "windows-1252", text });
  });

  it.each(['"', "'"])("preserves a valid UTF-8 XML declaration with %s quotes", (quote) => {
    const text = `<?xml version=${quote}1.0${quote} encoding=${quote}UTF-8${quote}?><p>Öl 中文</p>`;
    expect(decodeTextFileBytes(Buffer.from(text), { scopePath: "manual.xhtml" })).toEqual({
      encoding: "utf-8",
      text,
    });
  });

  it.each(["manual.html", "manual.txt"])("does not apply XML codecs to %s", (scopePath) => {
    const text = '<?xml version="1.0" encoding="windows-1252"?><p>Öl</p>';
    expect(decodedLegacy(text, scopePath)).toBeUndefined();
  });

  it.each([
    '<!-- <?xml version="1.0" encoding="windows-1252"?> -->',
    '<p><?xml version="1.0" encoding="windows-1252"?></p>',
    '<?xml version="1.0" encoding="windows-1252"',
  ])("does not accept an absent or incomplete initial XML declaration (%#)", (prefix) => {
    expect(decodedLegacy(`${prefix}<p>Öl</p>`, "manual.xhtml")).toBeUndefined();
  });

  it("fails closed for an actual unsupported XHTML codec", () => {
    expect(() =>
      decodedLegacy('<?xml version="1.0" encoding="unknown-codec"?><p>Öl</p>', "manual.xhtml"),
    ).toThrow("declared text encoding is unavailable");
  });

  it("keeps the byte-order mark authoritative over XML metadata", () => {
    const text = '<?xml version="1.0" encoding="unknown-codec"?><p>Öl 中文</p>';
    for (const codec of ["utf8", "utf16le"] as const) {
      expect(
        decodeTextFileBytes(Buffer.from(`\uFEFF${text}`, codec), {
          scopePath: "manual.xhtml",
          requireSupportedEncoding: true,
        })?.text,
      ).toBe(text);
    }
  });

  it("does not recognize a declaration completed beyond byte 1024", () => {
    const text = `<?xml version="1.0" ${" ".repeat(1024)}encoding="windows-1252"?><p>Öl</p>`;
    expect(decodedLegacy(text, "manual.xhtml")).toBeUndefined();
  });

  it("does not promote a lookalike raw-text closing tag", () => {
    const text =
      '<script>"</scripture><meta charset=\'unknown-codec\'>";</script><meta charset="windows-1252">Öl';
    expect(decodedLegacy(text)).toEqual({ encoding: "windows-1252", text });
  });

  it("recognizes an actual declaration after an XHTML self-closing script", () => {
    const text = '<script/><meta charset="windows-1252">Öl';
    expect(decodedLegacy(text, "manual.xhtml")).toEqual({ encoding: "windows-1252", text });
  });

  it("does not treat an HTML script slash as a self-closing XML element", () => {
    const text = '<script/><meta charset="unknown-codec"></script><meta charset="windows-1252">Öl';
    expect(decodedLegacy(text)).toEqual({ encoding: "windows-1252", text });
  });

  it.each([
    '<!-- <meta charset="unknown-codec">',
    "<script>const sample = '<meta charset=\"unknown-codec\">';",
    '<div title=\'<meta charset="unknown-codec">',
  ])("does not grant a declaration in unfinished markup (%#)", (prefix) => {
    const text = `${prefix}\n<p>Öl 中文</p>`;
    expect(decodeTextFileBytes(Buffer.from(text), { scopePath: "manual.html" })).toEqual({
      encoding: "utf-8",
      text,
    });
  });
});
