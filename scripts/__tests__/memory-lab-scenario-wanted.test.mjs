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

describe("an expect the loader cannot measure", () => {
  it("refuses an unknown key, which would silently drop a requirement", () => {
    // The failure this pins: `earliers` loaded and the probe was scored as a plain current-value one.
    expect(() =>
      validateScenario(
        scenario(probeWith("Wie komme ich?", { terms: [["Fähre"]], earliers: ["old"] })),
      ),
    ).toThrow(/probes\[0\]\.expect\.earliers is not a key of expect/u);
    for (const key of ["term", "forbid", "need", "earliers", "allows", "formats"])
      expect(() =>
        validateScenario(
          scenario({
            probes: [{ id: "p", question: "q?", expect: { kind: "abstain", [key]: 1 } }],
          }),
        ),
      ).toThrow(/is not a key of expect/u);
  });

  it("refuses a wanted term that a forbidden term of the probe contains", () => {
    const refuse = (expectation, pattern) =>
      expect(() => validateScenario(scenario(probeWith("Wie komme ich?", expectation)))).toThrow(
        pattern,
      );
    refuse(
      { earlier: ["old"], forbidden: [["Düsseldorf"]] },
      /earlier "old" is also the probe's own forbidden terms/u,
    );
    refuse(
      { terms: [["Fähre"]], forbidden: [["Fähre", "Boot"]] },
      /terms is also the probe's own forbidden terms/u,
    );
    // Only a contradiction counts: a forbidden group the wanted terms do not carry is fine.
    expect(() =>
      validateScenario(
        scenario(probeWith("Wie komme ich?", { terms: [["Fähre"]], forbidden: [["Auto"]] })),
      ),
    ).not.toThrow();
    expect(() =>
      validateScenario(
        scenario(
          probeWith("Wie komme ich?", { terms: [["Fähre"]], forbidden: [["Fähre"], ["Auto"]] }),
        ),
      ),
    ).not.toThrow();
  });

  it("refuses a needed truth whose term is a forgotten or a forbidden fact", () => {
    const needsRoom = probeWith("Wie?", { needs: ["room"] });
    expect(() =>
      validateScenario(scenario({ ...needsRoom, forgotten: [{ terms: [["Birch"]] }] })),
    ).toThrow(/needs "room" is also forgotten\[0\]/u);
    expect(() =>
      validateScenario(
        scenario({ ...needsRoom, forbidden: [{ class: "other", terms: [["birch"]] }] }),
      ),
    ).toThrow(/needs "room" is also forbidden\[0\]/u);
    expect(() =>
      validateScenario(scenario({ ...needsRoom, forgotten: [{ terms: [["Kaffee"]] }] })),
    ).not.toThrow();
  });
});

describe("a `with` binding that binds nothing", () => {
  const bound = (bindings, expectation = { needs: ["atlas", "borealis"] }) =>
    scenario({
      truth: [
        {
          key: "atlas",
          seed: "Atlas nutzt A.",
          must: false,
          terms: [["Cockroach"]],
          ...bindings.atlas,
        },
        {
          key: "borealis",
          seed: "Borealis nutzt B.",
          must: false,
          terms: [["Arango"]],
          ...bindings.borealis,
        },
      ],
      seed: undefined,
      turns: [{ user: "Hallo." }],
      ...probeWith("Welche Speicher?", expectation),
    });

  it("loads two distinct subjects", () => {
    expect(() =>
      validateScenario(bound({ atlas: { with: [["Atlas"]] }, borealis: { with: [["Borealis"]] } })),
    ).not.toThrow();
  });

  it("refuses a with that its own terms already carry", () => {
    expect(() => validateScenario(bound({ atlas: { with: [["Cockroach"]] } }))).toThrow(
      /truth\[0\]\.with is carried by its own terms/u,
    );
  });

  it("refuses a with that names the subject or the value of another truth of the probe", () => {
    expect(() =>
      validateScenario(bound({ atlas: { with: [["Atlas"]] }, borealis: { with: [["Atlas"]] } })),
    ).toThrow(/truth "atlas" with "Atlas" names the subject or value of truth "borealis"/u);
    expect(() =>
      validateScenario(
        bound({ atlas: { with: [["Arango"]] }, borealis: { with: [["Borealis"]] } }),
      ),
    ).toThrow(/truth "atlas" with "Arango" names the subject or value of truth "borealis"/u);
    // A truth that the probe does not need alongside is not a rival.
    expect(() =>
      validateScenario(
        bound(
          { atlas: { with: [["Arango"]] }, borealis: { with: [["Borealis"]] } },
          { needs: ["atlas"] },
        ),
      ),
    ).not.toThrow();
  });
});
