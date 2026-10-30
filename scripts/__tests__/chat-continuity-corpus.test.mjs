import { describe, expect, it } from "vitest";
import {
  continuityCorpusManifest,
  evaluateContinuityAnswer,
  continuityPressureNote,
  RECALL_QUESTION,
} from "../testing/coding-workbench-lab/chat-continuity-corpus.mjs";

const ANSWER = {
  projekt: "Kestrel",
  verantwortlich: "Mira Seidel",
  kennung: "Q7-42",
  budget: "8100 EUR",
  termin: "2027-04-09",
  ersteEntscheidung: "lokale Warteschlange",
  verworfeneAlternative: "externe Volltextablage",
  offenerSchritt: "Integrationsprobe",
  einschraenkung: "Die Rohdaten dürfen das Gerät nicht verlassen.",
};

describe("predeclared chat continuity corpus", () => {
  it("accepts the independently declared current values", () => {
    expect(evaluateContinuityAnswer(JSON.stringify(ANSWER))).toMatchObject({
      correct: 9,
      total: 9,
    });
  });
  it.each(["8100 Euro", "8.100 Euro", "€ 8.100", "EUR 8 100,00", "8.100,00 €"])(
    "accepts an unambiguous equivalent euro amount: %s",
    (budget) => {
      expect(
        evaluateContinuityAnswer(JSON.stringify({ ...ANSWER, budget })).fields.budget.correct,
      ).toBe(true);
    },
  );
  it("rejects obsolete budget and deadline values", () => {
    const scored = evaluateContinuityAnswer(
      JSON.stringify({ ...ANSWER, budget: "7300 EUR", termin: "2027-03-18" }),
    );
    expect(scored.correct).toBe(7);
    expect(scored.fields.budget.correct).toBe(false);
    expect(scored.fields.termin.correct).toBe(false);
  });
  it.each(["7300 EUR, later 8100 EUR", "78100", "81000", "8100,00 and 7.300 EUR"])(
    "rejects ambiguous or substring budget: %s",
    (budget) => {
      expect(
        evaluateContinuityAnswer(JSON.stringify({ ...ANSWER, budget })).fields.budget.correct,
      ).toBe(false);
    },
  );
  it.each([
    "18. März 2027, then 9. April 2027",
    "2027-03-18 / 2027-04-09",
    "2027-04-090",
    "19. April 2027",
  ])("rejects ambiguous or substring deadline: %s", (termin) => {
    expect(
      evaluateContinuityAnswer(JSON.stringify({ ...ANSWER, termin })).fields.termin.correct,
    ).toBe(false);
  });
  it("does not confuse a negated privacy restriction with preservation", () => {
    const scored = evaluateContinuityAnswer(
      JSON.stringify({ ...ANSWER, einschraenkung: "Die Rohdaten dürfen das Gerät verlassen." }),
    );
    expect(scored.fields.einschraenkung.correct).toBe(false);
  });
  it.each([
    ["ersteEntscheidung", "lokale Warteschlange verworfen"],
    ["ersteEntscheidung", "keine lokale Warteschlange"],
    ["ersteEntscheidung", "lokale Warteschlange nicht gewählt"],
    ["verworfeneAlternative", "externe Volltextablage gewählt"],
    ["verworfeneAlternative", "externe Volltextablage gewa\u0308hlt"],
    ["verworfeneAlternative", "externe Volltextablage nicht verworfen"],
  ])("rejects reversed decision polarity for %s: %s", (key, value) => {
    expect(
      evaluateContinuityAnswer(JSON.stringify({ ...ANSWER, [key]: value })).fields[key].correct,
    ).toBe(false);
  });
  it.each([
    ["ersteEntscheidung", "lokale Warteschlange gewählt, externe Volltextablage verworfen"],
    ["ersteEntscheidung", "lokale Warteschlange nicht verworfen"],
    ["verworfeneAlternative", "externe Volltextablage verworfen"],
    ["verworfeneAlternative", "externe Volltextablage nicht gewählt"],
  ])("keeps supported decision statements for %s: %s", (key, value) => {
    expect(
      evaluateContinuityAnswer(JSON.stringify({ ...ANSWER, [key]: value })).fields[key].correct,
    ).toBe(true);
  });
  it("records missing and malformed answers rather than removing their denominator", () => {
    expect(evaluateContinuityAnswer("unavailable")).toMatchObject({
      validJson: false,
      correct: 0,
      total: 9,
    });
    expect(evaluateContinuityAnswer("{}").fields.projekt).toEqual({
      correct: false,
      unknown: true,
    });
  });
  it("does not disclose expected answers in the probe or pressure note", () => {
    for (const content of [RECALL_QUESTION, continuityPressureNote(1, 2, 2000)])
      for (const value of ["Kestrel", "Mira Seidel", "Q7-42", "8100", "2027-04-09"])
        expect(content).not.toContain(value);
  });
  it("identifies the frozen corpus independently of execution time", () => {
    expect(continuityCorpusManifest()).toEqual(continuityCorpusManifest());
    expect(continuityCorpusManifest().criticalFields).toHaveLength(9);
  });
});
