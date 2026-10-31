import { describe, expect, it } from "vitest";

import { isLegacyBinaryOfficeFormat } from "./large-document/index.js";
import { selectionFromBytes, zipTextEntries, type ZipTextEntry } from "./parser-test-fixtures.js";
import { pptxParser } from "./pptx-parser.js";
import {
  PPTX_EXTENSION_INPUT,
  buildPptx,
  paragraphXml,
  pptxEntries,
  presentationPartXml,
  relationshipsXml,
  shapeXml,
  slidePartXml,
  tableXml,
  type FixtureSlide,
} from "./pptx-test-fixtures.js";
import { buildParserOptions } from "./registry.js";
import type { ParserOptions, ParserResult } from "./types.js";

type Overrides = Partial<ParserOptions>;

async function parse(bytes: Uint8Array, overrides: Overrides = {}): Promise<ParserResult> {
  return pptxParser.parseAsync(
    selectionFromBytes(bytes, PPTX_EXTENSION_INPUT),
    buildParserOptions({ now: () => 0, ...overrides }),
  );
}

function textOf(result: ParserResult): string {
  return "normalizedText" in result && typeof result.normalizedText === "string"
    ? result.normalizedText
    : "";
}

function slide(
  file: string,
  relationshipId: string,
  shapes: readonly string[],
  notes?: readonly string[],
): FixtureSlide {
  const xml = slidePartXml(...shapes);
  return notes === undefined ? { file, relationshipId, xml } : { file, relationshipId, xml, notes };
}

function codes(result: ParserResult): readonly string[] {
  return result.diagnostics.map((entry) => entry.code);
}

describe("pptxParser", () => {
  it("extracts one section per slide with titles, bullets, a table and speaker notes", async () => {
    const bytes = buildPptx([
      slide(
        "slide1.xml",
        "rId2",
        [
          shapeXml("title", paragraphXml("Quarterly results")),
          shapeXml(undefined, paragraphXml("Revenue grew 12%"), paragraphXml("Costs flat")),
        ],
        ["Mention the Q3 pricing change", "Ask for questions"],
      ),
      slide("slide2.xml", "rId3", [
        shapeXml("ctrTitle", paragraphXml("Controls")),
        tableXml(
          [
            ["Key", "Value"],
            ["C-17", "Encrypt backups"],
            ["C-18", "Rotate keys"],
          ],
          true,
        ),
      ]),
    ]);
    const result = await parse(bytes);

    expect(result.parser.parserId).toBe("pptx");
    expect(result.parser.dependencyVersions).toEqual([{ packageName: "yauzl", version: "3.4.0" }]);
    expect(result.diagnostics).toEqual([]);
    expect(result.sections.map((section) => section.sectionPath)).toEqual([
      ["Slide 1: Quarterly results"],
      ["Slide 2: Controls"],
    ]);
    const text = textOf(result);
    expect(text).toContain("Revenue grew 12%");
    expect(text).toContain("Speaker notes: Mention the Q3 pricing change Ask for questions");
    expect(text).toContain("Table row 1: Key=C-17 | Value=Encrypt backups");
    expect(text).toContain("Table row 2: Key=C-18 | Value=Rotate keys");
    expect(text).not.toContain("Table row 3");
    // The slide-number field and the slide-image placeholder on the notes page add no text.
    expect(text).not.toMatch(/\b7\b/u);
    const [first, second] = result.sections;
    expect(first?.characterStart).toBe(0);
    expect(text.slice(first?.characterStart, first?.characterEnd)).toContain("Costs flat");
    expect(first?.characterEnd).toBe(second?.characterStart);
    expect(second?.characterEnd).toBe(text.length);
    expect(text.slice(second?.characterStart, second?.characterEnd)).toMatch(/^Slide 2: Controls/u);
    expect(result.units.map((unit) => unit.kind)).toEqual(["section", "section"]);
  });

  it("orders slides by the presentation relationships, not by part file name", async () => {
    const bytes = buildPptx([
      slide("slide2.xml", "rId9", [shapeXml("title", paragraphXml("Presented first"))]),
      slide("slide1.xml", "rId1", [shapeXml("title", paragraphXml("Presented second"))]),
    ]);
    const result = await parse(bytes);

    expect(result.sections.map((section) => section.sectionPath[0])).toEqual([
      "Slide 1: Presented first",
      "Slide 2: Presented second",
    ]);
  });

  it("numbers a slide without a title and keeps the numbering across text-free slides", async () => {
    const bytes = buildPptx([
      slide("slide1.xml", "rId1", [shapeXml(undefined, paragraphXml("Only a body"))]),
      slide("slide2.xml", "rId2", [shapeXml("sldNum", paragraphXml("2"))]),
      slide("slide3.xml", "rId3", [shapeXml("title", paragraphXml("Third"))]),
    ]);
    const result = await parse(bytes);

    expect(result.sections.map((section) => section.sectionPath[0])).toEqual([
      "Slide 1",
      "Slide 3: Third",
    ]);
  });

  describe("long titles", () => {
    const filler = "A".repeat(120);

    it("shortens only the section label and keeps the complete title in the indexed text", async () => {
      const title = `${filler} LH-099 Required control`;
      const bytes = buildPptx([
        slide("slide1.xml", "rId1", [
          shapeXml("title", paragraphXml(title)),
          shapeXml(undefined, paragraphXml("Body line")),
        ]),
      ]);
      const result = await parse(bytes);

      expect(result.diagnostics).toEqual([]);
      expect(result.sections[0]?.sectionPath).toEqual([`Slide 1: ${filler}`]);
      expect(textOf(result)).toContain("LH-099 Required control");
      expect(textOf(result)).toContain(`${title}\nBody line`);
    });

    it("keeps every paragraph of a multi-paragraph title that exceeds the label length", async () => {
      const bytes = buildPptx([
        slide("slide1.xml", "rId1", [
          shapeXml(
            "ctrTitle",
            paragraphXml(`${filler} first`),
            paragraphXml("second LH-100"),
            paragraphXml("third LH-101"),
          ),
        ]),
      ]);
      const result = await parse(bytes);
      const text = textOf(result);

      expect(result.sections[0]?.sectionPath[0]).toBe(`Slide 1: ${filler}`);
      expect(text).toContain(`${filler} first\nsecond LH-100\nthird LH-101`);
    });

    it("does not repeat a title that fits the label", async () => {
      const bytes = buildPptx([
        slide("slide1.xml", "rId1", [
          shapeXml("title", paragraphXml("Short"), paragraphXml("title")),
        ]),
      ]);
      const text = textOf(await parse(bytes));

      expect(text).toBe("Slide 1: Short title");
    });
  });

  describe("XML-aware tokenization", () => {
    const rawSlide = (...shapes: readonly string[]): readonly FixtureSlide[] => [
      { file: "slide1.xml", relationshipId: "rId1", xml: slidePartXml(...shapes) },
    ];
    const specShape = (ph: string, text: string): string =>
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphXml(text)}</p:txBody></p:sp>`;

    it("ignores element-looking text inside comments", async () => {
      const ghost = `<!-- ${shapeXml(undefined, paragraphXml("Fictional shape"))} -->`;
      const inside = "<a:p><a:r><!-- <a:t>ghost run</a:t> --><a:t>real</a:t></a:r></a:p>";
      const bytes = buildPptx(
        rawSlide(ghost, shapeXml(undefined, inside), "<!-- <!DOCTYPE x> <?pi?> -->"),
      );
      const result = await parse(bytes);

      expect(result.diagnostics).toEqual([]);
      expect(textOf(result)).toBe("Slide 1\nreal");
    });

    it("emits CDATA as literal character data without its wrapper", async () => {
      const cdata = "<a:p><a:r><a:t>x <![CDATA[a <b> &amp; &#65; c]]> y</a:t></a:r></a:p>";
      const bytes = buildPptx(rawSlide(shapeXml(undefined, cdata)));
      const text = textOf(await parse(bytes));

      expect(text).toBe("Slide 1\nx a <b> &amp; &#65; c y");
      expect(text).not.toContain("CDATA");
    });

    it("keeps a quoted > inside an attribute value within its tag", async () => {
      const bytes = buildPptx(
        rawSlide(specShape('<p:ph name="a > b" type="title"/>', "Quoted title")),
      );

      expect((await parse(bytes)).sections[0]?.sectionPath).toEqual(["Slide 1: Quoted title"]);
    });

    it("reads an attribute by its own name, not from text inside another value", async () => {
      const bytes = buildPptx(
        rawSlide(specShape(`<p:ph name="x type='title'" type="body"/>`, "Body text")),
      );
      const result = await parse(bytes);

      expect(result.sections[0]?.sectionPath).toEqual(["Slide 1"]);
      expect(textOf(result)).toBe("Slide 1\nBody text");
    });

    it("decodes predefined entities and numeric references in attribute values", async () => {
      const bytes = buildPptx(
        rawSlide(specShape(`<p:ph name="&lt;" type="&#116;itle"/>`, "Decoded title")),
      );

      expect((await parse(bytes)).sections[0]?.sectionPath).toEqual(["Slide 1: Decoded title"]);
    });
  });

  it("treats a table without a header row as positional columns", async () => {
    const bytes = buildPptx([
      slide("slide1.xml", "rId1", [
        tableXml([["a", "b"]], false),
        shapeXml("title", paragraphXml("T")),
      ]),
    ]);

    expect(textOf(await parse(bytes))).toContain("Table row 1: Column 1=a | Column 2=b");
  });

  it("decodes character references but never expands declared or unknown entities", async () => {
    const bytes = buildPptx([
      slide("slide1.xml", "rId1", [
        shapeXml(undefined, paragraphXml("Don&#8217;t &amp; &lt;b&gt; &amp;lt; &lol9; &#xD800;")),
      ]),
    ]);
    const text = textOf(await parse(bytes));

    expect(text).toContain("Don’t & <b> &lt; &lol9; &#xD800;");
  });

  it("drops the slide-number and date fields but keeps other field text", async () => {
    const field = (type: string, text: string): string =>
      `<a:fld id="{1}" type="${type}"><a:t>${text}</a:t></a:fld>`;
    const bytes = buildPptx([
      slide("slide1.xml", "rId1", [
        shapeXml(
          undefined,
          `<a:p>${field("slidenum", "9")}${field("datetime1", "01.01.2026")}${field("custom", "kept")}</a:p>`,
        ),
      ]),
    ]);
    const text = textOf(await parse(bytes));

    expect(text).toContain("kept");
    expect(text).not.toContain("01.01.2026");
    expect(text).not.toMatch(/\b9\b/u);
  });

  it("reports an empty deck as having no extractable text", async () => {
    const result = await parse(buildPptx([]));

    expect(result.sections).toEqual([]);
    expect(codes(result)).toEqual(["UNSUPPORTED_FORMAT"]);
    expect(result.units).toEqual([
      expect.objectContaining({ kind: "unsupported-media", reason: "pptx-no-text" }),
    ]);
  });

  it("reports a deck whose slides carry no text as having no extractable text", async () => {
    const bytes = buildPptx([slide("slide1.xml", "rId1", [shapeXml(undefined, "<a:p/>")])]);

    expect((await parse(bytes)).units).toEqual([
      expect.objectContaining({ kind: "unsupported-media", reason: "pptx-no-text" }),
    ]);
  });

  describe("fail-closed handling", () => {
    it("rejects a slide with unterminated markup", async () => {
      const truncated = "<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Hel";
      const bytes = buildPptx([{ file: "slide1.xml", relationshipId: "rId1", xml: truncated }]);
      const result = await parse(bytes);

      expect(codes(result)).toEqual(["MALFORMED_INPUT"]);
      expect(result.diagnostics[0]?.severity).toBe("error");
      expect(result.units).toEqual([]);
    });

    it("rejects mismatched closing tags", async () => {
      const bytes = buildPptx([
        { file: "slide1.xml", relationshipId: "rId1", xml: "<p:sld><a:p></p:sld></a:p>" },
      ]);

      expect(codes(await parse(bytes))).toEqual(["MALFORMED_INPUT"]);
    });

    it.each([
      ["an unmatched start tag before a closing tag", "<p:sld><p:cSld><broken</p:cSld></p:sld>"],
      ["a start tag cut off before its end", "<p:sld><p:cSld></p:cSld></p:sld><broken"],
      ["an unquoted attribute value", "<p:sld><p:ph type=title/></p:sld>"],
      ["an unterminated attribute value", '<p:sld><p:ph type="title/></p:sld>'],
      ["a repeated attribute", '<p:sld><p:ph type="a" type="b"/></p:sld>'],
      ["attributes without separating whitespace", '<p:sld><p:ph type="a"id="b"/></p:sld>'],
      ["a bare < in character data", "<p:sld><a:t>1 < 2</a:t></p:sld>"],
      ["an unterminated comment", "<p:sld><!-- never closed </p:sld>"],
      ["an unterminated CDATA section", "<p:sld><a:t><![CDATA[never closed</a:t></p:sld>"],
      ["a processing instruction", "<p:sld><?target data?><a:t>x</a:t></p:sld>"],
      ["an XML declaration after the start", '<p:sld><?xml version="1.0"?></p:sld>'],
      ["attributes on a closing tag", '<p:sld></p:sld type="a">'],
    ])("rejects %s", async (_label, xml) => {
      const bytes = buildPptx([{ file: "slide1.xml", relationshipId: "rId1", xml }]);
      const result = await parse(bytes);

      expect(codes(result)).toEqual(["MALFORMED_INPUT"]);
      expect(result.units).toEqual([]);
    });

    it("rejects bytes that are not a zip archive", async () => {
      const result = await parse(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));

      expect(codes(result)).toEqual(["MALFORMED_INPUT"]);
    });

    it("rejects a package without a presentation part", async () => {
      const bytes = zipTextEntries([{ name: "ppt/slides/slide1.xml", content: slidePartXml() }]);

      expect(codes(await parse(bytes))).toEqual(["MALFORMED_INPUT"]);
    });

    it("rejects a DOCTYPE or ENTITY declaration in any part", async () => {
      const hostile =
        '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]>' +
        slidePartXml(shapeXml(undefined, paragraphXml("&lol2;")));
      const bytes = buildPptx([{ file: "slide1.xml", relationshipId: "rId1", xml: hostile }]);
      const result = await parse(bytes);

      expect(codes(result)).toEqual(["MALFORMED_INPUT"]);
      expect(textOf(result)).toBe("");
    });

    it("rejects a package that lists the same slide part twice", async () => {
      const entries = pptxEntries([
        slide("slide1.xml", "rId1", [shapeXml("title", paragraphXml("One"))]),
      ]);
      const duplicate = entries.find((entry) => entry.name === "ppt/slides/slide1.xml");

      if (duplicate === undefined) throw new Error("fixture slide entry missing");
      const result = await parse(zipTextEntries([...entries, duplicate]));

      expect(codes(result)).toEqual(["MALFORMED_INPUT"]);
    });

    it("rejects markup nested deeper than the nesting limit", async () => {
      const deep = `${"<p:grpSp>".repeat(8)}${"</p:grpSp>".repeat(8)}`;
      const bytes = buildPptx([
        { file: "slide1.xml", relationshipId: "rId1", xml: `<p:sld>${deep}</p:sld>` },
      ]);

      expect(codes(await parse(bytes, { maxNestingDepth: 4 }))).toEqual(["MALFORMED_INPUT"]);
    });
  });

  describe("missing slide parts", () => {
    it("skips a listed slide whose part is absent and warns once", async () => {
      const entries = pptxEntries([
        slide("slide1.xml", "rId1", [shapeXml("title", paragraphXml("Present"))]),
        slide("slide2.xml", "rId2", [shapeXml("title", paragraphXml("Absent"))]),
      ]).filter((entry) => entry.name !== "ppt/slides/slide2.xml");
      const result = await parse(zipTextEntries(entries));

      expect(result.sections.map((section) => section.sectionPath[0])).toEqual([
        "Slide 1: Present",
      ]);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: "MALFORMED_INPUT", severity: "warning" }),
      ]);
    });

    it("fails closed when no listed slide part exists", async () => {
      const entries = pptxEntries([
        slide("slide1.xml", "rId1", [shapeXml("title", paragraphXml("Absent"))]),
      ]).filter((entry) => entry.name !== "ppt/slides/slide1.xml");

      expect(codes(await parse(zipTextEntries(entries)))).toEqual(["MALFORMED_INPUT"]);
    });

    it("ignores relationship targets that escape the package or point outside it", async () => {
      const entries: ZipTextEntry[] = [
        { name: "ppt/presentation.xml", content: presentationPartXml(["rId1", "rId2"]) },
        {
          name: "ppt/_rels/presentation.xml.rels",
          content: relationshipsXml([
            { id: "rId1", type: "slide", target: "../../outside.xml" },
            { id: "rId2", type: "slide", target: "slides/slide1.xml" },
          ]),
        },
        {
          name: "ppt/slides/slide1.xml",
          content: slidePartXml(shapeXml("title", paragraphXml("Inside"))),
        },
      ];
      const result = await parse(zipTextEntries(entries));

      expect(result.sections.map((section) => section.sectionPath[0])).toEqual(["Slide 2: Inside"]);
    });

    it("keeps a slide readable when its notes part is absent", async () => {
      const entries = pptxEntries([
        slide("slide1.xml", "rId1", [shapeXml("title", paragraphXml("Solo"))], ["gone"]),
      ]).filter((entry) => !entry.name.startsWith("ppt/notesSlides/"));
      const result = await parse(zipTextEntries(entries));

      expect(result.diagnostics).toEqual([]);
      expect(textOf(result)).toBe("Slide 1: Solo");
    });
  });

  describe("bounds", () => {
    const smallDeck = (): Uint8Array =>
      buildPptx([slide("slide1.xml", "rId1", [shapeXml("title", paragraphXml("Small"))])]);

    it("refuses input larger than maxBytes", async () => {
      const bytes = smallDeck();
      const result = await parse(bytes, { maxBytes: bytes.byteLength - 1 });

      expect(codes(result)).toEqual(["OVERSIZED_FILE"]);
    });

    it("rejects an entry that inflates beyond the derived limit", async () => {
      const bomb = buildPptx([
        slide("slide1.xml", "rId1", [shapeXml(undefined, paragraphXml("A".repeat(65_536)))]),
      ]);
      const result = await parse(bomb, { maxBytes: 4096 + bomb.byteLength });

      expect(codes(result)).toEqual(["MALFORMED_INPUT"]);
    });

    it("rejects an entry whose compression ratio exceeds the ratio bound", async () => {
      const bomb = buildPptx([
        slide("slide1.xml", "rId1", [shapeXml(undefined, paragraphXml("A".repeat(65_536)))]),
      ]);

      expect(codes(await parse(bomb))).toEqual(["MALFORMED_INPUT"]);
    });

    it("aborts a many-entry archive with PARSER_TIMEOUT instead of walking every entry", async () => {
      const filler = Array.from({ length: 16_500 }, (_, index) => ({
        name: `media/filler-${String(index).padStart(6, "0")}.xml`,
        content: "<x/>",
      }));
      const bytes = zipTextEntries([
        ...filler,
        ...pptxEntries([slide("slide1.xml", "rId1", [shapeXml("title", paragraphXml("Late"))])]),
      ]);
      const result = await parse(bytes);

      expect(codes(result)).toEqual(["PARSER_TIMEOUT"]);
      expect(result.units).toEqual([]);
    });

    it("stops section emission at maxUnitsPerDocument", async () => {
      const bytes = buildPptx(
        Array.from({ length: 5 }, (_, index) =>
          slide(`slide${String(index + 1)}.xml`, `rId${String(index + 1)}`, [
            shapeXml("title", paragraphXml(`Topic ${String(index + 1)}`)),
          ]),
        ),
      );
      const result = await parse(bytes, { maxUnitsPerDocument: 2 });

      expect(result.units).toHaveLength(2);
      expect(codes(result)).toContain("UNIT_LIMIT_REACHED");
    });

    it("stops at maxObjectsPerDocument and discloses the truncation", async () => {
      const paragraphs = Array.from({ length: 20 }, (_, index) =>
        paragraphXml(`P${String(index)}`),
      );
      const bytes = buildPptx([slide("slide1.xml", "rId1", [shapeXml(undefined, ...paragraphs)])]);
      const result = await parse(bytes, { maxObjectsPerDocument: 5 });

      expect(codes(result)).toContain("OBJECT_LIMIT_REACHED");
      expect(textOf(result)).not.toContain("P19");
    });

    it("reports cancellation before and during the scan", async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await parse(smallDeck(), { signal: controller.signal });

      expect(codes(result)).toEqual(["PARSER_CANCELLED"]);
    });

    it("reports the elapsed deadline as PARSER_TIMEOUT", async () => {
      let tick = 0;
      const result = await parse(smallDeck(), { now: () => (tick += 1_000_000), timeoutMs: 10 });

      expect(codes(result)).toEqual(["PARSER_TIMEOUT"]);
    });
  });

  describe("selection", () => {
    it("matches by .pptx extension or presentation media type and not legacy .ppt", () => {
      const match = (extension: string, mediaType = ""): boolean =>
        pptxParser.capability.matches(
          selectionFromBytes(new Uint8Array(), { extension, mediaType }),
        );

      expect(match("pptx")).toBe(true);
      expect(match("", PPTX_EXTENSION_INPUT.mediaType)).toBe(true);
      expect(match("ppt")).toBe(false);
      expect(match("docx")).toBe(false);
      expect(isLegacyBinaryOfficeFormat("ppt")).toBe(true);
    });

    it("answers a synchronous call with an async-required unsupported unit", () => {
      const result = pptxParser.parse(
        selectionFromBytes(new Uint8Array(), PPTX_EXTENSION_INPUT),
        buildParserOptions({ now: () => 0 }),
      );

      expect(result.units).toEqual([
        expect.objectContaining({ kind: "unsupported-media", reason: "pptx-async-required" }),
      ]);
    });
  });
});
