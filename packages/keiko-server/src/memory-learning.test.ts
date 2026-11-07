// #4213: learning runs later, in passes, from the Chat's own stored messages. Real UiStore, real
// vault, a fake model port that answers the salience call the way a model following the production
// prompt would. No network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { CodingWorkbenchMode, NormalizedResponse } from "@oscharko-dev/keiko-contracts";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore, createNodeUiStore, type UiStore } from "./store/index.js";
import { runSerializedChatTurn } from "./chat-turn-serializer.js";
import { conversationMemoryScopes } from "./memory-conversation-context.js";
import {
  disposeMemoryLearningRuntime,
  memoryLearningRuntime,
  planLearningTurns,
} from "./memory-learning.js";
import type { PendingLearningMessage } from "./store/chatMemoryLearning.js";
import { forgetStatementNotLearned } from "./memory-handlers.js";
import { learnStoredTurn } from "./memory-salience.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";

const USER_SAID = "User said:\n";

// A plain Chat message: no workflow run is attached to it.
const NO_RUN = {
  runId: undefined,
  workflowId: undefined,
  workflowStatus: undefined,
  shortResult: undefined,
  taskType: undefined,
} as const;

function salienceAnswer(content: string): string {
  const start = content.lastIndexOf(USER_SAID);
  const said = start === -1 ? "" : content.slice(start + USER_SAID.length);
  const facts = said
    .split(/(?<=[.!?])\s+/u)
    .filter((sentence) => sentence.startsWith("I "))
    .map((fact) => ({
      body: fact,
      evidence: fact,
      about: "self",
      type: "fact",
      relation: "new",
      related: null,
    }));
  return JSON.stringify({ items: facts });
}

function response(modelId: string, content: string): NormalizedResponse {
  return {
    modelId,
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "learning-test",
      promptTokens: 7,
      completionTokens: 3,
      latencyMs: 11,
      costClass: "high",
    },
  };
}

interface FakeLearner {
  readonly port: ModelPort;
  readonly calls: () => number;
}

function fakeLearner(): FakeLearner {
  let calls = 0;
  return {
    port: {
      call(request): Promise<NormalizedResponse> {
        calls += 1;
        const user = request.messages.at(-1)?.content ?? "";
        return Promise.resolve(
          response(request.modelId, salienceAnswer(typeof user === "string" ? user : "")),
        );
      },
    },
    calls: () => calls,
  };
}

let dirs: string[] = [];
let vaults: MemoryVaultStore[] = [];
let stores: UiStore[] = [];

beforeEach(() => {
  dirs = [];
  vaults = [];
  stores = [];
});

afterEach(() => {
  vi.useRealTimers();
  resetServerLogger();
  for (const store of stores) disposeMemoryLearningRuntime({ store });
  for (const vault of vaults) vault.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  dirs.push(dir);
  return dir;
}

function makeVault(dir = tempDir("keiko-learning-vault-")): MemoryVaultStore {
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  vaults.push(vault);
  return vault;
}

function makeDeps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  const store = overrides.store ?? createInMemoryUiStore();
  stores.push(store);
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => fakeLearner().port,
    memoryVault: makeVault(),
    ...overrides,
    store,
  };
}

interface ChatFixture {
  readonly chatId: string;
  readonly projectPath: string;
}

function makeChat(deps: UiHandlerDeps): ChatFixture {
  const projectPath = tempDir("keiko-learning-project-");
  deps.store.createProject(projectPath);
  const chat = deps.store.createChat(projectPath, "Learning", "gpt-test");
  return { chatId: chat.id, projectPath };
}

let clock = 1_700_000_000_000;

// A committed turn, as the Chat writes it: the person's message, the answer, and the mark the turn
// leaves when memory was on.
function writeTurn(
  deps: UiHandlerDeps,
  chat: ChatFixture,
  text: string,
  memoryOn = true,
  mode?: CodingWorkbenchMode,
): { readonly userId: string; readonly assistantId: string } {
  clock += 1_000;
  const user = deps.store.createMessage({
    ...NO_RUN,
    chatId: chat.chatId,
    role: "user",
    content: text,
    timestamp: clock,
  });
  const assistant = deps.store.createMessage({
    ...NO_RUN,
    chatId: chat.chatId,
    role: "assistant",
    content: "Noted.",
    timestamp: clock + 1,
  });
  if (memoryOn) {
    memoryLearningRuntime(deps).noteTurn(
      { messageId: user.id, surface: "desktop", ...(mode === undefined ? {} : { mode }) },
      assistant.id,
    );
  }
  return { userId: user.id, assistantId: assistant.id };
}

function vaultOf(deps: UiHandlerDeps): MemoryVaultStore {
  if (deps.memoryVault === undefined) throw new Error("memory vault missing");
  return deps.memoryVault;
}

function learned(
  deps: UiHandlerDeps,
  chat: ChatFixture,
  status: readonly MemoryRecord["status"][] = ["accepted", "proposed"],
): readonly MemoryRecord[] {
  const vault = vaultOf(deps);
  const byId = new Map<string, MemoryRecord>();
  for (const scope of conversationMemoryScopes({
    userId: "local-operator" as never,
    workspaceId: chat.projectPath as never,
    projectId: chat.projectPath as never,
    conversationId: chat.chatId as never,
  })) {
    for (const record of vault.listMemoriesByScope(scope, { status, includeExpired: true })) {
      byId.set(String(record.id), record);
    }
  }
  return [...byId.values()];
}

function bodies(deps: UiHandlerDeps, chat: ChatFixture): readonly string[] {
  return learned(deps, chat)
    .map((record) => record.body)
    .sort();
}

describe("planLearningTurns", () => {
  const row = (id: string, role: string, position: number): PendingLearningMessage => ({
    id,
    role,
    content: id,
    position: { timestamp: position, rowid: position },
    mark: { surface: "desktop" },
  });

  it("pairs each message with its answers and learns an unanswered last message", () => {
    const plan = planLearningTurns(
      [
        row("s", "system", 1),
        row("u1", "user", 2),
        row("a1", "assistant", 3),
        row("u2", "user", 4),
        row("u3", "user", 5),
        row("a3", "assistant", 6),
        row("u4", "user", 7),
      ],
      false,
    );
    expect(plan.leadingEnd).toEqual({ timestamp: 1, rowid: 1 });
    expect(
      plan.turns.map((turn) => [turn.user.id, turn.assistantText, turn.correlationId]),
    ).toEqual([
      ["u1", "a1", "a1"],
      ["u2", "", "u2"],
      ["u3", "a3", "a3"],
      ["u4", "", "u4"],
    ]);
    expect(plan.turns.at(-1)?.end).toEqual({ timestamp: 7, rowid: 7 });
  });

  it("waits for the next page only for a full page's last turn, never for a whole page", () => {
    const full = planLearningTurns(
      [row("u1", "user", 1), row("a1", "assistant", 2), row("u2", "user", 3)],
      true,
    );
    expect(full.turns.map((turn) => turn.user.id)).toEqual(["u1"]);
    const plan = planLearningTurns([row("u1", "user", 1), row("s1", "system", 2)], true);
    expect(plan.turns.map((turn) => turn.user.id)).toEqual(["u1"]);
  });
});

describe("chat memory learning store", () => {
  it("keeps the position monotonic and drops a deleted Chat with its messages", () => {
    const deps = makeDeps();
    const chat = makeChat(deps);
    const store = deps.store.memoryLearning;
    if (store === undefined) throw new Error("learning store missing");
    const first = writeTurn(deps, chat, "I use Vim.");
    writeTurn(deps, chat, "I live in Hamburg.");
    expect(store.listChatsWithPending(8)).toEqual([chat.chatId]);
    const pending = store.listPending(chat.chatId, 64);
    expect(pending.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(pending[0]?.mark).toEqual({ surface: "desktop" });
    const later = pending[3]?.position;
    const earlier = pending[1]?.position;
    if (later === undefined || earlier === undefined) throw new Error("positions missing");
    store.advance(chat.chatId, later);
    store.advance(chat.chatId, earlier);
    expect(store.readPosition(chat.chatId)).toEqual(later);
    expect(store.listChatsWithPending(8)).toEqual([]);
    expect(store.markMessage("no-such-message", { surface: "voice" })).toBe(false);
    expect(store.markMessage(first.userId, { surface: "voice" })).toBe(true);
    deps.store.deleteChat(chat.chatId);
    expect(store.readPosition(chat.chatId)).toBeUndefined();
    expect(store.listPending(chat.chatId, 64)).toEqual([]);
  });
});

describe("memory learning passes", () => {
  it("learns nothing at message time and the stated fact after the pause", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const learner = fakeLearner();
    const deps = makeDeps({ modelPortFactory: () => learner.port });
    const chat = makeChat(deps);
    writeTurn(deps, chat, "I write Atlas in Rust.");
    expect(learner.calls()).toBe(0);
    expect(bodies(deps, chat)).toEqual([]);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(learner.calls()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => {
      expect(bodies(deps, chat)).toEqual(["I write Atlas in Rust."]);
    });
    expect(learner.calls()).toBe(1);
    expect(deps.store.memoryLearning?.listChatsWithPending(8)).toEqual([]);
  });

  it("learns what was said in one Chat when the person opens another", async () => {
    const deps = makeDeps({ env: { KEIKO_MEMORY_LEARNING_IDLE_MS: "3600000" } });
    const first = makeChat(deps);
    const runtime = memoryLearningRuntime(deps);
    runtime.noteChatOpened(first.chatId, undefined);
    writeTurn(deps, first, "I prefer tables for numbers.");
    runtime.noteChatOpened(first.chatId, undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bodies(deps, first)).toEqual([]);
    runtime.noteChatOpened("another-chat", undefined);
    // A Chat change waits a second, so a quick switch back and forth starts no pass.
    await vi.waitFor(
      () => {
        expect(bodies(deps, first)).toEqual(["I prefer tables for numbers."]);
      },
      { timeout: 5_000 },
    );
  });

  it("never learns a turn written with memory off, even after memory is switched on", async () => {
    const learner = fakeLearner();
    const deps = makeDeps({ modelPortFactory: () => learner.port });
    const chat = makeChat(deps);
    writeTurn(deps, chat, "I live in Hamburg.", false);
    writeTurn(deps, chat, "I use Vim.");
    await expect(memoryLearningRuntime(deps).runPass("inactivity", undefined)).resolves.toBe(
      "completed",
    );
    expect(bodies(deps, chat)).toEqual(["I use Vim."]);
    expect(learner.calls()).toBe(1);
    // A later pass does not return to the unmarked turn.
    writeTurn(deps, chat, "I drink tea.");
    await memoryLearningRuntime(deps).runPass("inactivity", undefined);
    expect(bodies(deps, chat)).toEqual(["I drink tea.", "I use Vim."]);
  });

  it("cancels a running pass for new Chat work and aborts the provider request", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const signals: AbortSignal[] = [];
    const slow: ModelPort = {
      call(_request, signal): Promise<NormalizedResponse> {
        signals.push(signal);
        return new Promise<NormalizedResponse>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
      },
    };
    const deps = makeDeps({ modelPortFactory: () => slow });
    const chat = makeChat(deps);
    writeTurn(deps, chat, "I write Atlas in Rust.");
    const pass = memoryLearningRuntime(deps).runPass("inactivity", undefined);
    await vi.waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    const startedAt = performance.now();
    const turn = runSerializedChatTurn(deps, chat.chatId, new AbortController().signal, () => "ok");
    expect(signals[0]?.aborted).toBe(true);
    await expect(pass).resolves.toBe("cancelled");
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    await expect(turn).resolves.toBe("ok");
    // Nothing was learned and the turn is still pending for the next pass.
    expect(bodies(deps, chat)).toEqual([]);
    expect(deps.store.memoryLearning?.listChatsWithPending(8)).toEqual([chat.chatId]);
    const settled = sink.events.find((event) => event.op === "memory.learn.pass.settled");
    expect(settled?.extra).toMatchObject({ outcome: "cancelled", pendingChatCount: 1 });
    expect(settled?.extra?.cancelLatencyMs).toEqual(expect.any(Number));
  });

  it("records a pass's start and end under its own id, linked to what triggered it", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const learner = fakeLearner();
    const deps = makeDeps({ modelPortFactory: () => learner.port });
    const chat = makeChat(deps);
    writeTurn(deps, chat, "I write Atlas in Rust.");
    await expect(
      memoryLearningRuntime(deps).runPass("chat-change", "request-correlation"),
    ).resolves.toBe("completed");
    const started = sink.events.find((event) => event.op === "memory.learn.pass.started");
    const settled = sink.events.find((event) => event.op === "memory.learn.pass.settled");
    if (started === undefined || settled === undefined) throw new Error("expected pass lines");
    expect(
      expectActivityLogProof("memory.learn.pass.started.line", formatActivityLogProofLine(started)),
    ).toMatchObject({ trigger: "chat-change", chatCount: 1 });
    expect(
      expectActivityLogProof("memory.learn.pass.settled.line", formatActivityLogProofLine(settled)),
    ).toMatchObject({
      trigger: "chat-change",
      outcome: "completed",
      chatCount: 1,
      turnCount: 1,
      learnedTurnCount: 1,
      pendingChatCount: 0,
    });
    expect(settled.correlationId).toBe(started.correlationId);
    expect(started.parentCorrelationId).toBe("request-correlation");
    // Neither the person's words nor the learned fact enters the log.
    expect(JSON.stringify(sink.events)).not.toContain("Atlas");
  });

  it("never hands capture the text of an attached document", async () => {
    const prompts: string[] = [];
    const learner = fakeLearner();
    const recording: ModelPort = {
      call(request, signal): Promise<NormalizedResponse> {
        prompts.push(JSON.stringify(request.messages));
        return learner.port.call(request, signal);
      },
    };
    const deps = makeDeps({ modelPortFactory: () => recording });
    const chat = makeChat(deps);
    clock += 1_000;
    const user = deps.store.createMessage({
      ...NO_RUN,
      chatId: chat.chatId,
      role: "user",
      content: "I write Atlas in Rust.",
      timestamp: clock,
      documentContext: [
        {
          id: "doc-1",
          displayName: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 64,
          extractedBytes: 64,
          truncated: false,
          text: "I live in Lisbon. The attachment owner prefers Go.",
        },
      ],
    });
    const assistant = deps.store.createMessage({
      ...NO_RUN,
      chatId: chat.chatId,
      role: "assistant",
      content: "Noted.",
      timestamp: clock + 1,
    });
    memoryLearningRuntime(deps).noteTurn({ messageId: user.id, surface: "desktop" }, assistant.id);
    await expect(memoryLearningRuntime(deps).runPass("inactivity", undefined)).resolves.toBe(
      "completed",
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("Lisbon");
    expect(prompts[0]).not.toContain("attachment owner");
    expect(bodies(deps, chat)).toEqual(["I write Atlas in Rust."]);
  });

  it("learns dictated words like typed words and never the spoken answer", async () => {
    // The answer claims a fact in the first person; a model that proposes it is still refused,
    // because a learned fact must stand verbatim in the person's own words.
    const answer = "I live in Munich.";
    const fromAnswer: ModelPort = {
      call(request): Promise<NormalizedResponse> {
        const said = request.messages.at(-1)?.content;
        const own = JSON.parse(salienceAnswer(typeof said === "string" ? said : "")) as {
          readonly items: readonly Record<string, unknown>[];
        };
        const claimed = { ...own.items[0], body: answer, evidence: answer };
        return Promise.resolve(
          response(request.modelId, JSON.stringify({ items: [...own.items, claimed] })),
        );
      },
    };
    const deps = makeDeps({ modelPortFactory: () => fromAnswer });
    const chat = makeChat(deps);
    clock += 1_000;
    const user = deps.store.createMessage({
      ...NO_RUN,
      chatId: chat.chatId,
      role: "user",
      content: "I write Atlas in Rust.",
      timestamp: clock,
    });
    const assistant = deps.store.createMessage({
      ...NO_RUN,
      chatId: chat.chatId,
      role: "assistant",
      content: answer,
      timestamp: clock + 1,
    });
    memoryLearningRuntime(deps).noteTurn({ messageId: user.id, surface: "voice" }, assistant.id);
    await memoryLearningRuntime(deps).runPass("inactivity", undefined);
    const records = learned(deps, chat);
    expect(records.map((record) => record.body)).toEqual(["I write Atlas in Rust."]);
    expect(records[0]?.provenance.sourceMessageIds).toEqual([user.id]);
  });

  // Chat messages are never edited in place: a corrected statement is the person's next turn. It
  // replaces the learned fact through the ordinary supersession rules, whether the earlier turn was
  // learned already or is learned in the same pass. In Full access the replacement is made at once;
  // in Ask for approval it waits as a proposal beside the fact it would replace.
  it.each([
    ["after the first statement was learned", true, "autonomous-delivery", "accepted"],
    ["while both statements were still pending", false, "autonomous-delivery", "accepted"],
    ["as a proposal when the person asks for approval", true, "governed-assist", "proposed"],
  ] as const)("replaces a corrected fact %s", async (_name, learnBetween, mode, status) => {
    const deps = makeDeps({ codingRuntimeDeploymentCeiling: "autonomous-delivery" });
    const chat = makeChat(deps);
    const runtime = memoryLearningRuntime(deps);
    writeTurn(deps, chat, "I use PostgreSQL 14.", true, mode);
    if (learnBetween) await runtime.runPass("inactivity", undefined);
    writeTurn(deps, chat, "I use PostgreSQL 16.", true, mode);
    await runtime.runPass("inactivity", undefined);
    const byStatus = (wanted: MemoryRecord["status"]): readonly string[] =>
      learned(deps, chat, [wanted]).map((record) => record.body);
    expect(byStatus(status)).toContain("I use PostgreSQL 16.");
    if (status === "accepted") {
      expect(byStatus("accepted")).toEqual(["I use PostgreSQL 16."]);
      expect(byStatus("superseded")).toEqual(["I use PostgreSQL 14."]);
    } else {
      // Nothing is replaced before the person approves: the earlier fact still stands.
      expect(bodies(deps, chat)).toEqual(["I use PostgreSQL 14.", "I use PostgreSQL 16."]);
      expect(byStatus("superseded")).toEqual([]);
    }
  });

  it("reports a failing pass, frees the runtime and retries later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const deps = makeDeps({ env: { KEIKO_MEMORY_LEARNING_IDLE_MS: "3600000" } });
    const chat = makeChat(deps);
    writeTurn(deps, chat, "I write Atlas in Rust.");
    const store = deps.store.memoryLearning;
    if (store === undefined) throw new Error("learning store missing");
    const listPending = store.listPending;
    let broken = true;
    Object.assign(store, {
      listPending: (chatId: string, limit: number) => {
        if (broken) throw new Error("database is locked");
        return listPending(chatId, limit);
      },
    });
    const runtime = memoryLearningRuntime(deps);
    await expect(runtime.runPass("inactivity", undefined)).resolves.toBe("failed");
    const settled = sink.events.find((event) => event.op === "memory.learn.pass.settled");
    expect(settled?.extra).toMatchObject({ outcome: "failed" });
    broken = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(bodies(deps, chat)).toEqual(["I write Atlas in Rust."]);
    });
  });

  it("learns a turn whose answer was lost and does not loop on it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const learner = fakeLearner();
    const deps = makeDeps({
      modelPortFactory: () => learner.port,
      env: { KEIKO_MEMORY_LEARNING_IDLE_MS: "3600000" },
    });
    const chat = makeChat(deps);
    clock += 1_000;
    const user = deps.store.createMessage({
      ...NO_RUN,
      chatId: chat.chatId,
      role: "user",
      content: "I write Atlas in Rust.",
      timestamp: clock,
    });
    memoryLearningRuntime(deps).noteTurn({ messageId: user.id, surface: "desktop" }, user.id);
    await memoryLearningRuntime(deps).runPass("inactivity", undefined);
    expect(bodies(deps, chat)).toEqual(["I write Atlas in Rust."]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(learner.calls()).toBe(1);
    expect(deps.store.memoryLearning?.listChatsWithPending(8)).toEqual([]);
  });

  it("adds nothing when a stopped pass learns the same message again", async () => {
    const deps = makeDeps();
    const chat = makeChat(deps);
    const turn = writeTurn(deps, chat, "I write Atlas in Rust.");
    await memoryLearningRuntime(deps).runPass("inactivity", undefined);
    const [record] = learned(deps, chat);
    if (record === undefined) throw new Error("expected the learned fact");
    const before = vaultOf(deps).getAccessStats([record.id]).get(record.id);
    // As if Keiko stopped after the vault write and before the Chat's position moved.
    const again = await learnStoredTurn(
      deps,
      {
        request: {
          content: "I write Atlas in Rust.",
          sourceMessageId: turn.userId,
          memory: { enabled: true },
        },
        context: {
          userId: "local-operator" as never,
          workspaceId: chat.projectPath as never,
          projectId: chat.projectPath as never,
          conversationId: chat.chatId as never,
        },
        modelId: "gpt-test",
        assistantText: "Noted.",
        surface: "desktop",
        correlationId: turn.assistantId,
        parentCorrelationId: turn.assistantId,
      },
      new AbortController().signal,
    );
    expect(again.outcome).toBe("learned");
    expect(bodies(deps, chat)).toEqual(["I write Atlas in Rust."]);
    expect(vaultOf(deps).getAccessStats([record.id]).get(record.id)).toEqual(before);
  });

  it("does not start while an answer runs", async () => {
    const learner = fakeLearner();
    const deps = makeDeps({ modelPortFactory: () => learner.port });
    const chat = makeChat(deps);
    writeTurn(deps, chat, "I write Atlas in Rust.");
    let release!: () => void;
    const answering = runSerializedChatTurn(
      deps,
      chat.chatId,
      new AbortController().signal,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(memoryLearningRuntime(deps).runPass("inactivity", undefined)).resolves.toBe(
      undefined,
    );
    expect(learner.calls()).toBe(0);
    release();
    await answering;
  });

  it("neither loses nor duplicates learning across a restart", async () => {
    const storeDir = tempDir("keiko-learning-store-");
    const vaultDir = tempDir("keiko-learning-vault-");
    const openStore = (): UiStore => createNodeUiStore(join(storeDir, "ui.db"));
    let store = openStore();
    const vault = makeVault(vaultDir);
    let calls = 0;
    // The first start dies while learning the second turn.
    const dying: ModelPort = {
      call(request, signal): Promise<NormalizedResponse> {
        calls += 1;
        if (calls === 2) {
          return new Promise<NormalizedResponse>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new Error("stopped"));
            });
          });
        }
        return fakeLearner().port.call(request, signal);
      },
    };
    let deps = makeDeps({ store, memoryVault: vault, modelPortFactory: () => dying });
    const chat = makeChat(deps);
    writeTurn(deps, chat, "I write Atlas in Rust.");
    writeTurn(deps, chat, "I live in Hamburg.");
    writeTurn(deps, chat, "I drink tea.");
    const pass = memoryLearningRuntime(deps).runPass("inactivity", undefined);
    await vi.waitFor(() => {
      expect(calls).toBe(2);
    });
    disposeMemoryLearningRuntime(deps);
    await pass;
    store.close();
    expect(bodies(deps, chat)).toEqual(["I write Atlas in Rust."]);

    store = openStore();
    deps = makeDeps({ store, memoryVault: vault });
    // The restart learns the leftover once, without the first fact twice.
    memoryLearningRuntime(deps).start();
    await vi.waitFor(
      () => {
        expect(bodies(deps, chat)).toEqual([
          "I drink tea.",
          "I live in Hamburg.",
          "I write Atlas in Rust.",
        ]);
      },
      { timeout: 10_000 },
    );
    expect(learned(deps, chat)).toHaveLength(3);
    store.close();
  });

  it("learns nothing from a deleted Chat", async () => {
    const learner = fakeLearner();
    const deps = makeDeps({ modelPortFactory: () => learner.port });
    const chat = makeChat(deps);
    writeTurn(deps, chat, "I write Atlas in Rust.");
    deps.store.deleteChat(chat.chatId);
    await expect(memoryLearningRuntime(deps).runPass("inactivity", undefined)).resolves.toBe(
      undefined,
    );
    expect(learner.calls()).toBe(0);
  });

  it("keeps the work pending without an error while the model is unavailable", async () => {
    let available = false;
    const learner = fakeLearner();
    const deps = makeDeps({ modelPortFactory: () => (available ? learner.port : undefined) });
    const chat = makeChat(deps);
    writeTurn(deps, chat, "I write Atlas in Rust.");
    await expect(memoryLearningRuntime(deps).runPass("inactivity", undefined)).resolves.toBe(
      "unavailable",
    );
    expect(deps.store.memoryLearning?.listChatsWithPending(8)).toEqual([chat.chatId]);
    available = true;
    await expect(memoryLearningRuntime(deps).runPass("retry", undefined)).resolves.toBe(
      "completed",
    );
    expect(bodies(deps, chat)).toEqual(["I write Atlas in Rust."]);
  });

  it("applies a forget to what was still waiting to be learned", async () => {
    const deps = makeDeps();
    const chat = makeChat(deps);
    writeTurn(deps, chat, "I live in Hamburg.");
    writeTurn(deps, chat, "I write Atlas in Rust.");
    // The person asked while nothing was learned yet: nothing matched then.
    writeTurn(deps, chat, "Forget that I live in Hamburg.");
    await memoryLearningRuntime(deps).runPass("inactivity", undefined);
    expect(bodies(deps, chat)).toEqual(["I write Atlas in Rust."]);
  });

  it("keeps a statement forgotten by reference from being learned", async () => {
    const deps = makeDeps();
    const chat = makeChat(deps);
    writeTurn(deps, chat, "I live in Hamburg.");
    // "Vergiss das" leaves its forget record for the previous statement at message time.
    await forgetStatementNotLearned(
      deps,
      vaultOf(deps),
      "I live in Hamburg.",
      conversationMemoryScopes({
        userId: "local-operator" as never,
        workspaceId: chat.projectPath as never,
        projectId: chat.projectPath as never,
        conversationId: chat.chatId as never,
      }),
      "forget-correlation",
    );
    writeTurn(deps, chat, "Vergiss das.");
    await memoryLearningRuntime(deps).runPass("inactivity", undefined);
    expect(bodies(deps, chat)).toEqual([]);
  });
});
