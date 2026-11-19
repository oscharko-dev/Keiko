import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryVault } from "@oscharko-dev/keiko-memory-vault";
import type { MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { collectMemoryActions, type SendDesktopChatRequest } from "./chat-handlers.js";
import type { ConversationMemoryRuntimeContext } from "./memory-conversation-context.js";
import { createInMemoryUiStore } from "./store/index.js";
import { previousUserMessageReader } from "./memory-explicit-statements.js";

const NO_RUN = {
  runId: undefined,
  workflowId: undefined,
  workflowStatus: undefined,
  shortResult: undefined,
  taskType: undefined,
} as const;

const dispose: (() => void)[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const close of dispose.splice(0).reverse()) close();
});

function fixture(): {
  readonly deps: UiHandlerDeps;
  readonly context: ConversationMemoryRuntimeContext;
  readonly request: (content: string) => SendDesktopChatRequest;
} {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-explicit-previous-"));
  dispose.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const vault = createMemoryVault({
    memoryDir: join(root, "memory"),
    redactString: (value) => value,
  });
  dispose.push(() => {
    vault.close();
  });
  const store = createInMemoryUiStore();
  dispose.push(() => {
    store.close();
  });
  store.createProject(root);
  const chat = store.createChat(root, "Synthetic", "local-model");
  const context = {
    userId: "local-operator",
    workspaceId: root,
    projectId: root,
    conversationId: chat.id,
  } as ConversationMemoryRuntimeContext;
  const deps: UiHandlerDeps = {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    memoryVault: vault,
    store,
  };
  return {
    deps,
    context,
    request: (content) => ({
      chatId: chat.id,
      projectPath: root,
      content,
      modelId: undefined,
      memory: { enabled: true, context: {} },
      documentContext: [],
      attachments: [],
      discussionMode: undefined,
    }),
  };
}

function sourceFact(context: ConversationMemoryRuntimeContext, messageId: string): MemoryRecord {
  return {
    schemaVersion: "1",
    id: "synthetic-source-fact" as MemoryRecord["id"],
    type: "semantic-fact",
    status: "accepted",
    scope: { kind: "user", userId: context.userId },
    body: "I use Vim.",
    payload: { kind: "string-list", items: ["I use Vim."] },
    provenance: {
      sourceKind: "system-default",
      sourceConversationId: context.conversationId,
      sourceMessageIds: [messageId],
      evidenceSpan: "I use Vim.",
      capturedAt: 100,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: 100 },
    createdAt: 100,
    updatedAt: 100,
    tags: [],
    pinned: false,
  };
}

describe("bounded foreground forget predecessor", () => {
  it.each([false, true])(
    "reads no full history when the current message was already stored: %s",
    async (admitted) => {
      const { deps, context, request } = fixture();
      const user = deps.store.createMessage({
        ...NO_RUN,
        chatId: context.conversationId,
        role: "user",
        content: "I use Vim.",
        timestamp: 100,
      });
      // This unmarked source must remain erasable by its person's explicit statement.
      const fact = sourceFact(context, user.id);
      deps.memoryVault?.insertMemory(fact);
      deps.store.createMessages(
        Array.from({ length: 10_000 }, () => ({
          ...NO_RUN,
          chatId: context.conversationId,
          role: "assistant",
          content: "A synthetic answer.",
          timestamp: 101,
        })),
      );
      if (admitted) {
        deps.store.createMessage({
          ...NO_RUN,
          chatId: context.conversationId,
          role: "user",
          content: "Please forget that.",
          timestamp: 102,
        });
      }
      const history = vi.spyOn(deps.store, "listMessages");
      const learning = deps.store.memoryLearning;
      if (learning === undefined) throw new Error("expected the learning store");
      const bounded = vi.spyOn(learning, "readPreviousUserMessage");
      const actions = await collectMemoryActions(deps, request("Please forget that."), context);
      expect(actions).toEqual([
        { kind: "forget", memoryId: fact.id, requiresConfirmation: false, forgotten: true },
      ]);
      expect(deps.memoryVault?.getMemory(fact.id)).toBeUndefined();
      expect(history).not.toHaveBeenCalled();
      expect(bounded).toHaveBeenCalledExactlyOnceWith(
        context.conversationId,
        "Please forget that.",
      );
    },
  );

  it("reuses one missing snapshot and rechecks a later decision after additions, edits and deletion", () => {
    const { deps, context } = fixture();
    const learning = deps.store.memoryLearning;
    if (learning === undefined) throw new Error("expected the learning store");
    let available: ReturnType<typeof learning.readPreviousUserMessage>;
    const reads = vi.spyOn(learning, "readPreviousUserMessage").mockImplementation(() => available);
    const first = previousUserMessageReader(deps, "Please forget that.", context.conversationId);
    expect(first()).toBeUndefined();
    expect(first()).toBeUndefined();
    expect(reads).toHaveBeenCalledTimes(1);
    const user = { id: "snapshot-user", content: "I use Vim.", timestamp: 100 };
    available = user;
    expect(first()).toBeUndefined();
    const next = previousUserMessageReader(deps, "Please forget that.", context.conversationId);
    expect(next()).toMatchObject({ id: user.id, content: "I use Vim.", timestamp: 100 });
    available = { ...user, content: "I use Emacs." };
    expect(next()).toMatchObject({ content: "I use Vim." });
    expect(
      previousUserMessageReader(deps, "Please forget that.", context.conversationId)(),
    ).toMatchObject({ id: user.id, content: "I use Emacs.", timestamp: 100 });
    available = undefined;
    expect(
      previousUserMessageReader(deps, "Please forget that.", context.conversationId)(),
    ).toBeUndefined();
    expect(reads).toHaveBeenCalledTimes(4);
  });

  it("does not read a predecessor for an ordinary self-contained request", async () => {
    const { deps, context, request } = fixture();
    const learning = deps.store.memoryLearning;
    if (learning === undefined) throw new Error("expected the learning store");
    const bounded = vi.spyOn(learning, "readPreviousUserMessage");
    const history = vi.spyOn(deps.store, "listMessages");
    expect(await collectMemoryActions(deps, request("What is two plus two?"), context)).toEqual([]);
    expect(bounded).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  it("uses the same bounded snapshot for an unlearned statement's forget fallback", async () => {
    const { deps, context, request } = fixture();
    deps.store.createMessage({
      ...NO_RUN,
      chatId: context.conversationId,
      role: "user",
      content: "I use Vim.",
      timestamp: 100,
    });
    const learning = deps.store.memoryLearning;
    if (learning === undefined) throw new Error("expected the learning store");
    const bounded = vi.spyOn(learning, "readPreviousUserMessage");
    const history = vi.spyOn(deps.store, "listMessages");
    expect(await collectMemoryActions(deps, request("Please forget that."), context)).toEqual([
      expect.objectContaining({ kind: "forget", forgotten: true, requiresConfirmation: false }),
    ]);
    expect(bounded).toHaveBeenCalledTimes(1);
    expect(history).not.toHaveBeenCalled();
  });

  it("resolves a legacy store without learning support only once", async () => {
    const { deps, context, request } = fixture();
    deps.store.createMessage({
      ...NO_RUN,
      chatId: context.conversationId,
      role: "user",
      content: "I use Vim.",
      timestamp: 100,
    });
    const { memoryLearning, ...legacyStore } = deps.store;
    expect(memoryLearning).toBeDefined();
    const history = vi.spyOn(legacyStore, "listMessages");
    const legacy = { ...deps, store: legacyStore };
    expect(await collectMemoryActions(legacy, request("Please forget that."), context)).toEqual([
      expect.objectContaining({ kind: "forget", forgotten: true }),
    ]);
    expect(history).toHaveBeenCalledTimes(1);
  });
});
