// Auxiliary fixtures use the very same governed dispatcher, journal and independent readback.
// No fixture helper has an HTTP mutation fallback.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { jsonRequest } from "./chat-read.mjs";
import { actorDetails, basicAuth, labSessionConnection, readPrivateFile } from "./lab-client.mjs";
import { read, proof } from "./api-qualification-read.mjs";
import { qualificationDigest } from "./api-qualification-evidence.mjs";

/**
 * One auxiliary governed effect with independent readback. `publishHumanInput` optionally submits
 * the scripted protected input (see `protectedInputPublisher`). Inside a held private-session turn
 * the effect rides that very turn; otherwise it runs as its own fully graded case.
 */
export async function fixtureWrite(context, tool, args, readback, publishHumanInput) {
  const entry = {
    tool,
    arguments: args,
    readback,
    ...(publishHumanInput === undefined ? {} : { publishHumanInput }),
  };
  if (context.heldQualificationFixture !== undefined)
    return context.heldQualificationFixture(entry);
  assert.equal(typeof context.qualificationFixture, "function");
  return context.qualificationFixture(entry);
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
      assert.match(data.issueKey, /^KEIKO-[1-9]\d*$/u);
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
    assert.match(String(id), /^[1-9]\d*$/u);
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
      assert.match(data.versionId, /^[1-9]\d*$/u);
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
      assert.match(data.fieldId, /^customfield_[1-9]\d*$/u);
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
  assert.match(String(value.id), /^[1-9]\d*$/u);
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
const MAX_FILE_BYTES = 20 * 1024 * 1024;
async function patchConnectedScope(context, chatId, root, paths) {
  const current = context.deps.store.findChatById(chatId);
  assert.ok(current);
  const scopes =
    current.connectedScopes ?? (current.connectedScope ? [current.connectedScope] : []);
  const kept = scopes.filter((entry) => entry.root !== root);
  const scope = { kind: "files", root, relativePaths: paths, connectedAtMs: Date.now() };
  const result = await jsonRequest(
    context.origin,
    context.cookie,
    "qualification-asset-files",
    `/api/chats?id=${encodeURIComponent(chatId)}`,
    {
      connectedScopes: paths.length === 0 ? (kept.length === 0 ? null : kept) : [...kept, scope],
    },
    "PATCH",
  );
  if (paths.length === 0) return;
  assert.deepEqual(result.chat.connectedScopes.at(-1).relativePaths, paths);
  assert.equal(result.chat.connectedScopes.at(-1).root, root);
}
/**
 * The one way a recipe makes a generated file readable as a `connected-file` source. The file
 * (a workspace-relative path) is listed in the dispatching Chat's connected scope through the
 * product's own authenticated route, exactly as a person's selection would, so the product's
 * source admission governs it. The returned descriptor is the `source` plus the `expectedFile`
 * review. Idempotent for the same Chat; a later batch's new Chat is bound again. Files bound to one
 * Chat accumulate until `releaseQualificationFile` removes them.
 */
export async function connectQualificationFile(context, fixture, relativePath, chat) {
  assert.ok(chat?.id, "A connected file binds to the Chat that will dispatch the operation");
  const root = realpathSync(context.projectPath);
  const bytes = readFileSync(join(root, relativePath));
  assert.ok(bytes.byteLength > 0 && bytes.byteLength <= MAX_FILE_BYTES);
  const bound = (fixture.qualificationFileChats ??= new Map());
  const paths = bound.get(chat.id) ?? new Set();
  paths.add(relativePath);
  bound.set(chat.id, paths);
  await patchConnectedScope(context, chat.id, root, [...paths]);
  return {
    source: { kind: "connected-file", path: relativePath },
    expectedFile: {
      name: basename(relativePath),
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}
/** A generated file in the workspace root, written once per run and key, then connected. */
export async function bindQualificationFile(context, fixture, chat, key, makeBytes) {
  const files = (fixture.qualificationFiles ??= {});
  files[key] ??= { name: `ac7-${key}-${fixture.runId}.png` };
  const { name } = files[key];
  if (!existsSync(join(context.projectPath, name))) {
    mkdirSync(context.projectPath, { recursive: true });
    writeFileSync(join(context.projectPath, name), makeBytes(), { mode: 0o600 });
  }
  const { expectedFile } = await connectQualificationFile(context, fixture, name, chat);
  return expectedFile;
}
/** Unbinds and deletes a file made by `bindQualificationFile`; safe when it is already gone. */
export async function releaseQualificationFile(context, fixture, key) {
  const entry = fixture.qualificationFiles?.[key];
  if (entry === undefined) return;
  const root = realpathSync(context.projectPath);
  for (const [chatId, paths] of fixture.qualificationFileChats ?? []) {
    if (paths.delete(entry.name)) await patchConnectedScope(context, chatId, root, [...paths]);
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
export const adminLoginInput = (context) => ({ password: labActorPassword(context, "admin") });
/**
 * The scripted human submission goes through the paired BFF's authenticated protected-input route,
 * so custody binds, revision-checks and consumes it exactly as for a person. `provideValues` is
 * read only at submission; values never leave this call. `purpose` optionally pins the request.
 */
export function protectedInputPublisher(provideValues, purpose) {
  return async (context, view) => {
    if (purpose !== undefined) assert.equal(view.purpose, purpose);
    assert.match(view.requestId, /^jhi_[a-f0-9]{64}$/u);
    assert.equal(typeof view.revision, "string");
    if (view.state !== "awaiting-input") return;
    const result = await jsonRequest(
      context.origin,
      context.cookie,
      "qualification-protected-input",
      `/api/atlassian-connectors/human-inputs/${view.requestId}`,
      {
        expectedRevision: view.revision,
        values: await provideValues(context, context.qualificationFixtureState),
      },
    );
    assert.equal(result.state, "ready");
  };
}

export async function createQualificationFilter(context, f, label) {
  const scope = await read(context, "/rest/api/2/filter/defaultShareScope");
  const name = `AC7 ${label} ${f.runId}`;
  let actual;
  await fixtureWrite(
    context,
    "jira.create-filter",
    {
      expectedActorKey: f.adminActorKey,
      expectedDefaultShareScope: scope.scope,
      acceptDefaultSharing: true,
      name,
      description: "Synthetic AC7 auxiliary filter",
      jql: "project = KEIKO ORDER BY Rank ASC",
    },
    async (c, data) => {
      assert.match(data.filterId, /^[1-9]\d*$/u);
      actual = await read(c, `/rest/api/2/filter/${data.filterId}`);
      assert.equal(String(actual.id), data.filterId);
      assert.equal(actual.name, name);
      assert.equal(actual.owner.key, f.adminActorKey);
      assert.equal(actual.jql, "project = KEIKO ORDER BY Rank ASC");
      return proof(4);
    },
  );
  assert.ok(actual);
  return actual;
}

/**
 * Jira answers GET /filter/{id}/columns with a bare 404 until the filter owns an explicit layout, and
 * the governed column tools refuse that unreviewed state. The recipe therefore seeds one on its own
 * synthetic filter as native fixture preparation (form-encoded, as Jira reads it); the governed
 * set/reset cases then run against the seeded, independently read layout.
 */
export async function seedQualificationFilterColumns(context, filterId, columns) {
  assert.match(filterId, /^[1-9]\d*$/u);
  const origin = labSessionConnection(context.session).origin;
  const response = await globalThis.fetch(
    new URL(`/rest/api/2/filter/${filterId}/columns`, origin),
    {
      method: "PUT",
      redirect: "manual",
      signal: globalThis.AbortSignal.timeout(30_000),
      headers: {
        Authorization: basicAuth(context.session, context.actor),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: columns.map((column) => `columns=${encodeURIComponent(column)}`).join("&"),
    },
  );
  assert.equal(response.status, 200, "Jira must accept the synthetic filter's explicit columns");
}

/**
 * The instance's default share scope gives a new filter a native `loggedin` share, a recipient type
 * the governed permission tools do not review. The recipe removes those broad shares from its own
 * synthetic filter as native fixture preparation so the group-share cases start from a private filter.
 */
export async function privatizeQualificationFilter(context, filterId) {
  assert.match(filterId, /^[1-9]\d*$/u);
  const origin = labSessionConnection(context.session).origin;
  const auth = basicAuth(context.session, context.actor);
  const base = new URL(`/rest/api/2/filter/${filterId}/permission`, origin);
  const call = (method, url) =>
    globalThis.fetch(url, {
      method,
      redirect: "manual",
      signal: globalThis.AbortSignal.timeout(30_000),
      headers: { Authorization: auth, Accept: "application/json" },
    });
  const listed = await call("GET", base);
  assert.equal(listed.status, 200);
  for (const row of await listed.json()) {
    assert.ok(
      new Set(["loggedin", "global"]).has(row.type),
      "Only broad default shares are removed",
    );
    assert.match(String(row.id), /^[1-9]\d*$/u);
    assert.equal((await call("DELETE", new URL(`${base.pathname}/${row.id}`, origin))).status, 204);
  }
  const after = await call("GET", base);
  assert.deepEqual(await after.json(), []);
}

/**
 * The seeded permission scheme omits the project permissions that destructive qualification needs.
 * The operator fixture grants one to the acting administrator in the project's own scheme, natively
 * and idempotently, so the governed case runs and is read back instead of ending in a local 403.
 */
export async function ensureAdminProjectPermission(context, permission) {
  assert.match(permission, /^[A-Z_]+$/u);
  const have = await read(
    context,
    `/rest/api/2/mypermissions?projectKey=KEIKO&permissions=${permission}`,
  );
  if (have.permissions[permission]?.havePermission === true) return;
  const scheme = await read(context, "/rest/api/2/project/KEIKO/permissionscheme");
  assert.match(String(scheme.id), /^[1-9]\d*$/u);
  const origin = labSessionConnection(context.session).origin;
  const response = await globalThis.fetch(
    new URL(`/rest/api/2/permissionscheme/${scheme.id}/permission`, origin),
    {
      method: "POST",
      redirect: "manual",
      signal: globalThis.AbortSignal.timeout(30_000),
      headers: {
        Authorization: basicAuth(context.session, context.actor),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        holder: { type: "user", parameter: "keiko-admin" },
        permission,
      }),
    },
  );
  assert.equal(response.status, 201, "Jira must accept the project permission grant");
  const after = await read(
    context,
    `/rest/api/2/mypermissions?projectKey=KEIKO&permissions=${permission}`,
  );
  assert.equal(after.permissions[permission]?.havePermission, true);
}
