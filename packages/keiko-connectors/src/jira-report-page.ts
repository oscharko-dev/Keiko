import { asArray, asRecord } from "./atlassian-sync-classify.js";
import type { JiraReportHttp } from "./jira-report-http.js";
import type { JiraReportFieldPlan } from "./jira-report-issue.js";
import type { JiraReportFailure } from "./jira-report-metadata.js";

/**
 * One request carries at most this many characters of field ids, far below the URL ceilings of the
 * proxies in front of a Data Center instance. A longer list is split across requests, never refused.
 */
export const JIRA_REPORT_FIELD_CHUNK_CHARS = 4000;

const BASE_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "project",
  "parent",
  "issuelinks",
  "labels",
  "assignee",
  "duedate",
];

/** Every field the report reads, except the parent candidates already shown not to hold a key. */
function fieldIdsOf(plan: JiraReportFieldPlan): readonly string[] {
  const ids = new Set<string>(BASE_FIELDS);
  ids.add(plan.estimateFieldId);
  for (const id of plan.parentFieldIds) if (!plan.parentFieldsRejected.has(id)) ids.add(id);
  for (const fields of plan.requiredByType.values()) for (const id of fields) ids.add(id);
  for (const id of plan.checker?.fieldIds ?? []) ids.add(id);
  if (plan.includeDescription) ids.add("description");
  return [...ids];
}

/** The field lists of one page's requests; each response is merged by issue key. */
export function jiraReportFieldChunks(plan: JiraReportFieldPlan): readonly string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const id of fieldIdsOf(plan)) {
    if (current.length > 0 && size + id.length + 1 > JIRA_REPORT_FIELD_CHUNK_CHARS) {
      chunks.push(current.join(","));
      current = [];
      size = 0;
    }
    current.push(id);
    size += id.length + 1;
  }
  chunks.push(current.join(","));
  return chunks;
}

export type JiraReportPageFetch =
  | { readonly kind: "page"; readonly body: Record<string, unknown> }
  | { readonly kind: "failed"; readonly reason: JiraReportFailure }
  | { readonly kind: "moved" };

function mergeIssue(left: unknown, right: unknown): unknown {
  const first = asRecord(left);
  const second = asRecord(right);
  if (first === undefined || second === undefined || first.key !== second.key) return undefined;
  return { ...first, fields: { ...asRecord(first.fields), ...asRecord(second.fields) } };
}
/** The responses must describe the same issues in the same order, or the scope moved between them. */
function mergePages(
  bodies: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  const [first, ...rest] = bodies;
  if (first === undefined) return undefined;
  let issues = asArray(first.issues);
  if (issues === undefined) return first;
  for (const body of rest) {
    const other = asArray(body.issues);
    if (other?.length !== issues.length || body.total !== first.total) return undefined;
    const merged: unknown[] = issues.map((issue, index) => mergeIssue(issue, other[index]));
    if (merged.includes(undefined)) return undefined;
    issues = merged;
  }
  return { ...first, issues };
}

/** One page of the search: every field chunk is requested at the same offset and merged. */
export async function fetchJiraReportPage(
  http: JiraReportHttp,
  plan: JiraReportFieldPlan,
  window: { readonly jql: string; readonly startAt: number; readonly maxResults: number },
): Promise<JiraReportPageFetch> {
  const outcomes = await Promise.all(
    jiraReportFieldChunks(plan).map((fields) =>
      http.getRecord(
        `search?${new URLSearchParams({
          jql: window.jql,
          startAt: String(window.startAt),
          maxResults: String(window.maxResults),
          fields,
        }).toString()}`,
      ),
    ),
  );
  const bodies: Record<string, unknown>[] = [];
  for (const outcome of outcomes) {
    if (!outcome.ok) return { kind: "failed", reason: outcome.reason };
    bodies.push(outcome.body);
  }
  const body = mergePages(bodies);
  return body === undefined ? { kind: "moved" } : { kind: "page", body };
}
