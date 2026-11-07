import { describe, expect, it, vi } from "vitest";
import {
  JIRA_DRAFT_PAGE_ITEMS_MAX,
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { field, LINKS_FIELD, response } from "../../../tests/support/jira-managed-remote.js";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { parseJiraDraft } from "./jira-draft.js";
import { createJiraDraftStore, type JiraDraftStoreOptions } from "./jira-draft-store.js";
import {
  executeJiraDraftStageTool,
  JIRA_DRAFT_TOO_LARGE_GUIDANCE,
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
  field("parent", "issuelink"),
  {
    ...field("description", "string", false),
    name: "Description",
    schema: { type: "string", system: "description" },
  },
  LINKS_FIELD,
];
function template(...frontMatter: readonly string[]): JiraIssueTemplate {
  const result = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "issueType: Story",
      "activateOn: [create]",
      ...frontMatter,
      "---",
      "## Acceptance criteria\n",
    ].join("\n"),
  );
  if (!result.ok) throw new Error("fixture template must parse");
  return result.template;
}
function connection(
  templates?: JiraIssueTemplateSet,
  fields: readonly unknown[] = CREATE_FIELDS,
): Parameters<typeof executeJiraDraftStageTool>[2] {
  const http = vi.fn<AtlassianHttpBodyPort>((request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/project/10000")) return Promise.resolve(response({ key: "SYN" }));
    if (path.endsWith("/issuetype/10001"))
      return Promise.resolve(response({ id: "10001", name: "Story" }));
    if (path.includes("createmeta"))
      return Promise.resolve(
        response({
          values: fields,
          start: 0,
          size: 100,
          last: true,
          total: fields.length,
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
function harness(
  templates?: JiraIssueTemplateSet,
  storeOptions: JiraDraftStoreOptions = {},
): {
  readonly activity: JiraDraftActivity[];
  readonly deps: JiraDraftToolDeps<ManagedMcpInvocationContext>;
  readonly stage: (
    args: CatalogJsonObject,
    owner?: string,
    fields?: readonly unknown[],
  ) => ReturnType<typeof executeJiraDraftStageTool>;
} {
  const store = createJiraDraftStore(storeOptions);
  const activity: JiraDraftActivity[] = [];
  const base: JiraDraftToolDeps<ManagedMcpInvocationContext> = {
    store,
    owner: () => "chat-1",
    activity: (item) => activity.push(item),
  };
  return {
    activity,
    deps: base,
    stage: (args, owner = "chat-1", fields) =>
      executeJiraDraftStageTool(args, CONTEXT, connection(templates, fields), {
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
    fields: { summary: `Item ${ref}`, description: "h2. Acceptance criteria\n* works" },
    ...extra,
  };
}
function pageOf(...refs: readonly string[]): CatalogJsonObject {
  return { items: refs.map((ref) => item(ref)) } as unknown as CatalogJsonObject;
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
  it("refuses source-criterion failure before Jira metadata reads or a staged digest", async () => {
    const h = harness();
    const target = connection();
    const append = vi.spyOn(h.deps.store, "append");
    const checkRequirements = vi.fn(() => ({
      data: { outcome: "rejected", reason: "field-validation" },
      violationCount: 1,
    }));
    const result = await executeJiraDraftStageTool(pageOf("source"), CONTEXT, target, {
      ...h.deps,
      checkRequirements,
    });
    expect(result).toMatchObject({
      isError: true,
      data: { outcome: "rejected", reason: "field-validation" },
    });
    expect(checkRequirements).toHaveBeenCalledExactlyOnceWith(pageOf("source").items, CONTEXT);
    expect(target.http).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(h.activity).toMatchObject([
      { phase: "refused", refusal: "invalid-fields", violationCount: 1 },
    ]);
  });

  it("stages the prepared description and labels before validation and binds private revisions", async () => {
    const h = harness({ templates: [template()], unreadable: 0 });
    const sourceDigest = "a".repeat(64);
    const description = "h2. Acceptance criteria\n* works\n\nh2. Source\nRevision A";
    const prepareRequirements = vi.fn((items: readonly Record<string, unknown>[]) => ({
      ok: true as const,
      items: items.map((entry) => ({
        ...entry,
        fields: { summary: "Prepared", description, labels: ["keiko-source-revision"] },
      })),
      sourceBindings: [{ ref: "source", sourceDigest }],
    }));
    const result = await executeJiraDraftStageTool(
      pageOf("source"),
      CONTEXT,
      connection(undefined, [
        ...CREATE_FIELDS,
        {
          ...field("labels", "array"),
          schema: { type: "array", items: "string", system: "labels" },
        },
      ]),
      { ...h.deps, prepareRequirements },
    );
    expect(result.isError).toBeUndefined();
    const held = h.deps.store.get(text(result.data.draftId), "chat-1");
    expect(prepareRequirements).toHaveBeenCalledExactlyOnceWith(pageOf("source").items, CONTEXT);
    expect(held).toMatchObject({
      items: [{ fields: { description, labels: ["keiko-source-revision"] } }],
      sourceBindings: [{ ref: "source", sourceDigest }],
    });
    expect(
      resolveJiraDraftArguments(
        {
          draftId: result.data.draftId,
          draftDigest: result.data.draftDigest,
        },
        () => held,
      ),
    ).toEqual({ ok: true, arguments: { items: held?.items } });
    expect(result.data).not.toHaveProperty("sourceBindings");
  });

  it("checks template sections against prepared fields rather than the original page", async () => {
    const h = harness();
    const result = await executeJiraDraftStageTool(
      pageOf("source"),
      CONTEXT,
      connection({ templates: [template()], unreadable: 0 }),
      {
        ...h.deps,
        prepareRequirements: () => ({
          ok: true,
          items: [
            item("source", { fields: { summary: "Prepared", description: "No required section" } }),
          ],
          sourceBindings: [{ ref: "source", sourceDigest: "a".repeat(64) }],
        }),
      },
    );
    expect(result).toMatchObject({ isError: true, data: { reason: "field-validation" } });
    expect(h.deps.store.size()).toBe(0);
  });

  it("refuses source preparation before metadata reads and never appends a failed page", async () => {
    const h = harness();
    const remote = connection();
    const result = await executeJiraDraftStageTool(pageOf("source"), CONTEXT, remote, {
      ...h.deps,
      prepareRequirements: () => ({
        ok: false,
        data: { outcome: "rejected", reason: "field-validation" },
        violationCount: 2,
      }),
    });
    expect(result).toMatchObject({ isError: true, data: { reason: "field-validation" } });
    expect(remote.http).not.toHaveBeenCalled();
    expect(h.deps.store.size()).toBe(0);
    expect(h.activity).toMatchObject([{ phase: "refused", violationCount: 2 }]);
  });

  it.each(["different-ref", "unknown-binding"])(
    "refuses a prepared page with %s before metadata reads",
    async (fault) => {
      const h = harness();
      const remote = connection();
      const result = await executeJiraDraftStageTool(pageOf("source"), CONTEXT, remote, {
        ...h.deps,
        prepareRequirements: () => ({
          ok: true,
          items: [item(fault === "different-ref" ? "different" : "source")],
          sourceBindings: [
            {
              ref: fault === "unknown-binding" ? "unknown" : "source",
              sourceDigest: "a".repeat(64),
            },
          ],
        }),
      });
      expect(result).toMatchObject({ isError: true, data: { reason: "invalid-input" } });
      expect(remote.http).not.toHaveBeenCalled();
      expect(h.deps.store.size()).toBe(0);
    },
  );

  it("captures prepared fields before asynchronous metadata reads can change their source", async () => {
    const h = harness();
    const prepared = {
      ref: "source",
      projectId: "10000",
      issueTypeId: "10001",
      fields: { summary: "Reviewed", description: "h2. Acceptance criteria\n* reviewed" },
    };
    const binding = { ref: "source", sourceDigest: "a".repeat(64) };
    const remote = connection();
    const delegate = vi.mocked(remote.http).getMockImplementation();
    if (delegate === undefined) throw new Error("expected fixture HTTP");
    vi.mocked(remote.http).mockImplementation((request) => {
      prepared.fields.description = "Changed while checking metadata";
      binding.sourceDigest = "b".repeat(64);
      return delegate(request);
    });
    const result = await executeJiraDraftStageTool(pageOf("source"), CONTEXT, remote, {
      ...h.deps,
      prepareRequirements: () => ({ ok: true, items: [prepared], sourceBindings: [binding] }),
    });
    expect(result.isError).toBeUndefined();
    const held = h.deps.store.get(text(result.data.draftId), "chat-1");
    expect(held).toMatchObject({
      items: [{ fields: { description: "h2. Acceptance criteria\n* reviewed" } }],
      sourceBindings: [{ sourceDigest: "a".repeat(64) }],
    });
    expect(
      resolveJiraDraftArguments(
        { draftId: result.data.draftId, draftDigest: result.data.draftDigest },
        () =>
          held === undefined
            ? undefined
            : {
                ...held,
                sourceBindings: [{ ref: "source", sourceDigest: "b".repeat(64) }],
              },
      ),
    ).toEqual({ ok: false, reason: "draft-changed" });
  });

  it("rejects untrusted model source bindings as extra stage arguments", async () => {
    const h = harness();
    const result = await h.stage({
      ...pageOf("source"),
      sourceBindings: [{ ref: "source", sourceDigest: "a".repeat(64) }],
    });
    expect(result).toMatchObject({ isError: true, data: { reason: "invalid-input" } });
    expect(h.deps.store.size()).toBe(0);
  });

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

  it("has no item-count limit: 1,200 items stage in pages and resolve to exactly those items", async () => {
    const h = harness();
    let draftId: string | undefined;
    for (let from = 0; from < 1200; from += JIRA_DRAFT_PAGE_ITEMS_MAX) {
      const staged = await h.stage(
        draftId === undefined
          ? { items: page(from, JIRA_DRAFT_PAGE_ITEMS_MAX) }
          : { draftId, items: page(from, JIRA_DRAFT_PAGE_ITEMS_MAX) },
      ); // NOSONAR typescript:S9382 -- each page extends the draft the previous page returned
      expect(staged.isError).toBeUndefined();
      draftId = text(staged.data.draftId);
    }
    const staged = h.deps.store.peek(text(draftId), "chat-1");
    expect(staged?.items).toHaveLength(1200);
    const resolved = resolveJiraDraftArguments(
      { draftId: text(draftId), draftDigest: staged?.digest ?? "" },
      (id) => h.deps.store.get(id, "chat-1"),
    );
    const draft = resolved?.ok === true ? parseJiraDraft(resolved.arguments) : undefined;
    expect(draft?.items).toHaveLength(1200);
  });

  it("refuses a draft above its byte bound whole, keeps what was staged and gives the model fixed guidance", async () => {
    const h = harness(undefined, { maxDraftBytes: 5_000 });
    const first = await h.stage({ items: page(0, 20) });
    expect(first.isError).toBeUndefined();
    const draftId = text(first.data.draftId);
    const before = h.deps.store.peek(draftId, "chat-1");
    const refused = await h.stage({ draftId, items: page(20, 50) });
    expect(refused).toMatchObject({
      isError: true,
      data: { outcome: "failed", reason: "too-large", guidance: JIRA_DRAFT_TOO_LARGE_GUIDANCE },
    });
    expect(JSON.stringify(refused.data)).not.toMatch(/\d{4,}/u);
    expect(JIRA_DRAFT_TOO_LARGE_GUIDANCE).toMatch(/split/u);
    expect(h.deps.store.peek(draftId, "chat-1")?.digest).toBe(before?.digest);
    expect(h.activity.at(-1)).toMatchObject({ phase: "refused", refusal: "too-large" });
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

  it("refuses a page whose item Keiko would refuse, naming it and the field (S05 of #4173)", async () => {
    const h = harness();
    const required = [...CREATE_FIELDS, field("customfield_10103", "string", true)];
    const result = await h.stage(pageOf("one", "two"), "chat-1", required);
    expect(result).toEqual({
      isError: true,
      data: {
        outcome: "rejected",
        reason: "field-validation",
        ref: "one",
        fieldId: "customfield_10103",
        validation: "required-field",
      },
    });
    expect(h.activity.at(-1)).toMatchObject({
      phase: "refused",
      refusal: "invalid-fields",
      pageItemCount: 2,
      violationCount: 2,
    });
    const staged = await h.stage(pageOf("one"));
    expect(staged.data).toMatchObject({ newDraft: true, itemCount: 1 });
  });

  describe("a template that requires a link (parentLink)", () => {
    const blocks = (): JiraIssueTemplateSet => ({
      templates: [template("parentLink: Blocks")],
      unreadable: 0,
    });
    const blocking = (to: Record<string, unknown>): Record<string, unknown> => ({
      links: [{ type: "Blocks", direction: "outward", ...to }],
    });

    it("stages an item whose proposed link satisfies the rule", async () => {
      const h = harness(blocks());
      const staged = await h.stage({
        items: [item("a", blocking({ issueKey: "SYN-90" }))] as CatalogJsonObject[],
      });
      expect(staged.data).toMatchObject({ outcome: "succeeded", itemCount: 1 });
    });

    it("stages an item whose required link targets a later staged item", async () => {
      const h = harness(blocks());
      const staged = await h.stage({
        items: [
          item("a", blocking({ ref: "b" })),
          item("b", blocking({ issueKey: "SYN-90" })),
        ] as CatalogJsonObject[],
      });
      expect(staged.data).toMatchObject({ outcome: "succeeded", itemCount: 2 });
    });

    it("refuses an item that proposes no such link, naming the link type to add", async () => {
      const h = harness(blocks());
      const refused = await h.stage({
        items: [
          item("a"),
          item("b", { links: [{ type: "Relates", direction: "outward", issueKey: "SYN-9" }] }),
        ] as CatalogJsonObject[],
      });
      expect(refused).toMatchObject({
        isError: true,
        data: {
          ref: "a",
          violations: [{ ruleId: "parent-missing", subject: "Blocks", template: "SYN/Story" }],
        },
      });
      expect(h.deps.store.size()).toBe(0);
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

  it("names the first item that is not in the jira.draft item form", async () => {
    const h = harness();
    const result = await h.stage({
      items: [item("a"), { ref: "b" }, { ref: "c" }] as unknown as CatalogJsonObject[],
    });
    expect(result.data).toMatchObject({ reason: "invalid-input" });
    expect(text(result.data.guidance)).toMatch(/^Item 2 is not in the jira\.draft item form/u);
    expect(text(result.data.guidance)).not.toContain('"b"');
    const empty = await h.stage({ items: [] });
    expect(text(empty.data.guidance)).toContain("1 to ");
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

describe("refs repeated inside one staged page (review)", () => {
  it("refuses a first page that repeats a ref and stages nothing", async () => {
    const h = harness();
    const refused = await h.stage({ items: [item("first"), item("first")] as CatalogJsonObject[] });
    expect(refused).toMatchObject({ isError: true, data: { reason: "duplicate-ref" } });
    expect(h.deps.store.size()).toBe(0);
  });

  it("refuses a later page that repeats a ref and keeps the last valid draft and digest", async () => {
    const h = harness();
    const first = await h.stage({ items: [item("a")] as CatalogJsonObject[] });
    const draftId = text(first.data.draftId);
    const refused = await h.stage({
      draftId,
      items: [item("b"), item("b")] as CatalogJsonObject[],
    });
    expect(refused.data).toMatchObject({ reason: "duplicate-ref" });
    const held = h.deps.store.peek(draftId, "chat-1");
    expect(held?.items).toHaveLength(1);
    expect(held?.digest).toBe(first.data.draftDigest);
  });

  it("stages a page of distinct refs and its digest resolves to a parsable draft", async () => {
    const h = harness();
    const staged = await h.stage({ items: [item("x"), item("y")] as CatalogJsonObject[] });
    expect(staged.data).toMatchObject({ outcome: "succeeded", itemCount: 2 });
    const resolved = resolveJiraDraftArguments(
      { draftId: text(staged.data.draftId), draftDigest: text(staged.data.draftDigest) },
      (id) => h.deps.store.get(id, "chat-1"),
    );
    expect(resolved?.ok === true && parseJiraDraft(resolved.arguments)).toBeTruthy();
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

describe("staged descriptions before requirement trace", () => {
  it("refuses an escaped description with requirement references without changing the saved draft", async () => {
    const h = harness({ templates: [template()], unreadable: 0 });
    const accepted = await h.stage(pageOf("kept"));
    const draftId = text(accepted.data.draftId);
    const before = h.deps.store.peek(draftId, "chat-1");
    const remote = connection({ templates: [template()], unreadable: 0 });
    const refused = await executeJiraDraftStageTool(
      {
        draftId,
        items: [
          item("encoded", {
            requirementIds: ["REQ-1"],
            fields: {
              summary: "Encoded description",
              description: String.raw`h2. Acceptance criteria\n* exact\nh2. Source\nReference`,
            },
          }) as CatalogJsonObject,
        ],
      },
      CONTEXT,
      remote,
      h.deps,
    );
    expect(refused).toEqual({
      isError: true,
      data: {
        outcome: "rejected",
        reason: "field-validation",
        ref: "encoded",
        fieldId: "description",
        validation: "invalid-field",
        messages: [
          "The text contains escaped line breaks (\\n) and no real line break; send real line breaks instead.",
        ],
      },
    });
    expect(h.deps.store.peek(draftId, "chat-1")).toEqual(before);
    expect(h.activity.at(-1)).toMatchObject({
      phase: "refused",
      refusal: "invalid-fields",
      pageItemCount: 1,
      violationCount: 1,
    });
    expect(vi.mocked(remote.http).mock.calls.every(([request]) => request.method === "GET")).toBe(
      true,
    );
  });
});

describe("native staged description rendering contract", () => {
  it("refuses Markdown-looking native headings before staging but accepts explicit Markdown", async () => {
    const h = harness({ templates: [template()], unreadable: 0 });
    const description = "## Acceptance criteria\n* works";
    const refused = await h.stage({
      items: [item("native", { fields: { summary: "Native", description } }) as CatalogJsonObject],
    });
    expect(refused).toMatchObject({
      isError: true,
      data: {
        outcome: "rejected",
        reason: "field-validation",
        ref: "native",
        violations: [{ ruleId: "section-missing", subject: "Acceptance criteria" }],
      },
    });
    expect(refused.data.guidance).toEqual(expect.stringContaining("h2. Title"));
    expect(h.deps.store.size()).toBe(0);
    expect(h.activity.at(-1)).toMatchObject({
      phase: "refused",
      refusal: "template-violation",
      violationCount: 1,
    });
    const explicit = { format: "markdown", text: description };
    const accepted = await h.stage({
      items: [
        item("explicit", {
          fields: { summary: "Explicit", description: explicit },
        }) as CatalogJsonObject,
      ],
    });
    expect(accepted.data).toMatchObject({ outcome: "succeeded", itemCount: 1 });
    expect(
      h.deps.store.peek(text(accepted.data.draftId), "chat-1")?.items[0]?.fields,
    ).toMatchObject({ description: explicit });
  });
});
