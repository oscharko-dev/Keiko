import assert from "node:assert/strict";
import { basicAuth, labRequest } from "./lab-client.mjs";
import { read, proof } from "./api-qualification-read.mjs";
import { adminMutationCase, observeAdminActor } from "./api-qualification-admin-cases.mjs";
import {
  createQualificationIssue,
  ensureAdminProjectPermission,
  fixtureWrite,
  issueReview,
} from "./api-qualification-fixtures.mjs";

const actorArgs = (f) => ({ expectedActorKey: f.adminActorKey, confirmUnverifiedEffect: true });
async function parent(c, f, label) {
  await observeAdminActor(c, f);
  f.lifecycleIssue = issueReview(await createQualificationIssue(c, f, label));
}
async function archiveState(c, f, archived) {
  const actual = await read(
    c,
    `/rest/api/2/issue/${f.lifecycleIssue.id}?fields=summary,project,issuetype,archived`,
  );
  assert.deepEqual(issueReview(actual), f.lifecycleIssue);
  const supplied = Object.hasOwn(actual, "archived") ? actual.archived : actual.fields.archived;
  assert.equal(
    supplied,
    archived,
    "Only an explicit native archived flag proves the requested state",
  );
  return proof(6);
}
export const API_QUALIFICATION_ISSUE_LIFECYCLE_CASES = [
  adminMutationCase(
    "jira.create-issues",
    (f) => ({
      ...actorArgs(f),
      issues: [1, 2].map((index) => ({
        projectId: f.projectId,
        issueTypeId: f.issueTypeId,
        fields: { summary: `Synthetic AC7 bulk ${index} ${f.runId}` },
      })),
    }),
    async (c, data, f) => {
      assert.ok(Array.isArray(data.issueKeys) && data.issueKeys.length === 2);
      assert.equal(new Set(data.issueKeys).size, 2);
      const observed = [];
      await data.issueKeys.reduce(async (previous, key) => {
        await previous;
        const actual = await read(c, `/rest/api/2/issue/${key}`);
        assert.equal(actual.key, key);
        assert.equal(actual.fields.project.id, f.projectId);
        assert.equal(actual.fields.issuetype.id, f.issueTypeId);
        observed.push(actual.fields.summary);
      }, Promise.resolve());
      assert.deepEqual(
        new Set(observed),
        new Set([1, 2].map((index) => `Synthetic AC7 bulk ${index} ${f.runId}`)),
      );
      return proof(9);
    },
  ),
  adminMutationCase(
    "jira.archive-issue",
    (f) => ({ ...actorArgs(f), expectedIssue: f.lifecycleIssue }),
    (c, _data, f) => archiveState(c, f, true),
    (c, f) => parent(c, f, "archive"),
  ),
  adminMutationCase(
    "jira.restore-issue",
    (f) => ({ ...actorArgs(f), expectedIssue: f.lifecycleIssue }),
    (c, _data, f) => archiveState(c, f, false),
    async (c, f) => {
      await observeAdminActor(c, f);
      await archiveState(c, f, true);
    },
  ),
  adminMutationCase(
    "jira.archive-issues",
    (f) => ({ ...actorArgs(f), expectedIssues: [f.lifecycleIssue] }),
    (c, _data, f) => archiveState(c, f, true),
    (c, f) => parent(c, f, "bulk archive"),
  ),
  adminMutationCase(
    "jira.pin-comment",
    (f) => ({
      expectedActorKey: f.adminActorKey,
      issueId: f.lifecycleIssue.id,
      issueKey: f.lifecycleIssue.key,
      commentId: f.pinCommentId,
      expectedBody: "Synthetic AC7 pinned comment",
    }),
    async (c, _data, f) => {
      const comment = await read(
        c,
        `/rest/api/2/issue/${f.lifecycleIssue.id}/comment/${f.pinCommentId}`,
      );
      assert.equal(comment.id, f.pinCommentId);
      assert.equal(comment.body, "Synthetic AC7 pinned comment");
      const pinned = await read(c, `/rest/api/2/issue/${f.lifecycleIssue.id}/pinned-comments`);
      assert.ok(Array.isArray(pinned));
      assert.equal(
        pinned.filter((row) => row.id === f.pinCommentId && row.body === comment.body).length,
        1,
      );
      return proof(4);
    },
    async (c, f) => {
      await parent(c, f, "pin");
      await fixtureWrite(
        c,
        "jira.comment",
        { issueKey: f.lifecycleIssue.key, body: "Synthetic AC7 pinned comment" },
        async (context, data) => {
          const comment = await read(
            context,
            `/rest/api/2/issue/${f.lifecycleIssue.id}/comment/${data.commentId}`,
          );
          assert.equal(comment.body, "Synthetic AC7 pinned comment");
          f.pinCommentId = comment.id;
          return proof(2);
        },
      );
    },
  ),
  adminMutationCase(
    "jira.move-subtask",
    (f) => ({
      ...actorArgs(f),
      expectedIssue: f.lifecycleIssue,
      expectedSubtasks: f.subtasksBefore,
      originalPosition: 0,
      currentPosition: 1,
    }),
    async (c, _data, f) => {
      const actual = await read(c, `/rest/api/2/issue/${f.lifecycleIssue.id}/subtask`);
      assert.deepEqual(
        actual.map((row) => ({ id: String(row.id), key: row.key })),
        [f.subtasksBefore[1], f.subtasksBefore[0]],
      );
      assert.deepEqual(
        issueReview(await read(c, `/rest/api/2/issue/${f.lifecycleIssue.id}`)),
        f.lifecycleIssue,
      );
      return proof(3);
    },
    async (c, f) => {
      await parent(c, f, "subtask parent");
      const project = await read(c, "/rest/api/2/project/KEIKO");
      const type = project.issueTypes.find((row) => row.subtask === true);
      assert.ok(type?.id);
      await createQualificationIssue(c, f, "subtask first", String(type.id), {
        parent: { key: f.lifecycleIssue.key },
      });
      await createQualificationIssue(c, f, "subtask second", String(type.id), {
        parent: { key: f.lifecycleIssue.key },
      });
      const children = await read(c, `/rest/api/2/issue/${f.lifecycleIssue.id}/subtask`);
      f.subtasksBefore = children.map((row) => ({ id: String(row.id), key: row.key }));
      assert.equal(f.subtasksBefore.length, 2);
    },
  ),
  adminMutationCase(
    "jira.delete-issue",
    (f) => ({ ...actorArgs(f), expectedIssue: f.lifecycleIssue, expectedSubtasks: [] }),
    async (c, _data, f) => {
      assert.ok(f.lifecycleIssue.id && f.lifecycleIssue.key);
      const response = await labRequest(
        c.session,
        "GET",
        `/rest/api/2/issue/${f.lifecycleIssue.id}`,
        basicAuth(c.session, c.actor),
      );
      assert.equal(response.status, 404);
      const project = await read(c, "/rest/api/2/project/KEIKO");
      assert.equal(String(project.id), f.lifecycleIssue.projectId);
      return proof(3);
    },
    async (c, f) => {
      await ensureAdminProjectPermission(c, "DELETE_ISSUES");
      await parent(c, f, "delete");
    },
  ),
];
