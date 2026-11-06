// Extends the existing Jira browser fixture. Only model/Jira wire responses are scripted;
// the browser, BFF, Knowledge store/tools, managed MCP, approval and journal stay real.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateCapsuleState } from "../../../packages/keiko-local-knowledge/dist/index.js";
import { seedCapsuleWithVectors } from "../../../packages/keiko-local-knowledge/dist/testing.js";
import { openKnowledgeStoreForDeps } from "../../../packages/keiko-server/dist/local-knowledge-store-open.js";

const EPIC = "10002";
const TASK = "10003";
const EPIC_NAME = "customfield_17701";
const EPIC_LINK = "customfield_17702";
const EPIC_SECTIONS = ["Objective", "Scope", "Requirements", "Acceptance criteria", "Dependencies"];
const TASK_SECTIONS = ["Context", "Implementation", "Acceptance criteria"];
export const BACKLOG_CRITERIA = [
  "The migration report includes every selected account.",
  "The migration report identifies rejected records.",
  "The validation records the account balance difference.",
  "The validation fails when the balance difference is nonzero.",
];
const SOURCE = [
  "# Migration requirements",
  "",
  "### DEMO-001 Migration report",
  "",
  "The service shall create a migration report for the selected accounts.",
  "",
  "Acceptance criteria:",
  ...BACKLOG_CRITERIA.slice(0, 2).map((text) => `- ${text}`),
  "",
  "### DEMO-002 Balance validation",
  "",
  "The service shall validate migrated balances against the source accounts.",
  "",
  "Acceptance criteria:",
  ...BACKLOG_CRITERIA.slice(2).map((text) => `- ${text}`),
  "",
].join("\n");

export async function seedBacklogPod(deps) {
  const session = openKnowledgeStoreForDeps(deps);
  try {
    const pod = await seedCapsuleWithVectors(session.store, {
      capsuleId: "b55870fd-6145-4576-a0de-012ac7b6b289",
      displayName: "Migration browser requirements",
      safeDisplayName: "migration-requirements.md",
      text: SOURCE,
    });
    updateCapsuleState(session.store, pod.capsuleId, "ready");
    return {
      id: pod.capsuleId,
      name: "Migration browser requirements",
      criteria: BACKLOG_CRITERIA,
    };
  } finally {
    session.close();
  }
}

export function saveBacklogTemplates(deps) {
  for (const [name, sections, fields] of [
    ["Epic", EPIC_SECTIONS, ["Description", "Epic Name"]],
    ["Task", TASK_SECTIONS, ["Description", "Epic Link"]],
  ]) {
    const markdown = [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: KEIKO",
      `issueType: ${name}`,
      "activateOn: [create]",
      `requiredFields: [${fields.join(", ")}]`,
      "---",
      `# ${name} template`,
      ...sections.map((section) => `## ${section}`),
    ].join("\n");
    deps.store.markdownSkills.import({
      fileName: `${name.toLowerCase()}-browser-backlog.md`,
      contentBase64: Buffer.from(markdown).toString("base64"),
    });
  }
}

function field(id, type, required = false) {
  return {
    fieldId: id,
    name: id,
    required,
    hasDefaultValue: false,
    operations: ["set"],
    schema: { type, system: id },
  };
}
function fieldsFor(typeId) {
  return [
    field("project", "project", true),
    field("issuetype", "issuetype", true),
    { ...field("summary", "string", true), name: "Summary" },
    { ...field("description", "string"), name: "Description" },
    {
      ...field("labels", "array"),
      operations: ["set", "add", "remove"],
      schema: { type: "array", items: "string", system: "labels" },
    },
    typeId === EPIC
      ? {
          ...field(EPIC_NAME, "string"),
          name: "Epic Name",
          schema: { type: "string", custom: "com.pyxis.greenhopper.jira:gh-epic-label" },
        }
      : {
          ...field(EPIC_LINK, "string"),
          name: "Epic Link",
          schema: { type: "string", custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
        },
  ];
}

export function createBacklogJiraRoutes(directory, observation, bodyOf, json) {
  const issues = [];
  const persist = () =>
    writeFileSync(join(directory, "backlog-issues.json"), JSON.stringify(issues), { mode: 0o600 });
  persist();
  return async (request, response, path, url) => {
    if (request.method === "GET") {
      const value = backlogRead(path, url, issues);
      if (value === undefined) return false;
      if (path.includes("/issue/KEIKO-")) {
        observation.counts.confirmations++;
        observation.persist();
      }
      json(response, 200, value);
      return true;
    }
    if (request.method !== "POST" || path !== "/jira/rest/api/2/issue") return false;
    const body = await bodyOf(request);
    const issue = {
      id: String(11000 + issues.length),
      key: `KEIKO-${String(issues.length + 1)}`,
      fields: body.fields,
    };
    issues.push(issue);
    observation.counts.writes++;
    observation.persist();
    persist();
    json(response, 201, { id: issue.id, key: issue.key });
    return true;
  };
}

function backlogRead(path, url, issues) {
  if (/\/project\/(?:10000|KEIKO)$/u.test(path))
    return { id: "10000", key: "KEIKO", name: "Synthetic project" };
  const type = /\/issuetype\/(10002|10003)$/u.exec(path)?.[1];
  if (type !== undefined) return { id: type, name: type === EPIC ? "Epic" : "Task" };
  const metadata = /\/createmeta\/(?:10000|KEIKO)\/issuetypes\/(10002|10003)$/u.exec(path)?.[1];
  if (metadata !== undefined) {
    const values = fieldsFor(metadata);
    return { values, start: 0, size: values.length, last: true, total: values.length };
  }
  if (path.endsWith("/search")) {
    const label = /labels = "([^"]+)"/u.exec(url.searchParams.get("jql") ?? "")?.[1];
    const found = issues.filter(
      (issue) => Array.isArray(issue.fields.labels) && issue.fields.labels.includes(label),
    );
    return { startAt: 0, maxResults: 50, total: found.length, issues: found };
  }
  return issues.find((issue) => path.endsWith(`/issue/${issue.key}`));
}

function observations(messages) {
  const names = new Map();
  const results = [];
  for (const message of messages) {
    for (const call of message.tool_calls ?? [])
      names.set(call.id, { name: call.function.name, args: JSON.parse(call.function.arguments) });
    if (message.role !== "tool") continue;
    const envelope = JSON.parse(message.content);
    const result = envelope.result ?? envelope;
    results.push({ ...names.get(message.tool_call_id), data: result.data, status: result.status });
  }
  return results;
}
function completed(results, name, predicate = () => true) {
  return results.findLast(
    (result) => result.name === name && result.status === "completed" && predicate(result.data),
  )?.data;
}
function documentRef(results) {
  const inventory = completed(results, "knowledge_documents", (data) => data?.view === "inventory");
  const document = inventory?.items?.[0];
  if (document === undefined) throw new TypeError("Missing actual Knowledge inventory receipt");
  return { documentScope: document.documentScope, revisionDigest: document.revisionDigest };
}
function description(sections, unit) {
  const criteria = unit.acceptanceCriteria.map((criterion) => `* ${criterion.text}`).join("\n");
  return sections
    .map(
      (section) =>
        `h2. ${section}\n${section === "Acceptance criteria" ? criteria : unit.statement}`,
    )
    .join("\n\n");
}
function stagedItems(results) {
  const units = completed(results, "knowledge_requirements")?.items;
  if (units?.length !== 2) throw new TypeError("Missing two original requirement observations");
  return {
    items: [
      {
        ref: "epic",
        projectId: "10000",
        issueTypeId: EPIC,
        fields: {
          summary: "Migration readiness",
          description: description(EPIC_SECTIONS, units[0]),
          [EPIC_NAME]: "Migration readiness",
        },
        requirementIds: [units[0].reference],
      },
      {
        ref: "task",
        projectId: "10000",
        issueTypeId: TASK,
        fields: {
          summary: "Validate migration",
          description: description(TASK_SECTIONS, units[1]),
        },
        requirementIds: [units[1].reference],
        parent: { fieldId: EPIC_LINK, ref: "epic" },
      },
    ],
  };
}
function reference(results) {
  const stage = completed(results, "jira_draft_stage");
  if (stage === undefined) throw new TypeError("Missing actual staged draft receipt");
  return { draftId: stage.draftId, draftDigest: stage.draftDigest };
}
function nextBacklogCall(current, all) {
  if (!completed(current, "knowledge_documents", (data) => data?.view === "read"))
    return ["knowledge_documents", { view: "read", ...documentRef(all) }];
  if (!completed(current, "knowledge_requirements"))
    return ["knowledge_requirements", { view: "units" }];
  if (!completed(current, "knowledge_review")) return ["knowledge_review", documentRef(all)];
  for (const issueTypeId of [EPIC, TASK]) {
    if (
      !current.some(
        (result) =>
          result.name === "jira_create_fields" &&
          result.status === "completed" &&
          result.args?.issueTypeId === issueTypeId,
      )
    )
      return ["jira_create_fields", { projectKey: "KEIKO", issueTypeId }];
  }
  if (!completed(current, "jira_draft_stage")) return ["jira_draft_stage", stagedItems(all)];
  if (!completed(current, "jira_draft")) return ["jira_draft", reference(all)];
  return undefined;
}

function isSemanticReview(body) {
  return body.response_format?.json_schema?.name === "knowledge_document_review";
}

function backlogPrompt(turnMessages) {
  return String(turnMessages.find((message) => message.role === "user")?.content ?? "");
}

function replayReference(text) {
  // The grounded user message wraps the literal question with excerpts and repair instructions.
  const match = /\{"draftId":"([0-9a-f-]{36})","draftDigest":"([0-9a-f]{64})"\}/u.exec(text);
  if (match === null) throw new TypeError("Missing explicit reviewed staged draft reference");
  return { draftId: match[1], draftDigest: match[2] };
}

function nextJourneyCall(text, current, all) {
  if (!text.includes("JIRA_E2E_REPLAY")) return nextBacklogCall(current, all);
  return completed(current, "jira_draft") ? undefined : ["jira_draft", replayReference(text)];
}

export function backlogModelMessage(body, turnMessages) {
  if (isSemanticReview(body))
    return { role: "assistant", content: JSON.stringify({ complete: true, findings: [] }) };
  const text = backlogPrompt(turnMessages);
  if (!text.includes("JIRA_E2E_BACKLOG") && !text.includes("JIRA_E2E_REPLAY")) return undefined;
  // The grounded route separately synthesizes the verified tool turn without a tool catalog.
  if (!Array.isArray(body.tools)) return completedBacklogMessage();
  const all = observations(Array.isArray(body.messages) ? body.messages : []);
  const current = observations(turnMessages);
  const next = nextJourneyCall(text, current, all);
  if (next === undefined) return completedBacklogMessage();
  const [name, args] = next;
  if (!body.tools?.some((tool) => tool.function?.name === name))
    throw new TypeError(`Missing offered ${name}`);
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: `backlog-${String(current.length)}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function completedBacklogMessage() {
  return {
    role: "assistant",
    content: "JIRA_E2E_BACKLOG_DONE: the reviewed backlog is verified.",
  };
}
