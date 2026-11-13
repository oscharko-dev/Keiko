// The Release 1 lab fixtures (#4369): the estimate-mix project, the parent-field project, the
// fixture inventory and the order that completes a session.
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => []);
vi.mock("../testing/jira-chat-lab/requirements/seed-projects.mjs", () => ({
  ensureProject: vi.fn(),
  bulkCreate: vi.fn(),
  fieldIds: vi.fn(),
  moveTo: vi.fn(),
}));
vi.mock("../testing/jira-chat-lab/seed-fields.mjs", () => ({
  withFixtureFieldOptional: vi.fn((_session, run) => run()),
}));
import {
  estimateMixPlan,
  expectedByType,
  ensureOnProjectScreen,
  findStoryPoints,
  mixTruth,
  offeredEstimateFields,
  readMixTruth,
} from "../testing/jira-chat-lab/requirements/seed-estimate-mix.mjs";
import {
  findParentLink,
  offeredParentFields,
  parentFieldsTruth,
} from "../testing/jira-chat-lab/requirements/seed-parent-fields.mjs";

/** A fake Jira answering the few native reads the fixtures use, keyed by the exact path. */
function jiraOf(answers) {
  return {
    posts: [],
    async call(_name, method, path, body) {
      if (method === "POST") {
        this.posts.push([path, body]);
        return undefined;
      }
      if (!Object.hasOwn(answers, path)) throw new TypeError(`unexpected ${path}`);
      return structuredClone(answers[path]);
    },
  };
}

describe("estimate-mix plan and truth", () => {
  const plan = estimateMixPlan();

  it("plans every shape: points on Epic/Story, time on Bug, nothing on Task/Sub-task", () => {
    expect(expectedByType(plan)).toEqual({
      Epic: { issues: 2, estimated: 0 },
      Story: { issues: 10, estimated: 8, total: 28 },
      Bug: { issues: 6, estimated: 5, totalSeconds: 39_600 },
      Task: { issues: 6, estimated: 0 },
      "Sub-task": { issues: 3, estimated: 0 },
    });
  });

  const offered = {
    Epic: ["story-points"],
    Story: ["story-points"],
    Bug: ["time-tracking"],
    Task: [],
    "Sub-task": [],
  };
  const held = {
    Epic: { issues: 2, points: 0, pointsHeld: 0, seconds: 0, secondsHeld: 0 },
    Story: { issues: 10, points: 28, pointsHeld: 8, seconds: 0, secondsHeld: 0 },
    Bug: { issues: 6, points: 0, pointsHeld: 0, seconds: 39_600, secondsHeld: 5 },
    Task: { issues: 6, points: 0, pointsHeld: 0, seconds: 0, secondsHeld: 0 },
    "Sub-task": { issues: 3, points: 0, pointsHeld: 0, seconds: 0, secondsHeld: 0 },
  };
  const ids = { storyPoints: "customfield_1", epicLink: "customfield_2" };

  it("separates estimated, unestimated and not applicable per type", () => {
    const { types } = mixTruth({ plan, offered, held, ids });
    expect(types.Story).toMatchObject({
      estimated: 8,
      unestimated: 2,
      notApplicable: 0,
      points: 28,
    });
    expect(types.Bug).toMatchObject({ estimated: 5, unestimated: 1, seconds: 39_600 });
    expect(types.Task).toMatchObject({ estimated: 0, unestimated: 0, notApplicable: 6 });
    expect(types.Epic).toMatchObject({ unestimated: 2, notApplicable: 0 });
  });

  it("refuses a project whose screens do not offer exactly the planned estimate", () => {
    expect(() =>
      mixTruth({ plan, offered: { ...offered, Task: ["time-tracking"] }, held, ids }),
    ).toThrow("does not offer exactly");
    expect(() =>
      mixTruth({ plan, offered: { ...offered, Bug: ["story-points"] }, held, ids }),
    ).toThrow("does not offer exactly");
  });

  it("refuses a population Jira does not hold as planned", () => {
    const short = { ...held, Story: { ...held.Story, pointsHeld: 7 } };
    expect(() => mixTruth({ plan, offered, held: short, ids })).toThrow("planned Story");
  });

  it("reads the offered estimate fields per type from create metadata", async () => {
    const base = "/rest/api/2/issue/createmeta/EST/issuetypes";
    const jira = jiraOf({
      [base]: {
        values: [
          { id: "1", name: "Story" },
          { id: "2", name: "Bug" },
          { id: "3", name: "Task" },
        ],
      },
      [`${base}/1?maxResults=200`]: { values: [{ fieldId: "customfield_1" }] },
      [`${base}/2?maxResults=200`]: { values: [{ fieldId: "timetracking" }] },
      [`${base}/3?maxResults=200`]: { values: [{ fieldId: "summary" }] },
    });
    expect(await offeredEstimateFields(jira, "EST", "customfield_1")).toEqual({
      Story: ["story-points"],
      Bug: ["time-tracking"],
      Task: [],
    });
  });

  it("sums points and seconds per type from one native search", async () => {
    const query = (start) =>
      `/rest/api/2/search?jql=project%20%3D%20EST%20ORDER%20BY%20key%20ASC&fields=issuetype,customfield_1,timeoriginalestimate&startAt=${start}&maxResults=100`;
    const jira = jiraOf({
      [query(0)]: {
        total: 3,
        issues: [
          {
            fields: { issuetype: { name: "Story" }, customfield_1: 3, timeoriginalestimate: null },
          },
          {
            fields: {
              issuetype: { name: "Story" },
              customfield_1: null,
              timeoriginalestimate: null,
            },
          },
          {
            fields: { issuetype: { name: "Bug" }, customfield_1: null, timeoriginalestimate: 7200 },
          },
        ],
      },
    });
    expect(await readMixTruth(jira, "EST", { storyPoints: "customfield_1" })).toEqual({
      Story: { issues: 2, points: 3, pointsHeld: 1, seconds: 0, secondsHeld: 0 },
      Bug: { issues: 1, points: 0, pointsHeld: 0, seconds: 7200, secondsHeld: 1 },
    });
  });
});

describe("placing a field on one project screen", () => {
  const screens = [
    { id: 7, name: "EST: Scrum Bug Screen" },
    { id: 8, name: "EST: Scrum Default Issue Screen" },
    { id: 9, name: "OTHER: Scrum Bug Screen" },
  ];
  const tabs = (id, ids) => ({
    [`/rest/api/2/screens/${id}/tabs`]: [{ id: 70 }],
    [`/rest/api/2/screens/${id}/tabs/70/fields`]: ids.map((fieldId) => ({ id: fieldId })),
  });

  it("adds a missing field to the one matching screen of this project only", async () => {
    const jira = jiraOf({ "/rest/api/2/screens": screens, ...tabs(7, ["summary"]) });
    expect(await ensureOnProjectScreen(jira, "EST", "Bug", "timetracking")).toEqual({
      added: true,
    });
    expect(jira.posts).toEqual([
      ["/rest/api/2/screens/7/tabs/70/fields", { fieldId: "timetracking" }],
    ]);
  });

  it("leaves a screen that already holds the field alone", async () => {
    const jira = jiraOf({ "/rest/api/2/screens": screens, ...tabs(7, ["timetracking"]) });
    expect(await ensureOnProjectScreen(jira, "EST", "Bug", "timetracking")).toEqual({
      added: false,
    });
    expect(jira.posts).toEqual([]);
  });

  it("refuses an ambiguous or absent screen instead of guessing", async () => {
    const jira = jiraOf({ "/rest/api/2/screens": screens });
    await expect(ensureOnProjectScreen(jira, "EST", "Scrum", "x")).rejects.toThrow("not unique");
    await expect(ensureOnProjectScreen(jira, "EST", "Missing", "x")).rejects.toThrow("not unique");
  });

  it("finds Story Points by schema and refuses an ambiguous instance", async () => {
    const field = (id, custom, name = "Story Points") => ({ id, name, schema: { custom } });
    const float = "com.atlassian.jira.plugin.system.customfieldtypes:float";
    expect(
      await findStoryPoints(jiraOf({ "/rest/api/2/field": [field("a", float), field("b", "x")] })),
    ).toBe("a");
    await expect(
      findStoryPoints(jiraOf({ "/rest/api/2/field": [field("a", float), field("b", float)] })),
    ).rejects.toThrow("no unique");
  });
});

describe("parent-field project", () => {
  const parent = "com.atlassian.jpo:jpo-custom-field-parent";

  it("finds Parent Link by its schema type and never stands in for a missing one", async () => {
    expect(
      await findParentLink(
        jiraOf({ "/rest/api/2/field": [{ id: "p", schema: { custom: parent } }] }),
      ),
    ).toBe("p");
    await expect(
      findParentLink(
        jiraOf({
          "/rest/api/2/field": [{ id: "t", name: "Parent Link", schema: { custom: "text" } }],
        }),
      ),
    ).rejects.toThrow("no unique Parent Link");
  });

  it("records which types offer both fields side by side and refuses none", async () => {
    const base = "/rest/api/2/issue/createmeta/PAR/issuetypes";
    const jira = jiraOf({
      [base]: {
        values: [
          { id: "1", name: "Task" },
          { id: "2", name: "Bug" },
        ],
      },
      [`${base}/1?maxResults=200`]: { values: [{ fieldId: "e" }, { fieldId: "p" }] },
      [`${base}/2?maxResults=200`]: { values: [{ fieldId: "e" }] },
    });
    const offered = await offeredParentFields(jira, "PAR", { epicLink: "e", parentLink: "p" });
    expect(offered).toEqual({
      Task: { epicLink: true, parentLink: true },
      Bug: { epicLink: true, parentLink: false },
    });
    const ids = { epicLink: "e", parentLink: "p" };
    expect(parentFieldsTruth({ project: "PAR", ids, offered, issues: [] }).sideBySideTypes).toEqual(
      ["Task"],
    );
    expect(() =>
      parentFieldsTruth({ project: "PAR", ids, offered: { Bug: offered.Bug }, issues: [] }),
    ).toThrow("side by side");
  });
});
