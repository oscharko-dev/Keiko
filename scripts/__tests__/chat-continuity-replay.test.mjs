import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  removeMeasuredProbe,
  sendReplayRequest,
} from "../testing/coding-workbench-lab/chat-continuity-replay.mjs";
import {
  INITIAL_CONTEXT,
  CORRECTION_CONTEXT,
  RECALL_QUESTION,
  continuityDigest,
} from "../testing/coding-workbench-lab/chat-continuity-corpus.mjs";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE chats(id TEXT, project_path TEXT, selected_model TEXT); CREATE TABLE chat_messages(id TEXT, chat_id TEXT, role TEXT, content TEXT)",
  );
  db.prepare("INSERT INTO chats VALUES (?, ?, ?)").run("chat", "/synthetic", "qwen");
  const put = db.prepare("INSERT INTO chat_messages VALUES (?, ?, ?, ?)");
  [INITIAL_CONTEXT, CORRECTION_CONTEXT, RECALL_QUESTION].forEach((text, i) =>
    put.run(`u${i}`, "chat", "user", text),
  );
  put.run("a", "chat", "assistant", "{}");
  return { db, row: { model: "qwen", kind: "plain", answerDigest: continuityDigest("{}") } };
}

describe("retained-state Chat replay", () => {
  it.each([200, 503])(
    "does not dispatch Chat when readiness is unavailable (%s)",
    async (status) => {
      const paths = [],
        result = {};
      const runtime = {
        setActive: vi.fn(),
        async request(method, path) {
          paths.push([method, path]);
          return { status, json: { probes: [{ name: "chat", status: "failed" }] } };
        },
      };
      await sendReplayRequest(runtime, {}, "qwen", 95, result);
      expect(paths).toEqual([["POST", "/api/gateway/readiness"]]);
      expect(result.status).toBe("readiness-failed");
      expect(result.score).toBeUndefined();
    },
  );
  it("uses only the original question after readiness, with no expected answer in the request", async () => {
    const requests = [],
      result = {};
    const runtime = {
      setActive: vi.fn(),
      drain: vi.fn().mockResolvedValue(undefined),
      async request(method, path, body) {
        requests.push({ method, path, body });
        return path.endsWith("readiness")
          ? { status: 200, json: { probes: [{ name: "chat", status: "passed" }] } }
          : { status: 200, json: { messages: [{ role: "assistant", content: "{}" }] } };
      },
    };
    await sendReplayRequest(
      runtime,
      { chat: { id: "chat", project_path: "/synthetic" } },
      "qwen",
      95,
      result,
    );
    expect(requests[1].body.content).toBe(RECALL_QUESTION);
    expect(requests[1].path).toBe("/api/desktop/chat");
    expect(result.status).toBe("completed");
    expect(result.score.correct).toBe(0);
  });
  it("persists successful readiness before waiting for the model answer", async () => {
    const result = {},
      progress = [];
    const runtime = {
      setActive: vi.fn(),
      drain: vi.fn().mockResolvedValue(undefined),
      async request(_method, path) {
        if (path.endsWith("readiness"))
          return { status: 200, json: { probes: [{ name: "chat", status: "passed" }] } };
        expect(progress.at(-1)).toMatchObject({ stage: "request", readinessPassed: true });
        return { status: 200, json: { messages: [{ role: "assistant", content: "{}" }] } };
      },
    };
    await sendReplayRequest(
      runtime,
      { chat: { id: "chat", project_path: "/synthetic" } },
      "qwen",
      95,
      result,
      () => progress.push(structuredClone(result)),
    );
  });
  it("removes only the verified measured pair and hashes the unchanged originals", () => {
    const { db, row } = fixture();
    try {
      const before = db
        .prepare("SELECT rowid, * FROM chat_messages ORDER BY rowid")
        .all()
        .slice(0, -2);
      const prepared = removeMeasuredProbe(db, row);
      expect(db.prepare("SELECT rowid, * FROM chat_messages ORDER BY rowid").all()).toEqual(before);
      expect(prepared.canonicalDigest).toBe(continuityDigest(JSON.stringify(before)));
      expect(prepared.canonicalMessages).toBe(2);
      expect(prepared.originalScore.correct).toBe(0);
    } finally {
      db.close();
    }
  });
  it.each(["digest", "model", "kind", "question", "originals", "later-message"])(
    "refuses %s mismatch without deleting originals",
    (failure) => {
      const { db, row } = fixture();
      try {
        if (failure === "digest") row.answerDigest = continuityDigest("different");
        if (failure === "model") row.model = "gemma";
        if (failure === "kind") row.kind = "grounded";
        if (failure === "question")
          db.exec("UPDATE chat_messages SET content = 'changed' WHERE id = 'u2'");
        if (failure === "originals") db.exec("DELETE FROM chat_messages WHERE id = 'u0'");
        if (failure === "later-message")
          db.exec("INSERT INTO chat_messages VALUES ('later', 'chat', 'user', 'continuation')");
        const before = db.prepare("SELECT * FROM chat_messages").all();
        expect(() => removeMeasuredProbe(db, row)).toThrow();
        expect(db.prepare("SELECT * FROM chat_messages").all()).toEqual(before);
      } finally {
        db.close();
      }
    },
  );
});
