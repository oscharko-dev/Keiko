import { response, type FixtureIssue } from "./jira-report.fixture.js";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";

/** Independent, deliberately small JQL fixture; unsupported predicates fail instead of selecting all. */
function equality(issue: FixtureIssue, clause: string): boolean | undefined {
  const match = /^(issuetype|statusCategory) (!?=) "([^"]+)"$/u.exec(clause);
  if (match === null) return undefined;
  const value = match[1] === "issuetype" ? issue.type : issue.category;
  return match[2] === "=" ? value === match[3] : value !== match[3];
}
function presence(issue: FixtureIssue, clause: string): boolean | undefined {
  const match =
    /^(originalEstimate|assignee|"Acceptance Criteria"|"Epic Link") IS (NOT )?EMPTY$/u.exec(clause);
  if (match === null) return undefined;
  const values = {
    originalEstimate: issue.seconds === undefined,
    assignee: !issue.assignee,
    '"Epic Link"': issue.epic === undefined,
    '"Acceptance Criteria"': issue.type === "Story" && issue.acceptance === null,
  };
  const empty = values[match[1] as keyof typeof values];
  return match[2] === undefined ? empty : !empty;
}
function contentMatch(issue: FixtureIssue, clause: string): boolean {
  const due = /^duedate < "([0-9-]+)"$/u.exec(clause);
  if (due !== null) return issue.due !== undefined && issue.due < (due[1] ?? "");
  const text = /^text ~ "(REQ-\d+)"$/u.exec(clause);
  if (text !== null)
    return [issue.summary, issue.description ?? "", ...issue.labels]
      .join(" ")
      .includes(text[1] ?? "");
  throw new TypeError(`Unsupported synthetic JQL predicate: ${clause}`);
}
function matches(issue: FixtureIssue, clause: string): boolean {
  if (clause === 'project = "REP"') return true;
  const compared = equality(issue, clause) ?? presence(issue, clause);
  if (compared !== undefined) return compared;
  const epic = /^"Epic Link" = "([A-Z]+-\d+)"$/u.exec(clause);
  if (epic !== null) return issue.epic === epic[1];
  const estimate = /^originalEstimate = (\d+)m$/u.exec(clause);
  return estimate === null
    ? contentMatch(issue, clause)
    : issue.seconds === Number(estimate[1]) * 60;
}
export function selectForJql(
  issues: readonly FixtureIssue[],
  jql: string,
): readonly FixtureIssue[] {
  const clauses = jql.replace(/ ORDER BY key ASC$/u, "").split(" AND ");
  return issues.filter((issue) => clauses.every((clause) => matches(issue, clause)));
}
/** Native count-only query, separately requested from the same synthetic project as jira.report. */
export async function jqlCount(http: AtlassianHttpBodyPort, clause = ""): Promise<number> {
  const url = new URL("https://jira.example.invalid/context/rest/api/2/search");
  const query = clause.length === 0 ? 'project = "REP"' : `project = "REP" AND ${clause}`;
  url.searchParams.set("jql", query);
  url.searchParams.set("maxResults", "0");
  url.searchParams.set("startAt", "0");
  url.searchParams.set("fields", "key");
  const answer = await http({ method: "GET", url: url.href, timeoutMs: 1000, maxBodyBytes: 1024 });
  if (answer.kind !== "response" || answer.status !== 200)
    throw new TypeError("Synthetic reconciliation count unavailable");
  const body = JSON.parse(answer.bodyText) as { total: unknown; issues: unknown[] };
  if (!Number.isSafeInteger(body.total) || body.issues.length !== 0)
    throw new TypeError("Synthetic reconciliation must be a count-only response");
  return body.total as number;
}

/** Board metadata is forbidden and readable project screens offer no estimate fallback. */
export function withoutEstimateConfiguration(http: AtlassianHttpBodyPort): AtlassianHttpBodyPort {
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/agile/1.0/board")) return { ...response({}), status: 403 };
    const answer = await http(request);
    if (!/\/createmeta\/REP\/issuetypes\/\d+$/u.test(path) || answer.kind !== "response")
      return answer;
    const body = JSON.parse(answer.bodyText) as { values: { fieldId: string }[] };
    const values = body.values.filter((field) => field.fieldId !== "timetracking");
    return response({ values, total: values.length, isLast: true });
  };
}
