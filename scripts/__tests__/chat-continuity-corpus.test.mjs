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
  it("rejects obsolete budget and deadline values", () => {
    const scored = evaluateContinuityAnswer(
      JSON.stringify({ ...ANSWER, budget: "7300 EUR", termin: "2027-03-18" }),
    );
    expect(scored.correct).toBe(7);
    expect(scored.fields.budget.correct).toBe(false);
    expect(scored.fields.termin.correct).toBe(false);
  });
  it("does not confuse a negated privacy restriction with preservation", () => {
    const scored = evaluateContinuityAnswer(
      JSON.stringify({ ...ANSWER, einschraenkung: "Die Rohdaten dürfen das Gerät verlassen." }),
    );
    expect(scored.fields.einschraenkung.correct).toBe(false);
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
