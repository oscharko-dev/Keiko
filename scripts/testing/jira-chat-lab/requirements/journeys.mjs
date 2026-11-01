// End-to-end journeys through ordinary Keiko Chat for epic #4173 (#4174).
// Each journey sends a natural request with the Knowledge Pod and Jira Pod bound in Full access,
// approves what the product asks for, and is graded only by an independent Jira or truth oracle.
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
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
import { jsonRequest, prepareChat, withLiveChat } from "../chat-read.mjs";
import { withWorkProjectLock } from "./work-project-lock.mjs";
import { basicAuth, labRequest } from "../lab-client.mjs";
import { STRUCTURE_RULES, buildCorpus } from "./corpus.mjs";
import { writeCorpusDocuments } from "./corpus-documents.mjs";
import { FORMATS } from "./formats.mjs";
import { JOURNEYS, JOURNEY_IDS } from "./journey-checks.mjs";

const TURN_LIMIT_MS = 1_800_000;

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

async function approveReadGrant(ctx, grant, decisions) {
  if (grant?.state !== "pending" || decisions.ids.has(grant.grantId)) return;
  decisions.ids.add(grant.grantId);
  decisions.reads += 1;
  const id = encodeURIComponent(grant.grantId);
  await api(
    ctx,
    "read-consent",
    `/api/atlassian-connectors/action-approvals/${id}/chat-read-consent`,
    {
      decision: "approve",
      disclosureVersion: grant.disclosureVersion,
    },
  );
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
  const path = `/api/atlassian-connectors/action-approvals/${id}/chat-write-approval`;
  const current = await api(ctx, "write-observe", path, undefined, "GET");
  const observed = await Promise.resolve(observe?.()).catch(() => undefined);
  decisions.records.push({ approval: current.approval, call: exchange.call, observed });
  await api(ctx, "write-approve", path, {
    decision: "approve",
    actionDigest: current.approval.actionDigest,
  });
}

async function approvePending(ctx, transcript, decisions, observe) {
  await approveReadGrant(ctx, transcript?.readGrant, decisions);
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
 * returns how many read grants and write approvals it decided (S05 expects exactly one write).
 */
async function superviseTurn(ctx, chat, prior, isSettled, observe) {
  const decisions = { ids: new Set(), reads: 0, writes: 0, records: [] };
  const started = Date.now();
  while (!isSettled() && Date.now() - started < TURN_LIMIT_MS) {
    const observed = await api(ctx, "observe", messagesPath(ctx, chat), undefined, "GET");
    const user = observed.messages.find((m) => m.role === "user" && !prior.has(m.id));
    await approvePending(ctx, user?.toolTranscript, decisions, observe);
    await delay(500);
  }
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
    decisions = await superviseTurn(ctx, chat, prior, () => settled, options.observeBeforeApproval);
  } finally {
    // A turn that outlives supervision is cancelled, so it cannot write into the next journey.
    if (!settled) send.abort();
    await pending;
  }
  const { reads, writes, records } = decisions;
  return {
    durationMs: Date.now() - started,
    failure,
    approvals: { reads, writes, records },
    ...(await settledTurn(ctx, chat, prior)),
  };
}

// ---------- independent oracle read ----------

async function jql(session, query, fields = "summary") {
  const issues = [];
  for (let startAt = 0; ; startAt += 100) {
    const path = `/rest/api/2/search?jql=${encodeURIComponent(query)}&startAt=${startAt}&maxResults=100&fields=${fields}`;
    const page = await labRequest(session, "GET", path, basicAuth(session, "admin"));
    if (page.status !== 200) throw new TypeError(`Oracle search failed (${page.status})`);
    issues.push(...page.value.issues);
    if (startAt + page.value.issues.length >= page.value.total) return issues;
  }
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

function logMatchCount(root, needle) {
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const path = stack.pop();
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const stat = statSync(child);
      if (stat.isDirectory()) stack.push(child);
      else if (/\.(jsonl|log|ndjson)$/.test(name))
        count += readFileSync(child, "utf8").split(needle).length - 1;
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

export { JOURNEY_IDS };

/** The live plumbing the journey checks are given (see journey-checks.mjs). */
function journeyContext(live, session, truth) {
  const ctx = {
    ...live,
    truth,
    turn: (chat, content, options) => chatTurn(ctx, chat, content, options),
    search: (query, fields) => jql(session, query, fields),
    http: (name, path, body, method = "POST") => api(ctx, name, path, body, method),
    deselectSkill: (chat) => deselectSkill(ctx, chat),
    comments: (key) => issueComments(session, key),
    exportReport: (chat, reportId, format) => exportReport(ctx, chat, reportId, format),
    refusals: () => logMatchCount(ctx.root, "generation-changed"),
  };
  return ctx;
}

/** Runs the selected journeys in one live Keiko session and returns checks keyed by scenario. */
/**
 * A journey that is not green names why at once, so a lane in progress can be diagnosed against
 * the Activity Log window it ran in before the scorecard is written.
 */
function reportJourney(id, { status, detail }, started) {
  console.log(
    JSON.stringify({
      operation: "requirements-journey",
      id,
      status,
      startedAt: new Date(started).toISOString(),
      ...(status === "green" || detail === undefined ? {} : { detail }),
    }),
  );
}

/** One journey in its own fresh bound Chat; a lab error is a red check, never a lost scenario. */
async function runJourney({ ctx, session, modelId, capsuleId, id }) {
  let check;
  try {
    const mode = JOURNEY_MODES[id] ?? "autonomous-delivery";
    check = await withWorkProjectLock(
      session.directory,
      id,
      async () => {
        const bound = await freshBoundChat(ctx, session, modelId, capsuleId, mode);
        return JOURNEYS[id](ctx, bound.chat);
      },
      {
        log: (line) => console.log(JSON.stringify(line)),
        onWait: () => api(ctx, "session-keepalive", "/api/skills", undefined, "GET"),
      },
    );
  } catch (error) {
    check = { status: "red", detail: `lab error: ${error.message}` };
  }
  if (id === "S14") {
    await ctx.replaceSpecification(1).catch((error) => {
      console.log(
        JSON.stringify({ operation: "requirements-restore", error: String(error.message) }),
      );
    });
  }
  return check;
}

export async function runJourneys({ session, modelId, embeddingModelId, truth, ids }) {
  const checks = {};
  await withLiveChat({
    session,
    modelId,
    embeddingModelId,
    modelRetries: 1,
    retainState: true,
    run: async (live) => {
      const ctx = journeyContext(live, session, truth);
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
      const ordered = [...ids.filter((id) => id !== "S14"), ...ids.filter((id) => id === "S14")];
      for (const id of ordered) {
        const started = Date.now();
        checks[id] = await runJourney({ ctx, session, modelId, capsuleId, id });
        checks[id].durationMs = Date.now() - started;
        reportJourney(id, checks[id], started);
      }
    },
  });
  return checks;
}
