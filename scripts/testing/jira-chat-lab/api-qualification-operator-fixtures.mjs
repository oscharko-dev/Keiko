// Operator fixtures of the model-free AC7 live qualification: synced sprints, a native dashboard
// item, a select field with one option, a permission-scheme attribute and the verified default
// email pack. Every step observes the native result and fails closed with one closed reason.
// Fixtures are merged into the session's existing fixture.json; nothing here is a second store.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";
import { basicAuth, labSessionConnection } from "./lab-client.mjs";
import { privateJson } from "./private-json.mjs";
import { withLabAdmin } from "./seed-admin.mjs";

export const PREPARATION_REASONS = Object.freeze([
  "native-response-unexpected",
  "sprint-not-synced",
  "dashboard-not-created",
  "option-not-created",
  "attribute-not-stored",
  "email-default-unavailable",
  "fixture-manifest-invalid",
]);

export class QualificationPreparationError extends Error {
  constructor(reason, status) {
    super(`AC7 preparation refused: ${reason}`);
    this.name = "QualificationPreparationError";
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}

const SELECT_TYPE = "com.atlassian.jira.plugin.system.customfieldtypes:select";
const SELECT_SEARCHER = "com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher";
const DEFAULT_PERMISSION_ATTRIBUTE = "ac7.synthetic.attribute";
const numeric = /^[1-9]\d*$/u;

/** Authenticated admin call straight to the lab; a body is JSON unless raw text is requested. */
export async function adminRequest(session, method, path, body, contentType) {
  if (!path.startsWith("/rest/")) throw new TypeError("Unexpected laboratory API path");
  const origin = labSessionConnection(session).origin;
  const response = await globalThis.fetch(new URL(path, origin), {
    method,
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(30_000),
    headers: {
      Accept: "application/json",
      Authorization: basicAuth(session, "admin"),
      "X-Atlassian-Token": "no-check",
      ...(body === undefined ? {} : { "Content-Type": contentType ?? "application/json" }),
    },
    ...(body === undefined
      ? {}
      : { body: contentType === undefined ? JSON.stringify(body) : String(body) }),
  });
  const text = (await response.text()).slice(0, 1_048_576);
  let value;
  try {
    value = text === "" ? undefined : JSON.parse(text);
  } catch {
    value = undefined;
  }
  return { status: response.status, value };
}

async function expectNative(io, method, path, body, statuses, contentType) {
  const result = await io.request(method, path, body, contentType);
  if (!statuses.includes(result.status))
    throw new QualificationPreparationError("native-response-unexpected", result.status);
  return result.value;
}

/** A failed administration page never leaks Playwright details; it becomes one closed reason. */
async function uiStep(io, reason, run) {
  try {
    return await io.withAdmin(run);
  } catch {
    throw new QualificationPreparationError(reason);
  }
}

const nonceName = (label, nonce) => `Synthetic AC7 ${label} ${nonce}`;

async function createSyncedSprints(io, boardId, nonce, label, count) {
  const ids = [];
  for (let index = 0; index < count; index++) {
    const created = await expectNative(
      io,
      "POST",
      "/rest/agile/1.0/sprint",
      {
        name: `AC7 ${label} ${nonce.slice(0, 6)}-${index + 1}`,
        originBoardId: Number(boardId),
        autoStartStop: false,
        synced: true,
      },
      [201],
    );
    const id = String(created?.id);
    if (!numeric.test(id)) throw new QualificationPreparationError("native-response-unexpected");
    const sprint = await expectNative(io, "GET", `/rest/agile/1.0/sprint/${id}`, undefined, [200]);
    if (sprint?.synced !== true || String(sprint.originBoardId) !== boardId)
      throw new QualificationPreparationError("sprint-not-synced");
    ids.push(id);
  }
  return ids;
}

async function verifiedSyncedIds(io, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return false;
  for (const id of ids) {
    const result = await io.request("GET", `/rest/agile/1.0/sprint/${id}`);
    if (result.status !== 200 || result.value?.synced !== true) return false;
  }
  return true;
}

/**
 * Jira Data Center lets an administrator create a synced sprint natively: POST /rest/agile/1.0/sprint
 * with synced=true on a Scrum board. Two disjoint sets are created because the instance-wide
 * unmap-all would otherwise consume the sprints that the selective unmap case still needs.
 */
export async function prepareSyncedSprints(io, fixture, nonce) {
  const one = await verifiedSyncedIds(io, fixture.planningSyncedSprintIds);
  const all = await verifiedSyncedIds(io, fixture.planningAllSyncedSprintIds);
  if (one && all) return {};
  const filter = await expectNative(
    io,
    "POST",
    "/rest/api/2/filter",
    {
      name: nonceName("synced sprints", nonce),
      jql: "project = KEIKO ORDER BY Rank ASC",
    },
    [200, 201],
  );
  const filterId = String(filter?.id);
  if (!numeric.test(filterId))
    throw new QualificationPreparationError("native-response-unexpected");
  const board = await expectNative(
    io,
    "POST",
    "/rest/agile/1.0/board",
    { name: nonceName("synced board", nonce), type: "scrum", filterId: Number(filterId) },
    [200, 201],
  );
  const boardId = String(board?.id);
  if (!numeric.test(boardId)) throw new QualificationPreparationError("native-response-unexpected");
  return {
    planningSyncedSprintIds: one
      ? fixture.planningSyncedSprintIds
      : await createSyncedSprints(io, boardId, nonce, "one", 2),
    planningAllSyncedSprintIds: all
      ? fixture.planningAllSyncedSprintIds
      : await createSyncedSprints(io, boardId, nonce, "all", 2),
  };
}

async function optionIdFor(io, fieldId, value) {
  const page = await io.request(
    "GET",
    `/rest/api/2/customFields/${fieldId.slice(12)}/options?page=1&maxResults=100&useAllContexts=true`,
  );
  const rows = Array.isArray(page.value?.values) ? page.value.values : [];
  const found = page.status === 200 ? rows.filter((row) => row.value === value) : [];
  return found.length === 1 && numeric.test(String(found[0].id)) ? String(found[0].id) : undefined;
}

/**
 * Jira DC 10.3 documents no REST write for select options (the customFields resource only lists
 * them), so the option is added through the supported administration UI of that very field.
 */
async function addOptionThroughUi(page, origin, fieldId, value) {
  await page.goto(
    `${origin}/secure/admin/ConfigureCustomField!default.jspa?customFieldId=${fieldId.slice(12)}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.getByRole("link", { name: "Edit Options" }).first().click();
  await page.locator("input[name=addValue]").fill(value);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText(value, { exact: true }).first().waitFor();
}

export async function prepareOptionFixture(io, fixture, nonce) {
  const value = `Synthetic AC7 option ${nonce}`;
  let fieldId = fixture.optionFieldId;
  if (typeof fieldId === "string") {
    const known = await optionIdFor(io, fieldId, fixture.optionValue ?? value);
    if (known !== undefined && known === fixture.optionId) return {};
  }
  const created = await expectNative(
    io,
    "POST",
    "/rest/api/2/field",
    {
      name: nonceName("option field", nonce),
      description: "Synthetic AC7 select field",
      type: SELECT_TYPE,
      searcherKey: SELECT_SEARCHER,
    },
    [200, 201],
  );
  fieldId = created?.id;
  if (typeof fieldId !== "string" || !/^customfield_[1-9]\d*$/u.test(fieldId))
    throw new QualificationPreparationError("native-response-unexpected");
  await uiStep(io, "option-not-created", (page) =>
    addOptionThroughUi(page, io.origin, fieldId, value),
  );
  const optionId = await optionIdFor(io, fieldId, value);
  if (optionId === undefined) throw new QualificationPreparationError("option-not-created");
  return { optionFieldId: fieldId, optionId, optionValue: value };
}

async function storedAttribute(io, schemeId, key) {
  const result = await io.request(
    "GET",
    `/rest/api/2/permissionscheme/${schemeId}/attribute/${encodeURIComponent(key)}`,
  );
  return result.status === 200 && result.value?.key === key && result.value.value === "false";
}

/** An own permission scheme keeps the default scheme untouched; the attribute value is native text. */
export async function preparePermissionAttribute(io, fixture, nonce, key) {
  if (
    /^(?:0|[1-9]\d*)$/u.test(String(fixture.permissionAttributeSchemeId)) &&
    fixture.permissionAttributeKey === key &&
    (await storedAttribute(io, fixture.permissionAttributeSchemeId, key))
  )
    return {};
  const scheme = await expectNative(
    io,
    "POST",
    "/rest/api/2/permissionscheme",
    { name: nonceName("attribute scheme", nonce), description: "Synthetic AC7", permissions: [] },
    [200, 201],
  );
  const schemeId = String(scheme?.id);
  if (!numeric.test(schemeId))
    throw new QualificationPreparationError("native-response-unexpected");
  await expectNative(
    io,
    "PUT",
    `/rest/api/2/permissionscheme/${schemeId}/attribute/${encodeURIComponent(key)}`,
    "false",
    [200, 201, 204],
    "text/plain",
  );
  if (!(await storedAttribute(io, schemeId, key)))
    throw new QualificationPreparationError("attribute-not-stored");
  return { permissionAttributeSchemeId: schemeId, permissionAttributeKey: key };
}

async function dashboardIdByName(io, name) {
  const page = await io.request("GET", "/rest/api/2/dashboard?filter=my&maxResults=100");
  const rows =
    page.status === 200 && Array.isArray(page.value?.dashboards) ? page.value.dashboards : [];
  const found = rows.filter((row) => row.name === name);
  return found.length === 1 && numeric.test(String(found[0].id)) ? String(found[0].id) : undefined;
}

const GADGET_URL =
  "rest/gadgets/1.0/g/com.atlassian.jira.gadgets:assigned-to-me-gadget/gadgets/assigned-to-me-gadget.xml";

/** Create the dashboard in Jira's own UI, then add one gadget with the UI's own authenticated call. */
async function createDashboardThroughUi(page, origin, name) {
  await page.goto(`${origin}/secure/AddPortalPage!default.jspa`, { waitUntil: "domcontentloaded" });
  await page.locator("input[name=portalPageName]").fill(name);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForURL((url) => /selectPageId=\d+/u.test(url.search));
  const id = /selectPageId=(\d+)/u.exec(page.url())?.[1];
  if (id === undefined) return undefined;
  const response = await page.request.post(`${origin}/rest/dashboards/1.0/${id}/gadget`, {
    data: { url: GADGET_URL },
    headers: { "X-Atlassian-Token": "no-check" },
  });
  if (!response.ok()) return undefined;
  return { id, itemId: String((await response.json())?.id) };
}

/** The item is accepted only when Jira's own REST resource names the dashboard and the item. */
async function itemIsNative(io, id, itemId, name) {
  if (!numeric.test(String(id)) || !numeric.test(String(itemId))) return false;
  const dashboard = await io.request("GET", `/rest/api/2/dashboard/${id}`);
  if (dashboard.status !== 200 || dashboard.value?.name !== name) return false;
  const keys = await io.request("GET", `/rest/api/2/dashboard/${id}/items/${itemId}/properties`);
  return keys.status === 200 && Array.isArray(keys.value?.keys);
}

export async function prepareAssetDashboard(io, fixture, nonce) {
  const known = fixture.assetDashboard;
  if (known && (await itemIsNative(io, known.id, known.itemId, known.name))) return {};
  const name = nonceName("dashboard", nonce);
  const created = await uiStep(io, "dashboard-not-created", (page) =>
    createDashboardThroughUi(page, io.origin, name),
  );
  const id = await dashboardIdByName(io, name);
  if (!created || id !== created.id || !(await itemIsNative(io, id, created.itemId, name)))
    throw new QualificationPreparationError("dashboard-not-created");
  return { assetDashboard: { id, itemId: created.itemId, name } };
}

/** The pack is captured before any template mutation and never replaced by a later capture. */
export async function prepareEmailDefault(io, fixture, session) {
  if (
    fixture.assetEmailDefault !== undefined &&
    fixture.assetEmailDefaultRelease === session.jiraVersion &&
    fixture.assetEmailDefaultImage === session.jiraImageDigest
  )
    return {};
  let pack;
  try {
    pack = await io.observeEmailPack();
  } catch {
    throw new QualificationPreparationError("email-default-unavailable");
  }
  if (!pack || !Array.isArray(pack.entries) || pack.entries.length === 0)
    throw new QualificationPreparationError("email-default-unavailable");
  return {
    assetEmailDefault: pack,
    assetEmailDefaultRelease: session.jiraVersion,
    assetEmailDefaultImage: session.jiraImageDigest,
  };
}

function readFixtureManifest(directory) {
  const path = join(directory, "fixture.json");
  const value = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new QualificationPreparationError("fixture-manifest-invalid");
  return { path, value };
}

/** The email pack goes first: nothing before it may touch an email template. */
export async function prepareOperatorFixtures(session, io, options = {}) {
  const { path, value } = readFixtureManifest(session.directory);
  const nonce = options.nonce ?? randomBytes(4).toString("hex");
  const key = options.permissionAttributeKey ?? DEFAULT_PERMISSION_ATTRIBUTE;
  let manifest = { ...value, ...(await prepareEmailDefault(io, value, session)) };
  const steps = [
    (current) => prepareSyncedSprints(io, current, nonce),
    (current) => prepareOptionFixture(io, current, nonce),
    (current) => preparePermissionAttribute(io, current, nonce, key),
    (current) => prepareAssetDashboard(io, current, nonce),
  ];
  privateJson(path, manifest);
  for (const step of steps) {
    manifest = { ...manifest, ...(await step(manifest)) };
    privateJson(path, manifest);
  }
  return Object.keys(manifest).filter((name) => !(name in value));
}

/** Production wiring: native admin REST, the lab's Playwright administration and the email export. */
export function defaultOperatorIo(session, observeEmailPack) {
  return {
    origin: labSessionConnection(session).origin,
    request: (method, path, body, contentType) =>
      adminRequest(session, method, path, body, contentType),
    withAdmin: (run) => withLabAdmin(session, run),
    observeEmailPack: () => observeEmailPack({ session, actor: "admin" }),
  };
}
