import { describe, expect, it, vi } from "vitest";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import {
  JIRA_DRAFT_IDENTITY_PREFIX,
  excludedJiraDraftRefs,
  jiraDraftIdentity,
  parseJiraDraft,
  resolveJiraDraftItem,
  type JiraDraft,
} from "./jira-draft.js";
import { executeJiraDraftItem } from "./jira-managed-mutations.js";
import { field, LINKS_FIELD, response } from "../../../tests/support/jira-managed-remote.js";

const LABELS = {
  ...field("labels", "array"),
  operations: ["set", "add", "remove"],
  schema: { type: "array", items: "string", system: "labels" },
};
const PARENT = { ...field("parent", "issuelink"), schema: { type: "issuelink", system: "parent" } };
const BASE_FIELDS = [
  field("project", "project", true),
  field("issuetype", "issuetype", true),
  field("summary", "string", true),
  PARENT,
  LINKS_FIELD,
];

function item(ref: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref,
    projectId: "10000",
    issueTypeId: "10001",
    fields: { summary: `Item ${ref}` },
    ...extra,
  };
}
function draft(items: readonly Record<string, unknown>[]): JiraDraft {
  const parsed = parseJiraDraft({ items });
  if (parsed === undefined) throw new Error("expected a valid draft");
  return parsed;
}

describe("parseJiraDraft", () => {
  it("orders items so every referenced item comes first, keeping the given order otherwise", () => {
    const parsed = draft([
      item("task", { parent: { fieldId: "customfield_10100", ref: "epic" } }),
      item("epic"),
      item("bug", { links: [{ type: "Relates", direction: "outward", ref: "task" }] }),
      item("loose"),
    ]);
    expect(parsed.items.map((entry) => entry.ref)).toEqual(["epic", "task", "bug", "loose"]);
  });

  it.each([
    ["an unknown reference", [item("a", { parent: { fieldId: "parent", ref: "missing" } })]],
    ["a self-reference", [item("a", { parent: { fieldId: "parent", ref: "a" } })]],
    [
      "a cycle",
      [
        item("a", { links: [{ type: "Blocks", direction: "outward", ref: "b" }] }),
        item("b", { links: [{ type: "Blocks", direction: "outward", ref: "a" }] }),
      ],
    ],
    ["a duplicate reference", [item("a"), item("a")]],
    ["a missing summary", [{ ...item("a"), fields: { description: "x" } }]],
    ["a routing override", [{ ...item("a"), fields: { summary: "x", project: { id: "1" } } }]],
    [
      "a parent field also written directly",
      [
        {
          ...item("a", { parent: { fieldId: "parent", issueKey: "SYN-9" } }),
          fields: { summary: "x", parent: "SYN-1" },
        },
      ],
    ],
    [
      "both ref and issueKey",
      [item("a", { parent: { fieldId: "parent", ref: "a", issueKey: "SYN-1" } })],
    ],
    ["an unknown item key", [{ ...item("a"), extra: true }]],
    ["an invalid ref", [item("1abc")]],
    ["a non-numeric project", [{ ...item("a"), projectId: "SYN" }]],
    [
      "an invalid link direction",
      [item("a", { links: [{ type: "Relates", direction: "up", issueKey: "SYN-1" }] })],
    ],
    ["no items", []],
  ])("refuses %s", (_name, items) => {
    expect(parseJiraDraft({ items })).toBeUndefined();
  });

  it("refuses more than the item ceiling and unknown top-level keys", () => {
    const many = Array.from({ length: 33 }, (_, index) => item(`i${String(index)}`));
    expect(parseJiraDraft({ items: many })).toBeUndefined();
    expect(parseJiraDraft({ items: [item("a")], extra: 1 })).toBeUndefined();
  });
});

describe("excludedJiraDraftRefs", () => {
  it("extends the deselection to every dependent item and ignores unknown references", () => {
    const parsed = draft([
      item("epic"),
      item("task", { parent: { fieldId: "customfield_10100", ref: "epic" } }),
      item("sub", { parent: { fieldId: "parent", ref: "task" } }),
      item("bug", { links: [{ type: "Relates", direction: "outward", ref: "sub" }] }),
      item("other"),
    ]);
    expect([...excludedJiraDraftRefs(parsed, ["task", "ghost"])].sort()).toEqual([
      "bug",
      "sub",
      "task",
    ]);
    expect(excludedJiraDraftRefs(parsed, [])).toEqual(new Set());
  });
});

describe("jiraDraftIdentity", () => {
  it("depends on project, issue type and normalized summary, not on the reference", () => {
    const [a] = draft([item("a")]).items;
    const [b] = draft([{ ...item("b"), fields: { summary: "  Item   a " } }]).items;
    const [c] = draft([{ ...item("a"), issueTypeId: "10002" }]).items;
    if (a === undefined || b === undefined || c === undefined) throw new Error("items");
    expect(jiraDraftIdentity(a)).toBe(jiraDraftIdentity(b));
    expect(jiraDraftIdentity(a)).not.toBe(jiraDraftIdentity(c));
    expect(jiraDraftIdentity(a)).toMatch(
      new RegExp(`^${JIRA_DRAFT_IDENTITY_PREFIX}[a-f0-9]{20}$`, "u"),
    );
  });
});

describe("resolveJiraDraftItem", () => {
  it("writes the parent key into the named field and resolves link references", () => {
    const parsed = draft([
      item("epic"),
      item("task", {
        parent: { fieldId: "customfield_10100", ref: "epic" },
        links: [
          { type: "Relates", direction: "inward", ref: "epic" },
          { type: "Blocks", direction: "outward", issueKey: "SYN-7" },
        ],
      }),
    ]);
    const task = parsed.items[1];
    if (task === undefined) throw new Error("task");
    expect(resolveJiraDraftItem(task, new Map())).toBeUndefined();
    expect(resolveJiraDraftItem(task, new Map([["epic", "SYN-3"]]))).toEqual({
      projectId: "10000",
      issueTypeId: "10001",
      fields: { summary: "Item task", customfield_10100: "SYN-3" },
      links: [
        { type: "Relates", direction: "inward", issueKey: "SYN-3" },
        { type: "Blocks", direction: "outward", issueKey: "SYN-7" },
      ],
    });
  });
});

interface StoredIssue {
  readonly key: string;
  readonly id: string;
  fields: Record<string, unknown>;
}
function syntheticJira(options: { readonly labels: boolean; readonly existing?: StoredIssue[] }): {
  readonly http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  readonly issues: StoredIssue[];
  readonly queries: string[];
} {
  const issues: StoredIssue[] = [...(options.existing ?? [])];
  const queries: string[] = [];
  const createFields = options.labels ? [...BASE_FIELDS, LABELS] : BASE_FIELDS;
  const read = (url: URL): ReturnType<AtlassianHttpBodyPort> => {
    if (url.pathname.includes("createmeta"))
      return Promise.resolve(
        response({
          values: createFields,
          start: 0,
          size: 100,
          last: true,
          total: createFields.length,
        }),
      );
    if (url.pathname.endsWith("/search")) {
      const jql = url.searchParams.get("jql") ?? "";
      queries.push(jql);
      const label = /labels = "([^"]+)"/u.exec(jql)?.[1];
      const found = issues.filter((issue) =>
        label === undefined
          ? jql.includes(String(issue.fields.summary))
          : (issue.fields.labels as readonly string[] | undefined)?.includes(label) === true,
      );
      return Promise.resolve(
        response({ issues: found.map(({ key, id, fields }) => ({ key, id, fields })) }),
      );
    }
    const issue = issues.find((entry) => url.pathname.endsWith(`/issue/${entry.key}`));
    return Promise.resolve(
      issue === undefined
        ? response({}, 404)
        : response({ key: issue.key, id: issue.id, fields: issue.fields }),
    );
  };
  const http = vi.fn<AtlassianHttpBodyPort>((request) => {
    const url = new URL(request.url);
    if (request.method === "GET") return read(url);
    const body = JSON.parse(request.bodyJson ?? "{}") as { fields: Record<string, unknown> };
    const created: StoredIssue = {
      key: `SYN-${String(issues.length + 1)}`,
      id: String(10001 + issues.length),
      fields: body.fields,
    };
    issues.push(created);
    return Promise.resolve(response({ key: created.key, id: created.id }, 201));
  });
  return { http, issues, queries };
}
function runItem(
  jira: ReturnType<typeof syntheticJira>,
  parsed: JiraDraft,
  index: number,
  keys: ReadonlyMap<string, string> = new Map(),
): ReturnType<typeof executeJiraDraftItem> {
  const entry = parsed.items[index];
  if (entry === undefined) throw new Error("item");
  return executeJiraDraftItem(
    entry,
    keys,
    {
      invocationId: "draft",
      correlationId: "draft",
      signal: new AbortController().signal,
      beforeEffect: () => true,
    },
    { deployment: "data-center", baseUrl: "https://jira.example.invalid", http: jira.http },
  );
}

describe("executeJiraDraftItem", () => {
  it("creates the item with its identity label and reconciles a second run without a write", async () => {
    const jira = syntheticJira({ labels: true });
    const parsed = draft([item("epic")]);
    await expect(runItem(jira, parsed, 0)).resolves.toEqual({
      ok: true,
      receipt: { issueKey: "SYN-1", issueId: "10001" },
    });
    const identity = jiraDraftIdentity(parsed.items[0] ?? (undefined as never));
    expect(jira.issues[0]?.fields.labels).toEqual([identity]);
    const writes = (): number =>
      jira.http.mock.calls.filter(([request]) => request.method !== "GET").length;
    expect(writes()).toBe(1);
    await expect(runItem(jira, parsed, 0)).resolves.toEqual({
      ok: true,
      receipt: { issueKey: "SYN-1", issueId: "10001" },
    });
    expect(writes()).toBe(1);
    expect(jira.queries.at(-1)).toBe(
      `project = 10000 AND issuetype = 10001 AND labels = "${identity}"`,
    );
  });

  it("keeps labels the model chose beside the identity label", async () => {
    const jira = syntheticJira({ labels: true });
    const parsed = draft([{ ...item("a"), fields: { summary: "Item a", labels: ["req-7"] } }]);
    await runItem(jira, parsed, 0);
    expect(jira.issues[0]?.fields.labels).toEqual([
      "req-7",
      jiraDraftIdentity(parsed.items[0] ?? (undefined as never)),
    ]);
  });

  it("reconciles by exact summary when the create screen has no labels field", async () => {
    const existing: StoredIssue = { key: "SYN-1", id: "10001", fields: { summary: "Item a" } };
    const near: StoredIssue = { key: "SYN-2", id: "10002", fields: { summary: "Item a (copy)" } };
    const jira = syntheticJira({ labels: false, existing: [existing, near] });
    await expect(runItem(jira, draft([item("a")]), 0)).resolves.toEqual({
      ok: true,
      receipt: { issueKey: "SYN-1", issueId: "10001" },
    });
    expect(jira.queries.at(-1)).toBe(
      'project = 10000 AND issuetype = 10001 AND summary ~ "\\"Item a\\""',
    );
  });

  it("refuses an ambiguous identity instead of guessing", async () => {
    const twin = (key: string, id: string): StoredIssue => ({
      key,
      id,
      fields: { summary: "Item a" },
    });
    const jira = syntheticJira({
      labels: false,
      existing: [twin("SYN-1", "10001"), twin("SYN-2", "10002")],
    });
    await expect(runItem(jira, draft([item("a")]), 0)).resolves.toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(jira.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("refuses an item whose referenced item has no key yet, before any request", async () => {
    const jira = syntheticJira({ labels: true });
    const parsed = draft([
      item("epic"),
      item("sub", { parent: { fieldId: "parent", ref: "epic" } }),
    ]);
    await expect(runItem(jira, parsed, 1)).resolves.toMatchObject({
      ok: false,
      reason: "field-validation",
    });
    expect(jira.http).not.toHaveBeenCalled();
    await expect(runItem(jira, parsed, 1, new Map([["epic", "SYN-9"]]))).resolves.toMatchObject({
      ok: true,
    });
    expect(jira.issues.at(-1)?.fields.parent).toEqual({ key: "SYN-9" });
  });

  it("is unavailable outside Jira Data Center", async () => {
    const jira = syntheticJira({ labels: true });
    const entry = draft([item("a")]).items[0];
    if (entry === undefined) throw new Error("item");
    await expect(
      executeJiraDraftItem(
        entry,
        new Map(),
        {
          invocationId: "d",
          correlationId: "d",
          signal: new AbortController().signal,
          beforeEffect: () => true,
        },
        { deployment: "cloud", baseUrl: "https://jira.example.invalid", http: jira.http },
      ),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});
