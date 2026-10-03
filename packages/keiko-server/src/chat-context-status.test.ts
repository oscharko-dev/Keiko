import {
  buildGatewayAssembly,
  captureGatewayTurnSnapshot,
  emptyMemoryResult,
} from "./chat-handlers.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type {
  ChatContextSegmentId,
  GroundedPromptContextWire,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  DEFAULT_CONTEXT_PROFILE,
  deriveContextProfile,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { createDefaultChatCapability } from "@oscharko-dev/keiko-model-gateway";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore, type UiStore, type ChatMessage } from "./store/index.js";
import { compactChatContext, readChatContextStatus } from "./chat-context-status.js";
import { captureChatHistory } from "./chat-history-snapshot.js";
import { loadChatContinuityCheckpoint } from "./chat-compaction-resurfacing.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { groundedConversationContinuity } from "./grounded-conversation-continuity.js";
import { persistChatCompactionEvidence } from "./chat-compaction-evidence.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import {
  formatRegisteredServerLogLine,
  serverLogProcessIdentity,
} from "@oscharko-dev/keiko-activity-log";
import { logChatContextManagement } from "./chat-context-log.js";

const stores: UiStore[] = [];
const paths: string[] = [];
afterEach(() => {
  resetServerLogger();
  for (const store of stores.splice(0)) store.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(
  pairs = 40,
  note = "We review the documentation together. ".repeat(25),
): { deps: UiHandlerDeps; chatId: string; projectPath: string } {
  const store = createInMemoryUiStore();
  stores.push(store);
  const path = mkdtempSync(join(tmpdir(), "keiko-context-status-"));
  paths.push(path);
  store.createProject(path, "Context fixture");
  const chatId = store.createChat(path, "Context fixture", "fixture").id;
  for (let index = 0; index < pairs; index += 1) {
    for (const role of ["user", "assistant"] as const) {
      store.createMessage({
        chatId,
        role,
        content: `Note ${String(index)}. ${note}`,
        timestamp: 1_700_000_000_000 + index * 2 + (role === "user" ? 0 : 1),
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      });
    }
  }
  const deps: UiHandlerDeps = {
    config: undefined,
    configPresent: false,
    evidenceStore: createInMemoryEvidenceStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    store,
    contextProfile: deriveContextProfile({
      maxInputTokens: 32_000,
      reservedOutputTokens: 2_000,
      safetyMarginTokens: 1_000,
    }),
    modelPortFactory: () => {
      throw new Error("Manual compaction must not call a provider");
    },
  };
  return { deps, chatId, projectPath: path };
}

function currentMessage(deps: UiHandlerDeps, chatId: string, content: string): ChatMessage {
  return deps.store.createMessage({
    chatId,
    role: "user",
    content,
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
}

function segmentOf(
  status: ReturnType<typeof readChatContextStatus>,
  id: ChatContextSegmentId,
): { readonly tokens: number; readonly count: number } {
  const segment = status.segments?.find((candidate) => candidate.id === id);
  if (segment === undefined) throw new Error(`missing ${id} segment`);
  return { tokens: segment.tokens, count: segment.count ?? 0 };
}

function projectionNotes(): string {
  return Array.from({ length: 16 }, (_, index) =>
    ["Fact", "Decision", "Constraint"]
      .map((kind) => `${kind}: Requirement ${String(index)} ${"durable information ".repeat(10)}`)
      .join("\n"),
  ).join("\n");
}

const GROUNDED_SCOPES = [
  { kind: "capsule" as const, capsuleId: "capsule-1" as KnowledgeCapsuleId, connectedAtMs: 1 },
];

function seedGroundedAnswer(
  deps: UiHandlerDeps,
  chatId: string,
  promptContext: GroundedPromptContextWire,
): void {
  const user = currentMessage(deps, chatId, "Welche Kontoarten gibt es?");
  deps.store.createMessage({
    chatId,
    role: "assistant",
    content: "Privatgirokonto, Basiskonto und P-Konto [1].",
    timestamp: user.timestamp + 1,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
    groundedAnswer: {
      groundingKind: "local-knowledge",
      userMessageId: user.id,
      assistantMessageId: "pending",
      content: "Privatgirokonto, Basiskonto und P-Konto [1].",
      citations: [],
      uncertainty: [],
      omittedCount: 0,
      elapsedMs: 10,
      noEvidence: false,
      contextPack: {
        kind: "local-knowledge",
        scopeKind: "capsule",
        scopeId: "lk-1",
        scopeLabel: "test",
        capsuleCount: 1,
        sourceCount: 1,
        citationCount: 1,
      },
      promptContext,
    } as unknown as NonNullable<ChatMessage["groundedAnswer"]>,
  });
}

// Field report 1.1.13: a grounded chat's meter showed only the conversation, although the retrieved
// sources were the largest share of every request. The status now carries that share from the
// latest grounded answer's body-free prompt context.
describe("grounded context status", () => {
  it("shows the latest grounded request's source share and size while the chat is grounded", () => {
    const { deps, chatId } = fixture(2, "Kurze Frage und Antwort.");
    seedGroundedAnswer(deps, chatId, {
      promptTokens: 5_901,
      promptTokensMeasured: true,
      estimatedPromptTokens: 6_420,
      instructionTokens: 310,
      sourceTokens: 4_100,
      sentReferenceCount: 4,
      availableReferenceCount: 16,
    });
    deps.store.updateChat(chatId, { localKnowledgeScopes: GROUNDED_SCOPES });
    const status = readChatContextStatus(deps, chatId, "fixture");
    expect(status.knowledgeSources).toEqual({
      tokens: 4_100,
      sentReferenceCount: 4,
      availableReferenceCount: 16,
    });
    expect(status.lastRequest).toEqual({
      promptTokens: 5_901,
      measured: true,
      estimatedTokens: 6_420,
    });
    const segments = status.segments ?? [];
    expect(segments.find((segment) => segment.id === "knowledge")).toEqual({
      id: "knowledge",
      tokens: 4_100,
      count: 4,
    });
    expect(segments.reduce((sum, segment) => sum + segment.tokens, 0)).toBe(
      status.contextWindowTokens,
    );
    expect(status.estimatedInputTokens).toBeGreaterThanOrEqual(4_100);
  });

  // PR #3678 review: after a model switch or an adopted window, the latest grounded request was
  // planned for another window. Its counts are history: no "references trimmed" note, no "last
  // request", while the source share stays in the breakdown, fitted to the current budget.
  it("treats a grounded request planned for another window as history", () => {
    const { deps, chatId } = fixture(2, "Kurze Frage und Antwort.");
    seedGroundedAnswer(deps, chatId, {
      promptTokens: 90_000,
      promptTokensMeasured: true,
      instructionTokens: 310,
      sourceTokens: 80_000,
      sentReferenceCount: 4,
      availableReferenceCount: 16,
      contextWindowTokens: 128_000,
    });
    deps.store.updateChat(chatId, { localKnowledgeScopes: GROUNDED_SCOPES });
    const status = readChatContextStatus(deps, chatId, "fixture");
    expect(status.lastRequest).toBeUndefined();
    expect(status.knowledgeSources).toBeUndefined();
    expect(segmentOf(status, "knowledge").tokens).toBeGreaterThan(0);
    expect(status.estimatedInputTokens).toBeLessThanOrEqual(status.inputBudgetTokens);
  });

  it("does not present a grounded request as the last one once the chat is no longer grounded", () => {
    const { deps, chatId } = fixture(2, "Kurze Frage und Antwort.");
    seedGroundedAnswer(deps, chatId, {
      promptTokens: 41_000,
      promptTokensMeasured: true,
      instructionTokens: 310,
      sourceTokens: 30_000,
      sentReferenceCount: 16,
      availableReferenceCount: 16,
    });
    const status = readChatContextStatus(deps, chatId, "fixture");
    expect(status.lastRequest).toBeUndefined();
    expect(status.knowledgeSources).toBeUndefined();
  });

  // PR #3678 review: manual compaction sized its target from the whole reading, sources included,
  // so a grounded chat with a small history never compacted.
  it("compacts a grounded chat's own history, not against the sources beside it", () => {
    const { deps, chatId } = fixture(10);
    seedGroundedAnswer(deps, chatId, {
      promptTokens: 21_000,
      promptTokensMeasured: true,
      instructionTokens: 310,
      sourceTokens: 20_000,
      sentReferenceCount: 16,
      availableReferenceCount: 16,
    });
    deps.store.updateChat(chatId, { localKnowledgeScopes: GROUNDED_SCOPES });
    const after = compactChatContext(deps, chatId, "fixture", "corr-grounded-manual");
    expect(after.compaction?.tokensSaved).toBeGreaterThan(0);
  });

  // PR #3678 review: the grounded send path compacts the conversation inside its lane (at most a
  // third of the input budget). The meter must show that projection — a summary and fewer verbatim
  // messages — instead of clipping the raw history's token total.
  it("projects a grounded chat's history against its conversation lane", () => {
    const seeded = fixture(10, "Wir besprechen die Kontoführung im Detail. ".repeat(40));
    const deps = {
      ...seeded.deps,
      contextProfile: deriveContextProfile({
        maxInputTokens: 16_384,
        reservedOutputTokens: 4_096,
        safetyMarginTokens: 512,
      }),
    };
    deps.store.updateChat(seeded.chatId, {
      localKnowledgeScopes: [
        { kind: "capsule", capsuleId: "capsule-1" as KnowledgeCapsuleId, connectedAtMs: 1 },
      ],
    });
    const status = readChatContextStatus(deps, seeded.chatId, "fixture");
    expect(status.pendingCompaction?.tokensBefore).toBeGreaterThan(status.inputBudgetTokens / 3);
    expect(status.pendingCompaction?.messagesCompacted).toBeGreaterThan(0);
    const summary = segmentOf(status, "summary");
    const messages = segmentOf(status, "messages");
    expect(summary.count).toBeGreaterThan(0);
    expect(summary.tokens).toBeGreaterThan(0);
    expect(messages.count).toBeLessThan(20);
    expect(summary.tokens + messages.tokens).toBeLessThanOrEqual(
      Math.floor(status.inputBudgetTokens / 3),
    );
  });

  // PR #3678 review (C12): an undeclared window reads as the default planning window and says so.
  it("reports an assumed window with the default geometry and flags it", () => {
    const { deps, chatId } = fixture(2, "Kurze Frage und Antwort.");
    const assumedDeps: UiHandlerDeps = {
      ...deps,
      contextProfile: undefined,
      config: {
        providers: [],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        capabilities: [
          {
            ...createDefaultChatCapability("fixture"),
            contextWindow: 4_096,
            contextWindowAssumed: true,
          },
        ],
      },
      configPresent: true,
    };

    const status = readChatContextStatus(assumedDeps, chatId, "fixture");

    expect(status.contextWindowAssumed).toBe(true);
    expect(status.contextWindowTokens).toBe(DEFAULT_CONTEXT_PROFILE.maxInputTokens);
  });

  // PR #3678 review (C4/C12): a grounded chat's readings carry the sources, so the logged savings
  // must be the conversation's own, equal to the saved checkpoint's.
  it("logs the conversation's own savings when a grounded chat with a pending compaction compacts", () => {
    const seeded = fixture(10, "Wir besprechen die Kontoführung im Detail. ".repeat(40));
    const deps = {
      ...seeded.deps,
      contextProfile: deriveContextProfile({
        maxInputTokens: 16_384,
        reservedOutputTokens: 4_096,
        safetyMarginTokens: 512,
      }),
    };
    seedGroundedAnswer(deps, seeded.chatId, {
      promptTokens: 9_000,
      promptTokensMeasured: true,
      instructionTokens: 310,
      sourceTokens: 6_000,
      sentReferenceCount: 4,
      availableReferenceCount: 4,
    });
    deps.store.updateChat(seeded.chatId, { localKnowledgeScopes: GROUNDED_SCOPES });
    expect(readChatContextStatus(deps, seeded.chatId, "fixture").pendingCompaction).toBeDefined();
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));

    const after = compactChatContext(deps, seeded.chatId, "fixture", "corr-grounded-savings");

    const compacted = sink.events.find(
      (event) => event.op === "chat.context.management" && event.extra?.outcome === "compacted",
    );
    expect(after.compaction?.tokensSaved).toBeGreaterThan(0);
    expect(compacted?.extra?.tokensSaved).toBe(after.compaction?.tokensSaved);
  });

  // PR #3678 review: the send path compares the complete assembly — history plus the empty
  // current-user scaffold — with the threshold. A history just below the meter's old history-only
  // count compacted on send while the meter reported free tokens.
  it("predicts the grounded send path's compaction at the threshold boundary", () => {
    const { deps, chatId } = fixture(0);
    const modelDeps = {
      ...deps,
      contextProfile: deriveContextProfile({
        maxInputTokens: 16_384,
        reservedOutputTokens: 4_096,
        safetyMarginTokens: 512,
      }),
    };
    for (const [role, content] of [
      ["user", "Fact: alpha ".repeat(962)],
      ["assistant", "Acknowledged."],
    ] as const) {
      deps.store.createMessage({
        chatId,
        role,
        content,
        timestamp: Date.now(),
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      });
    }
    deps.store.updateChat(chatId, { localKnowledgeScopes: GROUNDED_SCOPES });

    const status = readChatContextStatus(modelDeps, chatId, "fixture");
    const sent = groundedConversationContinuity(
      modelDeps,
      currentMessage(deps, chatId, "Next question?"),
      "fixture",
    );

    // The meter and the send path agree on whether this history compacts.
    expect(sent.compaction).toBeDefined();
    expect(status.pendingCompaction).toBeDefined();
  });

  it("uses the same bounded conversation lane to read a saved grounded compaction", () => {
    const { deps, chatId } = fixture();
    const modelDeps = {
      ...deps,
      contextProfile: deriveContextProfile({
        maxInputTokens: 128_000,
        reservedOutputTokens: 8_000,
        safetyMarginTokens: 4_000,
      }),
    };
    deps.store.updateChat(chatId, { localKnowledgeScopes: GROUNDED_SCOPES });
    const user = currentMessage(deps, chatId, "Continue reviewing the documentation.");
    const continuity = groundedConversationContinuity(modelDeps, user, "fixture");
    const compaction = continuity.compaction;
    if (compaction === undefined) throw new Error("expected grounded compaction");
    persistChatCompactionEvidence(modelDeps, {
      compaction,
      chatId,
      modelId: "fixture",
      messageCount: deps.store.countMessages(chatId),
      startedAt: 1,
      finishedAt: 2,
      correlationId: "corr-grounded-lane-compaction",
    });

    const status = readChatContextStatus(modelDeps, chatId, "fixture");
    expect(status.compaction?.tokensSaved).toBeGreaterThan(0);
    expect(segmentOf(status, "summary").tokens).toBeGreaterThan(0);
    expect(status.pendingCompaction).toBeUndefined();
  });

  it("keeps a model-only chat free of a source share", () => {
    const { deps, chatId } = fixture(2);
    const status = readChatContextStatus(deps, chatId, "fixture");
    expect(status.knowledgeSources).toBeUndefined();
    expect(status.segments?.some((segment) => segment.id === "knowledge")).toBe(false);
    expect((status.segments ?? []).reduce((sum, segment) => sum + segment.tokens, 0)).toBe(
      status.contextWindowTokens,
    );
  });
});

describe("composer context status and manual maintenance", () => {
  it.each([
    "inspected",
    "compacted",
    "unchanged",
    "failed",
    "summary-discarded",
    "prompt-compacted",
    "prompt-failed",
  ] as const)("reconstructs the closed %s outcome from emitted maintenance evidence", (outcome) => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    logChatContextManagement(
      outcome,
      { estimatedInputTokens: 1000, inputBudgetTokens: 2000 },
      500,
      "corr-maintenance-outcome",
    );
    const event = sink.events[0];
    expect(event).toMatchObject({
      correlationId: "corr-maintenance-outcome",
      extra: { outcome, inputTokens: 1000, inputBudget: 2000, tokensSaved: 500 },
    });
    const line = formatActivityLogProofLine(event ?? {});
    expectActivityLogProof("chat.context.management.line", line);
    const report = analyzeLogText(line);
    expect(report.sufficiency.status).toBe("complete");
    expect(
      report.timelines
        .find((timeline) => timeline.correlationId === "corr-maintenance-outcome")
        ?.lines.some((entry) => entry.op === "chat.context.management"),
    ).toBe(true);
  });
  // PR #3678 review: the inspected line must let an agent rebuild the meter reading: the trigger,
  // the last knowledge request, the reference trim, the known shares and a pending probe.
  it("records the meter reading's trigger, knowledge request and shares on the inspected line", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    logChatContextManagement(
      "inspected",
      {
        estimatedInputTokens: 9_000,
        inputBudgetTokens: 20_000,
        autoCompactionAtTokens: 12_400,
        conversationInputBudgetTokens: 8_000,
        knowledgeSources: { tokens: 6_000, sentReferenceCount: 4, availableReferenceCount: 16 },
        lastRequest: { promptTokens: 8_800, measured: true, estimatedTokens: 9_100 },
        segments: [
          { id: "system", tokens: 700 },
          { id: "summary", tokens: 300 },
          { id: "messages", tokens: 2_000, count: 6 },
          { id: "knowledge", tokens: 6_000, count: 4 },
          { id: "source-capacity", tokens: 9_600 },
        ],
        contextWindowProbePending: true,
      },
      0,
      "corr-inspected-reading",
    );

    const line = formatActivityLogProofLine(sink.events[0] ?? {});
    expect(expectActivityLogProof("chat.context.management.line", line)).toMatchObject({
      correlationId: "corr-inspected-reading",
      autoCompactionAtTokens: 12_400,
      conversationInputBudgetTokens: 8_000,
      sourceCapacityTokens: 9_600,
      knowledgeSourceTokens: 6_000,
      sentReferenceCount: 4,
      availableReferenceCount: 16,
      lastRequestTokens: 8_800,
      lastRequestMeasured: true,
      lastRequestEstimatedTokens: 9_100,
      systemTokens: 700,
      summaryTokens: 300,
      messageTokens: 2_000,
      contextWindowProbePending: true,
    });
    const report = analyzeLogText(line);
    expect(report.sufficiency.status).toBe("complete");
    expect(
      report.timelines
        .find((timeline) => timeline.correlationId === "corr-inspected-reading")
        ?.lines.some((entry) => entry.op === "chat.context.management"),
    ).toBe(true);
    expect(line).not.toContain("Kurze Frage");
  });
  it.each([
    "Was kostet das Modell Qwen?",
    "Wie groß ist dieses Kontextfenster von Mistral?",
    "What is this model's context window?",
    "They deployed Qwen yesterday. What is its pricing?",
    "Write Vitest tests for normalizeEmail in src/email.ts.",
    "Schreibe Vitest-Testfälle für normalizeEmail in src/email.ts.",
    "Add tests for the normalizeEmail function.",
  ])("does not add an unrelated old question to the explicit retrieval query: %s", (query) => {
    const { deps, chatId } = fixture(1, "Unrelated old payroll policy.");
    const continuity = groundedConversationContinuity(
      deps,
      currentMessage(deps, chatId, query),
      "fixture",
    );
    expect(continuity.retrievalContent).toBe(query);
  });
  it.each([
    "Wie funktioniert das?",
    "Was bedeutet das?",
    "Erkläre das bitte.",
    "How does it work?",
    "What does this mean?",
    "Summarize that.",
    "Schreibe dafür Vitest-Testfälle, einschließlich Grenzwerten.",
    "Schreibe Vitest-Tests für diese Funktion.",
    "Write Vitest tests for that function, including edge cases.",
    "Add test cases for the proposed function.",
  ])("resolves a concrete anaphoric follow-up: %s", (query) => {
    const { deps, chatId } = fixture(1, "Qwen invoice extraction process.");
    const continuity = groundedConversationContinuity(
      deps,
      currentMessage(deps, chatId, query),
      "fixture",
    );
    expect(continuity.retrievalContent).toContain("Qwen invoice extraction process.");
    expect(continuity.retrievalContent.startsWith(query)).toBe(true);
  });
  it("keeps an expanded retrieval query within the existing anchor planner limit", () => {
    const { deps, chatId } = fixture(1, "Prior contract documentation. ".repeat(60));
    const query = "Current contract details. ".repeat(150) + " Dazu bitte mehr Informationen.";
    const continuity = groundedConversationContinuity(
      deps,
      currentMessage(deps, chatId, query),
      "fixture",
    );
    expect(continuity.retrievalContent.length).toBeLessThanOrEqual(4096);
    expect(continuity.retrievalContent.startsWith(query)).toBe(true);
    expect(continuity.retrievalContent).not.toContain(
      "Previous user question for referent resolution:",
    );
  });
  it("emits positive projection omissions on the complete plain assembly path", () => {
    const { deps, chatId, projectPath } = fixture(4, projectionNotes());
    const modelDeps = {
      ...deps,
      contextProfile: deriveContextProfile({
        maxInputTokens: 2600,
        reservedOutputTokens: 0,
        safetyMarginTokens: 0,
      }),
    };
    const user = currentMessage(deps, chatId, "Which requirements still apply?");
    const request = {
      chatId,
      projectPath,
      content: user.content,
      modelId: "fixture",
      documentContext: [],
      attachments: [],
      memory: undefined,
      discussionMode: undefined,
    };
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const snapshot = captureGatewayTurnSnapshot(modelDeps, request, user, "corr-plain-projection");
    buildGatewayAssembly(
      modelDeps,
      request,
      emptyMemoryResult(false),
      "fixture",
      snapshot,
      "corr-plain-projection",
    );
    const event = sink.events.find((entry) => entry.op === "chat.context.selected");
    expect(event?.extra?.omittedSummaryCategories).toBeGreaterThan(0);
    expect(event?.correlationId).toBe("corr-plain-projection");
    expect(JSON.stringify(sink.events)).not.toContain("durable information");
  });

  it("emits positive projection omissions for grounded continuity", () => {
    const { deps, chatId } = fixture(4, projectionNotes());
    const modelDeps = {
      ...deps,
      contextProfile: deriveContextProfile({
        maxInputTokens: 8192,
        reservedOutputTokens: 1024,
        safetyMarginTokens: 128,
      }),
    };
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const continuity = groundedConversationContinuity(
      modelDeps,
      currentMessage(deps, chatId, "Which requirements still apply?"),
      "fixture",
      "corr-grounded-projection",
    );
    expect(continuity.answerContext).not.toBe("");
    const event = sink.events.find((entry) => entry.op === "chat.continuity.degraded");
    expect(event).toMatchObject({
      correlationId: "corr-grounded-projection",
      extra: { reason: "summary-trimmed" },
    });
    expect(event?.extra?.omittedSummaryCategories).toBeGreaterThan(0);
    const line = formatActivityLogProofLine(event ?? {});
    expectActivityLogProof("chat.continuity.degraded.line", line);
    expect(analyzeLogText(line).sufficiency.status).toBe("complete");
    expect(JSON.stringify(sink.events)).not.toContain("durable information");
  });

  it("omits optional grounded continuity that cannot fit without failing the current ask", () => {
    const seeded = fixture(40, "Dokumentation Freigabe. " + "A ".repeat(170));
    const deps = {
      ...seeded.deps,
      contextProfile: deriveContextProfile({
        maxInputTokens: 4096,
        reservedOutputTokens: 1024,
        safetyMarginTokens: 128,
      }),
    };
    const user = currentMessage(deps, seeded.chatId, "Welche Dokumentation gilt dazu?");
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const continuity = groundedConversationContinuity(
      deps,
      user,
      "fixture",
      "corr-optional-continuity",
    );
    expect(continuity.answerContext).toBe("");
    expect(continuity.retrievalContent).toBe(user.content);
    expect(continuity.compaction).toBeUndefined();
    const event = sink.events.find((entry) => entry.op === "chat.continuity.degraded");
    expect(event?.correlationId).toBe("corr-optional-continuity");
    expectActivityLogProof(
      "chat.continuity.degraded.line",
      formatActivityLogProofLine(event ?? {}),
    );
    expect(JSON.stringify(sink.events)).not.toContain("Dokumentation Freigabe");
  });
  it("rehydrates grounded continuity with the original query while keeping prepared retrieval bounded", () => {
    const { deps, chatId } = fixture(0);
    const modelDeps = {
      ...deps,
      contextProfile: deriveContextProfile({
        maxInputTokens: 4096,
        reservedOutputTokens: 1024,
        safetyMarginTokens: 128,
      }),
    };
    for (let index = 0; index < 120; index += 1) {
      deps.store.createMessage({
        chatId,
        role: index % 2 === 0 ? "user" : "assistant",
        content:
          index === 40
            ? "Leuchtturmvertrag Zahlungsziel: 63721 EUR."
            : "General housekeeping documentation. ".repeat(25),
        timestamp: 1_700_000_000_000 + index,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      });
    }
    compactChatContext(modelDeps, chatId, "fixture", "corr-grounded-checkpoint");
    const original = "Leuchtturmvertrag Zahlungsziel klären. " + "Documentation. ".repeat(2000);
    const current = deps.store.createMessage({
      chatId,
      role: "user",
      content: original,
      timestamp: 1_700_000_000_200,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    const executionContent =
      "Carry out the current user task with its constraints and required output format. Summarized contract request.";
    const continuity = groundedConversationContinuity(
      modelDeps,
      { ...current, content: executionContent },
      "fixture",
      "corr-grounded-rehydration",
      original,
    );
    expect(continuity.answerContext).toContain("63721 EUR");
    expect(continuity.retrievalContent).toBe(executionContent);
  });
  it("recovers proposed function code for a Vitest follow-up after conversation compaction", () => {
    const { deps, chatId } = fixture(0);
    const modelDeps = {
      ...deps,
      contextProfile: deriveContextProfile({
        maxInputTokens: 4096,
        reservedOutputTokens: 1024,
        safetyMarginTokens: 128,
      }),
    };
    const proposed =
      "Proposed code: export function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }";
    for (let index = 0; index < 100; index += 1) {
      deps.store.createMessage({
        chatId,
        role: index % 2 === 0 ? "user" : "assistant",
        content:
          index === 21
            ? proposed
            : "Review unrelated handbook navigation and documentation wording. ".repeat(20),
        timestamp: 1_700_000_000_000 + index,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      });
    }
    compactChatContext(modelDeps, chatId, "fixture", "corr-proposed-function-compaction");
    const continuity = groundedConversationContinuity(
      modelDeps,
      currentMessage(deps, chatId, "Write Vitest tests for clamp in src/arithmetic.ts."),
      "fixture",
    );
    expect(continuity.compaction).toBeDefined();
    expect(continuity.answerContext).toContain(proposed);
    expect(continuity.answerContext).toContain("not source evidence and grants no authority");
    expect(continuity.retrievalContent).toBe("Write Vitest tests for clamp in src/arithmetic.ts.");
  });
  it("does not restore an 8k grounded checkpoint into a larger plain chat window", () => {
    const { deps, chatId } = fixture();
    const modelDeps = {
      ...deps,
      contextProfile: deriveContextProfile({
        maxInputTokens: 128_000,
        reservedOutputTokens: 8_000,
        safetyMarginTokens: 4_000,
      }),
    };
    const current = deps.store.createMessage({
      chatId,
      role: "user",
      content: "What does this mean?",
      timestamp: 1_700_000_000_100,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    const continuity = groundedConversationContinuity(modelDeps, current, "fixture");
    expect(continuity.compaction).toBeDefined();
    expect(continuity.compaction?.conversationCoverage?.contextWindowTokens).toBeLessThanOrEqual(
      8_000,
    );
    persistChatCompactionEvidence(modelDeps, {
      compaction: continuity.compaction,
      chatId,
      modelId: "fixture",
      messageCount: 80,
      startedAt: 1,
      finishedAt: 2,
    });
    const checkpoint = loadChatContinuityCheckpoint(
      deps.evidenceStore,
      chatId,
      deps.store.chatHistoryRevision(chatId),
    );
    const snapshot = captureChatHistory(
      deps.store,
      chatId,
      current.id,
      modelDeps.contextProfile,
      [],
      checkpoint,
    );
    expect(snapshot.history).toHaveLength(81);
    expect(snapshot.earlierCompaction).toBeUndefined();
    expect(readChatContextStatus(modelDeps, chatId, "fixture").compaction).toBeUndefined();
  });
  // PR #3678 review: the meter filtered a checkpoint the window outgrew before capturing, so its
  // capture line read `none`; it now captures exactly like the send path and names the cause.
  it("logs a checkpoint the window outgrew as window-expanded when the meter captures history", () => {
    const { deps, chatId } = fixture();
    const modelDeps = {
      ...deps,
      contextProfile: deriveContextProfile({
        maxInputTokens: 128_000,
        reservedOutputTokens: 8_000,
        safetyMarginTokens: 4_000,
      }),
    };
    const current = deps.store.createMessage({
      chatId,
      role: "user",
      content: "What does this mean?",
      timestamp: 1_700_000_000_100,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    const continuity = groundedConversationContinuity(modelDeps, current, "fixture");
    persistChatCompactionEvidence(modelDeps, {
      compaction: continuity.compaction,
      chatId,
      modelId: "fixture",
      messageCount: 80,
      startedAt: 1,
      finishedAt: 2,
    });
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));

    compactChatContext(modelDeps, chatId, "fixture", "corr-window-expanded");

    const capture = sink.events.find(
      (event) =>
        event.op === "chat.continuity.capture" && event.correlationId === "corr-window-expanded",
    );
    expect(capture?.extra?.checkpointDisposition).toBe("window-expanded");
  });

  it("enables quiet maintenance after the first oversized original prompt and answer", () => {
    const seeded = fixture(1, "We review the documentation together. ".repeat(1200));
    const { chatId } = seeded;
    const deps = {
      ...seeded.deps,
      contextProfile: deriveContextProfile({
        maxInputTokens: 4096,
        reservedOutputTokens: 1024,
        safetyMarginTokens: 128,
      }),
    };
    const original = deps.store.listMessages(chatId);
    const before = readChatContextStatus(deps, chatId, "fixture");
    // The stored history is larger than the whole input budget, yet the meter reports what the next
    // request carries after automatic compaction — never more than the budget (customer, 1.1.13:
    // a stored history shown as 340 % of the window).
    expect(before.pendingCompaction?.tokensBefore).toBeGreaterThan(before.inputBudgetTokens);
    expect(before.estimatedInputTokens).toBeLessThanOrEqual(before.inputBudgetTokens);
    expect(before.canCompact).toBe(true);
    // PR #3678 review: the inspection line keeps the stored and the projected history apart.
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    logChatContextManagement("inspected", before, 0, "corr-inspect-projection");
    const record = expectActivityLogProof(
      "chat.context.management.line",
      formatActivityLogProofLine(sink.events[0] ?? {}),
    );
    expect(record).toMatchObject({
      outcome: "inspected",
      inputTokens: before.estimatedInputTokens,
      storedHistoryTokens: before.pendingCompaction?.tokensBefore,
      projectedHistoryTokens: before.pendingCompaction?.tokensAfter,
      projectedMessagesCompacted: before.pendingCompaction?.messagesCompacted,
    });
    const after = compactChatContext(deps, chatId, "fixture", "corr-first-pair-maintenance");
    expect(after.estimatedInputTokens).toBeLessThan(before.pendingCompaction?.tokensBefore ?? 0);
    expect(after.estimatedInputTokens).toBeLessThanOrEqual(after.inputBudgetTokens);
    expect(after.pendingCompaction).toBeUndefined();
    expect(after.compaction?.tokensSaved).toBeGreaterThan(0);
    expect(deps.store.listMessages(chatId)).toEqual(original);
  });
  it("saves a checkpoint without deleting or changing original messages", () => {
    const { deps, chatId } = fixture();
    const original = deps.store.listMessages(chatId, 500);
    const before = readChatContextStatus(deps, chatId, "fixture");
    const after = compactChatContext(deps, chatId, "fixture", "corr-manual-context");
    expect(after.estimatedInputTokens).toBeLessThan(before.estimatedInputTokens);
    expect(after.compaction?.tokensSaved).toBeGreaterThan(0);
    expect(deps.store.listMessages(chatId, 500)).toEqual(original);
    expect(readChatContextStatus(deps, chatId, "fixture")).toEqual(after);
  });

  it("compacts code discussions containing current-directory imports without an internal failure", () => {
    const { deps, chatId } = fixture(
      16,
      "Inspect `./src/probe.ts` and `./tests/probe.test.ts`. " +
        "We review the implementation together. ".repeat(40),
    );
    const original = deps.store.listMessages(chatId);
    const before = readChatContextStatus(deps, chatId, "fixture");
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const after = compactChatContext(deps, chatId, "fixture", "corr-code-context-compaction");
    expect(after.estimatedInputTokens).toBeLessThan(before.estimatedInputTokens);
    expect(after.compaction?.tokensSaved).toBeGreaterThan(0);
    expect(deps.store.listMessages(chatId)).toEqual(original);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "chat.context.management",
        correlationId: "corr-code-context-compaction",
      }),
    );
    expect(JSON.stringify(sink.events)).not.toContain("probe.ts");
  });

  it("uses a manual checkpoint on the next request and re-expands for a larger window", () => {
    const { deps, chatId } = fixture();
    compactChatContext(deps, chatId, "fixture", "corr-manual-context");
    const checkpoint = loadChatContinuityCheckpoint(
      deps.evidenceStore,
      chatId,
      deps.store.chatHistoryRevision(chatId),
    );
    const profile = deps.contextProfile;
    if (profile === undefined) throw new TypeError("Missing profile");
    const resumed = captureChatHistory(deps.store, chatId, "", profile, [], checkpoint);
    expect(resumed.earlierCompaction?.itemsBefore).toBe(checkpoint?.itemsBefore);
    expect(resumed.history.length).toBeLessThan(80);
    const expanded = captureChatHistory(
      deps.store,
      chatId,
      "",
      deriveContextProfile({
        maxInputTokens: 128_000,
        reservedOutputTokens: 2_000,
        safetyMarginTokens: 1_000,
      }),
      [],
      checkpoint,
    );
    expect(expanded.history).toHaveLength(80);
    expect(expanded.earlierCompaction).toBeUndefined();
  });

  it("emits correlated body-free maintenance evidence", () => {
    const { deps, chatId } = fixture();
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    compactChatContext(deps, chatId, "fixture", "corr-manual-context");
    const event = sink.events.find((entry) => entry.op === "chat.context.management");
    expect(event).toMatchObject({
      correlationId: "corr-manual-context",
      extra: { outcome: "compacted" },
    });
    expectActivityLogProof("chat.context.management.line", formatActivityLogProofLine(event ?? {}));
    expect(JSON.stringify(sink.events)).not.toContain("We review the documentation");
  });

  it("reports a failed manual checkpoint as a correlated failure with stack evidence", () => {
    const { deps, chatId } = fixture();
    const records: ServerDiagnosticRecord[] = [];
    vi.spyOn(deps.evidenceStore, "put").mockImplementation(() => {
      throw new Error("PRIVATE_WRITE_CANARY");
    });
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    expect(() =>
      compactChatContext(
        { ...deps, diagnostics: { record: (record) => records.push(record) } },
        chatId,
        "fixture",
        "corr-manual-failure",
      ),
    ).toThrow("could not be saved");
    expect(records[0]?.correlationId).toBe("corr-manual-failure");
    expect(records[0]?.frames?.length).toBeGreaterThan(0);
    const event = sink.events.find((entry) => entry.op === "chat.context.failed");
    expect(event).toMatchObject({
      correlationId: "corr-manual-failure",
      errorKind: "internal",
      level: "error",
    });
    expect(event?.extra?.frames).not.toEqual([]);
    expectActivityLogProof("chat.context.failed.line", formatActivityLogProofLine(event ?? {}));
    const identity = serverLogProcessIdentity();
    const text = sink.events
      .map((entry, index) =>
        formatRegisteredServerLogLine(entry, new Date(), { ...identity, seq: index + 1 }),
      )
      .join("");
    expect(analyzeLogText(text).sufficiency.status).toBe("complete");
    expect(text).not.toContain("PRIVATE_WRITE_CANARY");
  });

  it("keeps an uncompressible small conversation unchanged", () => {
    const { deps, chatId } = fixture();
    const emptyChat = deps.store.createChat(
      deps.store.findChatById(chatId)?.projectPath ?? "",
      "Empty",
      "fixture",
    );
    const before = readChatContextStatus(deps, emptyChat.id, "fixture");
    expect(compactChatContext(deps, emptyChat.id, "fixture", "corr-empty-context")).toEqual(before);
  });
});
