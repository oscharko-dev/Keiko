import { describe, expect, it } from "vitest";

import {
  factReplacedByStatement,
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
    [
      "Bevorzugt Tabellen und Listen und Grafiken",
      "Bevorzugt Kaffee und Tee und Wasser",
      "different",
    ],
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
      expect(
        decide("Bevorzugt Tabellen", "Ich bevorzuge Tabellen", label, "Bevorzugt Tabellen"),
      ).toEqual({
        kind: "confirm",
        factId: "old",
      });
    }
  });

  it("replaces on a reversal, a number or a negation, whatever the model calls it", () => {
    expect(
      decide(
        "I prefer spaces over tabs",
        "I prefer spaces over tabs",
        "new",
        "I prefer tabs over spaces",
        false,
      ),
    ).toEqual({
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
    expect(
      decide("Wohnt in Bonn", "Ich wohne in Bonn", "contradiction", "Bevorzugt Tabellen"),
    ).toEqual({
      kind: "new",
    });
  });

  it("holds an unconfirmed claim of sameness back only when the facts share a content word", () => {
    expect(
      decide(
        "Mag Tabellen sehr",
        "Ich mag Tabellen sehr",
        "same",
        "Bevorzugt Tabellen in Berichten",
      ),
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
    expect(mostSimilarFacts("Ich bevorzuge Tabellen", known, 2).map((fact) => fact.id)).toEqual([
      "b",
      "c",
    ]);
    expect(mostSimilarFacts("", known, 2)).toEqual([]);
  });

  it("does not read two unrelated preferences as one slot", () => {
    expect(compareFacts("Bevorzugt Tabellen", "Bevorzugt Tee")).toBe("different");
  });

  it.each([
    ["Arbeitet mit Excel", "Arbeitet mit Word"],
    ["Works with Python", "Works with Go"],
    ["Wohnt in Berlin", "Arbeitet in Berlin"],
    ["Lives in Bonn", "Works in Bonn"],
  ])("does not read %s and %s as one value replacing another", (a, b) => {
    expect(compareFacts(a, b)).toBe("different");
    expect(compareFacts(b, a)).toBe("different");
  });

  it.each([
    ["Arbeitet bei Acme", "Arbeitet für Globex"],
    ["Works at Acme", "Works at Globex"],
    ["Heißt Alex", "Heisst Sam"],
  ])("reads %s and %s as one single-value slot", (a, b) => {
    expect(compareFacts(a, b)).toBe("slot-changed");
  });

  it("reads a new home as a new value of one slot", () => {
    expect(compareFacts("Wohnt in Berlin", "Wohnt in Hamburg")).toBe("slot-changed");
  });

  it("tells languages and versions apart", () => {
    expect(compareFacts("Nutzt C#", "Nutzt C++")).not.toBe("same");
    expect(compareFacts("Nutzt Python 3.3", "Nutzt Python 3")).toBe("number-changed");
  });

  it("never replaces a fixed fact, however certain the change", () => {
    const known = [{ id: "m1", body: "Nutzt Jira", fixed: true }];
    expect(
      decideFactRelation({
        body: "Nutzt kein Jira",
        evidence: "Ich nutze kein Jira",
        label: "update",
        known,
      }),
    ).toEqual({ kind: "new" });
  });

  it.each([
    ["Nutzt Word für Berichte", "Ich nutze Word für Berichte", "Nutzt Excel für Berichte"],
    ["Arbeitet bei Acme mit Word", "Ich arbeite bei Acme mit Word", "Arbeitet bei Acme mit Excel"],
    ["Mag Listen für Zahlen", "Ich mag Listen für Zahlen", "Mag Tabellen für Zahlen"],
  ])("keeps both on a label alone when %s may stand beside the old fact", (body, evidence, old) => {
    expect(decide(body, evidence, "update", old)).toEqual({ kind: "new" });
  });

  it.each([
    ["Arbeitet bei Globex", "Ich arbeite bei Globex", "Arbeitet bei Acme"],
    ["Wohnt in Hamburg", "Ich wohne in Hamburg", "Wohnt in Berlin"],
    [
      "Bevorzugt Listen für Zahlen",
      "Ich bevorzuge Listen für Zahlen",
      "Bevorzugt Tabellen für Zahlen",
    ],
  ])("replaces a one-at-a-time value on a label: %s", (body, evidence, old) => {
    expect(decide(body, evidence, "update", old)).toEqual({
      kind: "supersede",
      factId: "old",
      basis: "slot-changed",
    });
  });

  it.each([
    ["Ich arbeite jetzt bei Foo", "Arbeitet bei Acme"],
    ["Ich arbeite inzwischen bei Foo", "Arbeitet bei Acme"],
    ["Ich wohne jetzt in Köln", "Wohnt in Berlin"],
    ["I now work at Foo", "Works at Acme"],
  ])("lets a stated move with a word between replace the value: %s", (statement, old) => {
    expect(factReplacedByStatement(statement, [{ id: "old", body: old }])).toMatchObject({
      id: "old",
    });
  });

  it.each([
    ["Ich nutze jetzt auch Python", "Nutzt Excel"],
    ["I also like Python now", "Likes Excel"],
    ["Ich arbeite jetzt auch bei Foo", "Arbeitet bei Acme"],
  ])("keeps the old fact when %s only adds to it", (statement, old) => {
    expect(factReplacedByStatement(statement, [{ id: "old", body: old }])).toBeNull();
    expect(decide(statement, statement, "update", old)).toEqual({ kind: "new" });
  });

  it.each([
    ["Wohnt in der Türkei", "Wohnt in der Schweiz"],
    ["Arbeitet bei der Sparkasse", "Arbeitet bei der Volksbank"],
    ["Lives in San Francisco", "Lives in San Diego"],
    ["Wohnt in Bad Homburg", "Wohnt in Bad Soden"],
  ])("reads the whole value of a slot: %s", (body, old) => {
    expect(decide(body, body, "update", old)).toMatchObject({ kind: "supersede" });
  });

  it.each([
    ["Mag heiße Schokolade", "Mag heißen Kaffee"],
    ["Uses a tool called Jira", "Uses a tool called Slack"],
    ["Bevorzugt kurze Antworten in Meetings", "Bevorzugt lange Antworten in Chats"],
  ])("does not read %s as a one-at-a-time value", (body, old) => {
    expect(decide(body, body, "update", old)).toEqual({ kind: "new" });
  });

  it("still replaces a use on a stated change", () => {
    expect(
      decide(
        "Nutzt jetzt Word für Berichte",
        "Ich nutze jetzt Word für Berichte",
        "update",
        "Nutzt Excel für Berichte",
      ),
    ).toMatchObject({ kind: "supersede", factId: "old" });
  });
});
