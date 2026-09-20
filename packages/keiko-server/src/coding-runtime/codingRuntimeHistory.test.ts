import { createOpenCodeV2HistoryProjection } from "./opencodeV2History.js";
import type { ActiveWorkspaceView } from "../task-workspace/types.js";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildUiStoreOverDatabase,
  createInMemoryUiStore,
  openNodeUiDatabase,
  type UiStore,
} from "../store/index.js";
import { CodingRuntimeHistory } from "./codingRuntimeHistory.js";
import { createCodingSafeActivityProjection } from "./codingSafeActivityProjection.js";
import { createBufferedServerLogSink } from "../observability/server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

let store: UiStore;
let root: string;
const operator = "local-operator";
const operatorDigest = createHash("sha256").update(operator).digest("hex");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-history-runtime-"));
  store = createInMemoryUiStore();
  store.createProject(root);
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function activeWorkspace(): ActiveWorkspaceView {
  const at = "2026-09-20T00:00:00.000Z";
  return {
    instance: {
      schemaVersion: "1",
      workspaceId: "ws-1",
      taskId: "task-1",
      repositoryId: "repo-1",
      repositoryRoot: root,
      baseBranch: "dev",
      taskBranch: "keiko/task/one",
      managedWorktreePath: root,
      gitdirIdentity: "gitdir-1",
      lifecycleState: "active",
      health: "healthy",
      lock: null,
      createdAt: at,
      updatedAt: at,
      driftMarkers: [],
      recoveryHints: [],
      auditCorrelationId: "history-create-one",
    },
    binding: {
      schemaVersion: "1",
      workspaceId: "ws-1",
      taskId: "task-1",
      activeRoot: root,
      boundSurfaces: [],
      gitDeliveryRoot: root,
      editorProjectRoot: root,
    },
    pointer: { workspaceId: "ws-1", setBy: "operator", setAt: at, updatedAt: at },
  };
}

function fixture(): {
  readonly history: CodingRuntimeHistory;
  readonly id: string;
  readonly sink: ReturnType<typeof createBufferedServerLogSink>;
} {
  const sink = createBufferedServerLogSink();
  const history = new CodingRuntimeHistory(store, () => operator, sink);
  const task = store.codingHistory?.create({
    projectPath: root,
    title: "Task",
    modelId: "coding",
    workspaceId: "ws-1",
    taskId: "task-1",
    branch: "keiko/task/one",
    operatorDigest,
  });
  if (task === undefined) throw new Error("History unavailable");
  store.codingHistory?.bindRun(task.id, "b98ffdea-fc67-4e81-b1da-c5a987198123");
  store.codingHistory?.append(
    task.id,
    "b98ffdea-fc67-4e81-b1da-c5a987198123",
    "intent",
    "user",
    "Inspect a private source file",
  );
  return { history, id: task.id, sink };
}

function completedFeed(): ReturnType<
  ReturnType<typeof createCodingSafeActivityProjection>["currentContent"]
> {
  const projection = createCodingSafeActivityProjection({ now: () => 1_721_323_200_000 });
  projection.open({
    runId: "b98ffdea-fc67-4e81-b1da-c5a987198123",
    workspaceId: "ws-1",
    authorityExpiresAt: "2026-07-18T18:00:00.000Z",
    workspaceIsCurrent: () => true,
  });
  const occurredAt = "2026-07-18T17:00:00.000Z";
  projection.ingest("b98ffdea-fc67-4e81-b1da-c5a987198123", {
    kind: "message",
    messageId: "user-one",
    role: "user",
    occurredAt,
  });
  projection.ingest("b98ffdea-fc67-4e81-b1da-c5a987198123", {
    kind: "text",
    messageId: "user-one",
    text: "Inspect a private source file",
    occurredAt,
  });
  projection.ingest("b98ffdea-fc67-4e81-b1da-c5a987198123", {
    kind: "message",
    messageId: "assistant-one",
    parentMessageId: "user-one",
    role: "assistant",
    occurredAt,
  });
  projection.ingest("b98ffdea-fc67-4e81-b1da-c5a987198123", {
    kind: "text",
    messageId: "assistant-one",
    text: "The private answer is retained locally.",
    occurredAt,
  });
  return projection.currentContent();
}

describe("paired coding conversation history", () => {
  it("persists the canonical native history beyond display turn/byte limits and expiry", () => {
    const { history, id, sink } = fixture();
    const runId = "b98ffdea-fc67-4e81-b1da-c5a987198123";
    let now = 1_000;
    const display = createCodingSafeActivityProjection({ now: () => now });
    display.open({
      runId,
      workspaceId: "ws-1",
      authorityExpiresAt: "2030-01-01T00:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    const native = createOpenCodeV2HistoryProjection({
      runId,
      activityLog: sink,
      captureMessages: (messages) => history.captureNative(runId, messages),
    });
    const messages = Array.from({ length: 40 }, (_, index) => [
      {
        id: `msg_user_${String(index)}`,
        type: "user",
        time: { created: now },
        text: `Turn ${String(index)}`,
      },
      {
        id: `msg_assistant_${String(index)}`,
        type: "assistant",
        time: { created: now },
        content: [{ type: "text", text: `${String(index)}:${"a".repeat(2_000)}` }],
      },
    ]).flat();
    const events = native.project("ses_durable", messages, undefined);
    for (const event of events) {
      const signal = native.takeSignal(event);
      if (signal !== undefined) display.ingest(runId, signal);
    }
    now += 31 * 60_000;
    expect(display.currentContent()?.feed.availability).not.toBe("available");
    const retained = history.detail(id, "read-native-history");
    expect(retained?.messages).toHaveLength(80);
    expect(
      retained?.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content),
    ).toEqual(
      messages
        .filter((message) => message.type === "assistant")
        .map((message) => message.content?.[0]?.text),
    );
    const event = sink.events.find((item) => item.extra?.captureSource === "native-history");
    const line = formatActivityLogProofLine(event ?? {});
    expect(expectActivityLogProof("coding-runtime.history.emitted-line", line)).toMatchObject({
      correlationId: runId,
      event: "captured",
      captureSource: "native-history",
      sourceMessageCount: 80,
      messageCount: 79,
      truncated: false,
    });
    expect(line).not.toContain("aaaaa");
  });

  it("updates streamed native text idempotently, chunks long responses and rejects rewritten prefixes", () => {
    const { history, id, sink } = fixture();
    const runId = "b98ffdea-fc67-4e81-b1da-c5a987198123";
    const message = { messageId: "msg_stream", role: "assistant" as const, content: "Hello" };
    expect(history.captureNative(runId, [message])).toBe(true);
    expect(history.captureNative(runId, [{ ...message, content: "Hello world" }])).toBe(true);
    expect(history.captureNative(runId, [{ ...message, content: "Hello world" }])).toBe(true);
    const long = { ...message, messageId: `msg_${"a".repeat(251)}`, content: "x".repeat(90_000) };
    expect(history.captureNative(runId, [long])).toBe(true);
    expect(history.detail(id, "read-stream")?.messages.map((item) => item.content)).toEqual([
      "Inspect a private source file",
      "Hello world",
      "x".repeat(65_536),
      "x".repeat(24_464),
    ]);
    expect(history.captureNative(runId, [{ ...message, content: "Different" }])).toBe(false);
    const line = formatActivityLogProofLine(sink.events.at(-1) ?? {});
    expect(expectActivityLogProof("coding-runtime.history.emitted-line", line)).toMatchObject({
      correlationId: runId,
      captureSource: "native-history",
      event: "failed",
      errorKind: "internal",
      loss: "event-dropped",
    });
    expect(history.captureNative("unknown-native-run", [message])).toBe(false);
  });

  it.each(["coding_history_runs", "coding_history_message_bindings"])(
    "rolls back the complete history initialization when SQLite rejects %s",
    (table) => {
      store.close();
      const db = openNodeUiDatabase(join(root, "history.sqlite"));
      store = buildUiStoreOverDatabase(db);
      const history = new CodingRuntimeHistory(store, () => operator, undefined);
      db.exec(
        `CREATE TEMP TRIGGER reject_history_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected history write failure'); END`,
      );
      const request = {
        requestId: "atomic-history-start",
        taskIntent: "Keep this intent",
        requestedMode: "governed-assist" as const,
      };
      expect(() => {
        history.begin(request, activeWorkspace(), "atomic-history-run");
      }).toThrow("injected history write failure");
      expect(store.listProjects()).toEqual([]);
      expect(store.listWorkspaceManifestRecords()).toEqual([]);
      expect(history.list("atomic-read")).toEqual([]);
      expect(history.forRun("atomic-history-run")).toBeUndefined();
      expect(db.prepare("SELECT COUNT(*) AS count FROM chats").get()?.count).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM chat_messages").get()?.count).toBe(0);
      db.exec("DROP TRIGGER reject_history_write");
      history.begin(request, activeWorkspace(), "atomic-history-run");
      const task = history.forRun("atomic-history-run");
      expect(task).toBeDefined();
      expect(
        history
          .detail(task?.id ?? "missing", "atomic-read")
          ?.messages.map((message) => message.content),
      ).toEqual(["Keep this intent"]);
    },
  );

  it("preserves a completed conversation when a continuation's intent cannot be written", () => {
    store.close();
    const db = openNodeUiDatabase(join(root, "history.sqlite"));
    store = buildUiStoreOverDatabase(db);
    const history = new CodingRuntimeHistory(store, () => operator, undefined);
    const request = {
      requestId: "atomic-history-start",
      taskIntent: "Original intent",
      requestedMode: "governed-assist" as const,
    };
    history.begin(request, activeWorkspace(), "atomic-first-run");
    const task = history.forRun("atomic-first-run");
    if (task === undefined) throw new Error("Missing task");
    history.update(task.id, { status: "completed" }, "complete-first");
    const before = history.detail(task.id, "before-continuation");
    db.exec(
      "CREATE TEMP TRIGGER reject_history_write BEFORE INSERT ON coding_history_message_bindings BEGIN SELECT RAISE(ABORT, 'injected history write failure'); END",
    );
    expect(() => {
      history.begin(
        { ...request, conversationId: task.id, taskIntent: "Continue" },
        activeWorkspace(),
        "atomic-second-run",
      );
    }).toThrow("injected history write failure");
    expect(history.detail(task.id, "after-continuation")).toEqual(before);
    expect(history.forRun("atomic-second-run")).toBeUndefined();
  });

  it.each([false, true])("records automatic repository registration: existing=%s", (existing) => {
    if (!existing) store.deleteProject(root);
    const sink = createBufferedServerLogSink();
    const history = new CodingRuntimeHistory(store, () => operator, sink);
    history.begin(
      {
        requestId: "history-start-one",
        taskIntent: "PRIVATE_TASK",
        requestedMode: "governed-assist",
      },
      activeWorkspace(),
      "history-run-one",
    );
    const event = sink.events.at(-1);
    if (event === undefined) throw new Error("Missing event");
    const line = formatActivityLogProofLine(event);
    expect(JSON.parse(line)).toMatchObject({
      op: "coding-runtime.history",
      correlationId: "history-run-one",
      event: "created",
      projectRegistered: !existing,
      projectDigest: createHash("sha256").update(root).digest("hex"),
    });
    expect(line).not.toContain(root);
    expect(line).not.toContain("PRIVATE_TASK");
  });

  it("captures the production safe projection once, isolates ordinary chats and scopes the local operator", () => {
    const { history, id } = fixture();
    history.capture("b98ffdea-fc67-4e81-b1da-c5a987198123", completedFeed());
    history.capture("b98ffdea-fc67-4e81-b1da-c5a987198123", completedFeed());
    expect(history.detail(id, "read-one")?.messages.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(store.listChats(root)).toEqual([]);
    const other = new CodingRuntimeHistory(store, () => "another-operator", undefined);
    expect(other.detail(id, "read-other")).toBeUndefined();
    expect(other.list("list-other")).toEqual([]);
    store.codingHistory?.bindRun(id, "history-run-two");
    store.codingHistory?.append(id, "history-run-two", "intent", "user", "Continue now");
    expect(history.initialContext("history-run-two")).toContain("The private answer");
    expect(history.initialContext("history-run-two")).not.toContain("Continue now");
  });

  it("persists body-free loss evidence when the projection is unavailable", () => {
    const { history, sink } = fixture();
    history.capture("b98ffdea-fc67-4e81-b1da-c5a987198123", null);
    const record = sink.events.find((entry) => entry.op === "coding-runtime.history");
    if (record === undefined) throw new Error("Missing history activity");
    const line = formatActivityLogProofLine(record);
    expectActivityLogProof("coding-runtime.history.emitted-line", line);
    expect(JSON.parse(line)).toMatchObject({
      op: "coding-runtime.history",
      correlationId: "b98ffdea-fc67-4e81-b1da-c5a987198123",
      errorKind: "unavailable",
      event: "unavailable",
      completeness: "partial",
      loss: "event-dropped",
    });
    expect(line).not.toContain("private");
    expect(line).not.toContain(root);
  });

  it("records capture errors with their class, safe frames and cause", () => {
    const { history, sink } = fixture();
    const error = new TypeError("PRIVATE_FAILURE", { cause: new RangeError("PRIVATE_CAUSE") });
    error.stack =
      "TypeError: PRIVATE_FAILURE\n    at capture (/app/packages/keiko-server/dist/store/codingHistory.js:25:3)";
    if (store.codingHistory === undefined) throw new Error("Missing store");
    vi.spyOn(store.codingHistory, "forRun").mockImplementationOnce(() => {
      throw error;
    });
    history.capture("b98ffdea-fc67-4e81-b1da-c5a987198123", completedFeed());
    const event = sink.events.at(-1);
    if (event === undefined) throw new Error("Missing event");
    const line = formatActivityLogProofLine(event);
    expect(JSON.parse(line)).toMatchObject({
      op: "coding-runtime.history",
      correlationId: "b98ffdea-fc67-4e81-b1da-c5a987198123",
      event: "failed",
      errorKind: "internal",
      errorClass: "TypeError",
      frames: ["packages/keiko-server/dist/store/codingHistory.js:25:3"],
      causeChain: ["RangeError"],
    });
    expect(line).not.toContain("PRIVATE_");
  });

  it("distinguishes completion, reopening and rename without exposing a title", () => {
    const { history, id, sink } = fixture();
    history.update(id, { status: "completed" }, "update-one");
    history.update(id, { status: "active" }, "update-two");
    history.update(id, { title: "PRIVATE_TITLE" }, "update-three");
    expect(
      sink.events.filter((event) => event.extra?.event === "updated").map((event) => event.extra),
    ).toMatchObject([
      { previousStatus: "active", status: "completed", titleChanged: false },
      { previousStatus: "completed", status: "active", titleChanged: false },
      { previousStatus: "active", status: "active", titleChanged: true },
    ]);
    expect(JSON.stringify(sink.events)).not.toContain("PRIVATE_TITLE");
  });

  it("keeps bounded continuation context valid JSON and marks omitted history", () => {
    const { history, id, sink } = fixture();
    store.codingHistory?.append(
      id,
      "b98ffdea-fc67-4e81-b1da-c5a987198123",
      "large",
      "assistant",
      "x".repeat(25_000),
    );
    store.codingHistory?.bindRun(id, "history-run-two");
    const context = history.initialContext("history-run-two");
    expect(context).toContain("Earlier context was truncated");
    expect(JSON.parse(context?.split("\n").at(-1) ?? "null")).toEqual([]);
    expect(sink.events.at(-1)).toMatchObject({
      op: "coding-runtime.history",
      correlationId: "history-run-two",
      extra: {
        event: "context-restored",
        conversationId: id,
        sourceMessageCount: 2,
        messageCount: 0,
        truncated: true,
        contextByteCount: 2,
        contextDigest: createHash("sha256").update("[]").digest("hex"),
      },
    });
  });
});
