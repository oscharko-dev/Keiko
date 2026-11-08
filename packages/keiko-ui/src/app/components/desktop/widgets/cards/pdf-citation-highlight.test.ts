import { describe, expect, it } from "vitest";
import {
  HIGHLIGHT_BOX_MAX,
  highlightBoxes,
  isPdfTextItem,
  locatePassageItems,
  type PdfTextItemLike,
  type PdfViewportLike,
} from "./pdf-citation-highlight";

// A page of 600 x 800 PDF units shown at scale 1 without rotation: PDF y grows upwards.
const VIEWPORT: PdfViewportLike = {
  width: 600,
  height: 800,
  convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y],
};

/** One text line at the given baseline, 10 units high. */
function line(str: string, baseline: number, x = 50, width = 400): PdfTextItemLike {
  return { str, transform: [10, 0, 0, 10, x, baseline], width, height: 10 };
}

const PAGE: readonly PdfTextItemLike[] = [
  line("Kapitel 1 Einleitung", 760),
  line("Die Altlasten der Bestandsauf-", 700),
  line("nahme machen die Datenqualität", 686),
  line("zum wichtigsten Erfolgsfaktor.", 672),
  line("2. Ziele des Vorhabens", 640),
  line("Zum Stichtag liegen alle Konten vor.", 620),
  line("Seite 4", 40),
];

describe("locatePassageItems", () => {
  it("finds a passage across line breaks, hyphenation and spacing", () => {
    const passage =
      "Die Altlasten der Bestandsaufnahme machen die Datenqualität zum wichtigsten Erfolgsfaktor.";
    expect(locatePassageItems(PAGE, passage)).toEqual([1, 2, 3]);
  });

  it("frames the part on this page of a passage that began on the previous page", () => {
    const passage =
      "Vorhergehender Satz der letzten Seite, der hier nicht steht. Die Altlasten der Bestandsaufnahme machen die Datenqualität";
    expect(locatePassageItems(PAGE, passage)).toEqual([1, 2]);
  });

  it("frames the part on this page of a passage that continues on the next page", () => {
    const passage =
      "Zum Stichtag liegen alle Konten vor. Und der Text geht auf der nächsten Seite weiter, die hier fehlt.";
    expect(locatePassageItems(PAGE, passage)).toEqual([5]);
  });

  it("finds nothing for a passage that is not on the page", () => {
    expect(
      locatePassageItems(PAGE, "Ein völlig anderer Absatz über Zahlungsverkehr und Depots."),
    ).toBeUndefined();
  });

  it("finds nothing for a passage too short to locate with confidence", () => {
    expect(locatePassageItems(PAGE, "Seite 4")).toBeUndefined();
  });

  it("refuses a span that joins two distant occurrences", () => {
    const repeated = [
      line("Abstimmung der Salden je Konto erfolgt täglich", 700),
      ...Array.from({ length: 30 }, (_unused, index) =>
        line(`Füllzeile ${String(index)} mit anderem Inhalt`, 680 - index * 14),
      ),
      line("und wird im Bericht dokumentiert", 200),
    ];
    const passage =
      "Abstimmung der Salden je Konto erfolgt täglich und wird im Bericht dokumentiert";
    expect(locatePassageItems(repeated, passage)).toBeUndefined();
  });
});

describe("highlightBoxes", () => {
  it("frames closely following lines as one region, in fractions of the page", () => {
    const boxes = highlightBoxes(PAGE, [1, 2, 3, 4, 5], VIEWPORT);
    expect(boxes).toHaveLength(1);
    const [box] = boxes;
    expect(box?.left).toBeCloseTo((50 - 3) / 600);
    expect(box?.top).toBeCloseTo((800 - 710 - 3) / 800);
    expect(box?.width).toBeCloseTo((400 + 6) / 600);
    expect(box?.height).toBeCloseTo((710 - 620 + 6) / 800);
  });

  it("starts a new region after a jump down the page", () => {
    expect(highlightBoxes(PAGE, [5, 6], VIEWPORT)).toHaveLength(2);
  });

  it("ignores blank and zero-width items", () => {
    const items = [line("   ", 700), { ...line("Wort", 680), width: 0 }];
    expect(highlightBoxes(items, [0, 1], VIEWPORT)).toEqual([]);
  });

  it("caps the number of regions", () => {
    const scattered = Array.from({ length: HIGHLIGHT_BOX_MAX + 5 }, (_unused, index) =>
      line(`Zeile ${String(index)}`, 790 - index * 40, 50, 100),
    );
    const boxes = highlightBoxes(
      scattered,
      scattered.map((_item, index) => index),
      { ...VIEWPORT, height: 4000, convertToViewportPoint: (x, y) => [x, 4000 - y] },
    );
    expect(boxes).toHaveLength(HIGHLIGHT_BOX_MAX);
  });
});

describe("isPdfTextItem", () => {
  it("accepts text items and rejects marked-content entries", () => {
    expect(isPdfTextItem(line("Text", 10))).toBe(true);
    expect(isPdfTextItem({ type: "beginMarkedContent", id: "mc0" })).toBe(false);
    expect(isPdfTextItem(null)).toBe(false);
  });
});
