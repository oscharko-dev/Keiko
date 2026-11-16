// Findings of the independent review of the merged-cell projection (#4235).

import { describe, expect, it } from "vitest";

import {
  applyMergedCells,
  type MergeCell,
  type MergeRange,
  type MergeRow,
} from "./xlsx-merged-cells.js";

function makeCell(columnIndex: number, value: string): MergeCell {
  return { columnIndex, value };
}

function sheetRows(count: number): MergeRow<MergeCell>[] {
  return Array.from({ length: count }, (_, index) => ({
    rowNumber: index + 1,
    cells: [makeCell(0, `a${String(index + 1)}`), makeCell(1, "b")],
    folded: false,
  }));
}

describe("a hostile list of merged ranges", () => {
  it("costs work in proportion to the sheet, not to ranges times rows", () => {
    const rows = sheetRows(3000);
    // The same wide range listed again and again, and ranges that all reach far down the sheet.
    const ranges: MergeRange[] = [];
    for (let index = 0; index < 4000; index += 1) {
      ranges.push({ firstRow: 1, lastRow: 2 + (index % 2999), firstColumn: 0, lastColumn: 200 });
    }
    const startedAt = performance.now();
    applyMergedCells(rows, ranges, makeCell);
    expect(performance.now() - startedAt).toBeLessThan(1500);
  });

  it("reads a range listed twice as one range", () => {
    const rows: MergeRow<MergeCell>[] = [
      { rowNumber: 1, cells: [makeCell(0, "Kapitel"), makeCell(1, "x")], folded: false },
      { rowNumber: 2, cells: [makeCell(1, "y")], folded: false },
    ];
    const range: MergeRange = { firstRow: 1, lastRow: 2, firstColumn: 0, lastColumn: 0 };
    applyMergedCells(rows, [range, { ...range }, { ...range }], makeCell);
    expect(rows[1]?.cells.map((cell) => cell.value)).toEqual(["Kapitel", "y"]);
  });
});
