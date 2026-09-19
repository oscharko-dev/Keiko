import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    store.codingHistory?.bindRun(id, "run-two");
    store.codingHistory?.append(id, "run-two", "intent", "user", "Continue now");
    expect(history.initialContext("run-two")).toContain("The private answer");
    expect(history.initialContext("run-two")).not.toContain("Continue now");
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

  it("keeps bounded continuation context valid JSON and marks omitted history", () => {
    const { history, id } = fixture();
    store.codingHistory?.append(
      id,
      "b98ffdea-fc67-4e81-b1da-c5a987198123",
      "large",
      "assistant",
      "x".repeat(25_000),
    );
    store.codingHistory?.bindRun(id, "run-two");
    const context = history.initialContext("run-two");
    expect(context).toContain("Earlier context was truncated");
    expect(JSON.parse(context?.split("\n").at(-1) ?? "null")).toEqual([]);
  });
});
