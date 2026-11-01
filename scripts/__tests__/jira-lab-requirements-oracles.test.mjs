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
  gradeDeviationReport,
  gradeQualityFindings,
  sectionsPresent,
} from "../testing/jira-chat-lab/requirements/oracles.mjs";

const TRUTH = buildCorpus(1).truth;
const VAGUE = TRUTH.filter((item) => item.vague).map((item) => item.id);
const NO_CRITERIA = TRUTH.filter((item) => item.acceptanceCount === 0).map((item) => item.id);

// Lab S05 (Qwen, 2026-11-01): epics whose sections read "__Ziel__" were judged to miss every section
// although "**Ziel**", the same Markdown emphasis, counted; the product's section rule strips both.
describe("description sections", () => {
  const SECTIONS = ["Ziel", "Fachlicher Kontext"];
  it.each([
    ["h2. Ziel\nx\nh2. Fachlicher Kontext\ny"],
    ["## Ziel\nx\n## Fachlicher Kontext\ny"],
    ["**Ziel**\nx\n**Fachlicher Kontext**\ny"],
    ["__Ziel__\nx\n__Fachlicher Kontext__\ny"],
  ])("finds every section heading in %j", (description) => {
    expect(sectionsPresent(description, SECTIONS)).toBe(true);
  });
  it.each([["__Ziel__\nx"], ["Das Ziel und der Fachlicher Kontext stehen im Text."], [undefined]])(
    "misses a section that is not a heading line in %j",
    (description) => {
      expect(sectionsPresent(description, SECTIONS)).toBe(false);
    },
  );
});

// Lab S11 (Qwen, 2026-11-01): the report flagged the estimate as "field-missing: Time Tracking", the
// answer said so for all eight issues, and the grader knew only the Story Points words for it.
describe("estimate deviations (S11)", () => {
  const issues = [{ key: "RPT-50", deviations: ["estimate"] }];
  const structured = new Map([
    ["RPT-50", { ruleIds: new Set(["field-missing"]), fieldIds: new Set(["timetracking"]) }],
  ]);
  const grade = (answer) =>
    gradeDeviationReport(answer, issues, structured, { storyPoints: "timetracking" });

  it.each([
    "| RPT-50 | Feld „Time Tracking“ fehlt |",
    "RPT-50: Zeiterfassung ist nicht gesetzt",
    "RPT-50: Original Estimate fehlt",
    "RPT-50: keine ursprüngliche Schätzung",
    "RPT-50: Story Points fehlen",
  ])("credits Jira's estimate field named as such: %s", (answer) => {
    expect(grade(answer).undescribed).toEqual([]);
  });

  it("still requires the estimate to be described, and not denied", () => {
    expect(grade("RPT-50: Zusammenfassung weicht ab").undescribed).toEqual(["RPT-50 estimate"]);
    expect(grade("RPT-50: Time Tracking ist korrekt").undescribed).toEqual(["RPT-50 estimate"]);
  });
});

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
  const valid = [
    "TESTFALL LH-002/AC1 | Schritte: Als angemeldeter Versicherungsnehmer das Portal öffnen und Einmalcode wählen | Erwartet: Einmalcode ist verfügbar und nutzbar",
    "TESTFALL LH-002/AC2 | Schritte: Einen fehlerhaften Einmalcode eingeben und Absenden drücken | Erwartet: Die fehlerhafte Eingabe wird vor dem Absenden gemeldet",
  ];

  it("accepts one usable test case per criterion", () => {
    expect(gradeCriterionTestCases(valid.join("\n"), item)).toMatchObject({ ok: true, cases: 2 });
    expect(gradeCriterionTestCases(`- **${valid[0]}**\n- ${valid[1]}`, item).ok).toBe(true);
  });

  it("rejects references without test cases and a refusal", () => {
    const referencesOnly =
      "No test cases were designed. These are merely references: LH-002/AC1, LH-002/AC2";
    expect(gradeCriterionTestCases(referencesOnly, item)).toMatchObject({
      ok: false,
      missing: [1, 2],
    });
    expect(gradeCriterionTestCases("Ich kann keine Testfälle entwerfen.", item).ok).toBe(false);
  });

  it("rejects duplicate, incomplete, unrelated and invented cases", () => {
    expect(gradeCriterionTestCases([valid[0], valid[0]].join("\n"), item)).toMatchObject({
      ok: false,
      duplicated: [1],
      missing: [2],
    });
    const noResult =
      "TESTFALL LH-002/AC2 | Schritte: Einen fehlerhaften Einmalcode eingeben und absenden";
    expect(gradeCriterionTestCases(`${valid[0]}\n${noResult}`, item)).toMatchObject({
      ok: false,
      unusable: [2],
    });
    const unrelated =
      "TESTFALL LH-002/AC2 | Schritte: Als angemeldeter Versicherungsnehmer das Portal öffnen | Erwartet: Einmalcode ist verfügbar";
    expect(gradeCriterionTestCases(`${valid[0]}\n${unrelated}`, item)).toMatchObject({
      ok: false,
      unusable: [2],
    });
    const invented =
      "TESTFALL LH-002/AC9 | Schritte: Etwas anderes ausprobieren und prüfen | Erwartet: Es funktioniert wie erwartet";
    expect(gradeCriterionTestCases([...valid, invented].join("\n"), item)).toMatchObject({
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
