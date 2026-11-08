// Saved-filter and Scrum fixtures use the same governed dispatch and independent lab reads.
import assert from "node:assert/strict";
import { basicAuth, labRequest } from "./lab-client.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import { qualificationPropertyCases } from "./api-qualification-property-cases.mjs";
import { proof, read, readRecord } from "./api-qualification-read.mjs";
async function actor(c, f) {
  const a = await read(c, "/rest/api/2/myself");
  assert.equal(a.name, "keiko-admin");
  f.agileActorKey = a.key;
}
const mutation = (tool, args, readback, prepare = actor) => ({
  tool,
  mutation: true,
  arguments: args,
  readback,
  prepare,
});
const filterName = (f) => `Synthetic AC7 agile ${f.runId}`;
const sprintName = (f) => `AC7-${f.runId.slice(0, 26)}`;
const filterPath = (f) => `/rest/api/2/filter/${f.agileFilterId}`;
const boardPath = (f) => `/rest/agile/1.0/board/${f.agileBoardId}`;
const sprintPath = (f) => `/rest/agile/1.0/sprint/${f.agileSprintId}`;
const boardArgs = (f) => ({ boardId: f.agileBoardId });
const sprintArgs = (f) => ({ sprintId: f.agileSprintId });
const issueRows = (value) =>
  value.issues.map((row) => ({ id: row.id, key: row.key, summary: row.fields.summary }));
const issuePage = (tool, path, args) =>
  readCase(tool, path, ["id", "key", "summary"], {
    args: (f) => ({ ...args(f), maxResults: 100 }),
    nativeRoot: issueRows,
  });
async function filter(c, f) {
  await actor(c, f);
  const value = await read(c, filterPath(f));
  assert.equal(String(value.id), f.agileFilterId);
  assert.equal(value.owner.key, f.agileActorKey);
  f.agileFilterReview = {
    filterId: f.agileFilterId,
    expectedOwnerKey: value.owner.key,
    expectedName: value.name,
    expectedJql: value.jql,
    expectedDescription: value.description ?? null,
  };
}
async function board(c, f) {
  await actor(c, f);
  const value = await read(c, `${boardPath(f)}/configuration`);
  assert.equal(String(value.id), f.agileBoardId);
  assert.equal(String(value.filter.id), f.agileFilterId);
  f.agileBoardReview = {
    boardId: f.agileBoardId,
    expectedActorKey: f.agileActorKey,
    expectedBoardName: value.name,
    expectedBoardType: value.type,
    expectedFilterId: String(value.filter.id),
  };
}
const properties = (kind, parent, args) =>
  qualificationPropertyCases({
    name: kind,
    arguments: args,
    parent,
    root: (f) => `${parent(f)}/properties`,
    query: "",
    includeKeys: true,
    actor: "admin",
    administration: true,
  });
const boardProperties = properties("board", boardPath, boardArgs);
const sprintProperties = properties("sprint", sprintPath, sprintArgs);
export const API_QUALIFICATION_AGILE_CASES = [
  mutation(
    "jira.create-filter",
    (f) => ({
      expectedActorKey: f.agileActorKey,
      expectedDefaultShareScope: f.agileDefaultSharing,
      acceptDefaultSharing: true,
      name: filterName(f),
      description: "Synthetic AC7 board filter",
      jql: "project = KEIKO ORDER BY Rank ASC",
    }),
    async (c, d, f) => {
      f.agileFilterId = d.filterId;
      const v = await readRecord(c, f.agileFilterId, filterPath(f));
      assert.equal(v.name, filterName(f));
      assert.equal(v.jql, "project = KEIKO ORDER BY Rank ASC");
      assert.equal(v.owner.key, f.agileActorKey);
      return proof(5);
    },
    async (c, f) => {
      await actor(c, f);
      const v = await read(c, "/rest/api/2/filter/defaultShareScope");
      assert.ok(new Set(["PRIVATE", "AUTHENTICATED", "GLOBAL"]).has(v.scope));
      f.agileDefaultSharing = v.scope;
    },
  ),
  readCase("jira.filter", filterPath, ["id", "name", "jql"], {
    args: (f) => ({ filterId: f.agileFilterId }),
    nativeRoot: "single",
  }),
  mutation(
    "jira.update-filter",
    (f) => ({ ...f.agileFilterReview, description: "Synthetic AC7 board filter revised" }),
    async (c, _d, f) => {
      const v = await read(c, filterPath(f));
      assert.equal(v.name, filterName(f));
      assert.equal(v.description, "Synthetic AC7 board filter revised");
      return proof(2);
    },
    filter,
  ),
  mutation(
    "jira.board-create",
    (f) => ({ name: filterName(f), type: "scrum", filterId: f.agileFilterId }),
    async (c, d, f) => {
      assert.match(d.boardId, /^[1-9][0-9]*$/u);
      f.agileBoardId = d.boardId;
      const v = await read(c, `${boardPath(f)}/configuration`);
      assert.equal(String(v.id), f.agileBoardId);
      assert.equal(v.name, filterName(f));
      assert.equal(v.type, "scrum");
      assert.equal(String(v.filter.id), f.agileFilterId);
      return proof(5);
    },
  ),
  readCase(
    "jira.boards",
    (f) => `/rest/agile/1.0/board?name=${encodeURIComponent(filterName(f))}&maxResults=100`,
    ["id", "name", "type"],
    { args: (f) => ({ name: filterName(f), maxResults: 100 }), nativeRoot: "values" },
  ),
  readCase("jira.board", boardPath, ["id", "name", "type"], {
    args: boardArgs,
    nativeRoot: "single",
  }),
  readCase(
    "jira.board-configuration",
    (f) => `${boardPath(f)}/configuration`,
    ["id", "name", "type", "filterId"],
    { args: boardArgs, nativeRoot: (v) => [{ ...v, filterId: v.filter.id }] },
  ),
  issuePage("jira.board-backlog", (f) => `${boardPath(f)}/backlog?maxResults=100`, boardArgs),
  issuePage("jira.board-issues", (f) => `${boardPath(f)}/issue?maxResults=100`, boardArgs),
  readCase(
    "jira.board-epics",
    (f) => `${boardPath(f)}/epic?maxResults=100`,
    ["id", "key", "name", "done"],
    { args: (f) => ({ ...boardArgs(f), maxResults: 100 }), nativeRoot: "values" },
  ),
  issuePage(
    "jira.board-epicless-issues",
    (f) => `${boardPath(f)}/epic/none/issue?maxResults=100`,
    boardArgs,
  ),
  issuePage(
    "jira.epicless-issues",
    () => "/rest/agile/1.0/epic/none/issue?maxResults=100",
    () => ({}),
  ),
  readCase(
    "jira.board-projects",
    (f) => `${boardPath(f)}/project?maxResults=100`,
    ["id", "key", "name"],
    { args: (f) => ({ ...boardArgs(f), maxResults: 100 }), nativeRoot: "values" },
  ),
  readCase(
    "jira.board-versions",
    (f) => `${boardPath(f)}/version?maxResults=100`,
    ["versionId", "name"],
    {
      args: (f) => ({ ...boardArgs(f), maxResults: 100 }),
      nativeRoot: "values",
      nativeNames: { versionId: "id" },
    },
  ),
  readCase(
    "jira.agile-issue",
    (f) => `/rest/agile/1.0/issue/${f.issueKeys[0]}`,
    ["id", "key", "summary"],
    {
      args: (f) => ({ issueIdOrKey: f.issueKeys[0] }),
      nativeRoot: (v) => issueRows({ issues: [v] }),
    },
  ),
  ...boardProperties,
  mutation(
    "jira.sprint-create",
    (f) => ({ originBoardId: f.agileBoardId, name: sprintName(f), goal: "Synthetic AC7 sprint" }),
    async (c, d, f) => {
      assert.match(d.sprintId, /^[1-9][0-9]*$/u);
      f.agileSprintId = d.sprintId;
      const v = await read(c, sprintPath(f));
      assert.equal(v.name, sprintName(f));
      assert.equal(v.state, "future");
      assert.equal(String(v.originBoardId), f.agileBoardId);
      assert.equal(v.goal, "Synthetic AC7 sprint");
      return proof(5);
    },
  ),
  readCase(
    "jira.sprints",
    (f) => `${boardPath(f)}/sprint?maxResults=100`,
    ["id", "name", "state"],
    { args: (f) => ({ ...boardArgs(f), maxResults: 100 }), nativeRoot: "values" },
  ),
  readCase("jira.sprint", sprintPath, ["id", "name", "state", "originBoardId"], {
    args: sprintArgs,
    nativeRoot: "single",
  }),
  mutation(
    "jira.sprint-update",
    (f) => ({ sprintId: f.agileSprintId, goal: "Synthetic AC7 sprint revised" }),
    async (c, _d, f) => {
      const v = await read(c, sprintPath(f));
      assert.equal(String(v.id), f.agileSprintId);
      assert.equal(v.goal, "Synthetic AC7 sprint revised");
      return proof(2);
    },
  ),
  mutation(
    "jira.sprint-move-issues",
    (f) => ({ sprintId: f.agileSprintId, issues: [f.issueKeys[0]] }),
    async (c, _d, f) => {
      const v = await read(c, `${sprintPath(f)}/issue?maxResults=100`);
      assert.equal(v.total, v.issues.length);
      assert.equal(v.issues.filter((v) => v.key === f.issueKeys[0]).length, 1);
      return proof(2);
    },
  ),
  issuePage("jira.sprint-issues", (f) => `${sprintPath(f)}/issue?maxResults=100`, sprintArgs),
  issuePage(
    "jira.board-sprint-issues",
    (f) => `${boardPath(f)}/sprint/${f.agileSprintId}/issue?maxResults=100`,
    (f) => ({ ...boardArgs(f), ...sprintArgs(f) }),
  ),
  ...sprintProperties,
  mutation(
    "jira.backlog-move-issues",
    (f) => ({ issues: [f.issueKeys[0]] }),
    async (c, _d, f) => {
      const parent = await read(c, sprintPath(f));
      assert.equal(String(parent.id), f.agileSprintId);
      const v = await read(c, `${sprintPath(f)}/issue?maxResults=100`);
      assert.equal(v.total, v.issues.length);
      assert.equal(
        v.issues.some((v) => v.key === f.issueKeys[0]),
        false,
      );
      const issue = await read(c, `/rest/agile/1.0/issue/${f.issueKeys[0]}`);
      assert.equal(issue.key, f.issueKeys[0]);
      const fields = await read(c, "/rest/api/2/field");
      const sprintFields = fields.filter(
        (field) => field.schema?.custom === "com.pyxis.greenhopper.jira:gh-sprint",
      );
      assert.equal(sprintFields.length, 1);
      const core = await read(
        c,
        `/rest/api/2/issue/${f.issueKeys[0]}?fields=${sprintFields[0].id}`,
      );
      assert.equal(core.key, f.issueKeys[0]);
      assert.equal(String(core.id), String(issue.id));
      const value = core.fields[sprintFields[0].id];
      assert.ok(Object.hasOwn(core.fields, sprintFields[0].id));
      assert.ok(value === null || (Array.isArray(value) && value.length === 0));
      return proof(9);
    },
  ),
  readCase(
    "jira.board-refined-velocity",
    (f) => `${boardPath(f)}/settings/refined-velocity`,
    ["value"],
    { args: boardArgs, nativeRoot: "single", productRoot: "single" },
  ),
  mutation(
    "jira.set-board-refined-velocity",
    (f) => ({
      ...f.agileBoardReview,
      expectedValue: f.agileRefinedVelocity,
      value: !f.agileRefinedVelocity,
    }),
    async (c, _d, f) => {
      const v = await read(c, `${boardPath(f)}/settings/refined-velocity`);
      assert.equal(v.value, !f.agileRefinedVelocity);
      return proof(1);
    },
    async (c, f) => {
      await board(c, f);
      const v = await read(c, `${boardPath(f)}/settings/refined-velocity`);
      assert.equal(typeof v.value, "boolean");
      f.agileRefinedVelocity = v.value;
    },
  ),
  mutation(
    "jira.delete-board",
    (f) => f.agileBoardReview,
    async (c, _d, f) => {
      const v = await read(
        c,
        `/rest/agile/1.0/board?name=${encodeURIComponent(filterName(f))}&maxResults=100`,
      );
      assert.equal(v.isLast, true);
      assert.equal(
        v.values.some((v) => String(v.id) === f.agileBoardId),
        false,
      );
      const filter = await read(c, filterPath(f));
      assert.equal(String(filter.id), f.agileFilterId);
      return proof(3);
    },
    board,
  ),
  mutation(
    "jira.delete-filter",
    (f) => f.agileFilterReview,
    async (c, _d, f) => {
      await actor(c, f);
      assert.equal(f.agileFilterReview?.filterId, f.agileFilterId);
      assert.equal(f.agileFilterReview.expectedOwnerKey, f.agileActorKey);
      const r = await labRequest(c.session, "GET", filterPath(f), basicAuth(c.session, c.actor));
      assert.equal(r.status, 404);
      return { matched: true, assertionCount: 4, observedStatus: 404, deletionConfirmed: false };
    },
    filter,
  ),
].map((entry) => ({
  ...entry,
  actor: "admin",
  administration: true,
  destructiveAdministration: entry.mutation === true,
}));
