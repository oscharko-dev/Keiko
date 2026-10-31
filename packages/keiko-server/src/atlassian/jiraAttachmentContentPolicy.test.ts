import { describe, expect, it } from "vitest";
import { docxOf, pdfOf, zipTextEntries } from "../../../../tests/support/zip-fixture.js";
import { admitAttachmentContent } from "./jiraAttachmentContentPolicy.js";

const SECRET = ["configured", "provider", "literal", "0123456789"].join("-");
const KEY_BLOCK = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
  "-----END RSA PRIVATE KEY-----",
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
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";

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

describe("what is allowed", () => {
  it.each([
    ["a PNG", png(), "a.png"],
    ["a JPEG", jpeg(), "a.jpg"],
    ["a GIF", Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0]), "a.gif"],
    [
      "a WebP",
      Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]),
      "a.webp",
    ],
  ])("%s by its signature", async (_label, bytes, name) => {
    expect(await admit(bytes, name)).toEqual({ ok: true });
  });
  it("does not trust an image name over its bytes", async () => {
    expect(
      await admit(
        text('password: hunter2hunter2hunter2\napi_key = "abcdefghijklmnopqrstuvwx1234"\n'),
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
