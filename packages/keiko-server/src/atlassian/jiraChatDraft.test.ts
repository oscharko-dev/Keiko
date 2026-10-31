import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { jiraDraftIdentity, parseJiraDraft } from "@oscharko-dev/keiko-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { buildUiStoreOverDatabase } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import { createChatToolMutationStore } from "../store/chatToolMutations.js";
import type {
  ChatToolMutationStore,
  JiraChatToolMutationIntent,
} from "../store/chatToolMutationTypes.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { field, LINKS_FIELD } from "../../../../tests/support/jira-managed-remote.js";
import { createGatewayAtlassianHttpBodyPort } from "./httpPort.js";
import {
  executeJiraChatDraft,
  jiraDraftChildIntent,
  jiraDraftOutcome,
  observedJiraDraftOutcome,
  type JiraChatDraftExecution,
} from "./jiraChatDraft.js";

const BASE_URL = "https://jira.example.invalid";
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

interface StoredIssue {
  readonly key: string;
  readonly id: string;
  readonly fields: Record<string, unknown>;
}
interface SyntheticJira {
  readonly fetch: Mock<typeof fetch>;
  readonly issues: StoredIssue[];
  readonly posts: () => readonly Record<string, unknown>[];
  /** Summaries Jira refuses on create, with its own field error. */
  readonly refuse: Set<string>;
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
function syntheticJira(existing: StoredIssue[] = []): SyntheticJira {
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
      return json({ issues: found });
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

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function journalFixture(): { journal: ChatToolMutationStore; intent: JiraChatToolMutationIntent } {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  const store = buildUiStoreOverDatabase(db);
  cleanup.push(() => {
    store.close();
  });
  const chat = store.createChat(store.createProject(process.cwd()).path, "Synthetic", "model");
  const turn = store.admitChatTurn("synthetic-turn", {
    chatId: chat.id,
    role: "user",
    content: "synthetic",
    timestamp: 1000,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (turn.kind !== "admitted" || turn.userMessage.canonicalTurnRef === undefined)
    throw new Error("Expected turn");
  const journal = createChatToolMutationStore(db, () => 1000, createBufferedServerLogSink());
  return {
    journal,
    intent: {
      invocationId: "draft-invocation",
      chatId: chat.id,
      userMessageId: turn.userMessage.id,
      turnRef: turn.userMessage.canonicalTurnRef,
      actorId: "actor-one",
      podId: "pod-one",
      bindingGeneration: 1,
      credentialGeneration: 1,
      authorityDigest: "a".repeat(64),
      actionDigest: "b".repeat(64),
      operation: "jira.draft",
      correlationId: "draft-one",
    },
  };
}

function item(ref: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref,
    projectId: "10000",
    issueTypeId: "10001",
    fields: { summary: `Item ${ref}` },
    ...extra,
  };
}
const BACKLOG = {
  items: [
    item("story", { parent: { fieldId: "parent", ref: "epic" } }),
    item("epic"),
    item("task", { links: [{ type: "Relates", direction: "outward", ref: "story" }] }),
    item("loose"),
  ],
} as unknown as CatalogJsonObject;

function execution(
  jira: SyntheticJira,
  args: CatalogJsonObject = BACKLOG,
  deselected: readonly string[] = [],
): JiraChatDraftExecution {
  const { journal, intent } = journalFixture();
  return {
    journal,
    intent,
    arguments: args,
    deselected,
    context: {
      invocationId: "transport",
      correlationId: intent.correlationId,
      signal: new AbortController().signal,
      beforeEffect: () => true,
    },
    connection: { baseUrl: BASE_URL, deployment: "data-center" },
    httpPortFactory: (lifecycle) =>
      createGatewayAtlassianHttpBodyPort({
        ...lifecycle,
        correlationId: intent.correlationId,
        baseUrl: BASE_URL,
        authRef: "synthetic-ref",
        credentials: {
          resolveForExecution: () => ({ scheme: "bearer-pat", apiToken: "synthetic-test-pat" }),
        },
        fetchImpl: jira.fetch,
      }),
    beforeEffect: () => true,
    beforeMutation: () => true,
  };
}
function itemsOf(result: Awaited<ReturnType<typeof executeJiraChatDraft>>): unknown[] {
  return result.data.items as unknown[];
}

describe("executeJiraChatDraft (#4178)", () => {
  it("creates every item once, in dependency order, behind one journal record each", async () => {
    const jira = syntheticJira();
    const input = execution(jira);
    const result = await executeJiraChatDraft(input);
    expect(result.isError).toBeUndefined();
    expect(result.data).toMatchObject({ outcome: "succeeded", createdCount: 4, skippedCount: 0 });
    expect(itemsOf(result)).toEqual([
      { ref: "epic", state: "created", issueKey: "SYN-1", browseUrl: `${BASE_URL}/browse/SYN-1` },
      { ref: "story", state: "created", issueKey: "SYN-2", browseUrl: `${BASE_URL}/browse/SYN-2` },
      { ref: "task", state: "created", issueKey: "SYN-3", browseUrl: `${BASE_URL}/browse/SYN-3` },
      { ref: "loose", state: "created", issueKey: "SYN-4", browseUrl: `${BASE_URL}/browse/SYN-4` },
    ]);
    expect(jira.issues[1]?.fields.parent).toEqual({ key: "SYN-1" });
    expect(jira.posts()[2]).toMatchObject({
      update: {
        issuelinks: [{ add: { type: { name: "Relates" }, outwardIssue: { key: "SYN-2" } } }],
      },
    });
    for (const ref of ["epic", "story", "task", "loose"])
      expect(
        input.journal?.find(jiraDraftChildIntent(input.intent, ref).invocationId),
      ).toMatchObject({ operation: "jira.create", phase: "settled", outcome: "succeeded" });
    expect(observedJiraDraftOutcome(input.journal, input.intent, BACKLOG)).toBe("succeeded");
  });

  it("never sends a replayed item again and still hands its key to later items", async () => {
    const jira = syntheticJira();
    const input = execution(jira);
    await executeJiraChatDraft(input);
    const result = await executeJiraChatDraft(input);
    expect(jira.posts()).toHaveLength(4);
    expect(itemsOf(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "epic", state: "created", issueKey: "SYN-1" }),
        expect.objectContaining({ ref: "story", state: "created", issueKey: "SYN-2" }),
      ]),
    );
  });

  it("leaves out the deselected items and every item that depends on them", async () => {
    const jira = syntheticJira();
    const result = await executeJiraChatDraft(execution(jira, BACKLOG, ["epic"]));
    expect(itemsOf(result)).toEqual([
      { ref: "epic", state: "excluded" },
      { ref: "story", state: "excluded" },
      { ref: "task", state: "excluded" },
      expect.objectContaining({ ref: "loose", state: "created" }),
    ]);
    expect(result.data).toMatchObject({ outcome: "succeeded", excludedCount: 3, createdCount: 1 });
    expect(jira.posts()).toHaveLength(1);
  });

  it("skips the dependents of an item refused before sending and continues with the rest", async () => {
    const jira = syntheticJira();
    const args = {
      items: [
        { ...item("epic"), fields: { summary: "Item epic", customfield_99999: "unknown" } },
        item("story", { parent: { fieldId: "parent", ref: "epic" } }),
        item("loose"),
      ],
    } as unknown as CatalogJsonObject;
    const result = await executeJiraChatDraft(execution(jira, args));
    expect(itemsOf(result)).toEqual([
      expect.objectContaining({ ref: "epic", state: "failed", reason: "field-validation" }),
      { ref: "story", state: "skipped" },
      expect.objectContaining({ ref: "loose", state: "created" }),
    ]);
    expect(result).toMatchObject({
      isError: true,
      data: { outcome: "succeeded", failedCount: 1, skippedCount: 1, createdCount: 1 },
    });
    expect(jira.posts()).toHaveLength(1);
  });

  it("stops after an item Jira refused once sent, and returns Jira's own field error", async () => {
    const jira = syntheticJira();
    jira.refuse.add("Item epic");
    const result = await executeJiraChatDraft(execution(jira));
    expect(itemsOf(result)).toEqual([
      expect.objectContaining({
        ref: "epic",
        state: "uncertain",
        fieldErrors: [{ fieldId: "summary", message: "Synthetic refusal" }],
      }),
      { ref: "story", state: "skipped" },
      { ref: "task", state: "skipped" },
      { ref: "loose", state: "skipped" },
    ]);
    expect(result).toMatchObject({
      isError: true,
      data: { outcome: "unknown", uncertainCount: 1 },
    });
    expect(jira.posts()).toHaveLength(1);
  });

  it("reconciles an item whose issue already exists instead of creating it twice", async () => {
    const parsed = parseJiraDraft(BACKLOG);
    const epic = parsed?.items.find((entry) => entry.ref === "epic");
    if (epic === undefined) throw new Error("epic");
    const jira = syntheticJira([
      {
        key: "SYN-1",
        id: "10001",
        fields: { summary: "Item epic", labels: [jiraDraftIdentity(epic)] },
      },
    ]);
    const input = execution(jira);
    const result = await executeJiraChatDraft(input);
    expect(itemsOf(result)[0]).toEqual({
      ref: "epic",
      state: "existing",
      issueKey: "SYN-1",
      browseUrl: `${BASE_URL}/browse/SYN-1`,
    });
    expect(result.data).toMatchObject({ existingCount: 1, createdCount: 3 });
    expect(jira.posts()).toHaveLength(3);
    expect(jira.issues[1]?.fields.parent).toEqual({ key: "SYN-1" });
    expect(
      input.journal?.find(jiraDraftChildIntent(input.intent, "epic").invocationId)?.outcome,
    ).toBe("not-dispatched");
  });

  it("refuses a malformed draft before any request", async () => {
    const jira = syntheticJira();
    const result = await executeJiraChatDraft(
      execution(jira, { items: [item("a", { parent: { fieldId: "parent", ref: "a" } })] } as never),
    );
    expect(result).toEqual({
      data: { outcome: "rejected", reason: "field-validation", items: [] },
      isError: true,
    });
    expect(jira.fetch).not.toHaveBeenCalled();
  });

  it("sends nothing when the human's admission is withdrawn before the mutation", async () => {
    const jira = syntheticJira();
    const input = { ...execution(jira), beforeMutation: (): boolean => false };
    const result = await executeJiraChatDraft(input);
    expect(jira.posts()).toHaveLength(0);
    expect(result.data.outcome).not.toBe("succeeded");
  });
});

describe("draft outcome", () => {
  it("is uncertain when any item is, and has no observation before any item ran", () => {
    expect(jiraDraftOutcome(["succeeded", "unknown"])).toBe("unknown");
    expect(jiraDraftOutcome(["succeeded", undefined])).toBe("unknown");
    expect(jiraDraftOutcome(["succeeded-unconfirmed", "succeeded"])).toBe("succeeded-unconfirmed");
    expect(jiraDraftOutcome(["rejected", "succeeded"])).toBe("succeeded");
    expect(jiraDraftOutcome(["rejected", "not-dispatched"])).toBe("rejected");
    expect(jiraDraftOutcome(["not-dispatched"])).toBe("not-dispatched");
    const { journal, intent } = journalFixture();
    expect(observedJiraDraftOutcome(journal, intent, BACKLOG)).toBeUndefined();
    expect(observedJiraDraftOutcome(undefined, intent, BACKLOG)).toBeUndefined();
  });
});
