import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BINARY_PROBE,
  decodeTextBytes,
  decodeTextFileBytes,
  detectTextByteEncoding,
  looksBinary,
} from "./binaryDetect.js";

describe("looksBinary", () => {
  it.each([
    { bytes: new Uint8Array(), encoding: "utf-8" },
    { bytes: new Uint8Array([0xef, 0xbb, 0xbf]), encoding: "utf-8" },
    { bytes: new Uint8Array([0xff, 0xfe]), encoding: "utf-16le" },
    { bytes: new Uint8Array([0xfe, 0xff]), encoding: "utf-16be" },
  ])("admits empty decoded text with $encoding encoding", ({ bytes, encoding }) => {
    expect(decodeTextFileBytes(bytes)).toEqual({ encoding, text: "" });
  });

  it("returns false on empty input", () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });

  it("returns false on a single text byte", () => {
    expect(looksBinary(new TextEncoder().encode("A"))).toBe(false);
  });

  it("returns false on UTF-8 multi-byte content", () => {
    expect(looksBinary(new TextEncoder().encode("é"))).toBe(false);
  });

  it.each(["\0", "\0".repeat(5), "\u0001".repeat(20)])(
    "classifies binary payload behind a UTF-8 BOM consistently with complete decoding (%#)",
    (payload) => {
      const bytes = Buffer.from(`\uFEFF${payload}`, "utf8");
      expect(looksBinary(bytes)).toBe(true);
      expect(decodeTextFileBytes(bytes)).toBeUndefined();
    },
  );

  it("preserves a BOM-prefixed valid multibyte sequence crossing the probe boundary", () => {
    const bytes = Buffer.from(`\uFEFF${"x".repeat(4092)}中`);
    expect(looksBinary(bytes)).toBe(false);
    expect(decodeTextFileBytes(bytes)?.text).toBe(`${"x".repeat(4092)}中`);
  });

  it("returns false on plain ASCII text", () => {
    expect(looksBinary(new TextEncoder().encode("hello world\nsecond line\n"))).toBe(false);
  });

  it.each([
    {
      title: "returns false when a single embedded NUL appears in otherwise textual content",
      length: 64,
      nulIndex: 3,
    },
    { title: "does not classify a sparse NUL at byte 511 as binary", length: 512, nulIndex: 511 },
    { title: "does not classify a sparse NUL at byte 600 as binary", length: 800, nulIndex: 600 },
  ])("$title", ({ length, nulIndex }) => {
    const bytes = new Uint8Array(length);
    bytes.fill(0x41);
    bytes[nulIndex] = 0;
    expect(looksBinary(bytes)).toBe(false);
  });

  it("still treats dense control bytes as binary", () => {
    const bytes = new Uint8Array(100);
    bytes.fill(0x41);
    for (let i = 0; i < 9; i += 1) {
      bytes[i] = 0;
    }
    expect(looksBinary(bytes)).toBe(true);
  });

  it("applies the control-byte ratio only inside the configured probe", () => {
    const bytes = new Uint8Array(800);
    bytes.fill(0x41);
    for (let i = 600; i < 700; i += 1) {
      bytes[i] = 0;
    }
    expect(looksBinary(bytes, { maxProbeBytes: 512 })).toBe(false);
    expect(looksBinary(bytes, { maxProbeBytes: 700 })).toBe(true);
  });

  it("returns true for an all-NUL buffer", () => {
    expect(looksBinary(new Uint8Array(16))).toBe(true);
  });

  it("respects a probe smaller than the buffer length", () => {
    const bytes = new Uint8Array(20);
    bytes.fill(0x41);
    for (let i = 12; i < 20; i += 1) {
      bytes[i] = 0;
    }
    expect(looksBinary(bytes, { maxProbeBytes: 8 })).toBe(false);
    expect(looksBinary(bytes, { maxProbeBytes: 16 })).toBe(true);
  });

  it("recognizes UTF-16LE source bytes with a BOM as text", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x65, 0x00, 0x78, 0x00, 0x70, 0x00]);
    expect(detectTextByteEncoding(bytes)).toBe("utf-16le");
    expect(looksBinary(bytes)).toBe(false);
    expect(decodeTextBytes(bytes)?.text).toBe("exp");
  });

  it("recognizes UTF-16BE source bytes without a BOM by NUL parity", () => {
    const bytes = new Uint8Array([0x00, 0x63, 0x00, 0x6c, 0x00, 0x61, 0x00, 0x73, 0x00, 0x73]);
    expect(detectTextByteEncoding(bytes)).toBe("utf-16be");
    expect(looksBinary(bytes)).toBe(false);
    expect(decodeTextBytes(bytes)?.text).toBe("class");
  });

  it("does not trim invalid trailing bytes unless the caller declares a capped read", () => {
    const bytes = new Uint8Array([0x65, 0x78, 0x70, 0xc3]);
    expect(decodeTextBytes(bytes)).toBeUndefined();
    expect(decodeTextBytes(bytes, "utf-8", { allowIncompleteTail: true })?.text).toBe("exp");
  });

  it("exposes a frozen default probe of 4096 bytes", () => {
    expect(DEFAULT_BINARY_PROBE.maxProbeBytes).toBe(4096);
  });

  it("treats UTF-16LE text with BOM as text despite NUL bytes", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x63, 0x00, 0x6c, 0x00, 0x61, 0x00, 0x73, 0x00]);
    expect(looksBinary(bytes)).toBe(false);
  });

  it("treats UTF-16LE-shaped text without BOM as text", () => {
    const bytes = new Uint8Array([0x63, 0x00, 0x6c, 0x00, 0x61, 0x00, 0x73, 0x00, 0x73, 0x00]);
    expect(looksBinary(bytes)).toBe(false);
  });
});

describe("declared HTML character encoding", () => {
  const legacy = (markup: string): Uint8Array => Buffer.from(markup, "latin1");
  it.each(["", "  "])("ignores an empty first charset before valid UTF-8 (%j)", (empty) => {
    const text = `<meta charset="${empty}"><meta charset="utf-8"><p>Ölwechsel 中文</p>`;
    expect(
      decodeTextFileBytes(Buffer.from(text), {
        scopePath: "manual.html",
        requireSupportedEncoding: true,
      }),
    ).toEqual({ encoding: "utf-8", text });
  });
  it.each(["utf-16", "utf-16le", "utf-16be"])(
    "interprets HTML-only %s metadata as UTF-8 without overriding a real BOM",
    (charset) => {
      const text = `<meta charset="${charset}"><p>Ölwechsel 中文</p>`;
      expect(decodeTextFileBytes(Buffer.from(text), { scopePath: "manual.html" })).toEqual({
        encoding: "utf-8",
        text,
      });
      expect(decodeTextFileBytes(Buffer.from(`\uFEFF${text}`, "utf16le"))).toEqual({
        encoding: "utf-16le",
        text,
      });
    },
  );
  it("does not turn an unsupported nonempty first charset into a fallback codec", () => {
    const bytes = Buffer.from('<meta charset="unavailable-codec"><meta charset="utf-8">safe text');
    expect(() =>
      decodeTextFileBytes(bytes, { scopePath: "manual.html", requireSupportedEncoding: true }),
    ).toThrow("declared text encoding is unavailable");
  });
  it.each(["windows-1252", "ISO-8859-1", "iso_8859-1", "latin1"])(
    "decodes declared %s",
    (encoding) => {
      const bytes = legacy(`<meta charset="${encoding}"><p>Ölwechsel</p>`);
      expect(decodeTextBytes(bytes, undefined, { scopePath: "manual.html" })?.text).toContain(
        "Ölwechsel",
      );
    },
  );
  it("accepts an http-equiv declaration with reordered attributes", () => {
    const bytes = legacy(
      '<META content="text/html; charset=ISO-8859-1" HTTP-EQUIV="Content-Type"><p>Öl</p>',
    );
    expect(decodeTextBytes(bytes, undefined, { scopePath: "manual.htm" })?.text).toContain("Öl");
  });
  it.each(["\u00a0", "\v"])(
    "does not promote a charset separated by non-HTML whitespace %j",
    (separator) => {
      const markup = `<meta data=a${separator}charset=windows-1252><p>Öl</p>`;
      expect(
        decodeTextBytes(legacy(markup), undefined, { scopePath: "manual.html" }),
      ).toBeUndefined();
    },
  );
  it.each(["\t", "\n", "\f", "\r", " "])(
    "recognizes HTML whitespace %j between metadata attributes",
    (separator) => {
      const markup = `<meta data=a${separator}charset=windows-1252><p>Öl</p>`;
      expect(decodeTextFileBytes(legacy(markup), { scopePath: "manual.html" })?.encoding).toBe(
        "windows-1252",
      );
    },
  );
  it("preserves slashes inside an unquoted http-equiv content value", () => {
    const markup = "<META HTTP-EQUIV=Content-Type CONTENT=text/html;charset=iso-8859-1><p>Öl</p>";
    expect(decodeTextFileBytes(legacy(markup), { scopePath: "manual.html" })).toEqual({
      encoding: "windows-1252",
      text: markup,
    });
  });
  it.each(['"', "'"])("keeps a quoted tag terminator inside an attribute using %s", (quote) => {
    const markup = `<meta name=${quote}x${quote} content=${quote}a>b${quote} charset=${quote}windows-1252${quote}><p>Öl</p>`;
    expect(decodeTextFileBytes(legacy(markup), { scopePath: "manual.html" })).toEqual({
      encoding: "windows-1252",
      text: markup,
    });
  });
  it.each([
    '<meta/charset="windows-1252">',
    '<meta http-equiv="Content-Type"content="text/html; charset=windows-1252">',
    "<meta http-equiv='Content-Type'content='text/html; charset=windows-1252'>",
    "<meta disabled charset=windows-1252/>",
    '<meta charset="windows-1252"charset="unknown-codec">',
  ])("decodes compact HTML attributes in %s", (declaration) => {
    expect(
      decodeTextFileBytes(legacy(`${declaration}<p>Ölwechsel</p>`), { scopePath: "manual.html" }),
    ).toEqual({ encoding: "windows-1252", text: `${declaration}<p>Ölwechsel</p>` });
  });
  it.each([
    '<meta data="unfinished charset=windows-1252>',
    "<meta data='unfinished charset=windows-1252>",
    '<meta data="/charset=windows-1252">',
    "<meta data='charset=windows-1252'>",
    '<meta data="a>charset=windows-1252">',
    "<meta data='a>charset=windows-1252'>",
    "<meta data=unquoted/charset=windows-1252>",
  ])("does not promote quoted attribute contents into a declaration: %s", (declaration) => {
    expect(
      decodeTextFileBytes(legacy(`${declaration}<p>Ölwechsel</p>`), { scopePath: "manual.html" }),
    ).toBeUndefined();
  });
  it.each([128, 512, 850])(
    "reads a malformed %i-character attribute name in linear work",
    (size) => {
      const markup = `<meta ${"x".repeat(size)}/charset='windows-1252'><p>Ölwechsel</p>`;
      let charactersRead: number;
      const spy = vi.spyOn(String.prototype, "charAt");
      try {
        expect(decodeTextFileBytes(legacy(markup), { scopePath: "manual.html" })).toEqual({
          encoding: "windows-1252",
          text: markup,
        });
      } finally {
        charactersRead = spy.mock.calls.length;
        spy.mockRestore();
      }
      expect(charactersRead).toBeGreaterThanOrEqual(size);
      expect(charactersRead).toBeLessThanOrEqual(markup.length * 4);
    },
  );
  it("matches the http-equiv charset parameter case-insensitively", () => {
    const bytes = legacy(
      '<META content="text/html; CHARSET=ISO-8859-1" HTTP-EQUIV="Content-Type"><p>Öl</p>',
    );
    expect(decodeTextBytes(bytes, undefined, { scopePath: "manual.htm" })?.text).toContain("Öl");
  });
  it("does not guess legacy encoding for arbitrary text extensions", () => {
    expect(
      decodeTextBytes(legacy('<meta charset="windows-1252">Öl'), undefined, {
        scopePath: "data.blob",
      }),
    ).toBeUndefined();
  });
  it("does not treat commented declarations as active metadata", () => {
    const bytes = legacy('<!-- <meta charset="windows-1252"> --><p>Öl</p>');
    expect(decodeTextBytes(bytes, undefined, { scopePath: "manual.html" })).toBeUndefined();
  });
  it.each(["unknown-encoding"])("does not guess unavailable declared %s", (charset) => {
    expect(
      decodeTextBytes(legacy(`<meta charset="${charset}"><p>Öl</p>`), undefined, {
        scopePath: "manual.html",
      }),
    ).toBeUndefined();
  });
  it("propagates unexpected decoder initialization failures instead of reporting unavailable text", () => {
    const NativeDecoder = TextDecoder;
    const failure = new TypeError("decoder initialization failed");
    class FaultingDecoder extends NativeDecoder {
      public constructor(label?: string, options?: TextDecoderOptions) {
        if (label === "shift_jis") throw failure;
        super(label, options);
      }
    }
    vi.stubGlobal("TextDecoder", FaultingDecoder);
    try {
      expect(() =>
        decodeTextBytes(
          new TextEncoder().encode('<meta charset="Shift_JIS"><p>source</p>'),
          undefined,
          {
            scopePath: "manual.html",
          },
        ),
      ).toThrow(failure);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([
    ["Shift_JIS", [0x82, 0xa0, 0x82], "あ"],
    ["Big5", [0xa4, 0xa4, 0xa4], "中"],
    ["ISO-2022-JP", [0x1b, 0x24, 0x42, 0x24, 0x22, 0x24], "あ"],
  ] as const)("decodes a capped %s prefix without replacement text", (charset, tail, expected) => {
    const bytes = Buffer.concat([Buffer.from(`<meta charset="${charset}">`), new Uint8Array(tail)]);
    expect(decodeTextBytes(bytes, undefined, { scopePath: "manual.html" })).toBeUndefined();
    const decoded = decodeTextBytes(bytes, undefined, {
      scopePath: "manual.html",
      allowIncompleteTail: true,
    });
    expect(decoded?.text).toBe(`<meta charset="${charset}">${expected}`);
    expect(decoded?.text).not.toContain("\ufffd");
  });
  it("does not mask malformed trailing UTF-8 bytes in a capped prefix", () => {
    expect(
      decodeTextBytes(new Uint8Array([0x61, 0xff]), "utf-8", { allowIncompleteTail: true }),
    ).toBeUndefined();
  });
  it("limits character declaration prescan to the first 1024 bytes", () => {
    const bytes = legacy(`${" ".repeat(1024)}<meta charset="windows-1252"><p>Öl</p>`);
    expect(decodeTextBytes(bytes, undefined, { scopePath: "manual.html" })).toBeUndefined();
  });
  it("keeps a BOM authoritative when an unavailable declared codec would otherwise reject", () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<meta charset="unavailable-codec"><p>BOM retains precedence</p>'),
    ]);
    expect(
      decodeTextFileBytes(bytes, { scopePath: "manual.html", requireSupportedEncoding: true }),
    ).toMatchObject({
      encoding: "utf-8",
      text: '<meta charset="unavailable-codec"><p>BOM retains precedence</p>',
    });
  });
  it("gives a UTF-8 BOM precedence over contradictory legacy metadata", () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<meta charset="windows-1252"><p>Öl</p>'),
    ]);
    expect(decodeTextBytes(bytes, undefined, { scopePath: "manual.html" })?.text).toContain("Öl");
  });
});

describe("complete decoded text eligibility", () => {
  it.each(["utf8", "utf16le"] as const)("rejects binary controls behind a %s BOM", (encoding) => {
    const bytes = Buffer.from("\uFEFFbinaryNeedle\n" + "\u0001".repeat(5_000), encoding);
    expect(decodeTextFileBytes(bytes)).toBeUndefined();
  });
  it.each(["utf8", "utf16le"] as const)("preserves legitimate %s text with a BOM", (encoding) => {
    const bytes = Buffer.from("\uFEFFÖlwechsel\t1250 Stunden\r\n第二章\n", encoding);
    expect(decodeTextFileBytes(bytes)?.text).toBe("Ölwechsel\t1250 Stunden\r\n第二章\n");
  });
});
