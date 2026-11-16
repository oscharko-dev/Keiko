import {
  boardSprints,
  definition,
  editBody,
  effectProof,
  exactBody,
  exactKeys,
  exactSprint,
  issueIdentity,
  issueRead,
  nativeId,
  oneNewNative,
  pointsTotal,
  projectJql,
  projectVersions,
  readProof,
  rememberEntity,
  requireRoleFact,
  roleRead,
  roleReadResult,
  roleSearch,
  same,
  sprintIssues,
  sprintProjection,
  sprintRead,
  stateEntity,
} from "./browser-roles-oracles.mjs";

const SPRINT_GOALS = [
  "Deliver the first customer increment.",
  "Finish the scoped stories and verify integration.",
];
function sprintFields(environment, number) {
  const offset = (number - 1) * 14 * 86400000;
  const date = (value) => new Date(Date.parse(value) + offset).toISOString();
  const { fixture } = environment;
  return {
    name: `${fixture.project.key} ${number === 3 ? "Cleanup" : `Iteration ${number}`}`,
    originBoardId: Number(fixture.board.id),
    goal: SPRINT_GOALS[0],
    startDate: date(fixture.dates.startDate),
    endDate: date(fixture.dates.endDate),
  };
}
async function createSprint(environment, meta, number) {
  const fields = sprintFields(environment, number);
  const before = await boardSprints(environment);
  return definition(
    meta,
    `Lege auf Board ${environment.fixture.board.id} genau einen Sprint namens "${fields.name}" an. Ziel: "${fields.goal}". Zeitraum: ${fields.startDate} bis ${fields.endDate}.`,
    [{ method: "POST", path: "/rest/agile/1.0/sprint", admit: (body) => exactBody(body, fields) }],
    async (turn) => {
      const created = oneNewNative(
        before,
        await boardSprints(environment),
        (value) => value.name === fields.name,
      );
      exactSprint(await sprintRead(environment, created.id), { ...fields, state: "future" });
      requireRoleFact((await sprintIssues(environment, created.id)).length === 0);
      rememberEntity(environment, `sprint${number}`, created);
      return effectProof(turn, meta.operations, { created: 1, sprintCount: before.length + 1 });
    },
  );
}
async function updateSprint(environment, meta, start) {
  const sprint = stateEntity(environment, "sprint1");
  const before = sprintProjection(await sprintRead(environment, sprint.id));
  const changes = start
    ? { state: "active" }
    : { name: `${environment.fixture.project.key} Delivery 1`, goal: SPRINT_GOALS[1] };
  return definition(
    meta,
    start
      ? `Start sprint "${before.name}" now with its existing goal and scheduled dates.`
      : `Benenne Sprint "${before.name}" in "${changes.name}" um und ändere sein Ziel auf "${changes.goal}". Board, Zeitraum und Status bleiben unverändert.`,
    [
      {
        method: "POST",
        path: `/rest/agile/1.0/sprint/${sprint.id}`,
        admit: (body) => exactBody(body, changes),
      },
    ],
    async (turn) => {
      exactSprint(await sprintRead(environment, sprint.id), { ...before, ...changes });
      return effectProof(turn, meta.operations, { changed: Object.keys(changes).length });
    },
  );
}
async function planStories(environment, meta) {
  const sprint = stateEntity(environment, "sprint1");
  const keys = environment.fixture.stories.slice(0, 4).map(({ key }) => key);
  return definition(
    meta,
    `Plane genau diese vier Stories für Sprint ${sprint.id}: ${keys.join(", ")}.`,
    [
      {
        method: "POST",
        path: `/rest/agile/1.0/sprint/${sprint.id}/issue`,
        admit: (body) => exactBody(body, { issues: keys }),
      },
    ],
    async (turn) => {
      exactKeys(await sprintIssues(environment, sprint.id), keys);
      return effectProof(turn, meta.operations, { members: keys.length });
    },
  );
}
async function rankStory(environment, meta) {
  const [anchor, , , selected] = environment.fixture.stories;
  const config = await roleRead(
    environment,
    `/rest/agile/1.0/board/${environment.fixture.board.id}/configuration`,
  );
  const jql = `project = "${environment.fixture.project.key}" ORDER BY Rank ASC`;
  const before = await roleSearch(environment, jql);
  const wanted = before.map(({ key }) => key).filter((key) => key !== selected.key);
  wanted.splice(wanted.indexOf(anchor.key), 0, selected.key);
  requireRoleFact(wanted.includes(selected.key) && wanted.includes(anchor.key));
  const body = {
    rankBeforeIssue: nativeId(anchor.id),
    rankCustomFieldId: Number(nativeId(config.ranking?.rankCustomFieldId)),
    issues: [nativeId(selected.id)],
  };
  return definition(
    meta,
    `Priorisiere ${selected.key} direkt vor ${anchor.key} auf Board ${environment.fixture.board.id}.`,
    [
      {
        method: "PUT",
        path: "/rest/agile/1.0/issue/rank",
        admit: (value) => exactBody(value, body),
      },
    ],
    async (turn) => {
      requireRoleFact(
        same(
          (await roleSearch(environment, jql)).map(({ key }) => key),
          wanted,
        ),
      );
      return effectProof(turn, meta.operations, { ranked: 1 });
    },
  );
}
async function observedCreatedVersion(environment, before, fields) {
  const version = oneNewNative(
    before,
    await projectVersions(environment),
    (value) => value.name === fields.name,
  );
  requireRoleFact(
    version.releaseDate === fields.releaseDate &&
      version.released === false &&
      version.archived === false,
  );
  return version;
}
async function createVersion(environment, meta) {
  const before = await projectVersions(environment);
  const fields = {
    projectId: Number(environment.fixture.project.id),
    name: "1.0",
    releaseDate: environment.fixture.dates.releaseDate,
  };
  const selected = environment.fixture.stories.slice(0, 3);
  const previous = await Promise.all(selected.map(({ key }) => issueRead(environment, key)));
  const observedVersion = () => observedCreatedVersion(environment, before, fields);
  const wire = [
    { method: "POST", path: "/rest/api/2/version", admit: (value) => exactBody(value, fields) },
    ...selected.map((issue, index) => ({
      method: "PUT",
      path: `/rest/api/2/issue/${issue.key}`,
      admit: async (body) =>
        editBody(body, {
          fixVersions: [
            ...previous[index].fields.fixVersions.map(({ id }) => ({ id })),
            { id: nativeId((await observedVersion()).id) },
          ],
        }),
    })),
  ];
  return definition(
    meta,
    `Create version 1.0 in project ${environment.fixture.project.key}, release date ${fields.releaseDate}, and assign exactly ${selected.map(({ key }) => key).join(", ")} to it. Preserve any existing fix versions.`,
    wire,
    async (turn) => {
      const version = await observedVersion();
      for (const [index, issue] of selected.entries()) {
        const after = await issueRead(environment, issue.key);
        issueIdentity(after, issue, environment.fixture.project);
        exactKeys(
          after.fields.fixVersions.map(({ id }) => ({ key: nativeId(id) })),
          [
            ...previous[index].fields.fixVersions.map(({ id }) => nativeId(id)),
            nativeId(version.id),
          ],
        );
      }
      rememberEntity(environment, "version", version);
      return effectProof(turn, meta.operations, { versionsCreated: 1, issuesChanged: 3 });
    },
  );
}
async function closeSprint(environment, meta) {
  const first = stateEntity(environment, "sprint1");
  const second = stateEntity(environment, "sprint2");
  const members = await sprintIssues(environment, first.id);
  const open = members
    .filter((issue) => issue.fields.status?.statusCategory?.key !== "done")
    .map(({ key }) => key);
  requireRoleFact(open.length > 0 && (await sprintIssues(environment, second.id)).length === 0);
  return definition(
    meta,
    `Schließe Sprint ${first.id} ab und verschiebe alle noch offenen Stories (${open.join(", ")}) in Sprint ${second.id}. Erledigte Stories bleiben dem abgeschlossenen Sprint zugeordnet.`,
    [
      {
        method: "POST",
        path: `/rest/agile/1.0/sprint/${first.id}`,
        admit: (body) => exactBody(body, { state: "closed" }),
      },
      {
        method: "POST",
        path: `/rest/agile/1.0/sprint/${second.id}/issue`,
        admit: (body) => exactBody(body, { issues: open }),
      },
    ],
    async (turn) => {
      const after = await sprintRead(environment, first.id);
      exactSprint(after, {
        id: first.id,
        originBoardId: environment.fixture.board.id,
        state: "closed",
      });
      requireRoleFact(Number.isFinite(Date.parse(after.completeDate)));
      exactKeys(
        await sprintIssues(environment, first.id),
        members.map(({ key }) => key),
      );
      exactKeys(await sprintIssues(environment, second.id), open);
      return effectProof(turn, meta.operations, {
        historicalMembers: members.length,
        moved: open.length,
      });
    },
  );
}
async function releaseVersion(environment, meta) {
  const version = stateEntity(environment, "version");
  const before = await roleRead(environment, `/rest/api/2/version/${version.id}`);
  return definition(
    meta,
    `Release version 1.0 in project ${environment.fixture.project.key}. Keep its name and release date.`,
    [
      {
        method: "PUT",
        path: `/rest/api/2/version/${version.id}`,
        admit: (body) => exactBody(body, { released: true }),
      },
    ],
    async (turn) => {
      const after = await roleRead(environment, `/rest/api/2/version/${version.id}`);
      requireRoleFact(
        after.released === true &&
          after.name === before.name &&
          after.releaseDate === before.releaseDate &&
          after.archived === before.archived,
      );
      return effectProof(turn, meta.operations, { released: 1 });
    },
  );
}
function sprintReport(environment, meta) {
  const sprint = stateEntity(environment, "sprint1");
  return definition(
    meta,
    `Erstelle einen Bericht zu Sprint ${sprint.id} im Projekt ${environment.fixture.project.key}. Nenne genau alle zugehörigen Issue-Keys und je eine Zeile "Erledigt: N", "Offen: N", "Story Points: N", "Erledigte Punkte: N" und "Offene Punkte: N".`,
    [],
    async (turn) => {
      const issues = await roleSearch(
        environment,
        projectJql(environment, ` AND sprint = ${sprint.id}`),
      );
      const done = issues.filter((issue) => issue.fields.status?.statusCategory?.key === "done");
      const open = issues.filter((issue) => issue.fields.status?.statusCategory?.key !== "done");
      return readProof(turn, meta.operations, issues, {
        Erledigt: done.length,
        Offen: open.length,
        "Story Points": pointsTotal(environment, issues),
        "Erledigte Punkte": pointsTotal(environment, done),
        "Offene Punkte": pointsTotal(environment, open),
      });
    },
  );
}
async function createDeleteSprint(environment, meta) {
  const before = await boardSprints(environment);
  const fields = sprintFields(environment, 3);
  let created;
  const resolveCreated = async () => {
    created = oneNewNative(
      before,
      await boardSprints(environment),
      (value) => value.name === fields.name,
    );
    exactSprint(await sprintRead(environment, created.id), { ...fields, state: "future" });
    requireRoleFact((await sprintIssues(environment, created.id)).length === 0);
    return `/rest/agile/1.0/sprint/${nativeId(created.id)}`;
  };
  return definition(
    meta,
    `Lege auf Board ${environment.fixture.board.id} den leeren Sprint "${fields.name}" mit Ziel "${fields.goal}" und Zeitraum ${fields.startDate} bis ${fields.endDate} an. Lösche anschließend genau diesen neuen Sprint wieder.`,
    [
      { method: "POST", path: "/rest/agile/1.0/sprint", admit: (body) => exactBody(body, fields) },
      { method: "DELETE", path: resolveCreated, admit: (body) => body === undefined },
    ],
    async (turn) => {
      requireRoleFact(created !== undefined);
      requireRoleFact(
        same(
          (await boardSprints(environment)).map((sprint) => sprintProjection(sprint)),
          before.map((sprint) => sprintProjection(sprint)),
        ),
      );
      requireRoleFact(
        (await roleReadResult(environment, `/rest/agile/1.0/sprint/${nativeId(created.id)}`))
          .status === 404,
      );
      return effectProof(turn, meta.operations, {
        created: 1,
        deleted: 1,
        remaining: before.length,
      });
    },
  );
}
export const projectLeadBuilders = {
  PL1: (environment, meta) => createSprint(environment, meta, 1),
  PL2: (environment, meta) => updateSprint(environment, meta, false),
  PL3: (environment, meta) => createSprint(environment, meta, 2),
  PL4: planStories,
  PL5: rankStory,
  PL6: createVersion,
  PL7: (environment, meta) => updateSprint(environment, meta, true),
  PL8: closeSprint,
  PL9: releaseVersion,
  PL10: sprintReport,
  PL11: createDeleteSprint,
};
