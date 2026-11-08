// Auxiliary fixtures use the very same governed dispatcher, journal and independent readback.
// No fixture helper has an HTTP mutation fallback.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { actorDetails, readPrivateFile } from "./lab-client.mjs";
import { read, proof } from "./api-qualification-read.mjs";
import { qualificationDigest } from "./api-qualification-evidence.mjs";

/** `humanInput(context, fixture)` optionally supplies the scripted protected-input submission. */
export async function fixtureWrite(context, tool, args, readback, humanInput) {
  assert.equal(typeof context.qualificationFixture, "function");
  return context.qualificationFixture({ tool, arguments: args, readback, humanInput });
}
export async function createQualificationIssue(
  context,
  f,
  label,
  issueTypeId = f.issueTypeId,
  fields = {},
) {
  const summary = `Synthetic AC7 ${label} ${f.runId}`;
  let actual;
  await fixtureWrite(
    context,
    "jira.create",
    {
      projectId: f.projectId,
      issueTypeId,
      fields: { summary, ...fields },
    },
    async (c, data) => {
      assert.match(data.issueKey, /^KEIKO-[1-9][0-9]*$/u);
      actual = await read(c, `/rest/api/2/issue/${data.issueKey}`);
      assert.equal(actual.key, data.issueKey);
      assert.equal(actual.fields.project.id, f.projectId);
      assert.equal(actual.fields.issuetype.id, issueTypeId);
      assert.equal(actual.fields.summary, summary);
      return proof(4);
    },
  );
  assert.ok(actual);
  return actual;
}
export function issueReview(value) {
  assert.ok(value && value.fields);
  assert.ok(value.fields.project && value.fields.issuetype);
  for (const id of [value.id, value.fields.project.id, value.fields.issuetype.id])
    assert.match(String(id), /^[1-9][0-9]*$/u);
  assert.equal(typeof value.key, "string");
  assert.equal(typeof value.fields.summary, "string");
  assert.ok(value.fields.summary.length > 0);
  return {
    id: String(value.id),
    key: value.key,
    summary: value.fields.summary,
    projectId: String(value.fields.project.id),
    issueTypeId: String(value.fields.issuetype.id),
  };
}
export async function createQualificationVersion(context, f, label) {
  const name = `AC7 ${label} ${f.runId}`;
  let actual;
  await fixtureWrite(
    context,
    "jira.create-version",
    {
      expectedActorKey: f.adminActorKey,
      projectId: f.projectId,
      name,
      description: "Synthetic AC7 auxiliary version",
      startDate: "2026-11-08",
      releaseDate: "2026-12-01",
      released: false,
      archived: false,
    },
    async (c, data) => {
      assert.match(data.versionId, /^[1-9][0-9]*$/u);
      actual = await read(c, `/rest/api/2/version/${data.versionId}`);
      assert.equal(String(actual.id), data.versionId);
      assert.equal(String(actual.projectId), f.projectId);
      assert.equal(actual.name, name);
      return proof(3);
    },
  );
  assert.ok(actual);
  return actual;
}
export async function createQualificationField(context, f, label) {
  const name = `AC7 ${label} ${f.runId}`;
  let actual;
  await fixtureWrite(
    context,
    "jira.create-custom-field",
    {
      expectedActorKey: f.adminActorKey,
      name,
      description: "Synthetic AC7 auxiliary field",
      type: "com.atlassian.jira.plugin.system.customfieldtypes:textfield",
      searcherKey: "com.atlassian.jira.plugin.system.customfieldtypes:textsearcher",
      projectIds: [f.projectId],
      issueTypeIds: [f.issueTypeId],
    },
    async (c, data) => {
      assert.match(data.fieldId, /^customfield_[1-9][0-9]*$/u);
      const rows = await read(c, "/rest/api/2/field");
      const found = rows.filter((row) => row.id === data.fieldId);
      assert.equal(found.length, 1);
      [actual] = found;
      assert.equal(actual.name, name);
      assert.equal(actual.custom, true);
      return proof(3);
    },
  );
  assert.ok(actual);
  return actual;
}
export const qualificationProjectKey = (f, label) =>
  `Q${qualificationDigest([f.runId, label]).slice(0, 9).toUpperCase()}`;
export function projectReview(value) {
  assert.match(String(value.id), /^[1-9][0-9]*$/u);
  for (const field of ["key", "name"]) assert.equal(typeof value[field], "string");
  assert.equal(typeof value.archived, "boolean");
  return { id: String(value.id), key: value.key, name: value.name, archived: value.archived };
}
export async function createQualificationProject(context, f, label) {
  const key = qualificationProjectKey(f, label);
  const name = `Synthetic AC7 ${label} ${f.runId}`;
  let actual;
  await fixtureWrite(
    context,
    "jira.create-project",
    { key, name, lead: "keiko-admin", projectTypeKey: "software", assigneeType: "UNASSIGNED" },
    async (c, data) => {
      actual = await read(c, `/rest/api/2/project/${data.projectId}`);
      assert.equal(String(actual.id), data.projectId);
      assert.equal(actual.key, key);
      assert.equal(actual.name, name);
      assert.equal(actual.projectTypeKey, "software");
      return proof(4);
    },
  );
  assert.ok(actual);
  return actual;
}

// ---- connected files -------------------------------------------------------------------------
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** A synthetic solid PNG; deterministic bytes, no personal or customer content. */
export function qualificationPng(size, shade) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, shade)]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
/**
 * The one way a recipe makes a generated file readable as a `connected-file` source. The file is
 * written once into the run's workspace and listed in the Chat's connected scope, exactly as a
 * person's selection would, so the product's own source admission governs it. The returned
 * descriptor is the `expectedFile` review. Idempotent for the same Chat; a later batch's new Chat
 * is bound again without rewriting bytes. `chat` is the third `specification.prepare` argument.
 */
export function bindQualificationFile(context, fixture, chat, key, makeBytes) {
  assert.ok(chat?.id, "A connected file binds to the Chat that will dispatch the operation");
  const files = (fixture.qualificationFiles ??= {});
  files[key] ??= { name: `ac7-${key}-${fixture.runId}.png` };
  const entry = files[key];
  const path = join(context.projectPath, entry.name);
  if (entry.sha256 === undefined || !existsSync(path)) {
    const bytes = makeBytes();
    mkdirSync(context.projectPath, { recursive: true });
    writeFileSync(path, bytes, { mode: 0o600 });
    entry.sizeBytes = bytes.length;
    entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  }
  const bound = (fixture.qualificationFileChats ??= new Map());
  const names = bound.get(chat.id) ?? new Set();
  names.add(entry.name);
  bound.set(chat.id, names);
  context.deps.store.updateChat(chat.id, {
    connectedScopes: [{ kind: "files", relativePaths: [...names], connectedAtMs: Date.now() }],
  });
  return { name: entry.name, sizeBytes: entry.sizeBytes, sha256: entry.sha256 };
}
/** Unbinds and deletes a file made by `bindQualificationFile`; safe when it is already gone. */
export function releaseQualificationFile(context, fixture, key) {
  const entry = fixture.qualificationFiles?.[key];
  if (entry === undefined) return;
  for (const [chatId, names] of fixture.qualificationFileChats ?? []) {
    if (!names.delete(entry.name)) continue;
    context.deps.store.updateChat(chatId, {
      connectedScopes:
        names.size === 0
          ? null
          : [{ kind: "files", relativePaths: [...names], connectedAtMs: Date.now() }],
    });
  }
  rmSync(join(context.projectPath, entry.name), { force: true });
  Reflect.deleteProperty(fixture.qualificationFiles, key);
}

// ---- protected input -------------------------------------------------------------------------
/** A lab actor's credential, read from its private file for a scripted protected-input answer. */
export const labActorPassword = (context, actor) =>
  readPrivateFile(join(context.session.directory, "secrets", actorDetails(actor).passwordFile));
/** A fresh runtime secret that exists nowhere else; never printed, stored or written. */
export const generatedSecret = () => `Ac7-${randomBytes(18).toString("base64url")}-q9!`;
