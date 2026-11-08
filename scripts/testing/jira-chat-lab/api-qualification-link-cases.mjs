import assert from "node:assert/strict";
import { read, readRecord, proof } from "./api-qualification-read.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import {
  adminMutationCase,
  observeAdminActor,
  nativeSnapshot,
} from "./api-qualification-admin-cases.mjs";
import { createQualificationIssue, fixtureWrite } from "./api-qualification-fixtures.mjs";
import { labSessionConnection } from "./lab-client.mjs";

const issuePath = (f) => `/rest/api/2/issue/${f.linkIssue.key}`;
const remotePath = (f) => `${issuePath(f)}/remotelink`;
async function linkRows(c, issue) {
  const value = await read(c, `/rest/api/2/issue/${issue.key}?fields=issuelinks`);
  assert.equal(value.key, issue.key);
  assert.ok(Array.isArray(value.fields.issuelinks));
  return value.fields.issuelinks;
}
const remoteFields = {
  globalId: "globalId",
  applicationType: "application.type",
  applicationName: "application.name",
  relationship: "relationship",
  url: "object.url",
  title: "object.title",
  summary: "object.summary",
  iconUrl: "object.icon.url16x16",
  iconTitle: "object.icon.title",
  resolved: "object.status.resolved",
  statusIconUrl: "object.status.icon.url16x16",
  statusIconTitle: "object.status.icon.title",
  statusIconLink: "object.status.icon.link",
};
const remoteField = (value, path) =>
  path.split(".").reduce((raw, key) => raw?.[key], value) ?? null;
export function remoteLinkReview(value) {
  assert.match(String(value.id), /^[1-9]\d*$/u);
  assert.equal(typeof value.object?.url, "string");
  assert.equal(typeof value.object?.title, "string");
  return {
    id: String(value.id),
    ...Object.fromEntries(
      Object.entries(remoteFields).map(([field, path]) => [field, remoteField(value, path)]),
    ),
  };
}
const desiredRemote = (c, f, label) => ({
  globalId: `keiko-ac7:${f.runId}:${label}`,
  applicationType: null,
  applicationName: null,
  relationship: "relates to",
  url: `${labSessionConnection(c.session).httpsOrigin}/browse/${f.linkTarget.key}`,
  title: `Synthetic AC7 ${label}`,
  summary: "Synthetic relationship",
  iconUrl: null,
  iconTitle: null,
  resolved: false,
  statusIconUrl: null,
  statusIconTitle: null,
  statusIconLink: null,
});
async function remote(c, f) {
  await observeAdminActor(c, f);
  const rows = await read(c, remotePath(f));
  assert.ok(Array.isArray(rows));
  const found = rows.filter((row) => String(row.id) === f.remoteLinkId);
  assert.equal(found.length, 1);
  f.remoteBefore = remoteLinkReview(found[0]);
}
async function assertRemote(c, f, value) {
  const rows = await read(c, remotePath(f));
  assert.ok(Array.isArray(rows));
  const found = rows.filter((row) => row.globalId === value.globalId);
  assert.equal(found.length, 1);
  const actual = remoteLinkReview(
    await readRecord(c, String(found[0].id), `${remotePath(f)}/${found[0].id}`),
  );
  assert.deepEqual(actual, { id: actual.id, ...value });
  f.remoteLinkId = actual.id;
  return proof(15);
}
const remoteArgs = (f) => ({
  expectedActorKey: f.adminActorKey,
  issueIdOrKey: f.linkIssue.key,
  expected: f.remoteBefore,
});
async function remoteDeleted(c, _data, f) {
  assert.equal(String((await read(c, issuePath(f))).id), String(f.linkIssue.id));
  const rows = await read(c, remotePath(f));
  assert.ok(Array.isArray(rows));
  assert.equal(
    rows.some(
      (row) => String(row.id) === f.remoteBefore.id || row.globalId === f.remoteBefore.globalId,
    ),
    false,
  );
  return proof(3);
}
export const API_QUALIFICATION_LINK_CASES = [
  adminMutationCase(
    "jira.create-issue-link",
    (f) => ({
      expectedActorKey: f.adminActorKey,
      inwardIssueIdOrKey: f.linkIssue.key,
      outwardIssueIdOrKey: f.linkTarget.key,
      linkType: f.linkType,
    }),
    async (c, _data, f) => {
      const found = (await linkRows(c, f.linkIssue)).filter(
        (row) =>
          String(row.type.id) === f.linkType.id && row.outwardIssue?.key === f.linkTarget.key,
      );
      assert.equal(found.length, 1);
      f.issueLinkId = String(found[0].id);
      const reciprocal = (await linkRows(c, f.linkTarget)).filter(
        (row) => String(row.id) === f.issueLinkId,
      );
      assert.equal(reciprocal.length, 1);
      assert.equal(String(reciprocal[0].type.id), f.linkType.id);
      assert.equal(reciprocal[0].inwardIssue?.key, f.linkIssue.key);
      return proof(5);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      f.linkIssue = await createQualificationIssue(c, f, "link source");
      f.linkTarget = await createQualificationIssue(c, f, "link target");
      const types = await read(c, "/rest/api/2/issueLinkType");
      assert.ok(Array.isArray(types.issueLinkTypes) && types.issueLinkTypes.length > 0);
      f.linkType = nativeSnapshot(types.issueLinkTypes[0], ["id", "name", "inward", "outward"]);
      assert.deepEqual(await linkRows(c, f.linkIssue), []);
      assert.deepEqual(await linkRows(c, f.linkTarget), []);
    },
  ),
  adminMutationCase(
    "jira.delete-issue-link",
    (f) => ({
      expectedActorKey: f.adminActorKey,
      inwardIssueIdOrKey: f.linkIssue.key,
      outwardIssueIdOrKey: f.linkTarget.key,
      linkType: f.linkType,
      linkId: f.issueLinkId,
    }),
    async (c, _data, f) => {
      for (const rows of await Promise.all([linkRows(c, f.linkIssue), linkRows(c, f.linkTarget)]))
        assert.equal(
          rows.some((row) => String(row.id) === f.issueLinkId),
          false,
        );
      return proof(4);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      await readRecord(c, f.issueLinkId, `/rest/api/2/issueLink/${f.issueLinkId}`);
    },
  ),
  adminMutationCase(
    "jira.upsert-remote-link",
    (f) => ({
      expectedActorKey: f.adminActorKey,
      issueIdOrKey: f.linkIssue.key,
      expectAbsent: true,
      value: f.remoteDesired,
    }),
    (c, _data, f) => assertRemote(c, f, f.remoteDesired),
    async (c, f) => {
      await observeAdminActor(c, f);
      f.remoteDesired = desiredRemote(c, f, "primary");
      const rows = await read(c, remotePath(f));
      assert.ok(Array.isArray(rows));
      assert.equal(
        rows.some((row) => row.globalId === f.remoteDesired.globalId),
        false,
      );
    },
  ),
  adminMutationCase(
    "jira.update-remote-link",
    (f) => ({
      ...remoteArgs(f),
      linkId: f.remoteLinkId,
      value: { ...f.remoteDesired, title: "Synthetic AC7 revised remote link" },
    }),
    async (c, _data, f) => {
      f.remoteDesired = { ...f.remoteDesired, title: "Synthetic AC7 revised remote link" };
      return assertRemote(c, f, f.remoteDesired);
    },
    remote,
  ),
  {
    ...readCase(
      "jira.remote-link",
      (f) => `${remotePath(f)}/${f.remoteLinkId}`,
      [
        "id",
        "globalId",
        "applicationType",
        "applicationName",
        "relationship",
        "url",
        "title",
        "summary",
        "iconUrl",
        "iconTitle",
        "resolved",
        "statusIconUrl",
        "statusIconTitle",
        "statusIconLink",
      ],
      {
        args: (f) => ({ issueIdOrKey: f.linkIssue.key, linkId: f.remoteLinkId }),
        nativeRoot: (value) => [remoteLinkReview(value)],
        productRoot: (data) => {
          assert.equal(data.reviewSnapshotAvailable, true);
          return [data.reviewSnapshot];
        },
      },
    ),
    actor: "admin",
    administration: true,
  },
  adminMutationCase(
    "jira.delete-remote-link",
    (f) => ({ ...remoteArgs(f), linkId: f.remoteLinkId }),
    remoteDeleted,
    remote,
  ),
  adminMutationCase(
    "jira.delete-remote-link-by-global-id",
    (f) => ({ ...remoteArgs(f), globalId: f.remoteBefore.globalId }),
    remoteDeleted,
    async (c, f) => {
      await observeAdminActor(c, f);
      f.remoteDesired = desiredRemote(c, f, "global deletion");
      await fixtureWrite(
        c,
        "jira.upsert-remote-link",
        {
          expectedActorKey: f.adminActorKey,
          issueIdOrKey: f.linkIssue.key,
          expectAbsent: true,
          value: f.remoteDesired,
        },
        (context) => assertRemote(context, f, f.remoteDesired),
      );
      await remote(c, f);
    },
  ),
];
