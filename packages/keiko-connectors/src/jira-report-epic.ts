import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import type { JiraReportHttp } from "./jira-report-http.js";
import type { JiraReportFailure } from "./jira-report-metadata.js";
import { compareCodePoints } from "./jira-report-order.js";

/**
 * The composed Epic clause stays well below the URL ceilings of the proxies in front of a Data
 * Center instance (the search is a GET); an Epic whose members do not fit is reported incomplete,
 * never silently narrowed.
 */
export const JIRA_REPORT_EPIC_CLAUSE_MAX_CHARS = 3000;
/** Members read to compose the clause; more cannot fit the clause anyway. */
const EPIC_MEMBERS_MAX = 1000;
const MEMBER_PAGE_SIZE = 100;

export type JiraReportEpicScope =
  | { readonly kind: "resolved"; readonly clause: string }
  | { readonly kind: "failed"; readonly reason: JiraReportFailure };

function memberClause(epicKey: string, withEpicLink: boolean): string {
  const key = JSON.stringify(epicKey);
  return [
    `key = ${key}`,
    ...(withEpicLink ? [`"Epic Link" = ${key}`] : []),
    `parent = ${key}`,
  ].join(" OR ");
}

/** The clause Keiko composes for an Epic: the Epic, its members and the sub-tasks of its members. */
export function jiraReportEpicClause(
  epicKey: string,
  withEpicLink: boolean,
  subtaskParents: readonly string[],
): string {
  const base = memberClause(epicKey, withEpicLink);
  return subtaskParents.length === 0
    ? base
    : `${base} OR parent in (${subtaskParents.map((key) => JSON.stringify(key)).join(", ")})`;
}

interface Members {
  readonly epicSeen: boolean;
  /** Members that can hold sub-tasks: everything except the Epic itself and sub-tasks. */
  readonly parents: readonly string[];
}
type MemberRead =
  | { readonly ok: true; readonly members: Members }
  | { readonly ok: false; readonly reason: JiraReportFailure };

function observe(
  hits: readonly unknown[],
  epicKey: string,
  into: { epicSeen: boolean; parents: Set<string> },
): void {
  for (const hit of hits) {
    const record = asRecord(hit);
    const key = record?.key;
    if (!isSafeAtlassianIdentifier(key)) continue;
    if (key === epicKey) into.epicSeen = true;
    else if (asRecord(asRecord(record?.fields)?.issuetype)?.subtask !== true) into.parents.add(key);
  }
}
async function readMembers(
  http: JiraReportHttp,
  epicKey: string,
  jql: string,
  startAt: number,
  into: { epicSeen: boolean; parents: Set<string> },
): Promise<JiraReportFailure | undefined> {
  const outcome = await http.getRecord(
    `search?${new URLSearchParams({
      jql: `${jql} ORDER BY key ASC`,
      startAt: String(startAt),
      maxResults: String(MEMBER_PAGE_SIZE),
      fields: "issuetype",
    }).toString()}`,
  );
  if (!outcome.ok) return outcome.reason;
  const hits = asArray(outcome.body.issues);
  const { total } = outcome.body;
  if (hits === undefined || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
    return "malformed-payload";
  if (total > EPIC_MEMBERS_MAX) return "bounds-exceeded";
  observe(hits, epicKey, into);
  const next = startAt + hits.length;
  if (hits.length === 0 || next >= total) return undefined;
  return readMembers(http, epicKey, jql, next, into);
}
async function membersOf(
  http: JiraReportHttp,
  epicKey: string,
  withEpicLink: boolean,
): Promise<MemberRead> {
  const into = { epicSeen: false, parents: new Set<string>() };
  const reason = await readMembers(http, epicKey, memberClause(epicKey, withEpicLink), 0, into);
  return reason === undefined
    ? {
        ok: true,
        members: { epicSeen: into.epicSeen, parents: [...into.parents].sort(compareCodePoints) },
      }
    : { ok: false, reason };
}

/**
 * Resolves an Epic scope into one reconcilable JQL clause. The members come from Jira itself;
 * the sub-tasks of those members are reached through their `parent`, because no single JQL clause
 * names them. An instance without an `Epic Link` clause answers 400, and the Epic is then read by
 * `parent` alone. The Epic must be visible to the account: an unreadable key is a failure, never an
 * empty scope.
 */
export async function resolveJiraReportEpicScope(
  http: JiraReportHttp,
  epicKey: string,
): Promise<JiraReportEpicScope> {
  const linked = await membersOf(http, epicKey, true);
  const withoutLink = !linked.ok && linked.reason === "field-validation";
  const read = withoutLink ? await membersOf(http, epicKey, false) : linked;
  if (!read.ok) return { kind: "failed", reason: read.reason };
  if (!read.members.epicSeen) return { kind: "failed", reason: "not-found" };
  const clause = jiraReportEpicClause(epicKey, !withoutLink, read.members.parents);
  return clause.length > JIRA_REPORT_EPIC_CLAUSE_MAX_CHARS
    ? { kind: "failed", reason: "bounds-exceeded" }
    : { kind: "resolved", clause };
}
