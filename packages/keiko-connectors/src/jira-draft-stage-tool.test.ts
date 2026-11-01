import { describe, expect, it, vi } from "vitest";
import {
  JIRA_DRAFT_ITEMS_MAX,
  JIRA_DRAFT_PAGE_ITEMS_MAX,
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { field, response } from "../../../tests/support/jira-managed-remote.js";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { parseJiraDraft } from "./jira-draft.js";
import { createJiraDraftStore } from "./jira-draft-store.js";
import {
  executeJiraDraftStageTool,
  resolveJiraDraftArguments,
  type JiraDraftActivity,
  type JiraDraftToolDeps,
} from "./jira-draft-stage-tool.js";
import type { JiraIssueTemplateSet } from "./jira-managed-template-gate.js";

const CONTEXT: ManagedMcpInvocationContext = {
  invocationId: "invocation",
  correlationId: "correlation",
  signal: new AbortController().signal,
  beforeEffect: () => true,
};
const CREATE_FIELDS = [
  field("project", "project", true),
  field("issuetype", "issuetype", true),
  { ...field("summary", "string", true), name: "Summary" },
  {
    ...field("description", "string", false),
    name: "Description",
    schema: { type: "string", system: "description" },
  },
];
function template(): JiraIssueTemplate {
  const result = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "issueType: Story",
      "activateOn: [create]",
      "---",
      "## Acceptance criteria\n",
    ].join("\n"),
  );
  if (!result.ok) throw new Error("fixture template must parse");
  return result.template;
}
function connection(
  templates?: JiraIssueTemplateSet,
): Parameters<typeof executeJiraDraftStageTool>[2] {
  const http = vi.fn<AtlassianHttpBodyPort>((request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/project/10000")) return Promise.resolve(response({ key: "SYN" }));
    if (path.endsWith("/issuetype/10001"))
      return Promise.resolve(response({ id: "10001", name: "Story" }));
    if (path.includes("createmeta"))
      return Promise.resolve(
        response({
          values: CREATE_FIELDS,
          start: 0,
          size: 100,
          last: true,
          total: CREATE_FIELDS.length,
        }),
      );
    return Promise.resolve(response({}, 404));
  });
  return {
    deployment: "data-center",
    baseUrl: "https://jira.example.invalid/context",
    identity: "credential-1",
    http,
    ...(templates === undefined ? {} : { issueTemplates: (): JiraIssueTemplateSet => templates }),
  };
}
function harness(templates?: JiraIssueTemplateSet): {
  readonly activity: JiraDraftActivity[];
  readonly deps: JiraDraftToolDeps<ManagedMcpInvocationContext>;
  readonly stage: (
    args: CatalogJsonObject,
    owner?: string,
  ) => ReturnType<typeof executeJiraDraftStageTool>;
} {
  const store = createJiraDraftStore();
  const activity: JiraDraftActivity[] = [];
  const base: JiraDraftToolDeps<ManagedMcpInvocationContext> = {
    store,
    owner: () => "chat-1",
    activity: (item) => activity.push(item),
  };
  return {
    activity,
    deps: base,
    stage: (args, owner = "chat-1") =>
      executeJiraDraftStageTool(args, CONTEXT, connection(templates), {
        ...base,
        owner: () => owner,
      }),
  };
}
function item(ref: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref,
    projectId: "10000",
    issueTypeId: "10001",
    fields: { summary: `Item ${ref}`, description: "## Acceptance criteria\n* works" },
    ...extra,
  };
}
function page(from: number, count: number): CatalogJsonObject[] {
  return Array.from(
    { length: count },
    (_, index) => item(`i${String(from + index)}`) as CatalogJsonObject,
  );
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}

describe("jira.draft-stage (#4178)", () => {
  it("assembles a 70-item draft in pages and resolves to exactly those items", async () => {
    const h = harness();
    const first = await h.stage({ items: page(0, JIRA_DRAFT_PAGE_ITEMS_MAX) });
    expect(first.isError).toBeUndefined();
    expect(first.data).toMatchObject({
      outcome: "succeeded",
      newDraft: true,
      itemCount: JIRA_DRAFT_PAGE_ITEMS_MAX,
      pageCount: 1,
      unresolvedRefCount: 0,
    });
    const draftId = text(first.data.draftId);
    const second = await h.stage({ draftId, items: page(JIRA_DRAFT_PAGE_ITEMS_MAX, 20) });
    expect(second.data).toMatchObject({ newDraft: false, itemCount: 70, pageCount: 2 });
    expect(second.data.draftDigest).not.toBe(first.data.draftDigest);
    const resolved = resolveJiraDraftArguments(
      { draftId, draftDigest: text(second.data.draftDigest) },
      (id) => h.deps.store.get(id, "chat-1"),
    );
    expect(resolved?.ok).toBe(true);
    const draft = resolved?.ok === true ? parseJiraDraft(resolved.arguments) : undefined;
    expect(draft?.items).toHaveLength(70);
    expect(h.activity.map((entry) => [entry.phase, entry.pageItemCount, entry.itemCount])).toEqual([
      ["staged", 50, 50],
      ["staged", 20, 70],
    ]);
  });

  it("names the relations still to be written and lets later pages complete them", async () => {
    const h = harness();
    const first = await h.stage({
      items: [item("story", { parent: { fieldId: "parent", ref: "epic" } }) as CatalogJsonObject],
    });
    expect(first.data).toMatchObject({ unresolvedRefCount: 1, unresolvedRefs: ["epic"] });
    const second = await h.stage({
      draftId: text(first.data.draftId),
      items: [item("epic") as CatalogJsonObject],
    });
    expect(second.data).toMatchObject({ unresolvedRefCount: 0, unresolvedRefs: [] });
  });

  it("refuses a draft above its resource bound whole and keeps what was staged", async () => {
    const h = harness();
    let draftId: string | undefined;
    for (let from = 0; from < JIRA_DRAFT_ITEMS_MAX; from += JIRA_DRAFT_PAGE_ITEMS_MAX) {
      const staged = await h.stage(
        draftId === undefined
          ? { items: page(from, JIRA_DRAFT_PAGE_ITEMS_MAX) }
          : { draftId, items: page(from, JIRA_DRAFT_PAGE_ITEMS_MAX) },
      ); // NOSONAR typescript:S9382 -- each page extends the draft the previous page returned
      draftId = text(staged.data.draftId);
    }
    const before = h.deps.store.peek(text(draftId), "chat-1");
    expect(before?.items).toHaveLength(JIRA_DRAFT_ITEMS_MAX);
    const refused = await h.stage({ draftId: text(draftId), items: page(9000, 1) });
    expect(refused).toMatchObject({
      isError: true,
      data: { outcome: "failed", reason: "too-many-items", itemLimit: JIRA_DRAFT_ITEMS_MAX },
    });
    expect(h.deps.store.peek(text(draftId), "chat-1")?.digest).toBe(before?.digest);
    expect(h.activity.at(-1)).toMatchObject({ phase: "refused", refusal: "too-many-items" });
  });

  it("refuses a page with a template violation whole, naming the item and the rule", async () => {
    const h = harness({ templates: [template()], unreadable: 0 });
    const result = await h.stage({
      items: [
        item("good"),
        item("bad", { fields: { summary: "No criteria", description: "nothing" } }),
      ] as CatalogJsonObject[],
    });
    expect(result).toMatchObject({
      isError: true,
      data: {
        outcome: "rejected",
        reason: "field-validation",
        ref: "bad",
        violations: [{ ruleId: "section-missing", subject: "Acceptance criteria" }],
      },
    });
    expect(h.deps.store.size()).toBe(0);
    expect(h.activity.at(-1)).toMatchObject({
      phase: "refused",
      refusal: "template-violation",
      violationCount: 1,
    });
  });

  it.each([
    ["an empty page", { items: [] }],
    ["an unknown argument", { items: [item("a")], extra: true }],
    ["a malformed draft id", { draftId: "nope", items: [item("a")] }],
    ["a malformed item", { items: [{ ref: "a" }] }],
    ["more items than a page", { items: page(0, JIRA_DRAFT_PAGE_ITEMS_MAX + 1) }],
  ])("refuses %s as invalid input", async (_name, args) => {
    const h = harness();
    const result = await h.stage(args as unknown as CatalogJsonObject);
    expect(result).toMatchObject({
      isError: true,
      data: { outcome: "failed", reason: "invalid-input" },
    });
    expect(h.deps.store.size()).toBe(0);
  });

  it("refuses an unknown draft, another Chat's draft and a repeated ref", async () => {
    const h = harness();
    const first = await h.stage({ items: [item("a") as CatalogJsonObject] });
    const draftId = text(first.data.draftId);
    const unknown = await h.stage({
      draftId: "99999999-9999-4999-8999-999999999999",
      items: [item("b") as CatalogJsonObject],
    });
    expect(unknown.data).toMatchObject({ reason: "draft-not-found" });
    const foreign = await h.stage({ draftId, items: [item("b") as CatalogJsonObject] }, "chat-2");
    expect(foreign.data).toMatchObject({ reason: "draft-not-found" });
    const repeated = await h.stage({ draftId, items: [item("a") as CatalogJsonObject] });
    expect(repeated.data).toMatchObject({ reason: "duplicate-ref" });
    expect(h.deps.store.peek(draftId, "chat-1")?.items).toHaveLength(1);
  });
});

describe("resolving the draft a jira.draft call names (#4178)", () => {
  it("is not a reference when the call carries its own items", () => {
    expect(resolveJiraDraftArguments({ items: [] }, () => undefined)).toBeUndefined();
  });

  it("refuses a draft that was extended after its digest was read", async () => {
    const h = harness();
    const first = await h.stage({ items: [item("a") as CatalogJsonObject] });
    const draftId = text(first.data.draftId);
    const digest = text(first.data.draftDigest);
    await h.stage({ draftId, items: [item("b") as CatalogJsonObject] });
    expect(
      resolveJiraDraftArguments({ draftId, draftDigest: digest }, (id) =>
        h.deps.store.get(id, "chat-1"),
      ),
    ).toEqual({ ok: false, reason: "draft-changed" });
  });

  it.each([
    ["a missing digest", { draftId: "11111111-2222-4333-8444-555555555555" }],
    [
      "an extra argument",
      { draftId: "11111111-2222-4333-8444-555555555555", draftDigest: "a".repeat(64), items: [] },
    ],
    ["a malformed digest", { draftId: "11111111-2222-4333-8444-555555555555", draftDigest: "A" }],
  ])("refuses %s as an unknown draft", (_name, args) => {
    expect(resolveJiraDraftArguments(args, () => undefined)).toEqual({
      ok: false,
      reason: "draft-not-found",
    });
  });
});
