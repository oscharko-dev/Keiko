// The contract between the document parsers and the requirement inventory (#4235): a blank line ends
// a block of normalized text in every format, and only the items of one list and the rows of one
// table stay on adjacent lines. A paragraph is never read into the paragraph or the table cell before
// it, and a list inside a table cell stays a list.

import { describe, expect, it } from "vitest";

import {
  deriveRequirementInventory,
  type RequirementInventory,
} from "@oscharko-dev/keiko-quality-intelligence";

import { csvParser } from "../../packages/keiko-local-knowledge/src/parsers/csv-parser.js";
import {
  cellXml,
  documentXml,
  parseDocx,
  plainTable,
  rowXml,
  tableXml,
  textCell,
  textOf,
  textPara,
} from "../../packages/keiko-local-knowledge/src/parsers/docx-test-fixtures.js";
import { htmlParser } from "../../packages/keiko-local-knowledge/src/parsers/html-parser.js";
import { jsonParser } from "../../packages/keiko-local-knowledge/src/parsers/json-parser.js";
import {
  selectionFromBytes,
  selectionFromText,
} from "../../packages/keiko-local-knowledge/src/parsers/parser-test-fixtures.js";
import { pptxParser } from "../../packages/keiko-local-knowledge/src/parsers/pptx-parser.js";
import {
  PPTX_EXTENSION_INPUT,
  buildPptx,
  paragraphXml,
  shapeXml,
  slidePartXml,
  tableXml as pptxTable,
} from "../../packages/keiko-local-knowledge/src/parsers/pptx-test-fixtures.js";
import { buildParserOptions } from "../../packages/keiko-local-knowledge/src/parsers/registry.js";
import type { ParserResult } from "../../packages/keiko-local-knowledge/src/parsers/types.js";

const OPTIONS = buildParserOptions({ now: () => 0 });

function normalized(result: ParserResult): string {
  return "normalizedText" in result && typeof result.normalizedText === "string"
    ? result.normalizedText
    : "";
}

function inventoryOf(text: string): RequirementInventory {
  return deriveRequirementInventory({ text, documentKey: "doc" });
}

function criteriaOf(inventory: RequirementInventory): readonly string[] {
  return inventory.entries[0]?.acceptanceCriteria.map((item) => item.text) ?? [];
}

function html(markup: string): string {
  return normalized(htmlParser.parse(selectionFromText(markup, { extension: "html" }), OPTIONS));
}

function csv(content: string): string {
  return normalized(csvParser.parse(selectionFromText(content, { extension: "csv" }), OPTIONS));
}

function json(content: unknown): string {
  const text = JSON.stringify(content, null, 2);
  return normalized(jsonParser.parse(selectionFromText(text, { extension: "json" }), OPTIONS));
}

async function pptx(xml: string): Promise<string> {
  const bytes = buildPptx([{ file: "slide1.xml", relationshipId: "rId1", xml }]);
  const input = selectionFromBytes(bytes, PPTX_EXTENSION_INPUT);
  return normalized(await pptxParser.parseAsync(input, OPTIONS));
}

const FOLLOWING = "Der Folgeabsatz gehört nicht zur Tabelle.";
const OBLIGATION = "Die Einwilligung muss freiwillig erteilt werden.";

describe("a paragraph behind a table", () => {
  it("is not read into the last cell of a Word table", async () => {
    const document = documentXml(
      plainTable(
        [
          ["ID", "Titel", "Beschreibung"],
          ["FR-1", "Login", "Die Bank prüft den Kunden."],
        ],
        true,
      ),
      textPara(FOLLOWING),
    );
    const text = textOf(await parseDocx({ document }));

    expect(text.endsWith(`\n\n${FOLLOWING}`)).toBe(true);
    expect(inventoryOf(text).entries[0]?.statement).toBe("Die Bank prüft den Kunden.");
  });

  it("is not read into the last cell of an HTML table", () => {
    const text = html(
      `<table><tr><th>ID</th><th>Beschreibung</th></tr><tr><td>FR-1</td><td>Die Bank prüft.</td></tr></table><p>${FOLLOWING}</p>`,
    );

    expect(inventoryOf(text).entries[0]?.statement).toBe("Die Bank prüft.");
  });

  it("is not read into the last cell of a PowerPoint table", async () => {
    const table = pptxTable(
      [
        ["ID", "Beschreibung"],
        ["FR-1", "Die Bank prüft."],
      ],
      true,
    );
    const text = await pptx(slidePartXml(table, shapeXml(undefined, paragraphXml(FOLLOWING))));

    expect(text).toContain(`\n\n${FOLLOWING}`);
    expect(inventoryOf(text).entries[0]?.statement).toBe("Die Bank prüft.");
  });
});

describe("two paragraphs in a row", () => {
  it("stay apart in Word", async () => {
    const document = documentXml(textPara("Einwilligung"), textPara(OBLIGATION));
    const text = textOf(await parseDocx({ document }));

    expect(text).toBe(`Einwilligung\n\n${OBLIGATION}`);
    expect(inventoryOf(text).entries.map((entry) => entry.statement)).toEqual([OBLIGATION]);
  });

  it("stay apart in HTML", () => {
    const text = html(`<p>Einwilligung</p><p>${OBLIGATION}</p>`);

    expect(text).toBe(`Einwilligung\n\n${OBLIGATION}`);
    expect(inventoryOf(text).entries.map((entry) => entry.statement)).toEqual([OBLIGATION]);
  });

  it("stay apart in a PowerPoint shape", async () => {
    const shape = shapeXml(undefined, paragraphXml("Einwilligung"), paragraphXml(OBLIGATION));
    const text = await pptx(slidePartXml(shape));

    expect(text).toBe(`Slide 1\n\nEinwilligung\n\n${OBLIGATION}`);
    expect(inventoryOf(text).entries.map((entry) => entry.statement)).toEqual([OBLIGATION]);
  });

  it("keep the items of a list on adjacent lines", () => {
    expect(html("<p>Einleitung</p><ul><li>eins</li><li>zwei</li></ul><p>Schluss</p>")).toBe(
      "Einleitung\n\n- eins\n- zwei\n\nSchluss",
    );
  });
});

describe("a list inside a table cell", () => {
  it("stays a list of criteria in Word", async () => {
    const document = documentXml(
      tableXml(
        rowXml([textCell("ID"), textCell("Akzeptanzkriterien")], "<w:trPr><w:tblHeader/></w:trPr>"),
        rowXml([
          textCell("FR-1"),
          cellXml(`${textPara("Erstes Kriterium.")}${textPara("Zweites Kriterium.")}`),
        ]),
      ),
    );

    expect(criteriaOf(inventoryOf(textOf(await parseDocx({ document }))))).toEqual([
      "Erstes Kriterium.",
      "Zweites Kriterium.",
    ]);
  });

  it("stays a list of criteria in HTML", () => {
    const text = html(
      "<table><tr><th>ID</th><th>Akzeptanzkriterien</th></tr>" +
        "<tr><td>FR-1</td><td><ul><li>Erstes Kriterium.</li><li>Zweites Kriterium.</li></ul></td></tr></table>",
    );

    expect(criteriaOf(inventoryOf(text))).toEqual(["Erstes Kriterium.", "Zweites Kriterium."]);
  });

  it("stays a list of criteria in PowerPoint", async () => {
    const cell = (body: string): string => `<a:tc><a:txBody><a:bodyPr/>${body}</a:txBody></a:tc>`;
    const table = `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tblPr firstRow="1"/><a:tr>${cell(
      paragraphXml("ID"),
    )}${cell(paragraphXml("Akzeptanzkriterien"))}</a:tr><a:tr>${cell(paragraphXml("FR-1"))}${cell(
      `${paragraphXml("Erstes Kriterium.")}${paragraphXml("Zweites Kriterium.")}`,
    )}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;

    expect(criteriaOf(inventoryOf(await pptx(slidePartXml(table))))).toEqual([
      "Erstes Kriterium.",
      "Zweites Kriterium.",
    ]);
  });
});

describe("a blank line inside a workbook cell", () => {
  it("keeps every criterion of the cell", () => {
    const text = csv('ID,Akzeptanzkriterien\nFR-1,"Erstes.\n\nZweites."\nFR-2,Drittes.\n');

    expect(text).not.toContain("\n\n");
    expect(criteriaOf(inventoryOf(text))).toEqual(["Erstes.", "Zweites."]);
  });

  it("keeps every paragraph of a statement cell and the cells that follow it", () => {
    const text = csv(
      'ID,Anforderung,Priorität\nFR-1,"Der Export liefert CSV.\n\nEr liefert UTF-8.",Muss\n',
    );

    expect(inventoryOf(text).entries[0]).toMatchObject({
      statement: "Der Export liefert CSV. Er liefert UTF-8.",
      priority: "Muss",
    });
  });

  it("reads the same requirement with one line break or several", () => {
    const of = (cell: string): string | undefined =>
      inventoryOf(csv(`ID,Akzeptanzkriterien\nFR-1,"${cell}"\n`)).entries[0]?.digest;

    expect(of("Erstes.\n\n\nZweites.")).toBe(of("Erstes.\nZweites."));
  });
});

describe("a requirement catalog in JSON", () => {
  const CATALOG = {
    requirements: [
      {
        id: "FR-1",
        title: "Login",
        priority: "Hoch",
        description: "Der Nutzer kann sich anmelden.",
        acceptanceCriteria: ["Erstes Kriterium.", "Zweites, längeres Kriterium."],
        owner: { team: "Kanal" },
      },
      { id: "FR-2", title: "Logout", description: "Der Nutzer kann sich abmelden." },
    ],
  };

  it("reads an array of strings as criteria", () => {
    const inventory = inventoryOf(json(CATALOG));

    expect(inventory.entries.map((entry) => entry.id)).toEqual(["FR-1", "FR-2"]);
    expect(criteriaOf(inventory)).toEqual(["Erstes Kriterium.", "Zweites, längeres Kriterium."]);
  });

  it("keeps pointers and nested records out of the statement", () => {
    expect(inventoryOf(json(CATALOG)).entries[0]?.statement).toBe("Der Nutzer kann sich anmelden.");
  });

  it("takes no requirement from an array of other things", () => {
    const text = json({ errors: [{ code: "E-1", message: "Limit" }] });

    expect(inventoryOf(text).entries).toEqual([]);
  });
});
