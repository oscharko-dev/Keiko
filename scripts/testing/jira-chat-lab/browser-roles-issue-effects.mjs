import {
  definition,
  editBody,
  effectProof,
  exactBody,
  exactKeys,
  issueIdentity,
  issueRead,
  nativeId,
  oneNewNative,
  projectJql,
  requireRoleFact,
  roleRead,
  roleSearch,
  same,
} from "./browser-roles-oracles.mjs";

export const ROLE_TEXT = {
  subtask: "Verify the focused implementation",
  subtaskDescription: "Run the focused checks and record the result.",
  bug: "Regression blocks the story",
  bugDescription: "Synthetic defect observed while implementing the selected story.",
  worklog: "Implementation and focused verification.",
  comment: "Implemented and checked the scoped change.",
  pullRequest: "https://github.com/example/roles-qualification/pull/42",
  pullRequestTitle: "Implementation pull request",
};
export function referenceIds(values) {
  requireRoleFact(Array.isArray(values));
  return values.map(({ id }) => nativeId(id));
}
function verifyEditedField(after, field, expected) {
  if (field === "components" || field === "fixVersions") {
    exactKeys(
      referenceIds(after.fields[field]),
      expected.map(({ id }) => nativeId(id)),
    );
  } else requireRoleFact(same(after.fields[field], expected));
}
export async function editRoleIssues(environment, meta, issues, changes, prompt) {
  const before = await Promise.all(issues.map(({ key }) => issueRead(environment, key)));
  const fields = before.map((issue, index, issuesBefore) => changes(issue, index, issuesBefore));
  return definition(
    meta,
    prompt,
    issues.map((issue, index) => ({
      method: "PUT",
      path: `/rest/api/2/issue/${issue.key}`,
      admit: (body) => editBody(body, fields[index]),
    })),
    async (turn) => {
      for (const [index, selected] of issues.entries()) {
        const after = await issueRead(environment, selected.key);
        issueIdentity(after, selected, environment.fixture.project);
        for (const [field, expected] of Object.entries(fields[index]))
          verifyEditedField(after, field, expected);
      }
      return effectProof(turn, meta.operations, { issuesChanged: issues.length });
    },
  );
}
export async function blocksType(environment) {
  const types = await roleRead(environment, "/rest/api/2/issueLinkType");
  requireRoleFact(Array.isArray(types.issueLinkTypes));
  const selected = types.issueLinkTypes.filter((type) => type.name === "Blocks");
  requireRoleFact(
    selected.length === 1 &&
      selected[0].outward === "blocks" &&
      selected[0].inward === "is blocked by",
  );
  return selected[0];
}
export function blocksBody(type, blocker, blocked) {
  return {
    type: { id: nativeId(type.id) },
    inwardIssue: { id: nativeId(blocker.id) },
    outwardIssue: { id: nativeId(blocked.id) },
  };
}
export async function verifyBlockingLink(environment, type, blocker, blocked) {
  const left = await issueRead(environment, blocker.key);
  const right = await issueRead(environment, blocked.key);
  issueIdentity(left, blocker, environment.fixture.project);
  issueIdentity(right, blocked, environment.fixture.project);
  const matches = (issue, side, target) =>
    issue.fields.issuelinks.filter(
      (link) =>
        nativeId(link.type.id) === nativeId(type.id) &&
        link[side] !== undefined &&
        nativeId(link[side].id) === nativeId(target.id),
    );
  const outward = matches(left, "outwardIssue", blocked);
  const inward = matches(right, "inwardIssue", blocker);
  requireRoleFact(
    outward.length === 1 &&
      inward.length === 1 &&
      nativeId(outward[0].id) === nativeId(inward[0].id),
  );
}
export async function linkRoleIssues(environment, meta, blocker, blocked, prompt) {
  const type = await blocksType(environment);
  return definition(
    meta,
    prompt,
    [
      {
        method: "POST",
        path: "/rest/api/2/issueLink",
        admit: (body) => exactBody(body, blocksBody(type, blocker, blocked)),
      },
    ],
    async (turn) => {
      await verifyBlockingLink(environment, type, blocker, blocked);
      return effectProof(turn, meta.operations, { linksCreated: 1 });
    },
  );
}
export async function roleIssueCreation(environment, kind, summary, description, parent) {
  const before = await roleSearch(environment, projectJql(environment));
  const project = await roleRead(
    environment,
    `/rest/api/2/project/${environment.fixture.project.id}`,
  );
  requireRoleFact(Array.isArray(project.issueTypes));
  const types = project.issueTypes.filter((type) =>
    kind === "Subtask" ? type.subtask === true : type.name === kind && type.subtask === false,
  );
  requireRoleFact(types.length === 1);
  const fields = {
    project: { id: nativeId(project.id) },
    issuetype: { id: nativeId(types[0].id) },
    summary,
    description,
    ...(parent ? { parent: { id: nativeId(parent.id) } } : {}),
  };
  const created = async () => {
    const added = oneNewNative(
      before,
      await roleSearch(environment, projectJql(environment)),
      (issue) => issue.fields.summary === summary,
    );
    const after = await issueRead(environment, added.key);
    issueIdentity(after, added, environment.fixture.project);
    requireRoleFact(
      after.fields.summary === summary &&
        after.fields.description === description &&
        nativeId(after.fields.issuetype.id) === fields.issuetype.id,
    );
    if (parent) requireRoleFact(nativeId(after.fields.parent?.id) === nativeId(parent.id));
    return after;
  };
  return {
    wire: {
      method: "POST",
      path: "/rest/api/2/issue",
      admit: (body) => exactBody(body, { fields, update: {} }),
    },
    created,
  };
}
