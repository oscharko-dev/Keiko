// Operator fixtures of the model-free AC7 live qualification: synced sprints, a native dashboard
// item, a select field with one option, a permission-scheme attribute and the verified default
// email pack. Every step observes the native result and fails closed with one closed reason.
// Fixtures are merged into the session's existing fixture.json; nothing here is a second store.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { labSessionConnection } from "./lab-client.mjs";
import {
  PREPARATION_REASONS,
  QualificationPreparationError,
  adminRequest,
  expectNative,
} from "./api-qualification-preparation-core.mjs";
import { COLLECTION_SEED_STEPS } from "./api-qualification-collection-seeds.mjs";
import { ensureFixtureSecurityScheme } from "./seed-security.mjs";
import { privateJson } from "./private-json.mjs";
import { withLabAdmin } from "./seed-admin.mjs";

export { PREPARATION_REASONS, QualificationPreparationError, adminRequest };

const SELECT_TYPE = "com.atlassian.jira.plugin.system.customfieldtypes:select";
const SELECT_SEARCHER = "com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher";
const DEFAULT_PERMISSION_ATTRIBUTE = "ac7.synthetic.attribute";
const numeric = /^[1-9]\d*$/u;

/** A failed administration page never leaks Playwright details; it becomes one closed reason. */
async function uiStep(io, reason, run) {
  try {
    return await io.withAdmin(run);
  } catch (error) {
    if (error instanceof QualificationPreparationError) throw error;
    throw new QualificationPreparationError(reason);
  }
}

const nonceName = (label, nonce) => `Synthetic AC7 ${label} ${nonce}`;

const FEATURE_DISABLED = /synced sprint when the feature is disabled/iu;

/** Jira refuses a synced sprint with a closed 400 text when the lab's feature flag is missing. */
async function createSyncedSprint(io, boardId, name) {
  const result = await io.request("POST", "/rest/agile/1.0/sprint", {
    name,
    originBoardId: Number(boardId),
    autoStartStop: false,
    synced: true,
  });
  if (result.status === 201) return result.value;
  const messages = JSON.stringify(result.value?.errorMessages ?? result.value?.message ?? "");
  if (result.status === 400 && FEATURE_DISABLED.test(messages))
    throw new QualificationPreparationError("sprint-sync-feature-disabled", result.status);
  throw new QualificationPreparationError("native-response-unexpected", result.status);
}

async function createSyncedSprints(io, boardId, nonce, label, count) {
  const ids = [];
  for (let index = 0; index < count; index++) {
    const created = await createSyncedSprint(
      io,
      boardId,
      `AC7 ${label} ${nonce.slice(0, 6)}-${index + 1}`,
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
  // Jira 10.3 lists a field's options under `options`; `values` is the page form of other lists.
  const listed = page.value?.options ?? page.value?.values;
  const rows = Array.isArray(listed) ? listed : [];
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
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const decodeEntities = (text) =>
  text.replace(/&(?:amp|lt|gt|quot|#39);/gu, (entity) => ENTITIES[entity]);

/** The hidden inputs of a Jira administration form (its XSRF token among them), by name. */
export function hiddenFormFields(html) {
  const fields = {};
  for (const tag of html.match(/<input\b[^>]*>/giu) ?? []) {
    const attributes = Object.fromEntries(
      [...tag.matchAll(/([a-z][\w-]*)="([^"]*)"/giu)].map((match) => [
        match[1].toLowerCase(),
        decodeEntities(match[2]),
      ]),
    );
    if (attributes.type?.toLowerCase() === "hidden" && attributes.name)
      fields[attributes.name] = attributes.value ?? "";
  }
  return fields;
}

/**
 * Jira's own "Create dashboard" form, submitted with the form's own XSRF token over the signed-in
 * administrator session. Every refusal names its stage and native status; no page content leaves.
 */
async function createDashboardThroughForm(page, origin, name) {
  const form = await page.request.get(`${origin}/secure/AddPortalPage!default.jspa`);
  if (!form.ok())
    throw new QualificationPreparationError("dashboard-form-unavailable", form.status());
  const hidden = hiddenFormFields(await form.text());
  if (!Object.hasOwn(hidden, "atl_token"))
    throw new QualificationPreparationError("dashboard-form-unavailable", form.status());
  const submitted = await page.request.post(`${origin}/secure/AddPortalPage.jspa`, {
    form: {
      ...hidden,
      portalPageName: name,
      portalPageDescription: "Synthetic AC7 dashboard",
      favourite: "true",
    },
    headers: { "X-Atlassian-Token": "no-check" },
    maxRedirects: 0,
  });
  if (submitted.status() !== 302)
    throw new QualificationPreparationError("dashboard-create-refused", submitted.status());
  return /selectPageId=(\d+)/u.exec(submitted.headers().location ?? "")?.[1];
}

async function firstGadgetId(io, id) {
  const dashboard = await io.request("GET", `/rest/dashboards/1.0/${id}`);
  const gadgets = dashboard.status === 200 ? dashboard.value?.gadgets : undefined;
  const found = Array.isArray(gadgets) ? gadgets[0]?.id : undefined;
  return numeric.test(String(found)) ? String(found) : undefined;
}

/** One gadget through the dashboard plugin's own REST resource, as the browser's picker does. */
async function addDashboardItem(io, id) {
  const added = await io.request("POST", `/rest/dashboards/1.0/${id}/gadget`, {
    url: GADGET_URL,
  });
  if (![200, 201].includes(added.status))
    throw new QualificationPreparationError("dashboard-gadget-refused", added.status);
  const direct = String(added.value?.id ?? added.value?.gadgetId);
  const itemId = numeric.test(direct) ? direct : await firstGadgetId(io, id);
  if (itemId === undefined) throw new QualificationPreparationError("dashboard-gadget-refused");
  return itemId;
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
  await uiStep(io, "dashboard-create-refused", (page) =>
    createDashboardThroughForm(page, io.origin, name),
  );
  const id = await dashboardIdByName(io, name);
  if (id === undefined) throw new QualificationPreparationError("dashboard-not-created");
  const itemId = await addDashboardItem(io, id);
  if (!(await itemIsNative(io, id, itemId, name)))
    throw new QualificationPreparationError("dashboard-not-created");
  return { assetDashboard: { id, itemId, name } };
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

/** Retries are bounded; the step observes the native state first, so a repeat never duplicates. */
async function securityStep(io) {
  for (let attempt = 1; attempt <= SECURITY_ATTEMPTS; attempt++) {
    try {
      if (await io.ensureSecurityScheme()) return {};
    } catch {
      // A cold Jira can time out an administration page; the next attempt starts from observation.
    }
    if (attempt < SECURITY_ATTEMPTS) await io.sleep(SECURITY_BACKOFF_MS);
  }
  throw new QualificationPreparationError("security-scheme-unavailable");
}
const SECURITY_ATTEMPTS = 3;
const SECURITY_BACKOFF_MS = 5_000;

const outcomeReason = (error) =>
  error instanceof QualificationPreparationError ? error.reason : "step-unexpected-error";

/**
 * Runs independent steps in order and records each outcome. A failed step never stops the others;
 * only a step that names a failed `needs` entry is skipped, with `dependency-failed`.
 */
export async function runPreparationSteps(steps, initial, persist) {
  let manifest = initial;
  const failed = new Set();
  const outcomes = [];
  for (const step of steps) {
    const dependency = (step.needs ?? []).find((name) => failed.has(name));
    if (dependency !== undefined) {
      failed.add(step.name);
      outcomes.push({
        step: step.name,
        outcome: "skipped",
        reason: "dependency-failed",
        dependency,
      });
      continue;
    }
    try {
      manifest = { ...manifest, ...(await step.run(manifest)) };
      persist(manifest);
      outcomes.push({ step: step.name, outcome: "completed" });
    } catch (error) {
      failed.add(step.name);
      outcomes.push({
        step: step.name,
        outcome: "failed",
        reason: outcomeReason(error),
        ...(Number.isSafeInteger(error?.status) ? { status: error.status } : {}),
      });
    }
  }
  return { manifest, outcomes };
}

/** The email pack goes first: nothing before it may touch an email template. */
export async function prepareOperatorFixtures(session, io, options = {}) {
  const { path, value } = readFixtureManifest(session.directory);
  const nonce = options.nonce ?? randomBytes(4).toString("hex");
  const key = options.permissionAttributeKey ?? DEFAULT_PERMISSION_ATTRIBUTE;
  const steps = [
    { name: "email-default", run: (current) => prepareEmailDefault(io, current, session) },
    { name: "synced-sprints", run: (current) => prepareSyncedSprints(io, current, nonce) },
    { name: "option-field", run: (current) => prepareOptionFixture(io, current, nonce) },
    {
      name: "permission-attribute",
      run: (current) => preparePermissionAttribute(io, current, nonce, key),
    },
    { name: "asset-dashboard", run: (current) => prepareAssetDashboard(io, current, nonce) },
    { name: "security-scheme", run: () => securityStep(io) },
    ...COLLECTION_SEED_STEPS.map(([name, run]) => ({ name, run: (current) => run(io, current) })),
  ];
  privateJson(path, value);
  const { manifest, outcomes } = await runPreparationSteps(steps, value, (current) =>
    privateJson(path, current),
  );
  options.onOutcomes?.(outcomes);
  if (outcomes.some((outcome) => outcome.outcome !== "completed")) {
    const error = new QualificationPreparationError("fixture-steps-failed");
    error.outcomes = outcomes;
    throw error;
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
    ensureSecurityScheme: () => ensureFixtureSecurityScheme(session),
    sleep: (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
  };
}
