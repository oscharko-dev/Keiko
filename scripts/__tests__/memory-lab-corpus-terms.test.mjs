import { describe, expect, it } from "vitest";
import {
  anyTermVisible,
  clozeQuestion,
  compileTermGroups,
} from "../testing/memory-lab/corpus/oracle.mjs";
import { literalStem, matchesTermGroups, normalizeText } from "../testing/memory-lab/score.mjs";

// The corpus helpers search for a term literally before they ask the scorer; a term with the prefix
// mark occurs as its stem, so the helpers must agree with the scorer on inflected and compound words.
describe("corpus term helpers and the prefix mark", () => {
  const groups = [["Tabelle*"]];

  it("keeps the clean-text prefilter in step with the scorer on a starred term", () => {
    // The failure this pins: the prefilter searched for the literal "tabelle*", found it nowhere and
    // let filler that stated "Tabellenform" pass as clean while the scorer would have matched it.
    const clean = compileTermGroups(groups);
    for (const text of [
      "Ich bevorzuge Tabellenform.",
      "Eine Tabelle reicht.",
      "Mehrere Tabellen.",
    ]) {
      const normalized = normalizeText(text);
      expect(clean(normalized), text).toBe(matchesTermGroups(text, groups));
      expect(clean(normalized), text).toBe(true);
    }
    expect(clean(normalizeText("Ich mag Listen."))).toBe(false);
    expect(clean(normalizeText("die Stabellen"))).toBe(matchesTermGroups("die Stabellen", groups));
  });

  it("sees a starred term in a question and blanks the inflected word of a seed", () => {
    expect(anyTermVisible("Zeig es als Tabellen.", groups)).toBe(true);
    expect(anyTermVisible("Zeig es als Liste.", groups)).toBe(false);
    const question = clozeQuestion(
      "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst.",
      groups,
      "de",
    );
    expect(question).toBeDefined();
    expect(question).not.toMatch(/tabelle/iu);
    expect(literalStem("Tabelle*")).toBe("Tabelle");
    expect(literalStem("Tabellen")).toBe("Tabellen");
  });
});
