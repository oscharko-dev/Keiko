import { describe, expect, it } from "vitest";

import {
  compareFacts,
  decideFactRelation,
  mostSimilarFacts,
  statesChangedFact,
  statesSameFact,
  type FactRelationLabel,
} from "./fact-relation.js";

describe("compareFacts", () => {
  it.each([
    ["I prefer tabs over spaces", "I prefer tabs over spaces", "same"],
    ["Ich bevorzuge Tabellen", "Bevorzugt Tabellen", "same"],
    ["Bevorzugt Tabellen", "Bevorzugt Tabellen.", "same"],
    ["Für Zahlen bevorzuge ich Tabellen", "Ich bevorzuge Tabellen für Zahlen", "same"],
    ["Mag Tabellen", "Bevorzugt Tabellen", "same"],
    ["I prefer tabs over spaces", "I prefer spaces over tabs", "reversed"],
    ["Bevorzugt Tabellen statt Listen", "Bevorzugt Listen statt Tabellen", "reversed"],
    ["PostgreSQL 14", "PostgreSQL 16", "number-changed"],
    ["Nutzt Node 24 und Vim", "Nutzt Node 26 und Vim", "number-changed"],
    ["Mag Tabellen", "Mag keine Tabellen", "polarity-changed"],
    ["I like tables", "I don't like tables", "polarity-changed"],
    ["Bevorzugt Tabellen für Zahlen", "Bevorzugt Listen für Zahlen", "slot-changed"],
    ["Arbeitet bei Acme", "Arbeitet bei Globex", "slot-changed"],
    ["Bevorzugt Tabellen für Zahlen", "Wohnt in Bonn", "different"],
    ["Bevorzugt Tabellen und Listen und Grafiken", "Bevorzugt Kaffee und Tee und Wasser", "different"],
    ["", "Bevorzugt Tabellen", "different"],
  ])("%s / %s reads %s", (a, b, expected) => {
    expect(compareFacts(a, b)).toBe(expected);
    expect(compareFacts(b, a)).toBe(expected);
  });

  it("never reads a reversal or a changed value as the same fact", () => {
    for (const [a, b] of [
      ["I prefer tabs over spaces", "I prefer spaces over tabs"],
      ["PostgreSQL 14", "PostgreSQL 16"],
    ] as const) {
      expect(statesSameFact(a, b)).toBe(false);
      expect(statesChangedFact(a, b)).toBe(true);
    }
    expect(statesChangedFact("Bevorzugt Tabellen", "Bevorzugt Tabellen.")).toBe(false);
    expect(statesChangedFact("Wohnt in Bonn", "Bevorzugt Tabellen")).toBe(false);
  });
});

function decide(
  body: string,
  evidence: string,
  label: FactRelationLabel,
  knownBody: string,
  named = true,
): ReturnType<typeof decideFactRelation> {
  const fact = { id: "old", body: knownBody };
  return decideFactRelation({
    body,
    evidence,
    label,
    known: [fact],
    ...(named ? { related: fact } : {}),
  });
}

describe("decideFactRelation", () => {
  it("confirms a repeat, whatever the model calls it", () => {
    for (const label of ["new", "update", "same", "contradiction"] as const) {
      expect(decide("Bevorzugt Tabellen", "Ich bevorzuge Tabellen", label, "Bevorzugt Tabellen")).toEqual({
        kind: "confirm",
        factId: "old",
      });
    }
  });

  it("replaces on a reversal, a number or a negation, whatever the model calls it", () => {
    expect(decide("I prefer spaces over tabs", "I prefer spaces over tabs", "new", "I prefer tabs over spaces", false)).toEqual({
      kind: "supersede",
      factId: "old",
      basis: "reversed",
    });
    expect(decide("PostgreSQL 16", "I use PostgreSQL 16", "new", "PostgreSQL 14", false)).toEqual({
      kind: "supersede",
      factId: "old",
      basis: "number-changed",
    });
    expect(decide("Mag keine Tabellen", "Ich mag keine Tabellen", "same", "Mag Tabellen")).toEqual({
      kind: "supersede",
      factId: "old",
      basis: "polarity-changed",
    });
  });

  it("needs the model's label for a changed word, and the same subject", () => {
    const old = "Bevorzugt Tabellen für Zahlen";
    const next = "Bevorzugt Listen für Zahlen";
    expect(decide(next, "Ich bevorzuge Listen für Zahlen", "update", old)).toEqual({
      kind: "supersede",
      factId: "old",
      basis: "slot-changed",
    });
    expect(decide(next, "Ich bevorzuge Listen für Zahlen", "new", old)).toEqual({ kind: "new" });
    expect(
      decide("Bevorzugt Tabellen für Text", "Ich bevorzuge Tabellen für Text", "update", old),
    ).toEqual({ kind: "new" });
  });

  it("takes a stated change as a change only when the model names the fact", () => {
    const evidence = "Ab jetzt bevorzuge ich Listen";
    const old = "Bevorzugt Tabellen, wenn Zahlen gezeigt werden";
    expect(decide("Bevorzugt Listen", evidence, "update", old)).toEqual({
      kind: "supersede",
      factId: "old",
      basis: "stated-change",
    });
    expect(decide("Bevorzugt Listen", evidence, "new", old)).toEqual({ kind: "new" });
    expect(decide("Bevorzugt Listen", evidence, "update", old, false)).toEqual({ kind: "new" });
  });

  it("does not replace on a label alone", () => {
    expect(decide("Wohnt in Bonn", "Ich wohne in Bonn", "contradiction", "Bevorzugt Tabellen")).toEqual({
      kind: "new",
    });
  });

  it("holds an unconfirmed claim of sameness back only when the facts share a content word", () => {
    expect(
      decide("Mag Tabellen sehr", "Ich mag Tabellen sehr", "same", "Bevorzugt Tabellen in Berichten"),
    ).toEqual({ kind: "same-unconfirmed" });
    expect(decide("Wohnt in Bonn", "Ich wohne in Bonn", "same", "Bevorzugt Tabellen")).toEqual({
      kind: "new",
    });
  });
});

describe("mostSimilarFacts", () => {
  it("shows the facts that read most like the message, within the limit", () => {
    const known = [
      { id: "a", body: "Wohnt in Bonn" },
      { id: "b", body: "Bevorzugt Tabellen" },
      { id: "c", body: "Bevorzugt Tabellen für Zahlen" },
    ];
    expect(
      mostSimilarFacts("Ich bevorzuge Tabellen", known, 2).map((fact) => fact.id),
    ).toEqual(["b", "c"]);
    expect(mostSimilarFacts("", known, 2)).toEqual([]);
  });
});
