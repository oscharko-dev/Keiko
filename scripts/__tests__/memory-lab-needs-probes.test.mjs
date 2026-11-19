// Probes that need more than one memory and probes about an earlier value (#4207). Each metric is
// proven red with a deliberately wrong answer before it counts: an answer that carries one of two
// needed facts must fail, and a failure must say whether the fact never reached the model or did and
// was not used.
import { describe, expect, it } from "vitest";
import { maskHoldoutResult } from "../testing/memory-lab/corpus/holdout.mjs";
import { validateScenario } from "../testing/memory-lab/scenario.mjs";
import { scoreProbe } from "../testing/memory-lab/score.mjs";

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
        },
      ],
      seed: { total: 40, filler: 38 },
    };
    const masked = maskHoldoutResult(result, "holdout:x");
    expect(masked.probes[0].neededMissing).toEqual(["fact-1", "fact-2"]);
    expect(masked.probes[0].neededNotSupplied).toEqual(["fact-1"]);
    expect(masked.seed).toBeUndefined();
    expect(JSON.stringify(masked)).not.toMatch(/room|before|day|filler/u);
  });
});
