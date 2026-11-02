// Model-free write check of the requirements lab (#4176): every field the laboratory Jira lists for
// an issue type is written through Keiko's production mutation path, one at a time, and read back
// from Jira. Metadata alone cannot prove this: a field can be accepted by the projection and still
// never land, or be declared on a tool that was never able to write it. The check writes into its
// own project, so a journey's work project and its grading stay untouched.
// Lab-side code may know Jira Software's field schemas; product code may not.
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { URL, pathToFileURL } from "node:url";
import { basicAuth, checked, labRequest } from "../lab-client.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const mutations = await import(
  pathToFileURL(join(REPO, "packages/keiko-connectors/dist/jira-managed-mutations.js")).href
);
const fieldMetadata = await import(
  pathToFileURL(join(REPO, "packages/keiko-connectors/dist/jira-field-metadata.js")).href
);

/** The check's own project. No journey names it. */
const WRITE_CHECK_PROJECT = "FLD";
const SCRUM = "com.pyxis.greenhopper.jira:gh-scrum-template";
const ACTOR = "keiko-api";
const EDIT_USER = "keiko-editor";
// The connector accepts https only; the lab's transport below maps it to the plain lab port.
const CONNECTION_URL = "https://jira.lab.test";
const TEXT = "Lab write check";
const FIXED_BY_CREATE = new Set(["project", "issuetype"]);
const THROUGH_OWN_TOOL = new Set(["comment", "attachment", "issuelinks"]);
const GREENHOPPER = "com.pyxis.greenhopper.jira:";

// Keiko refuses a second issue that repeats an earlier one: every sample text is its own.
const RUN = randomBytes(4).toString("hex");
let textSequence = 0;
function nextText() {
  textSequence += 1;
  return `${TEXT} ${RUN} ${textSequence}`;
}

const OPAQUE_SAMPLES = Object.freeze({
  [`${GREENHOPPER}gh-epic-link`]: (context) => context.epicKey,
  [`${GREENHOPPER}gh-epic-label`]: () => nextText(),
  [`${GREENHOPPER}gh-sprint`]: (context) => context.sprintId,
  [`${GREENHOPPER}gh-epic-color`]: () => "ghx-label-1",
});

function reference(values) {
  const first = values?.[0];
  return first === undefined ? undefined : { id: first.id };
}

const KIND_SAMPLES = Object.freeze({
  text: () => nextText(),
  number: () => 3,
  date: () => "2027-01-15",
  datetime: () => "2027-01-15T10:00:00.000+0000",
  strings: () => ["lab-write-check"],
  user: (_raw, context) => ({ name: context.userName ?? ACTOR }),
  users: (_raw, context) => [{ name: context.userName ?? ACTOR }],
  option: (raw) => reference(raw.allowedValues),
  options: (raw) => {
    const value = reference(raw.allowedValues);
    return value === undefined ? undefined : [value];
  },
  issue: (_raw, context) => ({ key: context.parentKey }),
});

function opaqueSample(raw, context) {
  if (raw.schema?.system === "timetracking") return { originalEstimate: "1h" };
  const known = OPAQUE_SAMPLES[raw.schema?.custom];
  return known === undefined ? nextText() : known(context);
}

/** A value of the shape Jira states for the field; undefined when the instance offers no choice. */
export function sampleFieldValue(kind, raw, context) {
  if (kind === "opaque") return opaqueSample(raw, context);
  return KIND_SAMPLES[kind]?.(raw, context);
}

function holds(sample, actual) {
  if (Array.isArray(sample))
    return Array.isArray(actual) && sample.every((item) => actual.some((one) => holds(item, one)));
  if (typeof sample === "object" && sample !== null)
    return (
      typeof actual === "object" &&
      actual !== null &&
      Object.entries(sample).every(([key, value]) => holds(value, actual[key]))
    );
  return String(actual).startsWith(String(sample));
}

/** Whether Jira now holds the value. An opaque field's stored form is Jira's own: not empty counts. */
export function readBackHolds(kind, sample, actual) {
  if (actual === null || actual === undefined) return false;
  if (kind === "opaque") return !Array.isArray(actual) || actual.length > 0;
  return holds(sample, actual);
}

/** What Jira itself decided. Any other failure after a write is not Jira refusing the field. */
const JIRA_REFUSALS = new Set(["field-validation", "permission-denied"]);

/**
 * One write's outcome. A refusal counts against Keiko unless the request reached Jira and Jira
 * answered with its own refusal: that is Jira's decision, listed for the reader, not hidden.
 */
export function classifyWrite(attempt, reachedJira, heldAfterwards) {
  if (attempt.ok) return heldAfterwards ? "written" : "not-held";
  if (!reachedJira) return "refused-by-keiko";
  return JIRA_REFUSALS.has(attempt.reason) ? "refused-by-jira" : "failed-after-write";
}

function labHttp(session) {
  const auth = basicAuth(session, "api");
  const state = { writes: 0 };
  const http = async ({ method, url, bodyJson, upload, signal }) => {
    if (method !== "GET") state.writes += 1;
    const { pathname, search } = new URL(url);
    const response = await globalThis.fetch(`${session.origin}${pathname}${search}`, {
      method,
      redirect: "manual",
      ...(signal === undefined ? {} : { signal }),
      headers: {
        Accept: "application/json",
        Authorization: auth,
        ...(bodyJson === undefined ? {} : { "Content-Type": "application/json" }),
        ...(upload === undefined
          ? {}
          : { "Content-Type": upload.contentType, "X-Atlassian-Token": "no-check" }),
      },
      ...(bodyJson === undefined ? {} : { body: bodyJson }),
      ...(upload === undefined ? {} : { body: upload.bytes }),
    });
    const bodyText = await response.text();
    return {
      kind: "response",
      status: response.status,
      bodyText,
      bodyBytes: Buffer.byteLength(bodyText),
      truncated: false,
    };
  };
  return { http, state };
}

const ATTACHMENT = Buffer.from("Lab write check attachment\n");
const attachmentSource = async () => ({
  ok: true,
  content: {
    name: "lab-write-check.txt",
    bytes: ATTACHMENT,
    sha256: createHash("sha256").update(ATTACHMENT).digest("hex"),
  },
});

function writer(session) {
  const { http, state } = labHttp(session);
  const connection = {
    deployment: "data-center",
    baseUrl: CONNECTION_URL,
    http,
    attachmentSource,
  };
  const context = { signal: globalThis.AbortSignal.timeout(600_000), beforeEffect: () => true };
  return async (operation, source) => {
    const before = state.writes;
    const attempt = await mutations.executeJiraManagedMutation(
      operation,
      source,
      context,
      connection,
    );
    return { attempt, reachedJira: state.writes > before };
  };
}

async function adminRead(session, path) {
  const result = await labRequest(session, "GET", path, basicAuth(session, "admin"));
  if (result.status !== 200) throw new TypeError(`Laboratory read failed (${result.status})`);
  return result.value;
}

async function ensureWriteCheckProject(session) {
  const auth = basicAuth(session, "admin");
  const path = `/rest/api/2/project/${WRITE_CHECK_PROJECT}`;
  const existing = await labRequest(session, "GET", path, auth);
  if (existing.status !== 200)
    await checked(session, "field-write-project", "POST", "/rest/api/2/project", auth, {
      key: WRITE_CHECK_PROJECT,
      name: "Field write check",
      projectTypeKey: "software",
      projectTemplateKey: SCRUM,
      lead: "keiko-admin",
      assigneeType: "UNASSIGNED",
    });
  await Promise.all(
    ["10002", "10001", "10000"].map((id) =>
      labRequest(session, "POST", `${path}/role/${id}`, auth, { user: [ACTOR] }),
    ),
  );
  return adminRead(session, path);
}

async function ensureSprint(session, auth) {
  const boards = await adminRead(
    session,
    `/rest/agile/1.0/board?projectKeyOrId=${WRITE_CHECK_PROJECT}`,
  );
  const board = boards.values?.[0]?.id;
  const sprints = await adminRead(session, `/rest/agile/1.0/board/${board}/sprint?state=future`);
  const existing = sprints.values?.[0]?.id;
  if (existing !== undefined) return existing;
  const created = await labRequest(session, "POST", "/rest/agile/1.0/sprint", auth, {
    name: "Lab sprint",
    originBoardId: board,
  });
  return created.value?.id;
}

/** Choices a new project lacks, so that each choice field has something to offer. */
async function ensureChoices(session, project) {
  const auth = basicAuth(session, "admin");
  if ((project.components ?? []).length === 0)
    await labRequest(session, "POST", "/rest/api/2/component", auth, {
      name: "Lab component",
      project: WRITE_CHECK_PROJECT,
    });
  if ((project.versions ?? []).length === 0)
    await labRequest(session, "POST", "/rest/api/2/version", auth, {
      name: "Lab version",
      project: WRITE_CHECK_PROJECT,
    });
  return ensureSprint(session, auth);
}

async function createMetadata(session, typeName) {
  const types = await adminRead(
    session,
    `/rest/api/2/issue/createmeta/${WRITE_CHECK_PROJECT}/issuetypes`,
  );
  const type = types.values.find((value) => value.name === typeName);
  if (type === undefined) return undefined;
  const page = await adminRead(
    session,
    `/rest/api/2/issue/createmeta/${WRITE_CHECK_PROJECT}/issuetypes/${type.id}?maxResults=200`,
  );
  return { typeId: type.id, fields: page.values };
}

function fieldsToWrite(raw) {
  const parsed = fieldMetadata.parseJiraFieldMetadata(raw);
  if (!parsed.ok) throw new TypeError(`Metadata refused by Keiko: ${parsed.reason}`);
  const byId = new Map(raw.map((field) => [field.fieldId, field]));
  return parsed.fields
    .filter((field) => !FIXED_BY_CREATE.has(field.id) && !THROUGH_OWN_TOOL.has(field.id))
    .map((field) => ({
      id: field.id,
      name: field.name,
      kind: field.kind,
      raw: byId.get(field.id),
    }));
}

function requiredValues(fields, context) {
  return Object.fromEntries(
    fields
      .filter((field) => field.raw.required)
      .map((field) => [field.id, sampleFieldValue(field.kind, field.raw, context)]),
  );
}

async function createIssue(write, created, target, fields) {
  const result = await write("jira.create", {
    projectId: target.projectId,
    issueTypeId: target.typeId,
    fields,
  });
  const issueKey = result.attempt.receipt?.issueKey;
  if (result.attempt.ok && issueKey !== undefined) created.push(issueKey);
  return { ...result, issueKey };
}

async function issueField(session, key, fieldId) {
  const issue = await adminRead(
    session,
    `/rest/api/2/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fieldId)}`,
  );
  return issue.fields?.[fieldId];
}

async function createOneField(run, field) {
  const sample = sampleFieldValue(field.kind, field.raw, run.context);
  if (sample === undefined) return { ...field, operation: "create", outcome: "no-choice-offered" };
  const fields = { ...requiredValues(run.fields, run.context), [field.id]: sample };
  const { attempt, reachedJira, issueKey } = await createIssue(
    run.write,
    run.created,
    run.target,
    fields,
  );
  const actual = attempt.ok ? await issueField(run.session, issueKey, field.id) : undefined;
  const held = attempt.ok && readBackHolds(field.kind, sample, actual);
  return {
    ...field,
    operation: "create",
    reason: attempt.reason,
    outcome: classifyWrite(attempt, reachedJira, held),
  };
}

async function editOneField(run, issueKey, field) {
  const sample = sampleFieldValue(field.kind, field.raw, run.context);
  if (sample === undefined) return { ...field, operation: "edit", outcome: "no-choice-offered" };
  const { attempt, reachedJira } = await run.write("jira.edit", {
    issueKey,
    fields: { [field.id]: sample },
  });
  const actual = attempt.ok ? await issueField(run.session, issueKey, field.id) : undefined;
  const held = attempt.ok && readBackHolds(field.kind, sample, actual);
  return {
    ...field,
    operation: "edit",
    reason: attempt.reason,
    outcome: classifyWrite(attempt, reachedJira, held),
  };
}

/** Comment, attachment and link have their own calls: each must land like a field does. */
async function ownToolWrites(run, issueKey) {
  const comment = await run.write("jira.comment", { issueKey, body: TEXT });
  const comments = comment.attempt.ok ? await issueField(run.session, issueKey, "comment") : null;
  const attach = await run.write("jira.attach", {
    issueKey,
    source: { kind: "connected-file", path: "lab-write-check.txt" },
  });
  const files = attach.attempt.ok ? await issueField(run.session, issueKey, "attachment") : [];
  const link = await run.write("jira.edit", {
    issueKey,
    links: [{ type: "Relates", direction: "outward", issueKey: run.context.parentKey }],
  });
  const links = link.attempt.ok ? await issueField(run.session, issueKey, "issuelinks") : [];
  const row = (id, result, held) => ({
    id,
    name: id,
    operation: "own-call",
    outcome: classifyWrite(result.attempt, result.reachedJira, held),
  });
  return [
    row(
      "comment",
      comment,
      (comments?.comments ?? []).some((item) => item.body === TEXT),
    ),
    row(
      "attachment",
      attach,
      (files ?? []).some((item) => item.filename === "lab-write-check.txt"),
    ),
    row("issuelinks", link, (links ?? []).length > 0),
  ];
}

async function editableFields(session, issueKey) {
  const meta = await adminRead(session, `/rest/api/2/issue/${issueKey}/editmeta`);
  return fieldsToWrite(
    Object.entries(meta.fields).map(([fieldId, field]) => ({ ...field, fieldId })),
  );
}

async function sequentially(items, step) {
  const results = [];
  for (const item of items) {
    results.push(await step(item)); // NOSONAR typescript:S9382 -- one Jira write after the other.
  }
  return results;
}

async function typeWrites(run) {
  const created = await sequentially(run.fields, (field) => createOneField(run, field));
  const base = await createIssue(run.write, run.created, run.target, {
    ...requiredValues(run.fields, run.context),
  });
  if (!base.attempt.ok)
    return [
      ...created,
      {
        id: "base",
        name: "base issue",
        operation: "create",
        reason: base.attempt.reason,
        outcome: classifyWrite(base.attempt, base.reachedJira, false),
      },
    ];
  const { issueKey } = base;
  const editable = await editableFields(run.session, issueKey);
  // A value the issue already holds changes nothing, and Keiko rightly reports no change: an edit
  // sets another user than the one the create wrote.
  const editing = { ...run, context: { ...run.context, userName: EDIT_USER } };
  const edited = await sequentially(editable, (field) => editOneField(editing, issueKey, field));
  return [...created, ...edited, ...(await ownToolWrites(run, issueKey))];
}

async function deleteCreated(session, keys) {
  const auth = basicAuth(session, "admin");
  await Promise.all(
    [...keys]
      .reverse()
      .map((key) =>
        labRequest(session, "DELETE", `/rest/api/2/issue/${key}?deleteSubtasks=true`, auth),
      ),
  );
}

async function anchorIssue(session, write, created, projectId, typeName, extra) {
  const metadata = await createMetadata(session, typeName);
  const fields = fieldsToWrite(metadata.fields);
  const target = { projectId, typeId: metadata.typeId };
  const context = { epicKey: undefined, parentKey: extra?.parentKey, sprintId: extra?.sprintId };
  const { attempt, issueKey } = await createIssue(
    write,
    created,
    target,
    requiredValues(fields, context),
  );
  if (!attempt.ok) throw new TypeError(`Anchor ${typeName} refused: ${attempt.reason}`);
  return issueKey;
}

const SETTLED = new Set(["written", "refused-by-jira", "no-choice-offered"]);
const failing = (results) => results.filter((result) => !SETTLED.has(result.outcome));

/** Every field of one issue type, written and read back. Issues it created are removed again. */
async function fieldWriteCheck(session, typeName) {
  const project = await ensureWriteCheckProject(session);
  const sprintId = await ensureChoices(session, project);
  const metadata = await createMetadata(session, typeName);
  if (metadata === undefined)
    return { status: "red", detail: `issue type ${typeName} missing in lab` };
  const write = writer(session);
  const created = [];
  try {
    const epicKey = await anchorIssue(session, write, created, project.id, "Epic");
    const parentKey = await anchorIssue(session, write, created, project.id, "Task");
    const run = {
      session,
      write,
      created,
      fields: fieldsToWrite(metadata.fields),
      target: { projectId: project.id, typeId: metadata.typeId },
      context: { epicKey, parentKey, sprintId },
    };
    const results = await typeWrites(run);
    return { results, failed: failing(results) };
  } finally {
    await deleteCreated(session, created);
  }
}

const named = (results) =>
  results.map(({ name, operation }) => `${name} (${operation})`).join(", ");

/** The probe-layer check of one issue type. */
export async function fieldWriteProbe(session, typeName) {
  const { results, failed, status, detail } = await fieldWriteCheck(session, typeName);
  if (results === undefined) return { status, detail };
  const refused = results.filter((result) => result.outcome === "refused-by-jira");
  const written = results.filter((result) => result.outcome === "written").length;
  const note = refused.length === 0 ? "" : `; refused by Jira itself: ${named(refused)}`;
  return failed.length === 0
    ? {
        status: "green",
        covers: ["fields-writable"],
        detail: `${typeName}: ${written} of ${results.length} writes landed and read back${note}`,
      }
    : {
        status: "red",
        covers: ["fields-writable"],
        detail: `${typeName}: ${failed.length} of ${results.length} writes failed: ${failed.map(({ name, operation, outcome }) => `${name} (${operation}, ${outcome})`).join(", ")}${note}`,
      };
}
