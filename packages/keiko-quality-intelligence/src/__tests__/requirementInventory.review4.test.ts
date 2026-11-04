// Findings of the fourth independent review of the requirement inventory (#4235). Synthetic
// documents only.

import { describe, expect, it } from "vitest";

import { deriveRequirementInventory } from "../domain/requirementInventory.js";

function derive(text: string): ReturnType<typeof deriveRequirementInventory> {
  return deriveRequirementInventory({ text, documentKey: "doc:review4" });
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
