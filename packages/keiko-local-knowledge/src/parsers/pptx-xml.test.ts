// Tokenizer pins for the shared OOXML reader (#4235 review): element names are the namespace's
// canonical prefixes whatever prefix the producer wrote, and a part must be one XML document.

import { describe, expect, it } from "vitest";

import { selectionFromBytes } from "./parser-test-fixtures.js";
import { buildDocx, linesOf, parseDocx } from "./docx-test-fixtures.js";
import { pptxParser } from "./pptx-parser.js";
import {
  PPTX_EXTENSION_INPUT,
  buildPptx,
  paragraphXml,
  shapeXml,
  slidePartXml,
} from "./pptx-test-fixtures.js";
import { attributeOf, scanXmlTags, scanXmlTokens } from "./pptx-xml.js";
import { buildParserOptions } from "./registry.js";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function names(xml: string): readonly string[] {
  return [...scanXmlTags(xml, 16)].map(
    (tag) => `${tag.closing ? "/" : ""}${tag.prefix}:${tag.local}`,
  );
}

describe("namespace prefixes", () => {
  it("names an element by its namespace, not by the prefix the producer chose", () => {
    const xml = `<ns0:p xmlns:ns0="${W_NS}"><ns0:r><ns0:t>x</ns0:t></ns0:r></ns0:p>`;
    expect(names(xml)).toEqual(["w:p", "w:r", "w:t", "/w:t", "/w:r", "/w:p"]);
  });

  it("names the elements of a default namespace and its attributes", () => {
    const xml = `<p xmlns="${W_NS}" xmlns:q="${W_NS}"><pStyle q:val="Heading1"/></p>`;
    const tags = [...scanXmlTags(xml, 16)];
    expect(tags.map((tag) => `${tag.prefix}:${tag.local}`)).toEqual(["w:p", "w:pStyle", "w:p"]);
    expect(attributeOf(tags[1] as never, "w:val")).toBe("Heading1");
  });

  it("reads the strict namespaces under the same names", () => {
    const xml = `<s:p xmlns:s="http://purl.oclc.org/ooxml/wordprocessingml/main"/>`;
    expect(names(xml)).toEqual(["w:p"]);
  });

  it("follows a redeclaration in a nested scope and restores the outer one", () => {
    const xml = `<x:a xmlns:x="${W_NS}"><x:b xmlns:x="${A_NS}"/><x:c/></x:a>`;
    expect(names(xml)).toEqual(["w:a", "a:b", "w:c", "/w:a"]);
  });

  it("keeps an unknown namespace's prefix, and never lets it impersonate a known one", () => {
    const xml = `<w:p xmlns:w="urn:other"><w:r/></w:p>`;
    const [first] = [...scanXmlTags(xml, 16)];
    expect(first?.prefix).not.toBe("w");
    expect(names(`<z:q xmlns:z="urn:other"/>`)).toEqual(["z:q"]);
  });

  it("leaves a prefix that no ancestor declares as written", () => {
    expect(names("<w:p><a:t/></w:p>")).toEqual(["w:p", "a:t", "/w:p"]);
  });

  it("reads a docx whose producer wrote another prefix for the main namespace", async () => {
    const document =
      `<?xml version="1.0"?><ns0:document xmlns:ns0="${W_NS}"><ns0:body><ns0:p><ns0:r>` +
      `<ns0:t>Absatz</ns0:t></ns0:r></ns0:p><ns0:tbl><ns0:tr><ns0:tc><ns0:p><ns0:r>` +
      `<ns0:t>Zelle</ns0:t></ns0:r></ns0:p></ns0:tc></ns0:tr></ns0:tbl></ns0:body></ns0:document>`;
    const result = await parseDocx(buildDocx({ document }));
    expect(linesOf(result)).toEqual(["Absatz", "Table row 1: Column 1=Zelle"]);
  });

  it("reads a docx written in the default namespace", async () => {
    const document =
      `<?xml version="1.0"?><document xmlns="${W_NS}"><body><p><r><t>Standard</t></r></p>` +
      `</body></document>`;
    expect(linesOf(await parseDocx({ document }))).toEqual(["Standard"]);
  });

  it("reads a pptx whose slide uses other prefixes for presentation and drawing", async () => {
    const slide = slidePartXml(shapeXml("title", paragraphXml("Titel")))
      .replaceAll("<p:", "<pp:")
      .replaceAll("</p:", "</pp:")
      .replaceAll("<a:", "<dd:")
      .replaceAll("</a:", "</dd:")
      .replace(`xmlns:p="${P_NS}"`, `xmlns:pp="${P_NS}"`)
      .replace(`xmlns:a="${A_NS}"`, `xmlns:dd="${A_NS}"`)
      .replace(`xmlns:r="${R_NS}"`, `xmlns:r="${R_NS}"`);
    const bytes = buildPptx([{ file: "slide1.xml", relationshipId: "rId1", xml: slide }]);
    const result = await pptxParser.parseAsync(
      selectionFromBytes(bytes, PPTX_EXTENSION_INPUT),
      buildParserOptions({ now: () => 0 }),
    );
    expect("normalizedText" in result ? result.normalizedText : "").toBe("Slide 1: Titel");
  });
});

describe("one XML document per part", () => {
  const drain = (xml: string): number => [...scanXmlTokens(xml, 16)].length;

  it.each([
    ["no element at all", "just text"],
    ["an empty part", ""],
    ["text after the root", "<a/>stray"],
    ["text before the root", "stray<a/>"],
    ["a second root element", "<a/><b/>"],
  ])("rejects %s", (_label, xml) => {
    expect(() => drain(xml)).toThrow("ooxml xml");
  });

  it("accepts whitespace, a comment and an XML declaration around the root", () => {
    expect(drain('﻿<?xml version="1.0"?>\n<!-- c -->\n<a><b/></a>\n')).toBeGreaterThan(0);
  });

  it("rejects a docx main part that is not XML as malformed, not as an empty document", async () => {
    const result = await parseDocx(buildDocx({ document: "not xml at all" }));
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["MALFORMED_INPUT"]);
  });
});
