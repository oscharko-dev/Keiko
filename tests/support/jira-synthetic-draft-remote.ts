import { vi, type Mock } from "vitest";
import { field, LINKS_FIELD } from "./jira-managed-remote.js";

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
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
export function syntheticJira(existing: StoredIssue[] = []): SyntheticJira {
  const issues = [...existing];
  const refuse = new Set<string>();
  const posted: Record<string, unknown>[] = [];
  const read = (url: URL): Response => {
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
    if (refuse.has(String(body.fields.summary)))
      return Promise.resolve(json({ errors: { summary: "Synthetic refusal" } }, 400));
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
    return Promise.resolve(json({ key: created.key, id: created.id }, 201));
  });
  return { fetch: fetchImpl, issues, posts: () => posted, refuse };
}
