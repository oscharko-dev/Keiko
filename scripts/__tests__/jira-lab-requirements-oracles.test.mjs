// The pure oracles of the requirement-derivation journeys S14-S16 (#4179) grade against the
// generated ground truth only; they never ask the model whether it succeeded.
import { describe, expect, it } from "vitest";
import {
  changeImpactTruth,
  structuredChangeSet,
} from "../testing/jira-chat-lab/requirements/change-impact.mjs";
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
  const currentIds = buildCorpus(2).truth.map((item) => item.id);
  // The epics of the first turn trace the changed and removed requirements, as the write path
  // labels them; one more epic traces an unchanged requirement, as another journey may have.
  const issue = (key, id) => ({
    key,
    fields: { labels: ["keiko-requirement", `keiko-req-${id}`] },
  });
  const epics = [...change.changed, ...change.removed].map((id, index) =>
    issue(`REQ-${index + 11}`, id),
  );
  const issues = [...epics, issue("REQ-30", "LH-001")];
  const truth = changeImpactTruth(issues, change, currentIds);
  const keys = epics.map((epic) => epic.key);
  const toolSays = (changes) => [
    {
      result: {
        toolRef: { canonicalId: "keiko.knowledge.requirements" },
        status: "completed",
        data: { outcome: "succeeded", view: "changes", changes },
      },
    },
  ];
  const stated = {
    baseline: { complete: true },
    changed: change.changed.map((id) => ({ id })),
    removed: change.removed.map((id) => ({ id })),
    untraced: [...truth.untraced],
    affectedIssues: keys,
  };
  const structured = structuredChangeSet(toolSays(stated));
  const answer = (said = {}) =>
    [
      `GEÄNDERT: ${(said.changed ?? change.changed).join(", ")}`,
      `ENTFERNT: ${(said.removed ?? change.removed).join(", ")}`,
      `NEU: ${(said.untraced ?? [...truth.untraced]).join(", ")}`,
      `BETROFFENE VORGÄNGE: ${(said.keys ?? keys).join(", ")}`,
    ].join("\n");

  it("takes the untraced set and the affected issues from what Jira holds", () => {
    expect([...truth.untraced]).not.toContain("LH-001");
    expect([...truth.untraced]).toEqual(expect.arrayContaining(change.added));
    expect([...truth.affected].sort()).toEqual([...keys].sort());
    expect(truth.traceable).toBe(true);
  });

  it("requires the answer and the tool to state the same sets", () => {
    expect(gradeChangeImpact(answer(), truth, structured).ok).toBe(true);
    expect(gradeChangeImpact(answer({ keys: keys.slice(1) }), truth, structured)).toMatchObject({
      affected: false,
      changed: true,
    });
    expect(gradeChangeImpact(answer({ untraced: change.added }), truth, structured).added).toBe(
      false,
    );
    const disagreeing = structuredChangeSet(toolSays({ ...stated, removed: [], untraced: [] }));
    expect(gradeChangeImpact(answer(), truth, disagreeing)).toMatchObject({
      ok: false,
      removed: false,
    });
  });

  it("credits nothing without a complete changes result of the turn", () => {
    expect(structuredChangeSet([])).toBeUndefined();
    expect(
      structuredChangeSet(toolSays({ ...stated, baseline: { complete: false } })),
    ).toBeUndefined();
    expect(structuredChangeSet(toolSays({ ...stated, truncated: ["untraced"] }))).toBeUndefined();
  });

  it("has no baseline when Jira holds no issue for a changed requirement", () => {
    const partial = changeImpactTruth(issues.slice(1), change, currentIds);

    expect(partial.traceable).toBe(false);
    expect(gradeChangeImpact(answer(), partial, structured).ok).toBe(false);
  });
});

describe("journey wiring (#4179)", () => {
  it("defines S04, S14, S15 and S16 next to the other journeys", () => {
    expect(Object.keys(JOURNEYS)).toEqual(expect.arrayContaining(["S04", "S14", "S15", "S16"]));
  });
});
