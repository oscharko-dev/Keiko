// S20 of the requirements lab (epic #4173, #4176 AC4): Jira's own field error reaches the model and
// its corrected retry succeeds. The grader must credit only a Jira rejection, never Keiko's own
// validation, and only a retry that put the task into the requested sprint after that rejection.
import { describe, expect, it } from "vitest";
import { SCENARIOS } from "../testing/jira-chat-lab/requirements/catalog.mjs";
import {
  gradeFieldCorrection,
  jiraSprintRejection,
  sprintFieldId,
  sprintIdsOf,
} from "../testing/jira-chat-lab/requirements/field-correction.mjs";
import { JOURNEYS } from "../testing/jira-chat-lab/requirements/journey-checks.mjs";

const SPRINT_FIELD = "customfield_10105";
const SPRINT_ID = 7;
const CHAT = { id: "chat" };

const write = (operation, status, data) => ({
  call: { id: `call-${operation}`, name: operation.replace(".", "_"), arguments: {} },
  result: { toolRef: { canonicalId: `keiko.${operation}` }, status, data },
});
const jiraRejection = (message = "Number value expected as the Sprint id.") =>
  write("jira.create", "failed", {
    outcome: "rejected",
    reason: "field-validation",
    messages: [message],
  });
const keikoRejection = () =>
  write("jira.create", "failed", {
    outcome: "rejected",
    reason: "field-validation",
    validation: "invalid-field",
    fieldId: SPRINT_FIELD,
    messages: ["Sprint must be valid JSON. Nothing was changed."],
  });
const created = () => write("jira.create", "completed", { outcome: "succeeded", key: "REQ-9" });
const sprintRead = (id) => [
  `com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=${id},rapidViewId=2,state=FUTURE,name=REQ Lab Sprint]`,
];
const task = (key, sprint) => ({ key, fields: { summary: "Aufgabe", [SPRINT_FIELD]: sprint } });
const tasksOf = (...issues) => ({
  credited: issues,
  created: issues,
  reconciled: [],
  duplicates: [],
});

describe("S20 Jira's field error and the corrected retry", () => {
  it("is catalogued for #4176 with both obligations", () => {
    const scenario = SCENARIOS.find((entry) => entry.id === "S20");
    expect(scenario).toMatchObject({ issue: 4176, requirement: "AC4" });
    expect(scenario.obligations).toEqual(["jira-field-error-returned", "corrected-retry-succeeds"]);
  });

  it("finds the sprint field by its Jira Software schema, never by id or name", () => {
    expect(
      sprintFieldId([
        { fieldId: "customfield_1", name: "Sprint", schema: { type: "string" } },
        {
          fieldId: SPRINT_FIELD,
          name: "Iteration",
          schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" },
        },
      ]),
    ).toBe(SPRINT_FIELD);
    expect(sprintFieldId([{ fieldId: "customfield_1", name: "Sprint" }])).toBeUndefined();
  });

  it.each([
    [sprintRead(7), [7]],
    [[{ id: 7, name: "REQ Lab Sprint" }], [7]],
    [{ id: 8 }, [8]],
    [null, []],
    [undefined, []],
    [["no sprint here"], []],
  ])("reads the sprint ids of %j", (value, ids) => {
    expect(sprintIdsOf(value)).toEqual(ids);
  });

  it("credits Jira's own error, at any depth, but never Keiko's validation", () => {
    expect(jiraSprintRejection([jiraRejection()])).toBe(0);
    expect(jiraSprintRejection([jiraRejection("Sprint doesn't exist.")])).toBe(0);
    expect(
      jiraSprintRejection([
        write("jira.draft", "failed", {
          items: [
            { outcome: "rejected", fieldErrors: [{ fieldId: SPRINT_FIELD, message: "Sprint id" }] },
          ],
        }),
      ]),
    ).toBe(0);
    expect(jiraSprintRejection([keikoRejection()])).toBe(-1);
    expect(jiraSprintRejection([jiraRejection("Summary is required.")])).toBe(-1);
    expect(
      jiraSprintRejection([
        {
          ...jiraRejection(),
          result: { ...jiraRejection().result, toolRef: { canonicalId: "keiko.jira.search" } },
        },
      ]),
    ).toBe(-1);
  });

  it("is green only for a task in the sprint written after Jira's rejection", () => {
    const exchanges = [jiraRejection(), created()];
    expect(
      gradeFieldCorrection({
        tasks: tasksOf(task("REQ-9", sprintRead(SPRINT_ID))),
        exchanges,
        sprintField: SPRINT_FIELD,
        sprintId: SPRINT_ID,
      }),
    ).toEqual({ rejected: true, corrected: true, inSprint: true, key: "REQ-9" });
  });

  it.each([
    ["the task is in another sprint", [jiraRejection(), created()], [task("REQ-9", sprintRead(3))]],
    ["no task was created", [jiraRejection()], []],
    [
      "two tasks were created",
      [jiraRejection(), created()],
      [task("REQ-9", sprintRead(7)), task("REQ-10", sprintRead(7))],
    ],
    [
      "the write completed before the rejection",
      [created(), jiraRejection()],
      [task("REQ-9", sprintRead(7))],
    ],
    ["only Keiko refused the value", [keikoRejection(), created()], [task("REQ-9", sprintRead(7))]],
  ])("is not corrected when %s", (_name, exchanges, issues) => {
    const grade = gradeFieldCorrection({
      tasks: tasksOf(...issues),
      exchanges,
      sprintField: SPRINT_FIELD,
      sprintId: SPRINT_ID,
    });
    expect(grade.corrected).toBe(false);
  });

  describe("journey", () => {
    function context({ exchanges, after }) {
      const calls = { turns: [], deselected: 0 };
      let searches = 0;
      const ctx = {
        labSprint: async () => ({ sprintId: SPRINT_ID, fieldId: SPRINT_FIELD }),
        deselectSkill: async () => {
          calls.deselected += 1;
        },
        search: async () => (searches++ === 0 ? [] : after),
        turn: async (_chat, content) => {
          calls.turns.push(content);
          return { durationMs: 1000, toolCalls: exchanges.length, toolExchanges: exchanges };
        },
      };
      return { ctx, calls };
    }

    it("sends a plain request naming the sprint and its id, without the value shape", async () => {
      const { ctx, calls } = context({
        exchanges: [jiraRejection(), created()],
        after: [task("REQ-9", sprintRead(SPRINT_ID))],
      });
      const check = await JOURNEYS.S20(ctx, CHAT);
      expect(check.status).toBe("green");
      expect(check.covers).toEqual(["jira-field-error-returned", "corrected-retry-succeeds"]);
      expect(calls.deselected).toBe(1);
      expect(calls.turns[0]).toContain(`Sprint-ID ${SPRINT_ID}`);
      expect(calls.turns[0]).not.toMatch(/\[|array|Zahl|number/i);
    });

    it("leaves a correct task without any Jira rejection unverified", async () => {
      const { ctx } = context({
        exchanges: [created()],
        after: [task("REQ-9", sprintRead(SPRINT_ID))],
      });
      expect((await JOURNEYS.S20(ctx, CHAT)).status).toBe("unverified");
    });

    it.each([
      ["a rejection without a corrected retry", [jiraRejection()], []],
      ["no task in the sprint", [created()], [task("REQ-9", null)]],
    ])("is red for %s", async (_name, exchanges, after) => {
      const { ctx } = context({ exchanges, after });
      expect((await JOURNEYS.S20(ctx, CHAT)).status).toBe("red");
    });
  });
});
