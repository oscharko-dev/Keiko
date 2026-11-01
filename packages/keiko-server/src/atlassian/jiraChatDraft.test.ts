import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  jiraDraftIdentity,
  parseJiraDraft,
  type JiraDraftActivity,
} from "@oscharko-dev/keiko-connectors";
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
import { JIRA_REJECTED_GUIDANCE, JIRA_UNCERTAIN_GUIDANCE } from "./jiraMutationResult.js";
import { jiraChatDraftConnection } from "./jiraChatCatalogRuntime.js";
import type { TraceSession } from "../requirement-trace.js";
import {
  executeJiraChatDraft,
  jiraDraftChildIntent,
  JIRA_DRAFT_EXISTING_GUIDANCE,
  JIRA_DRAFT_PARTLY_REJECTED_GUIDANCE,
  JIRA_DRAFT_PENDING_GUIDANCE,
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

  it("does not complete the item as existing on a new turn while its further link is still missing (review)", async () => {
    const jira = syntheticJira();
    jira.refuseLinks.add("SYN-3");
    await executeJiraChatDraft(execution(jira, HUB));
    const posts = jira.posts().length;
    // A fresh journal is a later turn: the identity matches the issue the first run created.
    const rerun = await executeJiraChatDraft(execution(jira, HUB));
    expect(itemsOf(rerun)[3]).toMatchObject({
      ref: "hub",
      state: "failed",
      issueKey: "SYN-4",
      reason: "conflict",
      linksRequested: 3,
      linksCreated: 2,
      linksMissing: [{ type: "Relates", direction: "outward", issueKey: "SYN-3" }],
    });
    expect(rerun.isError).toBe(true);
    expect(rerun.data).toMatchObject({ existingCount: 3, failedCount: 1 });
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
      { ref: "story", state: "skipped", blockedBy: ["epic"] },
      expect.objectContaining({ ref: "loose", state: "created" }),
    ]);
    expect(result).toMatchObject({
      isError: true,
      data: { outcome: "succeeded", failedCount: 1, skippedCount: 1, createdCount: 1 },
    });
    expect(jira.posts()).toHaveLength(1);
  });

  it("returns Jira's own field error for an item it refused with an error document and continues with the rest (#4176)", async () => {
    const jira = syntheticJira();
    jira.refuse.add("Item epic");
    const result = await executeJiraChatDraft(execution(jira));
    expect(itemsOf(result)).toEqual([
      expect.objectContaining({
        ref: "epic",
        state: "failed",
        fieldErrors: [{ fieldId: "summary", fieldName: "summary", message: "Synthetic refusal" }],
      }),
      { ref: "story", state: "skipped", blockedBy: ["epic"] },
      { ref: "task", state: "skipped", blockedBy: ["story"] },
      expect.objectContaining({ ref: "loose", state: "created" }),
    ]);
    expect(result).toMatchObject({
      isError: true,
      data: {
        outcome: "succeeded",
        failedCount: 1,
        skippedCount: 2,
        createdCount: 1,
        guidance: JIRA_DRAFT_PARTLY_REJECTED_GUIDANCE,
      },
    });
    expect(jira.posts()).toHaveLength(2);
  });

  // A partly refused draft changed Jira: its words must not say that nothing was changed (#4178).
  it.each([
    ["the refused item first", ["Item epic"]],
    ["the refused item last", ["Item loose"]],
  ])("names created and refused items when Jira refused only some, %s", async (_name, refused) => {
    const jira = syntheticJira();
    for (const summary of refused) jira.refuse.add(summary);
    const result = await executeJiraChatDraft(execution(jira));
    expect(result.data.guidance).toBe(JIRA_DRAFT_PARTLY_REJECTED_GUIDANCE);
    expect(itemsOf(result).some((item) => item.state === "created")).toBe(true);
  });

  it("keeps the nothing-changed words when Jira refused every item it was sent", async () => {
    const jira = syntheticJira();
    for (const summary of ["Item epic", "Item loose"]) jira.refuse.add(summary);
    const result = await executeJiraChatDraft(execution(jira));
    expect(result.data.guidance).toBe(JIRA_REJECTED_GUIDANCE);
    expect(itemsOf(result).some((item) => item.state === "created")).toBe(false);
  });

  it.each([
    ["a 400 that is no Jira error document", 400, "<html>Bad request</html>"],
    ["a 500", 500, JSON.stringify({ errorMessages: ["Internal error"], errors: {} })],
    ["a 409", 409, JSON.stringify({ errorMessages: ["Conflict"], errors: {} })],
    ["a 429", 429, JSON.stringify({ errorMessages: ["Slow down"], errors: {} })],
  ])(
    "stops after an item Jira refused with %s: the effect is uncertain",
    async (_name, status, body) => {
      const jira = syntheticJira();
      jira.refuseRaw.set("Item epic", { status, body });
      const result = await executeJiraChatDraft(execution(jira));
      expect(itemsOf(result)).toEqual([
        expect.objectContaining({ ref: "epic", state: "uncertain" }),
        { ref: "story", state: "skipped", blockedBy: ["epic"] },
        { ref: "task", state: "skipped", blockedBy: ["story"] },
        // Nothing is tried after an uncertain item; this one waits for no other item.
        { ref: "loose", state: "skipped" },
      ]);
      expect(result).toMatchObject({
        isError: true,
        data: { outcome: "unknown", uncertainCount: 1, guidance: JIRA_UNCERTAIN_GUIDANCE },
      });
      expect(jira.posts()).toHaveLength(1);
    },
  );

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
    // S19 (#4178): the model is told plainly that nothing is missing, so it does not create again.
    expect(rerun.data).toMatchObject({
      outcome: "not-dispatched",
      existingCount: 4,
      guidance: JIRA_DRAFT_EXISTING_GUIDANCE,
    });
    const none = await executeJiraChatDraft(execution(syntheticJira(), BACKLOG, ["epic", "loose"]));
    expect(none.isError).toBeUndefined();
    expect(none.data).toMatchObject({ outcome: "not-dispatched", excludedCount: 4 });
    expect(none.data).not.toHaveProperty("guidance");
    expect(jira.posts()).toHaveLength(4);
  });

  it("creates all 70 items of one approved draft although a turn admits only 32 single writes", async () => {
    // Epic #4173 AC "A draft of any size is approved once": the journal's bound on single writes
    // per turn (32) must not cut an approved draft; the draft is its own bounded batch.
    const jira = syntheticJira();
    const epics = Array.from({ length: 7 }, (_, index) => item(`epic${String(index)}`));
    const stories = Array.from({ length: 63 }, (_, index) =>
      item(`story${String(index)}`, {
        parent: { fieldId: "parent", ref: `epic${String(index % 7)}` },
      }),
    );
    const args = { items: [...epics, ...stories] } as unknown as CatalogJsonObject;
    const input = execution(jira, args);
    const result = await executeJiraChatDraft(input);
    expect(result.isError).toBeUndefined();
    expect(result.data).toMatchObject({
      outcome: "succeeded",
      createdCount: 70,
      failedCount: 0,
      skippedCount: 0,
    });
    expect(jira.issues).toHaveLength(70);
    expect(jira.posts().length).toBeGreaterThanOrEqual(70);
    expect(observedJiraDraftOutcome(input.journal, input.intent, args)).toBe("succeeded");
  });

  it("creates no new issue when an executed 70-item draft is run again", async () => {
    // Epic #4173 AC "Re-running an executed draft creates zero new issues": a fresh journal replays
    // nothing, so only the items' deterministic identities can tell Jira already holds them.
    const jira = syntheticJira();
    const epics = Array.from({ length: 7 }, (_, index) => item(`epic${String(index)}`));
    const stories = Array.from({ length: 63 }, (_, index) =>
      item(`story${String(index)}`, {
        parent: { fieldId: "parent", ref: `epic${String(index % 7)}` },
      }),
    );
    const args = { items: [...epics, ...stories] } as unknown as CatalogJsonObject;
    await executeJiraChatDraft(execution(jira, args));
    expect(jira.issues).toHaveLength(70);
    const postsAfterFirstRun = jira.posts().length;
    const rerun = await executeJiraChatDraft(execution(jira, args));
    expect(rerun.isError).toBeUndefined();
    expect(rerun.data).toMatchObject({ outcome: "not-dispatched", existingCount: 70 });
    expect(rerun.data).toMatchObject({ createdCount: 0, failedCount: 0 });
    expect(jira.issues).toHaveLength(70);
    expect(jira.posts()).toHaveLength(postsAfterFirstRun);
  });

  describe("a draft of any size (epic #4173, #4178)", () => {
    const largeDraft = (count: number): CatalogJsonObject => {
      const epics = Math.ceil(count / 100);
      return {
        items: [
          ...Array.from({ length: epics }, (_, index) => item(`epic${String(index)}`)),
          ...Array.from({ length: count - epics }, (_, index) =>
            item(`story${String(index)}`, {
              parent: { fieldId: "parent", ref: `epic${String(index % epics)}` },
            }),
          ),
        ],
      } as unknown as CatalogJsonObject;
    };

    it("creates all 1,200 items of one approved draft and reports them compactly and exactly", async () => {
      const jira = syntheticJira();
      const result = await executeJiraChatDraft(execution(jira, largeDraft(1200)));
      expect(result.isError).toBeUndefined();
      expect(result.data).toMatchObject({
        outcome: "succeeded",
        createdCount: 1200,
        failedCount: 0,
        pendingCount: 0,
        compact: true,
        items: [],
        createdRanges: ["SYN-1..SYN-1200"],
      });
      expect(jira.issues).toHaveLength(1200);
      // Within the tool catalog's 256 KiB result ceiling, however many items were created.
      expect(Buffer.byteLength(JSON.stringify(result.data))).toBeLessThan(262_144);
    });

    it("creates zero new issues when the executed 1,200-item draft is run again", async () => {
      const jira = syntheticJira();
      await executeJiraChatDraft(execution(jira, largeDraft(1200)));
      const postsAfterFirstRun = jira.posts().length;
      const rerun = await executeJiraChatDraft(execution(jira, largeDraft(1200)));
      expect(rerun.isError).toBeUndefined();
      expect(rerun.data).toMatchObject({
        outcome: "not-dispatched",
        createdCount: 0,
        existingCount: 1200,
        existingRanges: ["SYN-1..SYN-1200"],
      });
      expect(jira.issues).toHaveLength(1200);
      expect(jira.posts()).toHaveLength(postsAfterFirstRun);
    });

    it("keeps a run time-bounded, reports the unfinished items honestly and finishes them on a re-run", async () => {
      const args = largeDraft(40);
      const jira = syntheticJira();
      let tick = 0;
      const clock = (): number => (tick += 1000);
      const activity: JiraDraftActivity[] = [];
      const first = await executeJiraChatDraft({
        ...execution(jira, args),
        now: clock,
        budget: { writeMs: 20_000, totalMs: 3_600_000 },
        activity: (entry) => activity.push(entry),
      });
      const created = jira.issues.length;
      expect(created).toBeGreaterThan(0);
      expect(created).toBeLessThan(40);
      expect(first.isError).toBe(true);
      expect(first.data).toMatchObject({
        outcome: "succeeded",
        createdCount: created,
        pendingCount: 40 - created,
        guidance: JIRA_DRAFT_PENDING_GUIDANCE,
      });
      // The keys created in this run are listed exactly, none missing and none invented.
      const rows = first.data.items as { state: string; issueKey?: string }[];
      expect(rows.filter((row) => row.state === "created").map((row) => row.issueKey)).toEqual(
        jira.issues.map((issue) => issue.key),
      );
      expect(rows.filter((row) => row.state === "pending")).toHaveLength(40 - created);
      expect(activity.at(-1)).toMatchObject({
        phase: "executed",
        itemCount: 40,
        settledCount: created,
        pendingCount: 40 - created,
      });
      // The same draft again, in a later turn: what exists is recognised, the rest is created.
      const rerun = await executeJiraChatDraft(execution(jira, args));
      expect(rerun.isError).toBeUndefined();
      expect(rerun.data).toMatchObject({
        createdCount: 40 - created,
        existingCount: created,
        pendingCount: 0,
      });
      expect(jira.issues).toHaveLength(40);
      expect(new Set(jira.issues.map((issue) => issue.fields.summary)).size).toBe(40);
    });

    it("records progress every 100 attempted items, counts only", async () => {
      const activity: JiraDraftActivity[] = [];
      await executeJiraChatDraft({
        ...execution(syntheticJira(), largeDraft(250)),
        activity: (entry) => activity.push(entry),
      });
      expect(
        activity.map((entry) => [entry.phase, entry.settledCount, entry.pendingCount]),
      ).toEqual([
        ["progress", 100, 150],
        ["progress", 200, 50],
        ["executed", 250, 0],
      ]);
    });
  });

  it("keeps the per-turn bound for single writes after a large draft ran in the same turn", async () => {
    const jira = syntheticJira();
    const items = Array.from({ length: 40 }, (_, index) => item(`bulk${String(index)}`));
    const input = execution(jira, { items } as unknown as CatalogJsonObject);
    await executeJiraChatDraft(input);
    expect(jira.issues).toHaveLength(40);
    // Single writes of the same turn are counted on their own, not together with the draft's items.
    const single = input.journal?.prepare({
      ...input.intent,
      operation: "jira.create",
      invocationId: "single-write",
      actionDigest: "c".repeat(64),
    });
    expect(single?.kind).toBe("prepared");
  });

  it("refuses a malformed draft before any request", async () => {
    const jira = syntheticJira();
    const result = await executeJiraChatDraft(
      execution(jira, { items: [item("a", { parent: { fieldId: "parent", ref: "a" } })] } as never),
    );
    expect(result).toEqual({
      data: {
        outcome: "rejected",
        reason: "field-validation",
        guidance:
          "Item 1 names itself as its parent or link target. Nothing was changed. Correct the draft and send it once.",
        items: [],
      },
      isError: true,
    });
    expect(jira.fetch).not.toHaveBeenCalled();
  });

  // Each refusal says what to change, so a model that sent a malformed draft corrects it in the
  // same turn instead of giving up (S09 of epic #4173).
  it.each([
    [{ items: [] }, "The draft needs items"],
    [
      { items: [item("a")], extra: 1 },
      "The draft takes an items array, or the draftId and draftDigest of a staged draft.",
    ],
    [{ items: [{ ...item("a"), parent: { fieldId: "parent" } }] }, "Item 1 has a malformed parent"],
    [
      { items: [item("a"), { ...item("b"), fields: { description: "no summary" } }] },
      "Item 2 needs fields with a non-empty summary",
    ],
    [{ items: [item("a"), item("a")] }, "Two items share a ref."],
    [
      { items: [item("sub", { parent: { fieldId: "parent", ref: "missing" } })] },
      "Item 1 names a ref that no item of this draft has.",
    ],
    [
      {
        items: [
          item("a", { parent: { fieldId: "parent", ref: "b" } }),
          item("b", { parent: { fieldId: "parent", ref: "a" } }),
        ],
      },
      "The parent and link relations form a cycle.",
    ],
  ])("tells the model how to correct a refused draft (%#)", async (args, sentence) => {
    const jira = syntheticJira();
    const result = await executeJiraChatDraft(execution(jira, args as never));
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({
      outcome: "rejected",
      reason: "field-validation",
      items: [],
    });
    const guidance = result.data.guidance;
    expect(typeof guidance === "string" && guidance.includes(sentence)).toBe(true);
    expect(
      typeof guidance === "string" &&
        guidance.endsWith("Nothing was changed. Correct the draft and send it once."),
    ).toBe(true);
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

describe("source traceability of a draft (#4179)", () => {
  const FOOTER =
    "----\nKeiko traceability\nRequirement: LH-001 · Anmeldung\nEnd of Keiko traceability";
  const TRACE = {
    labels: ["keiko-requirement", "keiko-doc-aaaaaaaa", "keiko-req-LH-001"],
    footer: FOOTER,
    footerStart: "----\nKeiko traceability",
    footerEnd: "End of Keiko traceability",
    replaceLabelPrefixes: ["keiko-rev-"],
  };
  const TRACED = {
    items: [
      item("epic", {
        fields: { summary: "[LH-001] Anmeldung", description: "Ziel" },
        requirementIds: ["aaaaaaaa:LH-001"],
      }),
      item("other", {
        fields: { summary: "Ohne Bezug", description: "Siehe LH-001 und keiko-req-LH-001." },
      }),
    ],
  } as unknown as CatalogJsonObject;

  function session(close: () => void): TraceSession {
    return {
      resolve: (references) =>
        references.includes("aaaaaaaa:LH-001")
          ? { ok: true, trace: TRACE }
          : {
              ok: false,
              reason: "references",
              problems: references.map((reference) => ({ reference, reason: "unknown" as const })),
            },
      close,
    };
  }

  it("creates an item with its explicit references with the footer and labels, and says so", async () => {
    const jira = syntheticJira();
    const close = vi.fn();

    const result = await executeJiraChatDraft({
      ...execution(jira, TRACED),
      openTrace: () => session(close),
    });

    expect(result.data, JSON.stringify(result.data)).toMatchObject({
      outcome: "succeeded",
      createdCount: 2,
    });
    const [traced, untraced] = jira.posts() as readonly { fields: Record<string, unknown> }[];
    expect(traced?.fields.description).toBe(`Ziel\n\n${FOOTER}`);
    expect(traced?.fields.labels).toEqual(
      expect.arrayContaining([...TRACE.labels, expect.stringMatching(/^keiko-draft-/u)]),
    );
    expect(itemsOf(result)[0]).toMatchObject({
      ref: "epic",
      trace: { labelsApplied: true, footerApplied: true, droppedLabels: [] },
    });
    expect(close).toHaveBeenCalledTimes(1);
    // A mention of a requirement in prose is not a reference: nothing is scraped.
    expect(untraced?.fields.description).toBe("Siehe LH-001 und keiko-req-LH-001.");
    expect(untraced?.fields.labels).toEqual([expect.stringMatching(/^keiko-draft-/u)]);
    expect(itemsOf(result)[1]).not.toHaveProperty("trace");
  });

  it("refuses the whole draft before anything is created when a reference does not resolve", async () => {
    const jira = syntheticJira();
    const close = vi.fn();
    const bad = {
      items: [
        item("good", { requirementIds: ["aaaaaaaa:LH-001"] }),
        item("bad", { requirementIds: ["LH-999"] }),
      ],
    } as unknown as CatalogJsonObject;

    const result = await executeJiraChatDraft({
      ...execution(jira, bad),
      openTrace: () => session(close),
    });

    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({
      outcome: "rejected",
      reason: "field-validation",
      requirementProblems: [{ ref: "bad", reference: "LH-999", reason: "unknown" }],
    });
    expect(jira.posts()).toHaveLength(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not let an unresolvable reference of a deselected item refuse the selected backlog", async () => {
    const jira = syntheticJira();
    const draft = {
      items: [
        item("good", { requirementIds: ["aaaaaaaa:LH-001"] }),
        item("removed", { requirementIds: ["LH-999"] }),
        item("child", {
          parent: { fieldId: "parent", ref: "removed" },
          requirementIds: ["LH-998"],
        }),
      ],
    } as unknown as CatalogJsonObject;

    const result = await executeJiraChatDraft({
      ...execution(jira, draft, ["removed"]),
      openTrace: () => session(vi.fn()),
    });

    expect(result.data, JSON.stringify(result.data)).toMatchObject({
      outcome: "succeeded",
      createdCount: 1,
      excludedCount: 2,
    });
    expect(jira.posts()).toHaveLength(1);
  });

  it("still refuses when an item that can run names an unknown reference", async () => {
    const jira = syntheticJira();
    const draft = {
      items: [item("removed"), item("kept", { requirementIds: ["LH-999"] })],
    } as unknown as CatalogJsonObject;

    const result = await executeJiraChatDraft({
      ...execution(jira, draft, ["removed"]),
      openTrace: () => session(vi.fn()),
    });

    expect(result.data).toMatchObject({ outcome: "rejected", requirementRefusal: "references" });
    expect(jira.posts()).toHaveLength(0);
  });

  it("refuses an item with references when the Knowledge Pods cannot be read", async () => {
    const jira = syntheticJira();

    const result = await executeJiraChatDraft(execution(jira, TRACED));

    expect(result.data).toMatchObject({ outcome: "rejected", requirementRefusal: "unavailable" });
    expect(jira.posts()).toHaveLength(0);
  });

  it("leaves a draft without references untouched and never opens the Pods", async () => {
    const jira = syntheticJira();
    const open = vi.fn(() => session(vi.fn()));

    await executeJiraChatDraft({ ...execution(jira), openTrace: open });

    expect(jira.posts()).toHaveLength(4);
    expect((jira.posts()[0] as { fields: Record<string, unknown> }).fields).not.toHaveProperty(
      "description",
    );
  });

  it("reconciles a re-run to the existing issue instead of tracing a second one", async () => {
    const jira = syntheticJira();
    const input = { ...execution(jira, TRACED), openTrace: (): TraceSession => session(vi.fn()) };

    await executeJiraChatDraft(input);
    await executeJiraChatDraft(input);

    expect(jira.posts()).toHaveLength(2);
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

describe("the draft connection carries the customer's issue templates (#4177)", () => {
  function connectionWith(...frontMatter: readonly string[]): JiraChatDraftExecution["connection"] {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    const store = buildUiStoreOverDatabase(db);
    cleanup.push(() => {
      store.close();
    });
    store.markdownSkills.import({
      fileName: "story-template.md",
      contentBase64: Buffer.from(
        [
          "---",
          "keiko: jira-issue-template",
          "version: 1",
          "project: SYN",
          "issueType: Story",
          "activateOn: [create]",
          ...frontMatter,
          "---",
          "# Story",
        ].join("\n"),
      ).toString("base64"),
    });
    return jiraChatDraftConnection({ store }, { baseUrl: BASE_URL, deployment: "data-center" });
  }

  it("refuses a violating item and never POSTs it", async () => {
    const jira = syntheticJira();
    const connection = connectionWith("summaryMinLength: 40");
    const result = await executeJiraChatDraft({ ...execution(jira), connection });
    expect(jira.posts()).toEqual([]);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.data)).toContain("summary-too-short");
  });

  it("still creates the items of a draft the template accepts", async () => {
    const jira = syntheticJira();
    const connection = connectionWith("summaryMinLength: 3");
    const result = await executeJiraChatDraft({ ...execution(jira), connection });
    expect(jira.posts()).toHaveLength(4);
    expect(result.isError).toBeUndefined();
  });
});
