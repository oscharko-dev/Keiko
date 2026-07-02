import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import {
  buildGatewayAssembly,
  type GatewayConversationMessage,
  type SendDesktopChatRequest,
} from "./chat-handlers.js";
import { selectGatewayPromptAssembly } from "./chat-prompt-budget.js";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import {
  DEFAULT_CONTEXT_PROFILE,
  deriveContextProfile,
  estimateTokensForSegments,
  type ContextProfile,
  type ConversationDocumentContextWire,
} from "@oscharko-dev/keiko-contracts";
import {
  CONVERSATION_SYSTEM_PROMPT,
  renderConversationDocumentContextBlock,
} from "./conversation-prompt.js";
import type {
  ConversationMemoryContextEntryWire,
  ConversationMemoryResultWire,
} from "@oscharko-dev/keiko-contracts/bff-wire";

const CHAT_MODEL = "example-chat-model";
const PROJECT_PATH = "/repo";
const NOW = 1_700_000_000_000;

function customModelConfig(modelId = CHAT_MODEL): GatewayConfig {
  return {
    providers: [
      {
        modelId,
        baseUrl: "https://provider.example/v1",
        apiKey: "test-config-secret-value-1234567890",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 500,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [
      {
        id: modelId,
        kind: "chat",
        contextWindow: 64_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: false,
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "local endpoint",
        preferredUseCases: ["Local coding workflow"],
        knownLimitations: [],
      },
    ],
  };
}

function emptyEvidenceStore(): UiHandlerDeps["evidenceStore"] {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function createDeps(
  store: UiStore,
  contextProfile: ContextProfile | undefined,
  overrides: Partial<UiHandlerDeps> = {},
): UiHandlerDeps {
  return {
    config: customModelConfig(CHAT_MODEL),
    configPresent: true,
    evidenceStore: emptyEvidenceStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    contextProfile,
    ...overrides,
  };
}

function createStore(): { readonly store: UiStore; readonly chatId: string } {
  const root = mkdtempSync(join(tmpdir(), "keiko-chat-assembly-"));
  mkdirSync(root, { recursive: true });
  const store = createInMemoryUiStore();
  store.createProject(root, "repo");
  const chat = store.createChat(root, "Prompt budget", CHAT_MODEL);
  return { store, chatId: chat.id };
}

type SeedMessage = Parameters<UiStore["createMessage"]>[0];

function createMessage(
  chatId: string,
  role: SeedMessage["role"],
  content: string,
  timestamp: number,
): SeedMessage {
  return {
    chatId,
    role,
    content,
    timestamp,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
}

function seedHistory(chatId: string, store: UiStore, turns: readonly string[]): void {
  turns.forEach((content, index) => {
    const role = index % 2 === 0 ? "user" : "assistant";
    store.createMessage(createMessage(chatId, role, content, NOW + index));
  });
}

function makeDocument(
  id: string,
  displayName: string,
  text: string,
): ConversationDocumentContextWire {
  const extractedBytes = Buffer.byteLength(text, "utf8");
  return {
    id,
    displayName,
    mimeType: "text/plain",
    sizeBytes: extractedBytes,
    extractedBytes,
    truncated: false,
    text,
  };
}

function makeMemoryEntry(id: string, bodyExcerpt: string): ConversationMemoryContextEntryWire {
  return {
    memoryId: id,
    bodyExcerpt,
    inclusionReason: "semantic similarity to query",
    sourceKind: "explicit-user-instruction",
    sensitivity: "public",
    confidence: 0.91,
    status: "accepted",
    capturedAt: NOW,
  };
}

function renderMemoryText(entries: readonly ConversationMemoryContextEntryWire[]): string {
  return [
    "# Relevant memories",
    ...entries.map((entry) => `- (${entry.inclusionReason}) ${entry.bodyExcerpt}`),
  ].join("\n");
}

function makeMemoryResult(
  entries: readonly ConversationMemoryContextEntryWire[],
): ConversationMemoryResultWire {
  const text = entries.length === 0 ? "" : renderMemoryText(entries);
  return {
    context: {
      enabled: true,
      text,
      memories: entries,
      budget: {
        tokens: estimateTokensForSegments(text.length === 0 ? [] : [text]),
        used: estimateTokensForSegments(text.length === 0 ? [] : [text]),
      },
    },
    actions: [],
  };
}

function makeRequest(
  chatId: string,
  content: string,
  overrides: Partial<SendDesktopChatRequest> = {},
): SendDesktopChatRequest {
  return {
    chatId,
    projectPath: PROJECT_PATH,
    content,
    modelId: CHAT_MODEL,
    documentContext: [],
    attachments: [],
    memory: undefined,
    discussionMode: undefined,
    ...overrides,
  };
}

function assemblyMessages(outcome: ReturnType<typeof buildGatewayAssembly>): string[] {
  return outcome.messages.map((message: GatewayConversationMessage) => message.content);
}

describe("buildGatewayAssembly", () => {
  it("keeps the final prompt within the effective budget after trimming memory, docs, and history", () => {
    const { store, chatId } = createStore();
    seedHistory(chatId, store, ["history turn 0 " + "x".repeat(24)]);
    store.createMessage(
      createMessage(chatId, "user", "What should we keep from the current plan?", NOW + 99),
    );

    const profile = deriveContextProfile({
      maxInputTokens: 1600,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    });
    const deps = createDeps(store, profile);
    const memory = makeMemoryResult([
      makeMemoryEntry("mem-1", "memory-one " + "m".repeat(64)),
      makeMemoryEntry("mem-2", "memory-two " + "m".repeat(4000)),
      makeMemoryEntry("mem-3", "memory-three " + "m".repeat(4000)),
    ]);
    const request = makeRequest(chatId, "Summarise the current plan.", {
      documentContext: [
        makeDocument("doc-1", "spec-a.txt", "document-one " + "d".repeat(64)),
        makeDocument("doc-2", "spec-b.txt", "document-two " + "d".repeat(1200)),
      ],
    });

    const outcome = buildGatewayAssembly(deps, request, memory, CHAT_MODEL);
    const totalTokens = estimateTokensForSegments(assemblyMessages(outcome));
    const latestUserTurn = outcome.messages.at(-1)?.content ?? "";

    expect(totalTokens).toBeLessThanOrEqual(profile.effectiveInputBudget);
    expect(outcome.diagnostics.totalEstimatedTokens).toBe(totalTokens);
    expect(outcome.diagnostics.totalEstimatedTokens).toBeLessThanOrEqual(
      profile.effectiveInputBudget,
    );
    expect(outcome.diagnostics.lanes.some((lane) => lane.laneId === "working-memory")).toBe(true);
    expect(outcome.diagnostics.lanes.some((lane) => lane.laneId === "repo-evidence")).toBe(true);
    expect(
      outcome.diagnostics.lanes.find((lane) => lane.laneId === "working-memory")?.excludedItems,
    ).toBeGreaterThan(0);
    expect(
      outcome.diagnostics.lanes.find((lane) => lane.laneId === "repo-evidence")?.excludedItems,
    ).toBeGreaterThan(0);
    expect(
      outcome.diagnostics.lanes.find((lane) => lane.laneId === "working-memory")?.compactionReason,
    ).toBe("budget");
    expect(
      outcome.diagnostics.lanes.find((lane) => lane.laneId === "repo-evidence")?.compactionReason,
    ).toBe("budget");
    expect(
      outcome.diagnostics.lanes.reduce((sum, lane) => sum + lane.estimatedTokens, 0),
    ).toBeLessThanOrEqual(profile.effectiveInputBudget);
    expect((latestUserTurn.match(/Included memory context:/g) ?? []).length).toBe(1);
    expect(latestUserTurn).toContain("# Relevant memories");
  });

  it("summarizes a single oversized prior history turn instead of failing the current prompt", () => {
    const { store, chatId } = createStore();
    seedHistory(chatId, store, [`Fact: prior branch decision ${"x".repeat(80_000)}`]);
    store.createMessage(createMessage(chatId, "user", "Keep the current request exact.", NOW + 99));

    const profile = deriveContextProfile({
      maxInputTokens: 1_000,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    });
    const deps = createDeps(store, profile);
    const request = makeRequest(chatId, "Keep the current request exact.");

    const outcome = buildGatewayAssembly(deps, request, makeMemoryResult([]), CHAT_MODEL);
    const totalTokens = estimateTokensForSegments(assemblyMessages(outcome));

    expect(outcome.compaction?.itemsBefore).toBe(1);
    expect(totalTokens).toBeLessThanOrEqual(profile.effectiveInputBudget);
    expect(outcome.messages.at(-1)?.content).toBe("Keep the current request exact.");
    expect(outcome.messages.map((message) => message.content).join("\n")).not.toContain(
      "x".repeat(1_000),
    );
  });

  it("keeps a simple prompt unchanged while exposing allocator lane diagnostics", () => {
    const { store, chatId } = createStore();
    store.createMessage(createMessage(chatId, "user", "Simple prompt", NOW + 99));

    const deps = createDeps(store, DEFAULT_CONTEXT_PROFILE);
    const memory = makeMemoryResult([]);
    const request = makeRequest(chatId, "Simple prompt");

    const outcome = buildGatewayAssembly(deps, request, memory, CHAT_MODEL);

    expect(outcome.messages.at(-1)?.content).toBe("Simple prompt");
    expect(outcome.diagnostics.lanes.map((lane) => lane.laneId)).toEqual([
      "system-contract",
      "user-task",
      "repo-evidence",
      "working-memory",
      "history-summary",
      "verification-evidence",
    ]);
    expect(
      outcome.diagnostics.lanes.find((lane) => lane.laneId === "system-contract")?.includedItems,
    ).toBe(1);
    expect(
      outcome.diagnostics.lanes.find((lane) => lane.laneId === "user-task")?.includedItems,
    ).toBe(1);
  });

  it("drops whole document entries in order and preserves included content unchanged", () => {
    const { store, chatId } = createStore();
    seedHistory(chatId, store, ["previous user"]);
    store.createMessage(createMessage(chatId, "user", "Document check now", NOW + 99));

    const profile = deriveContextProfile({
      maxInputTokens: 420,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    });
    const deps = createDeps(store, profile);
    const firstDoc = makeDocument("doc-1", "keep.txt", "KEEP-IN-ORDER-" + "k".repeat(50));
    const secondDoc = makeDocument("doc-2", "drop.txt", "DROP-WHOLE-DOC-" + "z".repeat(1800));
    const memory = makeMemoryResult([]);
    const request = makeRequest(chatId, "Review the attached docs.", {
      documentContext: [firstDoc, secondDoc],
    });

    const outcome = buildGatewayAssembly(deps, request, memory, CHAT_MODEL);
    const latestUserTurn = outcome.messages.at(-1)?.content ?? "";
    const repoLane = outcome.diagnostics.lanes.find((lane) => lane.laneId === "repo-evidence");

    expect(latestUserTurn).toContain(firstDoc.text);
    expect(latestUserTurn).not.toContain(secondDoc.text);
    expect(repoLane?.includedItems).toBe(1);
    expect(repoLane?.excludedItems).toBe(1);
  });

  it("reserves prompt wrapper overhead before including optional document context", () => {
    const { store, chatId } = createStore();
    store.createMessage(createMessage(chatId, "user", "Wrapper overhead check", NOW + 99));

    const requestText = "Review the attached document.";
    const doc = makeDocument("doc-1", "edge.txt", "EDGE-DOC-" + "e".repeat(600));
    const budgetThatFitsRawLanesButNotWrappedPrompt = estimateTokensForSegments([
      CONVERSATION_SYSTEM_PROMPT,
      requestText,
      renderConversationDocumentContextBlock(doc),
    ]);
    const profile = deriveContextProfile({
      maxInputTokens: budgetThatFitsRawLanesButNotWrappedPrompt,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    });
    const deps = createDeps(store, profile);
    const memory = makeMemoryResult([]);
    const request = makeRequest(chatId, requestText, { documentContext: [doc] });

    const outcome = buildGatewayAssembly(deps, request, memory, CHAT_MODEL);
    const latestUserTurn = outcome.messages.at(-1)?.content ?? "";
    const totalTokens = estimateTokensForSegments(assemblyMessages(outcome));
    const repoLane = outcome.diagnostics.lanes.find((lane) => lane.laneId === "repo-evidence");

    expect(totalTokens).toBeLessThanOrEqual(profile.effectiveInputBudget);
    expect(latestUserTurn).not.toContain(doc.text);
    expect(repoLane?.includedItems).toBe(0);
    expect(repoLane?.excludedItems).toBe(1);
    expect(repoLane?.compactionReason).toBe("budget");
  });

  it("counts dropped resurfaced compaction context in working-memory diagnostics", () => {
    const profile = deriveContextProfile({
      maxInputTokens: 500,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    });
    const outcome = selectGatewayPromptAssembly({
      historyPrefix: [],
      historyTurnCount: 0,
      request: { content: "Continue with the current task.", discussionMode: undefined },
      profile,
      memoryEntries: [],
      compactionContextText: "# Persisted compaction context\n" + "c".repeat(4_000),
      documentContext: [],
      redactionSecrets: [],
    });
    expect(outcome).toBeDefined();
    if (outcome === undefined) return;
    const latestUserTurn = outcome.messages.at(-1)?.content ?? "";
    const memoryLane = outcome.diagnostics.lanes.find((lane) => lane.laneId === "working-memory");

    expect(latestUserTurn).not.toContain("Persisted compaction context");
    expect(memoryLane?.includedItems).toBe(0);
    expect(memoryLane?.excludedItems).toBe(1);
    expect(memoryLane?.compactionReason).toBe("budget");
  });

  it("keeps included resurfaced compaction context system-scoped", () => {
    const profile = deriveContextProfile({
      maxInputTokens: 2_000,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    });
    const compactionContextText =
      "# Persisted compaction context\nModel-written continuity summary:\n- structured model-summary evidence";
    const outcome = selectGatewayPromptAssembly({
      historyPrefix: [],
      historyTurnCount: 0,
      request: { content: "Continue with the current task.", discussionMode: undefined },
      profile,
      memoryEntries: [],
      compactionContextText,
      documentContext: [],
      redactionSecrets: [],
    });
    expect(outcome).toBeDefined();
    if (outcome === undefined) return;
    const latestUserTurn = outcome.messages.at(-1)?.content ?? "";
    const systemText = outcome.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    const memoryLane = outcome.diagnostics.lanes.find((lane) => lane.laneId === "working-memory");

    expect(latestUserTurn).not.toContain("structured model-summary evidence");
    expect(systemText).toContain("structured model-summary evidence");
    expect(memoryLane?.includedItems).toBe(1);
  });

  it("returns path-free aggregate diagnostics with history, memory, doc, and reserve lanes", () => {
    const { store, chatId } = createStore();
    seedHistory(chatId, store, ["one", "two", "three"]);
    store.createMessage(createMessage(chatId, "user", "Path-free diagnostics", NOW + 99));

    const profile = DEFAULT_CONTEXT_PROFILE;
    const deps = createDeps(store, profile);
    const memory = makeMemoryResult([makeMemoryEntry("mem-1", "memory for diagnostics")]);
    const request = makeRequest(chatId, "Please inspect the inputs.", {
      documentContext: [makeDocument("doc-1", "src/secret-context.txt", "repo evidence")],
    });

    const outcome = buildGatewayAssembly(deps, request, memory, CHAT_MODEL);
    const serialized = JSON.stringify(outcome.diagnostics);

    expect(outcome.diagnostics.lanes.map((lane) => lane.laneId)).toEqual(
      expect.arrayContaining([
        "system-contract",
        "user-task",
        "working-memory",
        "repo-evidence",
        "history-summary",
        "verification-evidence",
      ]),
    );
    expect(
      outcome.diagnostics.lanes.find((lane) => lane.laneId === "user-task")?.estimatedTokens,
    ).toBeGreaterThan(0);
    expect(serialized).not.toContain("src/secret-context.txt");
    expect(serialized).not.toContain("memory for diagnostics");
    expect(serialized).not.toContain("repo evidence");
    expect(serialized).not.toContain("/");
  });
});
