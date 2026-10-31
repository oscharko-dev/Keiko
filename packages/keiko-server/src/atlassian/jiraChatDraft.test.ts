import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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
import {
  SYNTHETIC_JIRA_BASE_URL,
  syntheticJira,
  type StoredIssue,
  type SyntheticJira,
} from "../../../../tests/support/jira-synthetic-draft-remote.js";
import { createGatewayAtlassianHttpBodyPort } from "./httpPort.js";
import {
  executeJiraChatDraft,
  jiraDraftChildIntent,
  jiraDraftOutcome,
  observedJiraDraftOutcome,
  type JiraChatDraftExecution,
} from "./jiraChatDraft.js";

const BASE_URL = SYNTHETIC_JIRA_BASE_URL;
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

  const HUB = {
    items: [
      item("one"),
      item("two"),
      item("three"),
      item("hub", {
        links: ["one", "two", "three"].map((ref) => ({
          type: "Relates",
          direction: "outward",
          ref,
        })),
      }),
    ],
  } as unknown as CatalogJsonObject;
  const linkKeys = (issue: StoredIssue | undefined): unknown[] =>
    ((issue?.fields.issuelinks ?? []) as { outwardIssue?: { key: string } }[])
      .map((link) => link.outwardIssue?.key)
      .sort();

  it("creates an item with several links as its create plus one call per further link (#4176)", async () => {
    const jira = syntheticJira();
    const input = execution(jira, HUB);
    const result = await executeJiraChatDraft(input);
    expect(result.data).toMatchObject({ outcome: "succeeded", createdCount: 4, failedCount: 0 });
    expect(linkKeys(jira.issues[3])).toEqual(["SYN-1", "SYN-2", "SYN-3"]);
    const operations = jira
      .posts()
      .map((body) => (body as { update?: { issuelinks?: unknown[] } }).update?.issuelinks?.length);
    expect(Math.max(...operations.map((count) => count ?? 0))).toBe(1);
    expect(jira.posts().filter((body) => "inwardIssue" in body)).toHaveLength(2);
    expect(
      input.journal?.find(jiraDraftChildIntent(input.intent, "hub").invocationId),
    ).toMatchObject({ phase: "settled", outcome: "succeeded", httpStatus: 201 });
  });

  it("names the created issue and the missing links when a further link fails (#4176)", async () => {
    const jira = syntheticJira();
    jira.refuseLinks.add("SYN-3");
    const input = execution(jira, HUB);
    const result = await executeJiraChatDraft(input);
    expect(itemsOf(result)[3]).toMatchObject({
      ref: "hub",
      state: "uncertain",
      issueKey: "SYN-4",
      reason: "not-found",
      linksRequested: 3,
      linksCreated: 2,
      linksMissing: [{ type: "Relates", direction: "outward", issueKey: "SYN-3" }],
    });
    // An uncertain item makes the draft uncertain; the item itself carries the partial effect.
    expect(result).toMatchObject({
      isError: true,
      data: { outcome: "unknown", uncertainCount: 1 },
    });
    expect(
      input.journal?.find(jiraDraftChildIntent(input.intent, "hub").invocationId),
    ).toMatchObject({ phase: "settled", outcome: "succeeded-unconfirmed" });
    // A repeat of the whole draft sends nothing: the hub is neither created nor linked again.
    const posts = jira.posts().length;
    await executeJiraChatDraft(input);
    expect(jira.posts()).toHaveLength(posts);
    expect(jira.issues).toHaveLength(4);
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

  it("creates two same-summary tasks under different parents and reconciles each on a rerun", async () => {
    const task = (ref: string, parentKey: string): Record<string, unknown> =>
      item(ref, {
        fields: { summary: "Implement logging" },
        parent: { fieldId: "parent", issueKey: parentKey },
      });
    const args = {
      items: [task("a", "SYN-90"), task("b", "SYN-91")],
    } as unknown as CatalogJsonObject;
    const jira = syntheticJira();
    const first = await executeJiraChatDraft(execution(jira, args));
    expect(first.isError).toBeUndefined();
    expect(first.data).toMatchObject({ outcome: "succeeded", createdCount: 2 });
    expect(jira.posts()).toHaveLength(2);
    expect(jira.issues.map((issue) => issue.fields.parent)).toEqual([
      { key: "SYN-90" },
      { key: "SYN-91" },
    ]);
    // A new journal: nothing replays, so only the draft identities can tell the items apart.
    const rerun = await executeJiraChatDraft(execution(jira, args));
    expect(jira.posts()).toHaveLength(2);
    expect(itemsOf(rerun)).toEqual([
      expect.objectContaining({ ref: "a", state: "existing", issueKey: "SYN-1" }),
      expect.objectContaining({ ref: "b", state: "existing", issueKey: "SYN-2" }),
    ]);
  });

  it("recovers an item reconciled on the first run when its journal replays", async () => {
    const epic = parseJiraDraft(BACKLOG)?.items.find((entry) => entry.ref === "epic");
    if (epic === undefined) throw new Error("epic");
    const jira = syntheticJira([
      {
        key: "SYN-1",
        id: "10001",
        fields: { summary: "Item epic", labels: [jiraDraftIdentity(epic)] },
      },
    ]);
    const args = {
      items: [item("epic"), item("story", { parent: { fieldId: "parent", ref: "epic" } })],
    } as unknown as CatalogJsonObject;
    const input = execution(jira, args);
    const first = await executeJiraChatDraft(input);
    expect(itemsOf(first)).toEqual([
      expect.objectContaining({ ref: "epic", state: "existing", issueKey: "SYN-1" }),
      expect.objectContaining({ ref: "story", state: "created", issueKey: "SYN-2" }),
    ]);
    expect(jira.posts()).toHaveLength(1);
    const replay = await executeJiraChatDraft(input);
    expect(jira.posts()).toHaveLength(1);
    expect(replay.isError).toBeUndefined();
    expect(itemsOf(replay)).toEqual([
      expect.objectContaining({ ref: "epic", state: "existing", issueKey: "SYN-1" }),
      expect.objectContaining({ ref: "story", state: "created", issueKey: "SYN-2" }),
    ]);
    expect(replay.data).toMatchObject({ existingCount: 1, createdCount: 1, failedCount: 0 });
  });

  it("is no error when every item already exists or the human deselected the whole draft", async () => {
    const jira = syntheticJira();
    await executeJiraChatDraft(execution(jira));
    expect(jira.posts()).toHaveLength(4);
    const rerun = await executeJiraChatDraft(execution(jira));
    expect(rerun.isError).toBeUndefined();
    expect(rerun.data).toMatchObject({ outcome: "not-dispatched", existingCount: 4 });
    const none = await executeJiraChatDraft(execution(syntheticJira(), BACKLOG, ["epic", "loose"]));
    expect(none.isError).toBeUndefined();
    expect(none.data).toMatchObject({ outcome: "not-dispatched", excludedCount: 4 });
    expect(jira.posts()).toHaveLength(4);
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
