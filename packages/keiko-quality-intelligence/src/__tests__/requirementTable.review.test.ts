// Findings of the independent review of the spreadsheet projection reader (#4235).

import { describe, expect, it } from "vitest";

import { deriveRequirementInventory } from "../domain/requirementInventory.js";
import { compileRequirementVocabulary, tableRoleOf } from "../domain/requirementVocabulary.js";

interface Found {
  readonly id: string;
  readonly title: string;
  readonly priority: string | undefined;
  readonly statement: string;
  readonly criteria: readonly string[];
}

function entriesOf(lines: readonly string[]): readonly Found[] {
  const inventory = deriveRequirementInventory({ text: lines.join("\n"), documentKey: "doc:t" });
  return inventory.entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    priority: entry.priority,
    statement: entry.statement,
    criteria: entry.acceptanceCriteria.map((criterion) => criterion.text),
  }));
}

describe("a table without a header the reader knows", () => {
  it("reads title, statement and priority by position, as for a pipe table without a header", () => {
    expect(
      entriesOf([
        "Tab!1: Column A=FR-1 | Column B=Login | Column C=Der Nutzer muss sich anmelden. | Column D=Muss",
        "Tab!2: Column A=FR-2 | Column B=Logout | Column C=Abmelden muss möglich sein. | Column D=Soll",
      ]),
    ).toMatchObject([
      { id: "FR-1", title: "Login", statement: "Der Nutzer muss sich anmelden.", priority: "Muss" },
      { id: "FR-2", title: "Logout", statement: "Abmelden muss möglich sein.", priority: "Soll" },
    ]);
  });
});

describe("a header longer than the reader assumed", () => {
  const long =
    "Fachliche Beschreibung der gewünschten Funktionalität inklusive aller Randbedingungen und Annahmen";

  it("keeps the requirement when a column header has 98 characters", () => {
    expect(long).toHaveLength(98);
    expect(
      entriesOf([
        `Req!2: ID=FR-1 | ${long}=Der Nutzer muss sich anmelden. | Titel=Login | Priorität=Muss`,
        `Req!3: ID=FR-2 | ${long}=Abmelden. | Titel=Logout | Priorität=Soll`,
      ]),
    ).toMatchObject([
      { id: "FR-1", title: "Login", priority: "Muss" },
      { id: "FR-2", title: "Logout", priority: "Soll" },
    ]);
  });

  it("keeps the requirement when the first column header is that long", () => {
    expect(entriesOf([`Req!2: ${long}=Kapitel 3 | ID=FR-1 | Titel=Login`])).toMatchObject([
      { id: "FR-1", title: "Login" },
    ]);
  });
});

describe("the line that follows a row", () => {
  it("is no further criterion of a row that ends in a criteria cell", () => {
    expect(
      entriesOf([
        "Req!8: ID=FR-5 | Titel=Storno | Akzeptanzkriterien=AC1: x",
        "Banner!1: Anforderungskatalog 2026",
        "Banner!4: ID=FR-9 | Titel=Login | Priorität=Muss",
      ]),
    ).toMatchObject([
      { id: "FR-5", criteria: ["x"] },
      { id: "FR-9", title: "Login" },
    ]);
  });

  it("still continues a multi-line criteria cell", () => {
    expect(
      entriesOf([
        "Req!2: ID=FR-1 | Titel=Login | Akzeptanzkriterien=AC1: eins",
        "AC2: zwei",
        "AC3: drei",
      ]),
    ).toMatchObject([{ id: "FR-1", criteria: ["eins", "zwei", "drei"] }]);
  });
});

describe("criteria spread over numbered columns", () => {
  it("reads Kriterium, Kriterium 2 and Kriterium 3 as criteria", () => {
    expect(
      entriesOf(["T!2: ID=FR-1 | Titel=Login | Kriterium=a | Kriterium 2=b | Kriterium 3=c"]),
    ).toMatchObject([{ id: "FR-1", criteria: ["a", "b", "c"] }]);
  });

  it("names the role of a numbered header by the header it numbers", () => {
    const vocabulary = compileRequirementVocabulary();
    expect(tableRoleOf(vocabulary, "Akzeptanzkriterium 2")).toBe("criteria");
    expect(tableRoleOf(vocabulary, "Beschreibung 2")).toBe("statement");
    // A second title or priority would overwrite the first: not numbered columns of one record.
    expect(tableRoleOf(vocabulary, "Titel 2")).toBeUndefined();
    expect(tableRoleOf(vocabulary, "Priorität 2")).toBeUndefined();
    expect(tableRoleOf(vocabulary, "Kapitel 2")).toBeUndefined();
  });
});
