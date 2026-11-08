import {
  chosenTransition,
  definition,
  effectProof,
  exactBody,
  exactKeys,
  issueIdentity,
  issueRead,
  nativeId,
  oneNewNative,
  projectJql,
  quotedJql,
  readProof,
  rememberEntity,
  requireRoleFact,
  rolePages,
  roleRead,
  roleSearch,
  same,
  sprintIssues,
  sprintProjection,
  sprintRead,
  stateEntity,
} from "./browser-roles-oracles.mjs";
import {
  blocksBody,
  blocksType,
  roleIssueCreation,
  ROLE_TEXT,
  verifyBlockingLink,
} from "./browser-roles-issue-effects.mjs";

const story = (environment) => environment.fixture.stories[1];
function mine(environment, meta) {
  const sprint = stateEntity(environment, "sprint1");
  const developer = environment.fixture.actors.developer;
  return definition(
    meta,
    `Welche Issues sind mir im aktuellen Sprint ${sprint.id} zugewiesen? Mein Jira-Benutzer ist ${developer.name}. Nenne genau die Issue-Keys und eine Zeile "Anzahl: N".`,
    [],
    async (turn) => {
      const issues = await roleSearch(
        environment,
        projectJql(
          environment,
          ` AND sprint = ${sprint.id} AND assignee = ${quotedJql(developer.name)}`,
        ),
      );
      return readProof(turn, meta.operations, issues, { Anzahl: issues.length });
    },
  );
}
function assign(environment, meta) {
  const selected = story(environment);
  const actor = environment.fixture.actors.developer;
  return definition(
    meta,
    `Assign ${selected.key} to me, Jira user ${actor.name}.`,
    [
      {
        method: "PUT",
        path: `/rest/api/2/issue/${selected.key}/assignee`,
        admit: (body) => exactBody(body, { name: actor.name }),
      },
    ],
    async (turn) => {
      const after = await issueRead(environment, selected.key);
      issueIdentity(after, selected, environment.fixture.project);
      requireRoleFact(
        after.fields.assignee?.key === actor.key && after.fields.assignee?.name === actor.name,
      );
      return effectProof(turn, meta.operations, { assigned: 1 });
    },
  );
}
async function transition(environment, meta, done) {
  const selected = story(environment);
  const available = await roleRead(
    environment,
    `/rest/api/2/issue/${selected.key}/transitions?expand=transitions.fields`,
  );
  const target = chosenTransition(available, done);
  let resolution;
  if (done) {
    const values =
      target.fields?.resolution?.allowedValues ??
      (await roleRead(environment, "/rest/api/2/resolution"));
    requireRoleFact(Array.isArray(values));
    const fixed = values.filter((value) => value.name === "Fixed");
    requireRoleFact(fixed.length === 1);
    resolution = fixed[0];
  }
  const fields =
    done && target.fields?.resolution ? { resolution: { id: nativeId(resolution.id) } } : {};
  return definition(
    meta,
    done
      ? `Schließe ${selected.key} mit Status "${target.to.name}" und Resolution "${resolution.name}" ab. Nutze genau einen Statuswechsel.`
      : `Move ${selected.key} to "${target.to.name}" so that implementation is in progress.`,
    [
      {
        method: "POST",
        path: `/rest/api/2/issue/${selected.key}/transitions`,
        admit: (body) =>
          exactBody(body, { fields, update: {}, transition: { id: nativeId(target.id) } }),
      },
    ],
    async (turn) => {
      const after = await issueRead(environment, selected.key);
      issueIdentity(after, selected, environment.fixture.project);
      requireRoleFact(
        nativeId(after.fields.status.id) === nativeId(target.to.id) &&
          after.fields.status.statusCategory.key === (done ? "done" : "indeterminate"),
      );
      if (done) requireRoleFact(nativeId(after.fields.resolution?.id) === nativeId(resolution.id));
      return effectProof(turn, meta.operations, { transitioned: 1, resolved: done ? 1 : 0 });
    },
  );
}
async function worklog(environment, meta) {
  const selected = story(environment);
  const path = `/rest/api/2/issue/${nativeId(selected.id)}/worklog`;
  const before = await rolePages(environment, path, "worklogs");
  const started = new Date(environment.fixture.dates.startDate).toISOString().replace("Z", "+0000");
  const fields = { comment: ROLE_TEXT.worklog, started, timeSpentSeconds: 7200 };
  return definition(
    meta,
    `Buche für ${selected.key} zwei Stunden Arbeit ab ${environment.fixture.dates.startDate}, Kommentar "${ROLE_TEXT.worklog}". Lass die Restschätzung unverändert.`,
    [
      {
        method: "POST",
        path: `${path}?adjustEstimate=leave`,
        admit: (body) => exactBody(body, fields),
      },
    ],
    async (turn) => {
      const after = await rolePages(environment, path, "worklogs");
      oneNewNative(
        before,
        after,
        (value) =>
          value.timeSpentSeconds === 7200 &&
          value.comment === fields.comment &&
          Date.parse(value.started) === Date.parse(started) &&
          value.author?.key === environment.fixture.actors.developer.key,
      );
      requireRoleFact(
        after.reduce((sum, value) => sum + value.timeSpentSeconds, 0) ===
          before.reduce((sum, value) => sum + value.timeSpentSeconds, 0) + 7200,
      );
      return effectProof(turn, meta.operations, { worklogsCreated: 1, seconds: 7200 });
    },
  );
}
async function comment(environment, meta) {
  const selected = story(environment);
  const path = `/rest/api/2/issue/${selected.key}/comment`;
  const before = await rolePages(environment, path, "comments");
  return definition(
    meta,
    `Add this comment to ${selected.key}: "${ROLE_TEXT.comment}"`,
    [{ method: "POST", path, admit: (body) => exactBody(body, { body: ROLE_TEXT.comment }) }],
    async (turn) => {
      oneNewNative(
        before,
        await rolePages(environment, path, "comments"),
        (value) =>
          value.body === ROLE_TEXT.comment &&
          value.author?.key === environment.fixture.actors.developer.key,
      );
      return effectProof(turn, meta.operations, { commentsCreated: 1 });
    },
  );
}
async function subtask(environment, meta) {
  const parent = environment.fixture.task;
  const creation = await roleIssueCreation(
    environment,
    "Subtask",
    ROLE_TEXT.subtask,
    ROLE_TEXT.subtaskDescription,
    parent,
  );
  return definition(
    meta,
    `Lege unter ${parent.key} genau eine Unteraufgabe "${ROLE_TEXT.subtask}" mit Beschreibung "${ROLE_TEXT.subtaskDescription}" an.`,
    [creation.wire],
    async (turn) => {
      rememberEntity(environment, "subtask", await creation.created());
      return effectProof(turn, meta.operations, { created: 1 });
    },
  );
}
async function bug(environment, meta) {
  const selected = story(environment);
  const type = await blocksType(environment);
  const creation = await roleIssueCreation(
    environment,
    "Bug",
    ROLE_TEXT.bug,
    ROLE_TEXT.bugDescription,
  );
  return definition(
    meta,
    `Create a Bug in ${environment.fixture.project.key}, summary "${ROLE_TEXT.bug}", description "${ROLE_TEXT.bugDescription}". The new Bug blocks ${selected.key}; add that dependency.`,
    [
      creation.wire,
      {
        method: "POST",
        path: "/rest/api/2/issueLink",
        admit: async (body) =>
          exactBody(body, blocksBody(type, await creation.created(), selected)),
      },
    ],
    async (turn) => {
      const created = await creation.created();
      await verifyBlockingLink(environment, type, created, selected);
      rememberEntity(environment, "bug", created);
      return effectProof(turn, meta.operations, { issuesCreated: 1, linksCreated: 1 });
    },
  );
}
async function watch(environment, meta) {
  const selected = story(environment);
  const path = `/rest/api/2/issue/${nativeId(selected.id)}/watchers`;
  const before = await roleRead(environment, path);
  requireRoleFact(Array.isArray(before.watchers));
  const actor = environment.fixture.actors.developer;
  requireRoleFact(!before.watchers.some(({ key }) => key === actor.key));
  return definition(
    meta,
    `Beobachte ${selected.key} ab jetzt für mich.`,
    [{ method: "POST", path, admit: (body) => body === undefined }],
    async (turn) => {
      const after = await roleRead(environment, path);
      requireRoleFact(Array.isArray(after.watchers) && after.watchCount === after.watchers.length);
      exactKeys(after.watchers, [...before.watchers.map(({ key }) => key), actor.key]);
      return effectProof(turn, meta.operations, { watchersAdded: 1 });
    },
  );
}
async function deniedSprint(environment, meta) {
  const sprint = stateEntity(environment, "sprint2");
  const before = sprintProjection(await sprintRead(environment, sprint.id));
  const members = await sprintIssues(environment, sprint.id);
  requireRoleFact(before.state === "future" && members.length === 0);
  return definition(
    meta,
    `Versuche, den leeren zukünftigen Sprint ${sprint.id} zu löschen. Falls meine Berechtigung fehlt, sage genau einmal in einer eigenen lesbaren Zeile "Berechtigung fehlt". Versuche keine andere Änderung.`,
    [
      {
        method: "DELETE",
        path: `/rest/agile/1.0/sprint/${sprint.id}`,
        status: 403,
        admit: (body) => body === undefined,
      },
    ],
    async (turn) => {
      const refused = turn.exchanges.filter(({ call }) => call.name === "jira_delete_sprint");
      requireRoleFact(
        refused.length === 1 &&
          (refused[0].result?.data?.reason ?? refused[0].result?.data?.failureReason) ===
            "permission-denied",
      );
      requireRoleFact(
        (turn.answer.match(/^\s*Berechtigung fehlt[.!]?\s*$/gmu) ?? []).length === 1,
        "answer-mismatch",
        "answer",
      );
      requireRoleFact(same(sprintProjection(await sprintRead(environment, sprint.id)), before));
      exactKeys(await sprintIssues(environment, sprint.id), []);
      return effectProof(turn, meta.operations, { refused: 1, members: 0 }, true);
    },
    true,
  );
}
export const developerBuilders = {
  Dev1: mine,
  Dev2: assign,
  Dev3: (environment, meta) => transition(environment, meta, false),
  Dev4: worklog,
  Dev5: comment,
  Dev6: subtask,
  Dev7: bug,
  Dev8: (environment, meta) => transition(environment, meta, true),
  Dev9: watch,
  Dev10: deniedSprint,
};
