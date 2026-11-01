import { describe, expect, it } from "vitest";
import { readPdfSyntax } from "./jiraAttachmentPdfSyntax.js";

const file = (source: string): ReturnType<typeof readPdfSyntax> => readPdfSyntax(source, "file");

describe("PDF names", () => {
  it("decodes number-sign escapes", () => {
    expect([...(file("1 0 obj << /F#69lter /A#42 >> endobj")?.names ?? [])]).toEqual([
      "Filter",
      "AB",
    ]);
  });
});

describe("PDF strings", () => {
  it.each([
    ["a literal with nesting", "(a(b)c)", "a(b)c"],
    ["octal escapes", String.raw`(\101\1\60)`, "A\u00010"],
    ["named escapes", String.raw`(\n\t\(\\)`, "\n\t(\\"],
    ["a line continuation", "(ab\\\r\ncd)", "abcd"],
    ["a hexadecimal string", "<4 8 69>", "Hi"],
    ["an odd hexadecimal string", "<486>", "H`"],
    ["UTF-16BE behind its mark", "<FEFF00480069>", "Hi"],
    ["UTF-16LE behind its mark", "<FFFE48006900>", "Hi"],
    ["UTF-8 behind its mark", "<EFBBBF4869>", "Hi"],
  ])("decodes %s", (_label, source, expected) => {
    expect(file(`1 0 obj << /T ${source} >> endobj`)?.stringText).toBe(expected);
  });
  it("also offers a string of two-byte characters without its NULs", () => {
    expect(file("1 0 obj << /T <480069> >> endobj")?.stringText.split("\n")).toEqual([
      "H\u0000i",
      "Hi",
    ]);
  });
  it("does not take a delimiter inside a comment or string for syntax", () => {
    const syntax = file("% ( not a string\n1 0 obj << /T (a>>b) >> endobj");
    expect(syntax?.stringText).toBe("a>>b");
  });
});

describe("PDF streams", () => {
  const stream = (dictionary: string, data = "xyz"): string =>
    `6 0 obj << /Length 3 ${dictionary} >> stream\r\n${data}\r\nendstream endobj`;
  it.each([
    ["no filter", "", []],
    ["a name", "/Filter /FlateDecode", ["FlateDecode"]],
    ["an escaped name", "/Filter /Flate#44ecode", ["FlateDecode"]],
    ["an array", "/Filter [ /ASCII85Decode /FlateDecode ]", ["ASCII85Decode", "FlateDecode"]],
    [
      "a key after a nested dictionary",
      "/DecodeParms << /Filter /X >> /Filter /LZWDecode",
      ["LZWDecode"],
    ],
    ["a key after a reference", "/Length2 7 0 R /Filter /FlateDecode", ["FlateDecode"]],
  ])("reads %s", (_label, dictionary, filters) => {
    const source = stream(dictionary);
    const found = file(source)?.streams[0];
    expect(found?.filters).toEqual(filters);
    expect(source.slice(found?.start, found?.end)).toBe("xyz");
  });
  it.each([
    ["an indirect value", "/Filter 7 0 R"],
    ["a malformed array", "/Filter [ /A 3 ]"],
    ["an unterminated array", "/Filter [ /A"],
  ])("cannot read %s", (_label, dictionary) => {
    expect(file(stream(dictionary))?.streams[0]?.filters).toBeUndefined();
  });
  it("cannot read a stream with no dictionary", () => {
    expect(file("6 0 obj stream\nxyz\nendstream endobj")?.streams[0]?.filters).toBeUndefined();
  });
  it("skips stream data whatever it holds", () => {
    const syntax = file(stream("", "(((<<<<[[ ÿ"));
    expect(syntax?.stringText).toBe("");
    expect(syntax?.streams).toHaveLength(1);
  });
});

describe("what a strict read cannot interpret", () => {
  it.each([
    ["an unterminated string", "1 0 obj (abc"],
    ["a malformed hexadecimal string", "1 0 obj <zz>"],
    ["an unterminated hexadecimal string", "1 0 obj <48"],
    ["a stray dictionary end", "1 0 obj >> endobj"],
    ["a stray closing parenthesis", "1 0 obj ) endobj"],
    ["a stream keyword without a line break", "6 0 obj << >> stream xyz endstream"],
    ["a stream without an end", "6 0 obj << >> stream\nxyz"],
  ])("%s", (_label, source) => {
    expect(file(source)).toBeUndefined();
  });
  it("is read leniently inside a decoded stream", () => {
    expect(readPdfSyntax("(open <zz> >> ) stream\nx", "inflated")?.streams).toEqual([]);
  });
});

describe("a pathological input is read in bounded time", () => {
  it.each([
    ["open strings", "(".repeat(300_000)],
    ["open dictionaries", "<<".repeat(300_000)],
    ["open arrays", "[".repeat(300_000)],
    ["empty hexadecimal strings", "<>".repeat(300_000)],
    ["many tiny strings", "(a)".repeat(300_000)],
    ["escapes", "(\\".repeat(300_000)],
  ])("%s", (_label, source) => {
    const started = Date.now();
    readPdfSyntax(source, "inflated");
    readPdfSyntax(`1 0 obj ${source}`, "file");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
