import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { deriveContextProfile } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import { compactChatContext, readChatContextStatus } from "./chat-context-status.js";
import { captureChatHistory } from "./chat-history-snapshot.js";
import { loadChatContinuityCheckpoint } from "./chat-compaction-resurfacing.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { groundedConversationContinuity } from "./grounded-conversation-continuity.js";
import { persistChatCompactionEvidence } from "./chat-compaction-evidence.js";

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
): { deps: UiHandlerDeps; chatId: string } {
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
  return { deps, chatId };
}

describe("composer context status and manual maintenance", () => {
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
    expect(before.estimatedInputTokens).toBeGreaterThan(before.inputBudgetTokens);
    expect(before.canCompact).toBe(true);
    const after = compactChatContext(deps, chatId, "fixture", "corr-first-pair-maintenance");
    expect(after.estimatedInputTokens).toBeLessThan(before.estimatedInputTokens);
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
