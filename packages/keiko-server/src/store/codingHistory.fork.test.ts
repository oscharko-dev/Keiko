import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "@oscharko-dev/keiko-contracts/bff-wire";
import { createInMemoryUiStore, type UiStore } from "./index.js";

// S03 (#3904): a fork begins a new Coding History task from a copy of the source's conversation
// ahead of the fork point, so the person sees the context the saved native session carries.
let root: string;
let store: UiStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-coding-history-fork-"));
  store = createInMemoryUiStore();
  store.createProject(root);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const OPERATOR = "a".repeat(64);

function history(): NonNullable<UiStore["codingHistory"]> {
  const found = store.codingHistory;
  if (found === undefined) throw new Error("Coding History store missing");
  return found;
}

function binding(overrides: Record<string, string> = {}): {
  readonly projectPath: string;
  readonly title: string;
  readonly modelId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly branch: string;
  readonly operatorDigest: string;
} {
  return {
    projectPath: root,
    title: "Source task",
    modelId: "coding",
    workspaceId: "ws_source",
    taskId: "task_source",
    branch: "keiko/task/source",
    operatorDigest: OPERATOR,
    ...overrides,
  };
}

/** A source with two runs: three user turns, each answered. Returns the message ids by position. */
function sourceTask(): { readonly id: string; readonly messages: readonly ChatMessage[] } {
  const first = history().begin({
    ...binding(),
    runId: "run-source-1",
    intent: "First question",
  });
  history().append(first.id, "run-source-1", "msg_a1", "assistant", "First answer");
  history().begin({
    ...binding(),
    conversationId: first.id,
    runId: "run-source-2",
    intent: "Second question",
  });
  history().append(first.id, "run-source-2", "msg_a2", "assistant", "Second answer");
  history().append(first.id, "run-source-2", "msg_u3", "user", "Third question");
  history().append(first.id, "run-source-2", "msg_a3", "assistant", "Third answer");
  return { id: first.id, messages: shown(first.id) };
}

/** A task's messages as Coding History lists them; the public conversation API hides coding tasks. */
function shown(taskId: string): readonly ChatMessage[] {
  return history().detail(taskId, OPERATOR)?.messages ?? [];
}

function contents(messages: readonly ChatMessage[]): readonly string[] {
  return messages.map((message) => message.content);
}

describe("forking a Coding History task", () => {
  it("copies the whole conversation of the source into a new task of the same workspace", () => {
    const source = sourceTask();
    const before = shown(source.id);

    const fork = history().fork({
      ...binding({ title: "Try again" }),
      sourceId: source.id,
      runId: "run-fork-1",
      intent: "Fork question",
    });

    expect(fork).toMatchObject({
      boundary: { kind: "end" },
      inheritedCount: 6,
      sourceCount: 6,
      task: {
        title: "Try again",
        workspaceId: "ws_source",
        taskId: "task_source",
        branch: "keiko/task/source",
        status: "active",
        latestRunId: "run-fork-1",
      },
    });
    expect(fork.task.id).not.toBe(source.id);
    const detail = history().detail(fork.task.id, OPERATOR);
    expect(contents(detail?.messages ?? [])).toEqual([
      "First question",
      "First answer",
      "Second question",
      "Second answer",
      "Third question",
      "Third answer",
      "Fork question",
    ]);
    expect(detail?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    // The copies keep the time they were written; the fork's own intent is new.
    expect(detail?.messages.slice(0, 6).map((message) => message.timestamp)).toEqual(
      before.map((message) => message.timestamp),
    );
    // The source is untouched.
    expect(shown(source.id)).toEqual(before);
    expect(history().forRun("run-fork-1")?.id).toBe(fork.task.id);
    expect(history().forRun("run-source-2")?.id).toBe(source.id);
  });

  it("holds the copies apart from the fork's own run, so a history replay still has them", () => {
    const source = sourceTask();

    const fork = history().fork({
      ...binding(),
      sourceId: source.id,
      runId: "run-fork-1",
      intent: "Fork question",
    });

    // The runtime that could not fork natively replays these as context (`messagesBeforeRun`),
    // exactly like a follow-up; the fork's own intent is not among them.
    expect(contents(history().messagesBeforeRun(fork.task.id, "run-fork-1"))).toEqual([
      "First question",
      "First answer",
      "Second question",
      "Second answer",
      "Third question",
      "Third answer",
    ]);
    const detail = history().detail(fork.task.id, OPERATOR);
    const forkRunMessages = (detail?.messages ?? []).filter(
      (message) => message.runId === "run-fork-1",
    );
    expect(contents(forkRunMessages)).toEqual(["Fork question"]);
    expect(
      detail?.messages.slice(0, 6).every((message) => message.runId === "inherit-run-fork-1"),
    ).toBe(true);
  });

  it("forks just before a user message: what came ahead of it, not it and not what followed", () => {
    const source = sourceTask();
    const second = source.messages.find((message) => message.content === "Second question");

    const fork = history().fork({
      ...binding(),
      sourceId: source.id,
      beforeMessageId: second?.id ?? "",
      runId: "run-fork-1",
      intent: "Fork question",
    });

    expect(fork).toMatchObject({
      boundary: { kind: "turn", ordinal: 1, userTurnCount: 3 },
      inheritedCount: 2,
      sourceCount: 6,
    });
    expect(contents(history().detail(fork.task.id, OPERATOR)?.messages ?? [])).toEqual([
      "First question",
      "First answer",
      "Fork question",
    ]);
  });

  it("plans a fork without creating anything, and plans the same fork it then makes", () => {
    const source = sourceTask();
    const third = source.messages.find((message) => message.content === "Third question");
    const input = { ...binding(), sourceId: source.id, beforeMessageId: third?.id ?? "" };
    const tasksBefore = history().list(OPERATOR).length;

    const plan = history().planFork(input);

    expect(history().list(OPERATOR)).toHaveLength(tasksBefore);
    expect(plan).toEqual({
      boundary: { kind: "turn", ordinal: 2, userTurnCount: 3 },
      inheritedCount: 4,
      sourceCount: 6,
    });
    const fork = history().fork({ ...input, runId: "run-fork-1", intent: "Fork question" });
    expect({
      boundary: fork.boundary,
      inheritedCount: fork.inheritedCount,
      sourceCount: fork.sourceCount,
    }).toEqual(plan);
  });

  it("leaves a stored echo of a run's intent out of the copy and of the turn count", () => {
    const task = history().begin({ ...binding(), runId: "run-echo", intent: "Do the thing" });
    // 1.1.x stored the prompt a second time next to the intent `begin` had written.
    history().upsert(task.id, "run-echo", "msg_echo", "user", "Do the thing");
    history().upsert(task.id, "run-echo", "msg_answer", "assistant", "Done");
    const answer = shown(task.id).find((message) => message.content === "Done");

    const fork = history().fork({
      ...binding(),
      sourceId: task.id,
      runId: "run-fork-1",
      intent: "Next",
    });

    expect(fork).toMatchObject({
      boundary: { kind: "end" },
      inheritedCount: 2,
      sourceCount: 2,
    });
    expect(contents(history().detail(fork.task.id, OPERATOR)?.messages ?? [])).toEqual([
      "Do the thing",
      "Done",
      "Next",
    ]);
    // The assistant message is not a fork point.
    expect(
      history().planFork({ ...binding(), sourceId: task.id, beforeMessageId: answer?.id ?? "" }),
    ).toBeUndefined();
  });

  it.each([
    ["another operator", { operatorDigest: "b".repeat(64) }],
    ["another workspace", { workspaceId: "ws_other" }],
    ["another task workspace", { taskId: "task_other" }],
    ["another branch", { branch: "keiko/task/other" }],
  ])("does not fork a task of %s", (_name, overrides) => {
    const source = sourceTask();
    const input = { ...binding(overrides), sourceId: source.id };
    const tasksBefore = history().list(OPERATOR).length;

    expect(history().planFork(input)).toBeUndefined();
    expect(() => history().fork({ ...input, runId: "run-fork-1", intent: "Fork" })).toThrow();
    expect(history().list(OPERATOR)).toHaveLength(tasksBefore);
    expect(history().forRun("run-fork-1")).toBeUndefined();
  });

  it("does not fork a task that does not exist, or at a message that is not one of its user turns", () => {
    const source = sourceTask();
    const other = history().begin({
      ...binding({ workspaceId: "ws_source" }),
      runId: "run-other",
      intent: "Another task's question",
    });
    const foreign = store
      .listMessages(other.id, 200)
      .find((message) => message.content === "Another task's question");
    const assistant = source.messages.find((message) => message.content === "First answer");

    expect(history().planFork({ ...binding(), sourceId: "chat_missing" })).toBeUndefined();
    for (const beforeMessageId of ["msg_unknown", foreign?.id ?? "", assistant?.id ?? ""]) {
      expect(
        history().planFork({ ...binding(), sourceId: source.id, beforeMessageId }),
      ).toBeUndefined();
    }
    expect(() =>
      history().fork({
        ...binding(),
        sourceId: source.id,
        beforeMessageId: "msg_unknown",
        runId: "run-fork-1",
        intent: "Fork",
      }),
    ).toThrow();
  });

  it("refuses a fork point in a conversation Coding History no longer lists in full, and forks it whole", () => {
    const task = history().begin({ ...binding(), runId: "run-long", intent: "m0" });
    for (let index = 1; index < 205; index += 1) {
      history().append(
        task.id,
        "run-long",
        `msg_${String(index)}`,
        index % 2 === 0 ? "user" : "assistant",
        `m${String(index)}`,
      );
    }
    const listed = shown(task.id);
    const user = listed.find((message) => message.role === "user");

    expect(
      history().planFork({ ...binding(), sourceId: task.id, beforeMessageId: user?.id ?? "" }),
    ).toBeUndefined();
    expect(history().planFork({ ...binding(), sourceId: task.id })).toMatchObject({
      boundary: { kind: "end" },
      inheritedCount: 200,
      sourceCount: 200,
    });
  });

  it("forks a task that has only its intent", () => {
    const task = history().begin({ ...binding(), runId: "run-only", intent: "Only message" });

    const fork = history().fork({
      ...binding(),
      sourceId: task.id,
      runId: "run-fork-1",
      intent: "Fork",
    });

    expect(fork).toMatchObject({ inheritedCount: 1, sourceCount: 1 });
  });
});
