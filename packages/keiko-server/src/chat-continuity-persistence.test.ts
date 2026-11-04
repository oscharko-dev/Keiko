import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextCompactionRecord } from "@oscharko-dev/keiko-contracts";
import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  deriveContextProfile,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { createInMemoryEvidenceStore, type EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import { redactContent } from "@oscharko-dev/keiko-security";
import {
  createInMemoryUiStore,
  createNodeUiStore,
  openNodeUiDatabase,
  type ChatMessage,
  type NewChatMessage,
  type UiStore,
  type UiStoreFactoryOptions,
} from "./store/index.js";
import type { UiHandlerDeps } from "./deps.js";
import { loadHistoryCheckpoint, captureChatHistory } from "./chat-history-snapshot.js";
import {
  enrichChatCompactionWithModelSummary,
  type ChatCompactionModelSummaryInput,
} from "./chat-compaction-model-summary.js";
import { persistChatCompactionEvidence } from "./chat-compaction-evidence.js";
import { compactChatContext } from "./chat-context-status.js";
import { persistRequiredChatContinuityCheckpoint } from "./chat-continuity-checkpoint.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";

const MODEL = "continuity-persistence-fixture";
const SUMMARY = "The approved owner is Mira and the corrected budget is 8100 euros.";
const cleanups: (() => void)[] = [];
afterEach(() => {
  resetServerLogger();
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => {
      cleanup();
    });
});

function modelResponse(): NormalizedResponse {
  return {
    modelId: MODEL,
    content: SUMMARY,
    finishReason: "stop",
    structuredOutput: null,
    toolCalls: [],
    usage: {
      requestId: "summary-fixture",
      promptTokens: 10,
      completionTokens: 10,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

interface PersistenceFixture {
  readonly deps: UiHandlerDeps;
  readonly store: UiStore;
  readonly evidenceStore: EvidenceStore;
  readonly chatId: string;
  readonly projectPath: string;
  readonly databasePath: string;
  readonly draft: (
    role: "user" | "assistant",
    content: string,
    timestamp: number,
  ) => NewChatMessage;
  readonly input: ChatCompactionModelSummaryInput & {
    readonly compaction: ContextCompactionRecord & {
      readonly conversationCoverage: NonNullable<ContextCompactionRecord["conversationCoverage"]>;
    };
    readonly historyPrefix: readonly [ChatMessage, ChatMessage];
  };
  readonly reopen: () => UiStore;
}

function fixture(persistent = false, options?: UiStoreFactoryOptions): PersistenceFixture {
  const path = mkdtempSync(join(tmpdir(), "keiko-continuity-persistence-"));
  const projectPath = join(path, "workspace");
  mkdirSync(projectPath);
  let store = persistent
    ? createNodeUiStore(join(path, "ui.sqlite"), options)
    : createInMemoryUiStore(options);
  cleanups.push(
    () => {
      rmSync(path, { recursive: true, force: true });
    },
    () => {
      store.close();
    },
  );
  store.createProject(projectPath, "Continuity persistence fixture");
  const chatId = store.createChat(projectPath, "Continuity persistence fixture", MODEL).id;
  const draft = (
    role: "user" | "assistant",
    content: string,
    timestamp: number,
  ): NewChatMessage => ({
    chatId,
    role,
    content,
    timestamp,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  const first = store.createMessage(draft("user", SUMMARY, 100));
  const last = store.createMessage(draft("assistant", "Acknowledged.", 101));
  const evidenceStore = createInMemoryEvidenceStore();
  const profile = deriveContextProfile({
    maxInputTokens: 4096,
    reservedOutputTokens: 512,
    safetyMarginTokens: 128,
  });
  const deps = {
    store,
    evidenceStore,
    env: {},
    configPresent: false,
    redactor: (value: unknown): unknown => value,
    contextProfile: profile,
    modelPortFactory: (): ModelPort => ({ call: () => Promise.resolve(modelResponse()) }),
  } as unknown as UiHandlerDeps;
  const record: PersistenceFixture["input"]["compaction"] = {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: "history-summary",
    reason: "fixture prefix",
    itemsBefore: 2,
    itemsAfter: 1,
    tokensBefore: 1000,
    tokensAfter: 100,
    preservedFacts: [],
    sourceSpans: [first, last].map((message) => ({ kind: "message", stableId: message.id })),
    conversationCoverage: {
      version: 1,
      throughMessageId: last.id,
      historyRevision: store.chatHistoryRevision(chatId),
      contextWindowTokens: profile.maxInputTokens,
    },
  };
  const startedAt = Date.now();
  const input = {
    chatId,
    modelId: MODEL,
    compaction: record,
    messageCount: 2,
    startedAt,
    finishedAt: startedAt + 1,
    historyPrefix: [first, last] as const,
    correlationId: "continuity-persistence-fixture",
  };
  return {
    deps,
    store,
    evidenceStore,
    chatId,
    projectPath,
    databasePath: join(path, "ui.sqlite"),
    draft,
    input,
    reopen: (): UiStore => {
      store.close();
      store = createNodeUiStore(join(path, "ui.sqlite"), options);
      return store;
    },
  };
}

describe("required private chat continuity", () => {
  it("retains the canonical digest when a protected earlier turn needs a smaller projection", () => {
    const f = fixture();
    f.store.createMessage(f.draft("user", "Later request.", 102));
    const last = f.store.createMessage(f.draft("assistant", "Later answer.", 103));
    const full = {
      ...f.input.compaction,
      itemsBefore: 4,
      conversationCoverage: {
        ...f.input.compaction.conversationCoverage,
        throughMessageId: last.id,
      },
    };
    expect(f.store.writeChatContinuityCheckpoint(f.chatId, full, undefined)).toBe(true);
    persistRequiredChatContinuityCheckpoint(f.deps, f.input);
    expect(f.store.readChatContinuityCheckpoint(f.chatId)).toMatchObject({
      generation: 1,
      record: { itemsBefore: 4, conversationCoverage: { throughMessageId: last.id } },
    });
    expect(f.store.countMessages(f.chatId)).toBe(4);
  });
  it("discards an older completion after another job has committed a valid summary", async () => {
    const f = fixture();
    let resolve = (_response: NormalizedResponse): void => undefined;
    const pending = new Promise<NormalizedResponse>((complete) => {
      resolve = complete;
    });
    const call = vi.fn<ModelPort["call"]>(() => pending);
    const oldWork = enrichChatCompactionWithModelSummary(
      { ...f.deps, modelPortFactory: (): ModelPort => ({ call }) },
      f.input,
    );
    const newer = "Mira remains the approved owner and the budget is 8100 euros.";
    await enrichChatCompactionWithModelSummary(
      {
        ...f.deps,
        modelPortFactory: (): ModelPort => ({
          call: (): Promise<NormalizedResponse> =>
            Promise.resolve({ ...modelResponse(), content: newer }),
        }),
      },
      f.input,
    );
    resolve(modelResponse());
    await oldWork;
    expect(call).toHaveBeenCalledTimes(1);
    expect(f.store.readChatContinuityCheckpoint(f.chatId)?.record?.modelSummary?.content).toBe(
      newer,
    );
  });
  it("restores the summary from the private database after reopening with no audit store", async () => {
    const f = fixture(true);
    await enrichChatCompactionWithModelSummary(f.deps, f.input);
    const store = f.reopen();
    const checkpoint = loadHistoryCheckpoint({
      store,
      evidenceStore: createInMemoryEvidenceStore(),
      chatId: f.chatId,
    });
    expect(checkpoint.record?.modelSummary?.content).toBe(SUMMARY);
    expect(store.countMessages(f.chatId)).toBe(2);
  });

  it("rejects a stale generation without replacing the current private checkpoint", () => {
    const f = fixture();
    const record = f.input.compaction;
    expect(f.store.writeChatContinuityCheckpoint(f.chatId, record, undefined)).toBe(true);
    const generation = f.store.readChatContinuityCheckpoint(f.chatId)?.generation;
    expect(
      f.store.writeChatContinuityCheckpoint(
        f.chatId,
        { ...record, reason: "New current capture" },
        generation,
      ),
    ).toBe(true);
    expect(f.store.writeChatContinuityCheckpoint(f.chatId, record, generation)).toBe(false);
    expect(f.store.readChatContinuityCheckpoint(f.chatId)?.record?.reason).toBe(
      "New current capture",
    );
  });

  it("invalidates derived content after a canonical message edit and removes it with the chat", () => {
    const f = fixture();
    expect(f.store.writeChatContinuityCheckpoint(f.chatId, f.input.compaction, undefined)).toBe(
      true,
    );
    f.store.createAssistantResponseVersion(f.input.historyPrefix[1].id, "Corrected response.", 102);
    expect(f.store.readChatContinuityCheckpoint(f.chatId)).toBeUndefined();
    const record = {
      ...f.input.compaction,
      conversationCoverage: {
        ...f.input.compaction.conversationCoverage,
        historyRevision: f.store.chatHistoryRevision(f.chatId),
      },
    };
    expect(f.store.writeChatContinuityCheckpoint(f.chatId, record, undefined)).toBe(true);
    f.store.deleteChat(f.chatId);
    expect(() => f.store.readChatContinuityCheckpoint(f.chatId)).toThrow("Chat not found");
  });

  it("never writes a checkpoint bound to a different chat's message", () => {
    const f = fixture();
    const other = f.store.createChat(f.projectPath, "Other chat", MODEL);
    const message = f.store.createMessage({
      ...f.draft("assistant", "Other chat data", 150),
      chatId: other.id,
    });
    const record = {
      ...f.input.compaction,
      conversationCoverage: {
        ...f.input.compaction.conversationCoverage,
        throughMessageId: message.id,
      },
    };
    expect(f.store.writeChatContinuityCheckpoint(f.chatId, record, undefined)).toBe(false);
    expect(f.store.readChatContinuityCheckpoint(f.chatId)).toBeUndefined();
  });

  it("keeps authorized content while applying the credential floor and dropping unknown fields", () => {
    const secret = "configured-checkpoint-secret-19283847";
    const f = fixture(false, {
      redactContentString: (value) => redactContent(value, "preserve", [secret]),
    });
    const record = {
      ...f.input.compaction,
      preservedFacts: [
        { statement: `Contact mira@example.org. Credential ${secret}`, inferred: true },
      ],
      unknownPrivateField: secret,
    };
    expect(f.store.writeChatContinuityCheckpoint(f.chatId, record, undefined)).toBe(true);
    const stored = f.store.readChatContinuityCheckpoint(f.chatId)?.record;
    expect(JSON.stringify(stored)).toContain("mira@example.org");
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain("unknownPrivateField");
  });

  it("rejects damaged private payloads without falling back to an older audit summary", async () => {
    const f = fixture(true);
    await enrichChatCompactionWithModelSummary(f.deps, f.input);
    const database = openNodeUiDatabase(f.databasePath);
    try {
      database
        .prepare(
          "UPDATE chat_continuity_checkpoints SET record_json = json_set(record_json, '$.reason', ?)",
        )
        .run("DAMAGED_CHECKPOINT_CANARY");
    } finally {
      database.close();
    }
    const checkpoint = loadHistoryCheckpoint({ ...f.deps, chatId: f.chatId });
    expect(checkpoint.record).toBeUndefined();
    expect(checkpoint.disposition).toBe("read-failed");
    expect(
      f.store.writeChatContinuityCheckpoint(f.chatId, f.input.compaction, checkpoint.generation),
    ).toBe(true);
    expect(f.store.countMessages(f.chatId)).toBe(2);
  });

  it("emits body-free registered checkpoint evidence", async () => {
    const f = fixture();
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    await enrichChatCompactionWithModelSummary(f.deps, f.input);
    const event = sink.events.find(
      (entry) => entry.op === "chat.continuity.checkpoint" && entry.extra?.outcome === "persisted",
    );
    expect(event).toBeDefined();
    if (event === undefined) throw new Error("Missing checkpoint event");
    expectActivityLogProof("chat.continuity.checkpoint.line", formatActivityLogProofLine(event));
    expect(sink.lines().join("\n")).not.toContain(SUMMARY);
    expect(sink.lines().join("\n")).not.toContain(f.chatId);
  });
  it("retains the operational summary when audit retention deletes its manifests", async () => {
    const f = fixture();
    await enrichChatCompactionWithModelSummary(f.deps, f.input);
    expect(
      loadHistoryCheckpoint({ ...f.deps, chatId: f.chatId }).record?.modelSummary?.content,
    ).toBe(SUMMARY);
    f.evidenceStore.list().forEach((id) => {
      f.evidenceStore.delete(id);
    });
    expect(
      loadHistoryCheckpoint({ ...f.deps, chatId: f.chatId }).record?.modelSummary?.content,
    ).toBe(SUMMARY);
    expect(f.store.countMessages(f.chatId)).toBe(2);
  });

  it("keeps a completed enrichment visible after a newer capture of the same prefix", async () => {
    const f = fixture();
    let resolve = (_response: NormalizedResponse): void => undefined;
    const pending = new Promise<NormalizedResponse>((complete) => {
      resolve = complete;
    });
    persistChatCompactionEvidence(f.deps, f.input);
    const work = enrichChatCompactionWithModelSummary(
      { ...f.deps, modelPortFactory: (): ModelPort => ({ call: () => pending }) },
      f.input,
    );
    f.store.createMessage(f.draft("user", "Continue.", 102));
    f.store.createMessage(f.draft("assistant", "Continuing.", 103));
    persistChatCompactionEvidence(f.deps, {
      ...f.input,
      messageCount: 4,
      startedAt: f.input.startedAt + 10,
      finishedAt: f.input.startedAt + 11,
    });
    resolve(modelResponse());
    await work;
    expect(
      loadHistoryCheckpoint({ ...f.deps, chatId: f.chatId }).record?.modelSummary?.content,
    ).toBe(SUMMARY);
    expect(f.store.countMessages(f.chatId)).toBe(4);
  });

  it("can compact through the regular path while optional audit persistence fails", () => {
    const f = fixture();
    for (let index = 0; index < 30; index++) {
      f.store.createMessage(
        f.draft("user", "Prior discussion detail. ".repeat(100), 200 + index * 2),
      );
      f.store.createMessage(f.draft("assistant", "Acknowledged.", 201 + index * 2));
    }
    const deps = {
      ...f.deps,
      evidenceStore: {
        ...f.evidenceStore,
        put: (): string => {
          throw new Error("injected audit failure");
        },
      },
    };
    expect(
      compactChatContext(deps, f.chatId, MODEL, "private-checkpoint-audit-failure").compaction
        ?.messagesCompacted,
    ).toBeGreaterThan(0);
    expect(f.store.countMessages(f.chatId)).toBe(62);
  });
});

function completeTurn(
  store: UiStore,
  chatId: string,
  id: string,
  user: NewChatMessage,
  assistant: NewChatMessage,
): void {
  const admitted = store.admitChatTurn(id, user);
  if (admitted.kind !== "admitted") throw new Error("Fixture turn not admitted");
  const answer = store.createTurnAssistant(admitted.userMessage.id, assistant);
  expect(store.completeChatTurn(chatId, id, user.content, answer.id).kind).toBe("completed");
}

it("invalidates the saved prefix when an earlier pending turn becomes eligible after later turns", () => {
  const f = fixture();
  const slowUser = f.draft("user", "The earlier task has a separate decision.", 200);
  const slow = f.store.admitChatTurn("slow-earlier-turn", slowUser);
  if (slow.kind !== "admitted") throw new Error("Slow fixture turn not admitted");
  completeTurn(
    f.store,
    f.chatId,
    "later-finished-turn",
    f.draft("user", "Later discussion. ".repeat(1000), 300),
    f.draft("assistant", "Later task finished.", 301),
  );
  const current = f.store.createMessage(f.draft("user", "Continue.", 400));
  const profile = deriveContextProfile({
    maxInputTokens: 256,
    reservedOutputTokens: 0,
    safetyMarginTokens: 0,
  });
  const before = captureChatHistory(f.store, f.chatId, current.id, profile, []);
  const revision = f.store.chatHistoryRevision(f.chatId);
  const answer = f.store.createTurnAssistant(
    slow.userMessage.id,
    f.draft("assistant", "Earlier task finished.", 500),
  );
  expect(
    f.store.completeChatTurn(f.chatId, "slow-earlier-turn", slowUser.content, answer.id).kind,
  ).toBe("completed");
  expect(f.store.chatHistoryRevision(f.chatId)).toBeGreaterThan(revision);
  const after = captureChatHistory(
    f.store,
    f.chatId,
    current.id,
    profile,
    [],
    before.earlierCompaction,
  );
  expect(after.earlierCompaction?.itemsBefore).toBe(
    (before.earlierCompaction?.itemsBefore ?? 0) + 2,
  );
});
