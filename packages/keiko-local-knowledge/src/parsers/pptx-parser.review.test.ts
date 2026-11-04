// Independent-review pins for the pptx parser (#4235): findings from reading python-pptx and
// LibreOffice output and from damaged packages. Each case fails on the reader it was written against.

import { describe, expect, it } from "vitest";

import { selectionFromBytes, zipTextEntries, type ZipTextEntry } from "./parser-test-fixtures.js";
import { pptxParser } from "./pptx-parser.js";
import {
  PPTX_EXTENSION_INPUT,
  buildPptx,
  paragraphXml,
  pptxEntries,
  relationshipsXml,
  shapeXml,
  slidePartXml,
} from "./pptx-test-fixtures.js";
import { buildParserOptions } from "./registry.js";
import type { ParserResult } from "./types.js";

async function parse(bytes: Uint8Array): Promise<ParserResult> {
  return pptxParser.parseAsync(
    selectionFromBytes(bytes, PPTX_EXTENSION_INPUT),
    buildParserOptions({ now: () => 0 }),
  );
}

function linesOf(result: ParserResult): readonly string[] {
  return "normalizedText" in result && typeof result.normalizedText === "string"
    ? result.normalizedText.split("\n")
    : [];
}

function oneSlide(xml: string): Uint8Array {
  return buildPptx([{ file: "slide1.xml", relationshipId: "rId1", xml }]);
}

function tableSlide(rows: readonly (readonly string[])[], firstRow: boolean): string {
  const body = rows
    .map(
      (cells) =>
        `<a:tr>${cells
          .map((cell) => `<a:tc><a:txBody><a:bodyPr/>${paragraphXml(cell)}</a:txBody></a:tc>`)
          .join("")}</a:tr>`,
    )
    .join("");
  return slidePartXml(
    `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tblPr firstRow="${firstRow ? "1" : "0"}"/>${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
  );
}

describe("pptx table projection syntax", () => {
  it("keeps a pipe inside a cell from reading as the next cell", async () => {
    const slide = tableSlide(
      [
        ["Regel", "Formel"],
        ["R1", "a | b"],
        ["R2", "x=y"],
      ],
      true,
    );
    expect(linesOf(await parse(oneSlide(slide))).slice(1)).toEqual([
      "Table row 1: Regel=R1 | Formel=a ¦ b",
      "Table row 2: Regel=R2 | Formel=x=y",
    ]);
  });

  it("keeps projection syntax out of a column label", async () => {
    const slide = tableSlide(
      [
        ["Soll = Ist", "Wert | Einheit"],
        ["1", "2"],
      ],
      true,
    );
    expect(linesOf(await parse(oneSlide(slide))).slice(1)).toEqual([
      "Table row 1: Soll Ist=1 | Wert Einheit=2",
    ]);
  });
});

describe("pptx no-break spaces", () => {
  it("indexes a no-break space as a space, as the docx parser does", async () => {
    const slide = slidePartXml(
      shapeXml(undefined, paragraphXml("Betrag 10 EUR netto")),
      tableSlideCell("Wert 5"),
    );
    expect(linesOf(await parse(oneSlide(slide))).slice(1)).toEqual([
      "Betrag 10 EUR netto",
      "Table row 1: Column 1=Wert 5",
    ]);
  });
});

function tableSlideCell(text: string): string {
  return `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tblPr/><a:tr><a:tc><a:txBody><a:bodyPr/>${paragraphXml(text)}</a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

describe("pptx speaker notes whose placeholder names no type", () => {
  it("reads the notes text of a placeholder that leaves the type to its default", async () => {
    const entries = pptxEntries([
      {
        file: "slide1.xml",
        relationshipId: "rId1",
        xml: slidePartXml(shapeXml("title", paragraphXml("Titel"))),
        notes: ["Notiz"],
      },
    ]).map((entry) =>
      entry.name.startsWith("ppt/notesSlides/")
        ? { ...entry, content: entry.content.replace('<p:ph type="body"/>', '<p:ph idx="1"/>') }
        : entry,
    );
    expect(linesOf(await parse(zipTextEntries(entries)))).toEqual([
      "Slide 1: Titel",
      "Speaker notes: Notiz",
    ]);
  });
});

describe("pptx unreadable chart and diagram references", () => {
  const C_NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"';
  const frame = (id: string): string =>
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Frame"/></p:nvGraphicFramePr><a:graphic><a:graphicData uri="u"><c:chart ${C_NS} r:id="${id}"/></a:graphicData></a:graphic></p:graphicFrame>`;
  const chart = `<?xml version="1.0"?><c:chartSpace ${C_NS}><c:chart/></c:chartSpace>`;

  function deck(target: string, type = "chart", withPart = true): Uint8Array {
    const slide = slidePartXml(shapeXml(undefined, paragraphXml("Text")), frame("rId5"));
    const parts: ZipTextEntry[] = withPart
      ? [{ name: "ppt/charts/chart1.xml", content: chart }]
      : [];
    return zipTextEntries([
      ...pptxEntries([{ file: "slide1.xml", relationshipId: "rId1", xml: slide }]),
      {
        name: "ppt/slides/_rels/slide1.xml.rels",
        content: relationshipsXml([{ id: "rId5", type, target }]),
      },
      ...parts,
    ]);
  }

  function skipped(result: ParserResult): readonly string[] {
    return result.diagnostics
      .filter((entry) => entry.code === "PART_SKIPPED")
      .map((entry) => `${entry.severity}:${entry.message}`);
  }

  it.each([
    ["a target outside the package", deck("../../../outside/chart1.xml")],
    ["a part that is not in the package", deck("../charts/gone.xml")],
    ["a relationship of another type", deck("../charts/chart1.xml", "image")],
  ])("says so when the chart reference has %s", async (_label, bytes) => {
    const result = await parse(bytes);
    expect(linesOf(result)).toEqual(["Slide 1", "Text"]);
    expect(skipped(result)).toEqual([
      "warning:pptx 1 chart or diagram part(s) could not be read and were skipped",
    ]);
  });

  it("stays silent when the chart is read", async () => {
    expect(skipped(await parse(deck("../charts/chart1.xml")))).toEqual([]);
  });

  it("counts each unreadable reference once and keeps the rest of the deck", async () => {
    const slide = slidePartXml(frame("rId5"), frame("rId5"));
    const bytes = zipTextEntries([
      ...pptxEntries([{ file: "slide1.xml", relationshipId: "rId1", xml: slide }]),
      {
        name: "ppt/slides/_rels/slide1.xml.rels",
        content: relationshipsXml([{ id: "rId5", type: "chart", target: "../charts/gone.xml" }]),
      },
    ]);
    const result = await parse(bytes);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["PART_SKIPPED"]);
    expect(result.diagnostics[0]?.message).toContain("pptx 2 chart or diagram");
  });
});
