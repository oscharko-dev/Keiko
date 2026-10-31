import type { ChatToolMutationIntent } from "./chatToolMutationTypes.js";
import { validateToolResultEnvelope } from "@oscharko-dev/keiko-tool-catalog";
import type { JiraChatToolWriteApprovalView as ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { buildUiStoreOverDatabase, type UiStore } from "./index.js";
import { processServerLogSink } from "../process-log-sink.js";
import { CHAT_TOOL_TURN_BUDGET } from "../chat-tool-turn-budget.js";
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
  it.each([
    '{"private-token":',
    JSON.stringify({
      schemaVersion: 1,
      exchanges: [{ call: { ...call, arguments: { text: "private-token" }, private: true } }],
    }),
    JSON.stringify({
      schemaVersion: 1,
      exchanges: [{ call: { ...call, arguments: { text: "private-token".repeat(262144) } } }],
    }),
  ])("normalizes corrupt private transcript input to one static failure %#", (json) => {
    const f = fixture();
    f.db.prepare("UPDATE chat_messages SET tool_transcript_json = ? WHERE id = ?").run(json, f.id);
    expect(() => f.store.findMessageById(f.id)).toThrow(
      new TypeError("Stored Chat tool transcript is invalid."),
    );
    expect(
      f.db.prepare("SELECT tool_transcript_json AS body FROM chat_messages WHERE id = ?").get(f.id)
        ?.body,
    ).toBe(json);
    expect(JSON.stringify(f.logs.events)).not.toContain("private-token");
  });
  it("bounds the transcript and refuses writes after canonical turn termination", () => {
    const { store, db, id } = fixture();
    // The bound is one exchange per tool call the largest turn envelope admits (#4175).
    const bound = CHAT_TOOL_TURN_BUDGET.maxToolCalls;
    for (let index = 0; index < bound; index++)
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
    expect(store.findMessageById(id)?.toolTranscript?.exchanges).toHaveLength(bound);
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

const mutationCall = {
  id: "mutation-call",
  name: "jira_comment",
  arguments: { issueKey: "SYN-1", body: "comment" },
};
function approval(f: ReturnType<typeof fixture>): ChatToolWriteApprovalView {
  return {
    kind: "jira-chat-write",
    approvalId: "approval-1",
    chatId: f.chatId,
    podId: "d5f5681e-ce98-4c3c-b27e-51d707c9d018",
    bindingGeneration: 1,
    authenticationGeneration: 1,
    invocationId: sha256Hex(canonicalise({ messageId: f.id, callId: mutationCall.id })),
    operation: "jira.comment",
    actionDigest: sha256Hex(
      canonicalise({
        operation: "jira.comment",
        argumentsDigest: sha256Hex(canonicalise(mutationCall.arguments)),
      }),
    ),
    state: "pending",
    requestedAt: 1000,
    expiresAt: 2000,
  };
}
function mutationResult(): ToolResultEnvelope {
  return validateToolResultEnvelope({
    ...result(),
    invocationId: "catalog-invocation-1",
    toolRef: { canonicalId: "keiko.jira.comment", contractVersion: 1 },
    projectionDigest: "c".repeat(64),
  });
}
function startWrite(f: ReturnType<typeof fixture>): ChatToolWriteApprovalView {
  const view = approval(f);
  f.store.updateChatToolTranscript(
    f.id,
    { kind: "started", call: mutationCall },
    "write-transcript",
  );
  f.store.updateChatToolTranscript(
    f.id,
    { kind: "write-approval", callId: mutationCall.id, approval: view },
    "write-transcript",
  );
  return view;
}
function saveApproval(f: ReturnType<typeof fixture>, view: ChatToolWriteApprovalView): void {
  f.store.updateChatToolTranscript(
    f.id,
    { kind: "write-approval", callId: mutationCall.id, approval: view },
    "write-transcript",
  );
}

describe("durable Chat mutation projections", () => {
  it("pins a settlement's independent mutation outcome across duplicate delivery", () => {
    const f = fixture();
    startWrite(f);
    const settled = {
      kind: "settled",
      callId: mutationCall.id,
      result: mutationResult(),
      mutationOutcome: "unknown",
    } as const;
    f.store.updateChatToolTranscript(f.id, settled, "mutation-outcome");
    f.store.updateChatToolTranscript(f.id, settled, "mutation-outcome");
    expect(() => {
      f.store.updateChatToolTranscript(
        f.id,
        { ...settled, mutationOutcome: "succeeded" },
        "mutation-outcome",
      );
    }).toThrow("identity conflict");
    expect(() => {
      f.store.updateChatToolTranscript(
        f.id,
        { kind: "settled", callId: mutationCall.id, result: mutationResult() },
        "mutation-outcome",
      );
    }).toThrow("identity conflict");
    expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.mutationOutcome).toBe(
      "unknown",
    );
  });

  it.each(["approved", "claimed", "rejected", "expired", "revoked"] as const)(
    "refuses a late pending update after %s",
    (state) => {
      const f = fixture();
      const view = startWrite(f);
      saveApproval(f, { ...view, state });
      expect(() => {
        saveApproval(f, view);
      }).toThrow("identity conflict");
      expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.approval?.state).toBe(
        state,
      );
    },
  );

  it("allows observed forward states but never resurrects a terminal decision", () => {
    const f = fixture();
    const view = startWrite(f);
    for (const state of ["approved", "claimed", "revoked"] as const)
      saveApproval(f, { ...view, state });
    saveApproval(f, { ...view, state: "revoked" });
    expect(() => {
      saveApproval(f, { ...view, state: "approved" });
    }).toThrow();
    expect(() => {
      saveApproval(f, { ...view, state: "claimed" });
    }).toThrow();
  });

  it.each([
    "chatId",
    "invocationId",
    "actionDigest",
    "operation",
    "approvalId",
    "bindingGeneration",
  ] as const)("rejects changed %s in a retained approval", (key) => {
    const f = fixture();
    const view = startWrite(f);
    const changes = {
      chatId: "other-chat",
      invocationId: "other-turn",
      actionDigest: "f".repeat(64),
      operation: "jira.edit",
      approvalId: "other-approval",
      bindingGeneration: 2,
    };
    expect(() => {
      saveApproval(f, { ...view, [key]: changes[key] });
    }).toThrow();
  });

  it.each([
    "chat",
    "turn",
    "arguments",
    "operation",
    "unknown-outcome",
    "unsettled-outcome",
    "read-outcome",
    "result-tool",
  ] as const)("fails closed when durable %s linkage is corrupt", (kind) => {
    const f = fixture();
    const view = startWrite(f);
    const row: Record<string, unknown> = { call: mutationCall, approval: view };
    if (kind === "chat") row.approval = { ...view, chatId: "another-chat" };
    if (kind === "turn") row.approval = { ...view, invocationId: "another-turn" };
    if (kind === "arguments") row.call = { ...mutationCall, arguments: { body: "another effect" } };
    if (kind === "operation") row.call = { ...mutationCall, name: "jira_edit" };
    if (kind === "unknown-outcome")
      Object.assign(row, { result: mutationResult(), mutationOutcome: "pending" });
    if (kind === "unsettled-outcome") row.mutationOutcome = "unknown";
    if (kind === "result-tool")
      Object.assign(row, {
        result: {
          ...mutationResult(),
          toolRef: { canonicalId: "keiko.jira.edit", contractVersion: 1 },
        },
        mutationOutcome: "unknown",
      });
    if (kind === "read-outcome")
      Object.assign(row, {
        call,
        approval: undefined,
        result: mutationResult(),
        mutationOutcome: "unknown",
      });
    f.db
      .prepare("UPDATE chat_messages SET tool_transcript_json = ? WHERE id = ?")
      .run(JSON.stringify({ schemaVersion: 1, exchanges: [row] }), f.id);
    expect(() => f.store.findMessageById(f.id)).toThrow("Stored Chat tool transcript is invalid");
  });

  it("keeps a cancelled envelope and observed mutation outcome independently readable", () => {
    const f = fixture();
    startWrite(f);
    const cancelled = validateToolResultEnvelope({
      ...mutationResult(),
      status: "cancelled",
      reason: "explicit-cancellation",
      effectStarted: true,
      toolRef: { canonicalId: "keiko.jira.comment", contractVersion: 1 },
      projectionDigest: "c".repeat(64),
    });
    f.store.updateChatToolTranscript(
      f.id,
      {
        kind: "settled",
        callId: mutationCall.id,
        result: cancelled,
        mutationOutcome: "succeeded-unconfirmed",
      },
      "cancelled-mutation",
    );
    expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]).toMatchObject({
      result: { status: "cancelled", data: null },
      mutationOutcome: "succeeded-unconfirmed",
    });
  });
});

function observedMutationFixture(): ReturnType<typeof fixture> & {
  intent: ChatToolMutationIntent;
} {
  const base = fixture();
  const turn = base.store.admitChatTurn("journal-projection-turn", {
    chatId: base.chatId,
    role: "user",
    content: "Synthetic mutation history",
    timestamp: 1001,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (turn.kind !== "admitted" || turn.userMessage.canonicalTurnRef === undefined)
    throw new Error("Expected canonical turn");
  const f = { ...base, id: turn.userMessage.id };
  const view = startWrite(f);
  const intent: ChatToolMutationIntent = {
    invocationId: view.invocationId,
    chatId: f.chatId,
    userMessageId: f.id,
    turnRef: turn.userMessage.canonicalTurnRef,
    actorId: "private-actor",
    podId: view.podId,
    bindingGeneration: 1,
    credentialGeneration: 1,
    authorityDigest: "a".repeat(64),
    actionDigest: view.actionDigest,
    operation: view.operation,
    correlationId: "mutation-projection-proof",
  };
  const journal = f.store.chatToolMutations;
  if (journal === undefined) throw new Error("Missing mutation owner");
  journal.prepare(intent);
  return { ...f, intent };
}
function acknowledgeMutation(f: ReturnType<typeof observedMutationFixture>): void {
  const journal = f.store.chatToolMutations;
  if (journal === undefined) throw new Error("Missing mutation owner");
  expect(journal.beginDispatch(f.intent.invocationId, () => true)).toBe(true);
  journal.acknowledge(f.intent.invocationId, 201);
  journal.settle(f.intent.invocationId, "succeeded-unconfirmed");
}

describe("authoritative late mutation history", () => {
  it("keeps an active prepared mutation pending instead of claiming no effect", () => {
    const f = observedMutationFixture();
    expect(
      f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.mutationOutcome,
    ).toBeUndefined();
  });
  it("recovers a known acknowledgement even if the process never persisted a catalog result", () => {
    const f = observedMutationFixture();
    acknowledgeMutation(f);
    const exchange = f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0];
    expect(exchange?.mutationOutcome).toBe("succeeded-unconfirmed");
    expect(exchange?.result).toBeUndefined();
    const event = f.logs.events.find((entry) => entry.op === "chat.tool-mutation.projected");
    const line = formatActivityLogProofLine(event ?? {});
    expectActivityLogProof("chat.tool-mutation.projected.line", line);
    expect(line).not.toMatch(/SYN-1|private-actor|comment/);
    expect(line).not.toContain(f.id);
    expect(analyzeLogText(line).timelines).toMatchObject([
      {
        correlationId: "mutation-projection-proof",
        lines: [{ op: "chat.tool-mutation.projected" }],
      },
    ]);
  });
  it.each([
    ["action_digest", "d".repeat(64)],
    ["invocation_id", "other-invocation"],
    ["user_message_id", null],
    ["authority_digest", "g".repeat(64)],
    ["actor_id", "/"],
    ["correlation_id", "private-correlation-canary/invalid"],
    ["operation", "jira.edit"],
  ])("does not attach a mismatched or corrupt journal %s to history", (column, value) => {
    const f = observedMutationFixture();
    acknowledgeMutation(f);
    f.db
      .prepare(`UPDATE chat_tool_mutations SET ${column} = ? WHERE invocation_id = ?`)
      .run(value, f.intent.invocationId);
    expect(
      f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.mutationOutcome,
    ).toBeUndefined();
  });
});

it("retains both source disclosures and upgrades a legacy single disclosure without loss", () => {
  const { store, db, id, chatId } = fixture();
  const jira = {
    kind: "jira-chat-read",
    grantId: "jira-grant",
    chatId,
    podId: "pod-1",
    bindingGeneration: 1,
    authenticationGeneration: 1,
    state: "granted",
    disclosureVersion: "jira-chat-read-v1",
    requestedAt: 1000,
    expiresAt: 2000,
  } as const;
  const mcp = {
    kind: "mcp-chat-read",
    grantId: "mcp-grant",
    chatId,
    configurationDigest: "c".repeat(64),
    state: "pending",
    disclosureVersion: "mcp-chat-read-v1",
    requestedAt: 1000,
    expiresAt: 2000,
  } as const;
  db.prepare("UPDATE chat_messages SET tool_transcript_json = ? WHERE id = ?").run(
    JSON.stringify({ schemaVersion: 1, exchanges: [], readGrant: jira }),
    id,
  );
  store.updateChatToolTranscript(id, { kind: "read-consent", grant: mcp }, "mixed-consent");
  expect(store.findMessageById(id)?.toolTranscript?.readGrants).toEqual([jira, mcp]);
  const granted = { ...mcp, state: "granted" } as const;
  store.updateChatToolTranscript(id, { kind: "read-consent", grant: granted }, "mixed-consent");
  const transcript = store.findMessageById(id)?.toolTranscript;
  expect(transcript?.readGrants).toEqual([jira, granted]);
  expect(transcript?.readGrant).toEqual(granted);
});
