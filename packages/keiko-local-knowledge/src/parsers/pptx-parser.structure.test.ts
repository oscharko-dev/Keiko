// Structure-level regression pins for the pptx parser (#4235): notes paragraphs, reading order,
// bullet levels, merged cells, alternate renderings, embedded chart and SmartArt text, and hidden
// slides. Each group fails on the previous reader.

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
  tableXml,
} from "./pptx-test-fixtures.js";
import { buildParserOptions } from "./registry.js";
import type { ParserOptions, ParserResult } from "./types.js";

async function parse(
  bytes: Uint8Array,
  overrides: Partial<ParserOptions> = {},
): Promise<ParserResult> {
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

function linesOf(result: ParserResult): readonly string[] {
  return textOf(result)
    .split("\n")
    .filter((line) => line.length > 0);
}

const C_NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"';
const DGM_NS = 'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"';
const MC_NS = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';

function xfrm(x: number, y: number, tag = "a:xfrm"): string {
  return `<${tag}><a:off x="${String(x)}" y="${String(y)}"/><a:ext cx="100" cy="100"/></${tag}>`;
}

function shapeAt(
  x: number,
  y: number,
  placeholder: string | undefined,
  ...texts: string[]
): string {
  return shapeXml(placeholder, ...texts.map((text) => paragraphXml(text))).replace(
    "<p:spPr/>",
    `<p:spPr>${xfrm(x, y)}</p:spPr>`,
  );
}

function groupAt(
  offset: readonly [number, number],
  child: readonly [number, number],
  scale: readonly [number, number],
  ...shapes: string[]
): string {
  const [ox, oy] = offset;
  const [cx, cy] = child;
  const [ex, ey] = scale;
  return (
    `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm><a:off x="${String(ox)}" y="${String(oy)}"/>` +
    `<a:ext cx="${String(ex)}" cy="${String(ey)}"/><a:chOff x="${String(cx)}" y="${String(cy)}"/>` +
    `<a:chExt cx="1000" cy="1000"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:grpSp>`
  );
}

function frameXml(inner: string, x = 0, y = 0): string {
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Frame"/></p:nvGraphicFramePr>${xfrm(x, y, "p:xfrm")}<a:graphic><a:graphicData uri="u">${inner}</a:graphicData></a:graphic></p:graphicFrame>`;
}

function chartFrame(relationshipId: string, x = 0, y = 0): string {
  return frameXml(`<c:chart ${C_NS} r:id="${relationshipId}"/>`, x, y);
}

function diagramFrame(relationshipId: string, x = 0, y = 0): string {
  return frameXml(`<dgm:relIds ${DGM_NS} r:dm="${relationshipId}" r:lo="rId9"/>`, x, y);
}

/** A one-slide deck whose slide relationships and extra parts the test supplies. */
function deck(
  slideXml: string,
  relationships: readonly { id: string; type: string; target: string }[],
  parts: readonly ZipTextEntry[] = [],
): Uint8Array {
  const entries = pptxEntries([{ file: "slide1.xml", relationshipId: "rId1", xml: slideXml }]);
  return zipTextEntries([
    ...entries,
    { name: "ppt/slides/_rels/slide1.xml.rels", content: relationshipsXml(relationships) },
    ...parts,
  ]);
}

const CHART_PART = `<?xml version="1.0"?><c:chartSpace ${C_NS} xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Umsatz je</a:t></a:r><a:r><a:t> Quartal</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:ser><c:idx val="0"/><c:tx><c:strRef><c:f>S!$B$1</c:f><c:strCache><c:pt idx="0"><c:v>Nord</c:v></c:pt></c:strCache></c:strRef></c:tx><c:dLbls><c:dLbl><c:tx><c:rich><a:p><a:r><a:t>Etikett</a:t></a:r></a:p></c:rich></c:tx></c:dLbl></c:dLbls><c:cat><c:strRef><c:f>S!$A$2</c:f><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>S!$B$2</c:f><c:numCache><c:formatCode>General</c:formatCode><c:pt idx="0"><c:v>120</c:v></c:pt><c:pt idx="1"><c:v>150</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart><c:catAx><c:title><c:tx><c:rich><a:p><a:r><a:t>Quartal</a:t></a:r></a:p></c:rich></c:tx></c:title></c:catAx><c:valAx><c:title><c:tx><c:rich><a:p><a:r><a:t>Euro</a:t></a:r></a:p></c:rich></c:tx></c:title></c:valAx></c:plotArea></c:chart></c:chartSpace>`;

const DIAGRAM_PART = `<?xml version="1.0"?><dgm:dataModel ${DGM_NS} xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst><dgm:pt modelId="{1}" type="doc"><dgm:t><a:bodyPr/><a:p><a:endParaRPr lang="de-DE"/></a:p></dgm:t></dgm:pt><dgm:pt modelId="{2}"><dgm:t><a:bodyPr/><a:p><a:r><a:t>Antrag</a:t></a:r></a:p></dgm:t></dgm:pt><dgm:pt modelId="{3}"><dgm:t><a:bodyPr/><a:p><a:r><a:t>Prüfung</a:t></a:r></a:p></dgm:t></dgm:pt><dgm:pt modelId="{4}" type="pres"><dgm:prSet/><dgm:t><a:bodyPr/><a:p><a:r><a:t>Layout</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst></dgm:dataModel>`;

describe("pptx speaker notes", () => {
  it("keeps every note paragraph as its own line and labels the first", async () => {
    const bytes = buildPptx([
      {
        file: "slide1.xml",
        relationshipId: "rId1",
        xml: slidePartXml(shapeXml("title", paragraphXml("Titel"))),
        notes: ["Erster Absatz", "Zweiter Absatz", "Dritter Absatz"],
      },
    ]);
    expect(linesOf(await parse(bytes))).toEqual([
      "Slide 1: Titel",
      "Speaker notes: Erster Absatz",
      "Zweiter Absatz",
      "Dritter Absatz",
    ]);
  });
});

describe("pptx reading order and bullet levels", () => {
  it("reads shapes top to bottom and left to right, whatever their order in the XML", async () => {
    const slide = slidePartXml(
      shapeAt(500_000, 4_000_000, undefined, "UNTEN"),
      shapeAt(3_000_000, 1_000_000, undefined, "OBEN RECHTS"),
      shapeAt(500_000, 1_000_000, undefined, "OBEN LINKS"),
    );
    const result = await parse(
      buildPptx([{ file: "slide1.xml", relationshipId: "rId1", xml: slide }]),
    );
    expect(linesOf(result)).toEqual(["Slide 1", "OBEN LINKS", "OBEN RECHTS", "UNTEN"]);
  });

  it("maps a shape inside a group through the group's transform", async () => {
    const slide = slidePartXml(
      shapeAt(0, 3_000_000, undefined, "MITTE"),
      groupAt([0, 5_000_000], [0, 0], [1000, 1000], shapeAt(0, 0, undefined, "IN GRUPPE")),
      shapeAt(0, 1_000_000, undefined, "OBEN"),
    );
    const result = await parse(
      buildPptx([{ file: "slide1.xml", relationshipId: "rId1", xml: slide }]),
    );
    expect(linesOf(result).slice(1)).toEqual(["OBEN", "MITTE", "IN GRUPPE"]);
  });

  it("keeps document order when no shape has a position, and keeps a placeholder behind its predecessor", async () => {
    const plain = slidePartXml(
      shapeXml("title", paragraphXml("Titel")),
      shapeXml(undefined, paragraphXml("zuerst")),
      shapeXml(undefined, paragraphXml("danach")),
    );
    expect(
      linesOf(await parse(buildPptx([{ file: "slide1.xml", relationshipId: "rId1", xml: plain }]))),
    ).toEqual(["Slide 1: Titel", "zuerst", "danach"]);
    const mixed = slidePartXml(
      shapeAt(0, 4_000_000, undefined, "unten"),
      shapeXml(undefined, paragraphXml("erbt unten")),
      shapeAt(0, 100_000, undefined, "oben"),
    );
    expect(
      linesOf(await parse(buildPptx([{ file: "slide1.xml", relationshipId: "rId1", xml: mixed }]))),
    ).toEqual(["Slide 1", "oben", "unten", "erbt unten"]);
  });

  it("indents a bullet by its level", async () => {
    const body = `<a:p><a:r><a:t>Haupt</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>Unter</a:t></a:r></a:p><a:p><a:pPr lvl="2"/><a:r><a:t>Tief</a:t></a:r></a:p>`;
    const slide = slidePartXml(shapeXml(undefined, body));
    const result = await parse(
      buildPptx([{ file: "slide1.xml", relationshipId: "rId1", xml: slide }]),
    );
    expect(linesOf(result)).toEqual(["Slide 1", "Haupt", "  Unter", "    Tief"]);
  });

  it("keeps a table cell with a line break on one projected line", async () => {
    const cell = `<a:p><a:r><a:t>eins</a:t></a:r><a:br/><a:r><a:t>zwei</a:t></a:r></a:p>`;
    const table = tableXml([["h"]], false)
      .replace("<a:p>", "")
      .replace(/<a:r>.*<\/a:p>/u, "");
    expect(table).toContain("a:tbl");
    const slide = slidePartXml(
      `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tblPr/><a:tr><a:tc><a:txBody>${cell}</a:txBody></a:tc><a:tc><a:txBody>${paragraphXml("x")}</a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
    );
    const result = await parse(
      buildPptx([{ file: "slide1.xml", relationshipId: "rId1", xml: slide }]),
    );
    expect(linesOf(result)).toEqual(["Slide 1", "Table row 1: Column 1=eins zwei | Column 2=x"]);
  });
});

describe("pptx merged table cells", () => {
  it("repeats the value of a vertically merged cell and keeps horizontally merged columns aligned", async () => {
    const cell = (text: string, attributes = ""): string =>
      `<a:tc${attributes}><a:txBody><a:bodyPr/>${paragraphXml(text)}</a:txBody></a:tc>`;
    const rows = [
      `<a:tr>${cell("Gruppe")}${cell("Name")}${cell("Wert")}</a:tr>`,
      `<a:tr>${cell("A", ' rowSpan="2"')}${cell("x")}${cell("1")}</a:tr>`,
      `<a:tr>${cell("", ' vMerge="1"')}${cell("y")}${cell("2")}</a:tr>`,
      `<a:tr>${cell("B", ' gridSpan="2"')}${cell("", ' hMerge="1"')}${cell("3")}</a:tr>`,
    ].join("");
    const slide = slidePartXml(
      `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tblPr firstRow="1"/>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
    );
    const result = await parse(
      buildPptx([{ file: "slide1.xml", relationshipId: "rId1", xml: slide }]),
    );
    expect(linesOf(result).slice(1)).toEqual([
      "Table row 1: Gruppe=A | Name=x | Wert=1",
      "Table row 2: Gruppe=A | Name=y | Wert=2",
      "Table row 3: Gruppe=B | Name= | Wert=3",
    ]);
  });
});

describe("pptx alternate renderings", () => {
  it("reads a shape once when the slide offers it as a choice and a fallback", async () => {
    const alternate = `<mc:AlternateContent ${MC_NS}><mc:Choice Requires="a14">${shapeXml(undefined, paragraphXml("Formel"))}</mc:Choice><mc:Fallback>${shapeXml(undefined, paragraphXml("Formel"))}</mc:Fallback></mc:AlternateContent>`;
    const slide = slidePartXml(alternate, shapeXml(undefined, paragraphXml("Danach")));
    const result = await parse(
      buildPptx([{ file: "slide1.xml", relationshipId: "rId1", xml: slide }]),
    );
    expect(linesOf(result)).toEqual(["Slide 1", "Formel", "Danach"]);
  });
});

describe("pptx embedded charts and diagrams", () => {
  const rels = [
    { id: "rId5", type: "chart", target: "../charts/chart1.xml" },
    { id: "rId6", type: "diagramData", target: "../diagrams/data1.xml" },
  ];
  const parts: ZipTextEntry[] = [
    { name: "ppt/charts/chart1.xml", content: CHART_PART },
    { name: "ppt/diagrams/data1.xml", content: DIAGRAM_PART },
  ];

  it("reads the title, axis titles, series name, categories and values of a chart", async () => {
    const slide = slidePartXml(shapeXml("title", paragraphXml("Zahlen")), chartFrame("rId5"));
    const result = await parse(deck(slide, rels, parts));
    expect(linesOf(result)).toEqual([
      "Slide 1: Zahlen",
      "Chart title: Umsatz je Quartal",
      "Chart series Nord: Q1=120 | Q2=150",
      "Axis title: Quartal",
      "Axis title: Euro",
    ]);
  });

  it("reads SmartArt node labels and skips layout bookkeeping points", async () => {
    const slide = slidePartXml(diagramFrame("rId6"));
    const result = await parse(deck(slide, rels, parts));
    expect(linesOf(result)).toEqual(["Slide 1", "Antrag", "Prüfung"]);
  });

  it("places chart text by the frame's position among the other shapes", async () => {
    const slide = slidePartXml(
      chartFrame("rId5", 0, 5_000_000),
      shapeAt(0, 1_000_000, undefined, "Einleitung"),
    );
    const result = await parse(deck(slide, rels, parts));
    expect(linesOf(result).slice(1, 3)).toEqual(["Einleitung", "Chart title: Umsatz je Quartal"]);
  });

  it("ignores a reference of the wrong relationship type and a missing part", async () => {
    const wrong = [{ id: "rId5", type: "image", target: "../charts/chart1.xml" }];
    const missing = [{ id: "rId5", type: "chart", target: "../charts/gone.xml" }];
    const slide = slidePartXml(shapeXml(undefined, paragraphXml("Text")), chartFrame("rId5"));
    expect(linesOf(await parse(deck(slide, wrong, parts)))).toEqual(["Slide 1", "Text"]);
    expect(linesOf(await parse(deck(slide, missing, parts)))).toEqual(["Slide 1", "Text"]);
  });

  it("charges chart values against the object budget and discloses the cut", async () => {
    const slide = slidePartXml(chartFrame("rId5"));
    const result = await parse(deck(slide, rels, parts), { maxObjectsPerDocument: 3 });
    expect(result.diagnostics.map((entry) => entry.code)).toContain("OBJECT_LIMIT_REACHED");
  });

  it("fails closed on a chart part that is not well formed", async () => {
    const broken: ZipTextEntry[] = [
      { name: "ppt/charts/chart1.xml", content: "<c:chartSpace><c:chart>" },
    ];
    const slide = slidePartXml(chartFrame("rId5"));
    const result = await parse(deck(slide, rels, broken));
    expect(result.diagnostics[0]?.code).toBe("MALFORMED_INPUT");
  });
});

describe("pptx hidden slides", () => {
  it("keeps a hidden slide indexed and counts it without naming it", async () => {
    const hidden = slidePartXml(shapeXml("title", paragraphXml("Intern"))).replace(
      "<p:sld ",
      '<p:sld show="0" ',
    );
    const shown = slidePartXml(shapeXml("title", paragraphXml("Öffentlich")));
    const bytes = buildPptx([
      { file: "slide1.xml", relationshipId: "rId1", xml: shown },
      { file: "slide2.xml", relationshipId: "rId2", xml: hidden },
    ]);
    const result = await parse(bytes);
    expect(linesOf(result)).toEqual(["Slide 1: Öffentlich", "Slide 2: Intern"]);
    expect(result.diagnostics).toEqual([
      {
        severity: "info",
        code: "HIDDEN_SLIDE_INDEXED",
        message: "indexed 1 hidden slide(s); hidden slides stay searchable",
        documentId: result.documentId,
      },
    ]);
  });

  it("does not count a slide that is shown", async () => {
    const shown = slidePartXml(shapeXml("title", paragraphXml("A"))).replace(
      "<p:sld ",
      '<p:sld show="1" ',
    );
    const result = await parse(
      buildPptx([{ file: "slide1.xml", relationshipId: "rId1", xml: shown }]),
    );
    expect(result.diagnostics).toEqual([]);
  });
});
