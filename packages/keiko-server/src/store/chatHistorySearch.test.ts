import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createInMemoryUiStore,
  createNodeUiStore,
  type NewChatMessage,
  type UiStore,
} from "./index.js";
import { rehydrateChatHistory } from "../chat-history-rehydration.js";

const stores: UiStore[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function message(
  chatId: string,
  role: "user" | "assistant",
  content: string,
  timestamp: number,
): NewChatMessage {
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

function fixture(): { readonly store: UiStore; readonly chatId: string; readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "keiko-chat-search-"));
  roots.push(root);
  const store = createInMemoryUiStore();
  stores.push(store);
  store.createProject(root, "Search fixture");
  return { store, root, chatId: store.createChat(root, "Search", "fixture").id };
}

function found(
  store: UiStore,
  chatId: string,
  value = "needle",
  kind: "identifier" | "word-prefix" = "word-prefix",
): readonly string[] {
  const ids = new Set<string>();
  store.searchGatewayMessageUnits(chatId, [{ value, kind }], (unit) => {
    for (const row of unit) ids.add(row.id);
  });
  return [...ids].sort();
}

function complete(store: UiStore, chatId: string, id: string, timestamp: number): void {
  const user = message(chatId, "user", "needle canonical fact", timestamp);
  const admission = store.admitChatTurn(id, user);
  if (admission.kind !== "admitted") throw new TypeError("Fixture admission failed");
  const answer = store.createTurnAssistant(
    admission.userMessage.id,
    message(chatId, "assistant", "needle canonical answer", timestamp - 1),
  );
  expect(store.completeChatTurn(chatId, id, user.content, answer.id).kind).toBe("completed");
}

it("admits exactly the ordinary canonical and legacy units, including skewed partner timestamps", () => {
  const { store, chatId } = fixture();
  store.createMessage(message(chatId, "assistant", "needle orphan assistant", 0));
  complete(store, chatId, "canonical", 10);
  store.createMessage(message(chatId, "user", "needle legacy fact", 20));
  store.createMessage(message(chatId, "assistant", "needle legacy answer", 21));
  store.admitChatTurn("pending", message(chatId, "user", "needle pending fact", 30));
  store.admitChatTurn("failed", message(chatId, "user", "needle failed fact", 31));
  store.failChatTurn(chatId, "failed");
  store.createMessage(message(chatId, "user", "needle orphan user", 40));
  const ordinary: string[] = [];
  store.visitGatewayMessageUnits(chatId, "", (unit) => {
    ordinary.push(...unit.map((row) => row.id));
  });
  expect(ordinary).toHaveLength(4);
  expect(found(store, chatId)).toEqual(ordinary.sort());
});

it("does not return another chat's matches and maintains edits and cascading deletion", () => {
  const { store, chatId, root } = fixture();
  const user = store.createMessage(message(chatId, "user", "Original question", 1));
  const answer = store.createMessage(message(chatId, "assistant", "needle local fact", 2));
  const other = store.createChat(root, "Other", "fixture").id;
  store.createMessage(message(other, "user", "needle separate fact", 3));
  store.createMessage(message(other, "assistant", "Acknowledged", 4));
  expect(found(store, chatId)).toContain(user.id);
  store.createAssistantResponseVersion(answer.id, "Replacement without a match", 5);
  expect(found(store, chatId)).toEqual([]);
  expect(found(store, other)).toHaveLength(2);
  store.deleteChat(other);
  expect(found(store, other)).toEqual([]);
});

it("indexes short identifiers and internal German compound fragments", () => {
  const { store, chatId } = fixture();
  const user = store.createMessage(message(chatId, "user", "Die Vorgangskennung ist A7.", 1));
  store.createMessage(message(chatId, "assistant", "Acknowledged", 2));
  expect(found(store, chatId, "A7", "identifier")).toContain(user.id);
  expect(found(store, chatId, "kennu")).toContain(user.id);
});

it.each(["pending", "orphan-assistant"])(
  "does not let %s hits crowd completed turns out of the candidate budget",
  (kind) => {
    const { store, chatId } = fixture();
    complete(store, chatId, "original", 10);
    const expected = store
      .listGatewayMessages(chatId, "", 10)
      .map((row) => row.id)
      .sort();
    for (let index = 0; index < 80; index++) {
      const input = message(
        chatId,
        kind === "pending" ? "user" : "assistant",
        "needle",
        100 + index,
      );
      if (kind === "pending") store.admitChatTurn(`pending-${String(index)}`, input);
      else store.createMessage(input);
    }
    expect(found(store, chatId)).toEqual(expected);
  },
);

it("retains the latest duplicate claim using canonical user anchors rather than assistant time", () => {
  const { store, chatId } = fixture();
  const user = message(chatId, "user", "Earlier request", 10);
  const admission = store.admitChatTurn("skewed", user);
  if (admission.kind !== "admitted") throw new TypeError("Fixture admission failed");
  const old = store.createTurnAssistant(
    admission.userMessage.id,
    message(chatId, "assistant", "needle checkpoint red", 1000),
  );
  store.completeChatTurn(chatId, "skewed", user.content, old.id);
  store.createMessage(message(chatId, "user", "needle checkpoint blue", 20));
  store.createMessage(message(chatId, "assistant", "Acknowledged", 21));
  const latest = store.createMessage(message(chatId, "user", "needle checkpoint red", 30));
  store.createMessage(message(chatId, "assistant", "Acknowledged", 31));
  const result = rehydrateChatHistory(store, chatId, "needle checkpoint", new Set(), []);
  expect(result).toContain(latest.id);
  expect(result).not.toContain(old.id);
  expect(result).toMatch(/checkpoint blue[\s\S]*checkpoint red/u);
});

it("retains its index across a private store reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "keiko-chat-index-reopen-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  const project = join(root, "workspace");
  mkdirSync(project);
  const original = createNodeUiStore(path);
  original.createProject(project, "Reopen fixture");
  const chatId = original.createChat(project, "Reopen", "fixture").id;
  const user = original.createMessage(message(chatId, "user", "needle original", 1));
  original.createMessage(message(chatId, "assistant", "Acknowledged", 2));
  original.close();
  const reopened = createNodeUiStore(path);
  stores.push(reopened);
  expect(found(reopened, chatId)).toContain(user.id);
});

it.each(['needle" OR content:*', "", "x".repeat(257)])(
  "rejects invalid index expression input %s",
  (value) => {
    const { store, chatId } = fixture();
    expect(() => found(store, chatId, value)).toThrow(TypeError);
  },
);
