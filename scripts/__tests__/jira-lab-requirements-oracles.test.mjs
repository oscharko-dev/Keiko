// The pure oracles of the requirement-derivation journeys S14-S16 (#4179) grade against the
// generated ground truth only; they never ask the model whether it succeeded.
import { describe, expect, it } from "vitest";
import { buildCorpus, corpusChange } from "../testing/jira-chat-lab/requirements/corpus.mjs";
import { JOURNEYS } from "../testing/jira-chat-lab/requirements/journey-checks.mjs";
import {
  gradeChangeImpact,
  gradeCriterionTestCases,
  gradeQualityFindings,
} from "../testing/jira-chat-lab/requirements/oracles.mjs";

const TRUTH = buildCorpus(1).truth;
const VAGUE = TRUTH.filter((item) => item.vague).map((item) => item.id);
const NO_CRITERIA = TRUTH.filter((item) => item.acceptanceCount === 0).map((item) => item.id);

describe("quality findings (S15)", () => {
  it("accepts exactly the seeded defects and rejects an omission or an extra id", () => {
    const exact = `UNKLAR: ${VAGUE.join(", ")}\nOHNE ABNAHMEKRITERIEN: ${NO_CRITERIA.join(", ")}`;
    const omitted = `UNKLAR: ${VAGUE.slice(1).join(", ")}\nOHNE ABNAHMEKRITERIEN: ${NO_CRITERIA.join(", ")}`;
    const extra = `unklar: ${VAGUE.join(", ")}, LH-001\nOhne Abnahmekriterien: ${NO_CRITERIA.join(", ")}`;

    expect(gradeQualityFindings(exact, TRUTH)).toMatchObject({ vagueOk: true, missingOk: true });
    expect(gradeQualityFindings(omitted, TRUTH)).toMatchObject({ vagueOk: false, missingOk: true });
    expect(gradeQualityFindings(extra, TRUTH)).toMatchObject({ vagueOk: false, missingOk: true });
    expect(gradeQualityFindings("keine", TRUTH)).toMatchObject({
      vagueOk: false,
      missingOk: false,
    });
  });
});

describe("test cases per criterion (S16)", () => {
  const item = TRUTH.find((entry) => entry.id === "LH-002");

  it("needs every criterion reference and no invented one", () => {
    const all = item.acceptance
      .map((_, index) => `TF ${index + 1}: LH-002/AC${index + 1}`)
      .join("\n");

    expect(gradeCriterionTestCases(all, item).ok).toBe(true);
    expect(gradeCriterionTestCases("LH-002/AC1", item)).toMatchObject({ ok: false, missing: [2] });
    expect(gradeCriterionTestCases(`${all}\nLH-002/AC9`, item)).toMatchObject({
      ok: false,
      invented: [9],
    });
  });
});

describe("change impact (S14)", () => {
  const change = corpusChange();
  const answer = (keys) =>
    [
      `GEÄNDERT: ${change.changed.join(", ")}`,
      `ENTFERNT: ${change.removed.join(", ")}`,
      `NEU: ${change.added.join(", ")}`,
      `BETROFFENE VORGÄNGE: ${keys.join(", ")}`,
    ].join("\n");

  it("requires the three requirement sets and exactly the tracing issues", () => {
    const keys = ["REQ-11", "REQ-12", "REQ-13", "REQ-14"];

    expect(gradeChangeImpact(answer(keys), change, keys).ok).toBe(true);
    expect(gradeChangeImpact(answer(keys.slice(1)), change, keys)).toMatchObject({
      affected: false,
      changed: true,
    });
    expect(
      gradeChangeImpact(answer(keys).replace("NEU:", "NEU: LH-001,"), change, keys).added,
    ).toBe(false);
  });
});

describe("journey wiring (#4179)", () => {
  it("defines S04, S14, S15 and S16 next to the other journeys", () => {
    expect(Object.keys(JOURNEYS)).toEqual(expect.arrayContaining(["S04", "S14", "S15", "S16"]));
  });
});
