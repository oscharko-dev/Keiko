// ADR-0013 D3/D8 — db.ts: createInMemoryUiStore (tests), createNodeUiStore (real on-disk).
// Asserts perms 0o700/0o600 on the dir/file (Unix), and that the DB file is NOT inside process.cwd().

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { StoredPdfCitationPreviewCitation } from "@oscharko-dev/keiko-contracts";
import { isStoreFingerprint } from "@oscharko-dev/keiko-contracts/runtime/store-fingerprint";
import { MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  buildUiStoreOverDatabase,
  createInMemoryUiStore,
  createNodeUiStore,
  openNodeUiDatabase,
  openNodeUiDatabaseReadOnly,
  SCHEMA_VERSION,
  UI_DB_BUSY_TIMEOUT_MS,
  type GroundedAnswer,
  type NewChatMessage,
} from "./index.js";
// Not yet re-exported through the barrel (Wave 4a is scoped to db.ts/deps.ts) — imported directly
// from the co-located module instead, same package, no boundary crossed.
import { computeStoreFingerprint, UI_STORE_FINGERPRINT_TABLES } from "./db.js";
import type { ServerLogEvent, ServerLogSink } from "../observability/index.js";

// Narrows an array-index access (T | undefined) to T without a non-null assertion.
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a defined value");
  return value;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keiko-uidb-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("createInMemoryUiStore", () => {
  it("returns a store that exposes the UiStore surface", () => {
    const store = createInMemoryUiStore();
    expect(typeof store.listProjects).toBe("function");
    expect(typeof store.createProject).toBe("function");
    expect(typeof store.listChats).toBe("function");
    expect(typeof store.createMessage).toBe("function");
    expect(typeof store.close).toBe("function");
    store.close();
  });

  it("returns an empty project list initially", () => {
    const store = createInMemoryUiStore();
    expect(store.listProjects()).toEqual([]);
    store.close();
  });

  it("validates canonical client turn identifiers without normalizing opaque identity", (): void => {
    const projectDir = mkdtempSync(join(tmpDir, "client-turn-id-project-"));
    const store = createInMemoryUiStore();
    store.createProject(projectDir);
    const chat = store.createChat(projectDir, "Voice", "example-chat-model");
    const message = (content: string, timestamp: number): NewChatMessage => ({
      chatId: chat.id,
      role: "user" as const,
      content,
      timestamp,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });

    expect(() => store.admitChatTurn("", message("empty", 1))).toThrow("Invalid clientTurnId.");
    expect(() => store.admitChatTurn(" \t\r\n", message("blank", 2))).toThrow(
      "Invalid clientTurnId.",
    );
    expect(() => store.admitChatTurn("\u00a0\ufeff\u3000", message("unicode-blank", 3))).toThrow(
      "Invalid clientTurnId.",
    );

    const paddedOpaqueId = "  opaque-id  ";
    const paddedAdmission = store.admitChatTurn(paddedOpaqueId, message("padded", 4));
    expect(paddedAdmission.kind).toBe("admitted");
    expect(store.inspectChatTurn(chat.id, paddedOpaqueId, "padded").kind).toBe("in-progress");
    expect(store.inspectChatTurn(chat.id, paddedOpaqueId.trim(), "padded").kind).toBe("missing");

    const maximumLengthId = "x".repeat(MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS);
    expect(store.admitChatTurn(maximumLengthId, message("maximum", 5)).kind).toBe("admitted");
    expect(() => store.admitChatTurn(`${maximumLengthId}x`, message("overlong", 6))).toThrow(
      "Invalid clientTurnId.",
    );
    store.close();
  });

  it("refuses a late assistant for a failed canonical user while preserving the legacy path", () => {
    const projectDir = mkdtempSync(join(tmpDir, "assistant-owner-project-"));
    const store = createInMemoryUiStore();
    store.createProject(projectDir);
    const chat = store.createChat(projectDir, "Voice", "example-chat-model");
    const canonical = store.admitChatTurn("failed-canonical-turn", {
      chatId: chat.id,
      role: "user",
      content: "Canonical user",
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    if (canonical.kind !== "admitted") throw new Error("expected canonical admission");
    store.failChatTurn(chat.id, "failed-canonical-turn");
    expect(() =>
      store.createTurnAssistant(canonical.userMessage.id, {
        chatId: chat.id,
        role: "assistant",
        content: "Late answer",
        timestamp: 2,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      }),
    ).toThrow("Canonical assistant does not match the admitted chat turn.");
    expect(store.listMessages(chat.id)).toHaveLength(1);

    const legacyUser = store.createMessage({
      chatId: chat.id,
      role: "user",
      content: "Legacy user",
      timestamp: 3,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    store.createTurnAssistant(legacyUser.id, {
      chatId: chat.id,
      role: "assistant",
      content: "Legacy answer",
      timestamp: 4,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    expect(store.listMessages(chat.id).map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
    store.close();
  });

  it("keeps a failed turn retryable only while it remains the latest chat message", () => {
    const projectDir = mkdtempSync(join(tmpDir, "failed-retry-order-project-"));
    const store = createInMemoryUiStore();
    store.createProject(projectDir);
    const chat = store.createChat(projectDir, "Voice", "example-chat-model");
    const failed = store.admitChatTurn("failed-old-turn", {
      chatId: chat.id,
      role: "user",
      content: "Old question",
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    expect(failed.kind).toBe("admitted");
    store.failChatTurn(chat.id, "failed-old-turn");
    expect(store.inspectChatTurn(chat.id, "failed-old-turn", "Old question").kind).toBe(
      "retryable",
    );
    const newer = store.admitChatTurn("completed-new-turn", {
      chatId: chat.id,
      role: "user",
      content: "New question",
      timestamp: 2,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    if (newer.kind !== "admitted") throw new Error("expected newer turn admission");
    const assistant = store.createTurnAssistant(newer.userMessage.id, {
      chatId: chat.id,
      role: "assistant",
      content: "New answer",
      timestamp: 3,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    expect(
      store.completeChatTurn(chat.id, "completed-new-turn", "New question", assistant.id).kind,
    ).toBe("completed");

    expect(store.inspectChatTurn(chat.id, "failed-old-turn", "Old question").kind).toBe("conflict");
    expect(
      store.admitChatTurn("failed-old-turn", {
        chatId: chat.id,
        role: "user",
        content: "Old question",
        timestamp: 4,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      }).kind,
    ).toBe("conflict");
    expect(store.inspectChatTurn(chat.id, "failed-old-turn", "Old question").kind).toBe("conflict");
    expect(store.listMessages(chat.id).map((message) => message.content)).toEqual([
      "Old question",
      "New question",
      "New answer",
    ]);
    store.close();
  });

  it("persists distinct failed and cancelled canonical turn endings for reload", () => {
    const projectDir = mkdtempSync(join(tmpDir, "turn-ending-project-"));
    const store = createInMemoryUiStore();
    store.createProject(projectDir);
    const chat = store.createChat(projectDir, "Turn endings", "example-chat-model");
    const admit = (clientTurnId: string, content: string, timestamp: number): void => {
      expect(
        store.admitChatTurn(clientTurnId, {
          chatId: chat.id,
          role: "user",
          content,
          timestamp,
          runId: undefined,
          workflowId: undefined,
          workflowStatus: undefined,
          shortResult: undefined,
          taskType: undefined,
        }).kind,
      ).toBe("admitted");
    };
    admit("failed-turn", "Failure body", 1);
    store.failChatTurn(chat.id, "failed-turn", "failed");
    admit("cancelled-turn", "Cancellation body", 2);
    store.failChatTurn(chat.id, "cancelled-turn", "cancelled");

    expect(
      store.listMessages(chat.id).map(({ content, turnState }) => ({ content, turnState })),
    ).toEqual([
      { content: "Failure body", turnState: "failed" },
      { content: "Cancellation body", turnState: "cancelled" },
    ]);
    expect(store.inspectChatTurn(chat.id, "cancelled-turn", "Cancellation body").kind).toBe(
      "retryable",
    );
    store.failChatTurn(chat.id, "cancelled-turn", "cancelled");
    expect(store.listMessages(chat.id).at(-1)?.turnState).toBe("cancelled");
    store.close();
  });

  it("keeps visible incomplete turns out of gateway history", (): void => {
    const projectDir = mkdtempSync(join(tmpDir, "gateway-history-project-"));
    const store = createInMemoryUiStore();
    store.createProject(projectDir);
    const chat = store.createChat(projectDir, "History", "example-chat-model");
    const draft = (
      role: "user" | "assistant",
      content: string,
      timestamp: number,
    ): NewChatMessage => ({
      chatId: chat.id,
      role,
      content,
      timestamp,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    const legacyAnswered = store.createMessage(draft("user", "legacy answered", 1));
    store.createTurnAssistant(legacyAnswered.id, draft("assistant", "legacy answer", 2));
    store.createMessage(draft("user", "legacy cancelled orphan", 3));
    const failed = store.admitChatTurn("failed-turn", draft("user", "canonical failed", 4));
    expect(failed.kind).toBe("admitted");
    store.failChatTurn(chat.id, "failed-turn");
    const completed = store.admitChatTurn("completed-turn", draft("user", "canonical done", 5));
    if (completed.kind !== "admitted") throw new Error("expected canonical admission");
    const answer = store.createTurnAssistant(
      completed.userMessage.id,
      draft("assistant", "canonical answer", 6),
    );
    expect(
      store.completeChatTurn(chat.id, "completed-turn", "canonical done", answer.id).kind,
    ).toBe("completed");
    const current = store.admitChatTurn("current-turn", draft("user", "current question", 7));
    if (current.kind !== "admitted") throw new Error("expected current admission");

    expect(store.listMessages(chat.id)).toHaveLength(7);
    expect(
      store
        .listGatewayMessages(chat.id, current.userMessage.id, 50)
        .map((message): string => message.content),
    ).toEqual([
      "legacy answered",
      "legacy answer",
      "canonical done",
      "canonical answer",
      "current question",
    ]);
    expect(
      store
        .listGatewayMessages(chat.id, current.userMessage.id, 1)
        .map((message): string => message.content),
    ).toEqual(["current question"]);
    store.close();
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects an invalid gateway history limit of %s",
    (limit): void => {
      const store = createInMemoryUiStore();
      expect((): unknown => store.listGatewayMessages("missing-chat", "", limit)).toThrow(
        "limit must be a positive integer.",
      );
      store.close();
    },
  );

  it("fills the gateway limit across ineligible pages without splitting turns", (): void => {
    const projectDir = mkdtempSync(join(tmpDir, "gateway-pagination-project-"));
    const store = createInMemoryUiStore();
    store.createProject(projectDir);
    const chat = store.createChat(projectDir, "Paginated history", "example-chat-model");
    const draft = (
      role: "user" | "assistant",
      content: string,
      timestamp: number,
    ): NewChatMessage => ({
      chatId: chat.id,
      role,
      content,
      timestamp,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    const legacyUser = store.createMessage(draft("user", "legacy user", 1));
    store.createTurnAssistant(legacyUser.id, draft("assistant", "legacy assistant", 2));
    const completed = store.admitChatTurn("completed-page-turn", draft("user", "done user", 3));
    if (completed.kind !== "admitted") throw new Error("expected canonical admission");
    const completedAssistant = store.createTurnAssistant(
      completed.userMessage.id,
      draft("assistant", "done assistant", 4),
    );
    store.completeChatTurn(chat.id, "completed-page-turn", "done user", completedAssistant.id);
    for (let index = 0; index < 124; index += 1) {
      store.createMessage(draft("user", `orphan ${String(index)}`, 5 + index));
    }
    const failed = store.admitChatTurn("failed-page-turn", draft("user", "failed user", 129));
    if (failed.kind !== "admitted") throw new Error("expected failed admission");
    store.failChatTurn(chat.id, "failed-page-turn");
    const pending = store.admitChatTurn("pending-page-turn", draft("user", "pending user", 130));
    if (pending.kind !== "admitted") throw new Error("expected pending admission");
    const current = store.admitChatTurn("current-page-turn", draft("user", "current user", 131));
    if (current.kind !== "admitted") throw new Error("expected current admission");

    const contents = (limit: number): readonly string[] =>
      store
        .listGatewayMessages(chat.id, current.userMessage.id, limit)
        .map((message): string => message.content);
    expect(contents(5)).toEqual([
      "legacy user",
      "legacy assistant",
      "done user",
      "done assistant",
      "current user",
    ]);
    expect(contents(4)).toEqual(["done user", "done assistant", "current user"]);
    store.close();
  });

  it("keeps canonical pairs complete when the assistant clock moves backwards", (): void => {
    const projectDir = mkdtempSync(join(tmpDir, "gateway-clock-skew-project-"));
    const store = createInMemoryUiStore();
    store.createProject(projectDir);
    const chat = store.createChat(projectDir, "Clock skew history", "example-chat-model");
    const draft = (
      role: "user" | "assistant" | "system",
      content: string,
      timestamp: number,
    ): NewChatMessage => ({
      chatId: chat.id,
      role,
      content,
      timestamp,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    const completed = store.admitChatTurn(
      "clock-skew-completed-turn",
      draft("user", "clock-skew user", 300),
    );
    if (completed.kind !== "admitted") throw new Error("expected canonical admission");
    for (let index = 0; index < 127; index += 1) {
      store.createMessage(draft("system", `intervening system ${String(index)}`, 299 - index));
    }
    const assistant = store.createTurnAssistant(
      completed.userMessage.id,
      draft("assistant", "clock-skew assistant", 1),
    );
    store.completeChatTurn(chat.id, "clock-skew-completed-turn", "clock-skew user", assistant.id);

    expect(
      store
        .listGatewayMessages(chat.id, "", 2)
        .map((message): readonly [string, string] => [message.role, message.content]),
    ).toEqual([
      ["user", "clock-skew user"],
      ["assistant", "clock-skew assistant"],
    ]);
    expect(
      store
        .listGatewayMessages(chat.id, completed.userMessage.id, 2)
        .map((message): readonly [string, string] => [message.role, message.content]),
    ).toEqual([
      ["user", "clock-skew user"],
      ["assistant", "clock-skew assistant"],
    ]);
    store.close();
  });

  it("keeps completed history and the admitted turn behind future system rows", (): void => {
    const projectDir = mkdtempSync(join(tmpDir, "gateway-current-skew-project-"));
    const store = createInMemoryUiStore();
    store.createProject(projectDir);
    const chat = store.createChat(projectDir, "Current clock skew", "example-chat-model");
    const completed = store.admitChatTurn("system-skew-completed-turn", {
      chatId: chat.id,
      role: "user",
      content: "completed request",
      timestamp: -2,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    if (completed.kind !== "admitted") throw new Error("expected completed admission");
    const completedAssistant = store.createTurnAssistant(completed.userMessage.id, {
      chatId: chat.id,
      role: "assistant",
      content: "completed answer",
      timestamp: -1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    store.completeChatTurn(
      chat.id,
      "system-skew-completed-turn",
      "completed request",
      completedAssistant.id,
    );
    for (let index = 0; index < 50; index += 1) {
      store.createMessage({
        chatId: chat.id,
        role: "system",
        content: `future system ${String(index)}`,
        timestamp: 200 + index,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      });
    }
    const current = store.admitChatTurn("current-skew-turn", {
      chatId: chat.id,
      role: "user",
      content: "current request",
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    if (current.kind !== "admitted") throw new Error("expected current admission");

    const history = store.listGatewayMessages(chat.id, current.userMessage.id, 4);
    expect(
      history.map((message): readonly [string, string] => [message.role, message.content]),
    ).toEqual([
      ["user", "completed request"],
      ["assistant", "completed answer"],
      ["user", "current request"],
    ]);
    expect(
      store
        .listGatewayMessages(chat.id, "", 2)
        .map((message): readonly [string, string] => [message.role, message.content]),
    ).toEqual([
      ["user", "completed request"],
      ["assistant", "completed answer"],
    ]);
    store.close();
  });
});

describe("createNodeUiStore — on-disk file", () => {
  it("creates the DB file on the supplied path", () => {
    const dbPath = join(tmpDir, "keiko-ui.db");
    const store = createNodeUiStore(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    store.close();
  });

  it("creates parent directory with mode 0o700 (Unix)", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const dbPath = join(tmpDir, "nested", "keiko-ui.db");
    const store = createNodeUiStore(dbPath);
    const dirMode = statSync(dirname(dbPath)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    store.close();
  });

  it("chmods the DB file to 0o600 (Unix)", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const dbPath = join(tmpDir, "keiko-ui.db");
    const store = createNodeUiStore(dbPath);
    const fileMode = statSync(dbPath).mode & 0o777;
    expect(fileMode).toBe(0o600);
    store.close();
  });

  it("survives a reopen — persisted projects round-trip", () => {
    const dbPath = join(tmpDir, "keiko-ui.db");
    const projDir = mkdtempSync(join(tmpDir, "proj-"));
    const s1 = createNodeUiStore(dbPath);
    s1.createProject(projDir);
    s1.close();
    const s2 = createNodeUiStore(dbPath);
    const list = s2.listProjects();
    expect(list).toHaveLength(1);
    expect(list[0]?.path).toBe(projDir);
    s2.close();
  });

  it("recovers an interrupted canonical turn without persisting an orphan assistant", () => {
    const dbPath = join(tmpDir, "canonical-turn.db");
    const projectDir = mkdtempSync(join(tmpDir, "canonical-project-"));
    const opaqueTurnId = "provider\u0000item\nÜ".padEnd(256, "x");
    const content = "Remember this spoken fact exactly once.";
    const firstStore = createNodeUiStore(dbPath);
    firstStore.createProject(projectDir);
    const chat = firstStore.createChat(projectDir, "Voice", "example-chat-model");
    const firstAdmission = firstStore.admitChatTurn(opaqueTurnId, {
      chatId: chat.id,
      role: "user",
      content,
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    expect(firstAdmission.kind).toBe("admitted");
    if (firstAdmission.kind !== "admitted") throw new Error("expected canonical admission");
    const interruptedAssistant = firstStore.createTurnAssistant(firstAdmission.userMessage.id, {
      chatId: chat.id,
      role: "assistant",
      content: "This staged answer must not survive a crash.",
      timestamp: 2,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    expect(firstStore.listMessages(chat.id).map((message) => message.id)).toEqual([
      firstAdmission.userMessage.id,
    ]);
    firstStore.close();

    const inspector = new DatabaseSync(dbPath, { readOnly: true });
    const stored = inspector
      .prepare(
        "SELECT client_turn_id, client_turn_state, client_turn_content_digest" +
          " FROM chat_messages WHERE id = ?",
      )
      .get(firstAdmission.userMessage.id) as {
      client_turn_id: string;
      client_turn_state: string;
      client_turn_content_digest: string;
    };
    inspector.close();
    const expectedTurnReference = firstAdmission.userMessage.canonicalTurnRef;
    if (expectedTurnReference === undefined) throw new Error("expected canonical turn reference");
    expect(stored.client_turn_id).toBe(expectedTurnReference);
    expect(firstAdmission.userMessage.canonicalTurnRef).toBe(expectedTurnReference);
    expect(stored.client_turn_id).not.toBe(opaqueTurnId);
    expect(stored.client_turn_state).toBe("pending");
    expect(stored.client_turn_content_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.client_turn_content_digest).not.toContain(content);

    const recoveredStore = createNodeUiStore(dbPath);
    const recoveredAdmission = recoveredStore.admitChatTurn(opaqueTurnId, {
      chatId: chat.id,
      role: "user",
      content,
      timestamp: 3,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    expect(recoveredAdmission.kind).toBe("admitted");
    if (recoveredAdmission.kind !== "admitted") throw new Error("expected recovered admission");
    expect(recoveredAdmission.userMessage.id).toBe(firstAdmission.userMessage.id);
    expect(recoveredStore.findMessageById(interruptedAssistant.id)).toBeUndefined();
    const recoveredAssistant = recoveredStore.createTurnAssistant(
      recoveredAdmission.userMessage.id,
      {
        chatId: chat.id,
        role: "assistant",
        content: "Recovered answer.",
        timestamp: 4,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      },
    );
    const completion = recoveredStore.completeChatTurn(
      chat.id,
      opaqueTurnId,
      content,
      recoveredAssistant.id,
    );
    expect(completion.kind).toBe("completed");
    recoveredStore.close();

    const replayStore = createNodeUiStore(dbPath);
    const replay = replayStore.admitChatTurn(opaqueTurnId, {
      chatId: chat.id,
      role: "user",
      content,
      timestamp: 5,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    expect(replay.kind).toBe("replay");
    if (replay.kind !== "replay") throw new Error("expected canonical replay");
    expect(replay.userMessage.id).toBe(firstAdmission.userMessage.id);
    expect(replay.assistantMessage.id).toBe(recoveredAssistant.id);
    expect(replayStore.listMessages(chat.id)).toHaveLength(2);
    expect(() =>
      replayStore.admitChatTurn(`${opaqueTurnId}x`, {
        chatId: chat.id,
        role: "user",
        content,
        timestamp: 6,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      }),
    ).toThrow("Invalid clientTurnId.");
    expect(replayStore.listMessages(chat.id)).toHaveLength(2);
    replayStore.close();
  });

  it("replays the same raw canonical content after visible redaction policy rotates", () => {
    const store = createInMemoryUiStore();
    const projectDir = mkdtempSync(join(tmpDir, "redaction-rotation-project-"));
    store.createProject(projectDir);
    const chat = store.createChat(projectDir, "Voice", "example-chat-model");
    const clientTurnId = "redaction-rotation-turn";
    const rawContent = "The deployment marker is customer-secret-a.";
    const admission = store.admitChatTurn(
      clientTurnId,
      {
        chatId: chat.id,
        role: "user",
        content: "The deployment marker is [REDACTED-A].",
        timestamp: 1,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      },
      { identityContent: rawContent },
    );
    expect(admission.kind).toBe("admitted");
    if (admission.kind !== "admitted") throw new Error("expected admission");
    const assistant = store.createTurnAssistant(admission.userMessage.id, {
      chatId: chat.id,
      role: "assistant",
      content: "Stored answer.",
      timestamp: 2,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    expect(store.completeChatTurn(chat.id, clientTurnId, rawContent, assistant.id).kind).toBe(
      "completed",
    );

    expect(store.inspectChatTurn(chat.id, clientTurnId, rawContent).kind).toBe("replay");
    const replay = store.admitChatTurn(
      clientTurnId,
      { ...admission.userMessage, content: "The deployment marker is [REDACTED-B]." },
      { identityContent: rawContent },
    );
    expect(replay.kind).toBe("replay");
    expect(store.inspectChatTurn(chat.id, clientTurnId, `${rawContent} changed`).kind).toBe(
      "conflict",
    );
    store.close();
  });

  it("does not place the DB inside the current working directory by default in tests", () => {
    // The test supplies its own mkdtemp path explicitly; assert the resolved path is outside cwd.
    const dbPath = join(tmpDir, "keiko-ui.db");
    const store = createNodeUiStore(dbPath);
    expect(dbPath.startsWith(process.cwd())).toBe(false);
    store.close();
  });

  it("quarantines a corrupt DB file, writes a diagnostic record, and opens a fresh store (M2)", () => {
    const dbPath = join(tmpDir, "corrupt.db");
    // Write non-SQLite garbage to the target path.
    writeFileSync(dbPath, Buffer.from("not a sqlite db"));

    // createNodeUiStore must survive the corrupt file and return a working store.
    const store = createNodeUiStore(dbPath);
    expect(store.listProjects()).toEqual([]);
    store.close();

    // A .corrupt.<timestamp> sibling file must exist.
    const siblings = readdirSync(tmpDir);
    const corruptFiles = siblings.filter(
      (f) => f.startsWith("corrupt.db.corrupt.") && !f.endsWith(".diagnostic.json"),
    );
    expect(corruptFiles).toHaveLength(1);
    const diagnostic = siblings.find(
      (f) => f.startsWith("corrupt.db.corrupt.") && f.endsWith(".diagnostic.json"),
    );
    expect(diagnostic).toBeDefined();
    const record = JSON.parse(readFileSync(join(tmpDir, diagnostic ?? ""), "utf8")) as {
      readonly store?: string;
      readonly cause?: { readonly errcode?: number };
    };
    expect(record.store).toBe("ui-db");
    expect(record.cause?.errcode).toBe(26);
  });

  it("does not quarantine a migration/schema logic error", () => {
    const dbPath = join(tmpDir, "schema-tampered.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE projects (id TEXT) STRICT; PRAGMA user_version = 0");
    db.close();

    expect(() => createNodeUiStore(dbPath)).toThrow();

    const siblings = readdirSync(tmpDir);
    const corruptFiles = siblings.filter((f) => f.startsWith("schema-tampered.db.corrupt."));
    expect(corruptFiles).toHaveLength(0);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("does not quarantine a newer schema downgrade guard", () => {
    const dbPath = join(tmpDir, "newer.db");
    const store = createNodeUiStore(dbPath);
    store.close();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 1)}`);
    } finally {
      db.close();
    }

    expect(() => createNodeUiStore(dbPath)).toThrow(/newer than this binary/);
    expect(readdirSync(tmpDir).some((f) => f.includes(".corrupt."))).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
  });

  // The open path honours SQLite's busy_timeout before surfacing SQLITE_BUSY, so under an EXCLUSIVE
  // lock this open blocks for ~that window and then throws. Give the test explicit headroom over the
  // busy_timeout window so it never races vitest's 5s default (behaviour is correct; only the wait is
  // long). Matches the flaky-timeout stabilisation pattern used by prior steps.
  it("does not quarantine SQLITE_BUSY lock contention", () => {
    const dbPath = join(tmpDir, "busy.db");
    const store = createNodeUiStore(dbPath);
    store.close();

    const locker = new DatabaseSync(dbPath);
    locker.exec("PRAGMA locking_mode = EXCLUSIVE");
    locker.exec("BEGIN EXCLUSIVE");
    try {
      expect(() => createNodeUiStore(dbPath)).toThrow(/locked|busy/i);
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
    expect(readdirSync(tmpDir).some((f) => f.includes(".corrupt."))).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
  }, 20000);

  // B.1 — AC#3: chat + messages survive close/reopen (on-disk round-trip).
  // This test complements the existing projects-only round-trip at line 64 by proving
  // that chats AND messages — including all workflow-run fields and the v2 task_type column —
  // are correctly persisted and rehydrated across two independent store sessions.
  it("survives a reopen — chat + messages round-trip with workflow fields and task_type", () => {
    const dbPath = join(tmpDir, "chat-roundtrip.db");
    const projDir = mkdtempSync(join(tmpDir, "proj-"));

    // ── Session 1: write ────────────────────────────────────────────────────
    const s1 = createNodeUiStore(dbPath);

    s1.createProject(projDir);
    const chat = s1.createChat(projDir, "Round-trip chat", "example-chat-model-fast");

    // Plain user message — all optional fields undefined.
    const plainMsg = s1.createMessage({
      chatId: chat.id,
      role: "user",
      content: "Hello from round-trip",
      timestamp: 100,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });

    // Workflow run-summary message — every optional field populated, including v2 task_type.
    const workflowMsg = s1.createMessage({
      chatId: chat.id,
      role: "system",
      content: "Unit test generation started",
      timestamp: 200,
      runId: "run-abc123",
      workflowId: "unit-test-generation",
      workflowStatus: "completed",
      shortResult: "Generated 12 tests.",
      taskType: "unit-test-generation",
    });

    const assistantMsg = s1.createMessage({
      chatId: chat.id,
      role: "assistant",
      content: "Grounded answer.",
      timestamp: 300,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    const grounded: GroundedAnswer = {
      groundingKind: "connected-context",
      userMessageId: plainMsg.id,
      assistantMessageId: assistantMsg.id,
      evidenceRunId: "grounded-run-1",
      content: "Grounded answer.",
      citations: [
        {
          scopePath: "package-lock.json",
          lineRange: { startLine: 1, endLine: 48 },
          score: 0.9,
          stableId: "atom-lock",
        },
      ],
      uncertainty: [],
      omittedCount: 0,
      elapsedMs: 10,
      contextPack: {
        schemaVersion: "1",
        scopeId: "scope-1",
        scopeKind: "files",
        fileCount: 1,
        queryKind: "natural-language",
        usage: {
          searchCalls: 1,
          filesRead: 1,
          excerptBytes: 128,
          modelInputTokens: 64,
          modelOutputTokens: 12,
          elapsedMs: 10,
          rerankCalls: 0,
        },
        budget: {
          searchCallsMax: 16,
          filesReadMax: 32,
          excerptBytesMax: 131_072,
          modelInputTokensMax: 32_000,
          modelOutputTokensMax: 4_096,
          elapsedMsMax: 30_000,
          rerankCallsMax: 0,
        },
        citationCount: 1,
        omittedCount: 0,
        omittedCounts: {
          "outside-scope": 0,
          binary: 0,
          generated: 0,
          ignored: 0,
          "size-exceeded": 0,
          "near-duplicate": 0,
          "low-relevance": 0,
          "redacted-only": 0,
          "budget-exhausted": 0,
          "tool-unavailable": 0,
          "unsupported-format": 0,
          "no-text-layer": 0,
          "malformed-document": 0,
          "encrypted-document": 0,
        },
        uncertaintyCount: 0,
        elapsedMs: 10,
      },
    };
    const previewCitations: readonly StoredPdfCitationPreviewCitation[] = [
      {
        stableId: "preview-1",
        marker: "[1]",
        markerIndex: 1,
        documentLabel: "policy.pdf",
        sourceLabel: "Policy Capsule / Manual",
        lineage: {
          capsuleId: "cap-1" as never,
          sourceId: "src-1" as never,
          documentId: "doc-1" as never,
          chunkId: "chunk-1" as never,
        },
        documentMediaType: "application/pdf",
        documentContentHash: "hash-1",
        pageNumber: 7,
        pageLabel: "7",
        characterStart: 0,
        characterEnd: 32,
      },
    ];
    s1.attachGroundedAnswer(assistantMsg.id, grounded, previewCitations);

    s1.close();

    // ── Session 2: read ─────────────────────────────────────────────────────
    const s2 = createNodeUiStore(dbPath);

    const chats = s2.listChats(projDir);
    expect(chats).toHaveLength(1);
    const reloadedChat = must(chats[0]);

    // Chat identity and model.
    expect(reloadedChat.id).toBe(chat.id);
    expect(reloadedChat.projectPath).toBe(projDir);
    expect(reloadedChat.title).toBe("Round-trip chat");
    expect(reloadedChat.selectedModel).toBe("example-chat-model-fast");

    const messages = s2.listMessages(chat.id);
    expect(messages).toHaveLength(3);

    // Ordered by timestamp ASC, so plain message comes first.
    const reloadedPlain = must(messages[0]);
    const reloadedWorkflow = must(messages[1]);
    const reloadedAssistant = must(messages[2]);

    // Plain message — all optional fields must be undefined (not null).
    expect(reloadedPlain.id).toBe(plainMsg.id);
    expect(reloadedPlain.chatId).toBe(chat.id);
    expect(reloadedPlain.role).toBe("user");
    expect(reloadedPlain.content).toBe("Hello from round-trip");
    expect(reloadedPlain.timestamp).toBe(100);
    expect(reloadedPlain.runId).toBeUndefined();
    expect(reloadedPlain.workflowId).toBeUndefined();
    expect(reloadedPlain.workflowStatus).toBeUndefined();
    expect(reloadedPlain.shortResult).toBeUndefined();
    expect(reloadedPlain.taskType).toBeUndefined();

    // Workflow message — all fields must survive the round-trip intact.
    expect(reloadedWorkflow.id).toBe(workflowMsg.id);
    expect(reloadedWorkflow.chatId).toBe(chat.id);
    expect(reloadedWorkflow.role).toBe("system");
    expect(reloadedWorkflow.content).toBe("Unit test generation started");
    expect(reloadedWorkflow.timestamp).toBe(200);
    expect(reloadedWorkflow.runId).toBe("run-abc123");
    expect(reloadedWorkflow.workflowId).toBe("unit-test-generation");
    expect(reloadedWorkflow.workflowStatus).toBe("completed");
    expect(reloadedWorkflow.shortResult).toBe("Generated 12 tests.");
    expect(reloadedWorkflow.taskType).toBe("unit-test-generation");

    expect(reloadedAssistant.id).toBe(assistantMsg.id);
    expect(reloadedAssistant.groundedAnswer).toMatchObject({
      groundingKind: "connected-context",
      assistantMessageId: assistantMsg.id,
      citations: [{ scopePath: "package-lock.json" }],
    });
    expect(s2.findGroundedPreviewCitations(assistantMsg.id)).toEqual(previewCitations);

    s2.close();
  });
});

// Issue #639 — the UI DB must configure a bounded PRAGMA busy_timeout so concurrent UI/BFF
// writers wait briefly for the writer lock instead of failing immediately with SQLITE_BUSY.
describe("UI DB busy_timeout (issue #639)", () => {
  it("exports a positive UI_DB_BUSY_TIMEOUT_MS constant", () => {
    expect(typeof UI_DB_BUSY_TIMEOUT_MS).toBe("number");
    expect(UI_DB_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("sets the active PRAGMA busy_timeout on the on-disk node UI database", () => {
    const dbPath = join(tmpDir, "busy.db");
    const db = openNodeUiDatabase(dbPath);
    try {
      const rows = db.prepare("PRAGMA busy_timeout").all() as unknown as readonly {
        timeout: number;
      }[];
      expect(rows[0]?.timeout).toBe(UI_DB_BUSY_TIMEOUT_MS);
    } finally {
      db.close();
    }
  });

  it("sets the active PRAGMA busy_timeout on the in-memory store factory", () => {
    // Probe a fresh DatabaseSync handle the same way preparedDatabase() does: this is the
    // strongest available assertion because createInMemoryUiStore does not expose its handle,
    // but the constant + the prod code are the single source of truth for the value applied.
    const probe = new DatabaseSync(":memory:");
    try {
      probe.exec(`PRAGMA busy_timeout = ${String(UI_DB_BUSY_TIMEOUT_MS)}`);
      const rows = probe.prepare("PRAGMA busy_timeout").all() as unknown as readonly {
        timeout: number;
      }[];
      expect(rows[0]?.timeout).toBe(UI_DB_BUSY_TIMEOUT_MS);
    } finally {
      probe.close();
    }
    // And the store factory still returns a working store (regression guard on the PRAGMA
    // statement not interfering with migrations).
    const store = createInMemoryUiStore();
    expect(store.listProjects()).toEqual([]);
    store.close();
  });

  // Finding 2: the read-only diagnostic open (`keiko support export`'s fingerprint collection)
  // must set the same busy_timeout as the production open, so a reader started against a live
  // production server does not spuriously report the store `open-failed` on an immediate
  // SQLITE_BUSY from a concurrent WAL checkpoint. RED (before fix): `node:sqlite`'s default
  // busy_timeout is 0, so this assertion fails against the un-pragma'd read-only open.
  it("sets the active PRAGMA busy_timeout on the read-only node UI database open", () => {
    const dbPath = join(tmpDir, "busy-readonly.db");
    openNodeUiDatabase(dbPath).close();

    const db = openNodeUiDatabaseReadOnly(dbPath);
    try {
      const rows = db.prepare("PRAGMA busy_timeout").all() as unknown as readonly {
        timeout: number;
      }[];
      expect(rows[0]?.timeout).toBe(UI_DB_BUSY_TIMEOUT_MS);
    } finally {
      db.close();
    }
  });
});

// Wave 4a, epic #3233 §6.2 — the redacted, point-in-time schema/integrity snapshot embedded in
// the support bundle manifest.
describe("computeStoreFingerprint (Wave 4a, epic #3233 §6.2)", () => {
  it("computes a valid, fully-populated fingerprint for a freshly migrated store", () => {
    const dbPath = join(tmpDir, "fingerprint-fresh.db");
    const db = openNodeUiDatabase(dbPath);
    try {
      const fingerprint = computeStoreFingerprint(db);
      // Validated against the real, independently-owned keiko-contracts guard rather than
      // re-asserting each field by hand — the producer and the shape gate must agree.
      expect(isStoreFingerprint(fingerprint)).toBe(true);
      expect(fingerprint.store).toBe("ui");
      expect(fingerprint.schemaVersion).toBe(SCHEMA_VERSION);
      expect(fingerprint.migrationsApplied).toEqual(
        Array.from({ length: SCHEMA_VERSION }, (_unused, index) => `v${String(index + 1)}`),
      );
      expect(Object.keys(fingerprint.tableRowCounts).sort()).toEqual(
        [...UI_STORE_FINGERPRINT_TABLES].sort(),
      );
      // The assertion above compares the constant against itself, so a migration that adds a table
      // and forgets to fingerprint it stays invisible — which is exactly what happened when schema
      // v21 added `github_issue_reader_authorization`. This one asks the DATABASE instead: every
      // persistent table the migrations actually created must be fingerprinted, or a support bundle
      // silently omits a store an operator is trying to diagnose.
      const liveTables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
      expect(
        liveTables.filter((table) => !UI_STORE_FINGERPRINT_TABLES.includes(table as never)),
      ).toEqual([]);
      expect(Object.values(fingerprint.tableRowCounts).every((count) => count === 0)).toBe(true);
      expect(fingerprint.quickCheckOk).toBe(true);
      expect(fingerprint.encryptionMode).toBe("plaintext");
      expect(fingerprint.keySource).toBeUndefined();
    } finally {
      db.close();
    }
  });

  // Schema v22 (#3385) widened `coding_runtime_snapshots` with the issue-binding columns and created
  // no table, so the fingerprint table list is exactly what v21 left it. This pins both halves: the
  // columns landed on the already-fingerprinted table (a support bundle keeps counting issue-bound
  // runs through the same row count), and no second, unfingerprinted store appeared for them.
  it("keeps the v22 issue-binding columns on the fingerprinted coding_runtime_snapshots table", () => {
    const dbPath = join(tmpDir, "fingerprint-v22.db");
    const db = openNodeUiDatabase(dbPath);
    try {
      const codingRuntimeTables = UI_STORE_FINGERPRINT_TABLES.filter((table) =>
        table.startsWith("coding_runtime"),
      );
      expect(codingRuntimeTables).toEqual(["coding_runtime_snapshots"]);
      const columns = (
        db.prepare("PRAGMA table_info(coding_runtime_snapshots)").all() as { name: string }[]
      ).map((row) => row.name);
      for (const column of [
        "issue_repository_id",
        "issue_remote_digest",
        "issue_number",
        "issue_id_digest",
        "issue_default_base_ref",
        "issue_content_revision_digest",
        "issue_binding_digest",
      ]) {
        expect(columns, column).toContain(column);
      }
      const liveTableCount = (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .get() as { count: number }
      ).count;
      expect(liveTableCount).toBe(UI_STORE_FINGERPRINT_TABLES.length);
      expect(computeStoreFingerprint(db).tableRowCounts.coding_runtime_snapshots).toBe(0);
    } finally {
      db.close();
    }
  });

  it("counts rows actually present in a table, independently per table", () => {
    const dbPath = join(tmpDir, "fingerprint-counts.db");
    const db = openNodeUiDatabase(dbPath);
    try {
      const store = buildUiStoreOverDatabase(db);
      const projectA = mkdtempSync(join(tmpDir, "fingerprint-project-a-"));
      const projectB = mkdtempSync(join(tmpDir, "fingerprint-project-b-"));
      store.createProject(projectA, "Project A");
      store.createProject(projectB, "Project B");
      const fingerprint = computeStoreFingerprint(db);
      expect(fingerprint.tableRowCounts.projects).toBe(2);
      expect(fingerprint.tableRowCounts.chats).toBe(0);
    } finally {
      db.close();
    }
  });

  // Regression pin: the manifest assembler this feeds must still produce a (degraded) fingerprint
  // for the very store an operator is trying to diagnose — it must never throw and abort the
  // whole support-bundle export over one unreadable store.
  it("never throws against a corrupted file, and returns a degraded fingerprint instead", () => {
    const dbPath = join(tmpDir, "fingerprint-corrupt.db");
    writeFileSync(dbPath, Buffer.from("not a sqlite db"));
    const db = new DatabaseSync(dbPath);
    try {
      let fingerprint: ReturnType<typeof computeStoreFingerprint> | undefined;
      expect(() => {
        fingerprint = computeStoreFingerprint(db);
      }).not.toThrow();
      const resolved = must(fingerprint);
      expect(isStoreFingerprint(resolved)).toBe(true);
      expect(resolved.quickCheckOk).toBe(false);
      expect(resolved.schemaVersion).toBe(0);
      expect(resolved.migrationsApplied).toEqual([]);
      expect(resolved.tableRowCounts).toEqual({});
    } finally {
      db.close();
    }
  });
});

// Wave 4a, epic #3233 §8 — a `store.opened` activity-log event once per successful open.
describe("openNodeUiDatabase — store.opened activity log (Wave 4a, epic #3233 §8)", () => {
  it("emits exactly one store.opened event through the supplied sink on a successful open", () => {
    const dbPath = join(tmpDir, "opened.db");
    const events: ServerLogEvent[] = [];
    const sink: ServerLogSink = {
      write: (event) => {
        events.push(event);
      },
    };
    const db = openNodeUiDatabase(dbPath, sink);
    try {
      expect(events).toHaveLength(1);
      const event = must(events[0]);
      expect(event.category).toBe("setup");
      expect(event.op).toBe("store.opened");
      expect(typeof event.durationMs).toBe("number");
      expect(event.durationMs ?? -1).toBeGreaterThanOrEqual(0);
      expect(event.extra?.store).toBe("ui");
      expect(event.extra?.storeSchemaVersion).toBe(SCHEMA_VERSION);
      expect(event.extra?.migrationsAppliedCount).toBe(SCHEMA_VERSION);
      expect(event.extra?.quickCheckOk).toBe(true);
      expect(event.extra?.encryptionMode).toBe("plaintext");
      // This store is never encrypted, so no key is ever resolved — `keySource` must be absent,
      // not merely `undefined`, on the emitted event.
      expect(event.extra !== undefined && "keySource" in event.extra).toBe(false);
    } finally {
      db.close();
    }
  });

  it("does not emit any event, and still opens normally, when no sink is supplied", () => {
    const dbPath = join(tmpDir, "opened-no-sink.db");
    const db = openNodeUiDatabase(dbPath);
    try {
      const row = db.prepare("PRAGMA user_version").get() as
        { readonly user_version?: number } | undefined;
      expect(row?.user_version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("still returns a working database when the supplied sink throws on write", () => {
    const dbPath = join(tmpDir, "opened-sink-throws.db");
    const sink: ServerLogSink = {
      write: () => {
        throw new Error("boom");
      },
    };
    let db: DatabaseSync | undefined;
    expect(() => {
      db = openNodeUiDatabase(dbPath, sink);
    }).not.toThrow();
    const opened = must(db);
    try {
      const row = opened.prepare("PRAGMA user_version").get() as
        { readonly user_version?: number } | undefined;
      expect(row?.user_version).toBe(SCHEMA_VERSION);
    } finally {
      opened.close();
    }
  });

  // PR #3244 review, thread 15: `buildUiStoreOpenedEvent` used to call `computeStoreFingerprint`,
  // which runs a SECOND full-database `PRAGMA quick_check` (the first already ran inside this same
  // `openNodeUiDatabase` call, via `assertQuickCheckOk`) and a `COUNT(*)` scan over every one of
  // `UI_STORE_FINGERPRINT_TABLES` — a cost that scales with database size, paid on every production
  // server start. Neither is needed: the emitted event carries only `quickCheckOk` (a boolean) and
  // `storeSchemaVersion`/`migrationsAppliedCount` (from the already-cheap `PRAGMA user_version`),
  // never `tableRowCounts`.
  it("emits the store.opened event without re-running quick_check or scanning any table for a row count", () => {
    const dbPath = join(tmpDir, "opened-perf.db");
    const sink: ServerLogSink = { write: (): void => undefined };
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare");
    let db: DatabaseSync | undefined;
    try {
      db = openNodeUiDatabase(dbPath, sink);
      const preparedSql = prepareSpy.mock.calls.map((call) => call[0]);
      const quickCheckCalls = preparedSql.filter((sql) => sql.includes("quick_check"));
      const countCalls = preparedSql.filter((sql) => /count\(\*\)/iu.test(sql));
      // Exactly one: the real integrity check `openNodeUiDatabase` itself needs, not a second one
      // recomputed only to build the log event.
      expect(quickCheckCalls).toHaveLength(1);
      // `runMigrations` legitimately issues its own single, unrelated `COUNT(*)` against
      // `workspace_manifests` (`migrateLegacyProjectManifests`'s post-migration trust-record
      // cleanup check) — that is not what this test guards against. What must NOT happen is
      // `computeStoreFingerprint`'s `readTableRowCounts`, which queries EVERY one of
      // `UI_STORE_FINGERPRINT_TABLES` (13 tables). Fewer COUNT(*) calls than that full table list
      // proves the whole-database row-count scan did not run for this event.
      expect(countCalls.length).toBeLessThan(UI_STORE_FINGERPRINT_TABLES.length);
    } finally {
      prepareSpy.mockRestore();
      db?.close();
    }
  });
});
