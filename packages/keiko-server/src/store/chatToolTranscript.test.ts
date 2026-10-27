import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { buildUiStoreOverDatabase, type UiStore } from "./index.js";
import { processServerLogSink } from "../process-log-sink.js";
import { runMigrations } from "./schema.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  formatActivityLogProofLine,
  expectActivityLogProof,
} from "../../../../tests/support/activity-log-proof.js";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import type { ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
});
function fixture(): {
  store: UiStore;
  db: DatabaseSync;
  id: string;
  chatId: string;
  logs: ReturnType<typeof createBufferedServerLogSink>;
} {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const logs = createBufferedServerLogSink();
  const store = buildUiStoreOverDatabase(db, {
    redactString: (value) => value.replaceAll("private-token", "[REDACTED]"),
  });
  disposals.push(() => {
    store.close();
  });
  const project = store.createProject(process.cwd());
  vi.spyOn(processServerLogSink(), "write").mockImplementation((event) => {
    logs.write(event);
  });
  const chat = store.createChat(project.path, "Synthetic", "synthetic");
  const message = store.createMessage({
    chatId: chat.id,
    role: "user",
    content: "Read Jira",
    timestamp: 1000,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  return { store, db, id: message.id, chatId: chat.id, logs };
}
const call = { id: "tool-call-1", name: "jira_issue", arguments: { issueKey: "SYN-1" } };
function result(): ToolResultEnvelope {
  return {
    schemaVersion: 1,
    invocationId: "invocation-1",
    toolRef: null,
    projectionDigest: null,
    status: "denied",
    reason: "authority-invalid",
    page: null,
    data: null,
    effectStarted: false,
    metrics: { inputBytes: 0, outputBytes: 0, resultCount: 0, durationMs: 0 },
  };
}
describe("ordinary Chat structured tool transcript", () => {
  it("persists identity/result pairs, redacts bodies and never changes the user text", () => {
    const { store, id } = fixture();
    store.updateChatToolTranscript(
      id,
      { kind: "started", call: { ...call, arguments: { text: "private-token" } } },
      "transcript-proof",
    );
    store.updateChatToolTranscript(
      id,
      { kind: "settled", callId: call.id, result: result() },
      "transcript-proof",
    );
    const message = store.findMessageById(id);
    expect(message?.content).toBe("Read Jira");
    expect(message?.toolTranscript?.exchanges).toEqual([
      { call: { ...call, arguments: { text: "[REDACTED]" } }, result: result() },
    ]);
  });
  it("makes duplicate delivery idempotent and refuses changed calls or settlements", () => {
    const { store, id } = fixture();
    store.updateChatToolTranscript(id, { kind: "started", call }, "duplicate");
    store.updateChatToolTranscript(id, { kind: "started", call }, "duplicate");
    expect(store.findMessageById(id)?.toolTranscript?.exchanges).toHaveLength(1);
    expect(() => {
      store.updateChatToolTranscript(
        id,
        { kind: "started", call: { ...call, arguments: {} } },
        "duplicate",
      );
    }).toThrow();
    expect(() => {
      store.updateChatToolTranscript(
        id,
        { kind: "settled", callId: "unknown", result: result() },
        "duplicate",
      );
    }).toThrow();
    store.updateChatToolTranscript(
      id,
      { kind: "settled", callId: call.id, result: result() },
      "duplicate",
    );
    expect(() => {
      store.updateChatToolTranscript(
        id,
        { kind: "settled", callId: call.id, result: { ...result(), invocationId: "changed" } },
        "duplicate",
      );
    }).toThrow();
  });
  it("fails closed on corrupt stored transcripts and isolates legacy messages", () => {
    const { store, db, id } = fixture();
    expect(store.findMessageById(id)?.toolTranscript).toBeUndefined();
    db.prepare("UPDATE chat_messages SET tool_transcript_json = ? WHERE id = ?").run(
      '{"schemaVersion":2}',
      id,
    );
    expect(() => store.findMessageById(id)).toThrow("Stored Chat tool transcript is invalid");
  });
  it("bounds the transcript and refuses writes after canonical turn termination", () => {
    const { store, db, id } = fixture();
    for (let index = 0; index < 30; index++)
      store.updateChatToolTranscript(
        id,
        { kind: "started", call: { ...call, id: `call-${String(index)}` } },
        "bounded",
      );
    expect(() => {
      store.updateChatToolTranscript(
        id,
        { kind: "started", call: { ...call, id: "overflow" } },
        "bounded",
      );
    }).toThrow();
    expect(store.findMessageById(id)?.toolTranscript?.exchanges).toHaveLength(30);
    db.prepare("UPDATE chat_messages SET client_turn_state = 'failed' WHERE id = ?").run(id);
    expect(() => {
      store.updateChatToolTranscript(id, { kind: "started", call }, "terminated");
    }).toThrow("no longer pending");
  });

  it("stores a public consent view only for its owning Chat", () => {
    const { store, id, chatId } = fixture();
    const grant = {
      kind: "jira-chat-read",
      grantId: "grant-1",
      chatId,
      podId: "pod-1",
      bindingGeneration: 1,
      authenticationGeneration: 1,
      state: "pending",
      disclosureVersion: "jira-chat-read-v1",
      requestedAt: 1000,
      expiresAt: 2000,
    } as const;
    expect(() => {
      store.updateChatToolTranscript(
        id,
        { kind: "read-consent", grant: { ...grant, chatId: "other-chat" } },
        "consent",
      );
    }).toThrow("mismatch");
    store.updateChatToolTranscript(id, { kind: "read-consent", grant }, "consent");
    expect(store.findMessageById(id)?.toolTranscript?.readGrant).toEqual(grant);
    expect(() => {
      store.updateChatToolTranscript(
        id,
        { kind: "read-consent", grant: { ...grant, authRef: "private-reference" } as typeof grant },
        "consent",
      );
    }).toThrow("Invalid tool consent");
  });

  it("records only identity digests and counts through the registered activity projection", () => {
    const { store, id, logs } = fixture();
    store.updateChatToolTranscript(id, { kind: "started", call }, "transcript-proof");
    const event = logs.events.find((entry) => entry.op === "chat.tool-transcript.updated");
    const line = formatActivityLogProofLine(event ?? {});
    expectActivityLogProof("chat.tool-transcript.updated.line", line);
    expect(line).not.toContain("SYN-1");
    expect(line).not.toContain(id);
    expect(analyzeLogText(line).timelines).toMatchObject([
      { correlationId: "transcript-proof", lines: [{ op: "chat.tool-transcript.updated" }] },
    ]);
  });
});
