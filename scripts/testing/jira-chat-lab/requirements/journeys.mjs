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

async function approveReadGrant(ctx, grant, decided) {
  if (grant?.state !== "pending" || decided.has(grant.grantId)) return;
  decided.add(grant.grantId);
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

async function approveWrite(ctx, approval, decided) {
  if (approval?.state !== "pending" || decided.has(approval.approvalId)) return;
  decided.add(approval.approvalId);
  const id = encodeURIComponent(approval.approvalId);
  const path = `/api/atlassian-connectors/action-approvals/${id}/chat-write-approval`;
  const current = await api(ctx, "write-observe", path, undefined, "GET");
  await api(ctx, "write-approve", path, {
    decision: "approve",
    actionDigest: current.approval.actionDigest,
  });
}

async function approvePending(ctx, transcript, decided) {
  await approveReadGrant(ctx, transcript?.readGrant, decided);
  for (const exchange of transcript?.exchanges ?? []) {
    await approveWrite(ctx, exchange.approval, decided);
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

/** Approves what the product asks for until the request settles or the lab limit passes. */
async function superviseTurn(ctx, chat, prior, isSettled) {
  const decided = new Set();
  const started = Date.now();
  while (!isSettled() && Date.now() - started < TURN_LIMIT_MS) {
    const observed = await api(ctx, "observe", messagesPath(ctx, chat), undefined, "GET");
    const user = observed.messages.find((m) => m.role === "user" && !prior.has(m.id));
    await approvePending(ctx, user?.toolTranscript, decided);
    await delay(500);
  }
}

async function settledTurn(ctx, chat, prior) {
  const observed = await api(ctx, "observe", messagesPath(ctx, chat), undefined, "GET");
  const fresh = observed.messages.filter((message) => !prior.has(message.id));
  const user = fresh.find((message) => message.role === "user");
  const assistant = fresh.find((message) => message.role === "assistant");
  return {
    answer: assistant?.content ?? assistant?.groundedAnswer?.content ?? "",
    toolCalls: user?.toolTranscript?.exchanges?.length ?? 0,
  };
}

/** Sends one Chat request and returns the settled answer, tool exchanges and failure, if any. */
async function chatTurn(ctx, chat, content) {
  const prior = await messageIds(ctx, chat);
  const started = Date.now();
  let settled = false;
  let failure;
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
    await superviseTurn(ctx, chat, prior, () => settled);
  } finally {
    // A turn that outlives supervision is cancelled, so it cannot write into the next journey.
    if (!settled) send.abort();
    await pending;
  }
  return { durationMs: Date.now() - started, failure, ...(await settledTurn(ctx, chat, prior)) };
}

// ---------- independent oracles ----------

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

const jiraTime = (ms) => new Date(ms - 60_000).toISOString().slice(0, 16).replace("T", " ");

function sectionsPresent(description, sections) {
  return sections.every((name) =>
    new RegExp(`(^|\\n)\\s*(h\\d\\.|#+)?\\s*\\**${name}`, "i").test(description ?? ""),
  );
}

function epicConforms(issue, requirementId) {
  const rule = STRUCTURE_RULES.Epic;
  return (
    issue.fields.summary.startsWith(`[${requirementId}]`) &&
    sectionsPresent(issue.fields.description, rule.sections) &&
    rule.labels.every((label) => issue.fields.labels?.includes(label))
  );
}

const result = (status, turn, detail) => ({
  status,
  detail: `${detail}; ${Math.round(turn.durationMs / 1000)} s, ${turn.toolCalls} tool calls${turn.failure ? `, failed: ${turn.failure}` : ""}`,
});

const JOURNEYS = {
  async S04(ctx, chat) {
    const truth = buildCorpus(1).truth.map((item) => item.id);
    const turn = await chatTurn(
      ctx,
      chat,
      "Liste ALLE Anforderungen aus dem Lastenheft im Wissens-Pod vollständig auf: je Zeile ID, Titel, Priorität und Kapitel. Nutze kein Jira-Werkzeug.",
    );
    const found = new Set(turn.answer.match(/LH-\d{3}/g) ?? []);
    const missing = truth.filter((id) => !found.has(id));
    const extra = [...found].filter((id) => !truth.includes(id));
    const ok = missing.length === 0 && extra.length === 0;
    return result(
      ok ? "green" : "red",
      turn,
      `${truth.length - missing.length}/${truth.length} requirements listed, ${extra.length} invented`,
    );
  },
  async S05(ctx, chat) {
    const since = jiraTime(Date.now());
    const ids = ["LH-001", "LH-002", "LH-003"];
    const turn = await chatTurn(
      ctx,
      chat,
      `Lege im Jira-Projekt REQ für die Anforderungen ${ids.join(", ")} aus dem Lastenheft je ein Epic genau nach der Strukturvorgabe an. Ermittle Felder und Pflichtfelder mit den Jira-Werkzeugen. Melde die Vorgangsschlüssel oder den genauen Fehler.`,
    );
    const epics = await jql(
      ctx.session,
      `project = REQ AND issuetype = Epic AND created >= "${since}"`,
      "summary,description,labels",
    );
    const conforming = ids.filter(
      (id) => epics.filter((epic) => epicConforms(epic, id)).length === 1,
    );
    return result(
      conforming.length === ids.length && epics.length === ids.length ? "green" : "red",
      turn,
      `${conforming.length}/${ids.length} conforming epics, ${epics.length} epics created`,
    );
  },
  async S07(ctx, chat) {
    const since = jiraTime(Date.now());
    const turn = await chatTurn(
      ctx,
      chat,
      "Lege im Jira-Projekt REQ zwei Umsetzungsaufgaben (Vorgangstyp Task) für die Anforderung LH-002 nach der Strukturvorgabe an und ordne sie dem Epic von LH-002 zu. Lege das Epic an, falls es fehlt. Melde die Schlüssel oder den genauen Fehler.",
    );
    const link = ctx.truth.fieldIds.epicLink;
    const epics = await jql(
      ctx.session,
      'project = REQ AND issuetype = Epic AND summary ~ "LH-002"',
    );
    const epicKeys = new Set(epics.map((epic) => epic.key));
    const tasks = await jql(
      ctx.session,
      `project = REQ AND issuetype = Task AND created >= "${since}"`,
      `summary,description,${link}`,
    );
    const good = tasks.filter(
      (task) =>
        epicKeys.has(task.fields[link]) &&
        sectionsPresent(task.fields.description, STRUCTURE_RULES.Task.sections),
    );
    return result(
      good.length >= 2 ? "green" : "red",
      turn,
      `${good.length} of ${tasks.length} new tasks linked to the LH-002 epic with required sections`,
    );
  },
  async S10(ctx, chat) {
    const turn = await chatTurn(
      ctx,
      chat,
      "Werte den Fortschritt des Jira-Projekts RPT aus. Antworte mit genau einer Zeile je Kombination im Format TYP;STATUS;ANZAHL für alle Vorgänge des Projekts, ohne weitere Zeilen.",
    );
    const issues = await jql(ctx.session, "project = RPT", "issuetype,status");
    const expected = new Map();
    for (const issue of issues) {
      const key = `${issue.fields.issuetype.name};${issue.fields.status.name}`.toLowerCase();
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    const reported = new Map(
      [...turn.answer.matchAll(/^\s*([^;\n]+);([^;\n]+);\s*(\d+)\s*$/gm)].map((m) => [
        `${m[1].trim()};${m[2].trim()}`.toLowerCase(),
        Number(m[3]),
      ]),
    );
    const matched = [...expected].filter(([key, count]) => reported.get(key) === count).length;
    const ok = matched === expected.size && reported.size === expected.size;
    return result(
      ok ? "green" : "red",
      turn,
      `${matched}/${expected.size} type/status counts exact over ${issues.length} issues`,
    );
  },
  async S11(ctx, chat) {
    const expected = new Set(
      ctx.truth.issues.filter((issue) => issue.deviations.length > 0).map((issue) => issue.key),
    );
    const turn = await chatTurn(
      ctx,
      chat,
      "Prüfe als Projektleiter jeden Vorgang des Jira-Projekts RPT gegen die Strukturvorgabe und liste die Schlüssel ALLER abweichenden Vorgänge mit ihren Abweichungen auf.",
    );
    const reported = new Set(turn.answer.match(/RPT-\d+/g) ?? []);
    const hits = [...expected].filter((key) => reported.has(key)).length;
    const falseFindings = [...reported].filter((key) => !expected.has(key)).length;
    const ok = hits === expected.size && falseFindings === 0;
    return result(
      ok ? "green" : "red",
      turn,
      `${hits}/${expected.size} deviating issues found, ${falseFindings} false findings`,
    );
  },
  async S17(ctx, chat) {
    const since = jiraTime(Date.now());
    const muss = buildCorpus(1)
      .truth.filter((item) => item.priority === "Muss")
      .map((item) => item.id);
    const refusalsBefore = logMatchCount(ctx.root, "generation-changed");
    const turn = await chatTurn(
      ctx,
      chat,
      "Lege im Jira-Projekt REQ für ALLE Anforderungen mit Priorität Muss aus dem Lastenheft je ein Epic nach der Strukturvorgabe an. Melde am Ende alle angelegten Schlüssel.",
    );
    const epics = await jql(
      ctx.session,
      `project = REQ AND issuetype = Epic AND created >= "${since}"`,
    );
    // Only this turn's refusals count; earlier journeys share the same live log.
    const refused = logMatchCount(ctx.root, "generation-changed") > refusalsBefore;
    const ok = !turn.failure && turn.answer.length > 0 && epics.length === muss.length && !refused;
    return result(
      ok ? "green" : "red",
      turn,
      `${epics.length}/${muss.length} epics created, answer ${turn.answer.length > 0 ? "present" : "missing"}${refused ? ", generation-changed refusal logged" : ""}`,
    );
  },
};

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

export const JOURNEY_IDS = Object.freeze(Object.keys(JOURNEYS));

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
      const ctx = { ...live, truth };
      const capsuleId = await prepareDataPod(ctx);
      for (const id of ids) {
        const started = Date.now();
        try {
          // A fresh Chat per journey, so no answer leaks into the next scenario.
          const base = await prepareChat(
            live.origin,
            live.cookie,
            session,
            live.projectPath,
            modelId,
          );
          const bound = await api(
            ctx,
            "bind",
            `/api/chats?id=${encodeURIComponent(base.id)}`,
            {
              localKnowledgeScopes: [{ kind: "capsule", capsuleId, connectedAtMs: Date.now() }],
              toolMode: "autonomous-delivery",
              expectedGroundingScopeIdentity: base.groundingScopeIdentity,
            },
            "PATCH",
          );
          await selectRulesSkill(ctx, bound.chat.id);
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
