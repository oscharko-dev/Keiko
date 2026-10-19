import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryUiStore, createNodeUiStore, UiStoreError, type UiStore } from "./index.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

const REQUEST = "9c710d81-b368-4dad-a5ae-1c261cc20c67";
const OPTIONS = { creationRequestId: REQUEST };
let directory: string;
let project: string;
let store: UiStore;
beforeEach(() => {
  directory = mkdtempSync(join(realpathSync(tmpdir()), "keiko-create-intent-"));
  project = join(directory, "project");
  mkdirSync(project);
  store = createInMemoryUiStore();
  store.createProject(project);
});
afterEach(() => {
  store.close();
  resetServerLogger();
  rmSync(directory, { recursive: true, force: true });
});

describe("durable chat creation intents", () => {
  it("replays committed creation across independent store connections and restart", () => {
    const path = join(directory, "ui.sqlite");
    const first = createNodeUiStore(path);
    let second: UiStore | undefined;
    try {
      first.createProject(project);
      const chat = first.createChat(project, "Original", "model", OPTIONS);
      second = createNodeUiStore(path);
      expect(second.createChat(project, "Original", "model", OPTIONS).id).toBe(chat.id);
      second.close();
      second = createNodeUiStore(path);
      expect(second.createChat(project, "Original", "model", OPTIONS).id).toBe(chat.id);
      expect(second.listChats(project)).toHaveLength(1);
    } finally {
      second?.close();
      first.close();
    }
  });

  it("keeps distinct intents and ordinary calls independent", () => {
    const first = store.createChat(project, "Original", "model", OPTIONS);
    const next = store.createChat(project, "Original", "model", { creationRequestId: "other" });
    const ordinary = store.createChat(project, "Original", "model");
    expect(new Set([first.id, next.id, ordinary.id]).size).toBe(3);
  });

  it("keeps the same creation reference independent across authorized project scopes", () => {
    const other = join(directory, "other");
    mkdirSync(other);
    store.createProject(other);
    const first = store.createChat(project, "Original", "model", OPTIONS);
    const second = store.createChat(other, "Original", "model", OPTIONS);
    expect(second.id).not.toBe(first.id);
    expect(second.projectPath).toBe(other);
    expect(store.createChat(project, "Original", "model", OPTIONS).id).toBe(first.id);
    expect(store.createChat(other, "Original", "model", OPTIONS).id).toBe(second.id);
  });

  it.each(["title", "model", "branch"] as const)(
    "refuses changed %s for a committed intent",
    (field) => {
      const original = store.createChat(project, "Original", "model", OPTIONS);
      const other = join(directory, "other");
      mkdirSync(other);
      store.createProject(other);
      expect(() =>
        store.createChat(
          project,
          field === "title" ? "Changed" : "Original",
          field === "model" ? "other-model" : "model",
          { ...OPTIONS, ...(field === "branch" ? { branchLabel: "other" } : {}) },
        ),
      ).toThrow(expect.objectContaining({ status: 409 }));
      expect(store.findChatById(original.id)?.title).toBe("Original");
      expect(store.listChats(project)).toHaveLength(1);
      expect(store.listChats(other)).toHaveLength(0);
    },
  );

  it("does not undo later edits when replaying the original creation", () => {
    const chat = store.createChat(project, "Original", "model", OPTIONS);
    store.updateChat(chat.id, { title: "Renamed", selectedModel: "other-model" });
    expect(store.createChat(project, "Original", "model", OPTIONS)).toMatchObject({
      id: chat.id,
      title: "Renamed",
      selectedModel: "other-model",
    });
  });

  it("binds the original automatic choice independently of the elected model", () => {
    const options = { ...OPTIONS, automaticModelSelection: true };
    const first = store.createChat(project, "Original", "model-a", options);
    expect(store.createChat(project, "Original", "model-b", options).id).toBe(first.id);
    const intent = {
      requestId: REQUEST,
      projectPath: project,
      title: "Original",
      requestedModelId: undefined,
      branchLabel: undefined,
      correlationId: undefined,
    };
    expect(store.replayChatCreation(intent)?.selectedModel).toBe("model-a");
    expect(() => store.replayChatCreation({ ...intent, requestedModelId: "model-a" })).toThrow(
      UiStoreError,
    );
    expect(store.replayChatCreation({ ...intent, requestId: "unknown" })).toBeUndefined();
    expect(store.listChats(project)).toHaveLength(1);
  });

  it("does not recreate a permanently deleted chat", () => {
    const chat = store.createChat(project, "Original", "model", OPTIONS);
    store.deleteChat(chat.id);
    expect(() => store.createChat(project, "Original", "model", OPTIONS)).toThrow(UiStoreError);
    expect(store.listChats(project)).toHaveLength(0);
  });

  it("retains a tombstone when the project is deleted and registered again", () => {
    store.createChat(project, "Original", "model", OPTIONS);
    store.deleteProject(project);
    store.createProject(project);
    expect(() => store.createChat(project, "Original", "model", OPTIONS)).toThrow(UiStoreError);
    expect(store.listChats(project)).toHaveLength(0);
  });

  it("does not reopen an archived conversation", () => {
    const chat = store.createChat(project, "Original", "model", OPTIONS);
    store.updateChat(chat.id, { status: "closed" });
    expect(() => store.createChat(project, "Original", "model", OPTIONS)).toThrow(UiStoreError);
    expect(store.findChatById(chat.id)?.status).toBe("closed");
  });

  it("does not reserve an intent when creation fails validation", () => {
    expect(() => store.createChat(project, "", "model", OPTIONS)).toThrow(UiStoreError);
    expect(store.createChat(project, "Corrected", "model", OPTIONS).title).toBe("Corrected");
    expect(store.listChats(project)).toHaveLength(1);
  });

  it("rolls back both chat and intent when durable intent insertion fails", () => {
    const path = join(directory, "failed-insertion.sqlite");
    const persistent = createNodeUiStore(path);
    const fault = new DatabaseSync(path);
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    try {
      persistent.createProject(project);
      fault.exec(`CREATE TRIGGER reject_creation_intent BEFORE INSERT ON chat_creation_intents
        BEGIN SELECT RAISE(ABORT, 'Synthetic insertion failure'); END`);
      expect(() => persistent.createChat(project, "Original", "model", OPTIONS)).toThrow();
      expect(persistent.listChats(project)).toHaveLength(0);
      expect(fault.prepare("SELECT COUNT(*) AS count FROM chat_creation_intents").get()).toEqual({
        count: 0,
      });
      expect(
        sink.events
          .filter((event) => event.op === "chat.creation.intent")
          .map((event) => event.extra?.outcome),
      ).toEqual(["failed"]);
      fault.exec("DROP TRIGGER reject_creation_intent");
      expect(persistent.createChat(project, "Original", "model", OPTIONS).title).toBe("Original");
      expect(persistent.listChats(project)).toHaveLength(1);
    } finally {
      fault.close();
      persistent.close();
    }
  });

  it.each(["", "x".repeat(161), "bad\nvalue", "bad\u0000value", "../escape"])(
    "refuses malformed intent %j without creating a chat",
    (creationRequestId) => {
      expect(() => store.createChat(project, "Original", "model", { creationRequestId })).toThrow(
        UiStoreError,
      );
      expect(store.listChats(project)).toHaveLength(0);
    },
  );

  it("reports created, reused and refused decisions without retaining input or identifiers", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const chat = store.createChat(project, "Private synthetic title", "model", OPTIONS);
    store.createChat(project, "Private synthetic title", "model", OPTIONS);
    expect(() => store.createChat(project, "Conflicting", "model", OPTIONS)).toThrow(UiStoreError);
    const events = sink.events.filter((entry) => entry.op === "chat.creation.intent");
    expect(events.map((entry) => entry.extra?.outcome)).toEqual(["created", "reused", "refused"]);
    for (const event of events)
      expectActivityLogProof("chat.creation.intent.decision", formatActivityLogProofLine(event));
    const serialized = JSON.stringify(events);
    for (const input of [project, REQUEST, chat.id, "Private synthetic title", "Conflicting"])
      expect(serialized).not.toContain(input);
  });
});
