// The S10 estimate oracle derives its expectation from native data by the product's rule (#4369):
// configured field when it holds values; a labelled fallback when only the other field does; both;
// neither. Both directions, through the journey's real entry point.
import { describe, expect, it } from "vitest";
import {
  ESTIMATE_RULE_PROMPT,
  TIME_FIELD,
  configuredEstimateField,
  deriveEstimate,
  estimateDescriptor,
  gradeEstimateRule,
  storyPointsFieldId,
} from "../testing/jira-chat-lab/requirements/estimate-rule.mjs";
import { JOURNEYS } from "../testing/jira-chat-lab/requirements/journey-checks.mjs";
import { SCENARIOS } from "../testing/jira-chat-lab/requirements/catalog.mjs";

const POINTS = "customfield_10111";
const LINK = "customfield_10109";
const FIELDS = { epicLink: LINK, storyPoints: POINTS };
const CATEGORY = { "To Do": "new", "In Progress": "indeterminate", Done: "done" };
const issue = (key, type, status, fields = {}) => ({
  key,
  fields: {
    issuetype: { name: type },
    status: { name: status, statusCategory: { key: CATEGORY[status] } },
    summary: key,
    labels: [],
    ...fields,
  },
});
const HOUR = 3600;

describe("deriveEstimate", () => {
  const rows = (...values) =>
    values.map(([points, seconds]) => ({ fields: { [POINTS]: points, [TIME_FIELD]: seconds } }));
  const derive = (issues, configured = POINTS) =>
    deriveEstimate({ issues, configured, storyPoints: POINTS });

  it("uses the configured field when it holds values", () => {
    expect(derive(rows([2, null], [3, null]))).toMatchObject({
      case: "configured",
      figureField: POINTS,
      configuredUnused: false,
      other: undefined,
    });
  });

  it("falls back to the other field when the configured one holds no value, and says it is unused", () => {
    expect(derive(rows([null, 3 * HOUR], [null, 2 * HOUR]))).toMatchObject({
      case: "fallback",
      figureField: TIME_FIELD,
      configured: POINTS,
      configuredUnused: true,
    });
  });

  it("falls back the other way round when the board estimates with time", () => {
    expect(derive(rows([2, null], [5, null]), TIME_FIELD)).toMatchObject({
      case: "fallback",
      figureField: POINTS,
      configuredUnused: true,
    });
  });

  it("keeps the configured field and names the other field's count and sum when both hold values", () => {
    expect(derive(rows([2, 3 * HOUR], [3, null], [null, 5 * HOUR]))).toMatchObject({
      case: "both",
      figureField: POINTS,
      other: { fieldId: TIME_FIELD, label: "Original Estimate", count: 2, sum: 8 },
    });
  });

  it("is zero of N when neither field holds a value; a numeric zero is a value", () => {
    expect(derive(rows([null, null], [null, null]))).toMatchObject({
      case: "neither",
      figureField: POINTS,
      configuredUnused: false,
    });
    expect(derive(rows([0, null])).case).toBe("configured");
  });

  it("has no second field when Story Points is ambiguous or absent: the configured time field still decides", () => {
    const issues = rows([null, 7200]);
    expect(
      deriveEstimate({ issues, configured: TIME_FIELD, storyPoints: undefined }),
    ).toMatchObject({
      case: "configured",
      other: undefined,
    });
    expect(
      deriveEstimate({ issues: rows([null, null]), configured: TIME_FIELD, storyPoints: undefined })
        .case,
    ).toBe("neither");
  });

  it("describes the figure's field, unit and label", () => {
    expect(estimateDescriptor(derive(rows([null, 3600])))).toEqual({
      fieldId: TIME_FIELD,
      writeFieldId: TIME_FIELD,
      unit: "seconds",
      label: "Original Estimate",
    });
  });
});

describe("native facts", () => {
  it("finds the unique numeric Story Points field by schema, not by id", () => {
    const float = "com.atlassian.jira.plugin.system.customfieldtypes:float";
    expect(
      storyPointsFieldId([
        { id: "a", name: "Story Points", schema: { custom: float } },
        { id: "b", name: "Other", schema: { custom: float } },
      ]),
    ).toBe("a");
    expect(
      storyPointsFieldId([
        { id: "a", name: "Story Points", schema: { custom: float } },
        { id: "c", name: "Story Points", schema: { custom: float } },
      ]),
    ).toBeUndefined();
    expect(storyPointsFieldId(undefined)).toBeUndefined();
  });

  it("reads the board's configured estimation field", async () => {
    const answers = {
      "/rest/agile/1.0/board?projectKeyOrId=RPT": { values: [{ id: 4 }] },
      "/rest/agile/1.0/board/4/configuration": { estimation: { field: { fieldId: TIME_FIELD } } },
    };
    expect(await configuredEstimateField(async (path) => answers[path], "RPT")).toBe(TIME_FIELD);
    expect(await configuredEstimateField(async () => ({ values: [] }), "RPT")).toBeUndefined();
  });
});

describe("gradeEstimateRule", () => {
  const derivedOf = (issues, configured = POINTS) =>
    deriveEstimate({ issues, configured, storyPoints: POINTS });
  const fallback = derivedOf([{ fields: { [POINTS]: null, [TIME_FIELD]: 3 * HOUR } }]);
  const both = derivedOf([
    { fields: { [POINTS]: 2, [TIME_FIELD]: 3 * HOUR } },
    { fields: { [POINTS]: null, [TIME_FIELD]: 2 * HOUR } },
  ]);
  const plain = derivedOf([{ fields: { [POINTS]: 2, [TIME_FIELD]: null } }]);

  it("grades a correct fallback answer green on all three statements", () => {
    const answer = "QUELLE;Original Estimate;ERSATZ\nUNGENUTZT;Story Points";
    const grade = gradeEstimateRule(answer, fallback);
    expect([grade.source.ok, grade.unused.ok, grade.other.ok]).toEqual([true, true, true]);
  });

  it.each([
    [
      "labels the fallback as configured",
      "QUELLE;Original Estimate;KONFIGURIERT\nUNGENUTZT;Story Points",
      "source",
    ],
    [
      "names the wrong source field",
      "QUELLE;Story Points;ERSATZ\nUNGENUTZT;Story Points",
      "source",
    ],
    ["omits the unused statement", "QUELLE;Original Estimate;ERSATZ", "unused"],
    [
      "claims a second field that holds nothing",
      "QUELLE;Original Estimate;ERSATZ\nUNGENUTZT;Story Points\nWEITERES;Story Points;1;1",
      "other",
    ],
  ])("grades red when the answer %s", (_name, answer, statement) => {
    expect(gradeEstimateRule(answer, fallback)[statement].ok).toBe(false);
  });

  it("requires the second field's exact count and sum when both hold values", () => {
    const ok = gradeEstimateRule(
      "QUELLE;Story Points;KONFIGURIERT\nWEITERES;Original Estimate;2;5",
      both,
    );
    expect(ok.other.ok).toBe(true);
    expect(
      gradeEstimateRule("QUELLE;Story Points;KONFIGURIERT\nWEITERES;Original Estimate;2;6", both)
        .other.ok,
    ).toBe(false);
    expect(gradeEstimateRule("QUELLE;Story Points;KONFIGURIERT", both).other.ok).toBe(false);
  });

  it("flags an unused claim for a configured field that holds values, and reads TAB and German rows", () => {
    expect(
      gradeEstimateRule("QUELLE;Story Points;KONFIGURIERT\nUNGENUTZT;Story Points", plain).unused
        .ok,
    ).toBe(false);
    expect(
      gradeEstimateRule("QUELLE\tOriginal Estimate\tERSATZ\nUNGENUTZT\tStory Points", fallback)
        .source.ok,
    ).toBe(true);
    const german = deriveEstimate({
      issues: [{ fields: { [POINTS]: 2, [TIME_FIELD]: 1_080_000 } }],
      configured: POINTS,
      storyPoints: POINTS,
    });
    expect(
      gradeEstimateRule(
        "QUELLE;Story Points;KONFIGURIERT\nWEITERES;Original Estimate;1;300",
        german,
      ).other.ok,
    ).toBe(true);
  });
});

describe("S10 against the native rule, through the journey", () => {
  const NATIVE_FIELDS = [
    {
      id: POINTS,
      name: "Story Points",
      schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" },
    },
  ];
  const nativeOf = (configured) => async (path) => {
    if (path === "/rest/api/2/field") return NATIVE_FIELDS;
    if (path.startsWith("/rest/agile/1.0/board?")) return { values: [{ id: 1 }] };
    return { estimation: { field: { fieldId: configured } } };
  };
  const world = (extra) => [
    issue("RPT-1", "Epic", "To Do"),
    issue("RPT-3", "Task", "Done", { [LINK]: "RPT-1", ...extra(3) }),
    issue("RPT-4", "Task", "In Progress", { [LINK]: "RPT-1", ...extra(2) }),
  ];
  const BASE = [
    "ANZAHL;Epic;To Do;1",
    "ANZAHL;Task;Done;1",
    "ANZAHL;Task;In Progress;1",
    "EPIC;RPT-1;2;1",
  ];
  const run = (issues, configured, answer, prompts = []) =>
    JOURNEYS.S10(
      {
        truth: { fieldIds: { ...FIELDS, storyPoints: TIME_FIELD }, issues: [] },
        refusals: () => 0,
        nativeGet: nativeOf(configured),
        search: async (query) => (/project = RPT/u.test(query) ? issues : []),
        turn: async (_chat, content) => {
          prompts.push(content);
          return {
            answer,
            toolExchanges: [],
            failure: undefined,
            durationMs: 1000,
            toolCalls: 0,
            approvals: { writes: 0 },
          };
        },
        deselectSkill: async () => undefined,
      },
      { id: "chat", jiraPodBinding: { podId: "pod-1" } },
    );
  const timeOnly = world((n) => ({ [TIME_FIELD]: n * HOUR }));
  const pointsOnly = world((n) => ({ [POINTS]: n }));
  const bothFields = world((n) => ({ [POINTS]: n, [TIME_FIELD]: n * HOUR }));
  const neither = world(() => ({}));

  it("is unverified, never green, when the native estimate facts cannot be read, and names why", async () => {
    // A figure the old truth-file estimate would have graded green must not be credited.
    const answer = [...BASE, "SCHÄTZUNG;5;3;2"].join("\n");
    const graded = (overrides) =>
      JOURNEYS.S10(
        {
          truth: { fieldIds: { ...FIELDS, storyPoints: TIME_FIELD }, issues: [], estimate: 5 },
          refusals: () => 0,
          search: async (query) => (/project = RPT/u.test(query) ? timeOnly : []),
          turn: async () => ({
            answer,
            toolExchanges: [],
            failure: undefined,
            durationMs: 1000,
            toolCalls: 0,
            approvals: { writes: 0 },
          }),
          deselectSkill: async () => undefined,
          ...overrides,
        },
        { id: "chat", jiraPodBinding: { podId: "pod-1" } },
      );
    const withoutReader = await graded({});
    expect(withoutReader.detail).toContain("estimate rule: unverified");
    expect(withoutReader.detail).toContain("no native Jira reader");
    for (const name of ["estimate-totals", "estimate-source-labelled", "configured-unused-stated"])
      expect(withoutReader.covers).not.toContain(name);
    // A board without an estimation field is the same gap, with its own reason.
    const noBoard = await graded({
      nativeGet: async (path) => (path === "/rest/api/2/field" ? NATIVE_FIELDS : { values: [] }),
    });
    expect(noBoard.detail).toContain("reports no configured estimation field");
    expect(noBoard.covers).not.toContain("estimate-totals");
  });

  it("neither: an unused-field statement naming the configured field is accepted, any other is red", async () => {
    const base = [...BASE, "SCHÄTZUNG;0;0;0", "QUELLE;Story Points;KONFIGURIERT"];
    expect((await run(neither, POINTS, base.join("\n"))).status).toBe("green");
    expect(
      (await run(neither, POINTS, [...base, "UNGENUTZT;Story Points"].join("\n"))).status,
    ).toBe("green");
    expect(
      (await run(neither, POINTS, [...base, "UNGENUTZT;Original Estimate"].join("\n"))).status,
    ).toBe("red");
  });

  it("states the unit of the WEITERES sum and asks for a bare number", () => {
    const line = ESTIMATE_RULE_PROMPT.find((entry) => entry.startsWith("WEITERES;"));
    expect(line).toContain("Stunden");
    expect(line).toContain("Punkten");
    // The S10 prompt of a time-tracking project must not mention the other field by name.
    expect(line).not.toContain("Story Points");
    expect(line).toContain("ohne Einheit");
  });

  it("reads the time field's WEITERES sum as hours, not seconds, and refuses a unit inside the cell", async () => {
    const hours = [
      ...BASE,
      "SCHÄTZUNG;5;3;2",
      "QUELLE;Story Points;KONFIGURIERT",
      "WEITERES;Original Estimate;2;5",
    ];
    expect((await run(bothFields, POINTS, hours.join("\n"))).status).toBe("green");
    const seconds = hours.slice(0, -1).concat("WEITERES;Original Estimate;2;18000");
    expect((await run(bothFields, POINTS, seconds.join("\n"))).status).toBe("red");
    const withUnit = hours.slice(0, -1).concat("WEITERES;Original Estimate;2;5 h");
    expect((await run(bothFields, POINTS, withUnit.join("\n"))).status).toBe("red");
  });

  it("asks for the statements of the rule, not for a field by name", async () => {
    const prompts = [];
    await run(timeOnly, POINTS, "", prompts);
    for (const line of ESTIMATE_RULE_PROMPT) expect(prompts[0]).toContain(line);
    expect(prompts[0]).toContain("SCHÄTZUNG;");
  });

  it("fallback (board Story Points, values in time tracking): green with the labelled source and the unused statement", async () => {
    const answer = [
      ...BASE,
      "SCHÄTZUNG;5;3;2",
      "QUELLE;Original Estimate;ERSATZ",
      "UNGENUTZT;Story Points",
    ].join("\n");
    const check = await run(timeOnly, POINTS, answer);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(
      expect.arrayContaining([
        "estimate-totals",
        "estimate-source-labelled",
        "configured-unused-stated",
        "other-estimate-field-named",
      ]),
    );
  });

  it("fallback: red when the answer reports the configured field's zero, the S10 failure of 2026-11-13", async () => {
    const answer = [...BASE, "SCHÄTZUNG;0;0;0", "QUELLE;Story Points;KONFIGURIERT"].join("\n");
    const check = await run(timeOnly, POINTS, answer);
    expect(check.status).toBe("red");
  });

  it("fallback: red when the figure is right but the source is not labelled or the unused statement is missing", async () => {
    const bare = [...BASE, "SCHÄTZUNG;5;3;2"].join("\n");
    expect((await run(timeOnly, POINTS, bare)).status).toBe("red");
  });

  it("reverse (board time tracking, values in Story Points): the points are the labelled fallback", async () => {
    const answer = [
      ...BASE,
      "SCHÄTZUNG;5;3;2",
      "QUELLE;Story Points;ERSATZ",
      `UNGENUTZT;Original Estimate`,
    ].join("\n");
    expect((await run(pointsOnly, TIME_FIELD, answer)).status).toBe("green");
  });

  it("both: the configured field is the figure and one line names the other field", async () => {
    const answer = [
      ...BASE,
      "SCHÄTZUNG;5;3;2",
      "QUELLE;Story Points;KONFIGURIERT",
      "WEITERES;Original Estimate;2;5",
    ].join("\n");
    expect((await run(bothFields, POINTS, answer)).status).toBe("green");
    const missing = [...BASE, "SCHÄTZUNG;5;3;2", "QUELLE;Story Points;KONFIGURIERT"].join("\n");
    expect((await run(bothFields, POINTS, missing)).status).toBe("red");
  });

  it("neither: zero of N, labelled as the configured field, with no unused claim", async () => {
    const answer = [...BASE, "SCHÄTZUNG;0;0;0", "QUELLE;Story Points;KONFIGURIERT"].join("\n");
    expect((await run(neither, POINTS, answer)).status).toBe("green");
  });

  it("S10 names the three statements as obligations of the scenario", () => {
    const obligations = SCENARIOS.find((entry) => entry.id === "S10").obligations;
    for (const name of [
      "estimate-source-labelled",
      "configured-unused-stated",
      "other-estimate-field-named",
    ])
      expect(obligations).toContain(name);
  });
});

describe("the four estimate-case fixtures", () => {
  it("plans fixtures whose values sit where the case says", async () => {
    const { ESTIMATE_CASE_PROJECTS, estimateCasePlan } =
      await import("../testing/jira-chat-lab/requirements/seed-estimate-cases.mjs");
    const holds = (key, field) =>
      estimateCasePlan(key, POINTS).filter((item) => item.fields[field] !== undefined).length;
    const time = (key) =>
      estimateCasePlan(key, POINTS).filter((item) => item.fields.timetracking !== undefined).length;
    expect(Object.keys(ESTIMATE_CASE_PROJECTS)).toEqual(["ESF", "ESR", "ESB", "ESN"]);
    expect([holds("ESF", POINTS), time("ESF")]).toEqual([0, 3]);
    expect([holds("ESR", POINTS), time("ESR")]).toEqual([3, 0]);
    expect([holds("ESB", POINTS), time("ESB")]).toEqual([2, 1]);
    expect([holds("ESN", POINTS), time("ESN")]).toEqual([0, 0]);
    expect(ESTIMATE_CASE_PROJECTS.ESR.board).toBe("time");
    expect(ESTIMATE_CASE_PROJECTS.ESF.expected).toBe("fallback");
  });
});
