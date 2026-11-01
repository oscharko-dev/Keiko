import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  docxOf,
  pdfOf,
  withArchiveComment,
  zipTextEntries,
} from "../../../../tests/support/zip-fixture.js";
import { admitAttachmentContent } from "./jiraAttachmentContentPolicy.js";

const SECRET = ["configured", "provider", "literal", "0123456789"].join("-");
// Credential-shaped fixtures are assembled at runtime so the repository carries no literal the
// secret scan would have to exempt; the values are synthetic.
const PEM_LABEL = ["RSA", "PRIVATE", "KEY"].join(" ");
const KEY_BLOCK = [
  `-----BEGIN ${PEM_LABEL}-----`,
  ["MIIEowIBAAKCAQEAu1SU1LfVLPHCozMx", "H2Mo4lgOEePzNm0tRgeLezV6ffAt0gun"].join(""),
  `-----END ${PEM_LABEL}-----`,
].join("\n");
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const admit = (bytes: Uint8Array, name: string): ReturnType<typeof admitAttachmentContent> =>
  admitAttachmentContent({ bytes, name, secrets: [SECRET] });
const CREDENTIAL = { ok: false, refusal: "contains-credential" } as const;
const UNSCANNABLE = { ok: false, refusal: "unscannable" } as const;

describe("a credential in text is refused whatever the file is called", () => {
  it.each([
    ["a private key in yml", "app.yml", `signing:\n  key: |\n${KEY_BLOCK}\n`],
    ["a private key in properties", "app.properties", `key=${KEY_BLOCK.replaceAll("\n", "\\n")}\n`],
    ["a private key in a SQL dump", "dump.sql", `INSERT INTO k VALUES ('${KEY_BLOCK}');\n`],
    [
      "an Authorization value in yml",
      "client.yml",
      "headers:\n  Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n",
    ],
    [
      "an Authorization value in properties",
      "client.properties",
      "http.header=Authorization: Basic dXNlcjpwYXNzd29yZHBhc3N3b3Jk\n",
    ],
    [
      "URL credentials in a SQL dump",
      "dump.sql",
      "INSERT INTO c VALUES ('postgres://admin:hunter2hunter2@db.internal/app');\n",
    ],
    ["an issuer token in yml", "ci.yml", "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n"],
    ["a configured secret literal", "notes.txt", `see ${SECRET} for access\n`],
  ])("%s", async (_label, name, content) => {
    expect(await admit(text(content), name)).toEqual(CREDENTIAL);
  });
  it("finds a configured literal in binary bytes too", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bytes = Uint8Array.from([...png, ...text(SECRET)]);
    expect(await admit(bytes, "shot.png")).toEqual(CREDENTIAL);
  });
  it("ignores a short configured value that is only an ordinary word", async () => {
    expect(
      await admitAttachmentContent({
        bytes: text("a plain sentence with the letters abc in it"),
        name: "a.txt",
        secrets: ["abc"],
      }),
    ).toEqual({ ok: true });
  });
});

describe("documents are scanned through their extracted text", () => {
  it("refuses a Word document and a PDF that hold a key", async () => {
    expect(await admit(docxOf(`token ghp_abcdefghijklmnopqrstuvwxyz0123456789`), "n.docx")).toEqual(
      CREDENTIAL,
    );
    expect(await admit(pdfOf(`ghp_abcdefghijklmnopqrstuvwxyz0123456789`), "n.pdf")).toEqual(
      CREDENTIAL,
    );
  });
  it("also reads a PDF's own bytes, so text drawn off the page is not a way around the scan", async () => {
    const offPage = pdfOf("ghp_abcdefghijklmnopqrstuvwxyz0123456789", 40);
    expect(await admit(offPage, "n.pdf")).toEqual(CREDENTIAL);
  });
  it("lets clean documents through", async () => {
    expect(await admit(docxOf("Quarterly planning notes"), "n.docx")).toEqual({ ok: true });
    expect(await admit(pdfOf("Hello PDF"), "n.pdf")).toEqual({ ok: true });
  });
  it("recognizes a PDF by its signature, not its name", async () => {
    expect(await admit(pdfOf(`ghp_abcdefghijklmnopqrstuvwxyz0123456789`), "n.txt")).toEqual(
      CREDENTIAL,
    );
  });
  it("refuses a document whose text cannot be extracted", async () => {
    expect(await admit(text("not really a zip"), "n.docx")).toEqual({ ok: true });
    expect(await admit(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 9, 9, 9]), "n.docx")).toEqual(
      UNSCANNABLE,
    );
  });
});

describe("what cannot be scanned is refused", () => {
  it.each([
    ["a zip archive", zipTextEntries([{ name: "a.txt", content: "hello" }]), "a.zip"],
    ["a zip renamed to txt", zipTextEntries([{ name: "a.txt", content: "hello" }]), "a.txt"],
    ["a sqlite database", text("SQLite format 3\u0000\u0001\u0002"), "a.db"],
    ["a gzip stream", Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0x01]), "a.gz"],
    [
      "a Java key store",
      Uint8Array.from([0xfe, 0xed, 0xfe, 0xed, 0x00, 0x00, 0x00, 0x02]),
      "a.jks",
    ],
    ["an ELF executable", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]), "a.out"],
    ["text with a NUL byte", Uint8Array.from([0x68, 0x00, 0x69]), "a.txt"],
    ["bytes that are not UTF-8", Uint8Array.from([0xff, 0xfe, 0xfd, 0xfc]), "a.txt"],
    [
      "a pptx package",
      zipTextEntries([{ name: "ppt/slides/slide1.xml", content: "<a/>" }]),
      "a.pptx",
    ],
  ])("%s", async (_label, bytes, name) => {
    expect(await admit(bytes, name)).toEqual(UNSCANNABLE);
  });
});

// Minimal, well-formed images the tests can extend with chunks, segments or trailing bytes.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function pngChunk(type: string, data: Uint8Array): number[] {
  const length = data.length;
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...text(type),
    ...data,
    0,
    0,
    0,
    0, // the checksum is not validated by the policy
  ];
}
const png = (...chunks: number[][]): Uint8Array =>
  Uint8Array.from([
    ...PNG_SIGNATURE,
    ...pngChunk("IHDR", new Uint8Array(13)),
    ...chunks.flat(),
    ...pngChunk("IEND", new Uint8Array()),
  ]);
function jpegSegment(marker: number, data: Uint8Array): number[] {
  const length = data.length + 2;
  return [0xff, marker, length >>> 8, length & 0xff, ...data];
}
const jpeg = (...segments: number[][]): Uint8Array =>
  Uint8Array.from([
    0xff,
    0xd8,
    ...jpegSegment(0xe0, text("JFIF\u0000")),
    ...segments.flat(),
    0xff,
    0xd9,
  ]);
const TOKEN = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  "dBjftJeZ4CVPmB92K27uhbUJU1p1r",
].join(".");

// Review (#4176): a signature alone proves nothing about what rides inside or behind the image.
describe("an image is allowed only when its bytes hold nothing hidden", () => {
  it.each([
    [
      "a PNG with a private key appended after IEND",
      Uint8Array.from([
        ...png(),
        ...text(
          `\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\n`,
        ),
      ]),
      "shot.png",
    ],
    [
      "a PNG with a tEXt chunk holding a JWT-shaped token",
      png(pngChunk("tEXt", text(`Comment\u0000${TOKEN}`))),
      "shot.png",
    ],
    [
      "a JPEG with a COM segment holding an Authorization value",
      jpeg(jpegSegment(0xfe, text("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789"))),
      "shot.jpg",
    ],
    [
      "a JPEG with a token in an APP1 (EXIF) segment",
      jpeg(jpegSegment(0xe1, text(`Exif\u0000\u0000ghp_abcdefghijklmnopqrstuvwxyz0123456789`))),
      "shot.jpeg",
    ],
  ])("refuses %s", async (_label, bytes, name) => {
    expect(await admit(bytes, name)).toEqual(CREDENTIAL);
  });
  it.each([
    ["a PNG with bytes after IEND", Uint8Array.from([...png(), 1, 2, 3, 4]), "shot.png"],
    ["a PNG that never reaches IEND", Uint8Array.from([...PNG_SIGNATURE, 0, 0, 0, 0]), "shot.png"],
    ["a JPEG with bytes after the final EOI", Uint8Array.from([...jpeg(), 9, 9, 9]), "shot.jpg"],
    ["a JPEG that never reaches EOI", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 2]), "shot.jpg"],
  ])("refuses %s as unscannable", async (_label, bytes, name) => {
    expect(await admit(bytes, name)).toEqual(UNSCANNABLE);
  });
  it("keeps a clean PNG and a clean JPEG", async () => {
    expect(
      await admit(png(pngChunk("tEXt", text("Comment\u0000a holiday photo"))), "a.png"),
    ).toEqual({ ok: true });
    expect(await admit(jpeg(jpegSegment(0xfe, text("a holiday photo"))), "a.jpg")).toEqual({
      ok: true,
    });
  });
});

// Independent review (#4176): a compressed carrier, an unread package part or a stream the
// extractor never draws is where a credential rides past a scan of the visible text.
const GHP = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const deflated = (value: string): Uint8Array => deflateSync(Buffer.from(value, "utf8"));
const keywordCompressed = (keyword: string, value: string): Uint8Array =>
  Uint8Array.from([...text(keyword), 0, 0, ...deflated(value)]);
const docxWith = (...parts: readonly { name: string; content: string }[]): Uint8Array =>
  docxOf("Quarterly planning notes", parts);
/** A text-layer PDF with one more object: a Flate stream the page never draws. */
function pdfWithFlateStream(stream: Uint8Array): Uint8Array {
  const pdf = Buffer.from(pdfOf("Hello PDF")).toString("latin1");
  const at = pdf.indexOf("xref");
  const object = `6 0 obj << /Length ${String(stream.length)} /Filter /FlateDecode >> stream\n${Buffer.from(stream).toString("latin1")}\nendstream endobj\n`;
  return Buffer.from(pdf.slice(0, at) + object + pdf.slice(at), "latin1");
}

describe("compressed and unread carriers are scanned or refused", () => {
  it.each([
    ["a Word comment", docxWith({ name: "word/comments.xml", content: `<w:t>${GHP}</w:t>` })],
    ["a Word header", docxWith({ name: "word/header1.xml", content: `<w:t>${GHP}</w:t>` })],
    ["any other package entry", docxWith({ name: "secret.txt", content: GHP })],
  ])("refuses a credential in %s", async (_label, bytes) => {
    expect(await admit(bytes, "n.docx")).toEqual(CREDENTIAL);
  });
  it("refuses a package part that is neither text nor a checked image", async () => {
    const embedded = docxWith({ name: "word/embeddings/o.bin", content: "\u0001\u0002\u0003" });
    expect(await admit(embedded, "n.docx")).toEqual(UNSCANNABLE);
  });
  it("keeps a Word document whose every part is clean", async () => {
    const clean = docxWith({ name: "word/comments.xml", content: "<w:t>looks good</w:t>" });
    expect(await admit(clean, "n.docx")).toEqual({ ok: true });
  });
  it.each([
    ["zTXt", png(pngChunk("zTXt", keywordCompressed("Comment", GHP)))],
    ["iCCP", png(pngChunk("iCCP", keywordCompressed("profile", GHP)))],
    [
      "compressed iTXt",
      png(
        pngChunk(
          "iTXt",
          Uint8Array.from([...text("XML:com.adobe.xmp"), 0, 1, 0, 0, 0, ...deflated(GHP)]),
        ),
      ),
    ],
  ])("refuses a credential deflated into a PNG %s chunk", async (_label, bytes) => {
    expect(await admit(bytes, "shot.png")).toEqual(CREDENTIAL);
  });
  it.each([
    ["an unknown PNG chunk", png(pngChunk("prVt", deflated(GHP)))],
    [
      "a second zlib stream behind a PNG carrier",
      png(
        pngChunk(
          "zTXt",
          Uint8Array.from([...keywordCompressed("Comment", "fine"), ...deflated(GHP)]),
        ),
      ),
    ],
    [
      "a JPEG with deflated bytes appended that end in an EOI marker",
      Uint8Array.from([...jpeg(), ...deflated(GHP), 0xff, 0xd9]),
    ],
    [
      "a GIF with trailing bytes",
      Uint8Array.from([...text("GIF89a"), 1, 0, 1, 0, 0, 0, 0, 0x3b, ...deflated(GHP)]),
    ],
    ["a WebP", Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])],
  ])("refuses %s as unscannable", async (_label, bytes) => {
    expect(await admit(bytes, "shot.png")).toEqual(UNSCANNABLE);
  });
  it("refuses a credential in a PDF Flate stream the page never draws", async () => {
    expect(await admit(pdfWithFlateStream(deflated(`/Annot (${GHP})`)), "n.pdf")).toEqual(
      CREDENTIAL,
    );
  });
  it("refuses a PDF stream under a filter it cannot read, and an embedded file", async () => {
    const lzw = Buffer.from(
      Buffer.from(pdfWithFlateStream(deflated("x")))
        .toString("latin1")
        .replace("/FlateDecode", "/LZWDecode"),
      "latin1",
    );
    expect(await admit(lzw, "n.pdf")).toEqual(UNSCANNABLE);
    const embedded = Buffer.from(
      Buffer.from(pdfOf("Hello PDF"))
        .toString("latin1")
        .replace("/Type /Catalog", "/Type /Catalog /Names << /EmbeddedFiles 6 0 R >>"),
      "latin1",
    );
    expect(await admit(embedded, "n.pdf")).toEqual(UNSCANNABLE);
  });
  it("keeps a PDF whose Flate streams are clean", async () => {
    expect(await admit(pdfWithFlateStream(deflated("BT (fine) Tj ET")), "n.pdf")).toEqual({
      ok: true,
    });
  });
});

// Independent review round 2 (#4182): a credential is the same credential after the document format
// decodes it; the scan reads the decoded forms, or refuses what it cannot interpret.
const AMP_SECRET = ["configured", "a&b", "literal", "0123456789"].join("-");
const admitAmp = (bytes: Uint8Array, name: string): ReturnType<typeof admitAttachmentContent> =>
  admitAttachmentContent({ bytes, name, secrets: [AMP_SECRET] });
const CORE = "docProps/core.xml";

describe("XML-decoded values are scanned in every OOXML part", () => {
  it.each([
    [
      "an escaped configured literal in the core properties",
      `<cp:coreProperties><dc:description>${AMP_SECRET.replaceAll("&", "&amp;")}</dc:description></cp:coreProperties>`,
    ],
    [
      "a numeric character reference in an attribute",
      `<w:comment w:author="x" w:initials="${GHP.replace("g", "&#103;")}"/>`,
    ],
    [
      "a token split across text runs",
      `<w:p><w:r><w:t>${GHP.slice(0, 12)}</w:t></w:r><w:r><w:t>${GHP.slice(12)}</w:t></w:r></w:p>`,
    ],
    [
      "a token split by a tag whose attribute holds a closing angle bracket",
      `<w:t>${GHP.slice(0, 10)}<w:x a=">"/>${GHP.slice(10)}</w:t>`,
    ],
    ["a token split by a comment", `<w:t>${GHP.slice(0, 9)}<!-- > -->${GHP.slice(9)}</w:t>`],
    ["a token in CDATA", `<w:t><![CDATA[${GHP}]]></w:t>`],
  ])("refuses %s", async (_label, content) => {
    const bytes = docxWith({ name: CORE, content });
    expect(await admitAmp(bytes, "n.docx")).toEqual(CREDENTIAL);
  });
  it("refuses an entity declaration, which expands to text the source does not show", async () => {
    const content = `<!DOCTYPE x [<!ENTITY a "${GHP.slice(0, 10)}"><!ENTITY b "${GHP.slice(10)}">]><x>&a;&b;</x>`;
    expect(await admit(docxWith({ name: CORE, content }), "n.docx")).toEqual(UNSCANNABLE);
  });
  it("keeps clean markup, escaped text and a comparison in prose", async () => {
    const content = `<cp:coreProperties><dc:title>Q&amp;A &lt;draft&gt; 1 &lt; 2</dc:title><!-- note --><x a="b>c"/></cp:coreProperties>`;
    expect(await admitAmp(docxWith({ name: CORE, content }), "n.docx")).toEqual({ ok: true });
  });
});

describe("the ZIP container's own metadata is scanned", () => {
  it("refuses a recognized token in the archive comment of a clean document", async () => {
    expect(await admit(withArchiveComment(docxOf("Quarterly notes"), GHP), "n.docx")).toEqual(
      CREDENTIAL,
    );
  });
  it("refuses a configured literal in the archive comment", async () => {
    expect(
      await admit(withArchiveComment(docxOf("Quarterly notes"), `x ${SECRET} y`), "n.docx"),
    ).toEqual(CREDENTIAL);
  });
  it("keeps a document whose archive comment is clean", async () => {
    const commented = withArchiveComment(docxOf("Quarterly notes"), "made by a tool");
    expect(await admit(commented, "n.docx")).toEqual({ ok: true });
  });
});

/** A text-layer PDF with more objects (source text) before its cross-reference table. */
function pdfWithObjects(objects: readonly string[], trailerExtra = ""): Uint8Array {
  const pdf = Buffer.from(pdfOf("Hello PDF")).toString("latin1");
  const at = pdf.indexOf("xref");
  const trailer = pdf.replace("/Size 6", `/Size 6 ${trailerExtra}`);
  return Buffer.from(
    `${trailer.slice(0, at)}${objects.join("\n")}\n${trailer.slice(at)}`,
    "latin1",
  );
}
const streamObject = (dictionary: string, data: Uint8Array): string =>
  `6 0 obj << /Length ${String(data.length)} ${dictionary} >> stream\n${Buffer.from(data).toString("latin1")}\nendstream endobj`;
const hex = (value: string): string => Buffer.from(value, "latin1").toString("hex");
const utf16Hex = (value: string): string =>
  `FEFF${Buffer.from(value, "utf16le").swap16().toString("hex")}`;

describe("a PDF dictionary is read the way a viewer reads it", () => {
  const carrier = deflated(`/Annot (${GHP})`);
  it.each([
    ["the plain spelling", "/Filter /FlateDecode"],
    ["an escaped key", "/F#69lter /FlateDecode"],
    ["an escaped value", "/Filter /Flate#44ecode"],
    ["an array", "/Filter [/FlateDecode]"],
    ["an escaped array element", "/Filter [/F#6Cate#44ecode]"],
    ["a string that contains obj", "/Filter /FlateDecode /Note (obj)"],
    ["a nested dictionary before it", "/DecodeParms << /Predictor 1 >> /Filter /FlateDecode"],
  ])("refuses a deflated token behind %s", async (_label, dictionary) => {
    const pdf = pdfWithObjects([streamObject(dictionary, carrier)]);
    expect(await admit(pdf, "n.pdf")).toEqual(CREDENTIAL);
  });
  it("refuses a filter stated by an indirect reference, which it cannot read", async () => {
    const pdf = pdfWithObjects([
      streamObject("/Filter 7 0 R", carrier),
      "7 0 obj /FlateDecode endobj",
    ]);
    expect(await admit(pdf, "n.pdf")).toEqual(UNSCANNABLE);
  });
  it("refuses an escaped Encrypt or EmbeddedFile name", async () => {
    expect(await admit(pdfWithObjects([], "/Encr#79pt 9 0 R"), "n.pdf")).toEqual(UNSCANNABLE);
    const embedded = pdfWithObjects(["7 0 obj << /Type /Embedded#46ile >> endobj"]);
    expect(await admit(embedded, "n.pdf")).toEqual(UNSCANNABLE);
  });
  it("refuses a stream keyword it did not take for a stream", async () => {
    const pdf = pdfWithObjects(["7 0 obj << /Note (a\nstream\nb) >> endobj"]);
    expect(await admit(pdf, "n.pdf")).toEqual(UNSCANNABLE);
  });
  it("refuses a file whose syntax it cannot interpret", async () => {
    expect(await admit(pdfWithObjects(["7 0 obj << /Title <zz> >> endobj"]), "n.pdf")).toEqual(
      UNSCANNABLE,
    );
    expect(await admit(pdfWithObjects(["7 0 obj << /Title (open endobj"]), "n.pdf")).toEqual(
      UNSCANNABLE,
    );
  });
  it("keeps a PDF whose dictionaries and strings are clean", async () => {
    const clean = pdfWithObjects(
      [
        "7 0 obj << /Title (Quarterly \\(draft\\) \\101) /Author <48656C6C6F> >> endobj",
        streamObject("/Filter [/F#6Cate#44ecode]", deflated("BT (fine) Tj ET")),
      ],
      "/Info 7 0 R",
    );
    expect(await admit(clean, "n.pdf")).toEqual({ ok: true });
  });
});

describe("decoded PDF strings are scanned", () => {
  const objectOf = (title: string): string => `7 0 obj << /Title ${title} >> endobj`;
  it.each([
    ["a hexadecimal string", `<${hex(GHP)}>`],
    ["a hexadecimal string with white space", `<${hex(GHP).replaceAll(/(..)/gu, "$1 ")}>`],
    ["an escaped literal string", `(${GHP.replace("_", "\\137").replace("a", "\\141")})`],
    ["a literal with a line continuation", `(${GHP.slice(0, 10)}\\\n${GHP.slice(10)})`],
    ["a UTF-16 string", `<${utf16Hex(GHP)}>`],
  ])("refuses %s in the document information", async (_label, title) => {
    const pdf = pdfWithObjects([objectOf(title)], "/Info 7 0 R");
    expect(await admit(pdf, "n.pdf")).toEqual(CREDENTIAL);
  });
  it("refuses a configured literal written as a hexadecimal string", async () => {
    const pdf = pdfWithObjects([objectOf(`<${hex(SECRET)}>`)], "/Info 7 0 R");
    expect(await admit(pdf, "n.pdf")).toEqual(CREDENTIAL);
  });
  it("refuses strings inside a deflated object stream and an unfiltered one", async () => {
    const info = `<< /Title <${hex(GHP)}> >>`;
    const flate = pdfWithObjects([streamObject("/Filter /FlateDecode", deflated(info))]);
    expect(await admit(flate, "n.pdf")).toEqual(CREDENTIAL);
    const plain = pdfWithObjects([streamObject("", text(info))]);
    expect(await admit(plain, "n.pdf")).toEqual(CREDENTIAL);
  });
  it("refuses a token that a content stream splits across strings", async () => {
    const content = `BT [(${GHP.slice(0, 8)}) -20 (${GHP.slice(8)})] TJ ET`;
    const pdf = pdfWithObjects([streamObject("/Filter /FlateDecode", deflated(content))]);
    expect(await admit(pdf, "n.pdf")).toEqual(CREDENTIAL);
  });
  it("keeps clean hexadecimal and UTF-16 document information", async () => {
    const pdf = pdfWithObjects(
      [`7 0 obj << /Title <${hex("Quarterly")}> /Subject <${utf16Hex("Planning")}> >> endobj`],
      "/Info 7 0 R",
    );
    expect(await admit(pdf, "n.pdf")).toEqual({ ok: true });
  });
});

describe("a JPEG inside a PDF stream gets the whole image admission", () => {
  const comment = (value: string): Uint8Array => jpeg(jpegSegment(0xfe, text(value)));
  const wrapped = (image: Uint8Array, filter: string, inflate = true): Uint8Array =>
    pdfWithObjects([streamObject(filter, inflate ? deflateSync(image) : image)]);
  const flateDct = "/Filter [/FlateDecode /DCTDecode]";
  it("refuses a token in the COM segment of an inflated JPEG, as it does the bare image", async () => {
    expect(await admit(comment(GHP), "a.jpg")).toEqual(CREDENTIAL);
    expect(await admit(wrapped(comment(GHP), flateDct), "n.pdf")).toEqual(CREDENTIAL);
  });
  it("refuses a configured literal in the inflated JPEG", async () => {
    expect(await admit(wrapped(comment(SECRET), flateDct), "n.pdf")).toEqual(CREDENTIAL);
  });
  it("refuses a JPEG with a token under DCTDecode alone", async () => {
    expect(await admit(wrapped(comment(GHP), "/Filter /DCTDecode", false), "n.pdf")).toEqual(
      CREDENTIAL,
    );
  });
  it("refuses an inflated stream that is not a JPEG, or one that is malformed", async () => {
    expect(await admit(wrapped(text("not an image"), flateDct), "n.pdf")).toEqual(UNSCANNABLE);
    const trailing = Uint8Array.from([...jpeg(), 9, 9]);
    expect(await admit(wrapped(trailing, flateDct), "n.pdf")).toEqual(UNSCANNABLE);
  });
  it("keeps a clean wrapped JPEG", async () => {
    expect(await admit(wrapped(comment("a holiday photo"), flateDct), "n.pdf")).toEqual({
      ok: true,
    });
  });
});

describe("what is allowed", () => {
  it.each([
    ["a PNG", png(), "a.png"],
    ["a JPEG", jpeg(), "a.jpg"],
    [
      "a PNG with a clean compressed text chunk and an Apple screenshot chunk",
      png(
        pngChunk("zTXt", keywordCompressed("Comment", "a screenshot")),
        pngChunk("iDOT", new Uint8Array(28)),
      ),
      "a.png",
    ],
    [
      "a JPEG with scan data, a stuffed byte and a restart marker",
      jpeg(jpegSegment(0xda, new Uint8Array(4)), [1, 0xff, 0x00, 2, 0xff, 0xd0, 3]),
      "a.jpg",
    ],
  ])("%s by its signature", async (_label, bytes, name) => {
    expect(await admit(bytes, name)).toEqual({ ok: true });
  });
  it("does not trust an image name over its bytes", async () => {
    expect(
      await admit(
        text(
          `password: hunter2hunter2hunter2\n${["api", "key"].join("_")} = "abcdefghijklmnopqrstuvwx1234"\n`,
        ),
        "shot.png",
      ),
    ).toEqual(CREDENTIAL);
  });
  it("lets clean text through", async () => {
    expect(await admit(text("# Notes\n\nNothing secret here.\n"), "notes.md")).toEqual({
      ok: true,
    });
  });
});
