import {
  definition,
  effectProof,
  exactBody,
  exactKeys,
  issueIdentity,
  issueRead,
  nativeId,
  oneNewNative,
  pointsTotal,
  projectComponents,
  projectJql,
  readProof,
  rememberEntity,
  requireRoleFact,
  rolePages,
  roleRead,
  roleSearch,
  same,
  stateEntity,
} from "./browser-roles-oracles.mjs";
import {
  blocksType,
  editRoleIssues,
  linkRoleIssues,
  referenceIds,
  ROLE_TEXT,
} from "./browser-roles-issue-effects.mjs";

const selectedStories = (environment) => environment.fixture.stories.slice(4, 7);
async function component(environment, meta) {
  const before = await projectComponents(environment);
  const actor = environment.fixture.actors.techLead;
  const fields = {
    name: "Backend",
    leadUserName: actor.name,
    project: environment.fixture.project.key,
  };
  return definition(
    meta,
    `Lege in ${environment.fixture.project.key} die Komponente "Backend" mit Lead ${actor.name} an.`,
    [{ method: "POST", path: "/rest/api/2/component", admit: (body) => exactBody(body, fields) }],
    async (turn) => {
      const added = oneNewNative(
        before,
        await projectComponents(environment),
        (value) => value.name === "Backend",
      );
      const after = await roleRead(environment, `/rest/api/2/component/${nativeId(added.id)}`);
      requireRoleFact(
        nativeId(after.id) === nativeId(added.id) &&
          after.name === "Backend" &&
          after.lead?.name === actor.name &&
          (after.lead.key === undefined || after.lead.key === actor.key) &&
          after.project === environment.fixture.project.key,
      );
      rememberEntity(environment, "component", after);
      return effectProof(turn, meta.operations, { componentsCreated: 1 });
    },
  );
}
function assignComponent(environment, meta) {
  const component = stateEntity(environment, "component");
  const selected = selectedStories(environment);
  return editRoleIssues(
    environment,
    meta,
    selected,
    (before) => ({
      components: [
        ...referenceIds(before.fields.components).map((id) => ({ id })),
        { id: component.id },
      ],
    }),
    `Assign component Backend to exactly ${selected.map(({ key }) => key).join(", ")}. Preserve their existing components.`,
  );
}
function dependency(environment, meta) {
  const [blocker, blocked] = selectedStories(environment);
  return linkRoleIssues(
    environment,
    meta,
    blocker,
    blocked,
    `${blocker.key} blockiert ${blocked.key}. Lege genau diese Abhängigkeit an.`,
  );
}
function blockedIssues(environment, meta) {
  return definition(
    meta,
    `Welche noch offenen Issues in ${environment.fixture.project.key} sind durch andere Issues blockiert? Nenne genau deren Issue-Keys und eine Zeile "Anzahl: N".`,
    [],
    async (turn) => {
      const type = await blocksType(environment);
      const open = await roleSearch(
        environment,
        projectJql(environment, " AND statusCategory != Done"),
      );
      const issues = open.filter((issue) =>
        issue.fields.issuelinks.some(
          (link) => nativeId(link.type.id) === nativeId(type.id) && link.inwardIssue !== undefined,
        ),
      );
      return readProof(turn, meta.operations, issues, { Anzahl: issues.length });
    },
  );
}
function labels(environment, meta) {
  const selected = selectedStories(environment).slice(0, 2);
  return editRoleIssues(
    environment,
    meta,
    selected,
    (before) => {
      requireRoleFact(
        Array.isArray(before.fields.labels) && !before.fields.labels.includes("tech-debt"),
      );
      return { labels: [...before.fields.labels, "tech-debt"] };
    },
    `Ergänze bei genau ${selected.map(({ key }) => key).join(" und ")} das Label tech-debt. Behalte alle bisherigen Labels.`,
  );
}
function epicMembers(environment, epic) {
  return rolePages(environment, `/rest/agile/1.0/epic/${nativeId(epic.id)}/issue`, "issues");
}
async function moveEpic(environment, meta) {
  const selected = selectedStories(environment)[2];
  const epic = environment.fixture.epics[0];
  const previous = environment.fixture.epics[1];
  const [targetMembers, previousMembers] = await Promise.all([
    epicMembers(environment, epic),
    epicMembers(environment, previous),
  ]);
  requireRoleFact(
    previousMembers.some(({ key }) => key === selected.key) &&
      !targetMembers.some(({ key }) => key === selected.key),
  );
  const fields = await roleRead(environment, "/rest/api/2/field");
  requireRoleFact(Array.isArray(fields));
  const links = fields.filter(
    (field) => field.schema?.custom === "com.pyxis.greenhopper.jira:gh-epic-link",
  );
  requireRoleFact(links.length === 1);
  return definition(
    meta,
    `Move ${selected.key} into epic ${epic.key}.`,
    [
      {
        method: "POST",
        path: `/rest/agile/1.0/epic/${nativeId(epic.id)}/issue`,
        admit: (body) => exactBody(body, { issues: [selected.key] }),
      },
    ],
    async (turn) => {
      const after = await issueRead(environment, selected.key);
      issueIdentity(after, selected, environment.fixture.project);
      requireRoleFact(after.fields[links[0].id] === epic.key);
      exactKeys(await epicMembers(environment, epic), [
        ...targetMembers.map(({ key }) => key),
        selected.key,
      ]);
      exactKeys(
        await epicMembers(environment, previous),
        previousMembers.filter(({ key }) => key !== selected.key).map(({ key }) => key),
      );
      return effectProof(turn, meta.operations, { moved: 1 });
    },
  );
}
function estimates(environment, meta) {
  const selected = selectedStories(environment);
  const values = [8, 13, 21];
  return editRoleIssues(
    environment,
    meta,
    selected,
    (_before, index) => ({ [environment.fixture.storyPointsField.id]: values[index] }),
    `Setze die Story Points für ${selected.map(({ key }, index) => `${key} auf ${values[index]}`).join(", ")}.`,
  );
}
function versionOpen(environment, meta) {
  const version = stateEntity(environment, "version");
  return definition(
    meta,
    `Was ist in Version 1.0 von ${environment.fixture.project.key} noch offen? Nenne genau die Issue-Keys und je eine Zeile "Anzahl: N" und "Story Points: N".`,
    [],
    async (turn) => {
      const issues = await roleSearch(
        environment,
        projectJql(environment, ` AND fixVersion = ${version.id} AND statusCategory != Done`),
      );
      return readProof(turn, meta.operations, issues, {
        Anzahl: issues.length,
        "Story Points": pointsTotal(environment, issues),
      });
    },
  );
}
async function remoteLink(environment, meta) {
  const selected = selectedStories(environment)[0];
  const path = `/rest/api/2/issue/${nativeId(selected.id)}/remotelink`;
  const before = await roleRead(environment, path);
  requireRoleFact(Array.isArray(before));
  const fields = { object: { url: ROLE_TEXT.pullRequest, title: ROLE_TEXT.pullRequestTitle } };
  return definition(
    meta,
    `Attach the pull request ${ROLE_TEXT.pullRequest} to ${selected.key} with the title "${ROLE_TEXT.pullRequestTitle}".`,
    [{ method: "POST", path, admit: (body) => exactBody(body, fields) }],
    async (turn) => {
      const after = await roleRead(environment, path);
      oneNewNative(before, after, (link) => same(link.object, fields.object));
      return effectProof(turn, meta.operations, { remoteLinksCreated: 1 });
    },
  );
}
export const techLeadBuilders = {
  TL1: component,
  TL2: assignComponent,
  TL3: dependency,
  TL4: blockedIssues,
  TL5: labels,
  TL6: moveEpic,
  TL7: estimates,
  TL8: versionOpen,
  TL9: remoteLink,
};
