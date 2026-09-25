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
  it.each(["", "   "])(
    "rolls back automatic project registration when title %j is invalid",
    (title) => {
      store.deleteProject(root);
      const projects = store.listProjects();
      const manifests = store.listWorkspaceManifestRecords();
      expect(() =>
        codingHistory().create({
          projectPath: root,
          title,
          modelId: "coding",
          workspaceId: "ws_new",
          taskId: "task_new",
          branch: "keiko/task/new",
          operatorDigest: "a".repeat(64),
        }),
      ).toThrow();
      expect(store.listProjects()).toEqual(projects);
      expect(store.listWorkspaceManifestRecords()).toEqual(manifests);
    },
  );

  it("registers an accepted workspace repository before storing its first coding task", () => {
    store.deleteProject(root);
    const task = codingHistory().create({
      projectPath: root,
      title: "First task in a bound workspace",
      modelId: "coding",
      workspaceId: "ws_new",
      taskId: "task_new",
      branch: "keiko/task/new",
      operatorDigest: "a".repeat(64),
    });
    expect(codingHistory().get(task.id)?.projectPath).toBe(root);
    expect(store.listProjects().map((project) => project.path)).toContain(root);
  });

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

  // #3610: 1.1.x stored every run's task prompt twice — once as the run's intent and once more
  // under the runtime's own message id. Reading such a task shows each question once, and the
  // context handed to a continued run carries it once, without rewriting the stored rows.
  it("reads a task prompt that a run stored twice only once", () => {
    const history = codingHistory();
    const task = history.create({
      projectPath: root,
      title: "Duplicated intent",
      modelId: "coding",
      workspaceId: "ws_dup",
      taskId: "task_dup",
      branch: "keiko/task/dup",
      operatorDigest: "a".repeat(64),
    });
    history.bindRun(task.id, "run-first");
    history.append(task.id, "run-first", "intent", "user", "Fix the failing test");
    history.append(task.id, "run-first", "msg_native_user", "user", "Fix the failing test");
    history.append(task.id, "run-first", "msg_native_answer", "assistant", "Fixed.");
    history.bindRun(task.id, "run-second");
    history.append(task.id, "run-second", "intent", "user", "Now add a test");
    history.append(task.id, "run-second", "msg_second_user", "user", "Now add a test");
    // A later user message of the same run with the same words is the operator's own, not an echo.
    history.append(task.id, "run-first", "msg_repeat_elsewhere", "user", "Now add a test");

    const detail = history.detail(task.id, "a".repeat(64));
    expect(detail?.messages.map(({ role, content }) => [role, content])).toEqual([
      ["user", "Fix the failing test"],
      ["assistant", "Fixed."],
      ["user", "Now add a test"],
      ["user", "Now add a test"],
    ]);
    expect(
      detail?.messages.filter(({ content }) => content === "Fix the failing test"),
    ).toHaveLength(1);
    expect(
      history.messagesBeforeRun(task.id, "run-second").map(({ role, content }) => [role, content]),
    ).toEqual([
      ["user", "Fix the failing test"],
      ["assistant", "Fixed."],
      ["user", "Now add a test"],
    ]);
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
