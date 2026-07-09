import {
  type CodeContextConnector,
  type CodeContextRawComment,
  type CodeContextRawObject,
  type CodeContextRef,
  type JiraCodeContextRef,
} from "./codeContextConnector.js";

export interface JiraCodeContextHttpRequest {
  readonly method: "GET";
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
}

export interface JiraCodeContextHttpPort {
  readJson(request: JiraCodeContextHttpRequest): Promise<unknown>;
}

const JIRA_PROJECT_RE = /^[A-Z][A-Z0-9_]{1,20}$/u;
const JIRA_NUMBER_RE = /^[1-9][0-9]{0,9}$/u;

export function createJiraCodeContextConnector(
  http: JiraCodeContextHttpPort,
): CodeContextConnector {
  return {
    read: async (ref): Promise<CodeContextRawObject> => readJiraCodeContext(http, ref),
  };
}

export function buildJiraCodeContextRequest(ref: JiraCodeContextRef): JiraCodeContextHttpRequest {
  const issueKey = jiraIssueKey(ref);
  return {
    method: "GET",
    path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    query: { fields: "summary,description,comment" },
  };
}

async function readJiraCodeContext(
  http: JiraCodeContextHttpPort,
  ref: CodeContextRef,
): Promise<CodeContextRawObject> {
  const jiraRef = assertJiraRef(ref);
  const json = await http.readJson(buildJiraCodeContextRequest(jiraRef));
  return rawObjectFromJira(jiraRef, json);
}

function assertJiraRef(ref: CodeContextRef): JiraCodeContextRef {
  if (ref.source !== "jira") throw new Error("Jira connector received non-Jira ref");
  return ref;
}

function rawObjectFromJira(ref: JiraCodeContextRef, json: unknown): CodeContextRawObject {
  const body = asRecord(json, "Jira issue");
  const fields = asRecord(body.fields, "Jira issue fields");
  return {
    source: "jira",
    objectKind: "issue",
    objectId: ref.objectId,
    title: optionalString(fields.summary),
    body: textFromUnknown(fields.description),
    comments: commentsFromJira(fields.comment),
    url: undefined,
  };
}

function jiraIssueKey(ref: JiraCodeContextRef): string {
  const projectKey = assertProjectKey(ref.projectKey);
  const objectId = assertJiraNumber(ref.objectId);
  return `${projectKey}-${objectId}`;
}

function assertProjectKey(value: string): string {
  if (!JIRA_PROJECT_RE.test(value)) throw new Error("projectKey must be a Jira project key");
  return value;
}

function assertJiraNumber(value: string): string {
  if (!JIRA_NUMBER_RE.test(value)) throw new Error("objectId must be a positive Jira issue number");
  return value;
}

function commentsFromJira(value: unknown): readonly CodeContextRawComment[] {
  if (value === undefined) return [];
  const commentEnvelope = asRecord(value, "Jira comment envelope");
  const comments = commentEnvelope.comments;
  if (!Array.isArray(comments)) return [];
  return comments.map((entry) => {
    const comment = asRecord(entry, "Jira comment");
    return { id: optionalString(comment.id), body: textFromUnknown(comment.body) };
  });
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join("\n");
  if (typeof value !== "object" || value === null) return "";
  return textFromRecord(value);
}

function textFromRecord(value: object): string {
  const record = value as Record<string, unknown>;
  const ownText = typeof record.text === "string" ? record.text : "";
  const nestedText = textFromUnknown(record.content);
  return [ownText, nestedText].filter(Boolean).join("\n");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} response must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
