// ADR-0013 — chat_messages CRUD. shortResult is redacted+truncated to ≤200 chars BEFORE persist.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryUiStore,
  UiStoreError,
  type ChatRole,
  type UiStore,
  type WorkflowStatus,
} from "../../../src/ui/store/index.js";

let tmp: string;
let proj: string;
let chatId: string;
let store: UiStore;

function makeRedactor(secret: string): (s: string) => string {
  return (s: string) => s.split(secret).join("[REDACTED]");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keiko-messages-"));
  proj = join(tmp, "p");
  mkdirSync(proj);
  let t = 1;
  store = createInMemoryUiStore({ now: () => ++t, redactString: makeRedactor("SECRET-TOKEN") });
  store.createProject(proj);
  chatId = store.createChat(proj, "t", "claude-opus-4-5").id;
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("createMessage", () => {
  it("persists a minimal message with all optional fields undefined", () => {
    const m = store.createMessage({
      chatId,
      role: "user",
      content: "hello",
      timestamp: 100,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
    });
    expect(m.id).toBeTruthy();
    expect(m.chatId).toBe(chatId);
    expect(m.role).toBe("user");
    expect(m.content).toBe("hello");
    expect(m.timestamp).toBe(100);
    expect(m.runId).toBeUndefined();
    expect(m.shortResult).toBeUndefined();
  });

  it("persists optional workflow ref columns", () => {
    const m = store.createMessage({
      chatId,
      role: "assistant",
      content: "ok",
      timestamp: 200,
      runId: "run-1",
      workflowId: "unit-tests",
      workflowStatus: "completed",
      shortResult: "all good",
    });
    expect(m.runId).toBe("run-1");
    expect(m.workflowId).toBe("unit-tests");
    expect(m.workflowStatus).toBe("completed");
    expect(m.shortResult).toBe("all good");
  });

  it("redacts shortResult before persist (no secret on disk)", () => {
    const m = store.createMessage({
      chatId,
      role: "assistant",
      content: "this content is NOT redacted",
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: "leaked SECRET-TOKEN here",
    });
    expect(m.shortResult).toBe("leaked [REDACTED] here");
    // Reload from DB; redaction is at-rest.
    const reread = store.listMessages(chatId)[0];
    expect(reread?.shortResult).toBe("leaked [REDACTED] here");
  });

  it("truncates shortResult longer than 200 chars", () => {
    const huge = "x".repeat(500);
    const m = store.createMessage({
      chatId,
      role: "assistant",
      content: "c",
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: huge,
    });
    expect(m.shortResult?.length).toBeLessThanOrEqual(200);
  });

  it("rejects an unknown role", () => {
    expect(() => {
      store.createMessage({
        chatId,
        role: "root" as unknown as ChatRole,
        content: "x",
        timestamp: 1,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
      });
    }).toThrow(UiStoreError);
  });

  it("rejects an unknown workflowStatus value", () => {
    expect(() => {
      store.createMessage({
        chatId,
        role: "assistant",
        content: "x",
        timestamp: 1,
        runId: "r",
        workflowId: "w",
        workflowStatus: "banana" as unknown as WorkflowStatus,
        shortResult: undefined,
      });
    }).toThrow(UiStoreError);
  });

  it("rejects an empty content", () => {
    expect(() =>
      store.createMessage({
        chatId,
        role: "user",
        content: "",
        timestamp: 1,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
      }),
    ).toThrow(UiStoreError);
  });

  it("rejects creation for an unknown chatId (FK violation)", () => {
    expect(() =>
      store.createMessage({
        chatId: "no-such-chat",
        role: "user",
        content: "x",
        timestamp: 1,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
      }),
    ).toThrow(UiStoreError);
  });
});

describe("listMessages", () => {
  it("returns messages ordered by timestamp ASC", () => {
    store.createMessage({
      chatId,
      role: "user",
      content: "B",
      timestamp: 20,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
    });
    store.createMessage({
      chatId,
      role: "assistant",
      content: "A",
      timestamp: 10,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
    });
    const list = store.listMessages(chatId);
    expect(list.map((m) => m.content)).toEqual(["A", "B"]);
  });

  it("returns an empty array for an unknown chatId (no throw)", () => {
    expect(store.listMessages("nope")).toEqual([]);
  });
});
