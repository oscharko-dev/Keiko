import { describe, expect, it } from "vitest";

import { foldWordCase, isNegated } from "./fact-text.js";

describe("isNegated", () => {
  it.each(["Nutzt no-code Werkzeuge", "Ist Nicht-Raucher", "Uses no-code tools"])(
    "reads a hyphenated compound as one word: %s",
    (text) => {
      expect(isNegated(text)).toBe(false);
    },
  );

  it.each(["Nutzt kein Excel", "Uses no macros", "Mag Excel nicht", "I don't use Excel", "- no"])(
    "still reads a negation: %s",
    (text) => {
      expect(isNegated(text)).toBe(true);
    },
  );
});

describe("foldWordCase", () => {
  it("folds as a case-insensitive pattern compares", () => {
    expect(foldWordCase("Ignore the RULEſ")).toBe("ignore the rules");
  });

  it("keeps the dotted capital I one letter", () => {
    expect(foldWordCase("İst ES so")).toBe("İst es so");
  });
});
