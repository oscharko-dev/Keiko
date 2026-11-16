// Planning fixtures and qualifying effects share the governed dispatcher; native GETs are oracles.
import assert from "./api-qualification-assert.mjs";
import { URL, URLSearchParams } from "node:url";
import { jiraSprintLifecycleSnapshot } from "../../../packages/keiko-connectors/dist/jira-sprint-lifecycle-values.js";
import { basicAuth, labRequest, labSessionConnection } from "./lab-client.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import { adminMutationCase, observeAdminActor } from "./api-qualification-admin-cases.mjs";
import {
  createQualificationFilter,
  createQualificationIssue,
  fixtureWrite,
} from "./api-qualification-fixtures.mjs";
import { proof, read, readRecord } from "./api-qualification-read.mjs";

const numericId = (value) => {
  assert.match(String(value), /^[1-9]\d{0,15}$/u);
  assert.ok(Number.isSafeInteger(Number(value)));
  return String(value);
};
const boardPath = (f) => `/rest/agile/1.0/board/${f.planningBoard.id}`;
const epicPath = (f) => `/rest/agile/1.0/epic/${f.planningEpic.id}`;
const sprintPath = (id) => `/rest/agile/1.0/sprint/${id}`;
const issuePath = (key) => `/rest/api/2/issue/${key}`;
const actorArgs = (f) => ({ expectedActorKey: f.adminActorKey });
const boardArgs = (f) => ({
  ...actorArgs(f),
  boardId: String(f.planningBoard.id),
  expectedBoardName: f.planningBoard.name,
});
/**
 * The seeded KEIKO project uses the simple issue type scheme (Task and Sub-task). Scrum planning needs
 * the global Epic and Story types in the project, so the operator fixture adds exactly those two to
 * the project's own scheme, natively and idempotently, before the governed planning cases run.
 */
async function ensureAgileIssueTypes(c, f) {
  const schemes = await read(c, "/rest/api/2/issuetypescheme");
  const own = schemes.schemes.filter((scheme) => scheme.name.startsWith("KEIKO: "));
  assert.equal(own.length, 1, "The seeded project must have exactly one own issue type scheme");
  const scheme = await read(c, `/rest/api/2/issuetypescheme/${own[0].id}?expand=issueTypes`);
  const present = new Set(scheme.issueTypes.map((type) => String(type.id)));
  const global = await read(c, "/rest/api/2/issuetype");
  const wanted = ["Epic", "Story"].map((name) => {
    const found = global.filter((type) => type.name === name && !type.subtask);
    assert.equal(found.length, 1, `The global ${name} issue type must be unique`);
    return String(found[0].id);
  });
  if (wanted.every((id) => present.has(id))) return;
  const origin = labSessionConnection(c.session).origin;
  const response = await globalThis.fetch(
    new URL(`/rest/api/2/issuetypescheme/${own[0].id}`, origin),
    {
      method: "PUT",
      redirect: "manual",
      signal: globalThis.AbortSignal.timeout(30_000),
      headers: { Authorization: basicAuth(c.session, c.actor), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: scheme.name,
        issueTypeIds: [...new Set([...present, ...wanted])],
        defaultIssueTypeId: String(f.issueTypeId),
      }),
    },
  );
  assert.equal(response.status, 200, "Jira must accept the project's Agile issue types");
}
/**
 * Jira requires Epic Name and records Story Points on those types, but the simple project's screens
 * do not list them, so create/edit metadata hides them from the governed tools. The operator fixture
 * adds exactly those two fields to the project's own create and edit screens, idempotently.
 */
async function ensureAgileScreenFields(c) {
  const fields = await read(c, "/rest/api/2/field");
  const wanted = [
    fields.filter((field) => field.schema?.custom === "com.pyxis.greenhopper.jira:gh-epic-label"),
    fields.filter((field) => field.name === "Story Points" && field.custom === true),
  ].map((found) => {
    assert.equal(found.length, 1, "The exact native Agile field must be uniquely available");
    return found[0].id;
  });
  const screens = await read(c, "/rest/api/2/screens");
  const origin = labSessionConnection(c.session).origin;
  for (const name of [
    "KEIKO: Simple Issue Tracking Create Issue Screen",
    "KEIKO: Simple Issue Tracking Edit/View Issue Screen",
  ]) {
    const matches = screens.filter((screen) => screen.name === name);
    assert.equal(matches.length, 1, "The seeded project must own its simple screens");
    const tabs = await read(c, `/rest/api/2/screens/${matches[0].id}/tabs`);
    assert.ok(tabs.length > 0);
    const tab = `/rest/api/2/screens/${matches[0].id}/tabs/${tabs[0].id}/fields`;
    const present = new Set((await read(c, tab)).map((field) => field.id));
    for (const id of wanted.filter((id) => !present.has(id))) {
      const response = await globalThis.fetch(new URL(tab, origin), {
        method: "POST",
        redirect: "manual",
        signal: globalThis.AbortSignal.timeout(30_000),
        headers: {
          Authorization: basicAuth(c.session, c.actor),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fieldId: id }),
      });
      assert.equal(response.status, 200, "Jira must accept the Agile field on the screen");
    }
  }
}
async function planningBoard(c, f) {
  await observeAdminActor(c, f);
  await ensureAgileIssueTypes(c, f);
  await ensureAgileScreenFields(c);
  if (!f.planningBoard) {
    const filter = await createQualificationFilter(c, f, "planning");
    const name = `Synthetic AC7 planning ${f.runId}`;
    await fixtureWrite(
      c,
      "jira.board-create",
      {
        name,
        type: "scrum",
        filterId: String(filter.id),
      },
      async (context, data) => {
        f.planningBoard = await readRecord(
          context,
          data.boardId,
          `/rest/agile/1.0/board/${data.boardId}/configuration`,
        );
        assert.equal(f.planningBoard.name, name);
        assert.equal(f.planningBoard.type, "scrum");
        assert.equal(String(f.planningBoard.filter.id), String(filter.id));
        return proof(4);
      },
    );
  }
  const current = await read(c, `${boardPath(f)}/configuration`);
  assert.equal(String(current.id), String(f.planningBoard.id));
  assert.equal(current.name, f.planningBoard.name);
  assert.equal(current.type, "scrum");
  f.planningBoard = current;
}
async function uniqueField(c, custom) {
  const fields = await read(c, "/rest/api/2/field");
  const matches = fields.filter((field) => field.schema?.custom === custom);
  assert.equal(matches.length, 1, "The exact native Agile field must be uniquely available");
  return matches[0];
}
async function createEpic(c, f, label) {
  const project = await read(c, "/rest/api/2/project/KEIKO");
  assert.equal(String(project.id), f.projectId);
  const types = project.issueTypes.filter((type) => type.name === "Epic" && !type.subtask);
  assert.equal(types.length, 1, "The synthetic project must expose its native Epic issue type");
  const field = await uniqueField(c, "com.pyxis.greenhopper.jira:gh-epic-label");
  const issue = await createQualificationIssue(c, f, label, String(types[0].id), {
    [field.id]: `AC7 ${label} ${f.runId}`,
  });
  const epic = await read(c, `/rest/agile/1.0/epic/${issue.key}`);
  assert.equal(String(epic.id), issue.id);
  assert.equal(epic.key, issue.key);
  assert.equal(epic.summary, issue.fields.summary);
  return epic;
}
async function planningEpic(c, f) {
  await planningBoard(c, f);
  f.planningEpic ??= await createEpic(c, f, "planning epic");
  const current = await read(c, epicPath(f));
  assert.equal(String(current.id), String(f.planningEpic.id));
  assert.equal(current.key, f.planningEpic.key);
  f.planningEpic = current;
}
async function membership(c, issue, expected) {
  const field = await uniqueField(c, "com.pyxis.greenhopper.jira:gh-epic-link");
  // Jira answers the filtered `fields=epic` read with null fields; the full record carries the epic.
  const agile = await read(c, `/rest/agile/1.0/issue/${issue.key}`);
  assert.equal(String(agile.id), String(issue.id));
  assert.equal(agile.key, issue.key);
  assert.ok(agile.fields && typeof agile.fields === "object");
  const core = await read(c, `${issuePath(issue.key)}?fields=${field.id}`);
  assert.equal(core.id, String(issue.id));
  assert.equal(core.key, issue.key);
  assert.ok(Object.hasOwn(core.fields, field.id));
  assert.equal(core.fields[field.id], expected?.key ?? null);
  if (expected === null) assert.ok((agile.fields.epic ?? null) === null);
  else {
    assert.equal(String(agile.fields.epic.id), String(expected.id));
    assert.equal(agile.fields.epic.key, expected.key);
  }
  return proof(9);
}
async function planningMember(c, f) {
  await planningEpic(c, f);
  f.planningMember = await createQualificationIssue(c, f, "epic member");
  await membership(c, f.planningMember, null);
  await fixtureWrite(
    c,
    "jira.epic-move-issues",
    {
      epicIdOrKey: String(f.planningEpic.id),
      issues: [f.planningMember.key],
    },
    (context) => membership(context, f.planningMember, f.planningEpic),
  );
}
const issueRows = (value) =>
  value.issues.map((row) => ({
    id: row.id,
    key: row.key,
    summary: row.fields.summary,
  }));
function epicIssues(tool, path, args) {
  return {
    ...readCase(tool, path, ["id", "key", "summary"], {
      args: (f) => ({ ...args(f), maxResults: 100 }),
      nativeRoot: issueRows,
    }),
    prepare: planningMember,
  };
}
// Jira keeps epics out of the board issue list, so epic order is read from the same rank-ordered JQL.
async function boardSubset(c, f, selected, anchor, epic = false) {
  const query = new URLSearchParams({
    jql: `id in (${selected.id},${anchor.id}) ORDER BY cf[${numericId(f.planningBoard.ranking.rankCustomFieldId)}] ASC`,
    startAt: "0",
    maxResults: "100",
    fields: "summary",
  });
  const value = await read(
    c,
    epic ? `/rest/api/2/search?${query}` : `${boardPath(f)}/issue?${query}`,
  );
  assert.equal(value.startAt, 0);
  assert.equal(value.total, 2);
  assert.equal(value.issues.length, 2);
  const keys = value.issues.map((row) => row.key);
  assert.deepEqual([...keys].sort(), [selected.key, anchor.key].sort());
  return keys;
}
async function rankIssue(c, issue, fieldId) {
  const value = await read(c, `${issuePath(issue.key)}?fields=${fieldId}`);
  assert.equal(value.id, String(issue.id));
  assert.equal(value.key, issue.key);
  assert.ok(Object.hasOwn(value.fields, fieldId));
  const rank = value.fields[fieldId];
  assert.ok(rank === null || (typeof rank === "string" && rank.length > 0));
  return { id: value.id, key: value.key, rank };
}
async function prepareRank(c, f, epic) {
  await planningBoard(c, f);
  const create = epic ? createEpic : createQualificationIssue;
  const selected = await create(c, f, epic ? "ranked epic" : "ranked issue");
  const anchor = await create(c, f, epic ? "anchor epic" : "anchor issue");
  const field = await uniqueField(c, "com.pyxis.greenhopper.jira:gh-lexo-rank");
  const fieldId = `customfield_${numericId(f.planningBoard.ranking.rankCustomFieldId)}`;
  assert.equal(field.id, fieldId);
  const order = await boardSubset(c, f, selected, anchor, epic);
  f.planningRank = {
    selected: await rankIssue(c, selected, fieldId),
    anchor: await rankIssue(c, anchor, fieldId),
    fieldId,
    epic,
    direction: order[0] === selected.key ? "after" : "before",
  };
}
const rankArgs = (f) => ({
  ...boardArgs(f),
  rankCustomFieldId: f.planningRank.fieldId.slice("customfield_".length),
  direction: f.planningRank.direction,
  expectedAnchorRank: f.planningRank.anchor.rank,
});
async function rankReadback(c, _data, f) {
  const { selected, anchor, fieldId, direction, epic } = f.planningRank;
  const order = await boardSubset(c, f, selected, anchor, epic);
  assert.deepEqual(
    order,
    direction === "before" ? [selected.key, anchor.key] : [anchor.key, selected.key],
  );
  const current = await rankIssue(c, selected, fieldId);
  await rankIssue(c, anchor, fieldId);
  assert.notEqual(current.rank, selected.rank, "The native rank must actually change");
  // Relative visible order is an observation, never confirmation of global index positions.
  return { ...proof(8), globalRankConfirmed: false };
}
const estimatePath = (f) =>
  `/rest/agile/1.0/issue/${f.planningEstimateIssue.key}/estimation?boardId=${f.planningBoard.id}`;
async function prepareEstimate(c, f) {
  await planningBoard(c, f);
  assert.equal(f.planningBoard.estimation.type, "field");
  const fieldId = f.planningBoard.estimation.field.fieldId;
  const fields = await read(c, "/rest/api/2/field");
  const exact = fields.filter((field) => field.id === fieldId);
  assert.equal(exact.length, 1);
  const minutes = fieldId === "timeoriginalestimate";
  assert.ok(minutes ? exact[0].schema?.system === fieldId : exact[0].schema?.type === "number");
  const project = await read(c, "/rest/api/2/project/KEIKO");
  assert.equal(String(project.id), f.projectId);
  const types = project.issueTypes.filter(
    (type) =>
      !type.subtask && (minutes ? String(type.id) === f.issueTypeId : type.name === "Story"),
  );
  assert.equal(
    types.length,
    1,
    "The native project must expose the reviewed estimation issue type",
  );
  f.planningEstimateIssue = await createQualificationIssue(
    c,
    f,
    "estimated issue",
    String(types[0].id),
    minutes ? { timetracking: { originalEstimate: "1m" } } : { [fieldId]: 1 },
  );
  const native = await read(c, estimatePath(f));
  assert.equal(native.fieldId, fieldId);
  assert.ok(
    Object.hasOwn(native, "value"),
    "The native current estimate must be explicitly observed",
  );
  assert.equal(native.value, minutes ? 60 : 1);
  const core = await read(c, `${issuePath(f.planningEstimateIssue.key)}?fields=${native.fieldId}`);
  assert.ok(Object.hasOwn(core.fields, native.fieldId));
  assert.equal(core.fields[native.fieldId], native.value);
  f.planningEstimate = native;
  f.planningEstimateUnit = native.fieldId === "timeoriginalestimate" ? "minutes" : "board-number";
  const first = f.planningEstimateUnit === "minutes" ? 120 : 2;
  f.planningEstimateTarget = native.value === first ? first * 2 : first;
}
async function estimateReadback(c, data, f, mutation = false) {
  const native = await read(c, estimatePath(f));
  assert.equal(native.fieldId, f.planningEstimate.fieldId);
  const core = await read(c, `${issuePath(f.planningEstimateIssue.key)}?fields=${native.fieldId}`);
  assert.equal(core.id, f.planningEstimateIssue.id);
  assert.equal(core.key, f.planningEstimateIssue.key);
  assert.ok(Object.hasOwn(core.fields, native.fieldId));
  assert.equal(core.fields[native.fieldId], native.value);
  if (mutation) assert.equal(native.value, f.planningEstimateTarget);
  else {
    assert.equal(data.boardId, String(f.planningBoard.id));
    assert.equal(data.issueId, f.planningEstimateIssue.id);
    assert.equal(data.issueKey, f.planningEstimateIssue.key);
    assert.equal(data.fieldId, native.fieldId);
    if (native.value === null) assert.equal(Object.hasOwn(data, "value"), false);
    else assert.equal(data.value, native.value);
  }
  return proof(mutation ? 7 : 11);
}
async function nativeSprint(c, id) {
  const value = jiraSprintLifecycleSnapshot(await read(c, sprintPath(id)), true);
  assert.ok(value, "The native sprint must satisfy the product's exact snapshot parser");
  assert.equal(value.id, id);
  return value;
}
function assertNativeSprintFields(raw, expected) {
  // Review uses the product codec; effect evidence compares the native fields themselves.
  assert.equal(typeof raw, "object");
  assert.ok(raw !== null && !Array.isArray(raw));
  for (const key of Object.keys(raw)) {
    if (key !== "self") assert.ok(Object.hasOwn(expected, key));
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    // Jira omits a null date, goal or destination from the native sprint record entirely.
    if (!Object.hasOwn(raw, key)) {
      assert.equal(expectedValue, null);
      continue;
    }
    const value =
      key === "id" ||
      key === "originBoardId" ||
      (key === "incompleteIssuesDestinationId" && raw[key] !== null)
        ? numericId(raw[key])
        : raw[key];
    assert.deepEqual(value, expectedValue);
  }
}
async function createSprint(c, f, label) {
  let actual;
  const name = `AC7-${label}-${f.runId}`.slice(0, 30);
  await fixtureWrite(
    c,
    "jira.sprint-create",
    {
      originBoardId: String(f.planningBoard.id),
      name,
      goal: "Synthetic AC7 planning sprint",
    },
    async (context, data) => {
      actual = await nativeSprint(context, data.sprintId);
      assert.equal(actual.name, name);
      assert.equal(actual.state, "future");
      assert.equal(actual.originBoardId, String(f.planningBoard.id));
      return proof(4);
    },
  );
  assert.ok(actual);
  return actual;
}
async function visibleSprints(c, boardId) {
  const ids = [];
  let total;
  for (let page = 0; page < 10; page++) {
    const value = await read(
      c,
      `/rest/agile/1.0/board/${boardId}/sprint?startAt=${ids.length}&maxResults=100`,
    );
    assert.equal(value.startAt, ids.length);
    assert.equal(typeof value.isLast, "boolean");
    assert.ok(Array.isArray(value.values));
    if (page > 0) assert.equal(value.total, total);
    total = value.total;
    for (const row of value.values) {
      const id = numericId(row.id);
      assert.equal(ids.includes(id), false);
      ids.push(id);
    }
    if (value.isLast) return ids;
    assert.ok(value.values.length > 0);
  }
  throw new TypeError("The complete native visible sprint order exceeds the bounded oracle");
}
async function sprintSelection(c, f, label) {
  await planningBoard(c, f);
  f.planningSprint = await createSprint(c, f, label);
}
const sprintArgs = (f) => ({
  ...actorArgs(f),
  sprintId: f.planningSprint.id,
  expectedSprint: f.planningSprint,
});
async function prepareUnmap(c, f, all) {
  await observeAdminActor(c, f);
  const key = all ? "planningAllSyncedSprintIds" : "planningSyncedSprintIds";
  const ids = f[key];
  assert.ok(
    Array.isArray(ids) && ids.length > 0 && ids.length <= 50,
    `The private fixture must explicitly name genuine synced sprints in ${key}`,
  );
  assert.equal(new Set(ids).size, ids.length);
  f.planningSyncedSprints = [];
  for (const id of ids) {
    assert.equal(numericId(id), id);
    const sprint = await nativeSprint(c, id);
    assert.equal(
      sprint.synced,
      true,
      "An unchanged or unknown sync flag cannot qualify an unmap effect",
    );
    const board = await read(c, `/rest/agile/1.0/board/${sprint.originBoardId}`);
    assert.equal(String(board.id), sprint.originBoardId);
    assert.equal(board.type, "scrum");
    f.planningSyncedSprints.push(sprint);
  }
}
async function unmapReadback(c, _data, f, all) {
  assert.ok(f.planningSyncedSprints.length > 0);
  for (const before of f.planningSyncedSprints) {
    assert.equal(before.synced, true);
    assertNativeSprintFields(await read(c, sprintPath(before.id)), { ...before, synced: false });
  }
  return {
    ...proof(f.planningSyncedSprints.length * 2),
    ...(all ? { instanceWideConfirmed: false } : {}),
  };
}

export const API_QUALIFICATION_PLANNING_CASES = [
  epicIssues(
    "jira.board-epic-issues",
    (f) => `${boardPath(f)}/epic/${f.planningEpic.id}/issue?maxResults=100`,
    (f) => ({ boardId: String(f.planningBoard.id), epicId: String(f.planningEpic.id) }),
  ),
  adminMutationCase(
    "jira.epic-remove-issues",
    (f) => ({
      ...actorArgs(f),
      issues: [
        {
          issueIdOrKey: f.planningMember.key,
          expectedEpic: { id: String(f.planningEpic.id), key: f.planningEpic.key },
        },
      ],
    }),
    (c, _data, f) => membership(c, f.planningMember, null),
    planningMember,
  ),
  {
    ...readCase("jira.epic", epicPath, ["id", "key", "name", "summary", "done"], {
      args: (f) => ({ epicIdOrKey: String(f.planningEpic.id) }),
      nativeRoot: "single",
    }),
    prepare: planningEpic,
  },
  adminMutationCase(
    "jira.epic-update",
    // Jira echoes `done` in its acknowledgement but does not persist it on this release (the next
    // read still shows the prior value), so the persisted epic name carries this proof instead.
    (f) => ({
      epicIdOrKey: String(f.planningEpic.id),
      name: `${f.planningEpic.name} revised`,
    }),
    async (c, _data, f) => {
      const current = await read(c, epicPath(f));
      for (const key of ["id", "key", "summary", "done"])
        assert.equal(current[key], f.planningEpic[key]);
      assert.equal(current.name, `${f.planningEpic.name} revised`);
      return proof(5);
    },
    planningEpic,
  ),
  epicIssues(
    "jira.epic-issues",
    (f) => `${epicPath(f)}/issue?maxResults=100`,
    (f) => ({ epicIdOrKey: String(f.planningEpic.id) }),
  ),
  adminMutationCase(
    "jira.epic-move-issues",
    (f) => ({
      epicIdOrKey: String(f.planningEpic.id),
      issues: [f.planningMember.key],
    }),
    (c, _data, f) => membership(c, f.planningMember, f.planningEpic),
    async (c, f) => {
      await planningEpic(c, f);
      f.planningMember = await createQualificationIssue(c, f, "moved epic member");
      await membership(c, f.planningMember, null);
    },
  ),
  adminMutationCase(
    "jira.rank-epic",
    (f) => ({
      ...rankArgs(f),
      epicIdOrKey: f.planningRank.selected.key,
      expectedRank: f.planningRank.selected.rank,
      anchorEpicIdOrKey: f.planningRank.anchor.key,
    }),
    rankReadback,
    (c, f) => prepareRank(c, f, true),
  ),
  adminMutationCase(
    "jira.rank-issues",
    (f) => ({
      ...rankArgs(f),
      issues: [
        { issueIdOrKey: f.planningRank.selected.key, expectedRank: f.planningRank.selected.rank },
      ],
      anchorIssueIdOrKey: f.planningRank.anchor.key,
    }),
    rankReadback,
    (c, f) => prepareRank(c, f, false),
  ),
  {
    tool: "jira.issue-estimation",
    prepare: prepareEstimate,
    arguments: (f) => ({
      issueIdOrKey: f.planningEstimateIssue.key,
      boardId: String(f.planningBoard.id),
    }),
    readback: estimateReadback,
  },
  adminMutationCase(
    "jira.set-issue-estimation",
    (f) => ({
      ...boardArgs(f),
      issueIdOrKey: f.planningEstimateIssue.key,
      fieldId: f.planningEstimate.fieldId,
      expectedValue: f.planningEstimate.value,
      unit: f.planningEstimateUnit,
      value: String(
        f.planningEstimateUnit === "minutes"
          ? f.planningEstimateTarget / 60
          : f.planningEstimateTarget,
      ),
    }),
    (c, data, f) => estimateReadback(c, data, f, true),
    prepareEstimate,
  ),
  ...[false, true].map((all) =>
    adminMutationCase(
      all ? "jira.unmap-all-sprints" : "jira.unmap-sprints",
      (f) => ({
        ...actorArgs(f),
        expectedSprints: f.planningSyncedSprints,
        ...(all ? { confirmInstanceWide: true } : {}),
      }),
      (c, data, f) => unmapReadback(c, data, f, all),
      (c, f) => prepareUnmap(c, f, all),
    ),
  ),
  adminMutationCase(
    "jira.delete-sprint",
    sprintArgs,
    async (c, _data, f) => {
      const response = await labRequest(
        c.session,
        "GET",
        sprintPath(f.planningSprint.id),
        basicAuth(c.session, c.actor),
      );
      assert.equal(response.status, 404);
      const board = await read(c, `/rest/agile/1.0/board/${f.planningSprint.originBoardId}`);
      assert.equal(String(board.id), f.planningSprint.originBoardId);
      assert.equal(board.type, "scrum");
      assert.equal(
        (await visibleSprints(c, f.planningSprint.originBoardId)).includes(f.planningSprint.id),
        false,
      );
      return { ...proof(4), observedStatus: 404, deletionConfirmed: false };
    },
    async (c, f) => {
      await sprintSelection(c, f, "delete");
      assert.equal(
        f.planningSprint.synced,
        false,
        "Deletion needs an explicitly unsynced native future sprint",
      );
    },
  ),
  adminMutationCase(
    "jira.replace-sprint",
    (f) => ({
      ...sprintArgs(f),
      replacement: f.planningReplacement,
      expectedDestination: f.planningDestination,
    }),
    async (c, _data, f) => {
      const current = await read(c, sprintPath(f.planningSprint.id));
      assertNativeSprintFields(current, { ...f.planningSprint, ...f.planningReplacement });
      return proof(2 + Object.keys(f.planningReplacement).length * 2);
    },
    async (c, f) => {
      await sprintSelection(c, f, "replace");
      assert.equal(
        typeof f.planningSprint.synced,
        "boolean",
        "Replacement requires an observed native synced flag",
      );
      assert.equal(f.planningSprint.synced, false);
      // Jira omits a null date, goal or destination from its next read, which the product (rightly)
      // never reads as a confirmed clear. Every replaced field is therefore a persisted value: both
      // dates, the goal and a second, owned sprint as the incomplete-issues destination.
      const destination = await createSprint(c, f, "replace-destination");
      // The product admits a named destination only with its reviewed native snapshot.
      f.planningDestination = destination;
      f.planningReplacement = {
        name: `${f.planningSprint.name.slice(0, 22)} revised`,
        state: "future",
        startDate: "2030-01-01T09:00:00.000Z",
        endDate: "2030-01-15T09:00:00.000Z",
        goal: "Synthetic AC7 replaced sprint",
        autoStartStop: false,
        incompleteIssuesDestinationId: destination.id,
      };
      assert.notEqual(f.planningReplacement.name, f.planningSprint.name);
    },
  ),
  adminMutationCase(
    "jira.swap-sprints",
    (f) => ({
      ...sprintArgs(f),
      swapSprintId: f.planningSwapSprint.id,
      expectedSwapSprint: f.planningSwapSprint,
      expectedVisibleSprintIds: f.planningSprintOrder,
    }),
    async (c, _data, f) => {
      assertNativeSprintFields(await read(c, sprintPath(f.planningSprint.id)), f.planningSprint);
      assertNativeSprintFields(
        await read(c, sprintPath(f.planningSwapSprint.id)),
        f.planningSwapSprint,
      );
      const expected = f.planningSprintOrder.map((id) => {
        if (id === f.planningSprint.id) return f.planningSwapSprint.id;
        return id === f.planningSwapSprint.id ? f.planningSprint.id : id;
      });
      assert.deepEqual(await visibleSprints(c, f.planningSprint.originBoardId), expected);
      return { ...proof(3), globalPositionConfirmed: false };
    },
    async (c, f) => {
      await sprintSelection(c, f, "swap-a");
      f.planningSwapSprint = await createSprint(c, f, "swap-b");
      f.planningSprintOrder = await visibleSprints(c, String(f.planningBoard.id));
      for (const sprint of [f.planningSprint, f.planningSwapSprint])
        assert.ok(f.planningSprintOrder.includes(sprint.id));
    },
  ),
].map((entry) => ({ ...entry, actor: "admin", administration: true }));
