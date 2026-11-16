// Structure-level regression pins for the docx parser (#4235): what the parser reads from the
// markup in run order, how headings, lists, tables, boxes and notes are placed, and what it
// excludes and says so. Each group fails on the previous regex-based reader.

import { describe, expect, it } from "vitest";

import {
  abstractNumXml,
  buildDocx,
  cellXml,
  documentXml,
  levelXml,
  linesOf,
  notesXml,
  numberingXml,
  numXml,
  paraXml,
  parseDocx,
  pathsOf,
  plainTable,
  rowXml,
  runXml,
  styleXml,
  stylesXml,
  tableXml,
  textCell,
  textOf,
  textPara,
} from "./docx-test-fixtures.js";

const BOLD = "<w:b/>";

function heading(text: string, level: number): string {
  return textPara(text, { style: `Heading${String(level)}` });
}

describe("docx run content in document order", () => {
  it("keeps a tab between runs instead of gluing the neighbours", async () => {
    const paragraph = paraXml(`${runXml("1. Ausgangslage")}<w:r><w:tab/></w:r>${runXml("3")}`);
    const result = await parseDocx({ document: documentXml(paragraph) });
    expect(linesOf(result)).toEqual(["1. Ausgangslage\t3"]);
  });

  it("keeps each soft line break so a Shift+Enter list stays one item per line", async () => {
    const paragraph = paraXml(
      `${runXml("Sperren")}<w:r><w:br/></w:r>${runXml("Neutrale Meldung")}<w:r><w:cr/></w:r>${runXml("Anzeigen")}`,
    );
    const result = await parseDocx({ document: documentXml(paragraph) });
    expect(linesOf(result)).toEqual(["Sperren", "Neutrale Meldung", "Anzeigen"]);
  });

  it("reads a page break and a positional tab as separators and trims a trailing break", async () => {
    const paragraph = paraXml(
      `${runXml("A")}<w:r><w:br w:type="page"/></w:r>${runXml("B")}<w:r><w:ptab w:alignment="right"/></w:r>${runXml("C")}<w:r><w:br/></w:r>`,
    );
    const result = await parseDocx({ document: documentXml(paragraph) });
    expect(linesOf(result)).toEqual(["A", "B\tC"]);
  });

  it("emits a plain hyphen for a non-breaking hyphen so identifiers still match", async () => {
    const title = paraXml(
      `${runXml("REQ")}<w:r><w:noBreakHyphen/></w:r>${runXml("001 Anmeldung")}`,
      { style: "Heading1" },
    );
    const result = await parseDocx({ document: documentXml(title, textPara("Text.")) });
    expect(linesOf(result)[0]).toBe("REQ-001 Anmeldung");
    expect(pathsOf(result)).toEqual(["REQ-001 Anmeldung"]);
  });

  it("drops a soft hyphen, maps symbols and turns no-break spaces into spaces", async () => {
    const paragraph = paraXml(
      [
        runXml("Zah"),
        "<w:r><w:softHyphen/></w:r>",
        runXml("lung 10 EUR "),
        '<w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>',
        '<w:r><w:sym w:font="Symbol" w:char="F0B7"/></w:r>',
        '<w:r><w:sym w:font="Symbol" w:char="F0FF"/></w:r>',
        '<w:r><w:sym w:font="Arial" w:char="00E4"/></w:r>',
      ].join(""),
    );
    const result = await parseDocx({ document: documentXml(paragraph) });
    expect(linesOf(result)).toEqual(["Zahlung 10 EUR ✓•ä"]);
  });

  it("does not run an empty self-closing text element into the next run", async () => {
    const paragraph = paraXml(`${runXml("Vor")}<w:r><w:t/></w:r>${runXml(" nach")}`);
    const result = await parseDocx({ document: documentXml(paragraph) });
    expect(linesOf(result)).toEqual(["Vor nach"]);
    expect(textOf(result)).not.toContain("<");
  });

  it("reads equation text and ignores deleted text and field instructions", async () => {
    const paragraph = paraXml(
      [
        runXml("Wert "),
        "<m:oMath><m:r><m:t>x+y</m:t></m:r></m:oMath>",
        "<w:r><w:delText>alt</w:delText></w:r><w:r><w:instrText> PAGE </w:instrText></w:r>",
      ].join(""),
    );
    const result = await parseDocx({ document: documentXml(paragraph) });
    expect(linesOf(result)).toEqual(["Wert x+y"]);
  });
});

describe("docx section paths follow heading levels", () => {
  it("nests under the nearest shallower heading after a skipped level", async () => {
    const document = documentXml(
      heading("H1", 1),
      textPara("t"),
      heading("H3 x", 3),
      textPara("t"),
      heading("H3 y", 3),
      textPara("t"),
      heading("H2 z", 2),
    );
    const result = await parseDocx({ document });
    expect(pathsOf(result)).toEqual(["H1", "H1 > H3 x", "H1 > H3 y", "H1 > H2 z"]);
  });

  it("keeps section offsets exact over the joined text", async () => {
    const document = documentXml(
      textPara("Vorspann"),
      heading("Kapitel", 1),
      textPara("Inhalt eins"),
      heading("Unterkapitel", 3),
      textPara("Inhalt zwei"),
    );
    const result = await parseDocx({ document });
    const text = textOf(result);
    const slices = result.sections.map((section) =>
      text.slice(section.characterStart, section.characterEnd),
    );
    expect(slices).toEqual([
      "Vorspann\n\n",
      "Kapitel\n\nInhalt eins\n\n",
      "Unterkapitel\n\nInhalt zwei",
    ]);
  });

  it("resolves a localized style id through its English style name", async () => {
    const styles = stylesXml(
      styleXml("berschrift1", { name: "heading 1" }),
      styleXml("berschrift2", { name: "heading 2", basedOn: "berschrift1" }),
    );
    const document = documentXml(
      textPara("Kapitel", { style: "berschrift1" }),
      textPara("Abschnitt", { style: "berschrift2" }),
      textPara("Text"),
    );
    const result = await parseDocx({ document, styles });
    expect(pathsOf(result)).toEqual(["Kapitel", "Kapitel > Abschnitt"]);
  });

  it("follows a custom style based on a heading and the outline level of a style", async () => {
    const styles = stylesXml(
      styleXml("Heading1", { name: "heading 1" }),
      styleXml("MeinKapitel", { name: "Mein Kapitel", basedOn: "Heading1" }),
      styleXml("Gliederung", { name: "Gliederung", outline: 1 }),
    );
    const document = documentXml(
      textPara("Eins", { style: "Heading1" }),
      textPara("Eigenes", { style: "MeinKapitel" }),
      textPara("Zwei", { style: "Gliederung" }),
    );
    const result = await parseDocx({ document, styles });
    expect(pathsOf(result)).toEqual(["Eins", "Eigenes", "Eigenes > Zwei"]);
  });

  it("honours an outline level on the paragraph itself, and level 9 as body text", async () => {
    const styles = stylesXml(
      styleXml("Heading1", { name: "heading 1" }),
      styleXml("TOCHeading", { name: "TOC Heading", basedOn: "Heading1", outline: 9 }),
    );
    const document = documentXml(
      textPara("Inhalt", { style: "TOCHeading" }),
      textPara("Direkt", { outline: 0 }),
      textPara("Unter", { outline: 1 }),
      textPara("Fließtext", { style: "Heading1", outline: 9 }),
    );
    const result = await parseDocx({ document, styles });
    expect(pathsOf(result)).toEqual(["", "Direkt", "Direkt > Unter"]);
    expect(linesOf(result)[0]).toBe("Inhalt");
  });

  it("makes the document title the root of the sections that follow", async () => {
    const styles = stylesXml(
      styleXml("Titel", { name: "Title" }),
      styleXml("Heading1", { name: "heading 1" }),
    );
    const document = documentXml(
      textPara("Handbuch", { style: "Titel" }),
      heading("Einleitung", 1),
      textPara("Text"),
    );
    const result = await parseDocx({ document, styles });
    expect(pathsOf(result)).toEqual(["Handbuch", "Handbuch > Einleitung"]);
  });

  it("falls back to the English style id when there is no styles part", async () => {
    const document = documentXml(
      textPara("Titel", { style: "Title" }),
      heading("Kapitel", 1),
      textPara("Text", { style: "Berschrift9" }),
    );
    const result = await parseDocx({ document });
    expect(pathsOf(result)).toEqual(["Titel", "Titel > Kapitel"]);
  });

  it("ends on a cyclic basedOn chain instead of looping", async () => {
    const styles = stylesXml(styleXml("A", { basedOn: "B" }), styleXml("B", { basedOn: "A" }));
    const document = documentXml(textPara("Text", { style: "A" }));
    const result = await parseDocx({ document, styles });
    expect(pathsOf(result)).toEqual([""]);
  });

  it("keeps the text of a cell that is not inside a row", async () => {
    const result = await parseDocx({ document: documentXml(cellXml(textPara("Verirrt"))) });
    expect(linesOf(result)).toEqual(["Verirrt"]);
  });

  it("does not turn a heading inside a table cell into a section", async () => {
    const cell = cellXml(textPara("In Zelle", { style: "Heading1" }));
    const document = documentXml(tableXml(rowXml([cell, textCell("b")])));
    const result = await parseDocx({ document });
    expect(pathsOf(result)).toEqual([""]);
  });
});

describe("docx tables follow the grid", () => {
  it("takes a header row from a label row over data of another shape", async () => {
    const document = documentXml(
      plainTable([
        ["ID", "Titel"],
        ["REQ-001", "Login"],
        ["REQ-002", "Logout"],
      ]),
    );
    const result = await parseDocx({ document });
    expect(linesOf(result)).toEqual([
      "Table row 1: ID=REQ-001 | Titel=Login",
      "Table row 2: ID=REQ-002 | Titel=Logout",
    ]);
  });

  it("keeps positional columns when the first row looks like the others", async () => {
    const document = documentXml(
      plainTable([
        ["Alice", "Open"],
        ["Bob", "Closed"],
      ]),
    );
    const result = await parseDocx({ document });
    expect(linesOf(result)).toEqual([
      "Table row 1: Column 1=Alice | Column 2=Open",
      "Table row 2: Column 1=Bob | Column 2=Closed",
    ]);
  });

  it("treats a bold first row over lighter rows as the header", async () => {
    const bold = (text: string): string => cellXml(paraXml(runXml(text, BOLD)));
    const header = rowXml([bold("Name"), bold("Status")]);
    const body = rowXml([textCell("Firewall"), textCell("Enabled")]);
    const result = await parseDocx({ document: documentXml(tableXml(header, body)) });
    expect(linesOf(result)).toEqual(["Table row 1: Name=Firewall | Status=Enabled"]);
  });

  it("does not take a first row for a header when it holds data-like or repeated cells", async () => {
    const data = documentXml(
      plainTable([
        ["REQ-001", "Login"],
        ["REQ-002", "Logout"],
      ]),
    );
    const repeated = documentXml(
      plainTable([
        ["Wert", "Wert"],
        ["1", "2"],
      ]),
    );
    expect(linesOf(await parseDocx({ document: data }))[0]).toBe(
      "Table row 1: Column 1=REQ-001 | Column 2=Login",
    );
    expect(linesOf(await parseDocx({ document: repeated }))[0]).toBe(
      "Table row 1: Column 1=Wert | Column 2=Wert",
    );
  });

  it("lets the header marker decide even for a table the evidence would not accept", async () => {
    const document = documentXml(
      plainTable(
        [
          ["Name", "Status"],
          ["Firewall", "Enabled"],
        ],
        true,
      ),
    );
    expect(linesOf(await parseDocx({ document }))).toEqual([
      "Table row 1: Name=Firewall | Status=Enabled",
    ]);
  });

  it("counts columns on the grid so a spanning cell does not shift the cells after it", async () => {
    const header = rowXml([textCell("ID"), textCell("Titel"), textCell("Prio")], "<w:tblHeader/>");
    const wide = rowXml([textCell("Beides", '<w:gridSpan w:val="2"/>'), textCell("Muss")]);
    const result = await parseDocx({ document: documentXml(tableXml(header, wide)) });
    expect(linesOf(result)).toEqual(["Table row 1: ID=Beides | Prio=Muss"]);
  });

  it("repeats the merged value in a vertically merged continuation cell", async () => {
    const header = rowXml([textCell("Gruppe"), textCell("Wert")], "<w:tblHeader/>");
    const first = rowXml([textCell("A", '<w:vMerge w:val="restart"/>'), textCell("1")]);
    const second = rowXml([textCell("", "<w:vMerge/>"), textCell("2")]);
    const third = rowXml([textCell("B"), textCell("3")]);
    const result = await parseDocx({
      document: documentXml(tableXml(header, first, second, third)),
    });
    expect(linesOf(result)).toEqual([
      "Table row 1: Gruppe=A | Wert=1",
      "Table row 2: Gruppe=A | Wert=2",
      "Table row 3: Gruppe=B | Wert=3",
    ]);
  });

  it("skips blank and tracked-deleted rows without consuming a row number", async () => {
    const rows = [
      rowXml([textCell("a"), textCell("b")]),
      rowXml([textCell(""), textCell("")]),
      rowXml([textCell("gone"), textCell("x")], "<w:del/>"),
      rowXml([textCell("c"), textCell("d")]),
    ];
    const result = await parseDocx({ document: documentXml(tableXml(...rows)) });
    expect(linesOf(result)).toEqual([
      "Table row 1: Column 1=a | Column 2=b",
      "Table row 2: Column 1=c | Column 2=d",
    ]);
  });

  it("keeps a soft break inside a cell on one projected line", async () => {
    const cell = cellXml(paraXml(`${runXml("eins")}<w:r><w:br/></w:r>${runXml("zwei")}`));
    const result = await parseDocx({
      document: documentXml(tableXml(rowXml([cell, textCell("x")]))),
    });
    expect(linesOf(result)).toEqual(["Table row 1: Column 1=eins zwei | Column 2=x"]);
  });
});

describe("docx list markers", () => {
  const numbering = numberingXml(
    abstractNumXml("0", [
      levelXml(0, { format: "decimal", text: "%1." }),
      levelXml(1, { format: "decimal", text: "%1.%2" }),
      levelXml(2, { format: "lowerLetter", text: "%3)" }),
    ]),
    abstractNumXml("1", [levelXml(0, { format: "bullet", text: "" })]),
    abstractNumXml("2", [
      levelXml(0, { format: "upperRoman", text: "%1." }),
      levelXml(1, { format: "decimalZero", text: "%2" }),
    ]),
    numXml("1", "0"),
    numXml("2", "1"),
    numXml("3", "0"),
    numXml("4", "0", '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride>'),
    numXml("5", "2"),
  );

  it("counts numbered items per level and shows the number a reader sees", async () => {
    const document = documentXml(
      textPara("A", { numId: "1", ilvl: 0 }),
      textPara("B", { numId: "1", ilvl: 0 }),
      textPara("B eins", { numId: "1", ilvl: 1 }),
      textPara("B zwei", { numId: "1", ilvl: 1 }),
      textPara("tief", { numId: "1", ilvl: 2 }),
      textPara("C", { numId: "1", ilvl: 0 }),
      textPara("C eins", { numId: "1", ilvl: 1 }),
    );
    const result = await parseDocx({ document, numbering });
    expect(linesOf(result)).toEqual([
      "1. A",
      "2. B",
      "  2.1 B eins",
      "  2.2 B zwei",
      "    a) tief",
      "3. C",
      "  3.1 C eins",
    ]);
  });

  it("shows a bullet for a bullet list and indents nested bullets by level", async () => {
    const document = documentXml(
      textPara("Punkt", { numId: "2", ilvl: 0 }),
      textPara("Unterpunkt", { numId: "2", ilvl: 1 }),
    );
    const result = await parseDocx({ document, numbering });
    expect(linesOf(result)).toEqual(["- Punkt", "  - Unterpunkt"]);
  });

  it("takes the list from the paragraph style and the level from the numbering part", async () => {
    const styles = stylesXml(
      styleXml("ListNumber", { name: "List Number", numId: "1" }),
      styleXml("ListBullet", { name: "List Bullet", numId: "2" }),
      styleXml("ListBullet2", { name: "List Bullet 2", basedOn: "ListBullet" }),
    );
    const document = documentXml(
      textPara("Erstens", { style: "ListNumber" }),
      textPara("Zweitens", { style: "ListNumber" }),
      textPara("Punkt", { style: "ListBullet2" }),
    );
    const result = await parseDocx({ document, styles, numbering });
    expect(linesOf(result)).toEqual(["1. Erstens", "2. Zweitens", "- Punkt"]);
  });

  it("does not mark a paragraph whose numId is 0 as a list item", async () => {
    const styles = stylesXml(styleXml("ListNumber", { name: "List Number", numId: "1" }));
    const document = documentXml(
      textPara("Keine Liste", { style: "ListNumber", numId: "0" }),
      textPara("Liste", { numId: "1", ilvl: 0 }),
    );
    const result = await parseDocx({ document, styles, numbering });
    expect(linesOf(result)).toEqual(["Keine Liste", "1. Liste"]);
  });

  it("applies a start override once and lets instances of one list continue each other", async () => {
    const document = documentXml(
      textPara("a", { numId: "1", ilvl: 0 }),
      textPara("b", { numId: "3", ilvl: 0 }),
      textPara("neu", { numId: "4", ilvl: 0 }),
      textPara("weiter", { numId: "4", ilvl: 0 }),
    );
    const result = await parseDocx({ document, numbering });
    expect(linesOf(result)).toEqual(["1. a", "2. b", "5. neu", "6. weiter"]);
  });

  it("counts letters past z the way Word does", async () => {
    const items = Array.from({ length: 28 }, (_, index) =>
      textPara(`Punkt ${String(index + 1)}`, { numId: "6", ilvl: 0 }),
    );
    const letters = numberingXml(
      abstractNumXml("3", [levelXml(0, { format: "lowerLetter", text: "%1)" })]),
      numXml("6", "3"),
    );
    const result = await parseDocx({ document: documentXml(...items), numbering: letters });
    expect(linesOf(result).slice(25)).toEqual(["z) Punkt 26", "aa) Punkt 27", "ab) Punkt 28"]);
  });

  it("formats roman numerals and zero padded numbers", async () => {
    const document = documentXml(
      textPara("eins", { numId: "5", ilvl: 0 }),
      textPara("zwei", { numId: "5", ilvl: 0 }),
      textPara("zwei eins", { numId: "5", ilvl: 1 }),
    );
    const result = await parseDocx({ document, numbering });
    expect(linesOf(result)).toEqual(["I. eins", "II. zwei", "  01 zwei eins"]);
  });

  it("counts an empty list paragraph and numbers a heading's list without changing the heading", async () => {
    const styles = stylesXml(styleXml("Heading1", { name: "heading 1", numId: "1" }));
    const document = documentXml(
      textPara("Kapitel", { style: "Heading1" }),
      paraXml("", { numId: "3", ilvl: 0 }),
      textPara("danach", { numId: "3", ilvl: 0 }),
    );
    const result = await parseDocx({ document, styles, numbering });
    expect(linesOf(result)).toEqual(["Kapitel", "3. danach"]);
    expect(pathsOf(result)).toEqual(["Kapitel"]);
  });

  it("shows a bullet, never an invented number, for a list that cannot be resolved", async () => {
    const document = documentXml(textPara("Offen", { numId: "42", ilvl: 0 }));
    expect(linesOf(await parseDocx({ document }))).toEqual(["- Offen"]);
    expect(linesOf(await parseDocx({ document, numbering }))).toEqual(["- Offen"]);
  });

  it("keeps the marker on the first line of an item with soft breaks only", async () => {
    const item = paraXml(`${runXml("eins")}<w:r><w:br/></w:r>${runXml("zwei")}`, {
      numId: "1",
      ilvl: 0,
    });
    const result = await parseDocx({ document: documentXml(item), numbering });
    expect(linesOf(result)).toEqual(["1. eins", "zwei"]);
  });

  it("ignores list formatting that a tracked change has already replaced", async () => {
    const history =
      '<w:pPrChange><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:pPrChange>';
    const document = documentXml(paraXml(runXml("Normal"), { extra: history }));
    const result = await parseDocx({ document, numbering });
    expect(linesOf(result)).toEqual(["Normal"]);
  });
});

describe("docx text boxes", () => {
  const box = (text: string): string => `<w:txbxContent>${textPara(text)}</w:txbxContent>`;

  it("emits box text once, as its own block after the anchor paragraph", async () => {
    const alternate = [
      "<w:r><mc:AlternateContent>",
      `<mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx>${box("Hinweis im Feld")}</wps:txbx></wps:wsp></w:drawing></mc:Choice>`,
      `<mc:Fallback><w:pict><v:shape><v:textbox>${box("Hinweis im Feld")}</v:textbox></v:shape></w:pict></mc:Fallback>`,
      "</mc:AlternateContent></w:r>",
    ].join("");
    const anchor = paraXml(`${runXml("Anker ")}${alternate}${runXml("Rest")}`);
    const result = await parseDocx({ document: documentXml(anchor, textPara("Danach")) });
    expect(linesOf(result)).toEqual(["Anker Rest", "Hinweis im Feld", "Danach"]);
  });

  it("emits a legacy text box that has no alternate content once", async () => {
    const legacy = `<w:r><w:pict><v:shape><v:textbox>${box("Altes Feld")}</v:textbox></v:shape></w:pict></w:r>`;
    const result = await parseDocx({
      document: documentXml(paraXml(`${runXml("Text")}${legacy}`)),
    });
    expect(linesOf(result)).toEqual(["Text", "Altes Feld"]);
  });

  it("does not open a section for a heading-styled paragraph inside a box", async () => {
    const drawing = `<w:r><w:drawing><wps:wsp><wps:txbx><w:txbxContent>${heading("Randnotiz", 1)}</w:txbxContent></wps:txbx></wps:wsp></w:drawing></w:r>`;
    const result = await parseDocx({
      document: documentXml(heading("Kapitel", 1), paraXml(`${runXml("Text")}${drawing}`)),
    });
    expect(pathsOf(result)).toEqual(["Kapitel"]);
    expect(linesOf(result)).toEqual(["Kapitel", "Text", "Randnotiz"]);
  });

  it("keeps the anchor paragraph's own text out of the box block and the other way round", async () => {
    const drawing = `<w:r><w:drawing><wps:wsp><wps:txbx>${box("Box")}</wps:txbx></wps:wsp></w:drawing></w:r>`;
    const result = await parseDocx({
      document: documentXml(paraXml(`${drawing}${runXml("nach der Box")}`)),
    });
    expect(linesOf(result)).toEqual(["nach der Box", "Box"]);
  });
});

describe("docx excluded content", () => {
  it("excludes hidden text and reports a body-free count", async () => {
    const hidden = `<w:r><w:rPr><w:vanish/></w:rPr><w:t>geheim</w:t></w:r>`;
    const visible = `<w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>sichtbar</w:t></w:r>`;
    const markHidden = "<w:rPr><w:vanish/></w:rPr>";
    const document = documentXml(
      paraXml(`${runXml("Ein ")}${hidden}${visible}`, { extra: markHidden }),
      paraXml(hidden),
    );
    const result = await parseDocx({ document });
    expect(linesOf(result)).toEqual(["Ein sichtbar"]);
    expect(result.diagnostics).toEqual([
      {
        severity: "info",
        code: "HIDDEN_CONTENT_EXCLUDED",
        message: "excluded 2 hidden text run(s) that a reader cannot see",
        documentId: result.documentId,
      },
    ]);
  });

  it("excludes the prompt of a content control that shows its placeholder", async () => {
    const control = (placeholder: boolean, text: string): string =>
      `<w:sdt><w:sdtPr>${placeholder ? "<w:showingPlcHdr/>" : ""}</w:sdtPr><w:sdtContent>${textPara(text)}</w:sdtContent></w:sdt>`;
    const document = documentXml(
      control(true, "Klicken Sie hier"),
      control(false, "Ausgefüllt"),
      textPara("Ende"),
    );
    const result = await parseDocx({ document });
    expect(linesOf(result)).toEqual(["Ausgefüllt", "Ende"]);
    expect(result.diagnostics.map((entry) => entry.message)).toEqual([
      "excluded 1 content-control placeholder(s)",
    ]);
  });

  it("drops moved-away and deleted text and keeps inserted and moved-to text", async () => {
    const tracked = [
      runXml("Das System "),
      `<w:del w:id="1"><w:r><w:delText>nicht </w:delText></w:r></w:del>`,
      `<w:moveFrom w:id="2"><w:r><w:t>alt verschoben </w:t></w:r></w:moveFrom>`,
      `<w:moveTo w:id="3"><w:r><w:t>neu verschoben </w:t></w:r></w:moveTo>`,
      `<w:ins w:id="4"><w:r><w:t>muss</w:t></w:r></w:ins>`,
    ].join("");
    const result = await parseDocx({ document: documentXml(paraXml(tracked)) });
    expect(linesOf(result)).toEqual(["Das System neu verschoben muss"]);
  });

  it("does not index review comments and counts them", async () => {
    const comments = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="x">${textPara("Kommentartext")}</w:comment><w:comment w:id="1">${textPara("Noch einer")}</w:comment></w:comments>`;
    const result = await parseDocx({ document: documentXml(textPara("Text")), comments });
    expect(textOf(result)).toBe("Text");
    expect(result.diagnostics.map((entry) => [entry.code, entry.message])).toEqual([
      ["COMMENTS_NOT_INDEXED", "2 review comment(s) are not indexed"],
    ]);
  });
});

describe("docx notes sit where they are cited", () => {
  const footnotes = notesXml("footnote", [
    { id: "-1", text: "", type: "separator" },
    { id: "0", text: "", type: "continuationSeparator" },
    { id: "2", text: "Quelle eins" },
    { id: "3", text: "Quelle zwei" },
    { id: "9", text: "Verwaist" },
  ]);
  const endnotes = notesXml("endnote", [{ id: "1", text: "Schlussnote" }]);
  const reference = (tag: string, id: string): string => `<w:r><w:${tag} w:id="${id}"/></w:r>`;

  it("places a footnote in the section that cites it and an unreferenced one at the end", async () => {
    const document = documentXml(
      heading("Eins", 1),
      paraXml(`${runXml("Text")}${reference("footnoteReference", "2")}`),
      heading("Zwei", 1),
      paraXml(`${runXml("Mehr")}${reference("footnoteReference", "3")}`),
    );
    const result = await parseDocx({ document, footnotes });
    expect(linesOf(result)).toEqual([
      "Eins",
      "Text",
      "Footnote 2: Quelle eins",
      "Zwei",
      "Mehr",
      "Footnote 3: Quelle zwei",
      "Footnote 9: Verwaist",
    ]);
    const text = textOf(result);
    const first = result.sections[0];
    expect(text.slice(first?.characterStart, first?.characterEnd)).toContain("Quelle eins");
    expect(text.slice(first?.characterStart, first?.characterEnd)).not.toContain("Quelle zwei");
  });

  it("reads endnotes like footnotes", async () => {
    const document = documentXml(
      paraXml(`${runXml("Satz")}${reference("endnoteReference", "1")}`),
      textPara("Danach"),
    );
    const result = await parseDocx({ document, endnotes });
    expect(linesOf(result)).toEqual(["Satz", "Endnote 1: Schlussnote", "Danach"]);
  });

  it("places a note cited in a table cell after the table", async () => {
    const cited = cellXml(paraXml(`${runXml("Zelle")}${reference("footnoteReference", "2")}`));
    const document = documentXml(tableXml(rowXml([cited, textCell("x")])), textPara("Danach"));
    const result = await parseDocx({ document, footnotes });
    expect(linesOf(result).slice(0, 3)).toEqual([
      "Table row 1: Column 1=Zelle | Column 2=x",
      "Footnote 2: Quelle eins",
      "Danach",
    ]);
  });

  it("places a note once even when its reference is repeated", async () => {
    const twice = paraXml(
      `${runXml("A")}${reference("footnoteReference", "2")}${reference("footnoteReference", "2")}`,
    );
    const result = await parseDocx({ document: documentXml(twice), footnotes });
    expect(linesOf(result).filter((line) => line.startsWith("Footnote 2"))).toHaveLength(1);
  });
});

describe("docx bounds and failure honesty", () => {
  it("does not cut paragraphs at the unit limit, only the sections, and warns about them", async () => {
    const blocks = Array.from({ length: 8 }, (_, index) => [
      heading(`Kapitel ${String(index + 1)}`, 1),
      textPara(`Inhalt ${String(index + 1)}`),
    ]).flat();
    const result = await parseDocx(
      { document: documentXml(...blocks) },
      { maxUnitsPerDocument: 3 },
    );
    expect(linesOf(result)).toHaveLength(16);
    expect(result.sections).toHaveLength(3);
    const limit = result.diagnostics.find((entry) => entry.code === "UNIT_LIMIT_REACHED");
    expect(limit?.severity).toBe("warning");
  });

  it("discloses a cut at the object budget as an error with the text that was read", async () => {
    const blocks = Array.from({ length: 20 }, (_, index) => textPara(`Absatz ${String(index)}`));
    const result = await parseDocx(
      { document: documentXml(...blocks) },
      { maxObjectsPerDocument: 5 },
    );
    expect(result.diagnostics.map((entry) => [entry.code, entry.severity])).toContainEqual([
      "OBJECT_LIMIT_REACHED",
      "error",
    ]);
    expect(linesOf(result).length).toBeLessThan(20);
  });

  it("names a part that inflates beyond the size limit instead of calling it malformed", async () => {
    const bomb = buildDocx({ document: documentXml(textPara("A".repeat(65_536))) });
    const result = await parseDocx(bomb, { maxBytes: 4096 });
    expect(result.diagnostics.map((entry) => [entry.code, entry.message])).toEqual([
      ["OVERSIZED_FILE", "docx part exceeds the inflated size limit of the parser"],
    ]);
  });

  it("still calls an implausible compression ratio malformed", async () => {
    const bomb = buildDocx({ document: documentXml(textPara("A".repeat(400_000))) });
    const result = await parseDocx(bomb);
    expect(result.diagnostics[0]?.code).toBe("MALFORMED_INPUT");
  });

  it("fails closed on markup nested beyond the nesting limit", async () => {
    const nested = (depth: number): string =>
      depth === 0 ? textPara("tief") : tableXml(rowXml([cellXml(nested(depth - 1))]));
    const result = await parseDocx({ document: documentXml(nested(6)) }, { maxNestingDepth: 12 });
    expect(result.diagnostics[0]?.code).toBe("MALFORMED_INPUT");
    expect(textOf(result)).toBe("");
  });

  it("fails closed on a document type declaration", async () => {
    const document = `<!DOCTYPE w:document [<!ENTITY x "y">]><w:document><w:body></w:body></w:document>`;
    const result = await parseDocx({ document });
    expect(result.diagnostics[0]?.code).toBe("MALFORMED_INPUT");
  });

  it("keeps the text readable when an auxiliary part is unreadable and says so", async () => {
    const document = documentXml(heading("Kapitel", 1), textPara("Inhalt"));
    const result = await parseDocx({ document, styles: "<w:styles><w:style>", numbering: "<<" });
    expect(pathsOf(result)).toEqual(["Kapitel"]);
    expect(result.diagnostics.map((entry) => [entry.code, entry.severity, entry.message])).toEqual([
      ["PART_SKIPPED", "warning", "docx word/styles.xml could not be read and was skipped"],
      ["PART_SKIPPED", "warning", "docx word/numbering.xml could not be read and was skipped"],
    ]);
  });

  it("reports a document that is only hidden text as having no text, with the count", async () => {
    const hidden = `<w:r><w:rPr><w:vanish/></w:rPr><w:t>geheim</w:t></w:r>`;
    const result = await parseDocx({ document: documentXml(paraXml(hidden)) });
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      "UNSUPPORTED_FORMAT",
      "HIDDEN_CONTENT_EXCLUDED",
    ]);
  });

  it("stays linear on a large document", async () => {
    const blocks = Array.from({ length: 20_000 }, (_, index) =>
      textPara(`Absatz ${String(index)}`),
    );
    const started = performance.now();
    const result = await parseDocx({ document: documentXml(...blocks) });
    expect(linesOf(result)).toHaveLength(20_000);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
