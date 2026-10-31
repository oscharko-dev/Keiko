import { vi, type Mock } from "vitest";
import {
  field,
  fixtureLinkOperationCount,
  jiraTooManyLinkOperationsBody,
  LINKS_FIELD,
} from "./jira-managed-remote.js";

/** A hermetic Jira site for backlog drafts: create metadata, identity search and issue create. */
export const SYNTHETIC_JIRA_BASE_URL = "https://jira.example.invalid";
const CREATE_FIELDS = [
  field("project", "project", true),
  field("issuetype", "issuetype", true),
  field("summary", "string", true),
  { ...field("parent", "issuelink"), schema: { type: "issuelink", system: "parent" } },
  {
    ...field("labels", "array"),
    operations: ["set", "add", "remove"],
    schema: { type: "array", items: "string", system: "labels" },
  },
  LINKS_FIELD,
];

export interface StoredIssue {
  readonly key: string;
  readonly id: string;
  readonly fields: Record<string, unknown>;
}
export interface SyntheticJira {
  readonly fetch: Mock<typeof fetch>;
  readonly issues: StoredIssue[];
  readonly posts: () => readonly Record<string, unknown>[];
  /** Summaries Jira refuses on create, with its own field error. */
  readonly refuse: Set<string>;
  /** Issue keys Jira cannot link (answered as missing). */
  readonly refuseLinks: Set<string>;
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
/** `POST /issueLink`: the inward issue is the source, as a real Data Center reads it back. */
function linkIssues(
  issues: StoredIssue[],
  body: Record<string, unknown>,
  refused: ReadonlySet<string>,
): Response {
  const source = issues.find((issue) => issue.key === (body.inwardIssue as { key: string }).key);
  const target = issues.find((issue) => issue.key === (body.outwardIssue as { key: string }).key);
  if (
    source === undefined ||
    target === undefined ||
    refused.has(source.key) ||
    refused.has(target.key)
  )
    return json({ errorMessages: ["Issue Does Not Exist"], errors: {} }, 404);
  const store = (issue: StoredIssue, link: Record<string, unknown>): void => {
    const links = (issue.fields.issuelinks as unknown[] | undefined) ?? [];
    issue.fields.issuelinks = [
      ...links,
      { id: String(30000 + links.length), type: body.type, ...link },
    ];
  };
  store(source, { outwardIssue: { key: target.key } });
  store(target, { inwardIssue: { key: source.key } });
  return new Response(null, { status: 201 });
}
function createIssue(
  issues: StoredIssue[],
  refuse: ReadonlySet<string>,
  body: { fields: Record<string, unknown> },
): Response {
  if (refuse.has(String(body.fields.summary)))
    return json({ errors: { summary: "Synthetic refusal" } }, 400);
  // Data Center and Cloud take ONE issuelinks operation per request (JRASERVER-66329).
  const operations = fixtureLinkOperationCount(body);
  if (operations > 1) return json(jiraTooManyLinkOperationsBody(operations), 400);
  // Jira reads an added link back with the other issue on its own side.
  const links = (body as { update?: { issuelinks?: { add: Record<string, unknown> }[] } }).update
    ?.issuelinks;
  const created = {
    key: `SYN-${String(issues.length + 1)}`,
    id: String(10001 + issues.length),
    fields: {
      ...body.fields,
      ...(links === undefined
        ? {}
        : { issuelinks: links.map(({ add }, index) => ({ id: String(20000 + index), ...add })) }),
    },
  };
  issues.push(created);
  return json({ key: created.key, id: created.id }, 201);
}
export function syntheticJira(existing: StoredIssue[] = []): SyntheticJira {
  const issues = [...existing];
  const refuse = new Set<string>();
  const refuseLinks = new Set<string>();
  const posted: Record<string, unknown>[] = [];
  const read = (url: URL): Response => {
    if (url.pathname.endsWith("/project/10000")) return json({ key: "SYN" });
    if (url.pathname.endsWith("/issuetype/10001")) return json({ id: "10001", name: "Story" });
    if (url.pathname.includes("createmeta"))
      return json({ values: CREATE_FIELDS, start: 0, size: 100, last: true, total: 6 });
    if (url.pathname.endsWith("/search")) {
      const label = /labels = "([^"]+)"/u.exec(url.searchParams.get("jql") ?? "")?.[1];
      const found = issues.filter((issue) =>
        (issue.fields.labels as readonly string[] | undefined)?.includes(label ?? "-"),
      );
      // Jira states the page it served: where it starts, the size it honours and the total.
      return json({ startAt: 0, maxResults: 50, total: found.length, issues: found });
    }
    const issue = issues.find((entry) => url.pathname.endsWith(`/issue/${entry.key}`));
    return issue === undefined ? json({}, 404) : json(issue);
  };
  const fetchImpl = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if ((init?.method ?? "GET") === "GET") return Promise.resolve(read(url));
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      fields: Record<string, unknown>;
    };
    posted.push(body);
    if (url.pathname.endsWith("/issueLink"))
      return Promise.resolve(linkIssues(issues, body, refuseLinks));
    return Promise.resolve(createIssue(issues, refuse, body));
  });
  return { fetch: fetchImpl, issues, posts: () => posted, refuse, refuseLinks };
}
