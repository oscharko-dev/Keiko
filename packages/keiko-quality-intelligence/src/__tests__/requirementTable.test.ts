// Requirement tables (#4235): header vocabulary, the identifier column, and table extractions
// that carry a leading column or come from a CSV file.

import { describe, expect, it } from "vitest";

import { deriveRequirementInventory } from "../domain/requirementInventory.js";
import { parseTableHeader, parseTableRow, tableCells } from "../domain/requirementTable.js";
import {
  compileRequirementVocabulary,
  tableRoleOf,
  type TableColumnRole,
} from "../domain/requirementVocabulary.js";

const VOCABULARY = compileRequirementVocabulary();

function inventoryOf(
  lines: readonly string[],
): readonly { id: string; title: string; priority: string | undefined; criteria: number }[] {
  const inventory = deriveRequirementInventory({ text: lines.join("\n"), documentKey: "doc:t" });
  return inventory.entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    priority: entry.priority,
    criteria: entry.acceptanceCriteria.length,
  }));
}

describe("table header vocabulary", () => {
  const cases: readonly (readonly [string, TableColumnRole | undefined])[] = [
    ["Akzeptanzkriterium", "criteria"],
    ["Abnahmekriterium", "criteria"],
    ["Akzeptanzkriterien (Gegeben/Wenn/Dann)", "criteria"],
    ["Akzeptanz-Kriterien", "criteria"],
    ["Acceptance criterion", "criteria"],
    ["Prio.", "priority"],
    ["Priorität *", "priority"],
    ["PRIORITÄT**", "priority"],
    ["Kurztitel", "title"],
    ["Zusammenfassung", "title"],
    ["Anforderungstext", "statement"],
    ["Nr.", "id"],
    ["Req-ID", "id"],
    ["Anforderungs-ID", "id"],
    ["ID *", "id"],
    ["Kapitel", undefined],
    ["Status", undefined],
    ["Bemerkung", undefined],
    ["", undefined],
    ["***", undefined],
  ];

  it.each(cases)("reads %j as %s", (header, role) => {
    expect(tableRoleOf(VOCABULARY, header)).toBe(role);
  });

  it("keeps a caller-extended vocabulary term working with decoration", () => {
    const extended = compileRequirementVocabulary({
      tableColumns: { title: ["Vorhaben"] } as never,
    });
    expect(tableRoleOf(extended, "Vorhaben (kurz)")).toBe("title");
  });
});

describe("the identifier column of a table", () => {
  it("finds the id column behind a counter column in a pipe table", () => {
    const header = parseTableHeader(tableCells("| Lfd. Nr. | ID | Titel |") ?? [], VOCABULARY);
    const row = parseTableRow(tableCells("| 1 | FR-1 | Login |") ?? [], header, VOCABULARY);
    expect(row).toMatchObject({ id: "FR-1", title: "Login" });
  });

  it("finds the id column behind a chapter column", () => {
    const header = parseTableHeader(tableCells("| Kapitel | ID | Titel |") ?? [], VOCABULARY);
    const row = parseTableRow(tableCells("| 3.2 | FR-7 | Export |") ?? [], header, VOCABULARY);
    expect(row).toMatchObject({ id: "FR-7", title: "Export" });
  });

  it("still takes the first cell when the table has no header", () => {
    const row = parseTableRow(tableCells("| FR-2 | Logout | Soll |") ?? [], undefined, VOCABULARY);
    expect(row).toMatchObject({ id: "FR-2", title: "Logout", priority: "Soll" });
  });

  it("defines nothing when no id column holds an identifier", () => {
    const header = parseTableHeader(tableCells("| ID | Titel |") ?? [], VOCABULARY);
    expect(parseTableRow(tableCells("| 12 | Login |") ?? [], header, VOCABULARY)).toBeUndefined();
  });
});

describe("workbook and CSV extractions", () => {
  it("reads a row whose id column follows a counter column", () => {
    expect(
      inventoryOf([
        "Anf!2: Lfd. Nr.=1 | ID=FR-1 | Titel=Login | Priorität=Muss",
        "Anf!3: Lfd. Nr.=2 | ID=FR-2 | Titel=Logout | Priorität=Soll",
      ]),
    ).toEqual([
      { id: "FR-1", title: "Login", priority: "Muss", criteria: 0 },
      { id: "FR-2", title: "Logout", priority: "Soll", criteria: 0 },
    ]);
  });

  it("reads a row with a leading chapter column and decorated headers", () => {
    expect(
      inventoryOf([
        "Anf!2: Kapitel=3.2 | Req-ID=FR-9 | Kurztitel=Export | Prio.=Muss | Akzeptanzkriterium=Datei ist UTF-8.",
      ]),
    ).toEqual([{ id: "FR-9", title: "Export", priority: "Muss", criteria: 1 }]);
  });

  it("inventories a clean CSV requirement list", () => {
    expect(
      inventoryOf([
        "csv!2: ID=FR-1 | Titel=Login | Beschreibung=Der Nutzer muss sich anmelden. | Priorität=Muss",
        "csv!3: ID=FR-2 | Titel=Logout | Beschreibung=Der Nutzer muss sich abmelden. | Priorität=Soll",
        "csv!4: ID=FR-3 | Titel=Reset | Beschreibung=Der Nutzer muss das Passwort ändern. | Priorität=Kann",
      ]).map((entry) => entry.id),
    ).toEqual(["FR-1", "FR-2", "FR-3"]);
  });

  it("does not read a plain line with a prefix and no labelled cell as a row", () => {
    expect(inventoryOf(["csv!1: Anforderungskatalog", "csv!2: ID | Titel"])).toEqual([]);
  });
});
