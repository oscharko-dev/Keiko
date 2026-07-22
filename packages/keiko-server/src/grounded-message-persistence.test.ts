import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiHandlerDeps } from "./deps.js";
import { persistGroundedExchange } from "./grounded-message-persistence.js";
import { createInMemoryUiStore, type ChatMessage, type UiStore } from "./store/index.js";

let projectDir: string;
let store: UiStore;
let chatId: string;
let otherChatId: string;

function deps(): UiHandlerDeps {
  return { store } as UiHandlerDeps;
}

function admitUser(): ChatMessage {
  const admission = store.admitChatTurn("grounded-turn", {
    chatId,
    role: "user",
    content: "Already admitted question",
    timestamp: 10,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (admission.kind !== "admitted") throw new Error("expected grounded user admission");
  return admission.userMessage;
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "keiko-grounded-message-persistence-"));
  let now = 100;
  store = createInMemoryUiStore({ now: () => ++now });
  store.createProject(projectDir);
  chatId = store.createChat(projectDir, "Grounded", "chat-model").id;
  otherChatId = store.createChat(projectDir, "Other", "chat-model").id;
});

afterEach(() => {
  store.close();
  rmSync(projectDir, { recursive: true, force: true });
});

describe("persistGroundedExchange", () => {
  it("persists a new user and assistant exchange through one atomic batch", () => {
    const createMessages = vi.spyOn(store, "createMessages");
    const createTurnAssistant = vi.spyOn(store, "createTurnAssistant");

    const [user, assistant] = persistGroundedExchange(
      deps(),
      chatId,
      "New grounded question",
      "Grounded answer",
    );

    expect(createMessages).toHaveBeenCalledOnce();
    expect(createTurnAssistant).not.toHaveBeenCalled();
    const batch = createMessages.mock.calls[0]?.[0];
    expect(batch?.map(({ chatId: id, role, content }) => ({ chatId: id, role, content }))).toEqual([
      { chatId, role: "user", content: "New grounded question" },
      { chatId, role: "assistant", content: "Grounded answer" },
    ]);
    expect([user, assistant].map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "New grounded question" },
      { role: "assistant", content: "Grounded answer" },
    ]);
    expect(store.listMessages(chatId).map((message) => message.id)).toEqual([
      user.id,
      assistant.id,
    ]);
  });

  it("reuses an admitted user and adds only its canonical assistant", () => {
    const admittedUser = admitUser();
    const createMessages = vi.spyOn(store, "createMessages");
    const createTurnAssistant = vi.spyOn(store, "createTurnAssistant");

    const [user, assistant] = persistGroundedExchange(
      deps(),
      chatId,
      "Must not become a duplicate user",
      "Canonical grounded answer",
      admittedUser,
    );

    expect(user).toBe(admittedUser);
    expect(createMessages).not.toHaveBeenCalled();
    expect(createTurnAssistant).toHaveBeenCalledOnce();
    expect(createTurnAssistant.mock.calls[0]?.[0]).toBe(admittedUser.id);
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("Canonical grounded answer");
    expect(store.listMessages(chatId)).toEqual([admittedUser]);

    const completion = store.completeChatTurn(
      chatId,
      "grounded-turn",
      "Already admitted question",
      assistant.id,
    );
    expect(completion.kind).toBe("completed");
    expect(store.listMessages(chatId).map((message) => message.content)).toEqual([
      "Already admitted question",
      "Canonical grounded answer",
    ]);
  });

  it("fails closed when the admitted user belongs to another chat", () => {
    const admittedUser = admitUser();
    const createMessages = vi.spyOn(store, "createMessages");
    const createTurnAssistant = vi.spyOn(store, "createTurnAssistant");

    expect(() =>
      persistGroundedExchange(
        deps(),
        otherChatId,
        "Mismatched question",
        "Must not persist",
        admittedUser,
      ),
    ).toThrow("admitted grounded message does not match the user turn");
    expect(createMessages).not.toHaveBeenCalled();
    expect(createTurnAssistant).not.toHaveBeenCalled();
    expect(store.listMessages(otherChatId)).toEqual([]);
    expect(store.listMessages(chatId)).toEqual([admittedUser]);
  });

  it("fails closed when the admitted message is not a user", () => {
    const admittedUser = admitUser();
    const wrongRole: ChatMessage = { ...admittedUser, role: "assistant" };
    const createMessages = vi.spyOn(store, "createMessages");
    const createTurnAssistant = vi.spyOn(store, "createTurnAssistant");

    expect(() =>
      persistGroundedExchange(deps(), chatId, "Mismatched question", "Must not persist", wrongRole),
    ).toThrow("admitted grounded message does not match the user turn");
    expect(createMessages).not.toHaveBeenCalled();
    expect(createTurnAssistant).not.toHaveBeenCalled();
    expect(store.listMessages(chatId)).toEqual([admittedUser]);
  });
});
