import type { ActiveWorkspaceView } from "../task-workspace/types.js";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
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
