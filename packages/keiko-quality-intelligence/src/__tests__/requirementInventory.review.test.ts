// Findings of the independent review of the requirement inventory (#4235). Synthetic
// documents only.

import { describe, expect, it } from "vitest";

import { deriveRequirementInventory } from "../domain/requirementInventory.js";
import { assessRequirementInventoryQuality } from "../domain/requirementInventoryQuality.js";

function derive(text: string): ReturnType<typeof deriveRequirementInventory> {
  return deriveRequirementInventory({ text, documentKey: "doc:review" });
}

describe("a line break written as a lone carriage return", () => {
  it("ends the line, so two requirements stay two entries", () => {
    const inventory = derive("FR-1: Das System muss X tun.\rFR-2: Das System muss Y tun.\r");
    expect(inventory.entries.map((entry) => entry.id)).toEqual(["FR-1", "FR-2"]);
  });

  it("keeps every span on the text it names", () => {
    const text = "FR-1: Das System muss X tun.\rFR-2: Das System muss Y tun.\r";
    const inventory = derive(text);
    expect(
      inventory.entries.map((entry) => text.slice(entry.characterStart, entry.characterEnd)),
    ).toEqual(["FR-1: Das System muss X tun.", "FR-2: Das System muss Y tun."]);
  });
});

describe("a typographic hyphen in an identifier", () => {
  it.each([
    ["non-breaking hyphen", "‑"],
    ["hyphen", "‐"],
    ["figure dash", "‒"],
    ["minus sign", "−"],
  ])("reads %s as the hyphen of the identifier", (_name, hyphen) => {
    const inventory = derive(
      `FR${hyphen}1: Das System muss X tun.\nFR${hyphen}2: Das System muss Y tun.\n`,
    );
    expect(inventory.entries.map((entry) => [entry.id, entry.idOrigin])).toEqual([
      ["FR-1", "explicit"],
      ["FR-2", "explicit"],
    ]);
  });

  it("reads the identifier cell of a projected table row", () => {
    const inventory = derive(
      [
        "Table!2: ID=FR‑1 | Text=Das System muss X tun.",
        "Table!3: ID=FR‑2 | Text=Das System muss Y tun.",
      ].join("\n"),
    );
    expect(inventory.entries.map((entry) => entry.id)).toEqual(["FR-1", "FR-2"]);
  });
});

describe("invisible characters in a requirement", () => {
  it("do not reach the title", () => {
    const inventory = derive("FR-1: Das System muss​ X tun.­\nFR-2: Das System muss Y tun.");
    expect(inventory.entries[0]?.title).toBe("Das System muss X tun.");
  });
});

describe("numbered clauses of a specification typed one per line", () => {
  it("keeps each multi-level clause a statement of its own", () => {
    const inventory = derive(
      "3.1.2 Das System muss X tun.\n3.1.3 Das System muss Y tun.\n3.1.4 Das System muss Z tun.",
    );
    expect(inventory.entries.map((entry) => entry.statement)).toEqual([
      "3.1.2 Das System muss X tun.",
      "3.1.3 Das System muss Y tun.",
      "3.1.4 Das System muss Z tun.",
    ]);
  });

  it("does not split a wrapped line that starts with a decimal quantity", () => {
    const inventory = derive(
      "Das System muss mindestens\n2.5 Sekunden warten, bevor es antwortet.",
    );
    expect(inventory.entries).toHaveLength(1);
  });
});

describe("table headers in French, Spanish and Italian", () => {
  it.each([
    ["Identificador", "Requisito", "El sistema debe permitir"],
    ["Identifiant", "Exigence", "Le système doit permettre"],
    ["Identificativo", "Requisito", "Il sistema deve consentire"],
  ])("reads %s and %s as identifier and statement", (id, statement, text) => {
    const inventory = derive(
      [
        `Table!2: ${id}=RF-1 | ${statement}=${text} X.`,
        `Table!3: ${id}=RF-2 | ${statement}=${text} Y.`,
      ].join("\n"),
    );
    expect(inventory.entries.map((entry) => [entry.id, entry.statement])).toEqual([
      ["RF-1", `${text} X.`],
      ["RF-2", `${text} Y.`],
    ]);
  });
});

describe("a requirement written on the line of its identifier", () => {
  it("keeps the sentence as its statement", () => {
    const [entry] = derive("FR-1: Das System muss X speichern.").entries;
    expect(entry).toMatchObject({
      id: "FR-1",
      title: "Das System muss X speichern.",
      statement: "Das System muss X speichern.",
    });
  });

  it("prefers it to a listing of the same identifier", () => {
    const { entries, referenceOnlyCount } = derive(
      [
        "FR-1: Login",
        "FR-2: Logout",
        "",
        "FR-1: Das System muss X speichern.",
        "FR-2: Das System muss Y senden.",
      ].join("\n"),
    );
    expect(entries.map((entry) => entry.statement)).toEqual([
      "Das System muss X speichern.",
      "Das System muss Y senden.",
    ]);
    expect(referenceOnlyCount).toBe(2);
  });

  it("reports two different sentences under one identifier as a conflict", () => {
    const { conflictingIds } = derive(
      "FR-1: Das System muss X speichern.\n\nFR-1: Das System muss Y senden.",
    );
    expect(conflictingIds).toEqual(["FR-1"]);
  });

  it("keeps its criteria", () => {
    const [entry] = derive(
      "FR-1: Das System muss X speichern.\nAkzeptanzkriterien:\n- Eins.",
    ).entries;
    expect(entry?.statement).toBe("Das System muss X speichern.");
    expect(entry?.acceptanceCriteria.map((item) => item.text)).toEqual(["Eins."]);
  });

  it.each(["FR-1: Das System muss X speichern.", "FR-1:\nDas System muss X speichern."])(
    "is one obligation when its title comes from its statement: %j",
    (text) => {
      const findings = assessRequirementInventoryQuality(derive(text).entries).get("FR-1");
      expect(findings).not.toContain("compound-requirement");
    },
  );

  it("does not take a plain title for a statement", () => {
    const { entries } = derive("FR-1: Login\nFR-2: Logout");
    expect(entries.map(({ title, statement }) => [title, statement])).toEqual([
      ["Login", ""],
      ["Logout", ""],
    ]);
  });
});

describe("a JSON row with a nested object", () => {
  it("reads the object's fields by their own names", () => {
    const [entry] = derive(
      "/reqs!1: id=FR-1 | detail.text=Das System muss exportieren. | detail.owner.name=Team A | priority=Hoch",
    ).entries;
    expect(entry).toMatchObject({
      id: "FR-1",
      statement: "Das System muss exportieren.",
      priority: "Hoch",
    });
  });

  it("does not read a dotted spreadsheet column by its last part", () => {
    const [entry] = derive(
      "Sheet!2: Abt.ID=17 | ID=FR-1 | Titel=Export | Beschreibung=Das System muss exportieren.",
    ).entries;
    expect(entry).toMatchObject({ id: "FR-1", title: "Export" });
  });
});
