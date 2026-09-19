import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryUiStore, type UiStore } from "./index.js";

let root: string;
let store: UiStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-coding-history-"));
  store = createInMemoryUiStore();
  store.createProject(root);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function codingHistory(): NonNullable<UiStore["codingHistory"]> {
  const history = store.codingHistory;
  if (history === undefined) throw new Error("Coding History store missing");
  return history;
}

describe("Coding History on the existing conversation store", () => {
  it("keeps coding tasks separate from ordinary chat history and retains their workspace", () => {
    const ordinary = store.createChat(root, "Conversation", "test-model");
    const task = codingHistory().create({
      projectPath: root,
      title: "Inspect the parser",
      modelId: "test-model",
      workspaceId: "ws_parser",
      taskId: "task_parser",
      branch: "keiko/task/parser",
      operatorDigest: "a".repeat(64),
    });
    expect(store.listChats(root).map(({ id }) => id)).toEqual([ordinary.id]);
    expect(codingHistory().list("a".repeat(64))).toEqual([task]);
    expect(codingHistory().list("b".repeat(64))).toEqual([]);
    expect(task).toMatchObject({
      workspaceId: "ws_parser",
      taskId: "task_parser",
      status: "active",
    });
  });

  it("retains messages across completion and reopening without duplicating captured output", () => {
    const history = codingHistory();
    const task = history.create({
      projectPath: root,
      title: "Parser",
      modelId: "test-model",
      workspaceId: "ws_parser",
      taskId: "task_parser",
      branch: "keiko/task/parser",
      operatorDigest: "a".repeat(64),
    });
    history.bindRun(task.id, "run_parser");
    history.append(task.id, "run_parser", "user_1", "user", "Inspect the parser");
    history.append(
      task.id,
      "run_parser",
      "assistant_1",
      "assistant",
      "The parser is in src/parser.ts.",
    );
    history.append(
      task.id,
      "run_parser",
      "assistant_1",
      "assistant",
      "The parser is in src/parser.ts.",
    );
    expect(history.forRun("run_parser")?.id).toBe(task.id);
    expect(history.detail(task.id, "a".repeat(64))?.messages).toHaveLength(2);
    expect(store.listMessages(task.id)).toEqual([]);
    expect(store.findChatById(task.id)).toBeUndefined();
    expect(history.update(task.id, { status: "completed" }).status).toBe("completed");
    expect(history.update(task.id, { status: "active" }).status).toBe("active");
    expect(history.detail(task.id, "a".repeat(64))?.messages[1]?.content).toBe(
      "The parser is in src/parser.ts.",
    );
  });

  it("refuses a run binding to a second task and cascades when its chat is removed", () => {
    const history = codingHistory();
    const input = {
      projectPath: root,
      title: "Parser",
      modelId: "test-model",
      workspaceId: "ws_parser",
      taskId: "task_parser",
      branch: "keiko/task/parser",
      operatorDigest: "a".repeat(64),
    };
    const first = history.create(input);
    const second = history.create(input);
    history.bindRun(first.id, "run_parser");
    expect(() => {
      history.bindRun(second.id, "run_parser");
    }).toThrow();
    expect(() => {
      store.deleteChat(first.id);
    }).toThrow();
    store.deleteProject(root);
    expect(history.forRun("run_parser")).toBeUndefined();
    expect(history.list("a".repeat(64))).toHaveLength(0);
  });
});
