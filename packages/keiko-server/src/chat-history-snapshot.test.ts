import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { deriveContextProfile } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { createInMemoryUiStore, type ChatMessage, type UiStore } from "./store/index.js";
import { captureChatHistory } from "./chat-history-snapshot.js";
import { rehydrateChatHistory } from "./chat-history-rehydration.js";

const stores: UiStore[] = [];
const paths: string[] = [];
afterEach(() => {
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
