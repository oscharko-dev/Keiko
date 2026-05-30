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
      taskType: undefined,
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
      taskType: undefined,
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
      taskType: undefined,
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
      taskType: undefined,
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
        taskType: undefined,
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
        taskType: undefined,
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
        taskType: undefined,
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
        taskType: undefined,
      }),
    ).toThrow(UiStoreError);
  });
});

describe("createMessage — cancelled + taskType (issue #66)", () => {
  it("accepts the cancelled workflow status", () => {
    const m = store.createMessage({
      chatId,
      role: "system",
      content: "x",
      timestamp: 1,
      runId: "r-1",
      workflowId: "unit-test-generation",
      workflowStatus: "cancelled",
      shortResult: undefined,
      taskType: undefined,
    });
    expect(m.workflowStatus).toBe("cancelled");
  });

  it("round-trips a taskType column", () => {
    const m = store.createMessage({
      chatId,
      role: "system",
      content: "x",
      timestamp: 1,
      runId: "r-2",
      workflowId: undefined,
      workflowStatus: "running",
      shortResult: undefined,
      taskType: "verify",
    });
    expect(m.taskType).toBe("verify");
    const list = store.listMessages(chatId);
    expect(list[0]?.taskType).toBe("verify");
  });

  it("rejects an invalid taskType pattern", () => {
    expect(() =>
      store.createMessage({
        chatId,
        role: "system",
        content: "x",
        timestamp: 1,
        runId: "r",
        workflowId: undefined,
        workflowStatus: "running",
        shortResult: undefined,
        taskType: "BAD TYPE",
      }),
    ).toThrow(UiStoreError);
  });
});

describe("updateMessage (issue #66)", () => {
  it("patches workflowStatus + shortResult + taskType together", () => {
    const created = store.createMessage({
      chatId,
      role: "system",
      content: "Verify started",
      timestamp: 10,
      runId: "r-3",
      workflowId: undefined,
      workflowStatus: "running",
      shortResult: undefined,
      taskType: "verify",
    });
    const updated = store.updateMessage(created.id, {
      workflowStatus: "completed",
      shortResult: "Verification passed: 5 classifications.",
      taskType: "verify",
    });
    expect(updated.workflowStatus).toBe("completed");
    expect(updated.shortResult).toBe("Verification passed: 5 classifications.");
    expect(updated.taskType).toBe("verify");
    expect(updated.content).toBe("Verify started");
  });

  it("partial patch only updates the named fields", () => {
    const created = store.createMessage({
      chatId,
      role: "system",
      content: "Tests started",
      timestamp: 11,
      runId: "r-4",
      workflowId: "unit-test-generation",
      workflowStatus: "running",
      shortResult: "in flight",
      taskType: undefined,
    });
    const updated = store.updateMessage(created.id, { workflowStatus: "completed" });
    expect(updated.workflowStatus).toBe("completed");
    expect(updated.shortResult).toBe("in flight");
    expect(updated.workflowId).toBe("unit-test-generation");
  });

  it("throws on an unknown message id (404 shape)", () => {
    expect(() => store.updateMessage("no-such-id", { workflowStatus: "completed" })).toThrow(
      UiStoreError,
    );
  });

  it("rejects an invalid workflowStatus", () => {
    const created = store.createMessage({
      chatId,
      role: "system",
      content: "x",
      timestamp: 12,
      runId: "r-5",
      workflowId: undefined,
      workflowStatus: "running",
      shortResult: undefined,
      taskType: undefined,
    });
    expect(() =>
      store.updateMessage(created.id, {
        workflowStatus: "banana" as unknown as WorkflowStatus,
      }),
    ).toThrow(UiStoreError);
  });

  it("rejects an invalid taskType pattern on patch", () => {
    const created = store.createMessage({
      chatId,
      role: "system",
      content: "x",
      timestamp: 13,
      runId: "r-6",
      workflowId: undefined,
      workflowStatus: "running",
      shortResult: undefined,
      taskType: undefined,
    });
    expect(() => store.updateMessage(created.id, { taskType: "BAD" })).toThrow(UiStoreError);
  });

  it("truncates a shortResult longer than 200 chars", () => {
    const created = store.createMessage({
      chatId,
      role: "system",
      content: "x",
      timestamp: 14,
      runId: "r-7",
      workflowId: undefined,
      workflowStatus: "running",
      shortResult: undefined,
      taskType: undefined,
    });
    const huge = "x".repeat(500);
    const updated = store.updateMessage(created.id, { shortResult: huge });
    expect(updated.shortResult?.length).toBeLessThanOrEqual(200);
  });

  it("redacts a shortResult via the injected redactor", () => {
    const created = store.createMessage({
      chatId,
      role: "system",
      content: "x",
      timestamp: 15,
      runId: "r-8",
      workflowId: undefined,
      workflowStatus: "running",
      shortResult: undefined,
      taskType: undefined,
    });
    const updated = store.updateMessage(created.id, {
      shortResult: "carries SECRET-TOKEN forward",
    });
    expect(updated.shortResult).toBe("carries [REDACTED] forward");
  });

  it("rejects an empty patch with an invalid_request error", () => {
    const created = store.createMessage({
      chatId,
      role: "system",
      content: "x",
      timestamp: 16,
      runId: "r-9",
      workflowId: undefined,
      workflowStatus: "running",
      shortResult: undefined,
      taskType: undefined,
    });
    expect(() => store.updateMessage(created.id, {})).toThrow(UiStoreError);
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
      taskType: undefined,
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
      taskType: undefined,
    });
    const list = store.listMessages(chatId);
    expect(list.map((m) => m.content)).toEqual(["A", "B"]);
  });

  it("returns an empty array for an unknown chatId (no throw)", () => {
    expect(store.listMessages("nope")).toEqual([]);
  });
});
