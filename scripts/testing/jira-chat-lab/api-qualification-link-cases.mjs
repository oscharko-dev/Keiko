import assert from "node:assert/strict";
import { read, readRecord, proof } from "./api-qualification-read.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import {
  adminMutationCase,
  observeAdminActor,
  nativeSnapshot,
} from "./api-qualification-admin-cases.mjs";
import {
  createQualificationIssue,
  fixtureWrite,
  issueReview,
} from "./api-qualification-fixtures.mjs";
import { assertSessionServerInfo, labSessionConnection, loadSession } from "./lab-client.mjs";

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
  adminMutationCase(
    "jira.create-reciprocal-remote-link",
    (f) => ({
      expectedActorKey: f.adminActorKey,
      expectedIssue: f.reciprocalIssue,
      expectedApplication: f.reciprocalApplication,
      remoteIssueId: f.reciprocalTarget.id,
      remoteIssueTitle: f.reciprocalTarget.key,
      sourceRelationship: "relates to",
      targetRelationship: "related by",
      expectLocalLinkAbsent: true,
      acceptNativeDelegatedEffect: true,
    }),
    reciprocalReadback,
    prepareReciprocalFixture,
  ),
];

const applicationPath = "/rest/applinks/1.0/listApplicationlinks";
const manifestPath = "/rest/applinks/1.0/manifest";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
async function manifest(c) {
  assertSessionServerInfo(c.session, await read(c, "/rest/api/2/serverInfo"));
  const value = await read(c, manifestPath);
  assert.match(value.id, uuid);
  assert.equal(value.typeId, "jira");
  assert.equal(typeof value.name, "string");
  return value;
}
async function configuredApplication(c, peerSession, expectedManifest) {
  const value = await read(c, applicationPath);
  assert.ok(Array.isArray(value.list));
  const matches = value.list.filter((row) => row.application?.id === expectedManifest.id);
  assert.equal(
    matches.length,
    1,
    "Reciprocal qualification requires a configured link to the owned peer manifest",
  );
  const [row] = matches;
  assert.equal(row.appLinkState, "OK");
  assert.equal(row.hasIncomingAuthenticationProviders, true);
  assert.equal(row.hasOutgoingAuthenticationProviders, true);
  assert.equal(row.application.typeId, "jira");
  assert.equal(row.application.name, expectedManifest.name);
  const origin = labSessionConnection(peerSession).httpsOrigin;
  assert.equal(row.application.displayUrl, origin);
  assert.equal(row.application.rpcUrl, origin);
  return nativeSnapshot(row.application, ["id", "name", "displayUrl", "rpcUrl"]);
}
const globalId = (applicationId, issueId) => `appId=${applicationId}&issueId=${issueId}`;
async function absentRemote(c, issueKey, selectedGlobalId) {
  const rows = await read(c, `/rest/api/2/issue/${issueKey}/remotelink`);
  assert.ok(Array.isArray(rows));
  assert.equal(
    rows.some((row) => row.globalId === selectedGlobalId),
    false,
  );
}
async function prepareReciprocalFixture(c, f) {
  const peer = c.qualificationReciprocalPeer;
  assert.ok(
    peer?.session?.directory && peer.issueKey,
    "Reciprocal qualification requires an operator-supplied owned peer session and synthetic KEIKO issue, distinct Jira manifests, mutually authenticated native application links, and independent credentials for both instances",
  );
  const session = loadSession(peer.session.directory);
  assert.notEqual(session.project, c.session.project);
  assert.notEqual(labSessionConnection(session).origin, labSessionConnection(c.session).origin);
  assert.match(peer.issueKey, /^KEIKO-[1-9]\d*$/u);
  const peerContext = { session, actor: "admin" };
  await observeAdminActor(c, f);
  const remoteActor = await read(peerContext, "/rest/api/2/myself");
  assert.equal(remoteActor.name, "keiko-admin");
  assert.equal(typeof remoteActor.key, "string");
  const localManifest = await manifest(c);
  const peerManifest = await manifest(peerContext);
  assert.notEqual(localManifest.id.toLowerCase(), peerManifest.id.toLowerCase());
  f.reciprocalApplication = await configuredApplication(c, session, peerManifest);
  await configuredApplication(peerContext, c.session, localManifest);
  f.reciprocalTarget = issueReview(await read(peerContext, `/rest/api/2/issue/${peer.issueKey}`));
  assert.equal(f.reciprocalTarget.key, peer.issueKey);
  assert.match(f.reciprocalTarget.summary, /^Synthetic AC7 /u);
  assert.equal(
    f.reciprocalTarget.projectId,
    String((await read(peerContext, "/rest/api/2/project/KEIKO")).id),
  );
  f.reciprocalIssue = issueReview(await createQualificationIssue(c, f, "reciprocal source"));
  f.reciprocalPeerContext = peerContext;
  f.reciprocalLocalManifest = localManifest;
  await absentRemote(c, f.reciprocalIssue.key, globalId(peerManifest.id, f.reciprocalTarget.id));
  await absentRemote(
    peerContext,
    f.reciprocalTarget.key,
    globalId(localManifest.id, f.reciprocalIssue.id),
  );
}
async function assertReciprocalSide(c, issue, expected) {
  const rows = await read(c, `/rest/api/2/issue/${issue.key}/remotelink`);
  assert.ok(Array.isArray(rows));
  const found = rows.filter((row) => row.globalId === expected.globalId);
  assert.equal(
    found.length,
    1,
    "The reciprocal effect requires independent matching links on both owned Jira instances",
  );
  const actual = remoteLinkReview(
    await readRecord(
      c,
      String(found[0].id),
      `/rest/api/2/issue/${issue.key}/remotelink/${found[0].id}`,
    ),
  );
  for (const [field, value] of Object.entries(expected)) assert.equal(actual[field], value);
}
async function reciprocalReadback(c, _data, f) {
  await assertReciprocalSide(c, f.reciprocalIssue, {
    globalId: globalId(f.reciprocalApplication.id, f.reciprocalTarget.id),
    applicationType: "com.atlassian.jira",
    applicationName: f.reciprocalApplication.name,
    relationship: "relates to",
    url: `${f.reciprocalApplication.displayUrl}/browse/${f.reciprocalTarget.id}`,
    title: f.reciprocalTarget.key,
  });
  await assertReciprocalSide(f.reciprocalPeerContext, f.reciprocalTarget, {
    globalId: globalId(f.reciprocalLocalManifest.id, f.reciprocalIssue.id),
    applicationType: "com.atlassian.jira",
    applicationName: f.reciprocalLocalManifest.name,
    relationship: "related by",
    url: `${labSessionConnection(c.session).httpsOrigin}/browse/${f.reciprocalIssue.id}`,
    title: f.reciprocalIssue.key,
    summary: f.reciprocalIssue.summary,
  });
  return proof(15);
}
