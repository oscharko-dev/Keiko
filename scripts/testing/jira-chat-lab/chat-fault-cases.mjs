import assert from "node:assert/strict";
import { actorDetails, basicAuth, checked } from "./lab-client.mjs";
import { commentState } from "./chat-write.mjs";
import { issueState, projectState, remoteRead } from "./catalog-state.mjs";

async function action(session, fixture, operation, key, marker) {
  if (operation === "jira.create") {
    const project = await remoteRead(session, "/rest/api/2/project/KEIKO");
    const fields = { summary: marker, [fixture.requiredFieldId]: "Synthetic fault required value" };
    return {
      args: { projectId: project.id, issueTypeId: fixture.issueTypeId, fields },
      target: {
        method: "POST",
        path: "/rest/api/2/issue",
        body: {
          fields: {
            ...fields,
            project: { id: project.id },
            issuetype: { id: fixture.issueTypeId },
          },
          update: {},
        },
      },
    };
  }
  return existingIssueAction(session, fixture, operation, key, marker);
}

async function existingIssueAction(session, fixture, operation, key, marker) {
  const path = `/rest/api/2/issue/${encodeURIComponent(key)}`;
  if (operation === "jira.edit") {
    const fields = { summary: marker };
    return {
      args: { issueKey: key, fields },
      target: { method: "PUT", path, body: { fields, update: {} } },
    };
  }
  if (operation === "jira.assign") {
    const name = actorDetails("assignee").name;
    return {
      args: { issueKey: key, assigneeName: name },
      target: { method: "PUT", path: `${path}/assignee`, body: { name } },
    };
  }
  if (operation === "jira.comment")
    return {
      args: { issueKey: key, body: marker },
      target: { method: "POST", path: `${path}/comment`, body: { body: marker } },
    };
  assert.equal(operation, "jira.transition");
  const metadata = await remoteRead(session, `${path}/transitions?expand=transitions.fields`);
  const transition = metadata.transitions.find((item) => item.name === "Done");
  assert.ok(transition?.fields[fixture.requiredFieldId]?.required);
  const resolutionId = transition.fields.resolution.allowedValues[0].id;
  assert.equal(typeof resolutionId, "string");
  const fields = { [fixture.requiredFieldId]: marker, resolution: { id: resolutionId } };
  return {
    args: { issueKey: key, transitionId: transition.id, fields },
    target: {
      method: "POST",
      path: `${path}/transitions`,
      body: { fields, update: {}, transition: { id: transition.id } },
    },
    targetStatusId: transition.to.id,
  };
}

export async function prepareFaultCase(session, fixture, operation, key, marker) {
  const selected = await action(session, fixture, operation, key, marker);
  const before = await projectState(session);
  const original =
    key === undefined ? undefined : await issueState(session, key, fixture.requiredFieldId);
  const comments =
    operation === "jira.comment" ? await commentState(session, key, marker) : undefined;
  return {
    operation,
    arguments: selected.args,
    target: selected.target,
    targetStatusId: selected.targetStatusId,
    marker,
    key,
    before,
    original,
    comments,
    fieldId: fixture.requiredFieldId,
  };
}

export async function observeFaultEffect(session, current) {
  const project = await projectState(session);
  let key = current.key;
  if (current.operation === "jira.create") {
    const matching = project.issues.filter((issue) => issue.fields.summary === current.marker);
    assert.equal(project.count, current.before.count + 1);
    assert.equal(matching.length, 1);
    key = matching[0].key;
  } else assert.equal(project.count, current.before.count);
  const issue = await issueState(session, key, current.fieldId);
  await verifyMutationEffect(session, current, key, issue);
  const comments =
    current.operation === "jira.comment"
      ? await commentState(session, key, current.marker)
      : undefined;
  return { project, issue, ...(comments === undefined ? {} : { comments }), key };
}

async function verifyMutationEffect(session, current, key, issue) {
  switch (current.operation) {
    case "jira.create":
      assert.equal(issue.fields[current.fieldId], current.arguments.fields[current.fieldId]);
      break;
    case "jira.edit":
      assert.equal(issue.fields.summary, current.marker);
      break;
    case "jira.assign":
      assert.equal(issue.fields.assignee?.name, current.arguments.assigneeName);
      break;
    case "jira.comment":
      assert.deepEqual(await commentState(session, key, current.marker), {
        total: current.comments.total + 1,
        matches: 1,
      });
      break;
    case "jira.transition":
      assert.equal(issue.fields.status.id, current.targetStatusId);
      assert.equal(issue.fields.resolution.id, current.arguments.fields.resolution.id);
      assert.equal(issue.fields[current.fieldId], current.marker);
      break;
    default:
      throw new TypeError("Unknown mutation qualification");
  }
  if (current.target.method === "PUT" || current.operation === "jira.transition")
    assert.equal(issue.historyCount, current.original.historyCount + 1);
}

/** Deliberate independent fixture edit, recorded separately from the single Chat effect. */
export async function applyForeignPut(session, current, observed) {
  if (current.target.method !== "PUT") return observed;
  const assignment = current.operation === "jira.assign";
  const body = assignment
    ? { name: actorDetails("api").name }
    : { fields: { summary: `Synthetic foreign ${current.id}` } };
  await checked(
    session,
    "fault-foreign-put",
    "PUT",
    current.target.path,
    basicAuth(session, "api"),
    body,
  );
  const after = await readFaultState(session, current, observed.key);
  assert.equal(after.issue.historyCount, observed.issue.historyCount + 1);
  if (assignment) assert.equal(after.issue.fields.assignee.name, body.name);
  else assert.equal(after.issue.fields.summary, body.fields.summary);
  return after;
}

export async function readFaultState(session, current, key) {
  return {
    project: await projectState(session),
    issue: await issueState(session, key, current.fieldId),
    ...(current.operation === "jira.comment"
      ? { comments: await commentState(session, key, current.marker) }
      : {}),
    key,
  };
}
