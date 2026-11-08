// Issue effects are sent only by the governed catalog; these reads are independent oracles.
import assert from "node:assert/strict";
import { basicAuth, labRequest } from "./lab-client.mjs";

async function read(context, path) {
  const response = await labRequest(
    context.session,
    "GET",
    path,
    basicAuth(context.session, context.actor),
  );
  assert.equal(response.status, 200);
  return response.value;
}
const issuePath = (fixture) => `/rest/api/2/issue/${fixture.createdIssueKey}`;
const key = (fixture) => {
  assert.match(fixture.createdIssueKey, /^KEIKO-[1-9][0-9]*$/u);
  return fixture.createdIssueKey;
};
const proof = (assertionCount) => ({ matched: true, assertionCount });
const mutation = (tool, args, readback) => ({ tool, mutation: true, arguments: args, readback });
const COMMENT = "Synthetic AC7 qualification comment";
const UPDATED_COMMENT = "Synthetic AC7 qualification comment updated";
const STARTED = "2026-11-08T08:00:00.000+0000";

export const API_QUALIFICATION_ISSUE_CASES = [
  mutation(
    "jira.create",
    (f) => ({
      projectId: f.projectId,
      issueTypeId: f.issueTypeId,
      fields: {
        summary: `Synthetic AC7 ${f.runId}`,
        description: "Synthetic qualification fixture.",
      },
    }),
    async (context, data, f) => {
      assert.match(data.issueKey, /^KEIKO-[1-9][0-9]*$/u);
      const actual = await read(context, `/rest/api/2/issue/${data.issueKey}`);
      assert.equal(actual.key, data.issueKey);
      assert.equal(actual.fields.summary, `Synthetic AC7 ${f.runId}`);
      assert.equal(actual.fields.project.id, f.projectId);
      assert.equal(actual.fields.issuetype.id, f.issueTypeId);
      f.createdIssueKey = actual.key;
      f.createdIssueId = actual.id;
      return proof(5);
    },
  ),
  mutation(
    "jira.edit",
    (f) => ({ issueKey: key(f), fields: { description: "Synthetic AC7 edited description." } }),
    async (context, _data, f) => {
      const actual = await read(context, issuePath(f));
      assert.equal(actual.key, key(f));
      assert.equal(actual.fields.description, "Synthetic AC7 edited description.");
      return proof(2);
    },
  ),
  mutation(
    "jira.assign",
    (f) => ({ issueKey: key(f), assigneeName: "keiko-assignee" }),
    async (context, _data, f) => {
      const actual = await read(context, issuePath(f));
      assert.equal(actual.key, key(f));
      assert.equal(actual.fields.assignee.name, "keiko-assignee");
      return proof(2);
    },
  ),
  mutation(
    "jira.comment",
    (f) => ({ issueKey: key(f), body: COMMENT }),
    async (context, data, f) => {
      assert.match(data.commentId, /^[1-9][0-9]*$/u);
      const actual = await read(context, `${issuePath(f)}/comment/${data.commentId}`);
      assert.equal(actual.id, data.commentId);
      assert.equal(actual.body, COMMENT);
      f.commentId = actual.id;
      return proof(3);
    },
  ),
  mutation(
    "jira.update-comment",
    (f) => ({ issueKey: key(f), commentId: f.commentId, body: UPDATED_COMMENT }),
    async (context, _data, f) => {
      const actual = await read(context, `${issuePath(f)}/comment/${f.commentId}`);
      assert.equal(actual.id, f.commentId);
      assert.equal(actual.body, UPDATED_COMMENT);
      return proof(2);
    },
  ),
  mutation(
    "jira.delete-comment",
    (f) => ({ issueKey: key(f), commentId: f.commentId, expectedBody: UPDATED_COMMENT }),
    async (context, _data, f) => {
      const issue = await read(context, issuePath(f));
      assert.equal(issue.key, key(f));
      const comments = await read(context, `${issuePath(f)}/comment?maxResults=100`);
      assert.equal(comments.total, comments.comments.length);
      assert.equal(
        comments.comments.some((comment) => comment.id === f.commentId),
        false,
      );
      return proof(3);
    },
  ),
  mutation(
    "jira.watch",
    (f) => ({ issueKey: key(f) }),
    async (context, _data, f) => {
      const actual = await read(context, `${issuePath(f)}/watchers`);
      assert.equal(actual.isWatching, true);
      assert.equal(actual.watchers.filter((user) => user.key === f.actorKey).length, 1);
      return proof(2);
    },
  ),
  mutation(
    "jira.unwatch",
    (f) => ({ issueKey: key(f) }),
    async (context, _data, f) => {
      const actual = await read(context, `${issuePath(f)}/watchers`);
      assert.equal(actual.isWatching, false);
      assert.equal(actual.watchers.filter((user) => user.key === f.actorKey).length, 0);
      return proof(2);
    },
  ),
  mutation(
    "jira.create-worklog",
    (f) => ({ issueKey: key(f), timeSpentSeconds: 600, started: STARTED, comment: COMMENT }),
    async (context, data, f) => {
      assert.match(data.worklogId, /^[1-9][0-9]*$/u);
      const actual = await read(context, `${issuePath(f)}/worklog/${data.worklogId}`);
      assert.equal(actual.id, data.worklogId);
      assert.equal(actual.timeSpentSeconds, 600);
      assert.equal(Date.parse(actual.started), Date.parse(STARTED));
      assert.equal(actual.comment, COMMENT);
      f.worklogId = actual.id;
      return proof(5);
    },
  ),
  mutation(
    "jira.update-worklog",
    (f) => ({ issueKey: key(f), worklogId: f.worklogId, timeSpentSeconds: 900 }),
    async (context, _data, f) => {
      const actual = await read(context, `${issuePath(f)}/worklog/${f.worklogId}`);
      assert.equal(actual.id, f.worklogId);
      assert.equal(actual.timeSpentSeconds, 900);
      assert.equal(Date.parse(actual.started), Date.parse(STARTED));
      assert.equal(actual.comment, COMMENT);
      return proof(4);
    },
  ),
  mutation(
    "jira.delete-worklog",
    (f) => ({
      issueKey: key(f),
      worklogId: f.worklogId,
      timeSpentSeconds: 900,
      started: STARTED,
      comment: COMMENT,
      visibility: null,
    }),
    async (context, _data, f) => {
      const issue = await read(context, issuePath(f));
      assert.equal(issue.key, key(f));
      const actual = await read(context, `${issuePath(f)}/worklog?maxResults=100`);
      assert.equal(actual.total, actual.worklogs.length);
      assert.equal(
        actual.worklogs.some((worklog) => worklog.id === f.worklogId),
        false,
      );
      return proof(3);
    },
  ),
];
