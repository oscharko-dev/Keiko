import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveContextProfile } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { activityLogEventRegistration } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  createFileServerLogSink,
  createServerLogger,
  setServerLogger,
  type ServerLogEvent,
  type ServerLogSink,
} from "@oscharko-dev/keiko-activity-log";
import { resetServerLogger } from "./support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "./support/buffered-server-log.js";
import { logChatContextManagement } from "../packages/keiko-server/src/chat-context-log.js";
import { logChatContextSelection } from "../packages/keiko-server/src/chat-activity.js";
import {
  logChatHistoryCapture,
  logChatRehydration,
  logGroundedContinuityDegradation,
} from "../packages/keiko-server/src/chat-continuity-log.js";
import { compactCurrentChatPrompt } from "../packages/keiko-server/src/chat-prompt-compaction.js";
import { selectGatewayPromptAssembly } from "../packages/keiko-server/src/chat-prompt-budget.js";
import {
  createInMemoryUiStore,
  type ChatMessage,
} from "../packages/keiko-server/src/store/index.js";
import { captureChatHistory } from "../packages/keiko-server/src/chat-history-snapshot.js";
import {
  DEFAULT_SUPPORT_QUERY_LIMITS,
  runSupportQuery,
  type SupportQueryResult,
} from "../packages/keiko-activity-log/src/reader/support-query.js";
import {
  ActivityLogScanner,
  ensureSegmentManifests,
  listActivityLogStoreFiles,
} from "../packages/keiko-activity-log/src/reader/support-segment-scan.js";

const CORRELATION = "chat-context-query-fixture";
const STATUS = { estimatedInputTokens: 1000, inputBudgetTokens: 2000 };
type ManagementOutcome = Parameters<typeof logChatContextManagement>[0];

function capture(emit: () => void): readonly ServerLogEvent[] {
  const buffer = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink: buffer, level: "debug" }));
  emit();
  return buffer.events;
}

function management(outcome: ManagementOutcome): readonly ServerLogEvent[] {
  return capture(() => {
    logChatContextManagement(outcome, STATUS, 100, CORRELATION);
  });
}

function historyCapture(
  checkpointDisposition: Parameters<typeof logChatHistoryCapture>[0]["checkpointDisposition"],
  correlationId = CORRELATION,
): readonly ServerLogEvent[] {
  return capture(() => {
    logChatHistoryCapture(
      {
        checkpointDisposition,
        historyRevision: 10,
        unitsVisited: 50,
        foldedItems: 30,
        retainedItems: 20,
        contextWindowTokens: 4096,
      },
      correlationId,
    );
  });
}

function query(stateDir: string): SupportQueryResult {
  const files = listActivityLogStoreFiles(stateDir);
  const scanner = new ActivityLogScanner(stateDir);
  const pass = ensureSegmentManifests(stateDir, files, scanner, {
    trigger: "query",
    persist: false,
    rebuild: false,
  });
  return runSupportQuery({
    files,
    scanner,
    manifests: pass.manifests,
    manifestStats: pass.stats,
    selection: {
      kind: "closure",
      queryClass: "incident",
      roots: [],
      windows: [{ fromMs: 0, toMs: Date.now() + 1000 }],
      requiredClasses: { kind: "observed-failures" },
      unresolved: false,
    },
    limits: { ...DEFAULT_SUPPORT_QUERY_LIMITS, maxContextEvents: 0 },
  });
}

function historyMessage(index: number): ChatMessage {
  const notes = Array.from({ length: 16 }, (_, item) =>
    ["Fact", "Decision", "Constraint"]
      .map((kind) => `${kind}: Requirement ${String(item)} ${"durable information ".repeat(10)}`)
      .join("\n"),
  ).join("\n");
  return {
    id: `message-${String(index)}`,
    chatId: "chat-query-fixture",
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Note ${String(Math.floor(index / 2))}. ${notes}`,
    timestamp: 1_700_000_000_000 + index,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
}

function historySnapshot(
  withHistory: boolean,
  profile: ReturnType<typeof deriveContextProfile>,
): ReturnType<typeof captureChatHistory> {
  const store = createInMemoryUiStore();
  try {
    store.createProject(tmpdir(), "Chat context fixture");
    const chatId = store.createChat(tmpdir(), "Chat context fixture", "fixture-model").id;
    for (let index = 0; index < (withHistory ? 8 : 0); index += 1)
      store.createMessage({ ...historyMessage(index), chatId });
    const current = store.createMessage({
      ...historyMessage(8),
      chatId,
      content: "Which requirements still apply?",
    });
    return captureChatHistory(store, chatId, current.id, profile, [], undefined, {
      correlationId: "assembly-preparation",
    });
  } finally {
    store.close();
  }
}

function selection(withHistory: boolean): readonly ServerLogEvent[] {
  const profile = deriveContextProfile({
    maxInputTokens: 2600,
    reservedOutputTokens: 0,
    safetyMarginTokens: 0,
  });
  const snapshot = historySnapshot(withHistory, profile);
  const assembly = selectGatewayPromptAssembly({
    proactiveCompaction: true,
    historyPrefix: snapshot.history.filter(
      (message) => message.id !== snapshot.currentUserMessageId,
    ),
    historyTurnCount: snapshot.history.length,
    earlierCompaction: snapshot.earlierCompaction,
    request: { content: "Which requirements still apply?", discussionMode: undefined },
    profile,
    memoryEntries: [],
    documentContext: [],
    redactionSecrets: [],
  });
  if (assembly === undefined) throw new TypeError("Expected a real budgeted chat assembly");
  return capture(() => {
    logChatContextSelection(CORRELATION, assembly, 0);
  });
}

describe("manual support selection of actual Chat context producers", () => {
  let stateDir: string;
  let sink: ServerLogSink;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-support-chat-context-"));
    sink = createFileServerLogSink(stateDir, { level: "debug" });
    // A running server already owns its writer. Its first-append readiness must not
    // accidentally retain the unrelated Chat request being tested.
    for (const event of historyCapture("none", "writer-bootstrap")) sink.write(event);
  });
  afterEach(() => {
    resetServerLogger();
    sink.close?.();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function selected(events: readonly ServerLogEvent[], op: string): boolean {
    for (const event of events) sink.write(event);
    sink.flush?.();
    return query(stateDir).events.some(
      (entry) => entry.parsed.view.op === op && entry.parsed.correlationId === CORRELATION,
    );
  }

  it.each(["failed", "prompt-failed"] as const)(
    "declares actual informational management failure %s",
    (outcome) => {
      const events = management(outcome);
      expect(events[0]).toMatchObject({
        level: "info",
        extra: { outcome, completeness: "complete", loss: "none" },
      });
      expect(events[0]?.errorKind).toBeUndefined();
      expect(activityLogEventRegistration(events[0] ?? {})).toMatchObject({
        diagnosticWhen: [{ field: "outcome", values: ["failed", "prompt-failed"] }],
      });
    },
  );

  it.each(["failed", "prompt-failed"] as const)(
    "retains actual failed management %s with no optional context",
    (outcome) => {
      expect(selected(management(outcome), "chat.context.management")).toBe(true);
    },
  );

  it.each([
    "inspected",
    "compacted",
    "unchanged",
    "summary-discarded",
    "prompt-compacted",
  ] as const)("leaves normal management %s and positive token metrics optional", (outcome) => {
    expect(selected(management(outcome), "chat.context.management")).toBe(false);
  });

  it("retains an actual current-prompt compaction failure and preserves its thrown cause", async () => {
    const buffer = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink: buffer, level: "info" }));
    const failure = new TypeError("Synthetic model failure");
    await expect(
      compactCurrentChatPrompt({
        content: "Important requirements. ".repeat(1600),
        modelId: "query-fixture-model",
        profile: deriveContextProfile({
          maxInputTokens: 4096,
          reservedOutputTokens: 1024,
          safetyMarginTokens: 128,
        }),
        call: () => Promise.reject(failure),
        signal: new AbortController().signal,
        correlationId: CORRELATION,
        redact: (value) => value,
      }),
    ).rejects.toBe(failure);
    expect(buffer.events).toHaveLength(1);
    expect(buffer.events[0]?.extra).toMatchObject({ outcome: "prompt-failed" });
    expect(selected(buffer.events, "chat.context.management")).toBe(true);
  });

  it("declares actual omitted plain-Chat summary categories as diagnostic evidence", () => {
    const events = selection(true);
    expect(events[0]?.extra?.omittedSummaryCategories).toBeGreaterThan(0);
    expect(activityLogEventRegistration(events[0] ?? {})).toMatchObject({
      diagnosticWhen: [{ field: "omittedSummaryCategories", positive: true }],
    });
  });

  it("retains actual omitted plain-Chat summary categories with no optional context", () => {
    const events = selection(true);
    expect(events[0]?.extra?.omittedSummaryCategories).toBeGreaterThan(0);
    expect(selected(events, "chat.context.selected")).toBe(true);
  });

  it("leaves a complete plain-Chat assembly and its positive prompt counts optional", () => {
    const events = selection(false);
    expect(events[0]?.extra).toMatchObject({ omittedSummaryCategories: 0 });
    expect(events[0]?.extra?.promptTokens).toBeGreaterThan(0);
    expect(selected(events, "chat.context.selected")).toBe(false);
  });

  it.each([
    "none",
    "read-failed",
    "restored",
    "revision-mismatch",
    "window-expanded",
    "input-budget-expanded",
    "current-turn-protected",
    "boundary-missing",
  ] as const)("preserves the existing checkpoint %s completeness semantics", (disposition) => {
    const events = historyCapture(disposition);
    expect(events[0]?.extra?.completeness).toBe(
      disposition === "read-failed" ? "partial" : "complete",
    );
    expect(selected(events, "chat.continuity.capture")).toBe(disposition === "read-failed");
  });

  it.each(["complete", "unit-limit", "character-limit", "best-matches", "no-query-terms"] as const)(
    "preserves the existing rehydration %s completeness semantics",
    (scanDisposition) => {
      const events = capture(() => {
        logChatRehydration(
          {
            scanDisposition,
            unitsVisited: 50,
            scannedChars: 1000,
            candidateCount: 20,
            excerptCount: 10,
            rehydratedTokens: 100,
          },
          CORRELATION,
        );
      });
      const incomplete = scanDisposition === "unit-limit" || scanDisposition === "character-limit";
      expect(events[0]?.extra?.completeness).toBe(incomplete ? "partial" : "complete");
      expect(selected(events, "chat.continuity.rehydration")).toBe(incomplete);
    },
  );

  it.each([0, 2])(
    "retains existing continuity degradation with %i omitted categories",
    (omitted) => {
      const events = capture(() => {
        logGroundedContinuityDegradation(2000, CORRELATION, omitted);
      });
      expect(events[0]?.level).toBe("warn");
      expect(selected(events, "chat.continuity.degraded")).toBe(true);
    },
  );
});
