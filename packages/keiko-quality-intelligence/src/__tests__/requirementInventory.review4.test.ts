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
