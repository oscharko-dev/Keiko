// Findings of the independent review of the table projection (#4235): real data taken for a
// header, a header taken for data, or a value that lost its label.

import { describe, expect, it } from "vitest";

import { projectTable, type TabularRow } from "./tabular.js";

type Grid = readonly (readonly (string | undefined)[])[];

// `rowNumbers` places the grid on explicit sheet rows, so a blank row is a gap in the numbers.
function rowsOf(grid: Grid, rowNumbers?: readonly number[]): readonly TabularRow[] {
  return grid.flatMap((cells, index) => {
    const present = cells.flatMap((value, columnIndex) =>
      value === undefined ? [] : [{ columnIndex, value }],
    );
    return present.length === 0
      ? []
      : [{ rowNumber: rowNumbers?.[index] ?? index + 1, cells: present }];
  });
}

function project(grid: Grid, rowNumbers?: readonly number[]): readonly string[] {
  return projectTable("T", rowsOf(grid, rowNumbers), (column) => `Column ${String(column)}`)
    .map((line) => line.text)
    .join("")
    .split("\n")
    .filter((line) => line.length > 0);
}

describe("a header whose labels look like identifiers", () => {
  it("labels the values under Q1..Q4", () => {
    expect(
      project([
        ["Region", "Q1", "Q2"],
        ["Nord", "10", "20"],
        ["Süd", "11", "21"],
      ]),
    ).toEqual(["T!2: Region=Nord | Q1=10 | Q2=20", "T!3: Region=Süd | Q1=11 | Q2=21"]);
  });

  it("labels the values under KW 12 and KW 13", () => {
    expect(
      project([
        ["Team", "KW 12", "KW 13"],
        ["A", "5", "6"],
      ]),
    ).toEqual(["T!2: Team=A | KW 12=5 | KW 13=6"]);
  });

  it("still takes a row of identifiers over identifiers for data, not for a header", () => {
    expect(
      project([
        ["FR-1", "Login", "Muss"],
        ["FR-2", "Logout", "Soll"],
      ]),
    ).toEqual([
      "T!1: Column 0=FR-1 | Column 1=Login | Column 2=Muss",
      "T!2: Column 0=FR-2 | Column 1=Logout | Column 2=Soll",
    ]);
  });
});

describe("a number written with an exponent is no label", () => {
  it("does not take a row of 1E-7 for a header", () => {
    expect(
      project([
        ["Konstante", "1E-7"],
        ["Faktor", "2.5E3"],
      ]),
    ).toEqual(["T!1: Column 0=Konstante | Column 1=1E-7", "T!2: Column 0=Faktor | Column 1=2.5E3"]);
  });
});

describe("a key of a key-value pair is no header", () => {
  it("keeps Projekt: and Stand: as plain lines above the real header", () => {
    expect(
      project(
        [
          ["Projekt:", "Alpha"],
          ["Stand:", "2026-03-05"],
          ["ID", "Titel", "Prio"],
          ["FR-1", "Login", "Muss"],
        ],
        [1, 2, 4, 5],
      ),
    ).toEqual([
      "T!1: Projekt: | Alpha",
      "T!2: Stand: | 2026-03-05",
      "T!5: ID=FR-1 | Titel=Login | Prio=Muss",
    ]);
  });
});

describe("a lone value after a blank row", () => {
  it("labels a lone value under a column other than the first", () => {
    expect(
      project(
        [
          ["ID", "Titel", "Prio"],
          ["FR-1", "Login", "Muss"],
          [undefined, "Nur Titel"],
        ],
        [1, 2, 4],
      ),
    ).toEqual(["T!2: ID=FR-1 | Titel=Login | Prio=Muss", "T!4: Titel=Nur Titel"]);
  });

  it("still takes a lone first-column text for a note", () => {
    expect(project([["ID", "Titel"], ["FR-1", "Login"], ["Stand: offen"]], [1, 2, 4])).toEqual([
      "T!2: ID=FR-1 | Titel=Login",
      "T!4: Stand: offen",
    ]);
  });
});
