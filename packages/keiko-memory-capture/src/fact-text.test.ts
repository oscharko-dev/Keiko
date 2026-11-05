import { describe, expect, it } from "vitest";

import { isNegated } from "./fact-text.js";

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
