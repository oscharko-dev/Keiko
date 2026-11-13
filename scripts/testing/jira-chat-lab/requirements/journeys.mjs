// End-to-end journeys through ordinary Keiko Chat for epic #4173 (#4174).
// Each journey sends a natural request with the Knowledge Pod and Jira Pod bound in Full access,
// approves what the product asks for, and is graded only by an independent Jira or truth oracle.
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { URLSearchParams } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chatReadLogDirectory, jsonRequest, prepareChat, withLiveChat } from "../chat-read.mjs";
import { eachJourneyInLicenseWindow, ensureLicenseWindow } from "./license-window.mjs";
import { LabOutageError, labJiraState } from "./lab-health.mjs";
import { withWorkProjectLock } from "./work-project-lock.mjs";
import { WORK_PROJECT, clearWorkProject } from "./work-project-reset.mjs";
import { actorDetails, basicAuth, checked, labRequest } from "../lab-client.mjs";
import { STRUCTURE_RULES, buildCorpus } from "./corpus.mjs";
import { writeCorpusDocuments } from "./corpus-documents.mjs";
import { FORMATS } from "./formats.mjs";
import { startDuring } from "./mid-turn.mjs";
import { JOURNEYS, JOURNEY_IDS } from "./journey-checks.mjs";
import { COMPOSER_JOURNEYS } from "./composer.mjs";
import { labSprintSetup } from "./field-correction.mjs";
import { aggregateRuns } from "./repeat.mjs";
import {
  classifyJourney,
  gradeException,
  invalidCheck,
  isDeadlineAbort,
  isTransportFailure,
  gatewayEvidenceTrusted,
  readGatewayFailures,
  redCheck,
  redactLabDetail,
  showsOutage,
} from "./validity.mjs";
import { sequentially } from "./journey-support.mjs";

const TURN_LIMIT_MS = 1_800_000;
const READINESS_LIMIT_MS = 120_000;

const api = (ctx, name, path, body, method = "POST", signal = undefined) =>
  jsonRequest(ctx.origin, ctx.cookie, name, path, body, method, signal);

function rulesMarkdown() {
  const lines = ["# Jira-Strukturvorgabe (Projektleitung, synthetisch)", ""];
  for (const [type, rule] of Object.entries(STRUCTURE_RULES)) {
    lines.push(`## ${type}`);
    if (rule.summary) lines.push(`- Zusammenfassung: "${rule.summary}"`);
    lines.push(`- Beschreibung mit den Abschnitten: ${rule.sections.join(", ")}`);
    if (rule.labels) lines.push(`- Labels: ${rule.labels.join(", ")}`);
    if (rule.parent) lines.push("- Muss dem Epic der Anforderung zugeordnet sein");
    if (rule.priority) lines.push("- Priorität ist Pflicht");
    lines.push("");
  }
  return lines.join("\n");
}

const SPECIFICATION_FILE = "Lastenheft-Schadenmeldung.md";

const specificationDirectory = (ctx) => join(ctx.projectPath, "projektunterlagen");

/** Removes the office renderings of the specification (S03) from the Pod's folder. */
function clearOfficeDocuments(directory) {
  for (const name of readdirSync(directory)) {
    if (FORMATS.some(({ extension }) => name.toLowerCase().endsWith(extension))) {
      rmSync(join(directory, name), { force: true });
    }
  }
}

/** Writes the specification of one version under a fixed name, so its document identity persists. */
function writeSpecification(ctx, version) {
  const directory = specificationDirectory(ctx);
  mkdirSync(directory, { recursive: true });
  clearOfficeDocuments(directory);
  writeFileSync(join(directory, SPECIFICATION_FILE), buildCorpus(version).markdown);
  return directory;
}

/** Replaces the Markdown specification by its rendering in one office format (S03). */
function writeSpecificationAs(ctx, format) {
  const directory = specificationDirectory(ctx);
  clearOfficeDocuments(directory);
  rmSync(join(directory, SPECIFICATION_FILE), { force: true });
  const scratch = mkdtempSync(join(tmpdir(), "keiko-lab-formats-"));
  try {
    const rendered = writeCorpusDocuments(scratch, 1).find((path) => path.endsWith(`.${format}`));
    copyFileSync(rendered, join(directory, basename(rendered)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function prepareDataPod(ctx) {
  const directory = writeSpecification(ctx, 1);
  writeFileSync(join(directory, "Jira-Strukturvorgabe.md"), rulesMarkdown());
  const created = await api(ctx, "pod-create", "/api/local-knowledge/capsules", {
    displayName: "Projekt Schadenmeldung Online",
  });
  const path = `/api/local-knowledge/capsules/${encodeURIComponent(created.capsule.id)}`;
  await api(ctx, "pod-connect", `${path}/connection`, {
    scope: { kind: "folder", rootPath: directory, recursive: true },
    displayName: "Projektunterlagen",
  });
  await indexPod(ctx, created.capsule.id);
  return created.capsule.id;
}

/** Indexes (or re-indexes) the Pod's folder and waits for the job to succeed. */
async function indexPod(ctx, capsuleId) {
  const path = `/api/local-knowledge/capsules/${encodeURIComponent(capsuleId)}`;
  const admitted = await api(ctx, "pod-index", `${path}/index`, { confirm: true });
  for (let waited = 0; waited < 600; waited += 1) {
    const detail = await api(ctx, "pod-observe", path, undefined, "GET");
    const job = detail.indexingJobs.find((entry) => entry.id === admitted.jobId);
    if (job?.status === "succeeded") return;
    if (job?.status === "failed" || job?.status === "cancelled") {
      throw new TypeError(`Knowledge Pod indexing ${job.status}`);
    }
    await delay(1_000);
  }
  throw new TypeError("Knowledge Pod indexing timed out");
}

async function selectRulesSkill(ctx, chatId) {
  const { skill } = await api(ctx, "skill-import", "/api/skills", {
    fileName: "Jira-Strukturvorgabe.md",
    contentBase64: Buffer.from(rulesMarkdown()).toString("base64"),
  });
  const current = await api(ctx, "skill-read", `/api/chats/${chatId}/skill`, undefined, "GET");
  await api(
    ctx,
    "skill-select",
    `/api/chats/${chatId}/skill`,
    {
      skill: { id: skill.id, revision: skill.revision, digest: skill.digest },
      expectedRevision: current.selection.revision,
    },
    "PUT",
  );
}

/**
 * A read never waits for a person (owner decision 2026-11-02): the server establishes the grant
 * itself, so a grant that is still pending is a product regression, never a step to approve.
 */
function refuseReadConsent(grant) {
  if (grant?.state === "pending")
    throw new TypeError("A read grant waited for a human decision; the server must establish it");
}

/**
 * Approves one pending write. `observe` runs after the approval is read and before it is decided:
 * the moment at which the product has asked a human and the effect has not happened (S18). The
 * approval and the call it covers are kept for the journey; an observer that fails is recorded as
 * an unobserved approval, never as a reason to leave the approval pending.
 */
async function approveWrite(ctx, exchange, decisions, observe) {
  const approval = exchange.approval;
  if (approval?.state !== "pending" || decisions.ids.has(approval.approvalId)) return;
  decisions.ids.add(approval.approvalId);
  decisions.writes += 1;
  const id = encodeURIComponent(approval.approvalId);
  const path = `/api/atlassian-connectors/chat-write-approval/${id}`;
  const current = await api(ctx, "write-observe", path, undefined, "GET");
  const observed = await Promise.resolve(observe?.()).catch(() => undefined);
  decisions.records.push({ approval: current.approval, call: exchange.call, observed });
  await api(ctx, "write-approve", path, {
    decision: "approve",
    actionDigest: current.approval.actionDigest,
  });
}

async function approvePending(ctx, transcript, decisions, observe) {
  refuseReadConsent(transcript?.readGrant);
  await (transcript?.exchanges ?? []).reduce(
    (previous, exchange) => previous.then(() => approveWrite(ctx, exchange, decisions, observe)),
    Promise.resolve(),
  );
}

function messagesPath(ctx, chat) {
  const chatId = encodeURIComponent(chat.id);
  return `/api/chats/messages?chatId=${chatId}&projectPath=${encodeURIComponent(ctx.projectPath)}`;
}

async function messageIds(ctx, chat) {
  const observed = await api(ctx, "observe", messagesPath(ctx, chat), undefined, "GET");
  return new Set(observed.messages.map((message) => message.id));
}

/**
 * Approves what the product asks for until the request settles or the lab limit passes, and
 * returns how many write approvals it decided (S05 expects exactly one write). Read grants are
 * never decided by anyone: the supervisor refuses one that waits.
 */
async function superviseTurn(ctx, chat, prior, isSettled, { observe, during }) {
  const decisions = { ids: new Set(), writes: 0, records: [], induced: undefined };
  const started = Date.now();
  while (!isSettled() && Date.now() - started < TURN_LIMIT_MS) {
    const observed = await api(ctx, "observe", messagesPath(ctx, chat), undefined, "GET");
    const user = observed.messages.find((m) => m.role === "user" && !prior.has(m.id));
    await approvePending(ctx, user?.toolTranscript, decisions, observe);
    decisions.induced ??= startDuring(during, user?.toolTranscript?.exchanges ?? [], isSettled);
    await delay(500);
  }
  decisions.labLimitReached = !isSettled() && Date.now() - started >= TURN_LIMIT_MS;
  return decisions;
}

async function settledTurn(ctx, chat, prior) {
  const observed = await api(ctx, "observe", messagesPath(ctx, chat), undefined, "GET");
  const fresh = observed.messages.filter((message) => !prior.has(message.id));
  const user = fresh.find((message) => message.role === "user");
  const assistant = fresh.find((message) => message.role === "assistant");
  const toolExchanges = user?.toolTranscript?.exchanges ?? [];
  return {
    answer: assistant?.content ?? assistant?.groundedAnswer?.content ?? "",
    toolCalls: toolExchanges.length,
    toolExchanges,
    requirementReads: toolExchanges.filter((entry) =>
      /knowledge[._]requirements/.test(entry.call?.name ?? ""),
    ).length,
  };
}

/**
 * Sends one Chat request and returns the settled answer, tool exchanges and failure, if any.
 * `options.observeBeforeApproval` is called while a write approval is pending (see approveWrite).
 */
async function chatTurn(ctx, chat, content, options = {}) {
  const prior = await messageIds(ctx, chat);
  const started = Date.now();
  let settled = false;
  let failure;
  let decisions;
  let termination;
  const send = new globalThis.AbortController();
  const pending = api(
    ctx,
    "send",
    "/api/desktop/chat",
    {
      chatId: chat.id,
      projectPath: ctx.projectPath,
      modelId: ctx.modelId,
      clientTurnId: randomUUID(),
      expectedGroundingScopeIdentity: chat.groundingScopeIdentity,
      content,
      memory: { enabled: false, budgetTokens: 0, mode: "governed-assist", context: {} },
    },
    "POST",
    send.signal,
  )
    .catch((error) => (failure = String(error?.message ?? error).slice(0, 300)))
    .finally(() => (settled = true));
  try {
    decisions = await superviseTurn(ctx, chat, prior, () => settled, {
      observe: options.observeBeforeApproval,
      during: options.during,
    });
  } finally {
    // A turn that outlives supervision is cancelled, so it cannot write into the next journey.
    if (!settled) {
      if (decisions?.labLimitReached) termination = "lab-limit";
      send.abort();
    }
    await pending;
  }
  const { writes, records } = decisions;
  return {
    durationMs: Date.now() - started,
    failure,
    termination,
    // The live lab context exposes no resolved product turn budget. A provider request timeout
    // is a different bound; neither it nor this supervision limit proves that product budget.
    limits: { labTurnMs: TURN_LIMIT_MS, productTurnMs: null },
    approvals: { writes, records },
    induced: await decisions.induced,
    ...(await settledTurn(ctx, chat, prior)),
  };
}

// ---------- independent oracle read ----------

function jqlPageBounds(response, startAt, total) {
  const page = response.value;
  if (response.status !== 200 || page === null || typeof page !== "object")
    throw new TypeError("Oracle search response is unavailable");
  if (!Number.isSafeInteger(page.total) || page.total < 0 || page.startAt !== startAt)
    throw new TypeError("Oracle search page has invalid bounds");
  if (total !== undefined && page.total !== total)
    throw new TypeError("Oracle search total changed between pages");
  return page;
}

function admitJqlPage(response, startAt, total) {
  const page = jqlPageBounds(response, startAt, total);
  if (!Array.isArray(page.issues) || page.issues.length > 100)
    throw new TypeError("Oracle search page exceeds the requested size");
  const end = startAt + page.issues.length;
  if (end > page.total || (page.issues.length === 0 && end < page.total))
    throw new TypeError("Oracle search page cannot establish complete coverage");
  return page;
}

function appendJqlIssues(state, issues) {
  for (const issue of issues) {
    if (typeof issue?.key !== "string" || typeof issue.id !== "string")
      throw new TypeError("Oracle search issue identity is unavailable");
    if (state.keys.has(issue.key) || state.ids.has(issue.id))
      throw new TypeError("Oracle search repeated an issue across pages");
    state.keys.add(issue.key);
    state.ids.add(issue.id);
    state.issues.push(issue);
  }
}

/**
 * The account the oracles read Jira as. Jira localizes per user, and the product acts as the lab actor
 * `api`: in a German-language session (`language.json` says `de_DE`) the oracle reads as that same
 * actor, so the type, status and field names it compares are the names the product sees. Any other
 * session reads as the administrator, as it always did.
 */
export function oracleReader(session) {
  if (typeof session?.directory !== "string") return "admin";
  const path = join(session.directory, "language.json");
  if (!existsSync(path)) return "admin";
  return JSON.parse(readFileSync(path, "utf8")).locale === "de_DE" ? "api" : "admin";
}

/**
 * The existing independent search (as `oracleReader`), with receipts of the actual GET pages. `maxResults`
 * records the fixed requested size, not the report tool's own pagination. One flat continuation
 * keeps reads sequential without retaining one unresolved promise per native page.
 */
export function pagedJql(session, query, fields = "summary") {
  const state = { issues: [], pages: [], keys: new Set(), ids: new Set(), total: undefined };
  return new Promise((resolve, reject) => {
    const next = () => {
      const startAt = state.issues.length;
      Promise.resolve()
        .then(() => {
          const path = `/rest/api/2/search?jql=${encodeURIComponent(query)}&startAt=${startAt}&maxResults=100&fields=${encodeURIComponent(fields)}`;
          return labRequest(session, "GET", path, basicAuth(session, oracleReader(session)));
        })
        .then((response) => {
          const page = admitJqlPage(response, startAt, state.total);
          state.total = page.total;
          appendJqlIssues(state, page.issues);
          state.pages.push({
            startAt,
            maxResults: 100,
            total: page.total,
            count: page.issues.length,
          });
          return state.issues.length === page.total;
        })
        .then((complete) => {
          if (complete) resolve({ issues: state.issues, pages: state.pages });
          else next();
        }, reject);
    };
    next();
  });
}

async function jql(session, query, fields = "summary") {
  return (await pagedJql(session, query, fields)).issues;
}
async function jqlCount(session, query) {
  const path = `/rest/api/2/search?jql=${encodeURIComponent(query)}&maxResults=0`;
  const page = await labRequest(session, "GET", path, basicAuth(session, oracleReader(session)));
  if (page.status !== 200 || !Number.isSafeInteger(page.value?.total))
    throw new TypeError(`Oracle count failed (${page.status})`);
  return page.value.total;
}

/** Every comment of one issue (admin read), as { id, body }. */
async function issueComments(session, key) {
  const path = `/rest/api/2/issue/${encodeURIComponent(key)}/comment?maxResults=1000`;
  const page = await labRequest(session, "GET", path, basicAuth(session, "admin"));
  if (page.status !== 200) throw new TypeError(`Oracle comment read failed (${page.status})`);
  return page.value.comments.map(({ id, body }) => ({ id, body }));
}

/** The Chat keeps no selected skill; the Pod's documents and the product are its only sources. */
async function deselectSkill(ctx, chat) {
  const path = `/api/chats/${encodeURIComponent(chat.id)}/skill`;
  const current = await api(ctx, "skill-read", path, undefined, "GET");
  await api(
    ctx,
    "skill-deselect",
    path,
    { skill: null, expectedRevision: current.selection.revision },
    "PUT",
  );
}

/** The local export file of a finished report, as the report card downloads it. */
function exportReport(ctx, chat, reportId, format) {
  const query = new URLSearchParams({ chatId: chat.id, format });
  const path = `/api/atlassian-connectors/jira-reports/${encodeURIComponent(reportId)}/export?${query.toString()}`;
  return api(ctx, "report-export", path, undefined, "GET");
}

/** The product log lines under `root` that contain every needle. */
export function logMatchCount(root, ...needles) {
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const path = stack.pop();
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const stat = statSync(child);
      if (stat.isDirectory()) stack.push(child);
      else if (/\.(jsonl|log|ndjson)$/.test(name))
        count += readFileSync(child, "utf8")
          .split("\n")
          .filter((line) => needles.every((needle) => line.includes(needle))).length;
    }
  }
  return count;
}

/**
 * The mode a journey runs in. Full access by default; S05 proves the single approval of a backlog
 * draft, which only exists in Ask for approval.
 */
const JOURNEY_MODES = Object.freeze({ S05: "governed-assist" });

/** A fresh Chat per journey, so no answer leaks into the next scenario. */
async function freshBoundChat(ctx, session, modelId, capsuleId, toolMode) {
  const base = await prepareChat(ctx.origin, ctx.cookie, session, ctx.projectPath, modelId);
  const bound = await api(
    ctx,
    "bind",
    `/api/chats?id=${encodeURIComponent(base.id)}`,
    {
      localKnowledgeScopes: [{ kind: "capsule", capsuleId, connectedAtMs: Date.now() }],
      toolMode,
      expectedGroundingScopeIdentity: base.groundingScopeIdentity,
    },
    "PATCH",
  );
  await selectRulesSkill(ctx, bound.chat.id);
  // The template routes read the instance through the Chat's Jira Pod.
  const jiraPodBinding = bound.chat.jiraPodBinding ?? base.jiraPodBinding;
  return { ...bound, chat: { ...bound.chat, jiraPodBinding } };
}

/**
 * A fresh Chat for the Composer lane: bound to the Jira Pod only (the default of every Chat), in the
 * given mode. It carries no Knowledge Pod scope and no structure skill (#4369).
 */
async function composerChat(ctx, session, modelId, toolMode) {
  const base = await prepareChat(ctx.origin, ctx.cookie, session, ctx.projectPath, modelId);
  const bound = await api(
    ctx,
    "bind",
    `/api/chats?id=${encodeURIComponent(base.id)}`,
    { toolMode, expectedGroundingScopeIdentity: base.groundingScopeIdentity },
    "PATCH",
  );
  const jiraPodBinding = bound.chat.jiraPodBinding ?? base.jiraPodBinding;
  return { ...bound, chat: { ...bound.chat, jiraPodBinding } };
}

/** The two journey lanes: how a journey's Chat is bound, and which table its id is looked up in. */
// The journey tables are read when a journey runs, not when this module loads: progress-report.mjs
// imports this module, so the tables may still be initializing while the import graph is built.
const DOCUMENT_LANE = Object.freeze({
  get journeys() {
    return JOURNEYS;
  },
  bind: (ctx, session, modelId, capsuleId, mode) =>
    freshBoundChat(ctx, session, modelId, capsuleId, mode),
});
const COMPOSER_LANE = Object.freeze({
  get journeys() {
    return COMPOSER_JOURNEYS;
  },
  bind: (ctx, session, modelId, _capsuleId, mode) => composerChat(ctx, session, modelId, mode),
});

const SYNTHETIC_VALUE = "Synthetic required value";

/**
 * The required fields a native create must still fill, read from the project's own create metadata
 * for the issue type (never from another project's fixture). See `requiredValue` for what each type
 * of field gets; any other required field fails closed, naming the field and the issue type.
 */
export async function requiredFieldValues(session, fields) {
  const auth = basicAuth(session, "admin");
  const project = fields.project.key;
  const typeName = fields.issuetype.name;
  const base = `/rest/api/2/issue/createmeta/${encodeURIComponent(project)}/issuetypes`;
  const types = await checked(session, "composer-create-types", "GET", base, auth);
  const type = (types.values ?? []).find((entry) => entry.name === typeName);
  if (type === undefined) throw new TypeError(`${project} has no issue type ${typeName}`);
  const meta = await checked(
    session,
    "composer-create-meta",
    "GET",
    `${base}/${type.id}?maxResults=200`,
    auth,
  );
  const missing = (meta.values ?? []).filter(
    (field) => field.required && !Object.hasOwn(fields, field.fieldId),
  );
  return Object.fromEntries(
    missing.map((field) => [field.fieldId, requiredValue({ project, typeName }, field)]),
  );
}

/** The synthetic value of the schema types that need no allowed value (a user field is the creator). */
const SCALAR_VALUES = new Map([
  ["user", () => ({ name: actorDetails("admin").name })],
  ["number", () => 1],
  ["date", () => new Date().toISOString().slice(0, 10)],
  ["datetime", () => new Date().toISOString().replace(/Z$/u, "+0000")],
]);

/** The synthetic value of a required field of one schema type, or undefined when none is known. */
function syntheticValue(field) {
  const type = field.schema?.type;
  const first = Array.isArray(field.allowedValues) ? field.allowedValues[0] : undefined;
  if (type === "string" && first === undefined) return SYNTHETIC_VALUE;
  const scalar = SCALAR_VALUES.get(type)?.();
  if (scalar !== undefined) return scalar;
  if (first === undefined) return undefined;
  const option = { id: String(first.id) };
  return type === "array" ? [option] : option;
}

/**
 * A required field gets: a synthetic text, the creating account (a user field such as `reporter`), a
 * number, a date, or the first of its allowed values (an array of them for an array field). Anything
 * else — `parent` included, which only the fixture can name — fails closed with the field's id, name
 * and schema type and the issue type, so a lab error is never a bare "cannot be filled".
 */
function requiredValue({ project, typeName }, field) {
  const value = syntheticValue(field);
  if (value !== undefined) return value;
  throw new TypeError(
    `A required field of ${project} cannot be filled natively: ${field.fieldId} "${field.name ?? "unnamed"}" (schema type ${field.schema?.type ?? "unknown"}) on ${typeName}`,
  );
}

/** What Jira said to a refused native create, as lab text: its messages and per-field errors, bounded. */
function refusalText(value) {
  const messages = Array.isArray(value?.errorMessages) ? value.errorMessages : [];
  const fields = Object.entries(value?.errors ?? {}).map(([id, text]) => `${id}: ${text}`);
  return redactLabDetail([...messages, ...fields].join("; ")).slice(0, 400);
}

/** A native admin create (fixtures of the Composer lane); returns the new issue key. */
async function createNativeIssue(session, fields) {
  const required = await requiredFieldValues(session, fields);
  const created = await labRequest(
    session,
    "POST",
    "/rest/api/2/issue",
    basicAuth(session, "admin"),
    { fields: { ...required, ...fields } },
  );
  if (created.status !== 201 || typeof created.value?.key !== "string")
    throw new TypeError(
      `The native create of a ${fields.issuetype.name} in ${fields.project.key} was refused (HTTP ${created.status}): ${refusalText(created.value)}`,
    );
  return created.value.key;
}

export { JOURNEY_IDS };

/** The live plumbing the journey checks are given (see journey-checks.mjs). */
export function journeyContext(live, session, truth) {
  const ctx = {
    ...live,
    truth,
    // The account the oracles read Jira as (the administrator unless the session is German).
    oracleReader: oracleReader(session),
    // The type and status names that account sees, for the oracles that compare names.
    displayNames: async () => {
      const reader = oracleReader(session);
      if (reader === "admin") return { types: new Map(), statuses: new Map() };
      const read = (actor) => (path) =>
        checked(session, "native-read", "GET", path, basicAuth(session, actor));
      const { displayNames } = await import("./large-project.mjs");
      return displayNames({ english: read("admin"), local: read(reader) });
    },
    turn: (chat, content, options) => chatTurn(ctx, chat, content, options),
    // The stored assistant message of the Chat (its grounded-answer uncertainty is the flag state).
    storedAnswer: async (chat) =>
      (await api(ctx, "stored-answer", messagesPath(ctx, chat), undefined, "GET")).messages
        .filter((message) => message.role === "assistant")
        .at(-1),
    // A page reload re-reads the conversation from the product; the count of messages it holds.
    reloadChat: async (chat) =>
      (await api(ctx, "reload", messagesPath(ctx, chat), undefined, "GET")).messages.length,
    search: (query, fields) => jql(session, query, fields),
    searchPages: (query, fields) => pagedJql(session, query, fields),
    count: (query) => jqlCount(session, query),
    http: (name, path, body, method = "POST") => api(ctx, name, path, body, method),
    deselectSkill: (chat) => deselectSkill(ctx, chat),
    comments: (key) => issueComments(session, key),
    exportReport: (chat, reportId, format) => exportReport(ctx, chat, reportId, format),
    refusals: () => logMatchCount(chatReadLogDirectory(session), "generation-changed"),
    // Only the end the mode change caused: a turn that ended on its own proves nothing.
    turnEnds: () =>
      logMatchCount(
        chatReadLogDirectory(session),
        "chat.tool-turn.ended",
        '"reason":"authority-invalid"',
      ),
    labSprint: () => labSprintSetup(session, WORK_PROJECT),
    // The oracles that derive their expectation from Jira itself (the S10 estimate rule).
    nativeGet: (path) =>
      checked(session, "native-read", "GET", path, basicAuth(session, oracleReader(session))),
    ...(/^[A-Z][A-Z0-9]{1,9}$/u.test(process.env.KEIKO_JIRA_LAB_ESTIMATE_PROJECT ?? "")
      ? { estimateProject: process.env.KEIKO_JIRA_LAB_ESTIMATE_PROJECT }
      : {}),
    nativeCreate: (fields) => createNativeIssue(session, fields),
  };
  return ctx;
}

/** Runs the selected journeys in one live Keiko session and returns checks keyed by scenario. */
/**
 * A journey that is not green names why at once, so a lane in progress can be diagnosed against
 * the Activity Log window it ran in before the scorecard is written.
 */
function reportJourney(id, { status, detail }, started, run) {
  console.log(
    JSON.stringify({
      operation: "requirements-journey",
      id,
      run,
      status,
      startedAt: new Date(started).toISOString(),
      ...(status === "green" || detail === undefined ? {} : { detail }),
    }),
  );
}

/**
 * S14 replaces the shared specification. A restoration that failed leaves a stale or partly
 * indexed specification: the run is invalid and no later run may start from that fixture.
 */
async function restoreSpecification(ctx, check) {
  try {
    await ctx.replaceSpecification(1);
    return check;
  } catch (error) {
    const detail = redactLabDetail(String(error?.message ?? error)).slice(0, 200);
    console.log(JSON.stringify({ operation: "requirements-restore", error: detail }));
    ctx.specificationRestoreFailed = true;
    return invalidCheck("lab-error", `specification restore failed: ${detail}`, check);
  }
}

/** One journey in its own fresh bound Chat; a lab error is an invalid check, a failed Keiko route stays red. */
async function runJourney({ ctx, session, modelId, capsuleId, id, lane = DOCUMENT_LANE }) {
  let check;
  try {
    const mode = JOURNEY_MODES[id] ?? "autonomous-delivery";
    check = await withWorkProjectLock(
      session.directory,
      id,
      async () => {
        const bound = await lane.bind(ctx, session, modelId, capsuleId, mode);
        return lane.journeys[id](ctx, bound.chat);
      },
      {
        log: (line) => console.log(JSON.stringify(line)),
        onWait: () => api(ctx, "session-keepalive", "/api/skills", undefined, "GET"),
        prepare: () =>
          clearWorkProject(session, WORK_PROJECT, {
            log: (line) => console.log(JSON.stringify({ ...line, id })),
          }),
      },
    );
  } catch (error) {
    check = gradeException(error);
  }
  if (id === "S14") check = await restoreSpecification(ctx, check);
  return check;
}

/**
 * A cheap model readiness check through the ordinary Chat route before a journey: one short turn
 * in a fresh unbound Chat. Returns undefined when the model answered, otherwise
 * `{ unavailable, detail }`: `unavailable` only when the Activity Log window of the readiness
 * turn shows an infrastructure failure or the error is a transport signature; any other failure
 * is a failed Keiko route and is the product's.
 */
export async function modelUnavailable(ctx, session, modelId) {
  const fromMs = Date.now();
  try {
    const base = await prepareChat(ctx.origin, ctx.cookie, session, ctx.projectPath, modelId);
    await api(
      ctx,
      "readiness",
      "/api/desktop/chat",
      {
        chatId: base.id,
        projectPath: ctx.projectPath,
        modelId,
        clientTurnId: randomUUID(),
        expectedGroundingScopeIdentity: base.groundingScopeIdentity,
        content: "Reply with the single word OK.",
        memory: { enabled: false, budgetTokens: 0, mode: "governed-assist", context: {} },
      },
      "POST",
      globalThis.AbortSignal.timeout(READINESS_LIMIT_MS),
    );
    return undefined;
  } catch (error) {
    const detail = redactLabDetail(String(error?.message ?? error)).slice(0, 200);
    const logRoot = chatReadLogDirectory(session);
    const failures = readGatewayFailures(logRoot, {
      fromMs,
      toMs: Date.now(),
      pid: process.pid,
    });
    const evidenceTrusted = gatewayEvidenceTrusted(logRoot, failures);
    // The readiness turn's own deadline fired: a hung model is unavailable, not a product failure.
    const unavailable =
      showsOutage(failures) || isTransportFailure(detail) || isDeadlineAbort(error);
    return { unavailable, evidenceTrusted, detail };
  }
}

/** One graded run: readiness first, then the journey re-graded against its gateway evidence. */
async function gradedRun({ lane, labState = labJiraState, ...run }) {
  const { ctx, session, modelId, capsuleId, id, readiness } = run;
  // A journey that starts while the lab's own Jira is down is invalid with that cause, never red.
  const before = await labState(session);
  if (before.state !== "licensed")
    return invalidCheck("lab-outage", `the laboratory Jira was ${before.state} before the journey`);
  const refused = await readiness(ctx, session, modelId);
  if (refused !== undefined) {
    if (refused.unavailable)
      return invalidCheck("model-unavailable", `model unavailable: ${refused.detail}`);
    // A failure whose gateway evidence is unreadable cannot be attributed to the product.
    if (refused.evidenceTrusted === false)
      return invalidCheck("lab-error", `readiness evidence unavailable: ${refused.detail}`);
    return redCheck("product-route-failed", `readiness turn failed: ${refused.detail}`);
  }
  const fromMs = Date.now();
  const check = await runJourney({ ctx, session, modelId, capsuleId, id, lane });
  const logRoot = chatReadLogDirectory(session);
  const failures = readGatewayFailures(logRoot, { fromMs, toMs: Date.now(), pid: process.pid });
  // A failed journey is re-read against the lab's own Jira: an outage during it is the lab's.
  const after = check.status === "green" ? undefined : (await labState(session)).state;
  return classifyJourney(check, failures, gatewayEvidenceTrusted(logRoot, failures), after);
}

/**
 * Runs every selected journey `repeat` times, each in a fresh Chat, and returns the checks keyed
 * by scenario: the single run itself for `repeat` 1, otherwise the aggregate over the runs.
 */
export async function runJourneys(options) {
  const { session, modelId, embeddingModelId, repeat = 1 } = options;
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20) {
    throw new TypeError("Invalid journey repeat count");
  }
  const checks = {};
  await withLiveChat({
    session,
    modelId,
    embeddingModelId,
    modelRetries: 1,
    retainState: true,
    run: (live) => runLane(live, options, checks),
  });
  return checks;
}

/** The Knowledge Pod lane: the corpus, its Pod and the structure skill, as every journey had them. */
async function prepareDocumentLane(ctx, session, modelId) {
  const capsuleId = await prepareDataPod(ctx);
  // S14 replaces the specification with its next version; it runs last and restores version 1.
  ctx.replaceSpecification = async (version) => {
    writeSpecification(ctx, version);
    await indexPod(ctx, capsuleId);
  };
  // S03 puts the specification into the Pod as one office format; S18 and S19 need further Chats.
  ctx.useSpecificationFormat = async (format) => {
    writeSpecificationAs(ctx, format);
    await indexPod(ctx, capsuleId);
  };
  ctx.freshChat = async (toolMode) =>
    (await freshBoundChat(ctx, session, modelId, capsuleId, toolMode)).chat;
  return capsuleId;
}

/** The ordered ids; S14 replaces the shared specification, so it always runs last. */
const journeyOrder = (ids) => [
  ...ids.filter((id) => id !== "S14"),
  ...ids.filter((id) => id === "S14"),
];

async function runLane(live, options, checks) {
  const { session, directory, modelId, truth, ids, repeat = 1 } = options;
  const ctx = journeyContext(live, session, truth);
  // The Composer lane has no Knowledge Pod: nothing is prepared and no Pod is bound (#4369).
  const composer = options.set === "composer";
  const capsuleId = composer ? undefined : await prepareDocumentLane(ctx, session, modelId);
  if (composer) {
    ctx.freshChat = async (toolMode) => (await composerChat(ctx, session, modelId, toolMode)).chat;
    // The types and modes this run selected (`--types`, `--modes`); empty means all of them.
    ctx.composerSelection = options.composerSelection ?? {};
  }
  const guard = licenseGuard(session, directory);
  const run = { ctx, session, modelId, capsuleId, lane: composer ? COMPOSER_LANE : DOCUMENT_LANE };
  const ports = {
    readiness: options.readiness ?? modelUnavailable,
    labState: options.labState ?? labJiraState,
  };
  await eachJourneyInLicenseWindow(journeyOrder(ids), guard.ensure, async (id) => {
    if (guard.outage() !== undefined) {
      checks[id] = invalidCheck("lab-outage", guard.outage().message);
      return;
    }
    const runs = await sequentially(
      Array.from({ length: repeat }, (_, i) => i + 1),
      (number) => timedRun({ ...run, id, ...ports }, number),
    );
    checks[id] = repeat === 1 ? runs[0] : aggregateRuns(runs);
  });
}

/**
 * The license window before each journey. A Jira that stays down past the bound ends that journey
 * as a lab outage (`outage()`), not the whole run; any other failure still stops the run.
 */
function licenseGuard(session, directory) {
  let outage;
  return {
    outage: () => outage,
    ensure: async (minimumSeconds) => {
      outage = undefined;
      try {
        await ensureLicenseWindow(session, directory, minimumSeconds);
      } catch (error) {
        if (!(error instanceof LabOutageError)) throw error;
        outage = error;
      }
    },
  };
}

async function timedRun(args, run) {
  const started = Date.now();
  const check = args.ctx.specificationRestoreFailed
    ? invalidCheck("lab-error", "specification restore failed in an earlier run")
    : await gradedRun(args);
  check.durationMs = Date.now() - started;
  reportJourney(args.id, check, started, run);
  return check;
}
