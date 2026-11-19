// Probes that need more than one memory and probes about an earlier value (#4207). Each metric is
// proven red with a deliberately wrong answer before it counts: an answer that carries one of two
// needed facts must fail, and a failure must say whether the fact never reached the model or did and
// was not used.
import { describe, expect, it } from "vitest";
import { maskHoldoutResult } from "../testing/memory-lab/corpus/holdout.mjs";
import { validateScenario } from "../testing/memory-lab/scenario.mjs";
import {
  answerUnits,
  carrierIds,
  scoreProbe,
  suppliedCarries,
  wantedOf,
} from "../testing/memory-lab/score.mjs";

function scenario(probes, overrides = {}) {
  return validateScenario({
    schemaVersion: 1,
    id: "needs-fixture-en",
    language: "en",
    class: "update",
    difficulty: "plain",
    description: "Needs fixture.",
    truth: [
      { key: "room", seed: "Room Birch.", must: false, terms: [["Birch"]] },
      { key: "day", seed: "Every Tuesday.", must: false, terms: [["Tuesday"]] },
    ],
    superseded: [{ key: "before", terms: [["Monday"]] }],
    forgotten: [{ terms: [["Kolibri"]] }],
    turns: [{ user: "Hello." }],
    probes,
    ...overrides,
  });
}

const BOTH = {
  id: "both",
  question: "Where and when is the meeting?",
  expect: { kind: "answer", needs: ["room", "day"] },
};
const EARLIER = {
  id: "earlier",
  question: "When was the meeting before?",
  expect: { kind: "answer", earlier: ["before"] },
};
const supply = (...bodies) =>
  bodies.map((body, index) => ({ memoryId: `m${String(index)}`, bodyExcerpt: body }));

function score(probe, answer, supplied, links) {
  return scoreProbe(scenario([probe]), probe, answer, supplied, links);
}

describe("a probe that needs several memories", () => {
  it("passes only when the answer carries the terms of every named truth", () => {
    const supplied = supply("The meeting is in room Birch.", "The meeting is every Tuesday.");
    expect(score(BOTH, "Birch, on Tuesday.", supplied).passed).toBe(true);
    // Red: one of two needed facts is not enough.
    const half = score(BOTH, "It is in room Birch.", supplied);
    expect(half.passed).toBe(false);
    expect(half.neededMissing).toEqual(["day"]);
    expect(score(BOTH, "No idea.", supplied).neededMissing).toEqual(["room", "day"]);
  });

  it("still fails on a forbidden term, whatever else the answer carries", () => {
    const supplied = supply("The meeting is in room Birch.", "The meeting is every Tuesday.");
    const result = score(BOTH, "Birch, Tuesday, and Kolibri.", supplied);
    expect(result.termsPresent).toBe(true);
    expect(result.forbiddenPresent).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("names which needed memory never reached the model, apart from which the answer lacks", () => {
    // Both facts are in the answer (from the model's own text) but only one memory was supplied.
    const answer = score(BOTH, "Birch, Tuesday.", supply("The meeting is in room Birch."));
    expect(answer.passed).toBe(true);
    expect(answer.neededNotSupplied).toEqual(["day"]);
    expect(answer.relevantSupplied).toBe(false);
    // Retrieved but not used: supplied, and the answer does not carry it.
    const unused = score(BOTH, "Birch.", supply("room Birch.", "every Tuesday."));
    expect(unused.neededNotSupplied).toEqual([]);
    expect(unused.neededMissing).toEqual(["day"]);
    expect(unused.relevantSupplied).toBe(true);
  });

  it("counts a seeded memory as supplied by its link, even when its excerpt is cut short", () => {
    const links = new Map([
      ["m0", { truth: "room" }],
      ["m1", { truth: "day" }],
    ]);
    const cut = supply("The meet", "The meet");
    expect(score(BOTH, "x", cut, links).neededNotSupplied).toEqual([]);
    expect(score(BOTH, "x", cut).neededNotSupplied).toEqual(["room", "day"]);
  });

  it("leaves a probe that names nothing exactly as before: no needed fields", () => {
    const plain = { id: "p", question: "Where?", expect: { kind: "answer", terms: [["Birch"]] } };
    const result = score(plain, "Birch.", supply("room Birch."));
    expect(Object.keys(result)).toEqual([
      "id",
      "kind",
      "passed",
      "termsPresent",
      "forbiddenPresent",
      "forbiddenMentioned",
      "relevantSupplied",
      "suppliedCount",
    ]);
  });

  it("adds its own terms to the needed ones when it has both", () => {
    const probe = {
      id: "p",
      question: "Where?",
      expect: { kind: "answer", terms: [["Birch"]], needs: ["day"] },
    };
    const supplied = supply("room Birch.", "every Tuesday.");
    expect(score(probe, "Birch on Tuesday", supplied).passed).toBe(true);
    expect(score(probe, "Birch", supplied).passed).toBe(false);
    expect(score(probe, "Tuesday", supplied).passed).toBe(false);
  });
});

describe("a probe about an earlier value", () => {
  it("passes on the replaced value and fails on the current one", () => {
    const supplied = supply("The meeting used to be on Monday.");
    expect(score(EARLIER, "On Monday.", supplied).passed).toBe(true);
    // Red: the current value is the wrong answer to a question about the earlier one.
    const current = score(EARLIER, "Every Tuesday.", supply("The meeting is every Tuesday."));
    expect(current.passed).toBe(false);
    expect(current.neededMissing).toEqual(["earlier:before"]);
    expect(current.neededNotSupplied).toEqual(["earlier:before"]);
  });

  it("is supplied by a seeded record linked to the replaced value", () => {
    const links = new Map([["m0", { earlier: "before" }]]);
    expect(score(EARLIER, "x", supply("cut"), links).neededNotSupplied).toEqual([]);
    expect(
      score(EARLIER, "x", supply("cut"), new Map([["m0", { truth: "before" }]])).neededNotSupplied,
    ).toEqual(["earlier:before"]);
  });
});

describe("validating needs and earlier", () => {
  const probe = (expect) => [{ id: "p", question: "Q?", expect }];
  const refused = (expectation, message) =>
    expect(() => scenario(probe(expectation))).toThrow(message);

  it("accepts an answer probe that has needs or earlier and no terms of its own", () => {
    expect(scenario(probe({ kind: "answer", needs: ["room"] })).probes).toHaveLength(1);
    expect(scenario(probe({ kind: "answer", earlier: ["before"] })).probes).toHaveLength(1);
  });

  it("still requires terms on an answer probe that names neither", () => {
    refused({ kind: "answer" }, "expect.terms must be non-empty term groups");
  });

  it("refuses a key that does not exist, a repeated key, an empty list and another kind of probe", () => {
    refused({ kind: "answer", needs: ["nowhere"] }, "names no such key: nowhere");
    refused({ kind: "answer", earlier: ["room"] }, "names no such key: room");
    refused({ kind: "answer", needs: ["room", "room"] }, "names a key twice");
    refused({ kind: "answer", needs: [] }, "non-empty array of keys");
    refused({ kind: "abstain", needs: ["room"] }, "only measured on an answer probe");
  });

  it("keeps the rule that a true term cannot occur inside a replaced value", () => {
    expect(() =>
      scenario(probe({ kind: "answer", earlier: ["before"] }), {
        superseded: [{ key: "before", terms: [["Birch room"]] }],
      }),
    ).toThrow("occurs inside the replaced value");
  });

  it("refuses a replaced value with a malformed or repeated key", () => {
    expect(() =>
      scenario(probe({ kind: "answer", terms: [["Birch"]] }), {
        superseded: [{ key: "Bad Key", terms: [["Monday"]] }],
      }),
    ).toThrow("key must be a lowercase slug");
    expect(() =>
      scenario(probe({ kind: "answer", terms: [["Birch"]] }), {
        superseded: [
          { key: "a", terms: [["Monday"]] },
          { key: "a", terms: [["Friday"]] },
        ],
      }),
    ).toThrow("duplicates a");
  });
});

describe("a sealed run's view of such a probe", () => {
  it("names no fact key and no seeded store: both are part of the hidden scenario", () => {
    const result = {
      scenario: "needs-fixture-en",
      store: { missing: [], verdicts: [], memories: [] },
      probes: [
        {
          id: "both",
          kind: "answer",
          passed: false,
          neededMissing: ["room", "earlier:before"],
          neededNotSupplied: ["day"],
          recallTrace: { needed: [{ key: "room", id: "m-room", stage: "beyond-limit" }] },
        },
      ],
      seed: { total: 40, filler: 38 },
    };
    const masked = maskHoldoutResult(result, "holdout:x");
    expect(masked.probes[0].neededMissing).toEqual(["fact-1", "fact-2"]);
    expect(masked.probes[0].neededNotSupplied).toEqual(["fact-1"]);
    expect(masked.seed).toBeUndefined();
    expect(masked.probes[0].recallTrace).toBeUndefined();
    expect(JSON.stringify(masked)).not.toMatch(/room|before|day|filler/u);
  });
});

describe("a needed truth bound to its subject with `with`", () => {
  const bound = validateScenario({
    schemaVersion: 1,
    id: "bound-fixture-en",
    language: "en",
    class: "update",
    difficulty: "plain",
    description: "Bound fixture.",
    truth: [
      {
        key: "atlas",
        seed: "I chose PostgreSQL for project Atlas.",
        must: false,
        terms: [["PostgreSQL", "Postgres"]],
        with: [["Atlas"]],
      },
      {
        key: "borealis",
        seed: "I chose MongoDB for project Borealis.",
        must: false,
        terms: [["MongoDB"]],
        with: [["Borealis"]],
      },
      { key: "plain", seed: "Room Birch.", must: false, terms: [["Birch"]] },
    ],
    turns: [{ user: "Hello." }],
    probes: [
      {
        id: "compare",
        question: "Which storage for Atlas and Borealis?",
        expect: { kind: "answer", needs: ["atlas", "borealis"] },
      },
      {
        id: "mixed",
        question: "Storage for Atlas, and the room?",
        expect: { kind: "answer", needs: ["atlas", "plain"] },
      },
    ],
  });
  const [compare, mixed] = bound.probes;
  const run = (probe, answer) => scoreProbe(bound, probe, answer, supply("x"), undefined);

  it("passes the correct answer, in one sentence or in two", () => {
    expect(run(compare, "Atlas uses PostgreSQL and Borealis uses MongoDB.").passed).toBe(true);
    expect(run(compare, "Atlas uses PostgreSQL. Borealis uses MongoDB.").passed).toBe(true);
    expect(run(compare, "Atlas: Postgres; Borealis: MongoDB").passed).toBe(true);
  });

  it("fails the reversed answer, which carries both terms but binds them wrongly", () => {
    // The failure this pins: both terms were somewhere in the answer, so the swap passed.
    const swapped = run(compare, "Atlas uses MongoDB. Borealis uses PostgreSQL.");
    expect(swapped.passed).toBe(false);
    expect(swapped.neededMissing).toEqual(["atlas", "borealis"]);
    expect(
      run(compare, "Atlas uses PostgreSQL. Borealis is on something else.").neededMissing,
    ).toEqual(["borealis"]);
  });

  it("reads a Markdown list with one item per project", () => {
    expect(run(compare, "- Atlas: PostgreSQL\n- Borealis: MongoDB").passed).toBe(true);
    expect(run(compare, "- Atlas: MongoDB\n- Borealis: PostgreSQL").passed).toBe(false);
    expect(answerUnits("- Atlas: PostgreSQL\n- Borealis: MongoDB. Done!")).toEqual([
      "- Atlas: PostgreSQL",
      "- Borealis: MongoDB",
      " Done",
    ]);
  });

  it("fails a reversed association inside one sentence, on both facts", () => {
    // The failure this pins: both subjects and both values occurred in one unit, so it passed.
    const swapped = run(compare, "Atlas uses MongoDB and Borealis uses PostgreSQL.");
    expect(swapped.passed).toBe(false);
    expect(swapped.neededMissing).toEqual(["atlas", "borealis"]);
    expect(run(compare, "Atlas uses PostgreSQL and Borealis uses MongoDB.").passed).toBe(true);
    expect(run(compare, "Atlas: Postgres, Borealis: MongoDB").passed).toBe(true);
    expect(run(compare, "Atlas: MongoDB, Borealis: PostgreSQL").neededMissing).toEqual([
      "atlas",
      "borealis",
    ]);
  });

  it("does not carry a value that two subjects share equally, or one that is no nearer its own", () => {
    // Remaining limit: a coordinated clause cannot be decided. At most one of the facts is carried.
    const coordinated = run(compare, "Atlas and Borealis use PostgreSQL and MongoDB.");
    expect(coordinated.passed).toBe(false);
    expect(coordinated.neededMissing).toContain("atlas");
    expect(run(compare, "Atlas MongoDB Borealis PostgreSQL").passed).toBe(false);
  });

  it("keeps a decimal point inside its unit", () => {
    expect(answerUnits("Limit 5.000 Euro. Next 3.5 days!")).toEqual([
      "Limit 5.000 Euro",
      " Next 3.5 days",
    ]);
  });

  it("applies the binding when it decides which supplied memory carries a fact", () => {
    // The failure this pins: the text fallback ignored `with`, so a memory about Atlas "carried"
    // the Borealis fact and the diagnostics called a retrieved fact missing the wrong one.
    const [atlas, borealis] = wantedOf(bound, compare);
    const memories = [
      { id: "m0", body: "Atlas uses MongoDB." },
      { id: "m1", body: "Borealis uses MongoDB." },
    ];
    expect(carrierIds(memories, borealis)).toEqual(["m1"]);
    expect(carrierIds(memories, atlas)).toEqual([]);
    expect(suppliedCarries(supply("Atlas uses MongoDB."), borealis, undefined)).toBe(false);
    expect(suppliedCarries(supply("Borealis uses MongoDB."), borealis, undefined)).toBe(true);
    // The exact seed link still carries the fact whatever the text says.
    expect(
      suppliedCarries(supply("anything"), borealis, new Map([["m0", { truth: "borealis" }]])),
    ).toBe(true);
    const asked = scoreProbe(bound, compare, "x", supply("Atlas uses MongoDB."), undefined);
    expect(asked.neededNotSupplied).toEqual(["atlas", "borealis"]);
  });

  it("leaves a truth without the field exactly as it was, wherever its term occurs", () => {
    expect(run(mixed, "Atlas uses PostgreSQL.\n\nThe room is Birch.").passed).toBe(true);
    expect(run(mixed, "The room is Birch, but I do not know the storage.").neededMissing).toEqual([
      "atlas",
    ]);
    expect(run(mixed, "Birch. PostgreSQL. Atlas.").neededMissing).toEqual(["atlas"]);
  });

  it("is a closed field of a scenario: non-empty term groups, or the scenario is refused", () => {
    const refuse = (withValue) =>
      expect(() =>
        validateScenario({
          ...bound,
          truth: [{ ...bound.truth[0], with: withValue }, ...bound.truth.slice(1)],
        }),
      ).toThrow(/\.with must be non-empty term groups/u);
    refuse([]);
    refuse("Atlas");
    refuse([[]]);
  });
});
