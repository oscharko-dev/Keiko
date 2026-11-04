// The lab step that gives the report project a real estimate (#4174, S10), against a fake Jira:
// discovery by schema, the board-configuration fallback, screens, the story-points / time-tracking
// choice, writes and the truth.
import { describe, expect, it } from "vitest";
import {
  discoverEstimateField,
  ensureOnScreens,
  expectedEstimates,
  seedEstimates,
  syncTruth,
  TIME_TRACKING,
} from "../testing/jira-chat-lab/requirements/estimate-field.mjs";

const JSW = "com.pyxis.greenhopper.jira:jsw-story-points";
const FLOAT = "com.atlassian.jira.plugin.system.customfieldtypes:float";
const POINTS = "customfield_10106";
const HOUR = 3600;

const numberField = (id, custom, name = "Whatever") => ({
  id,
  name,
  custom: true,
  schema: { type: "number", custom },
});

const hoursToSeconds = (text) => (text === "" ? null : Number(/^(\d+)h$/.exec(text)[1]) * HOUR);

/** A fake Jira Data Center holding one project, its screens and its Tasks. */
function fakeJira({
  fields,
  board,
  taskCount = 26,
  onScreen = false,
  screensListed = true,
  pointsOnTask = true,
  timeTracking = true,
}) {
  const state = {
    fields,
    screenFields: new Map([
      [1, onScreen ? ["summary", POINTS] : ["summary"]],
      [2, ["summary"]],
      [3, ["resolution"]],
    ]),
    estimates: new Map(Array.from({ length: taskCount }, (_, i) => [`RPT-${i + 1}`, null])),
    seconds: new Map(Array.from({ length: taskCount }, (_, i) => [`RPT-${i + 1}`, null])),
    writes: [],
    posts: [],
  };
  const screens = [
    { id: 1, name: "RPT: Scrum Default Issue Screen" },
    { id: 2, name: "RPT: Scrum Bug Screen" },
    { id: 3, name: "RPT: Workflow Screen" },
    { id: 4, name: "Default Screen" },
  ];
  // Jira offers a field when a screen holds it and its context (story points) or the instance
  // setting (time tracking) allows it on Task.
  const allowed = { [POINTS]: pointsOnTask, timetracking: timeTracking };
  const offered = (id) =>
    allowed[id] !== false && [...state.screenFields.values()].some((ids) => ids.includes(id));
  const offeredFields = () => [POINTS, "timetracking"].filter(offered);
  const tabFields = (m) => state.screenFields.get(Number(m[1]));
  const routes = [
    ["GET", /^\/rest\/api\/2\/field$/, () => [200, state.fields]],
    [
      "GET",
      /^\/rest\/agile\/1\.0\/board\?/,
      () => (board === undefined ? [404, undefined] : [200, { values: [{ id: 7 }] }]),
    ],
    [
      "GET",
      /^\/rest\/agile\/1\.0\/board\/7\/configuration$/,
      () => [200, { estimation: { type: "field", field: { fieldId: board } } }],
    ],
    ["GET", /createmeta\/RPT\/issuetypes$/, () => [200, { values: [{ id: "1", name: "Task" }] }]],
    [
      "GET",
      /createmeta\/RPT\/issuetypes\/1\?/,
      () => [
        200,
        { values: [{ fieldId: "summary" }, ...offeredFields().map((fieldId) => ({ fieldId }))] },
      ],
    ],
    [
      "GET",
      /\/editmeta$/,
      () => [
        200,
        { fields: Object.fromEntries(["summary", ...offeredFields()].map((id) => [id, {}])) },
      ],
    ],
    ["GET", /^\/rest\/api\/2\/screens$/, () => (screensListed ? [200, screens] : [404])],
    ["GET", /\/screens\/(\d+)\/tabs$/, (m) => [200, [{ id: 10 * Number(m[1]) }]]],
    [
      "GET",
      /\/screens\/(\d+)\/tabs\/\d+\/fields$/,
      (m) => [200, tabFields(m).map((id) => ({ id }))],
    ],
    [
      "POST",
      /\/screens\/(\d+)\/tabs\/\d+\/fields$/,
      (m, body) => {
        state.posts.push(Number(m[1]));
        tabFields(m).push(body.fieldId);
        return [200, {}];
      },
    ],
    [
      "POST",
      /\/screens\/addToDefault\/\w+/,
      (m) => {
        state.posts.push("default");
        state.screenFields.get(1).push(/addToDefault\/(\w+)/.exec(m[0])[1]);
        return [200];
      },
    ],
    [
      "GET",
      /\/search\?.*startAt=(\d+)/,
      (m) => {
        const field = /fields=(\w+)/.exec(m[0])[1];
        const values = field === POINTS ? state.estimates : state.seconds;
        const keys = [...values.keys()];
        const issues = keys.slice(Number(m[1]), Number(m[1]) + 100).map((key) => ({
          key,
          fields: { [field]: values.get(key) },
        }));
        return [200, { issues, total: keys.length }];
      },
    ],
    [
      "PUT",
      /\/issue\/(RPT-\d+)$/,
      (m, body) => {
        state.writes.push(m[1]);
        const { timetracking } = body.fields;
        if (timetracking === undefined) state.estimates.set(m[1], body.fields[POINTS]);
        else state.seconds.set(m[1], hoursToSeconds(timetracking.originalEstimate));
        return [204];
      },
    ],
  ];
  const request = async (method, path, body) => {
    for (const [routeMethod, pattern, handle] of routes) {
      const match = routeMethod === method ? pattern.exec(path) : null;
      if (match) {
        const [status, value] = handle(match, body);
        return { status, value };
      }
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const call = async (_name, method, path, body, expected = [200, 201, 204]) => {
    const result = await request(method, path, body);
    if (!expected.includes(result.status)) throw new TypeError("Laboratory API rejected");
    return result.value;
  };
  return { jira: { call, request }, state };
}

const truthFor = (taskCount = 26, extra = {}) => ({
  schemaVersion: 1,
  projects: { work: "REQ", report: "RPT" },
  fieldIds: { epicName: "customfield_10104", epicLink: "customfield_10105", ...extra },
  issues: [
    { type: "Epic", key: "RPT-900", deviations: ["summary"] },
    ...Array.from({ length: taskCount }, (_, i) => ({
      type: "Task",
      key: `RPT-${i + 1}`,
      points: ((i + 1) % 5) + 1,
      deviations: (i + 1) % 11 === 0 ? ["parent"] : [],
    })),
  ],
});

const discard = () => undefined;
const storyPoints = numberField(POINTS, JSW, "Story Points");
const unrelated = numberField("customfield_10200", FLOAT, "Budget");

describe("estimate field discovery", () => {
  it("finds the field by the Jira Software story-points type, whatever it is called", async () => {
    const { jira } = fakeJira({
      fields: [unrelated, numberField(POINTS, JSW, "Aufwand"), { id: "summary", schema: {} }],
    });
    expect(await discoverEstimateField(jira, "RPT")).toMatchObject({
      id: POINTS,
      name: "Aufwand",
      source: "custom-type",
    });
  });

  it("falls back to the estimation field the board is configured with", async () => {
    const { jira } = fakeJira({
      fields: [unrelated, numberField(POINTS, FLOAT, "Story Points")],
      board: POINTS,
    });
    expect(await discoverEstimateField(jira, "RPT")).toMatchObject({
      id: POINTS,
      source: "board-estimation",
    });
  });

  it("does not take a board estimation field that is not numeric", async () => {
    const { jira } = fakeJira({
      fields: [{ id: POINTS, name: "Sprint", schema: { type: "array" } }],
      board: POINTS,
    });
    expect(await discoverEstimateField(jira, "RPT")).toBeUndefined();
  });

  it("returns nothing when the instance has no estimate field at all", async () => {
    const { jira } = fakeJira({ fields: [unrelated] });
    expect(await discoverEstimateField(jira, "RPT")).toBeUndefined();
  });

  it("lets the board decide between two story-points fields and refuses to guess otherwise", async () => {
    const second = numberField("customfield_10107", JSW, "Story Points (2)");
    const decided = fakeJira({ fields: [storyPoints, second], board: POINTS });
    expect(await discoverEstimateField(decided.jira, "RPT")).toMatchObject({
      id: POINTS,
      source: "custom-type",
    });
    const open = fakeJira({ fields: [storyPoints, second] });
    await expect(discoverEstimateField(open.jira, "RPT")).rejects.toThrow(/cannot choose/);
  });
});

describe("estimate screens", () => {
  it("adds the field to the project's issue screens only", async () => {
    const { jira, state } = fakeJira({ fields: [storyPoints] });
    expect(await ensureOnScreens(jira, "RPT", POINTS)).toEqual({
      added: 2,
      present: 0,
      viaDefault: false,
    });
    expect(state.posts).toEqual([1, 2]);
    expect(state.screenFields.get(3)).toEqual(["resolution"]);
  });

  it("leaves a screen that already holds the field alone", async () => {
    const { jira, state } = fakeJira({ fields: [storyPoints], onScreen: true });
    expect(await ensureOnScreens(jira, "RPT", POINTS)).toEqual({
      added: 1,
      present: 1,
      viaDefault: false,
    });
    expect(state.posts).toEqual([2]);
  });

  it("uses the default screen when the instance cannot list screens", async () => {
    const { jira, state } = fakeJira({ fields: [storyPoints], screensListed: false });
    expect((await ensureOnScreens(jira, "RPT", POINTS)).viaDefault).toBe(true);
    expect(state.posts).toEqual(["default"]);
  });
});

const save = () => {
  let saved;
  return { keep: (truth) => (saved = truth), get: () => saved };
};
const deviationsOf = (truth, key) => truth.issues.find((issue) => issue.key === key).deviations;

describe("seeding the estimates with story points", () => {
  it("uses story points when Jira offers them on Task and records the deviations", async () => {
    const { jira, state } = fakeJira({ fields: [storyPoints] });
    const out = save();
    const summary = await seedEstimates(jira, truthFor(26), out.keep);
    expect(summary).toMatchObject({ written: 24, tasks: 26, unestimated: 2 });
    expect(summary.estimate).toMatchObject({ fieldId: POINTS, unit: "points" });
    expect(state.estimates.get("RPT-1")).toBe(2);
    expect(state.estimates.get("RPT-13")).toBeNull();
    expect(state.estimates.get("RPT-26")).toBeNull();
    expect(state.seconds.get("RPT-1")).toBeNull();
    const saved = out.get();
    expect(saved.fieldIds).toEqual({
      epicName: "customfield_10104",
      epicLink: "customfield_10105",
      storyPoints: POINTS,
    });
    expect(saved.estimate).toEqual({
      fieldId: POINTS,
      writeFieldId: POINTS,
      unit: "points",
      label: "Story Points",
    });
    expect(deviationsOf(saved, "RPT-13")).toEqual(["estimate"]);
    expect(deviationsOf(saved, "RPT-11")).toEqual(["parent"]);
    expect(deviationsOf(saved, "RPT-1")).toEqual([]);
    expect(saved.issues[0]).toEqual({ type: "Epic", key: "RPT-900", deviations: ["summary"] });
  });

  it("is idempotent: a second run writes and adds nothing and saves the same truth", async () => {
    const { jira, state } = fakeJira({ fields: [storyPoints] });
    const first = save();
    await seedEstimates(jira, truthFor(26), first.keep);
    state.writes.length = 0;
    state.posts.length = 0;
    const second = save();
    const summary = await seedEstimates(jira, first.get(), second.keep);
    expect(summary.written).toBe(0);
    expect(state.writes).toEqual([]);
    expect(state.posts).toEqual([]);
    expect(second.get()).toEqual(first.get());
  });

  it("changes nothing on screens when the field is already offered", async () => {
    const { jira, state } = fakeJira({ fields: [storyPoints], onScreen: true });
    state.screenFields.set(2, ["summary", POINTS]);
    const summary = await seedEstimates(jira, truthFor(26), discard);
    expect(state.posts).toEqual([]);
    expect(summary.screens).toEqual({ added: 0, present: 0, viaDefault: false });
  });

  it("repairs an estimate that drifted in Jira", async () => {
    const { jira, state } = fakeJira({ fields: [storyPoints] });
    const first = save();
    await seedEstimates(jira, truthFor(26), first.keep);
    state.estimates.set("RPT-2", 99);
    state.estimates.set("RPT-13", 4);
    state.writes.length = 0;
    await seedEstimates(jira, first.get(), discard);
    expect(state.writes).toEqual(["RPT-2", "RPT-13"]);
    expect(state.estimates.get("RPT-2")).toBe(3);
    expect(state.estimates.get("RPT-13")).toBeNull();
  });

  it("refuses a truth file that records another estimate field", async () => {
    const { jira } = fakeJira({ fields: [storyPoints] });
    await expect(
      seedEstimates(jira, truthFor(26, { storyPoints: "customfield_99999" }), discard),
    ).rejects.toThrow(/different estimate field/);
  });

  it("refuses a truth Task that breaks the seed estimate rule", () => {
    const truth = truthFor(3);
    truth.issues[1].points = 9;
    expect(() => expectedEstimates(truth, TIME_TRACKING)).toThrow(/seed estimate rule/);
  });
});

describe("seeding the estimates with time tracking", () => {
  it("falls back to Original Estimate when story points are not offered on Task", async () => {
    const { jira, state } = fakeJira({ fields: [storyPoints], pointsOnTask: false });
    const out = save();
    const summary = await seedEstimates(jira, truthFor(26), out.keep);
    expect(summary.estimate).toMatchObject({ fieldId: "timeoriginalestimate", unit: "seconds" });
    expect(summary).toMatchObject({ written: 24, tasks: 26, unestimated: 2 });
    expect(state.seconds.get("RPT-1")).toBe(2 * HOUR);
    expect(state.seconds.get("RPT-4")).toBe(5 * HOUR);
    expect(state.seconds.get("RPT-13")).toBeNull();
    expect(state.estimates.get("RPT-1")).toBeNull();
    const saved = out.get();
    expect(saved.fieldIds.storyPoints).toBe("timeoriginalestimate");
    expect(saved.estimate).toEqual({
      fieldId: "timeoriginalestimate",
      writeFieldId: "timetracking",
      unit: "seconds",
      label: "Original Estimate",
    });
    expect(deviationsOf(saved, "RPT-13")).toEqual(["estimate"]);
    expect(deviationsOf(saved, "RPT-26")).toEqual(["estimate"]);
    expect(deviationsOf(saved, "RPT-1")).toEqual([]);
  });

  it("uses time tracking when the instance has no story-points field at all", async () => {
    const { jira } = fakeJira({ fields: [unrelated] });
    const summary = await seedEstimates(jira, truthFor(26), discard);
    expect(summary.estimate.fieldId).toBe("timeoriginalestimate");
  });

  it("is idempotent and repairs drift, including a cleared estimate", async () => {
    const { jira, state } = fakeJira({ fields: [storyPoints], pointsOnTask: false });
    const first = save();
    await seedEstimates(jira, truthFor(26), first.keep);
    state.writes.length = 0;
    state.posts.length = 0;
    expect((await seedEstimates(jira, first.get(), discard)).written).toBe(0);
    expect([state.writes, state.posts]).toEqual([[], []]);
    state.seconds.set("RPT-2", 99);
    state.seconds.set("RPT-13", 4 * HOUR);
    await seedEstimates(jira, first.get(), discard);
    expect(state.writes).toEqual(["RPT-2", "RPT-13"]);
    expect(state.seconds.get("RPT-2")).toBe(3 * HOUR);
    expect(state.seconds.get("RPT-13")).toBeNull();
  });

  it("fails clearly and saves nothing when time tracking is disabled too", async () => {
    const { jira, state } = fakeJira({
      fields: [storyPoints],
      pointsOnTask: false,
      timeTracking: false,
    });
    const keep = () => {
      throw new Error("must not save");
    };
    await expect(seedEstimates(jira, truthFor(26), keep)).rejects.toThrow(
      /enable time tracking in Jira/,
    );
    expect(state.writes).toEqual([]);
  });
});

describe("estimate truth sync", () => {
  it("derives the estimate deviation from Jira, never from the rule", () => {
    const truth = truthFor(3);
    truth.issues[1].deviations = ["estimate", "parent"];
    const actual = new Map([
      ["RPT-1", 3],
      ["RPT-2", null],
      ["RPT-3", 5],
    ]);
    const target = { fieldId: POINTS, writeFieldId: POINTS, unit: "points", label: "Story Points" };
    const synced = syncTruth(truth, target, actual);
    expect(synced.issues.slice(1).map((issue) => issue.deviations)).toEqual([
      ["parent"],
      ["estimate"],
      [],
    ]);
    expect(synced.fieldIds.storyPoints).toBe(POINTS);
    expect(truth.fieldIds.storyPoints).toBeUndefined();
    expect(truth.estimate).toBeUndefined();
  });
});
