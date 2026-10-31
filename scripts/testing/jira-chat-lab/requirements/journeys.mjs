// End-to-end journeys through ordinary Keiko Chat for epic #4173 (#4174).
// Each journey sends a natural request with the Knowledge Pod and Jira Pod bound in Full access,
// approves what the product asks for, and is graded only by an independent Jira or truth oracle.
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { jsonRequest, prepareChat, withLiveChat } from "../chat-read.mjs";
import { basicAuth, labRequest } from "../lab-client.mjs";
import { STRUCTURE_RULES, buildCorpus } from "./corpus.mjs";
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

async function prepareDataPod(ctx) {
  const directory = join(ctx.projectPath, "projektunterlagen");
  mkdirSync(directory, { recursive: true });
  const corpus = buildCorpus(1);
  writeFileSync(join(directory, corpus.fileName), corpus.markdown);
  writeFileSync(join(directory, "Jira-Strukturvorgabe.md"), rulesMarkdown());
  const created = await api(ctx, "pod-create", "/api/local-knowledge/capsules", {
    displayName: "Projekt Schadenmeldung Online",
  });
  const path = `/api/local-knowledge/capsules/${encodeURIComponent(created.capsule.id)}`;
  await api(ctx, "pod-connect", `${path}/connection`, {
    scope: { kind: "folder", rootPath: directory, recursive: true },
    displayName: "Projektunterlagen",
  });
  const admitted = await api(ctx, "pod-index", `${path}/index`, { confirm: true });
  for (let waited = 0; waited < 600; waited += 1) {
    const detail = await api(ctx, "pod-observe", path, undefined, "GET");
    const job = detail.indexingJobs.find((entry) => entry.id === admitted.jobId);
    if (job?.status === "succeeded") return created.capsule.id;
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

async function approveWrite(ctx, approval, decisions) {
  if (approval?.state !== "pending" || decisions.ids.has(approval.approvalId)) return;
  decisions.ids.add(approval.approvalId);
  decisions.writes += 1;
  const id = encodeURIComponent(approval.approvalId);
  const path = `/api/atlassian-connectors/action-approvals/${id}/chat-write-approval`;
  const current = await api(ctx, "write-observe", path, undefined, "GET");
  await api(ctx, "write-approve", path, {
    decision: "approve",
    actionDigest: current.approval.actionDigest,
  });
}

async function approvePending(ctx, transcript, decisions) {
  await approveReadGrant(ctx, transcript?.readGrant, decisions);
  for (const exchange of transcript?.exchanges ?? []) {
    await approveWrite(ctx, exchange.approval, decisions);
  }
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
async function superviseTurn(ctx, chat, prior, isSettled) {
  const decisions = { ids: new Set(), reads: 0, writes: 0 };
  const started = Date.now();
  while (!isSettled() && Date.now() - started < TURN_LIMIT_MS) {
    const observed = await api(ctx, "observe", messagesPath(ctx, chat), undefined, "GET");
    const user = observed.messages.find((m) => m.role === "user" && !prior.has(m.id));
    await approvePending(ctx, user?.toolTranscript, decisions);
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
  };
}

/** Sends one Chat request and returns the settled answer, tool exchanges and failure, if any. */
async function chatTurn(ctx, chat, content) {
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
    decisions = await superviseTurn(ctx, chat, prior, () => settled);
  } finally {
    // A turn that outlives supervision is cancelled, so it cannot write into the next journey.
    if (!settled) send.abort();
    await pending;
  }
  const { reads, writes } = decisions;
  return {
    durationMs: Date.now() - started,
    failure,
    approvals: { reads, writes },
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
  return bound;
}

export { JOURNEY_IDS };

/** Runs the selected journeys in one live Keiko session and returns checks keyed by scenario. */
export async function runJourneys({ session, modelId, embeddingModelId, truth, ids }) {
  const checks = {};
  await withLiveChat({
    session,
    modelId,
    embeddingModelId,
    modelRetries: 1,
    retainState: true,
    run: async (live) => {
      const ctx = {
        ...live,
        truth,
        turn: (chat, content) => chatTurn(ctx, chat, content),
        search: (query, fields) => jql(session, query, fields),
        refusals: () => logMatchCount(ctx.root, "generation-changed"),
      };
      const capsuleId = await prepareDataPod(ctx);
      for (const id of ids) {
        const started = Date.now();
        try {
          const mode = JOURNEY_MODES[id] ?? "autonomous-delivery";
          const bound = await freshBoundChat(ctx, session, modelId, capsuleId, mode);
          checks[id] = await JOURNEYS[id](ctx, bound.chat);
        } catch (error) {
          checks[id] = { status: "red", detail: `lab error: ${error.message}` };
        }
        checks[id].durationMs = Date.now() - started;
        console.log(
          JSON.stringify({ operation: "requirements-journey", id, status: checks[id].status }),
        );
      }
    },
  });
  return checks;
}
