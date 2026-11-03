import assert from "node:assert/strict";
import { jiraReadQuestion } from "./catalog-questions.mjs";
import { URLSearchParams } from "node:url";
import { actorDetails, basicAuth, labRequest } from "./lab-client.mjs";
import { adminRead, RESTRICTED_REFUSAL_DIAGNOSTICS } from "./restricted-cases.mjs";

const WRITE_PERMISSIONS = [
  "CREATE_ISSUES",
  "EDIT_ISSUES",
  "ASSIGN_ISSUES",
  "ADD_COMMENTS",
  "TRANSITION_ISSUES",
];

function readDefinitions(fixture) {
  const key = fixture.isolationIssueKey;
  const projectKey = "ISOLATED";
  const page = { maxResults: 100 };
  const issue = `issue/${key}`;
  const create = `issue/createmeta/${projectKey}/issuetypes`;
  const query = actorDetails("admin").name;
  const jql = `project = ${projectKey} ORDER BY key`;
  return [
    ["jira.projects", page, "project", "key"],
    ["jira.issue-types", { projectKey, ...page }, `${create}?maxResults=100`, "id"],
    [
      "jira.create-fields",
      { projectKey, issueTypeId: fixture.issueTypeId, ...page },
      `${create}/${fixture.issueTypeId}?maxResults=100`,
      "id",
    ],
    ["jira.edit-fields", { issueKey: key, ...page }, `${issue}/editmeta`, "id"],
    [
      "jira.search",
      { jql, ...page },
      `search?${new URLSearchParams({ jql, maxResults: "100" })}`,
      "key",
    ],
    ["jira.issue", { issueKey: key }, issue, "key"],
    ["jira.comments", { issueKey: key, ...page }, `${issue}/comment?maxResults=100`, "id"],
    [
      "jira.transitions",
      { issueKey: key, ...page },
      `${issue}/transitions?expand=transitions.fields`,
      "id",
    ],
    [
      "jira.assignable-users",
      { issueKey: key, query, ...page },
      `user/assignable/search?${new URLSearchParams({ issueKey: key, username: query, maxResults: "100" })}`,
      "name",
    ],
  ];
}

function referenceItems(operation, raw) {
  switch (operation) {
    case "jira.projects":
    case "jira.assignable-users":
      return raw;
    case "jira.issue-types":
      return raw.values;
    case "jira.create-fields":
      return raw.values.map((field) => ({ id: field.fieldId }));
    case "jira.edit-fields":
      return Object.keys(raw.fields).map((id) => ({ id }));
    case "jira.search":
      return raw.issues;
    case "jira.issue":
      return [raw];
    case "jira.comments":
      return raw.comments;
    case "jira.transitions":
      return raw.transitions;
    default:
      throw new TypeError("Unknown restricted read reference");
  }
}

export function restrictedReadExpectation(operation, field, response) {
  if (operation === "jira.assignable-users" && response.status === 401)
    return {
      outcome: "cancelled",
      referenceStatus: 401,
      credentialInvalidationExpected: true,
    };
  if (response.status !== 200) {
    const reason = RESTRICTED_REFUSAL_DIAGNOSTICS.get(response.status);
    assert.ok(reason, "Only an actual Jira scope/permission refusal qualifies");
    return { outcome: "failed", reasons: [reason], referenceStatus: response.status };
  }
  const items = referenceItems(operation, response.value);
  assert.ok(Array.isArray(items) && items.length <= 100);
  const values = items.map((item) => item[field]);
  assert.ok(values.every((value) => typeof value === "string" && value.length > 0));
  assert.equal(new Set(values).size, values.length);
  if (operation === "jira.projects") assert.deepEqual(values, ["ISOLATED"]);
  if (operation === "jira.search")
    assert.ok(values.length > 0 && values.every((key) => key.startsWith("ISOLATED-")));
  return {
    outcome: "succeeded",
    referenceStatus: 200,
    readExpected: { field, values: values.toSorted() },
  };
}

async function restrictedReads(session, fixture) {
  const cases = [];
  for (const [operation, args, path, field] of readDefinitions(fixture)) {
    const response = await labRequest(
      session,
      "GET",
      `/rest/api/2/${path}`,
      basicAuth(session, "restricted"),
    );
    cases.push({
      id: `restricted-${operation}`,
      actor: "restricted",
      operation,
      question: jiraReadQuestion(operation),
      arguments: args,
      dispatches: 0,
      ...restrictedReadExpectation(operation, field, response),
    });
  }
  return cases;
}

async function requireRestrictedPermissions(session) {
  const auth = basicAuth(session, "restricted");
  const identity = await labRequest(session, "GET", "/rest/api/2/myself", auth);
  assert.equal(identity.status, 200);
  assert.equal(identity.value.name, actorDetails("restricted").name);
  const query = new URLSearchParams({
    projectKey: "ISOLATED",
    permissions: ["BROWSE_PROJECTS", ...WRITE_PERMISSIONS].join(","),
  });
  const response = await labRequest(session, "GET", `/rest/api/2/mypermissions?${query}`, auth);
  assert.equal(response.status, 200);
  assert.equal(response.value.permissions.BROWSE_PROJECTS.havePermission, true);
  for (const permission of WRITE_PERMISSIONS)
    assert.equal(response.value.permissions[permission].havePermission, false);
}

function permissionWrite(operation, args, target) {
  return {
    id: `restricted-${operation}`,
    actor: "restricted",
    operation,
    arguments: args,
    outcome: "unknown",
    dispatches: 1,
    statuses: [400, 403, 404],
    target,
    localRefusalAllowed: true,
    reasons: ["permission-denied", "not-found", "field-validation", "invalid-transition"],
  };
}

function transitionFields(fixture, transition, marker) {
  const fields = {};
  for (const [id, metadata] of Object.entries(transition.fields ?? {})) {
    if (!metadata.required || metadata.hasDefaultValue === true) continue;
    if (id === fixture.requiredFieldId) fields[id] = marker;
    else if (id === "resolution") fields[id] = { id: metadata.allowedValues[0].id };
    else throw new TypeError("Unsupported required transition fixture field");
  }
  return fields;
}

export function restrictedWriteCases(fixture, projectId, transition, id) {
  const key = fixture.isolationIssueKey;
  const marker = `Synthetic restricted catalog ${id}`;
  const path = `/rest/api/2/issue/${key}`;
  const fields = { summary: marker, [fixture.requiredFieldId]: "Synthetic required value" };
  const name = actorDetails("admin").name;
  const workflowFields = transitionFields(fixture, transition, marker);
  return [
    permissionWrite(
      "jira.create",
      { projectId, issueTypeId: fixture.issueTypeId, fields },
      {
        method: "POST",
        path: "/rest/api/2/issue",
        body: {
          fields: { ...fields, project: { id: projectId }, issuetype: { id: fixture.issueTypeId } },
          update: {},
        },
      },
    ),
    permissionWrite(
      "jira.edit",
      { issueKey: key, fields: { summary: marker } },
      { method: "PUT", path, body: { fields: { summary: marker }, update: {} } },
    ),
    permissionWrite(
      "jira.assign",
      { issueKey: key, assigneeName: name },
      { method: "PUT", path: `${path}/assignee`, body: { name } },
    ),
    permissionWrite(
      "jira.comment",
      { issueKey: key, body: marker },
      { method: "POST", path: `${path}/comment`, body: { body: marker } },
    ),
    permissionWrite(
      "jira.transition",
      { issueKey: key, transitionId: transition.id, fields: workflowFields },
      {
        method: "POST",
        path: `${path}/transitions`,
        body: { fields: workflowFields, update: {}, transition: { id: transition.id } },
      },
    ),
  ];
}

export async function restrictedCatalogCases(session, fixture, id) {
  await requireRestrictedPermissions(session);
  const reads = await restrictedReads(session, fixture);
  await requireRestrictedPermissions(session);
  const project = await adminRead(session, "/rest/api/2/project/ISOLATED");
  const metadata = await adminRead(
    session,
    `/rest/api/2/issue/${fixture.isolationIssueKey}/transitions?expand=transitions.fields`,
  );
  const transition = metadata.transitions.find((item) => item.name === "Done");
  assert.ok(
    transition,
    "An administrator-visible transition is required as the positive reference",
  );
  const assignmentAuthFailure = reads.some((read) => read.credentialInvalidationExpected);
  const writes = restrictedWriteCases(fixture, project.id, transition, id).map((write) =>
    assignmentAuthFailure && write.operation === "jira.assign"
      ? {
          ...write,
          outcome: "cancelled",
          dispatches: 0,
          credentialInvalidationExpected: true,
          expectedMutationOutcome: "rejected",
        }
      : write,
  );
  return [...reads, ...writes];
}
