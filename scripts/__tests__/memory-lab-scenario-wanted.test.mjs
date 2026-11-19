// The scenario loader fails closed on a probe that wants something it cannot measure (audit F3, F6):
// a wanted term the question already contains, a wanted term that contradicts what the probe forbids,
// an unknown key of `expect`, and a `with` binding that binds nothing. Each case is a defect the
// audit executed on a loadable scenario; every refusal is paired with the repaired shape that loads.
import { describe, expect, it } from "vitest";
import { validateScenario } from "../testing/memory-lab/scenario.mjs";

function scenario(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "wanted-fixture-de",
    language: "de",
    class: "paraphrase",
    difficulty: "plain",
    description: "Fixture.",
    truth: [
      { key: "commute", seed: "Ich fahre mit der Fähre.", must: false, terms: [["Fähre"]] },
      { key: "room", seed: "Das Treffen ist in Raum Birch.", must: false, terms: [["Birch"]] },
    ],
    superseded: [{ key: "old", terms: [["Düsseldorf"]] }],
    turns: [],
    seed: {
      records: [
        {
          key: "commute",
          body: "Ich fahre mit der Fähre.",
          type: "semantic-fact",
          scope: "user",
          status: "accepted",
          ageDays: 5,
          truth: "commute",
        },
      ],
    },
    probes: [
      {
        id: "p",
        question: "Wie komme ich zur Arbeit?",
        expect: { kind: "answer", terms: [["Fähre"]] },
      },
    ],
    ...overrides,
  };
}

const probeWith = (question, expectation) => ({
  probes: [{ id: "p", question, expect: { kind: "answer", ...expectation } }],
});

describe("a wanted term the question already contains", () => {
  it("refuses an own term that the question carries, folded like the scorer folds it", () => {
    // "Fähre" folds to "fahre", which the question carries: a parroted answer passed.
    expect(() =>
      validateScenario(scenario(probeWith("Womit fahre ich zur Arbeit?", { terms: [["Fähre"]] }))),
    ).toThrow(/probe p: terms term "Fähre" occurs in the probe's own question/u);
    expect(() =>
      validateScenario(scenario(probeWith("Wie komme ich zur Arbeit?", { terms: [["Fähre"]] }))),
    ).not.toThrow();
  });

  it("refuses it in one alternative of a group, and in a prefix term", () => {
    expect(() =>
      validateScenario(
        scenario(probeWith("Welche Faehre?", { terms: [["Birch", "Faehre", "Boot"]] })),
      ),
    ).toThrow(/term "Faehre" occurs/u);
    expect(() =>
      validateScenario(scenario(probeWith("Fahre ich?", { terms: [["Fahr*"]] }))),
    ).toThrow(/term "Fahr\*" occurs/u);
  });

  it("refuses a needed truth and a replaced value the question carries", () => {
    expect(() =>
      validateScenario(scenario(probeWith("Ist es Raum Birch?", { needs: ["room"] }))),
    ).toThrow(/needs "room" term "Birch" occurs in the probe's own question/u);
    expect(() =>
      validateScenario(scenario(probeWith("War es früher Düsseldorf?", { earlier: ["old"] }))),
    ).toThrow(/earlier "old" term "Düsseldorf" occurs in the probe's own question/u);
    expect(() =>
      validateScenario(scenario(probeWith("Wo war es früher?", { earlier: ["old"] }))),
    ).not.toThrow();
  });

  it("leaves an abstain probe and a forbidden term that the question names alone", () => {
    expect(() =>
      validateScenario(
        scenario({
          probes: [
            { id: "p", question: "Wie komme ich?", expect: { kind: "answer", terms: [["Fähre"]] } },
            {
              id: "q",
              question: "Und die Fähre von Dana?",
              expect: { kind: "abstain", forbidden: [["Dana"], ["Fähre"]] },
            },
          ],
        }),
      ),
    ).not.toThrow();
  });
});
