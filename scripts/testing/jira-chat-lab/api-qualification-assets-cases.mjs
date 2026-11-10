// Exact AC7 asset identities. Every effect uses the existing governed catalog and journal.
import assert from "node:assert/strict";
import { basicAuth, labRequest } from "./lab-client.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import { observeAdminActor, adminMutationCase } from "./api-qualification-admin-cases.mjs";
import {
  createQualificationIssue,
  ensureAdminProjectPermission,
  fixtureWrite,
} from "./api-qualification-fixtures.mjs";
import { assertQualificationJson } from "./api-qualification-json.mjs";
import { proof, read, readRecord } from "./api-qualification-read.mjs";
import {
  attachNativeArchive,
  observeEmailPack,
  prepareAttachmentSource,
  prepareEmailSource,
  requireEmailDefault,
} from "./api-qualification-assets-fixtures.mjs";

const scope = { actor: "admin", administration: true };
const actorArgs = (f) => ({ expectedActorKey: f.adminActorKey });
const attachmentPath = (f) => `/rest/api/2/attachment/${f.assetAttachment.id}`;

/** Jira 10.3's attachment record carries no `id`; its self link names the exact attachment. */
const nativeAttachment = (raw) => ({ ...raw, id: String(raw.self).split("/").at(-1) });
async function attachmentRecord(context, id, path) {
  assert.match(id, /^[1-9]\d*$/u);
  const value = nativeAttachment(await read(context, path));
  assert.equal(value.id, id);
  return value;
}
async function attachmentReadback(context, data, f) {
  assert.match(data.attachmentId, /^[1-9]\d*$/u);
  const native = await attachmentRecord(
    context,
    data.attachmentId,
    `/rest/api/2/attachment/${data.attachmentId}`,
  );
  const issue = await read(context, `/rest/api/2/issue/${f.assetIssueKey}?fields=attachment`);
  assert.equal(issue.key, f.assetIssueKey);
  assert.ok(Array.isArray(issue.fields.attachment));
  assert.equal(
    issue.fields.attachment.filter((row) => String(row.id) === data.attachmentId).length,
    1,
  );
  assert.equal(native.filename, f.assetAttachmentFile.expectedFile.name);
  assert.equal(native.size, f.assetAttachmentFile.expectedFile.sizeBytes);
  f.assetAttachment = { id: String(native.id), filename: native.filename, size: native.size };
  return proof(7);
}
async function attachmentIssue(context, f) {
  await observeAdminActor(context, f);
  await prepareAttachmentSource(context, f);
  const issue = await createQualificationIssue(context, f, "asset attachment");
  f.assetIssueKey = issue.key;
  f.assetAttachment = undefined;
}
async function ensureAttachment(context, f) {
  await observeAdminActor(context, f);
  await prepareAttachmentSource(context, f);
  if (f.assetAttachment !== undefined) {
    const native = await attachmentRecord(context, f.assetAttachment.id, attachmentPath(f));
    assert.equal(native.filename, f.assetAttachment.filename);
    assert.equal(native.size, f.assetAttachment.size);
    return;
  }
  await attachmentIssue(context, f);
  await fixtureWrite(
    context,
    "jira.attach",
    {
      issueKey: f.assetIssueKey,
      source: f.assetAttachmentFile.source,
    },
    (c, data) => attachmentReadback(c, data, f),
  );
}
async function ensureArchive(context, f) {
  await observeAdminActor(context, f);
  if (f.assetArchive !== undefined) return;
  const issue = await createQualificationIssue(context, f, "asset archive");
  await attachNativeArchive(context, f, issue.key);
}
function assetRead(tool, path, fields, options, prepare) {
  return { ...scope, ...readCase(tool, path, fields, options), prepare };
}
function archiveRead(tool, suffix, fields, options) {
  const entry = assetRead(
    tool,
    (f) => `/rest/api/2/attachment/${f.assetArchive.id}/expand/${suffix}`,
    fields,
    options,
    ensureArchive,
  );
  return {
    ...entry,
    readback: async (c, data, f) => {
      const result = await entry.readback(c, data, f);
      assert.equal(data.totalEntryCount, f.assetArchivePack.entries.length);
      assert.ok(data.totalEntryCount > 0);
      if (suffix === "raw") {
        assert.equal(data.items.length, f.assetArchivePack.entries.length);
        assert.equal(data.entriesComplete, true);
      }
      return { ...result, assertionCount: result.assertionCount + (suffix === "raw" ? 4 : 2) };
    },
  };
}

const dashboardPath = (f) => `/rest/api/2/dashboard/${f.assetDashboard.id}`;
const propertiesPath = (f) => `${dashboardPath(f)}/items/${f.assetDashboard.itemId}/properties`;
const propertyKey = (f) => `keiko-ac7-assets-${f.runId}`;
const propertyValue = (f) => `Synthetic AC7 dashboard ${f.runId}`;
const propertyNodes = (f) => [{ path: "", kind: "string", textValue: propertyValue(f) }];
const dashboardArgs = (f) => ({
  dashboardId: f.assetDashboard.id,
  itemId: f.assetDashboard.itemId,
});
const propertyArgs = (f) => ({ ...dashboardArgs(f), propertyKey: propertyKey(f) });

async function dashboard(context, f) {
  await observeAdminActor(context, f);
  assert.ok(
    f.assetDashboard,
    "Supply an actual disposable dashboard/item created through native Jira UI",
  );
  assert.match(f.assetDashboard.id, /^[1-9]\d*$/u);
  assert.match(f.assetDashboard.itemId, /^[1-9]\d*$/u);
  assert.match(f.assetDashboard.name, /^Synthetic AC7 /u);
  const native = await readRecord(context, f.assetDashboard.id, dashboardPath(f));
  assert.equal(native.name, f.assetDashboard.name);
  const keys = await read(context, propertiesPath(f));
  assert.ok(Array.isArray(keys.keys));
}
async function propertyReadback(context, data, f, present, projected = false) {
  await dashboard(context, f);
  const keys = await read(context, propertiesPath(f));
  assert.equal(keys.keys.filter((row) => row.key === propertyKey(f)).length, present ? 1 : 0);
  const native = await labRequest(
    context.session,
    "GET",
    `${propertiesPath(f)}/${propertyKey(f)}`,
    basicAuth(context.session, context.actor),
  );
  assert.equal(native.status, present ? 200 : 404);
  if (present) {
    assert.equal(native.value.key, propertyKey(f));
    assert.equal(native.value.value, propertyValue(f));
  }
  assert.equal(data.dashboardId, f.assetDashboard.id);
  assert.equal(data.selectedItemId, f.assetDashboard.itemId);
  assert.equal(data.propertyKey, propertyKey(f));
  if (projected) assertQualificationJson(data.items, propertyNodes(f));
  else assert.equal(data.propertyPresent, present);
  return proof(present ? 10 : 8);
}
async function ensureProperty(context, f) {
  await dashboard(context, f);
  const keys = await read(context, propertiesPath(f));
  if (keys.keys.some((row) => row.key === propertyKey(f))) {
    const native = await read(context, `${propertiesPath(f)}/${propertyKey(f)}`);
    assert.equal(native.value, propertyValue(f));
    return;
  }
  await fixtureWrite(
    context,
    "jira.set-dashboard-item-property",
    {
      ...propertyArgs(f),
      expectAbsent: true,
      valueNodes: propertyNodes(f),
    },
    (c, data) => propertyReadback(c, data, f, true),
  );
}

async function emailActor(context, f) {
  await observeAdminActor(context, f);
  f.assetEmailPrior = await observeEmailPack(context);
}
async function emailReadback(context, data) {
  const pack = await observeEmailPack(context);
  assert.equal(data.selectionScope, "complete-exported-email-template-pack");
  assert.equal(data.manifestSha256, pack.manifestSha256);
  assert.equal(data.entryCount, pack.entries.length);
  assertQualificationJson(data.items, pack.entries);
  assert.ok(Number.isSafeInteger(data.archiveBytes) && data.archiveBytes > 0);
  assert.match(data.archiveSha256, /^[a-f0-9]{64}$/u);
  return proof(6 + pack.entries.length * 3);
}
function emailArgs(f, apply = false) {
  return {
    ...actorArgs(f),
    expectedActiveManifestSha256: f.assetEmailPrior.manifestSha256,
    acceptGlobalTemplateChange: true,
    ...(apply ? { acceptUnverifiedStagedPack: true } : {}),
  };
}
async function emailMutationReadback(context, data, f, action) {
  const pack = await observeEmailPack(context);
  const actor = await read(context, "/rest/api/2/myself");
  assert.equal(data.userKey, actor.key);
  assert.equal(data.emailTemplateAction, action);
  if (action === "upload") {
    assert.equal(data.uploadSha256, f.assetEmailFile.expectedFile.sha256);
    assert.equal(data.uploadBytes, f.assetEmailFile.expectedFile.sizeBytes);
    assert.equal(pack.manifestSha256, f.assetEmailPrior.manifestSha256);
  } else {
    assert.equal(data.priorManifestSha256, f.assetEmailPrior.manifestSha256);
    assert.equal(data.observedManifestSha256, pack.manifestSha256);
    if (action === "apply") assert.equal(pack.manifestSha256, f.assetEmailPack.manifestSha256);
    if (action === "revert") {
      assert.notEqual(f.assetEmailPrior.manifestSha256, f.assetEmailDefault.manifestSha256);
      assert.equal(pack.manifestSha256, f.assetEmailDefault.manifestSha256);
      assertQualificationJson(pack.entries, f.assetEmailDefault.entries);
    }
  }
  // Upload has no readable staged identity; revert has no complete default/consequence oracle.
  return { ...proof(5), persistenceConfirmed: action === "apply" };
}
async function emailUpload(context, f) {
  await observeAdminActor(context, f);
  await prepareEmailSource(context, f);
}
async function ensureEmailUpload(context, f) {
  await emailUpload(context, f);
  await fixtureWrite(
    context,
    "jira.upload-email-template-pack",
    {
      ...actorArgs(f),
      ...f.assetEmailFile,
      acceptStagedTemplateReplacement: true,
    },
    (c, data) => emailMutationReadback(c, data, f, "upload"),
  );
}
async function emailRevert(context, f) {
  await requireEmailDefault(context, f);
  await emailActor(context, f);
  if (f.assetEmailPrior.manifestSha256 === f.assetEmailDefault.manifestSha256) {
    await ensureEmailUpload(context, f);
    await fixtureWrite(context, "jira.apply-email-template-pack", emailArgs(f, true), (c, data) =>
      emailMutationReadback(c, data, f, "apply"),
    );
    f.assetEmailPrior = await observeEmailPack(context);
  }
  assert.notEqual(f.assetEmailPrior.manifestSha256, f.assetEmailDefault.manifestSha256);
}
async function materializeEmailUpload(context, f, data) {
  await emailMutationReadback(context, data, f, "upload");
  await fixtureWrite(context, "jira.apply-email-template-pack", emailArgs(f, true), (c, result) =>
    emailMutationReadback(c, result, f, "apply"),
  );
}
async function materializedEmailReadback(context, data, f) {
  const pack = await observeEmailPack(context);
  const native = await read(context, "/rest/api/2/myself");
  assert.equal(data.userKey, native.key);
  assert.equal(data.emailTemplateAction, "upload");
  assert.equal(data.uploadSha256, f.assetEmailFile.expectedFile.sha256);
  assert.equal(data.uploadBytes, f.assetEmailFile.expectedFile.sizeBytes);
  assert.equal(pack.manifestSha256, f.assetEmailPack.manifestSha256);
  assertQualificationJson(pack.entries, f.assetEmailPack.entries);
  return { ...proof(6), materializedByGovernedApply: true };
}

export const API_QUALIFICATION_ASSETS_CASES = [
  {
    ...adminMutationCase(
      "jira.attach",
      (f) => ({ issueKey: f.assetIssueKey, source: f.assetAttachmentFile.source }),
      attachmentReadback,
      attachmentIssue,
    ),
  },
  assetRead(
    "jira.attachment",
    attachmentPath,
    ["attachmentId", "filename", "size"],
    {
      args: (f) => ({ attachmentId: f.assetAttachment.id }),
      nativeRoot: (raw) => [nativeAttachment(raw)],
      productRoot: "single",
      nativeNames: { attachmentId: "id" },
      optionalFields: ["mimeType", "created"],
    },
    ensureAttachment,
  ),
  archiveRead(
    "jira.attachment-archive-summary",
    "human",
    ["attachmentId", "name", "mediaType", "totalEntryCount"],
    {
      args: (f) => ({ attachmentId: f.assetArchive.id }),
      nativeRoot: "single",
      productRoot: "single",
      nativeNames: { attachmentId: "id" },
    },
  ),
  archiveRead("jira.attachment-archive", "raw", ["entryIndex"], {
    args: (f) => ({ attachmentId: f.assetArchive.id, maxResults: 100 }),
    nativeRoot: "entries",
    optionalFields: ["name", "size", "mediaType", "abbreviatedName"],
  }),
  adminMutationCase(
    "jira.delete-attachment",
    (f) => ({
      issueKey: f.assetIssueKey,
      attachmentId: f.assetAttachment.id,
      filename: f.assetAttachment.filename,
      size: f.assetAttachment.size,
    }),
    async (c, data, f) => {
      const issue = await read(c, `/rest/api/2/issue/${f.assetIssueKey}?fields=attachment`);
      assert.equal(issue.key, f.assetIssueKey);
      assert.ok(Array.isArray(issue.fields.attachment));
      assert.equal(
        issue.fields.attachment.some((row) => String(row.id) === f.assetAttachment.id),
        false,
      );
      assert.equal(data.attachmentId, f.assetAttachment.id);
      f.assetAttachment = undefined;
      return proof(4);
    },
    async (c, f) => {
      await ensureAdminProjectPermission(c, "DELETE_OWN_ATTACHMENTS");
      await ensureAttachment(c, f);
    },
  ),
  adminMutationCase(
    "jira.set-dashboard-item-property",
    (f) => ({ ...propertyArgs(f), expectAbsent: true, valueNodes: propertyNodes(f) }),
    (c, data, f) => propertyReadback(c, data, f, true),
    dashboard,
  ),
  assetRead(
    "jira.dashboard-item-property-keys",
    propertiesPath,
    ["key"],
    { args: (f) => ({ ...dashboardArgs(f), maxResults: 100 }), nativeRoot: "keys" },
    ensureProperty,
  ),
  {
    ...scope,
    tool: "jira.dashboard-item-property",
    arguments: propertyArgs,
    prepare: ensureProperty,
    readback: (c, data, f) => propertyReadback(c, data, f, true, true),
  },
  adminMutationCase(
    "jira.delete-dashboard-item-property",
    (f) => ({ ...propertyArgs(f), expectedValueNodes: propertyNodes(f) }),
    (c, data, f) => propertyReadback(c, data, f, false),
    ensureProperty,
  ),
  assetRead(
    "jira.dashboard",
    dashboardPath,
    ["id", "name"],
    {
      args: (f) => ({ dashboardId: f.assetDashboard.id }),
      nativeRoot: "single",
      productRoot: "single",
    },
    dashboard,
  ),
  {
    ...scope,
    tool: "jira.email-template-pack",
    arguments: () => ({}),
    prepare: emailActor,
    readback: emailReadback,
  },
  {
    ...adminMutationCase(
      "jira.upload-email-template-pack",
      (f) => ({ ...actorArgs(f), ...f.assetEmailFile, acceptStagedTemplateReplacement: true }),
      materializedEmailReadback,
      emailUpload,
    ),
    prerequisiteTools: ["jira.apply-email-template-pack"],
    verifyInvocation: materializeEmailUpload,
  },
  adminMutationCase(
    "jira.apply-email-template-pack",
    (f) => emailArgs(f, true),
    (c, data, f) => emailMutationReadback(c, data, f, "apply"),
    ensureEmailUpload,
  ),
  adminMutationCase(
    "jira.revert-email-template-pack",
    emailArgs,
    (c, data, f) => emailMutationReadback(c, data, f, "revert"),
    emailRevert,
  ),
];
