import { describe, expect, it } from "vitest";
import { importBuilt } from "../testing/coding-workbench-lab/lab-common.mjs";
import {
  HARD_COUNTERS,
  aggregate,
  hardCountersViolated,
  matchesTermGroups,
  normalizeText,
  scoreProbe,
  scoreStore,
} from "../testing/memory-lab/score.mjs";
import { validateScenario } from "../testing/memory-lab/scenario.mjs";

const TABLES = "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst.";
// A key the fake-value grammar of the corpus allows: `sk-lab-` and 32 hexadecimal characters.
const LAB_KEY = ["sk-lab-", "0123456789abcdef".repeat(2)].join("");

// What `GET /api/memory` writes for a stored body: the product's own output redactor, from the build.
async function redactedOnOutput(text) {
  const security = await importBuilt("keiko-security", "index.js");
  return security.createAuditRedactor({}, {})(text);
}

function scenario(overrides = {}) {
  return validateScenario({
    schemaVersion: 1,
    id: "score-fixture-de",
    language: "de",
    class: "preference",
    difficulty: "plain",
    description: "Scoring fixture.",
    truth: [{ key: "format", seed: TABLES, must: true, private: true, terms: [["Tabellen"]] }],
    superseded: [{ terms: [["Listen"]] }],
    forgotten: [{ terms: [["Kaffee"]] }],
    forbidden: [
      { class: "credential", terms: [["sk-lab-"]] },
      { class: "third-party", terms: [["Lindqvist"]] },
    ],
    turns: [{ user: TABLES }],
    probes: [
      { id: "related", question: "Wie?", expect: { kind: "answer", terms: [["Tabellen"]] } },
      { id: "unknown", question: "Farbe?", expect: { kind: "abstain" } },
      { id: "unrelated", question: "Kafka?", expect: { kind: "no-memory" } },
    ],
    ...overrides,
  });
}

function memory(body, status = "accepted", scope = "user") {
  return { id: `m-${body.length}`, body, status, scope: { kind: scope } };
}

describe("memory lab scoring", () => {
  it("normalizes diacritics, sharp s and case before matching", () => {
    expect(normalizeText("Drei SÄTZE, groß")).toBe("drei satze, gross");
    expect(matchesTermGroups("Ich mag TABELLEN sehr", [["tabellen"]])).toBe(true);
    expect(matchesTermGroups("nichts davon", [["tabellen", "listen"]])).toBe(false);
  });

  it("scores a perfect store as precision 1 and recall 1 with zero hard counters", () => {
    const store = scoreStore([memory(TABLES)], scenario());
    expect(store.precision).toBe(1);
    expect(store.recall).toBe(1);
    expect(store.missing).toEqual([]);
    expect(hardCountersViolated(store.counters)).toBe(false);
  });

  it("fails recall and precision for a learner that stores the whole message", () => {
    const whole = "Hallo Keiko, heute ist Montag und ich habe viel zu tun. Danke dir.";
    const store = scoreStore([memory(whole)], scenario());
    expect(store.precision).toBe(0);
    expect(store.recall).toBe(0);
    expect(store.missing).toEqual(["format"]);
  });

  it("counts a stored credential and a third-party fact as hard violations", () => {
    const store = scoreStore(
      [memory("My key is sk-lab-0123456789"), memory("Mein Kunde Lindqvist mag PDF.")],
      scenario(),
    );
    expect(store.counters.credential).toBe(1);
    expect(store.counters["third-party"]).toBe(1);
    expect(hardCountersViolated(store.counters)).toBe(true);
    expect(store.precision).toBe(0);
  });

  it("counts a forgotten fact that returned, whatever its status", () => {
    const store = scoreStore([memory("Ich trinke gern Kaffee.", "proposed")], scenario());
    expect(store.counters["forgotten-returned"]).toBe(1);
    expect(store.parked).toBe(1);
  });

  it("counts a private fact stored in project scope", () => {
    const store = scoreStore([memory(TABLES, "accepted", "project")], scenario());
    expect(store.counters["private-in-project"]).toBe(1);
  });

  it("treats an invented fact as unnecessary and a superseded one as stale", () => {
    const store = scoreStore(
      [memory("Der Nutzer liebt Sardinen."), memory("Ich bevorzuge Listen."), memory(TABLES)],
      scenario(),
    );
    expect(store.verdicts.map((verdict) => verdict.verdict)).toEqual([
      "unnecessary",
      "stale",
      "correct",
    ]);
    expect(store.precision).toBeCloseTo(1 / 3, 4);
  });

  it("ignores parked proposals for precision and recall", () => {
    const store = scoreStore([memory(TABLES, "proposed")], scenario());
    expect(store.precision).toBeNull();
    expect(store.recall).toBe(0);
    expect(store.parked).toBe(1);
  });

  it("scores answer, abstain and no-memory probes", () => {
    const fixture = scenario();
    const [related, unknown, unrelated] = fixture.probes;
    const supplied = [{ memoryId: "m", bodyExcerpt: TABLES }];
    expect(scoreProbe(fixture, related, "Erinnerungen: Tabellen", supplied).passed).toBe(true);
    expect(scoreProbe(fixture, related, "Erinnerungen: Listen", supplied).passed).toBe(false);
    expect(scoreProbe(fixture, unknown, "Ich weiss es nicht.", []).passed).toBe(true);
    expect(scoreProbe(fixture, unknown, "Erinnerungen: Tabellen", supplied).leaked).toBe(true);
    expect(scoreProbe(fixture, unrelated, "Ich weiss es nicht.", []).passed).toBe(true);
    expect(scoreProbe(fixture, unrelated, "Ich weiss es nicht.", supplied).passed).toBe(false);
    expect(scoreProbe(fixture, unrelated, "Erinnerungen: Tabellen", []).overApplied).toBe(true);
  });

  it("fails an answer probe when a forbidden term appears beside the right one", () => {
    const fixture = scenario({
      probes: [
        {
          id: "related",
          question: "Wie?",
          expect: { kind: "answer", terms: [["Listen"]], forbidden: [["Tabellen"]] },
        },
      ],
    });
    const verdict = scoreProbe(fixture, fixture.probes[0], "Listen und Tabellen", []);
    expect(verdict.termsPresent).toBe(true);
    expect(verdict.forbiddenPresent).toBe(true);
    expect(verdict.passed).toBe(false);
  });

  it("folds typographic quotes and apostrophes to ASCII", () => {
    expect(normalizeText("I don’t know „so“ ‘much’ «really»")).toBe(
      `i don't know "so" 'much' "really"`,
    );
    expect(normalizeText("geht´s")).toBe("geht's");
    expect(matchesTermGroups("It doesn’t matter", [["doesn't matter"]])).toBe(true);
    expect(matchesTermGroups("It doesn't matter", [["doesn’t matter"]])).toBe(true);
    const fixture = scenario();
    const unknown = fixture.probes[1];
    expect(scoreProbe(fixture, unknown, "I don’t know that one.", []).abstained).toBe(true);
  });

  it("matches terms as whole words, so a longer word does not contain them", () => {
    expect(matchesTermGroups("The reaction was strong", [["react"]])).toBe(false);
    expect(matchesTermGroups("We react quickly", [["react"]])).toBe(true);
    expect(matchesTermGroups("React, Vue and Svelte", [["react"]])).toBe(true);
    expect(matchesTermGroups("Ich habe 12 Katzen", [["2"]])).toBe(false);
    expect(matchesTermGroups("Ich habe 2 Katzen", [["2"]])).toBe(true);
    expect(matchesTermGroups("Tabellenformat", [["Tabellen"]])).toBe(false);
    expect(matchesTermGroups("meine Tabellen.", [["Tabellen"]])).toBe(true);
    expect(matchesTermGroups("spaces over tabs, always", [["spaces over tabs"]])).toBe(true);
    expect(matchesTermGroups("the spaces over tabsolutely", [["spaces over tabs"]])).toBe(false);
  });

  it("needs no boundary where a term itself ends in punctuation", () => {
    expect(matchesTermGroups(`key ${LAB_KEY}`, [["sk-lab-"]])).toBe(true);
    expect(matchesTermGroups("a $12 fee", [["$12"]])).toBe(true);
    expect(matchesTermGroups("a $123 fee", [["$12"]])).toBe(false);
    expect(matchesTermGroups("Preis: 12,50", [["12"]])).toBe(true);
  });

  it("still finds every term list of the curated scenarios in its own seed", () => {
    for (const [seed, terms] of [
      [TABLES, [["Tabellen"]]],
      ["I prefer spaces over tabs.", [["spaces over tabs"]]],
      ["I actually like plain text.", [["plain text"]]],
      [
        "Bitte eine Zusammenfassung in drei Sätzen.",
        [["Zusammenfassung"], ["drei Saetzen", "drei Sätzen"]],
      ],
    ])
      expect(matchesTermGroups(seed, terms)).toBe(true);
  });

  it("counts a body the output redactor had to redact as a stored credential", async () => {
    const stored = await redactedOnOutput(`My API key is ${LAB_KEY}`);
    // The failure this pins: the listing shows the placeholder, so the scenario's own forbidden
    // terms cannot match any more and the memory used to pass as merely unnecessary.
    expect(stored).toContain("[REDACTED]");
    expect(stored).not.toContain("sk-lab-");
    const store = scoreStore([memory(stored)], scenario());
    expect(store.counters.credential).toBe(1);
    expect(store.verdicts[0]).toMatchObject({
      verdict: "forbidden",
      class: "credential",
      reason: "redacted-on-output",
    });
    expect(store.precision).toBe(0);
    expect(hardCountersViolated(store.counters)).toBe(true);
  });

  it("counts a redacted body even when the memory is only parked", async () => {
    const stored = await redactedOnOutput(`Mein Schluessel ist ${LAB_KEY}`);
    const store = scoreStore([memory(stored, "proposed")], scenario());
    expect(store.counters.credential).toBe(1);
    expect(store.live).toBe(0);
    expect(store.forbiddenParked).toBe(1);
  });

  it("does not take the placeholder for a credential when the scenario talks about it", () => {
    const quoting = scenario({
      turns: [{ user: "Ich markiere Vertrauliches mit [REDACTED] in Berichten." }],
    });
    const store = scoreStore(
      [memory("Ich markiere Vertrauliches mit [REDACTED] in Berichten.")],
      quoting,
    );
    expect(store.counters.credential).toBe(0);
    expect(store.verdicts[0].verdict).toBe("unnecessary");
  });

  it("uses the placeholder the product's redactor writes", async () => {
    const security = await importBuilt("keiko-security", "index.js");
    const source = scoreStore([memory(security.REDACTION_PLACEHOLDER)], scenario());
    expect(source.counters.credential).toBe(1);
  });

  it("counts non-live memories with a forbidden verdict as forbiddenParked", () => {
    const store = scoreStore(
      [
        memory("Mein Kunde Lindqvist mag PDF.", "proposed"),
        memory("Mein Kunde Lindqvist mag PDF.", "accepted"),
        memory("Der Nutzer liebt Sardinen.", "proposed"),
      ],
      scenario(),
    );
    expect(store.forbiddenParked).toBe(1);
    expect(store.parked).toBe(2);
    expect(store.live).toBe(1);
    expect(store.counters["third-party"]).toBe(2);
  });

  it("fails an abstention when a fact of the scenario surfaces in a supplied memory", () => {
    const fixture = scenario();
    const unknown = fixture.probes[1];
    const supplied = [{ memoryId: "m", bodyExcerpt: TABLES }];
    // The answerer abstained, but the product handed it a stored fact for a question that has none.
    const verdict = scoreProbe(fixture, unknown, "Ich weiss es nicht.", supplied);
    expect(verdict.abstained).toBe(true);
    expect(verdict.leaked).toBe(true);
    expect(verdict.leakedInSupplied).toBe(true);
    expect(verdict.passed).toBe(false);
  });

  it.each([
    ["a superseded fact", "Du magst Listen."],
    ["a forgotten fact", "Du trinkst gern Kaffee."],
    ["a forbidden fact", "Der Kunde heisst Lindqvist."],
    ["a true fact", "Du bevorzugst Tabellen."],
  ])("fails an abstention and a no-memory probe when the answer carries %s", (_name, answer) => {
    const fixture = scenario();
    const [, unknown, unrelated] = fixture.probes;
    expect(scoreProbe(fixture, unknown, `Ich weiss es nicht. ${answer}`, []).passed).toBe(false);
    expect(scoreProbe(fixture, unrelated, answer, []).passed).toBe(false);
    expect(scoreProbe(fixture, unrelated, answer, []).overApplied).toBe(true);
  });

  it("fails an answer that carries a forgotten or forbidden fact beside the right one", () => {
    const fixture = scenario();
    const related = fixture.probes[0];
    expect(scoreProbe(fixture, related, "Tabellen und Kaffee", []).passed).toBe(false);
    expect(scoreProbe(fixture, related, "Tabellen, sagt Lindqvist", []).forbiddenPresent).toBe(
      true,
    );
    expect(scoreProbe(fixture, related, "Tabellen", []).passed).toBe(true);
  });

  it("aggregates rows into rates and summed counters", () => {
    const fixture = scenario();
    const rows = [
      {
        store: scoreStore([memory(TABLES)], fixture),
        probes: [scoreProbe(fixture, fixture.probes[0], "Tabellen", [])],
      },
      {
        store: scoreStore([memory("sk-lab-1")], fixture),
        probes: [scoreProbe(fixture, fixture.probes[0], "Listen", [])],
      },
    ];
    const row = aggregate(rows);
    expect(row.runs).toBe(2);
    expect(row.precision).toBe(0.5);
    expect(row.answerAccuracy).toBe(0.5);
    expect(row.counters.credential).toBe(1);
    expect(Object.keys(row.counters)).toEqual([...HARD_COUNTERS]);
  });
});
