import { describe, expect, it } from "vitest";

import {
  composeInWindows,
  composePages,
  pageLayoutOf,
  sectionsFromHeadings,
  type PageLayout,
  type PositionedTextItem,
} from "./pdf-layout.js";

const CHAR_WIDTH = 5;
const LEFT = 50;
const RIGHT_MARGIN = 500;

function drawn(
  str: string,
  x: number,
  y: number,
  height = 10,
  fontName = "body",
): PositionedTextItem {
  return {
    str,
    transform: [height, 0, 0, height, x, y],
    width: str.length * CHAR_WIDTH,
    height,
    fontName,
  };
}

/** Text that reaches the right margin, so the word after it had to wrap. */
function fullLine(start: string, x = LEFT): string {
  const length = Math.floor((RIGHT_MARGIN - x) / CHAR_WIDTH);
  return `${start} `.padEnd(length, "x");
}

/** A line reaching the margin that ends in the given text. */
function fullLineEndingIn(end: string, x = LEFT): string {
  const length = Math.floor((RIGHT_MARGIN - x) / CHAR_WIDTH);
  return `${"x".repeat(Math.max(length - end.length - 1, 1))} ${end}`;
}

function textOf(items: readonly PositionedTextItem[]): string {
  return composePages([pageLayoutOf(items)]).texts[0] ?? "";
}

/** A page wide enough that the margin is known; a real body page always shows it. */
function withMargin(items: readonly PositionedTextItem[]): readonly PositionedTextItem[] {
  return [drawn(fullLine("Margin line"), LEFT, 780), ...items];
}

function bodyText(items: readonly PositionedTextItem[]): string {
  return textOf(withMargin(items)).split("\n").slice(1).join("\n").trim();
}

describe("paragraph reflow", () => {
  it("joins a line the margin forced to wrap", () => {
    const first = fullLine("Das Portal muss");
    expect(bodyText([drawn(first, LEFT, 700), drawn("Eingaben validieren.", LEFT, 688)])).toBe(
      `${first} Eingaben validieren.`,
    );
  });

  it("keeps a line that would have fit behind the previous one", () => {
    expect(bodyText([drawn("Titel kurz", LEFT, 700), drawn("Statement.", LEFT, 688)])).toBe(
      "Titel kurz\nStatement.",
    );
  });

  it("does not take the longest of a few short lines for a margin", () => {
    expect(
      textOf([
        drawn("Max Mustermann", LEFT, 700),
        drawn("Musterstrasse 1", LEFT, 688),
        drawn("12345 Musterstadt", LEFT, 676),
      ]),
    ).toBe("Max Mustermann\nMusterstrasse 1\n12345 Musterstadt");
  });

  it("keeps a line when the producer reported no widths", () => {
    const items = ["Eine Zeile die lang ist", "und weiter geht"].map((str, index) => ({
      str,
      transform: [10, 0, 0, 10, LEFT, 700 - index * 12],
      height: 10,
    }));
    expect(textOf(items)).toBe("Eine Zeile die lang ist\nund weiter geht");
  });

  it("separates paragraphs at a gap wider than the line pitch", () => {
    const text = bodyText([
      drawn(fullLine("Erster Absatz"), LEFT, 700),
      drawn("endet hier.", LEFT, 688),
      drawn("Zweiter Absatz.", LEFT, 664),
    ]);
    expect(text.split("\n\n")).toHaveLength(2);
    expect(text.endsWith("endet hier.\n\nZweiter Absatz.")).toBe(true);
  });

  it("does not join a closed sentence to a capitalized line that starts a new thought", () => {
    const first = `${fullLine("Das Portal prüft").slice(0, -1)}.`;
    expect(bodyText([drawn(first, LEFT, 700), drawn("Priorität: Muss.", LEFT, 688)])).toBe(
      `${first}\nPriorität: Muss.`,
    );
  });

  it.each(["(z.", "(z. B.", "z.B.", "d. h.", "bzw.", "gem.", "vgl."])(
    "does not take the abbreviation %s at the margin for the end of a sentence",
    (abbreviation) => {
      const first = fullLineEndingIn(abbreviation);
      expect(bodyText([drawn(first, LEFT, 700), drawn("Wildschaden gemeldet.", LEFT, 688)])).toBe(
        `${first} Wildschaden gemeldet.`,
      );
    },
  );

  it("still ends a sentence at the margin behind an ordinary short word", () => {
    const first = fullLineEndingIn("wird.");
    expect(bodyText([drawn(first, LEFT, 700), drawn("Danach folgt.", LEFT, 688)])).toBe(
      `${first}\nDanach folgt.`,
    );
  });

  it("wraps against the margin of the text, not against a wider table on the page", () => {
    const line = "x ".repeat(42).trimEnd();
    const text = textOf([
      drawn(fullLine("Margin line"), LEFT, 780),
      drawn(line, LEFT, 700),
      drawn("nachgewiesene Werte.", LEFT, 688),
      drawn("Spalte", LEFT, 640),
      drawn("Wert", 400, 640),
      drawn("Eins", LEFT, 620),
      drawn("Ein breiter Inhalt der Tabelle", 400, 620),
    ]);
    expect(text).toContain(`${line} nachgewiesene Werte.`);
  });

  it("allows for a word being wider than the line's average glyph suggests", () => {
    const margin: PositionedTextItem = {
      str: "Margin line of the page body",
      transform: [10, 0, 0, 10, 76.9, 780],
      width: 440,
      height: 10,
    };
    const short: PositionedTextItem = {
      str: "umgewandelt (rueckwirkend zum Monatsbeginn). Der monatliche Grundfreibetrag und",
      transform: [10, 0, 0, 10, 76.9, 308],
      width: 374.6,
      height: 10,
    };
    const next: PositionedTextItem = {
      str: "nachgewiesene Erhoehungen sind jederzeit verfuegbar; nicht verbrauchtes Freibetragsguthaben ist",
      transform: [10, 0, 0, 10, 76.9, 294],
      width: 428.6,
      height: 10,
    };
    expect(textOf([margin, short, next])).toContain("Grundfreibetrag und nachgewiesene");
  });

  it("repairs a hyphen at the margin and keeps one the document itself writes", () => {
    const repaired = fullLineEndingIn("Konsens-");
    expect(bodyText([drawn(repaired, LEFT, 700), drawn("findung folgt.", LEFT, 688)])).toContain(
      "Konsensfindung folgt.",
    );
    const kept = fullLineEndingIn("E-");
    expect(
      bodyText([
        drawn("Eine E-mail wird versendet.", LEFT, 720),
        drawn(kept, LEFT, 700),
        drawn("mail folgt.", LEFT, 688),
      ]),
    ).toContain(" E-mail folgt.");
  });

  it("does not join lines of different sizes", () => {
    const text = bodyText([
      drawn(fullLine("Ein grosser Kopf"), LEFT, 700, 14),
      drawn("Fliesstext.", LEFT, 684),
    ]);
    expect(text.split("\n\n")).toHaveLength(2);
  });

  it.each([
    ["Kunden-", "konto wird", "Kundenkonto wird"],
    ["Ein-", "und Auszahlung", "Ein- und Auszahlung"],
    ["E-", "Mail geht", "E-Mail geht"],
    ["TB-", "001 gilt", "TB-001 gilt"],
  ])("resolves the hyphen of %s + %s", (end, next, joined) => {
    const start = fullLine("Vorlauf ").slice(0, -end.length);
    expect(bodyText([drawn(`${start}${end}`, LEFT, 700), drawn(next, LEFT, 688)])).toBe(
      `${start}${joined}`,
    );
  });

  it("does not insert a space where one word changes font inside a line", () => {
    const bold = drawn("Prio", LEFT, 700, 10, "bold");
    const rest = drawn("rität gilt", LEFT + 4 * CHAR_WIDTH, 700);
    expect(textOf([bold, rest])).toBe("Priorität gilt");
  });

  it("keeps the space between words the producer drew separately", () => {
    const first = drawn("Wort", LEFT, 700);
    const second = drawn("zwei", LEFT + 4 * CHAR_WIDTH + 3, 700);
    expect(textOf([first, second])).toBe("Wort zwei");
  });

  it("reads a word drawn twice for a fake bold once", () => {
    expect(textOf([drawn("Fett", LEFT, 700), drawn("Fett", LEFT + 0.3, 700)])).toBe("Fett");
  });

  it("reads a non-breaking space as a space", () => {
    const text = textOf([drawn("Paragraph\u00A01\u00A0Absatz\u00A02", LEFT, 700)]);

    expect(text).toBe("Paragraph 1 Absatz 2");
  });

  it("strips the soft hyphen inside a word and resolves it at the wrap", () => {
    const start = `${fullLine("Vorlauf ").slice(0, -7)}Kunden­`;
    expect(bodyText([drawn(start, LEFT, 700), drawn("kon­to wird", LEFT, 688)])).toBe(
      `${start.slice(0, -1)}konto wird`,
    );
  });
});

describe("list items", () => {
  it("keeps the wrap of a marked item inside it, even after a closed sentence", () => {
    const marked = `${fullLine("• Bei Abbruch endet.").slice(0, -1)}.`;
    const text = bodyText([
      drawn(marked, LEFT, 700),
      drawn("Danach gilt Abschnitt zwei.", LEFT + 10, 688),
      drawn("• Zweiter Punkt.", LEFT, 676),
    ]);
    expect(text).toBe(`${marked} Danach gilt Abschnitt zwei.\n• Zweiter Punkt.`);
  });

  it("starts a new item at each bullet even when the previous line is full", () => {
    const marked = fullLine("• Erster Punkt");
    expect(bodyText([drawn(marked, LEFT, 700), drawn("• Zweiter Punkt", LEFT, 688)])).toBe(
      `${marked}\n• Zweiter Punkt`,
    );
  });

  it("joins a separator the margin moved to the line start instead of opening an item", () => {
    const first = fullLineEndingIn("Hoch · Quelle: FK-1 §7");
    expect(bodyText([drawn(first, LEFT, 700), drawn("· Jira: ZAHL-10", LEFT, 688)])).toBe(
      `${first} · Jira: ZAHL-10`,
    );
  });

  it("keeps a real item whose previous item uses the same glyph inside its text", () => {
    const first = `• ${fullLineEndingIn("Hoch · Quelle").slice(2)}`;
    expect(bodyText([drawn(first, LEFT, 700), drawn("• Zweiter Punkt", LEFT, 688)])).toBe(
      `${first}\n• Zweiter Punkt`,
    );
  });

  it("reads a date that a wrap put at the line start as text, not as a list item", () => {
    const first = fullLine("Die Frist endet am");
    expect(bodyText([drawn(first, LEFT, 700), drawn("16. April des Jahres.", LEFT, 688)])).toBe(
      `${first} 16. April des Jahres.`,
    );
  });

  it("keeps a wrapped numbered item and starts the next one at its marker", () => {
    const one = fullLine("1. Erster Schritt");
    const text = bodyText([
      drawn(one, LEFT, 700),
      drawn("16. April ist der Stichtag", LEFT + 15, 688),
      drawn("2. Zweiter Schritt", LEFT, 676),
    ]);
    expect(text).toBe(`${one} 16. April ist der Stichtag\n2. Zweiter Schritt`);
  });

  it("reads a marker drawn apart from its text as one list item, not as a table", () => {
    const rows = [1, 2, 3].flatMap((number, index) => [
      drawn(String(number), LEFT, 700 - index * 12),
      drawn(`Schritt ${String(number)} der Liste`, LEFT + 30, 700 - index * 12),
    ]);
    expect(textOf(rows)).toBe(
      "1. Schritt 1 der Liste\n2. Schritt 2 der Liste\n3. Schritt 3 der Liste",
    );
  });

  it("joins a bullet drawn apart and hangs its wrap under the text", () => {
    const body = fullLine("Angenommen der Kunde", LEFT + 30);
    const text = bodyText([
      drawn("•", LEFT, 700),
      drawn(body, LEFT + 30, 700),
      drawn("lehnt das Portal ab.", LEFT + 30, 688),
      drawn("•", LEFT, 676),
      drawn("Zweites Kriterium.", LEFT + 30, 676),
    ]);
    expect(text).toBe(`• ${body} lehnt das Portal ab.\n• Zweites Kriterium.`);
  });
});

function tableRow(y: number, cells: readonly (readonly [number, string])[]): PositionedTextItem[] {
  return cells.map(([x, text]) => drawn(text, x, y));
}

describe("tables", () => {
  it("keeps distant cells on their row instead of moving them to the page end", () => {
    const text = textOf([
      ...tableRow(700, [
        [50, "Nr."],
        [120, "Format"],
        [350, "Zeitvorgabe"],
      ]),
      ...tableRow(686, [
        [50, "S 1"],
        [120, "pacs.008"],
        [350, "10 Sekunden"],
      ]),
      ...tableRow(672, [
        [50, "S 2"],
        [120, "pacs.002"],
        [350, "500 Millisekunden"],
      ]),
      drawn("Danach folgt ein Absatz, der quer über die Spalten der Tabelle hinausläuft.", 50, 640),
    ]);
    expect(text).toBe(
      "Nr. | Format | Zeitvorgabe\n" +
        "S 1 | pacs.008 | 10 Sekunden\n" +
        "S 2 | pacs.002 | 500 Millisekunden\n\n" +
        "Danach folgt ein Absatz, der quer über die Spalten der Tabelle hinausläuft.",
    );
  });

  it("merges a wrapped cell into its logical row when row and line pitch differ", () => {
    const text = textOf([
      ...tableRow(700, [
        [50, "ID"],
        [120, "Titel"],
        [300, "Quelle"],
      ]),
      ...tableRow(680, [
        [50, "A-1"],
        [120, "Eine Bezeichnung"],
        [300, "Kapitel 1"],
      ]),
      ...tableRow(668, [[120, "über zwei Zeilen"]]),
      ...tableRow(648, [
        [50, "A-2"],
        [120, "Kurz"],
        [300, "Kapitel 2"],
      ]),
    ]);
    expect(text).toBe(
      "ID | Titel | Quelle\n" +
        "A-1 | Eine Bezeichnung über zwei Zeilen | Kapitel 1\n" +
        "A-2 | Kurz | Kapitel 2",
    );
  });

  it("merges a continuation without a first cell when all rows have the same pitch", () => {
    const text = textOf([
      ...tableRow(700, [
        [50, "ID"],
        [120, "Titel"],
      ]),
      ...tableRow(688, [
        [50, "A-1"],
        [120, "Zweizeiliger"],
      ]),
      ...tableRow(676, [[120, "Titel"]]),
      ...tableRow(664, [
        [50, "A-2"],
        [120, "Einzeilig"],
      ]),
    ]);
    expect(text).toBe("ID | Titel\nA-1 | Zweizeiliger Titel\nA-2 | Einzeilig");
  });

  it("repairs a word the renderer had to break inside a narrow cell", () => {
    const text = textOf([
      ...tableRow(700, [
        [50, "ID"],
        [100, "Titel"],
        [200, "Prio"],
      ]),
      ...tableRow(680, [
        [50, "A-1"],
        [100, "Konditionsanzei"],
        [200, "Hoch"],
      ]),
      ...tableRow(668, [[100, "ge"]]),
      ...tableRow(648, [
        [50, "A-2"],
        [100, "Kurz"],
        [200, "Hoch"],
      ]),
    ]);
    expect(text).toContain("A-1 | Konditionsanzeige | Hoch");
  });

  function narrowCellTable(title: string, wrapped: string, prose = ""): string {
    return textOf([
      ...(prose.length > 0 ? [drawn(prose, LEFT, 760)] : []),
      ...tableRow(700, [
        [50, "ID"],
        [100, "Titel"],
        [240, "Prio"],
      ]),
      ...tableRow(680, [
        [50, "A-1"],
        [100, title],
        [240, "Hoch"],
      ]),
      ...tableRow(668, [[100, wrapped]]),
      ...tableRow(648, [
        [50, "A-2"],
        [100, "Kurz"],
        [240, "Hoch"],
      ]),
    ]);
  }

  it("keeps the space behind a long whole word the document uses elsewhere", () => {
    const text = narrowCellTable(
      "Legitimationspruefung",
      "beim Onboarding",
      "Die Legitimationspruefung erfolgt ohne Anlegen des Kontos.",
    );
    expect(text).toContain("A-1 | Legitimationspruefung beim Onboarding | Hoch");
  });

  it("keeps the space when only the word on the next line is known", () => {
    const text = narrowCellTable(
      "Legitimationspruefung",
      "beim Onboarding",
      "Das erfolgt beim Anlegen des Kontos.",
    );
    expect(text).toContain("A-1 | Legitimationspruefung beim Onboarding | Hoch");
  });

  it("joins a broken word whose whole form the document uses elsewhere", () => {
    const text = narrowCellTable(
      "Konditionsanzei",
      "ge und Filter",
      "Die Konditionsanzeige zeigt ge und mehr.",
    );
    expect(text).toContain("A-1 | Konditionsanzeige und Filter | Hoch");
  });

  it("joins an identifier the renderer broke inside its digits", () => {
    const text = narrowCellTable("FK-VERS-KFZ-MOD-0", "1", "Version 1 von Modul 1 gilt.");
    expect(text).toContain("A-1 | FK-VERS-KFZ-MOD-01 | Hoch");
  });

  it("keeps the space when two whole words fit a line of the cell together", () => {
    const text = textOf([
      ...tableRow(700, [
        [50, "ID"],
        [100, "Titel"],
        [300, "Prio"],
      ]),
      ...tableRow(680, [
        [50, "A-1"],
        [100, "Bedarfseingabe der Kundinnen"],
        [300, "Hoch"],
      ]),
      ...tableRow(668, [[100, "und Konditionen"]]),
      ...tableRow(648, [
        [50, "A-2"],
        [100, "Kurz"],
        [300, "Hoch"],
      ]),
    ]);
    expect(text).toContain("A-1 | Bedarfseingabe der Kundinnen und Konditionen | Hoch");
  });

  it("separates a cell that sits closer to its neighbour than the segment gap", () => {
    const text = textOf([
      ...tableRow(700, [
        [50, "Ziel"],
        [150, "Wert"],
      ]),
      ...tableRow(688, [
        [50, "Kurz"],
        [150, "9 Tage"],
      ]),
      ...tableRow(676, [
        [50, "Das Ziel ist lang geraten"],
        [177, "19 Tage"],
      ]),
      ...tableRow(664, [
        [50, "Mittlere Laufzeit Meldung"],
        [150, "12 Tage"],
      ]),
    ]);
    expect(text).toContain("Ziel | Wert\nKurz | 9 Tage");
    expect(text).not.toContain("Laufzeit Meldung 12 Tage");
  });

  it("ends the table at a following line that sits only in the first column", () => {
    const text = textOf([
      ...tableRow(700, [
        [50, "Ziel"],
        [200, "Wert"],
      ]),
      ...tableRow(688, [
        [50, "A"],
        [200, "1"],
      ]),
      ...tableRow(676, [
        [50, "B"],
        [200, "2"],
      ]),
      drawn("Anschließender Text", 50, 650),
    ]);
    expect(text).toBe("Ziel | Wert\nA | 1\nB | 2\n\nAnschließender Text");
  });

  it("reads one aligned row as text, not as a table", () => {
    expect(
      textOf([
        ...tableRow(700, [
          [50, "Links"],
          [300, "Rechts"],
        ]),
      ]),
    ).toBe("Links Rechts");
  });
});

function runningText(x: number, y: number, label: string, right: number): PositionedTextItem {
  const count = Math.floor((right - x) / CHAR_WIDTH);
  return drawn(`${label} `.padEnd(count - 1, "x") + ".", x, y);
}

describe("columns", () => {
  const leftEnd = 280;
  const rightStart = 320;
  const rightEnd = 550;
  const columnRows = (y: number, index: number): PositionedTextItem[] => [
    runningText(LEFT, y, `L${String(index)}`, leftEnd),
    runningText(rightStart, y, `R${String(index)}`, rightEnd),
  ];

  it("reads a real two-column page down the left column first", () => {
    const items = [700, 688, 676, 664, 652].flatMap((y, index) => columnRows(y, index));
    const lines = textOf(items).split("\n");
    expect(lines.map((line) => line.slice(0, 2))).toEqual([
      "L0",
      "L1",
      "L2",
      "L3",
      "L4",
      "R0",
      "R1",
      "R2",
      "R3",
      "R4",
    ]);
  });

  it("keeps a full-width heading above the columns and a band below them in place", () => {
    const items = [
      runningText(LEFT, 730, "HEAD", rightEnd),
      ...[700, 688, 676, 664, 652].flatMap((y, index) => columnRows(y, index)),
      runningText(LEFT, 620, "FOOT", rightEnd),
    ];
    const lines = textOf(items)
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.slice(0, 4).trim());
    expect(lines[0]).toBe("HEAD");
    expect(lines[1]?.startsWith("L0")).toBe(true);
    expect(lines.at(-1)).toBe("FOOT");
  });

  it("does not take a sparse table for columns", () => {
    const items = [700, 688, 676, 664, 652].flatMap((y, index) => [
      drawn(`A${String(index)}`, LEFT, y),
      drawn(`B${String(index)}`, 350, y),
    ]);
    expect(textOf(items).split("\n")[0]).toBe("A0 | B0");
  });

  it("does not take a narrow label column with long text for columns", () => {
    const items = [700, 688, 676, 664, 652].flatMap((y, index) => [
      drawn(`Feld ${String(index)}`, LEFT, y),
      runningText(150, y, "Wert", rightEnd),
    ]);
    expect(textOf(items).split("\n")[0]?.startsWith("Feld 0 | Wert")).toBe(true);
  });
});

function pageWith(
  body: readonly PositionedTextItem[],
  furniture: readonly PositionedTextItem[],
): PageLayout {
  return pageLayoutOf([...furniture, ...body]);
}

function bodyLines(page: number): PositionedTextItem[] {
  return [700, 688, 676, 664].map((y) =>
    drawn(`Seite ${String(page)} Zeile ${String(y)}`, LEFT, y),
  );
}

describe("repeated page furniture", () => {
  it("removes a running header and a footer whose page number changes", () => {
    const pages = [1, 2, 3, 4].map((page) =>
      pageWith(bodyLines(page), [
        drawn("Lastenheft Kernbank", LEFT, 780),
        drawn(`Seite ${String(page)} von 4`, LEFT, 40),
      ]),
    );
    const composed = composePages(pages);
    expect(composed.removedRows).toBe(8);
    expect(composed.texts[1]).toBe(
      "Seite 2 Zeile 700\nSeite 2 Zeile 688\nSeite 2 Zeile 676\nSeite 2 Zeile 664",
    );
  });

  it("keeps a table header repeated at the top of each page, which has no gap below it", () => {
    const pages = [1, 2, 3].map((page) =>
      pageLayoutOf([
        ...tableRow(712, [
          [50, "ID"],
          [200, "Titel"],
        ]),
        ...tableRow(700, [
          [50, `A-${String(page)}`],
          [200, "eins"],
        ]),
        ...tableRow(688, [
          [50, `B-${String(page)}`],
          [200, "zwei"],
        ]),
        ...tableRow(676, [
          [50, `C-${String(page)}`],
          [200, "drei"],
        ]),
      ]),
    );
    const composed = composePages(pages);
    expect(composed.removedRows).toBe(0);
    expect(composed.texts[2]?.startsWith("ID | Titel\n")).toBe(true);
  });

  it("keeps a line that repeats on too few pages or too few pages exist", () => {
    const twoPages = [1, 2].map((page) =>
      pageWith(bodyLines(page), [drawn("Lastenheft Kernbank", LEFT, 780)]),
    );
    expect(composePages(twoPages).removedRows).toBe(0);
    const once = [1, 2, 3, 4, 5, 6, 7, 8].map((page) =>
      pageWith(bodyLines(page), page === 1 ? [drawn("Nur auf der ersten Seite", LEFT, 780)] : []),
    );
    expect(composePages(once).texts[0]).toContain("Nur auf der ersten Seite");
  });

  it("does not treat the only row of a page as furniture", () => {
    const pages = [1, 2, 3, 4].map((page) =>
      pageLayoutOf([drawn(`Marker ${String(page)}`, LEFT, 700)]),
    );
    expect(composePages(pages).texts).toEqual(["Marker 1", "Marker 2", "Marker 3", "Marker 4"]);
  });

  it("applies what earlier runs of the document proved to a short final run", () => {
    const first = [1, 2, 3].map((page) =>
      pageWith(bodyLines(page), [drawn("Lastenheft Kernbank", LEFT, 780)]),
    );
    const known = composePages(first).furniture;
    const last = composePages(
      [pageWith(bodyLines(4), [drawn("Lastenheft Kernbank", LEFT, 780)])],
      known,
    );
    expect(last.texts[0]).not.toContain("Lastenheft Kernbank");
  });
});

describe("orientation", () => {
  it("reads a page whose text runs along the rotated axis in reading order", () => {
    const rotated = (str: string, x: number, y: number): PositionedTextItem => ({
      str,
      transform: [0, 10, -10, 0, x, y],
      width: str.length * CHAR_WIDTH,
      height: 10,
    });
    expect(textOf([rotated("Zeile eins", 100, 50), rotated("Zeile zwei", 112, 50)])).toBe(
      "Zeile eins\nZeile zwei",
    );
  });

  it("keeps a single margin note out of the reading flow and removes a repeated watermark", () => {
    const stamp = (str: string): PositionedTextItem => ({
      str,
      transform: [7, 7, -7, 7, 200, 300],
      width: 100,
      height: 10,
    });
    const once = composePages([pageLayoutOf([drawn("Text der Seite", LEFT, 700), stamp("Notiz")])]);
    expect(once.texts[0]).toBe("Text der Seite\nNotiz");
    const marked = [1, 2, 3].map((page) =>
      pageLayoutOf([drawn(`Text der Seite ${String(page)}`, LEFT, 700), stamp("ENTWURF")]),
    );
    const composed = composePages(marked);
    expect(composed.texts).toEqual(["Text der Seite 1", "Text der Seite 2", "Text der Seite 3"]);
    expect(composed.removedRows).toBe(3);
  });
});

describe("headings", () => {
  const body = (y: number, label: string): PositionedTextItem =>
    drawn(`${label} ist ein Satz im Fliesstext des Dokuments.`, LEFT, y);

  it("stands apart from the text around it, however tight the page is set (#4235)", () => {
    expect(
      textOf([
        body(760, "Vorher"),
        drawn("1. Zweck und Geltungsbereich", LEFT, 744, 15, "bold"),
        body(723, "Danach"),
      ]),
    ).toBe(
      [
        "Vorher ist ein Satz im Fliesstext des Dokuments.",
        "1. Zweck und Geltungsbereich",
        "Danach ist ein Satz im Fliesstext des Dokuments.",
      ].join("\n\n"),
    );
  });

  it("reports larger lines as headings with levels by size", () => {
    const composed = composePages([
      pageLayoutOf([
        drawn("Titel des Dokuments", LEFT, 760, 18, "bold"),
        body(730, "Vorwort"),
        body(718, "Weiter"),
        drawn("1. Kapitel", LEFT, 690, 14, "bold"),
        body(670, "Inhalt"),
        drawn("1.1 Abschnitt", LEFT, 640, 12, "bold"),
        body(620, "Mehr"),
      ]),
    ]);
    expect(composed.headings[0]?.map(({ title, level }) => [title, level])).toEqual([
      ["Titel des Dokuments", 1],
      ["1. Kapitel", 2],
      ["1.1 Abschnitt", 3],
    ]);
    const heading = composed.headings[0]?.[1];
    expect(composed.texts[0]?.slice(heading?.offset, (heading?.offset ?? 0) + 10)).toBe(
      "1. Kapitel",
    );
  });

  it("reports a whole line in another face at the start of a block", () => {
    const composed = composePages([
      pageLayoutOf([
        drawn("Abschnitt in Fett", LEFT, 760, 10, "bold"),
        body(740, "Eins"),
        body(728, "Zwei"),
        body(716, "Drei"),
      ]),
    ]);
    expect(composed.headings[0]?.map(({ title }) => title)).toEqual(["Abschnitt in Fett"]);
  });

  it("does not report a lead-in, a sentence, a list item or a bold line inside a block", () => {
    const composed = composePages([
      pageLayoutOf([
        body(760, "Start"),
        drawn("Akzeptanzkriterien:", LEFT, 730, 10, "bold"),
        body(718, "Eins"),
        drawn("Ein fetter Satz.", LEFT, 690, 10, "bold"),
        body(678, "Zwei"),
        body(666, "Drei"),
        drawn("Fett ohne Abstand", LEFT, 654, 10, "bold"),
        drawn("• Fett markiert", LEFT, 630, 10, "bold"),
      ]),
    ]);
    expect(composed.headings[0]).toEqual([]);
  });

  it("does not report table rows", () => {
    const composed = composePages([
      pageLayoutOf([
        ...tableRow(700, [
          [50, "ID"],
          [200, "Titel"],
        ]),
        ...tableRow(688, [
          [50, "A"],
          [200, "B"],
        ]),
      ]),
    ]);
    expect(composed.headings[0]).toEqual([]);
  });

  it("does not repeat a level that was skipped when building sections", () => {
    expect(
      sectionsFromHeadings(
        [
          { start: 10, title: "H1", level: 1 },
          { start: 20, title: "H3 x", level: 3 },
          { start: 30, title: "H3 y", level: 3 },
          { start: 40, title: "H2", level: 2 },
        ],
        50,
      ),
    ).toEqual([
      { sectionPath: [], characterStart: 0, characterEnd: 10 },
      { sectionPath: ["H1"], characterStart: 10, characterEnd: 20 },
      { sectionPath: ["H1", "H3 x"], characterStart: 20, characterEnd: 30 },
      { sectionPath: ["H1", "H3 y"], characterStart: 30, characterEnd: 40 },
      { sectionPath: ["H1", "H2"], characterStart: 40, characterEnd: 50 },
    ]);
  });

  it("returns no sections without headings", () => {
    expect(sectionsFromHeadings([], 50)).toEqual([]);
  });
});

describe("a paragraph across a page break (#4235)", () => {
  const WINDOW = 16;
  const SECOND = "Eingaben validieren und Fehler melden.";
  const page = (...items: readonly PositionedTextItem[]): PageLayout => pageLayoutOf(items);
  const bodyPage = (...lines: readonly string[]): PageLayout =>
    page(...lines.map((line, index) => drawn(line, LEFT, 700 - index * 12)));
  const composed = (...pages: readonly PageLayout[]): ReturnType<typeof composeInWindows> =>
    composeInWindows(pages, WINDOW);

  it("goes on behind the page break when the margin forced the last line", () => {
    const last = fullLine("Das Portal muss");
    const result = composed(bodyPage(last), bodyPage(SECOND));

    expect(result.texts).toEqual([last, SECOND]);
    expect(result.separators).toEqual([undefined, " "]);
  });

  it("goes on when the next page opens with a capital and the sentence is not over", () => {
    const last = fullLine("Die Bank weist den Auftrag mit dem Code");
    const result = composed(bodyPage(last), bodyPage("SEPA-014 oder einem anderen Code ab."));

    expect(result.separators[1]).toBe(" ");
  });

  it("drops a wrap hyphen of a word the page break split", () => {
    const last = fullLineEndingIn("Trennstri-");
    const result = composed(bodyPage(last), bodyPage("chen bleiben nicht im Text."));

    expect(result.texts[0]).toBe(last.slice(0, -1));
    expect(result.separators[1]).toBe("");
  });

  it("keeps the hyphen where the page before was already handed on, and the sentence whole", () => {
    const last = fullLineEndingIn("Trennstri-");
    const result = composeInWindows([bodyPage(last), bodyPage("chen bleiben nicht im Text.")], 1);

    expect(result.texts[0]).toBe(last);
    expect(result.separators[1]).toBe("");
  });

  it.each([
    ["the last line ends a sentence", fullLine("Das Portal prüft").padEnd(89, "x") + ".", SECOND],
    ["the last line stops short of the margin", "Das Portal muss", "daher weiter gehen."],
  ])("ends at the page break when %s", (_name, last, next) => {
    const margin = fullLine("Eine Zeile bis zum Rand.");
    const result = composed(bodyPage(margin, last), bodyPage(next));

    expect(result.separators).toEqual([undefined, undefined]);
  });

  it("ends at the page break when the next page opens with a list", () => {
    const result = composed(bodyPage(fullLine("Das Portal muss")), bodyPage("- Erstens prüfen"));

    expect(result.separators[1]).toBeUndefined();
  });

  describe("below a list item", () => {
    const item = fullLine("- Das Portal zeigt");
    const hangingLine = (y: number): PositionedTextItem =>
      drawn(fullLine("a b", LEFT + 12), LEFT + 12, y);

    it("does not read a new paragraph into a one-line item", () => {
      expect(composed(bodyPage(item), bodyPage("Weiterer Absatz.")).separators[1]).toBeUndefined();
    });

    it("goes on where the line hangs under the item or the sentence visibly goes on", () => {
      const hanging = page(drawn("Meldung an.", LEFT + 12, 700));
      expect(composed(bodyPage(item), hanging).separators[1]).toBe(" ");
      expect(composed(bodyPage(item), bodyPage("die Meldung an.")).separators[1]).toBe(" ");
    });

    it("stops where the item's own lines hang and the line does not", () => {
      const closing = page(drawn(item, LEFT, 700), hangingLine(688));

      expect(composed(closing, bodyPage("Weiterer Absatz.")).separators[1]).toBeUndefined();
    });

    it("goes on in a numbered clause whose lines do not hang at all", () => {
      const clause = page(
        drawn(fullLine("D. Availability of the Service"), LEFT, 700),
        drawn(fullLine("you are responsible"), LEFT, 688),
      );

      expect(composed(clause, bodyPage("for compliance with the law.")).separators[1]).toBe(" ");
    });
  });

  it("ends at the page break when the next page opens with a heading", () => {
    const result = composed(
      bodyPage(fullLine("Das Portal muss")),
      page(
        drawn("Neues Kapitel", LEFT, 720, 15, "bold"),
        drawn("Der Text des neuen Kapitels.", LEFT, 700),
      ),
    );

    expect(result.separators[1]).toBeUndefined();
  });

  it("ends at the page break when the next page opens with a table", () => {
    const table = page(
      drawn("Regel", LEFT, 700),
      drawn("Wert", 300, 700),
      drawn("R1", LEFT, 688),
      drawn("eins", 300, 688),
    );

    expect(composed(bodyPage(fullLine("Das Portal muss")), table).separators[1]).toBeUndefined();
  });

  it("ends at the page break when the page closes with text against the reading direction", () => {
    const note: PositionedTextItem = {
      str: "Randnotiz",
      transform: [0, 10, -10, 0, 20, 400],
      width: 45,
      height: 10,
      fontName: "body",
    };
    const closing = page(drawn(fullLine("Das Portal muss"), LEFT, 700), note);

    expect(composed(closing, bodyPage(SECOND)).separators[1]).toBeUndefined();
  });

  it("does not carry a paragraph over a page without text", () => {
    const last = fullLine("Das Portal muss");

    expect(composed(bodyPage(last), page(), bodyPage(SECOND)).separators).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("degenerate input", () => {
  it("composes an empty page and an empty document", () => {
    expect(composePages([])).toMatchObject({ texts: [], removedRows: 0 });
    expect(composePages([pageLayoutOf([])]).texts).toEqual([""]);
  });

  it("joins items without any position with spaces", () => {
    expect(
      composePages([pageLayoutOf([{ str: " eins " }, { str: "" }, { str: "zwei" }])]).texts,
    ).toEqual(["eins zwei"]);
  });

  it("ignores zero-width characters and empty runs the producer draws", () => {
    expect(
      textOf([
        { str: "", transform: [0, 0, 0, 0, LEFT, 700], width: 0, height: 0 },
        drawn("Null\u200Bbreite", LEFT, 700),
      ]),
    ).toBe("Nullbreite");
  });

  it("survives more items on one baseline than a call can take as arguments", () => {
    const items = Array.from({ length: 200_000 }, (_, index) => drawn("a", LEFT + index * 5, 700));
    expect(composePages([pageLayoutOf(items)]).texts[0]?.length).toBe(200_000);
  });

  it("stays fast on a table with very many rows", () => {
    const items = Array.from({ length: 30_000 }, (_, index) => [
      drawn(`A-${String(index)}`, LEFT, 400_000 - index * 12),
      drawn("Hoch", 300, 400_000 - index * 12),
    ]).flat();
    const started = performance.now();
    const text = composePages([pageLayoutOf(items)]).texts[0] ?? "";
    expect(text).toContain("A-29999 | Hoch");
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("stays fast when a page is full of rows that start a table and never extend it", () => {
    const items = Array.from({ length: 20_000 }, (_, index) => [
      drawn("Links", LEFT + (index % 7) * 40, 900_000 - index * 40),
      drawn("Rechts", 300 + (index % 11) * 13, 900_000 - index * 40),
    ]).flat();
    const started = performance.now();
    composePages([pageLayoutOf(items)]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("stays linear on a page with many items", () => {
    const items = Array.from({ length: 20_000 }, (_, index) =>
      drawn(`w${String(index)}`, LEFT + (index % 60) * 8, 780 - Math.floor(index / 60) * 2),
    );
    const started = performance.now();
    composePages([pageLayoutOf(items)]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("review of real producers (#4235)", () => {
  it("keeps numbers in a two-column numeric table as cells, not as a numbered list", () => {
    const rows = [
      ["1", "2"],
      ["3", "4"],
      ["12", "99"],
      ["5", "6"],
    ].flatMap(([left, right], index) => [
      drawn(left ?? "", LEFT, 700 - index * 14),
      drawn(right ?? "", 200, 700 - index * 14),
    ]);
    expect(textOf(rows)).toBe("1 | 2\n3 | 4\n12 | 99\n5 | 6");
  });

  it("reads the private-use bullet an Office export draws as one list item", () => {
    const bullet = "";
    const rows = [0, 1, 2].flatMap((index) => [
      drawn(bullet, LEFT, 700 - index * 14),
      drawn(`Punkt ${String(index)} der Liste`, LEFT + 18, 700 - index * 14),
    ]);
    expect(textOf(rows)).toBe("• Punkt 0 der Liste\n• Punkt 1 der Liste\n• Punkt 2 der Liste");
  });

  it("reads a second-level bullet drawn as the letter o in its own face as a list item", () => {
    const rows = [0, 1].flatMap((index) => [
      drawn("o", LEFT + 18, 700 - index * 14, 10, "courier"),
      drawn(`Unterpunkt ${String(index)}`, LEFT + 36, 700 - index * 14),
    ]);
    expect(textOf(rows)).toBe("◦ Unterpunkt 0\n◦ Unterpunkt 1");
  });

  it("keeps a subscript and a superscript on the line of the word they belong to", () => {
    const text = textOf([
      drawn("Der Betrag steigt um 5", LEFT, 700),
      drawn("1", LEFT + 110, 704, 6),
      drawn("und H", LEFT + 118, 700),
      drawn("2", LEFT + 143, 699, 6),
      drawn("O im Wasser.", LEFT + 147, 700),
    ]);
    expect(text).toBe("Der Betrag steigt um 51 und H2O im Wasser.");
  });

  it("keeps a heading that every page starts with, which is larger than the body", () => {
    const pages = [1, 2, 3, 4].map((page) =>
      pageLayoutOf([drawn("Zusammenfassung", LEFT, 780, 16, "bold"), ...bodyLines(page)]),
    );
    const composed = composePages(pages);
    expect(composed.removedRows).toBe(0);
    expect(composed.texts[2]?.startsWith("Zusammenfassung\n")).toBe(true);
  });

  it("reads three columns one after the other, not as a table of their lines", () => {
    const starts = [50, 220, 390];
    const rows = [700, 688, 676, 664, 652].flatMap((y, index) =>
      starts.map((start, column) =>
        runningText(start, y, `${"ABC".charAt(column)}${String(index)}`, start + 150),
      ),
    );
    const lines = textOf(rows)
      .split("\n")
      .map((line) => line.slice(0, 2));
    expect(lines).toEqual([
      ...[0, 1, 2, 3, 4].map((index) => `A${String(index)}`),
      ...[0, 1, 2, 3, 4].map((index) => `B${String(index)}`),
      ...[0, 1, 2, 3, 4].map((index) => `C${String(index)}`),
    ]);
  });

  it("reads a column pair below a table and a full-width line down its left column first", () => {
    const items = [
      ...[700, 688, 676, 664].flatMap((y, index) =>
        tableRow(y, [
          [50, `T${String(index)}`],
          [200, "Hoch"],
          [350, "offen"],
        ]),
      ),
      runningText(LEFT, 640, "WIDE", 550),
      ...[610, 598, 586, 574, 562].flatMap((y, index) => [
        runningText(LEFT, y, `L${String(index)}`, 280),
        runningText(320, y, `R${String(index)}`, 550),
      ]),
    ];
    const lines = textOf(items)
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.slice(0, 2));
    expect(lines).toEqual([
      "T0",
      "T1",
      "T2",
      "T3",
      "WI",
      ...[0, 1, 2, 3, 4].map((index) => `L${String(index)}`),
      ...[0, 1, 2, 3, 4].map((index) => `R${String(index)}`),
    ]);
  });

  it("reads the runs of a right-to-left line in logical order, the first one at the right", () => {
    // pdf.js reports the runs in logical order; a right-to-left line starts at its right end.
    const text = textOf([
      drawn("אבגד", 149, 700),
      drawn("Keiko", 118, 700),
      drawn("בבבב", 92, 700),
      drawn("Bank", 66, 700),
      drawn("דהוז", 40, 700),
    ]);
    expect(text).toBe("אבגד Keiko בבבב Bank דהוז");
  });

  it("keeps the lines of a right-to-left page apart, which end at the margin on the right", () => {
    const hebrew = "אבגד ".repeat(18).trimEnd();
    const text = textOf([
      drawn(hebrew, LEFT, 700),
      drawn(hebrew, LEFT, 688),
      drawn("Ende.", LEFT, 676),
    ]);
    expect(text.split("\n")).toHaveLength(3);
  });

  it("keeps the hyphen of a URL or an identifier that a wrap broke after it", () => {
    const url = fullLineEndingIn("siehe https://example.org/a-");
    expect(bodyText([drawn(url, LEFT, 700), drawn("b/c.html weiter.", LEFT, 688)])).toBe(
      `${url}b/c.html weiter.`,
    );
    const identifier = fullLineEndingIn("Feld CdtTrfTxInf_Pmt-");
    expect(bodyText([drawn(identifier, LEFT, 700), drawn("id2 folgt.", LEFT, 688)])).toBe(
      `${identifier}id2 folgt.`,
    );
  });

  it("stays linear when thousands of wrapped lines make one paragraph", () => {
    const items = Array.from({ length: 60_000 }, (_, index) =>
      drawn(fullLine(`Zeile ${String(index)}`), LEFT, 900_000 - index * 12),
    );
    const started = performance.now();
    const text = composePages([pageLayoutOf(items)]).texts[0] ?? "";
    expect(text.length).toBeGreaterThan(60_000 * 80);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("stays fast when every row of a page holds thousands of separate cells", () => {
    const items = Array.from({ length: 40_000 }, (_, index) =>
      drawn("w", Math.floor(index / 40) * 30 + (index % 3), 800 - (index % 40) * 12),
    );
    const started = performance.now();
    composePages([pageLayoutOf(items)]);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
