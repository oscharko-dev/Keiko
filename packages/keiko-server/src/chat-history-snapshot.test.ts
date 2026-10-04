import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  deriveContextProfile,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { createInMemoryUiStore, type ChatMessage, type UiStore } from "./store/index.js";
import { captureChatHistory, checkpointFitsProfile } from "./chat-history-snapshot.js";
import { rehydrateChatHistory } from "./chat-history-rehydration.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";

const stores: UiStore[] = [];
const paths: string[] = [];
afterEach(() => {
  resetServerLogger();
  for (const store of stores.splice(0)) store.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): {
  store: UiStore;
  chatId: string;
  add: (role: "user" | "assistant", content: string) => ChatMessage;
} {
  const store = createInMemoryUiStore();
  stores.push(store);
  const path = mkdtempSync(join(tmpdir(), "keiko-history-"));
  paths.push(path);
  store.createProject(path, "History fixture");
  const chatId = store.createChat(path, "Continuity fixture", "fixture").id;
  let timestamp = 1_700_000_000_000;
  return {
    store,
    chatId,
    add: (role, content) =>
      store.createMessage({
        chatId,
        role,
        content,
        timestamp: timestamp++,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      }),
  };
}

function profile(tokens: number): ReturnType<typeof deriveContextProfile> {
  return deriveContextProfile({
    maxInputTokens: tokens,
    reservedOutputTokens: 0,
    safetyMarginTokens: 0,
  });
}

describe("paged conversation continuity", () => {
  it.each([32_000, 128_000])(
    "re-expands a grounded checkpoint to the full %i-token verbatim tail even when history still overflows",
    (window) => {
      const { store, chatId, add } = fixture();
      for (let index = 0; index < 240; index += 1) {
        add("user", `Question ${String(index)}: ${"Long conversation reference. ".repeat(100)}`);
        add("assistant", `Answer ${String(index)}: ${"Detailed reference response. ".repeat(100)}`);
      }
      const current = add("user", "Continue with the complete conversation.");
      const plainProfile = profile(window);
      const plain = captureChatHistory(store, chatId, current.id, plainProfile, []);
      expect(plain.earlierCompaction).toBeDefined();
      const grounded = captureChatHistory(
        store,
        chatId,
        current.id,
        profile(8000),
        [],
        plain.earlierCompaction,
      );
      expect(grounded.earlierCompaction?.conversationCoverage?.contextWindowTokens).toBe(8000);
      expect(grounded.history.length).toBeLessThan(plain.history.length);
      const restored = captureChatHistory(
        store,
        chatId,
        current.id,
        plainProfile,
        [],
        grounded.earlierCompaction,
      );
      expect(restored.history.map((message) => message.id)).toEqual(
        plain.history.map((message) => message.id),
      );
      const repeated = captureChatHistory(
        store,
        chatId,
        current.id,
        plainProfile,
        [],
        restored.earlierCompaction,
      );
      expect(repeated.history.map((message) => message.id)).toEqual(
        plain.history.map((message) => message.id),
      );
    },
  );
  it.each(["user", "assistant"] as const)(
    "retains the current user unit when the checkpoint boundary is its %s",
    (boundaryRole) => {
      const { store, chatId, add } = fixture();
      add("user", "An older question");
      add("assistant", "An older answer");
      const user = add("user", "The mandatory current question");
      const assistant = add("assistant", "The answer being regenerated");
      const checkpoint = {
        schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
        laneId: "history-summary" as const,
        reason: "manual maintenance",
        itemsBefore: 3,
        itemsAfter: 1,
        tokensBefore: 100,
        tokensAfter: 20,
        conversationCoverage: {
          version: 1 as const,
          throughMessageId: boundaryRole === "user" ? user.id : assistant.id,
          historyRevision: store.chatHistoryRevision(chatId),
          contextWindowTokens: 4096,
        },
      };
      const snapshot = captureChatHistory(store, chatId, user.id, profile(4096), [], checkpoint);
      expect(snapshot.history.map((message) => message.id)).toContain(user.id);
      expect(snapshot.history.find((message) => message.id === user.id)?.content).toBe(
        user.content,
      );
      expect(snapshot.earlierCompaction?.conversationCoverage?.throughMessageId).not.toBe(user.id);
    },
  );
  it("retains all budget-safe turns across database page boundaries", () => {
    const { store, chatId, add } = fixture();
    for (let i = 0; i < 90; i += 1) {
      add("user", `Question ${String(i)}`);
      add("assistant", `Answer ${String(i)}`);
    }
    const current = add("user", "Continue");
    const snapshot = captureChatHistory(store, chatId, current.id, profile(32_000), []);
    expect(snapshot.history).toHaveLength(181);
    expect(snapshot.earlierCompaction).toBeUndefined();
    expect(snapshot.history.map((message) => message.timestamp)).toEqual(
      [...snapshot.history.map((message) => message.timestamp)].sort((a, b) => a - b),
    );
  });

  it("resumes a checkpoint and re-expands its original turns on a larger model", () => {
    const { store, chatId, add } = fixture();
    for (let i = 0; i < 30; i += 1) {
      add("user", `Unser Budget beträgt ${i === 0 ? "75000" : "60000"} Euro.\n${"x".repeat(600)}`);
      add("assistant", "Verstanden. ".repeat(40));
    }
    const current = add("user", "Wie hoch ist unser Budget?");
    const first = captureChatHistory(store, chatId, current.id, profile(2_000), []);
    expect(first.earlierCompaction).toBeDefined();
    const resumed = captureChatHistory(
      store,
      chatId,
      current.id,
      profile(2_000),
      [],
      first.earlierCompaction,
    );
    expect(resumed).toEqual(first);
    expect(
      resumed.earlierCompaction?.preservedFacts?.some((fact) => fact.statement.includes("60000")),
    ).toBe(true);
    expect(resumed.history[0]?.role).toBe("user");
    const expanded = captureChatHistory(
      store,
      chatId,
      current.id,
      profile(64_000),
      [],
      first.earlierCompaction,
    );
    expect(expanded.history).toHaveLength(61);
    expect(expanded.earlierCompaction).toBeUndefined();
  });

  it("re-expands original turns when the input ceiling grows inside the same model window", () => {
    const { store, chatId, add } = fixture();
    for (let index = 0; index < 30; index += 1) {
      add("user", `Question ${String(index)} ${"x".repeat(600)}`);
      add("assistant", "Understood. ".repeat(40));
    }
    const current = add("user", "Continue with the original turns.");
    const restricted = deriveContextProfile({
      maxInputTokens: 128_000,
      inputTokenLimit: 2_000,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    });
    const first = captureChatHistory(store, chatId, current.id, restricted, []);
    expect(first.earlierCompaction).toBeDefined();
    const expanded = captureChatHistory(
      store,
      chatId,
      current.id,
      deriveContextProfile({ ...restricted, inputTokenLimit: 64_000 }),
      [],
      first.earlierCompaction,
    );
    expect(expanded.history).toHaveLength(61);
    expect(expanded.earlierCompaction).toBeUndefined();
  });

  it("preserves legacy checkpoint fallback and invalidates only a larger stamped input budget", () => {
    const { store, chatId, add } = fixture();
    for (let index = 0; index < 30; index += 1) {
      add("user", "Original context. ".repeat(100));
      add("assistant", "Understood.");
    }
    const current = add("user", "Continue.");
    const restricted = deriveContextProfile({
      maxInputTokens: 128_000,
      inputTokenLimit: 2_000,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    });
    const record = captureChatHistory(store, chatId, current.id, restricted, []).earlierCompaction;
    if (record?.conversationCoverage === undefined) throw new TypeError("Missing checkpoint");
    const { effectiveInputBudget, ...legacyCoverage } = record.conversationCoverage;
    expect(effectiveInputBudget).toBe(2_000);
    const expanded = deriveContextProfile({ ...restricted, inputTokenLimit: 64_000 });
    expect(checkpointFitsProfile(record, expanded)).toBe(false);
    expect(checkpointFitsProfile(record, restricted)).toBe(true);
    expect(
      checkpointFitsProfile(
        record,
        deriveContextProfile({ ...restricted, inputTokenLimit: 1_000 }),
      ),
    ).toBe(true);
    expect(
      checkpointFitsProfile({ ...record, conversationCoverage: legacyCoverage }, expanded),
    ).toBe(true);
  });

  it("rehydrates a middle-of-history German correction with stable source ids", () => {
    const { store, chatId, add } = fixture();
    add("user", "Das Budget beträgt 75000 Euro.");
    add("assistant", "Verstanden.");
    const correction = add("user", "Korrektur: Das Budget beträgt jetzt 60000 Euro.");
    add("assistant", "Verstanden.");
    for (let i = 0; i < 80; i += 1) {
      add("user", "Wir prüfen die Dokumentation.");
      add("assistant", "Verstanden.");
    }
    const result = rehydrateChatHistory(store, chatId, "Wie hoch ist das Budget?", new Set(), []);
    expect(result).toContain(correction.id);
    expect(result).toContain("60000");
    expect(result?.indexOf("75000")).toBeLessThan(result?.indexOf("60000") ?? -1);
  });

  it("keeps corrections reachable after repeated follow-up questions and duplicate answers", () => {
    const { store, chatId, add } = fixture();
    add("user", "Das Projekt heißt Linden. Unser Budget beträgt 75000 Euro.");
    add("assistant", "Verstanden.");
    const correction = add("user", "Korrektur: Unser Budget beträgt jetzt 60000 Euro.");
    add("assistant", "Verstanden.");
    const query =
      "Fasse bitte die gültigen Eckdaten von vorhin zusammen. Antworte ausschließlich als JSON mit project, budgetEUR und deadline. Nutze die jüngste Korrektur.";
    for (let index = 0; index < 12; index += 1) {
      add("user", query);
      add("assistant", '{"project":"Linden","budgetEUR":60000,"deadline":"19. November"}');
    }
    const result = rehydrateChatHistory(store, chatId, query, new Set(), []);
    expect(result).toContain(correction.id);
    expect(result?.match(/budgetEUR/gu)).toHaveLength(1);
    expect(result).not.toContain(query);
  });

  it("rehydrates a correction near the end of a large pasted user prompt", () => {
    const { store, chatId, add } = fixture();
    const source = add(
      "user",
      "Unser Budget beträgt 75000 Euro.\n" +
        "Die Dokumentation wird geprüft.\n".repeat(800) +
        "Verbindliche Korrektur: Das Budget beträgt jetzt 60000 Euro.",
    );
    add("assistant", "Verstanden.");
    const result = rehydrateChatHistory(
      store,
      chatId,
      "Welches Budget ist aktuell?",
      new Set(),
      [],
    );
    expect(result).toContain(source.id);
    expect(result).toContain("60000");
    expect(result).not.toContain("75000");
  });

  it.each([
    "Was ist das aktuelle Budget für Projekt Linden nach der letzten Korrektur?",
    "Was ist das aktuelle Budget für Projekt Linden? Antworte als JSON mit budgetEUR, deadline, owner und symbol.",
  ])(
    "keeps the correction paragraph when later output keys also match the follow-up: %s",
    (query) => {
      const { store, chatId, add } = fixture();
      add(
        "user",
        "Projekt Linden: Budget 75000 Euro.\n" +
          "Projektunterlagen ohne neue Entscheidung.\n".repeat(800) +
          "Verbindliche Korrektur: Budget jetzt 60000 Euro, Termin jetzt 19. November, Verantwortliche Mara Linke, Symbol parseLocalStateFlags. Antworte ausschließlich als JSON mit budgetEUR, deadline, owner und symbol. Verwende die korrigierten Werte.",
      );
      add("assistant", "Verstanden.");
      const result = rehydrateChatHistory(store, chatId, query, new Set(), []);
      expect(result).toContain("60000");
      expect(result).toContain("19. November");
      expect(result).toContain("Mara Linke");
      expect(result).not.toContain("75000");
    },
  );
});

it("keeps excerpt offsets in the original Unicode text when lowercase expansion changes length", () => {
  const { store, chatId, add } = fixture();
  add(
    "user",
    "İstanbul documentation without decisions. ".repeat(800) +
      "\nKorrektur: Das Budget beträgt jetzt 60000 Euro.",
  );
  add("assistant", "Verstanden.");
  const result = rehydrateChatHistory(store, chatId, "Welches Budget ist aktuell?", new Set(), []);
  expect(result).toContain("60000");
});

it("rehydrates source facts matched by letters outside the Unicode basic plane", () => {
  const { store, chatId, add } = fixture();
  const source = add("user", "𐐀𐐁𐐂𐐃𐐄: The corrected budget is 900 euros.");
  add("assistant", "Understood.");
  const result = rehydrateChatHistory(store, chatId, "𐐀𐐁𐐂𐐃𐐄?", new Set(), []);
  expect(result).toContain(source.id);
  expect(result).toContain("900 euros");
});

it("bounds optional recall work while retaining the newest matching correction", () => {
  const { store, chatId, add } = fixture();
  for (let index = 0; index < 1_100; index += 1) {
    add("user", "Unrelated documentation without the requested subject.");
    add("assistant", "Acknowledged.");
  }
  add("user", "Correction: the budget is now 60000 euros.");
  add("assistant", "Acknowledged.");
  const visit = store.visitGatewayMessageUnits.bind(store);
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  let unitsVisited = 0;
  vi.spyOn(store, "visitGatewayMessageUnits").mockImplementation((id, current, visitor) => {
    visit(id, current, (unit) => {
      unitsVisited += 1;
      return visitor(unit);
    });
  });
  const result = rehydrateChatHistory(
    store,
    chatId,
    "What is the budget?",
    new Set(),
    [],
    "corr-recall-limit",
  );
  expect(result).toContain("60000 euros");
  expect(unitsVisited).toBeLessThanOrEqual(1024);
  const event = sink.events.find((entry) => entry.op === "chat.continuity.rehydration");
  expect(event).toMatchObject({
    correlationId: "corr-recall-limit",
    extra: { unitsVisited: 1024, scanDisposition: "unit-limit", completeness: "partial" },
  });
  expectActivityLogProof(
    "chat.continuity.rehydration.line",
    formatActivityLogProofLine(event ?? {}),
  );
  expect(JSON.stringify(sink.events)).not.toContain("60000 euros");
});

it("bounds scanned characters and final token cost while searching the latest part of a huge source", () => {
  const { store, chatId, add } = fixture();
  add("user", "Unrelated notes. ".repeat(80_000) + "\nCorrection: the budget is 60000 euros.");
  add("assistant", "Acknowledged.");
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  const result = rehydrateChatHistory(
    store,
    chatId,
    "What is the budget?",
    new Set(),
    [],
    "corr-character-limit",
  );
  expect(result).toContain("60000 euros");
  const event = sink.events.find((entry) => entry.op === "chat.continuity.rehydration");
  expect(event).toMatchObject({
    correlationId: "corr-character-limit",
    extra: { scannedChars: 1_048_576, scanDisposition: "character-limit", completeness: "partial" },
  });
  expect(Number(event?.extra?.rehydratedTokens)).toBeLessThanOrEqual(800);
  expectActivityLogProof(
    "chat.continuity.rehydration.line",
    formatActivityLogProofLine(event ?? {}),
  );
});

it("reports checkpoint reuse, model expansion and revision invalidation without conversation bodies", () => {
  const { store, chatId, add } = fixture();
  for (let index = 0; index < 30; index += 1) {
    add("user", "Budget 60000 euros. ".repeat(40));
    add("assistant", "Acknowledged. ".repeat(30));
  }
  const current = add("user", "Continue");
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  const first = captureChatHistory(store, chatId, current.id, profile(2000), [], undefined, {
    correlationId: "corr-capture",
  });
  const checkpoint = first.earlierCompaction;
  if (checkpoint?.conversationCoverage === undefined) throw new TypeError("Missing checkpoint");
  captureChatHistory(store, chatId, current.id, profile(2000), [], checkpoint, {
    correlationId: "corr-capture",
  });
  captureChatHistory(store, chatId, current.id, profile(64000), [], checkpoint, {
    correlationId: "corr-capture",
  });
  captureChatHistory(
    store,
    chatId,
    current.id,
    profile(2000),
    [],
    {
      ...checkpoint,
      conversationCoverage: { ...checkpoint.conversationCoverage, historyRevision: -1 },
    },
    { correlationId: "corr-capture" },
  );
  const events = sink.events.filter((entry) => entry.op === "chat.continuity.capture");
  expect(events.map((event) => event.extra?.checkpointDisposition)).toEqual([
    "none",
    "restored",
    "window-expanded",
    "revision-mismatch",
  ]);
  for (const event of events) {
    expect(event.correlationId).toBe("corr-capture");
    expectActivityLogProof("chat.continuity.capture.line", formatActivityLogProofLine(event));
  }
  expect(JSON.stringify(events)).not.toContain("Budget 60000 euros");
});

function canonicalTurn(
  store: UiStore,
  chatId: string,
  index: number,
  assistantTime = index * 2 + 1,
): void {
  const draft = (
    role: "user" | "assistant",
    timestamp: number,
  ): Parameters<UiStore["createMessage"]>[0] => ({
    chatId,
    role,
    content: `${role} ${String(index)}`,
    timestamp,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });

  const turnId = `turn-${String(index)}`;
  const turn = store.admitChatTurn(turnId, draft("user", index * 2));
  if (turn.kind !== "admitted") throw new TypeError("Expected fixture admission");
  const assistant = store.createTurnAssistant(
    turn.userMessage.id,
    draft("assistant", assistantTime),
  );
  store.completeChatTurn(chatId, turnId, turn.userMessage.content, assistant.id);
}

it("visits canonical turns newest first even when assistant clocks cross multiple pages", () => {
  const { store, chatId } = fixture();
  for (let i = 0; i < 100; i += 1) canonicalTurn(store, chatId, i, -1000 - i);
  const anchors: string[] = [];
  store.visitGatewayMessageUnits(chatId, "", (unit) => {
    anchors.push(unit[0]?.content ?? "missing");
  });
  expect(anchors).toEqual(Array.from({ length: 100 }, (_, i) => `user ${String(99 - i)}`));
});

it("keeps a prefix revision stable while an ordinary canonical turn completes", () => {
  const { store, chatId } = fixture();
  const before = store.chatHistoryRevision(chatId);
  canonicalTurn(store, chatId, 1);
  expect(store.chatHistoryRevision(chatId)).toBe(before);
});

it("invalidates revisions for regeneration and backdated history insertion", () => {
  const { store, chatId, add } = fixture();
  add("user", "Original question");
  const assistant = add("assistant", "Original answer");
  const before = store.chatHistoryRevision(chatId);
  store.createAssistantResponseVersion(assistant.id, "Corrected answer", assistant.timestamp + 1);
  expect(store.chatHistoryRevision(chatId)).toBeGreaterThan(before);
  const after = store.chatHistoryRevision(chatId);
  canonicalTurn(store, chatId, 1);
  expect(store.chatHistoryRevision(chatId)).toBeGreaterThan(after);
});

it("rebuilds a stale checkpoint after a canonical answer is regenerated", () => {
  const { store, chatId } = fixture();
  for (let i = 0; i < 30; i += 1) canonicalTurn(store, chatId, i);
  const first = captureChatHistory(store, chatId, "", profile(200), []);
  expect(first.earlierCompaction).toBeDefined();
  const assistant = store.listMessages(chatId).find((message) => message.content === "assistant 0");
  if (assistant === undefined) throw new TypeError("Missing fixture assistant");
  store.createAssistantResponseVersion(assistant.id, "Fact: Revised milestone is Delta.", 1000);
  const refreshed = captureChatHistory(
    store,
    chatId,
    "",
    profile(200),
    [],
    first.earlierCompaction,
  );
  expect(refreshed.earlierCompaction?.preservedFacts).toEqual(
    expect.arrayContaining([expect.objectContaining({ statement: "Revised milestone is Delta." })]),
  );
});
