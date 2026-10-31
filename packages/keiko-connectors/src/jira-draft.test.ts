import { describe, expect, it, vi } from "vitest";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import {
  JIRA_DRAFT_IDENTITY_PREFIX,
  JIRA_DRAFT_SEARCH_PAGES_MAX,
  JIRA_DRAFT_SEARCH_PAGE_SIZE,
  excludedJiraDraftRefs,
  jiraDraftIdentity,
  parseJiraDraft,
  resolveJiraDraftItem,
  type JiraDraft,
} from "./jira-draft.js";
import { executeJiraDraftItem, findJiraDraftItem } from "./jira-managed-mutations.js";
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
      // Jira's text match: the phrase occurs in the summary, so near matches are candidates too.
      const phrase = /summary ~ "\\"(.*)\\""/u.exec(jql)?.[1] ?? "";
      const found = issues.filter((issue) =>
        label === undefined
          ? String(issue.fields.summary).includes(phrase)
          : (issue.fields.labels as readonly string[] | undefined)?.includes(label) === true,
      );
      // Jira pages its results and states the size of the whole candidate set.
      const startAt = Number(url.searchParams.get("startAt") ?? "0");
      const maxResults = Number(url.searchParams.get("maxResults") ?? "50");
      return Promise.resolve(
        response({
          startAt,
          maxResults,
          total: found.length,
          issues: found
            .slice(startAt, startAt + maxResults)
            .map(({ key, id, fields }) => ({ key, id, fields })),
        }),
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

function writes(jira: ReturnType<typeof syntheticJira>): number {
  return jira.http.mock.calls.filter(([request]) => request.method !== "GET").length;
}
function stored(index: number, summary: string): StoredIssue {
  return { key: `SYN-${String(index + 1)}`, id: String(10001 + index), fields: { summary } };
}
/** Issues whose summary contains the item's, as Jira's text match returns them before the exact one. */
function nearMatches(count: number): StoredIssue[] {
  return Array.from({ length: count }, (_, index) =>
    stored(index, `Item a (copy ${String(index)})`),
  );
}

describe("a draft item's identity binds its relation scope", () => {
  const sibling = (ref: string, parentKey: string): Record<string, unknown> => ({
    ...item(ref),
    fields: { summary: "Implement logging" },
    parent: { fieldId: "parent", issueKey: parentKey },
  });

  it("separates items that share a summary but hang from different parents or relations", () => {
    const parsed = draft([
      sibling("one", "SYN-90"),
      sibling("two", "SYN-91"),
      { ...item("plain"), fields: { summary: "Implement logging" } },
      {
        ...item("related"),
        fields: { summary: "Implement logging" },
        links: [{ type: "Relates", direction: "outward", issueKey: "SYN-90" }],
      },
    ]);
    const identities = parsed.items.map(jiraDraftIdentity);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("derives a child's identity from its parent item, not from the draft-local reference", () => {
    const childIdentity = (epicSummary: string, epicRef: string, childRef: string): string => {
      const parsed = draft([
        { ...item(epicRef), fields: { summary: epicSummary } },
        {
          ...item(childRef),
          fields: { summary: "Child" },
          parent: { fieldId: "parent", ref: epicRef },
        },
      ]);
      return jiraDraftIdentity(parsed.items[1] ?? (undefined as never));
    };
    expect(childIdentity("Epic", "e1", "c1")).toBe(childIdentity("Epic", "other", "second"));
    expect(childIdentity("Another epic", "e1", "c1")).not.toBe(childIdentity("Epic", "e1", "c1"));
  });

  it.each([true, false])(
    "creates each of two same-summary items under its own parent, then reconciles both (labels: %s)",
    async (labels) => {
      const jira = syntheticJira({ labels });
      const parsed = draft([sibling("one", "SYN-90"), sibling("two", "SYN-91")]);
      await expect(runItem(jira, parsed, 0)).resolves.toMatchObject({
        ok: true,
        receipt: { issueKey: "SYN-1" },
      });
      await expect(runItem(jira, parsed, 1)).resolves.toMatchObject({
        ok: true,
        receipt: { issueKey: "SYN-2" },
      });
      expect(writes(jira)).toBe(2);
      expect(jira.issues.map((issue) => issue.fields.parent)).toEqual([
        { key: "SYN-90" },
        { key: "SYN-91" },
      ]);
      await expect(runItem(jira, parsed, 0)).resolves.toMatchObject({
        ok: true,
        receipt: { issueKey: "SYN-1" },
      });
      await expect(runItem(jira, parsed, 1)).resolves.toMatchObject({
        ok: true,
        receipt: { issueKey: "SYN-2" },
      });
      expect(writes(jira)).toBe(2);
    },
  );

  it("keeps two identical siblings as two issues", async () => {
    const jira = syntheticJira({ labels: true });
    const parsed = draft([sibling("one", "SYN-90"), sibling("two", "SYN-90")]);
    await runItem(jira, parsed, 0);
    await expect(runItem(jira, parsed, 1)).resolves.toMatchObject({
      ok: true,
      receipt: { issueKey: "SYN-2" },
    });
    expect(writes(jira)).toBe(2);
  });

  // An unlabelled search sees only project, type, summary and parent, so these items would all
  // reconcile to the first one's issue: one issue where the draft asked for two.
  it.each([
    ["identical siblings", [sibling("one", "SYN-90"), sibling("two", "SYN-90")]],
    [
      "items that differ only by a link",
      [
        { ...item("plain"), fields: { summary: "Implement logging" } },
        {
          ...item("related"),
          fields: { summary: "Implement logging" },
          links: [{ type: "Relates", direction: "outward", issueKey: "SYN-90" }],
        },
      ],
    ],
  ])("refuses %s without a labels field before any write", async (_name, items) => {
    const jira = syntheticJira({ labels: false });
    const parsed = draft(items);
    for (const index of [0, 1])
      await expect(runItem(jira, parsed, index)).resolves.toMatchObject({
        ok: false,
        reason: "conflict",
      });
    expect(writes(jira)).toBe(0);
  });

  it("still creates an unlabelled item whose summary and parent are unique in the draft", async () => {
    const jira = syntheticJira({ labels: false });
    const parsed = draft([sibling("one", "SYN-90"), sibling("two", "SYN-91")]);
    expect(parsed.items.map((entry) => entry.unlabelledTwin)).toEqual([false, false]);
    await expect(runItem(jira, parsed, 0)).resolves.toMatchObject({ ok: true });
  });
});

describe("a draft item's identity search is complete or refused", () => {
  const exact = (index: number): StoredIssue => stored(index, "Item a");

  it("finds the exact match on a later page instead of creating a duplicate", async () => {
    const near = nearMatches(JIRA_DRAFT_SEARCH_PAGE_SIZE + 5);
    const jira = syntheticJira({ labels: false, existing: [...near, exact(near.length)] });
    await expect(runItem(jira, draft([item("a")]), 0)).resolves.toEqual({
      ok: true,
      receipt: { issueKey: `SYN-${String(near.length + 1)}`, issueId: String(10001 + near.length) },
    });
    expect(writes(jira)).toBe(0);
    expect(jira.queries).toHaveLength(2);
  });

  it("detects a second exact match beyond the first page as a conflict", async () => {
    const near = nearMatches(JIRA_DRAFT_SEARCH_PAGE_SIZE + 5);
    const jira = syntheticJira({
      labels: false,
      existing: [exact(0), ...near.slice(1), exact(near.length)],
    });
    await expect(runItem(jira, draft([item("a")]), 0)).resolves.toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(writes(jira)).toBe(0);
  });

  it("reads exactly as many candidates as the page ceiling allows", async () => {
    const ceiling = JIRA_DRAFT_SEARCH_PAGES_MAX * JIRA_DRAFT_SEARCH_PAGE_SIZE;
    const near = nearMatches(ceiling - 1);
    const jira = syntheticJira({ labels: false, existing: [...near, exact(near.length)] });
    await expect(runItem(jira, draft([item("a")]), 0)).resolves.toMatchObject({
      ok: true,
      receipt: { issueKey: `SYN-${String(ceiling)}` },
    });
    expect(writes(jira)).toBe(0);
    expect(jira.queries).toHaveLength(JIRA_DRAFT_SEARCH_PAGES_MAX);
  });

  it("refuses a search larger than the page ceiling instead of creating", async () => {
    const ceiling = JIRA_DRAFT_SEARCH_PAGES_MAX * JIRA_DRAFT_SEARCH_PAGE_SIZE;
    const jira = syntheticJira({ labels: false, existing: nearMatches(ceiling + 1) });
    await expect(runItem(jira, draft([item("a")]), 0)).resolves.toEqual({
      ok: false,
      reason: "bounds-exceeded",
    });
    expect(writes(jira)).toBe(0);
  });

  it("refuses a malformed page instead of treating the item as absent", async () => {
    const jira = syntheticJira({ labels: false });
    const original = jira.http.getMockImplementation();
    if (original === undefined) throw new Error("expected the synthetic transport");
    jira.http.mockImplementation((request) =>
      request.url.includes("/search") ? Promise.resolve(response({ total: 1 })) : original(request),
    );
    await expect(runItem(jira, draft([item("a")]), 0)).resolves.toEqual({
      ok: false,
      reason: "malformed-payload",
    });
    expect(writes(jira)).toBe(0);
  });

  const inconsistentPages: readonly (readonly [string, Record<string, unknown>])[] = [
    [
      "an empty page before the total is reached",
      { startAt: 0, maxResults: 50, total: 1, issues: [] },
    ],
    [
      "a page that starts elsewhere than requested",
      { startAt: 50, maxResults: 50, total: 1, issues: [{ key: "SYN-1", id: "10001" }] },
    ],
    ["a page that states no start", { maxResults: 50, total: 0, issues: [] }],
    [
      "more issues than the page size it states",
      {
        startAt: 0,
        maxResults: 1,
        total: 2,
        issues: [
          { key: "SYN-1", id: "10001" },
          { key: "SYN-2", id: "10002" },
        ],
      },
    ],
    [
      "more issues than the total",
      { startAt: 0, maxResults: 50, total: 0, issues: [{ key: "SYN-1", id: "10001" }] },
    ],
    ["a total that is not a count", { startAt: 0, maxResults: 50, total: "1", issues: [] }],
    ["a page size that is not a count", { startAt: 0, maxResults: -1, total: 0, issues: [] }],
    [
      "an exact match without a numeric id",
      {
        startAt: 0,
        maxResults: 50,
        total: 1,
        issues: [{ key: "SYN-1", fields: { summary: "Item a" } }],
      },
    ],
    [
      "an exact match without a key",
      {
        startAt: 0,
        maxResults: 50,
        total: 1,
        issues: [{ id: "10001", fields: { summary: "Item a" } }],
      },
    ],
    [
      "a candidate with a non-numeric id beside a valid one",
      {
        startAt: 0,
        maxResults: 50,
        total: 2,
        issues: [
          { key: "SYN-1", id: "10001", fields: { summary: "Item a" } },
          { key: "SYN-2", id: "x", fields: { summary: "Other" } },
        ],
      },
    ],
  ];
  it.each(inconsistentPages)(
    "refuses %s instead of treating the item as absent",
    async (_, body) => {
      const jira = syntheticJira({ labels: false });
      const original = jira.http.getMockImplementation();
      if (original === undefined) throw new Error("expected the synthetic transport");
      jira.http.mockImplementation((request) =>
        request.url.includes("/search") ? Promise.resolve(response(body)) : original(request),
      );
      await expect(runItem(jira, draft([item("a")]), 0)).resolves.toEqual({
        ok: false,
        reason: "malformed-payload",
      });
      expect(writes(jira)).toBe(0);
    },
  );

  it("still treats a complete empty search as absence and creates", async () => {
    const jira = syntheticJira({ labels: false });
    await expect(runItem(jira, draft([item("a")]), 0)).resolves.toMatchObject({ ok: true });
    expect(writes(jira)).toBe(1);
  });
});

describe("findJiraDraftItem", () => {
  it("recovers an item's key read-only, and reports one that is gone as not found", async () => {
    const jira = syntheticJira({ labels: true });
    const parsed = draft([item("a")]);
    const entry = parsed.items[0];
    if (entry === undefined) throw new Error("item");
    const connection = {
      deployment: "data-center" as const,
      baseUrl: "https://jira.example.invalid",
      http: jira.http,
    };
    const context = {
      invocationId: "d",
      correlationId: "d",
      signal: new AbortController().signal,
      beforeEffect: (): boolean => true,
    };
    await expect(findJiraDraftItem(entry, new Map(), context, connection)).resolves.toEqual({
      ok: false,
      reason: "not-found",
    });
    await runItem(jira, parsed, 0);
    await expect(findJiraDraftItem(entry, new Map(), context, connection)).resolves.toEqual({
      ok: true,
      receipt: { issueKey: "SYN-1", issueId: "10001" },
    });
    expect(writes(jira)).toBe(1);
  });
});
