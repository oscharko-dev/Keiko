import { describe, expect, it } from "vitest";
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
