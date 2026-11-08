// Independent native oracle for #4321: 61 Stories lack an estimate; 65 is the project-wide
// figure including four Epics. Exercise the existing report owner, without a second parser.
import { describe, expect, it } from "vitest";
import {
  gradeProgress,
  parseProgressAnswer,
  progressTruth,
} from "../testing/jira-chat-lab/requirements/progress-report.mjs";

const FIELDS = { epicLink: "customfield_10001", storyPoints: "customfield_10002" };
const ESTIMATE = {
  fieldId: FIELDS.storyPoints,
  writeFieldId: FIELDS.storyPoints,
  unit: "points",
  label: "Story Points",
};
const CATEGORIES = { "To Do": "new", "In Progress": "indeterminate", Done: "done" };

function issue(key, type, status, estimate, parent) {
  return {
    key,
    fields: {
      issuetype: { name: type },
      status: { name: status, statusCategory: { key: CATEGORIES[status] } },
      [FIELDS.storyPoints]: estimate,
      ...(parent === undefined ? {} : { [FIELDS.epicLink]: parent }),
    },
  };
}

// Literal distribution: Done 0 + 72*3 + 13 = 229; remaining 234*4 + 5 = 941.
// Every later Story has an explicit native null, never an invented numeric zero.
function storyEstimate(index) {
  if (index === 0) return 0;
  if (index < 73) return 3;
  if (index === 73) return 13;
  if (index < 308) return 4;
  return index === 308 ? 5 : null;
}

function goldenIssues() {
  const epics = Array.from({ length: 4 }, (_, index) =>
    issue(`LIM7-${String(index + 1)}`, "Epic", "To Do", null),
  );
  const stories = Array.from({ length: 370 }, (_, index) =>
    issue(
      `LIM7-${String(index + 5)}`,
      "Story",
      index < 74 ? "Done" : index < 222 ? "In Progress" : "To Do",
      storyEstimate(index),
      `LIM7-${String((index % 4) + 1)}`,
    ),
  );
  return [...epics, ...stories];
}

const GOLDEN_ROWS = [
  ["ANZAHL", "Epic", "To Do", "4"],
  ["ANZAHL", "Story", "Done", "74"],
  ["ANZAHL", "Story", "In Progress", "148"],
  ["ANZAHL", "Story", "To Do", "148"],
  ["EPIC", "LIM7-1", "93", "19"],
  ["EPIC", "LIM7-2", "93", "19"],
  ["EPIC", "LIM7-3", "92", "18"],
  ["EPIC", "LIM7-4", "92", "18"],
  ["SCHÄTZUNG", "1170", "229", "941"],
  ["GESCHÄTZT", "Epic", "0"],
  ["GESCHÄTZT", "Story", "309"],
  ["UNGESCHÄTZT", "Epic", "4"],
  ["UNGESCHÄTZT", "Story", "61"],
];
const rowsText = (rows) => rows.map((row) => row.join(";")).join("\n");
const goldenTruth = () => progressTruth(goldenIssues(), FIELDS, ESTIMATE);

function localizedRows(locale) {
  return GOLDEN_ROWS.map(([kind, ...cells]) => {
    if (kind === "SCHÄTZUNG") return [kind, locale === "de" ? "1.170" : "1,170", "229", "941"];
    const localizedKind =
      locale === "en" && kind === "GESCHÄTZT"
        ? "ESTIMATED"
        : locale === "en" && kind === "UNGESCHÄTZT"
          ? "UNESTIMATED"
          : kind;
    return [localizedKind, ...cells.map((cell) => (cell === "Story" ? "Stories" : cell))];
  });
}

function expectGoldenGrade(answer) {
  const grade = gradeProgress(answer, goldenTruth());
  expect(grade.counts).toMatchObject({ graded: true, ok: true });
  expect(grade.epics).toMatchObject({ graded: true, ok: true });
  expect(grade.estimate).toMatchObject({ graded: true, ok: true });
  expect(grade.estimated).toMatchObject({ graded: true, ok: true });
  expect(grade.unestimated).toMatchObject({ graded: true, ok: true });
  expect(grade.conflicts).toBe(0);
}

describe("limit-run report golden: native Story scope", () => {
  it("computes the independent 374-issue oracle with 61 missing Story estimates, not global 65", () => {
    const truth = goldenTruth();
    expect(truth.issueCount).toBe(374);
    expect(truth.counts).toEqual(
      new Map([
        ["epic;to do", 4],
        ["story;done", 74],
        ["story;in progress", 148],
        ["story;to do", 148],
      ]),
    );
    expect(truth.estimate).toEqual({ total: 1170, done: 229, remaining: 941 });
    expect(truth.estimatedByType).toEqual(
      new Map([
        ["epic", 0],
        ["story", 309],
      ]),
    );
    expect(truth.unestimatedByType).toEqual(
      new Map([
        ["epic", 4],
        ["story", 61],
      ]),
    );
    expect([...truth.unestimatedByType.values()].reduce((sum, value) => sum + value, 0)).toBe(65);
  });

  it("accepts every exact scoped figure in the existing semicolon format", () => {
    expectGoldenGrade(rowsText(GOLDEN_ROWS));
  });

  it.each(["en", "de"])("accepts %s tab-separated rows and locale thousands", (locale) => {
    const answer = localizedRows(locale)
      .map((row) => row.join("\t"))
      .join("\n");
    const parsed = parseProgressAnswer(answer);
    expect(parsed.estimate).toEqual([1170, 229, 941]);
    expect(parsed.unestimatedByType?.get("story")).toBe(61);
    expectGoldenGrade(answer);
  });

  it.each(["en", "de"])(
    "accepts %s Markdown rows without treating the header as an issue type",
    (locale) => {
      const header =
        locale === "de"
          ? "| Kennzahl | Arbeitsvorgang | Status | Anzahl |"
          : "| Metric | Issue type | Status | Count |";
      const answer = [
        header,
        "| --- | --- | --- | --- |",
        ...localizedRows(locale).map((row) => `| ${row.join(" | ")} |`),
      ].join("\n");
      const parsed = parseProgressAnswer(answer);
      expect(parsed.counts.get("story;done")).toBe(74);
      expect(parsed.unestimatedByType?.get("story")).toBe(61);
      expectGoldenGrade(answer);
    },
  );

  it("rejects the superficially plausible project-wide 65 when the answer claims Story scope", () => {
    const answer = rowsText(GOLDEN_ROWS).replace("UNGESCHÄTZT;Story;61", "UNGESCHÄTZT;Story;65");
    const grade = gradeProgress(answer, goldenTruth());
    expect(grade.counts).toMatchObject({ ok: true });
    expect(grade.estimate).toMatchObject({ ok: true });
    expect(grade.unestimated).toMatchObject({ graded: true, ok: false });
  });

  it("does not let a correct Story count erase a conflicting plural English statement", () => {
    const answer = `${rowsText(GOLDEN_ROWS)}\nUNESTIMATED;Stories;65`;
    expect(parseProgressAnswer(answer).conflicts).toHaveLength(1);
    expect(gradeProgress(answer, goldenTruth()).unestimated).toMatchObject({ ok: false });
  });

  it.each(["74.0", "74,0", "74.5", "74,5"])(
    "rejects decimal issue count %s instead of truncating it",
    (count) => {
      const answer = rowsText(GOLDEN_ROWS).replace(
        "ANZAHL;Story;Done;74",
        `ANZAHL;Story;Done;${count}`,
      );
      expect(gradeProgress(answer, goldenTruth()).counts).toMatchObject({
        graded: true,
        ok: false,
      });
    },
  );

  it.each(["61.0", "61,0", "61.5", "61,5"])("rejects decimal unestimated count %s", (count) => {
    const answer = rowsText(GOLDEN_ROWS).replace(
      "UNGESCHÄTZT;Story;61",
      `UNGESCHÄTZT;Story;${count}`,
    );
    expect(gradeProgress(answer, goldenTruth()).unestimated).toMatchObject({
      graded: true,
      ok: false,
    });
  });

  it("keeps fractional estimates distinct from integer issue counts", () => {
    expect(parseProgressAnswer("SCHÄTZUNG;1.170,5;229,5;941").estimate).toEqual([
      1170.5, 229.5, 941,
    ]);
    expect(parseProgressAnswer("SCHÄTZUNG;1,5;1;0,5").estimate).toEqual([1.5, 1, 0.5]);
  });

  it("counts a native zero estimate as estimated and null as unestimated", () => {
    const truth = progressTruth(
      [issue("LIM7-1", "Story", "Done", 0), issue("LIM7-2", "Story", "To Do", null)],
      { storyPoints: FIELDS.storyPoints },
      ESTIMATE,
    );
    expect(truth.estimate).toEqual({ total: 0, done: 0, remaining: 0 });
    expect(truth.estimatedByType?.get("story")).toBe(1);
    expect(truth.unestimatedByType?.get("story")).toBe(1);
  });

  it("leaves an absent native estimate property unavailable instead of counting it as null or zero", () => {
    const observed = issue("LIM7-1", "Story", "Done", 0);
    const { [FIELDS.storyPoints]: estimate, ...fields } = observed.fields;
    expect(estimate).toBe(0);
    const missing = { ...observed, fields };
    const truth = progressTruth([missing], { storyPoints: FIELDS.storyPoints }, ESTIMATE);
    expect(truth.estimate).toBeUndefined();
    expect(truth.estimatedByType?.get("story")).toBeUndefined();
    expect(truth.unestimatedByType?.get("story")).toBeUndefined();
    const grade = gradeProgress(
      "ANZAHL;Story;Done;1\nGESCHÄTZT;Story;0\nUNGESCHÄTZT;Story;0",
      truth,
    );
    expect(grade.estimated).toMatchObject({ ok: false });
    expect(grade.unestimated).toMatchObject({ ok: false });
  });

  it("does not manufacture estimate coverage when native field metadata is unavailable", () => {
    const truth = progressTruth(goldenIssues(), {});
    expect(truth.estimate).toBeUndefined();
    expect(truth.estimatedByType).toBeUndefined();
    expect(truth.unestimatedByType).toBeUndefined();
    const grade = gradeProgress(rowsText(GOLDEN_ROWS), truth);
    expect(grade.estimate).toMatchObject({ graded: false, ok: false });
    expect(grade.estimated).toMatchObject({ graded: false, ok: false });
    expect(grade.unestimated).toMatchObject({ graded: false, ok: false });
  });

  it("matches an actual German native type name without guessing that it means Story", () => {
    const truth = progressTruth(
      [issue("LIM7-1", "Arbeitsvorgang", "To Do", null)],
      { storyPoints: FIELDS.storyPoints },
      ESTIMATE,
    );
    const grade = gradeProgress(
      "ANZAHL;Arbeitsvorgang;To Do;1\nGESCHÄTZT;Arbeitsvorgang;0\nUNGESCHÄTZT;Arbeitsvorgang;1",
      truth,
    );
    expect(grade.counts).toMatchObject({ graded: true, ok: true });
    expect(grade.unestimated).toMatchObject({ graded: true, ok: true });
    expect(parseProgressAnswer("UNESTIMATED;Stories;61").unestimatedByType?.get("story")).toBe(61);
  });
});

function humanTables(locale, options = {}) {
  const german = locale === "de";
  return [
    [
      [
        german ? "Vorgangstyp" : "Issue type",
        "To Do",
        "In Progress",
        "Done",
        german ? "Gesamt" : "Total",
      ],
      ["Epic", "4", "0", "0", "4"],
      ["Stories", "148", "148", options.done ?? "74", options.total ?? "370"],
    ],
    [
      german
        ? ["Kennzahl", "Gesamt", "Erledigt", "Offen"]
        : ["Metric", "Total", "Done", "Remaining"],
      ["Story Points", german ? "1.170" : "1,170", "229", "941"],
    ],
    [
      german ? ["Typ", "Mit Schätzung", "Ohne Schätzung"] : ["Type", "Estimated", "Unestimated"],
      ["Story", "309", options.unestimated ?? "61"],
      ["Epic", "0", "4"],
    ],
  ];
}

function renderHumanTables(tables, format) {
  return tables
    .map(([header, ...rows]) => {
      if (format === "tabs") return [header, ...rows].map((row) => row.join("\t")).join("\n");
      const separator = header.map(() => "---");
      return [header, separator, ...rows].map((row) => `| ${row.join(" | ")} |`).join("\n");
    })
    .join("\n\n");
}

// These tables ask for type/status counts, totals and type-scoped estimate coverage. They do
// not contain a per-Epic membership table; the original golden cases above grade that separately.
const humanTableTruth = () =>
  progressTruth(goldenIssues(), { storyPoints: FIELDS.storyPoints }, ESTIMATE);

describe("limit-run report golden: real header-bound tables without technical tags", () => {
  it.each([
    ["de", "markdown"],
    ["en", "markdown"],
    ["de", "tabs"],
    ["en", "tabs"],
  ])("accepts %s %s status, estimate and scoped coverage tables", (locale, format) => {
    const answer = renderHumanTables(humanTables(locale), format);
    expect(answer).not.toMatch(/ANZAHL|SCHÄTZUNG;|UNGESCHÄTZT;/u);
    const parsed = parseProgressAnswer(answer);
    expect(parsed.counts.get("story;done")).toBe(74);
    expect(parsed.counts.get("story;in progress")).toBe(148);
    expect(parsed.counts.get("story;to do")).toBe(148);
    expect(parsed.counts.get("epic;to do")).toBe(4);
    expect(parsed.estimate).toEqual([1170, 229, 941]);
    expect(parsed.estimatedByType?.get("story")).toBe(309);
    expect(parsed.unestimatedByType?.get("story")).toBe(61);
    const grade = gradeProgress(answer, humanTableTruth());
    expect(grade.counts).toMatchObject({ graded: true, ok: true });
    expect(grade.estimate).toMatchObject({ graded: true, ok: true });
    expect(grade.estimated).toMatchObject({ graded: true, ok: true });
    expect(grade.unestimated).toMatchObject({ graded: true, ok: true });
    expect(grade.conflicts).toBe(0);
  });

  it.each(["de", "en"])("rejects global 65 in the %s Story unestimated table cell", (locale) => {
    const answer = renderHumanTables(humanTables(locale, { unestimated: "65" }), "markdown");
    const parsed = parseProgressAnswer(answer);
    expect(parsed.unestimatedByType?.get("story")).toBe(65);
    const grade = gradeProgress(answer, humanTableTruth());
    expect(grade.counts).toMatchObject({ ok: true });
    expect(grade.estimate).toMatchObject({ ok: true });
    expect(grade.unestimated).toMatchObject({ graded: true, ok: false });
  });

  it.each(["de", "en"])(
    "checks the %s row total instead of ignoring 371 beside 370 statuses",
    (locale) => {
      const answer = renderHumanTables(humanTables(locale, { total: "371" }), "tabs");
      expect(gradeProgress(answer, humanTableTruth()).counts).toMatchObject({
        graded: true,
        ok: false,
      });
    },
  );

  it("refuses duplicate status headers rather than assigning their numbers by position", () => {
    const tables = humanTables("de");
    tables[0][0] = ["Vorgangstyp", "Done", "In Progress", "Done", "Gesamt"];
    const answer = renderHumanTables(tables, "markdown");
    expect(gradeProgress(answer, humanTableTruth()).counts).toMatchObject({
      graded: true,
      ok: false,
    });
  });

  it("does not guess estimate meanings from an unlabeled sequence of the correct numbers", () => {
    const tables = humanTables("de");
    tables[1][0] = ["Kennzahl", "A", "B", "C"];
    const answer = renderHumanTables(tables, "tabs");
    expect(gradeProgress(answer, humanTableTruth()).estimate).toMatchObject({
      graded: true,
      ok: false,
    });
  });

  it("rejects decimal counts in natural status and missing-estimate columns", () => {
    const answer = renderHumanTables(
      humanTables("de", { done: "74,5", unestimated: "61,0" }),
      "markdown",
    );
    const grade = gradeProgress(answer, humanTableTruth());
    expect(grade.counts).toMatchObject({ graded: true, ok: false });
    expect(grade.unestimated).toMatchObject({ graded: true, ok: false });
  });
});
