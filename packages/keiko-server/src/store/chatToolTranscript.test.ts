import { jiraOperationBindingForTool, jiraOperationForTool } from "../atlassian/jiraManagedProvider.js";
import { jiraChatWriteAction } from "../atlassian/jiraChatCatalogWrite.js";
import { jiraOperationActionDigest } from "../atlassian/jiraOperationRegistry.js";
import { mcpChatWriteAction } from "../mcp/mcpChatCatalogAdmission.js";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ChatToolMutationIntent } from "./chatToolMutationTypes.js";
import {
  validateToolResultEnvelope,
  type ToolResultValidationBinding,
} from "@oscharko-dev/keiko-tool-catalog";
import type { JiraChatToolWriteApprovalView as ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { buildUiStoreOverDatabase, type UiStore } from "./index.js";
import {
  CHAT_TOOL_TRANSCRIPT_BASE_BYTES,
  CHAT_TOOL_TRANSCRIPT_MAX_BYTES,
  chatToolExchangeReservation,
  chatToolTranscriptOccupancy,
} from "./chatToolTranscript.js";
import { processServerLogSink } from "../process-log-sink.js";
import { jiraMutationDeclarations } from "../atlassian/jiraManagedMutationDescriptors.js";
import { CHAT_TOOL_TURN_BUDGET } from "../chat-tool-turn-budget.js";
import { runMigrations } from "./schema.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  formatActivityLogProofLine,
  expectActivityLogProof,
} from "../../../../tests/support/activity-log-proof.js";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import type {
  ToolDescriptor,
  ToolResultEnvelope,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

const JIRA_MUTATION_DECLARATIONS = jiraMutationDeclarations();

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
function persistedCall(store: UiStore, id: string): ChatToolExchange["call"] | undefined {
  return store.findMessageById(id)?.toolTranscript?.exchanges[0]?.call;
}
describe("ordinary Chat structured tool transcript", () => {
  it("keeps runtime calls rollback-compatible and rejects unknown call origins", () => {
    const { store, db, id } = fixture();
    store.updateChatToolTranscript(
      id,
      { kind: "started", call: { ...call, origin: "runtime" } },
      "runtime-origin-proof",
    );
    expect(persistedCall(store, id)).toEqual(call);
    const row = db.prepare("SELECT tool_transcript_json FROM chat_messages WHERE id = ?").get(id);
    if (typeof row?.tool_transcript_json !== "string")
      throw new TypeError("Missing stored transcript");
    const stored = JSON.parse(row.tool_transcript_json) as {
      exchanges: { call: typeof call & { origin?: "runtime" } }[];
    };
    const storedCall = stored.exchanges[0]?.call;
    expect(Object.keys(storedCall ?? {}).sort()).toEqual(["arguments", "id", "name"]);
    if (storedCall === undefined) throw new TypeError("Missing stored call");
    storedCall.origin = "runtime";
    db.prepare("UPDATE chat_messages SET tool_transcript_json = ? WHERE id = ?").run(
      JSON.stringify(stored),
      id,
    );
    expect(persistedCall(store, id)).toEqual(call);
    const untouched = db
      .prepare("SELECT tool_transcript_json FROM chat_messages WHERE id = ?")
      .get(id);
    expect(untouched?.tool_transcript_json).toBe(JSON.stringify(stored));
    store.updateChatToolTranscript(id, { kind: "started", call }, "runtime-origin-proof");
    const rewritten = db
      .prepare("SELECT tool_transcript_json FROM chat_messages WHERE id = ?")
      .get(id);
    expect(rewritten?.tool_transcript_json).toBe(row.tool_transcript_json);
    expect(() => {
      store.updateChatToolTranscript(
        id,
        {
          kind: "started",
          call: { ...call, id: "invalid-origin", origin: "external" as "runtime" },
        },
        "runtime-origin-proof",
      );
    }).toThrow();
  });

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
  it("fails closed on a tampered row after the same message was read and verified", () => {
    const f = fixture();
    const view = startWrite(f);
    const valid = f.db
      .prepare("SELECT tool_transcript_json AS json FROM chat_messages WHERE id = ?")
      .get(f.id) as { json: string };
    expect(f.store.findMessageById(f.id)?.toolTranscript).toBeDefined();
    expect(f.store.findMessageById(f.id)?.toolTranscript).toBeDefined();
    const row = { call: mutationCall, approval: { ...view, chatId: "another-chat" } };
    f.db
      .prepare("UPDATE chat_messages SET tool_transcript_json = ? WHERE id = ?")
      .run(JSON.stringify({ schemaVersion: 1, exchanges: [row] }), f.id);
    expect(() => f.store.findMessageById(f.id)).toThrow("Stored Chat tool transcript is invalid");
    f.db
      .prepare("UPDATE chat_messages SET tool_transcript_json = ? WHERE id = ?")
      .run(valid.json, f.id);
    expect(f.store.findMessageById(f.id)?.toolTranscript).toBeDefined();
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

const draftCall = {
  id: "draft-call",
  name: "jira_draft",
  arguments: {
    items: [
      { ref: "epic", projectId: "10000", issueTypeId: "10001", fields: { summary: "Epic" } },
      {
        ref: "task",
        projectId: "10000",
        issueTypeId: "10002",
        fields: { summary: "Task" },
        parent: { fieldId: "parent", ref: "epic" },
      },
    ],
  },
};
function draftApproval(f: ReturnType<typeof fixture>): ChatToolWriteApprovalView {
  return {
    ...approval(f),
    invocationId: sha256Hex(canonicalise({ messageId: f.id, callId: draftCall.id })),
    operation: "jira.draft",
    actionDigest: sha256Hex(
      canonicalise({
        operation: "jira.draft",
        argumentsDigest: sha256Hex(canonicalise(draftCall.arguments)),
      }),
    ),
  };
}
function saveDraftApproval(f: ReturnType<typeof fixture>, view: ChatToolWriteApprovalView): void {
  f.store.updateChatToolTranscript(
    f.id,
    { kind: "write-approval", callId: draftCall.id, approval: view },
    "draft-transcript",
  );
}
function startDraft(f: ReturnType<typeof fixture>): ChatToolWriteApprovalView {
  const view = draftApproval(f);
  f.store.updateChatToolTranscript(f.id, { kind: "started", call: draftCall }, "draft-transcript");
  saveDraftApproval(f, view);
  return view;
}
function storedDraftApproval(f: ReturnType<typeof fixture>): unknown {
  return f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.approval;
}

describe("a backlog draft's deselection is part of the one approval (#4178)", () => {
  it("admits the approving transition's deselection and pins it through every later state", () => {
    const f = fixture();
    const view = startDraft(f);
    const approved = { ...view, state: "approved", excludedItemRefs: ["task"] } as const;
    saveDraftApproval(f, approved);
    saveDraftApproval(f, approved);
    saveDraftApproval(f, { ...approved, state: "claimed" });
    expect(storedDraftApproval(f)).toMatchObject({ state: "claimed", excludedItemRefs: ["task"] });
    saveDraftApproval(f, { ...approved, state: "revoked" });
    expect(storedDraftApproval(f)).toMatchObject({ state: "revoked", excludedItemRefs: ["task"] });
  });

  it.each([
    ["dropped when claimed", "claimed", undefined],
    ["changed when claimed", "claimed", ["epic"]],
    ["extended when claimed", "claimed", ["task", "epic"]],
    ["dropped when expired", "expired", undefined],
  ] as const)("refuses an approved deselection %s", (_name, state, excluded) => {
    const f = fixture();
    const view = startDraft(f);
    saveDraftApproval(f, { ...view, state: "approved", excludedItemRefs: ["task"] });
    expect(() => {
      saveDraftApproval(f, {
        ...view,
        state,
        ...(excluded === undefined ? {} : { excludedItemRefs: excluded }),
      });
    }).toThrow("identity conflict");
    expect(storedDraftApproval(f)).toMatchObject({ state: "approved", excludedItemRefs: ["task"] });
  });

  it.each(["pending", "claimed", "rejected", "expired", "revoked"] as const)(
    "refuses a deselection added when the approval becomes %s",
    (state) => {
      const f = fixture();
      const view = startDraft(f);
      expect(() => {
        saveDraftApproval(f, { ...view, state, excludedItemRefs: ["task"] });
      }).toThrow("identity conflict");
      expect(storedDraftApproval(f)).toMatchObject({ state: "pending" });
    },
  );

  it("refuses a deselection added after the approval was already recorded without one", () => {
    const f = fixture();
    const view = startDraft(f);
    saveDraftApproval(f, { ...view, state: "approved" });
    expect(() => {
      saveDraftApproval(f, { ...view, state: "claimed", excludedItemRefs: ["task"] });
    }).toThrow("identity conflict");
  });

  it.each([
    ["an unknown ref", ["ghost"]],
    ["a repeated ref", ["task", "task"]],
  ] as const)("refuses an approving deselection with %s", (_name, excluded) => {
    const f = fixture();
    const view = startDraft(f);
    expect(() => {
      saveDraftApproval(f, { ...view, state: "approved", excludedItemRefs: excluded });
    }).toThrow();
    expect(storedDraftApproval(f)).toMatchObject({ state: "pending" });
  });

  it("refuses a deselection on a first save and any other difference alongside it", () => {
    const f = fixture();
    f.store.updateChatToolTranscript(f.id, { kind: "started", call: draftCall }, "draft-first");
    const view = draftApproval(f);
    expect(() => {
      saveDraftApproval(f, { ...view, state: "approved", excludedItemRefs: ["task"] });
    }).toThrow("identity conflict");
    saveDraftApproval(f, view);
    expect(() => {
      saveDraftApproval(f, {
        ...view,
        state: "approved",
        excludedItemRefs: ["task"],
        expiresAt: 2001,
      });
    }).toThrow("identity conflict");
    expect(storedDraftApproval(f)).toMatchObject({ state: "pending" });
  });

  it("refuses a deselection on an operation that is not a backlog draft", () => {
    const f = fixture();
    const view = startWrite(f);
    expect(() => {
      saveApproval(f, { ...view, state: "approved", excludedItemRefs: ["task"] });
    }).toThrow();
  });
});

function observedMutationFixture(journaled = true): ReturnType<typeof fixture> & {
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
  if (journaled) journal.prepare(intent);
  return { ...f, intent };
}
function acknowledgeMutation(f: ReturnType<typeof observedMutationFixture>): void {
  const journal = f.store.chatToolMutations;
  if (journal === undefined) throw new Error("Missing mutation owner");
  expect(journal.beginDispatch(f.intent.invocationId, () => true)).toBe(true);
  journal.acknowledge(f.intent.invocationId, 201);
  journal.settle(f.intent.invocationId, "succeeded-unconfirmed");
}

function firstStoredExchange(f: ReturnType<typeof fixture>): ChatToolExchange | undefined {
  return f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0];
}

describe("authoritative late mutation history", () => {
  it.each([
    { kind: "current", sourceDigest: undefined },
    { kind: "retired", sourceDigest: undefined },
    { kind: "current", sourceDigest: "a".repeat(64) },
    { kind: "retired", sourceDigest: "a".repeat(64) },
  ])(
    "recovers a late acknowledgement from its $kind contract and source $sourceDigest without a write approval",
    ({ kind, sourceDigest }) => {
      const f = observedMutationFixture(false);
      const current = contractApproval(f).operationBinding;
      const operationBinding =
        kind === "current" ? current : { ...current, contractDigest: "d".repeat(64) };
      if (f.intent.sourceKind === "configured-mcp") throw new TypeError("Expected Jira fixture");
      const intent = {
        ...f.intent,
        actionDigest: jiraOperationActionDigest(
          f.intent.operation,
          sha256Hex(canonicalise(mutationCall.arguments)),
          operationBinding,
          sourceDigest,
        ),
      };
      f.db.prepare("UPDATE chat_messages SET tool_transcript_json = NULL WHERE id = ?").run(f.id);
      f.store.updateChatToolTranscript(
        f.id,
        { kind: "started", call: mutationCall, operationBinding },
        "late-contract-proof",
      );
      if (sourceDigest !== undefined)
        f.store.updateChatToolTranscript(
          f.id,
          { kind: "write-prepared", callId: mutationCall.id, sourceDigest },
          "late-contract-proof",
        );
      const journal = f.store.chatToolMutations;
      if (journal === undefined) throw new TypeError("Missing mutation journal");
      journal.prepare(intent);
      expect(journal.beginDispatch(intent.invocationId, () => true)).toBe(true);
      f.db.prepare("UPDATE chat_messages SET client_turn_state = 'failed' WHERE id = ?").run(f.id);
      expect(firstStoredExchange(f)?.mutationOutcome).toBe("unknown");
      journal.acknowledge(intent.invocationId, 201);
      journal.settle(intent.invocationId, "succeeded");
      const exchange = firstStoredExchange(f);
      expect(exchange?.mutationOutcome).toBe("succeeded");
      expect(exchange?.approval).toBeUndefined();
      expect(exchange?.result).toBeUndefined();
      expect(exchange).not.toHaveProperty("operationBinding");
      expect(exchange).not.toHaveProperty("sourceDigest");
    },
  );

  // The journal commits before any dispatch, so a call it never saw cannot have reached the source:
  // a card that was never decided must not read as a change that may have been applied.
  it("reports a reviewed call the journal never saw as not sent once its turn has ended", () => {
    const f = observedMutationFixture(false);
    const outcome = (): unknown =>
      f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.mutationOutcome;
    expect(outcome()).toBeUndefined();
    f.db.prepare("UPDATE chat_messages SET client_turn_state = 'failed' WHERE id = ?").run(f.id);
    expect(outcome()).toBe("not-dispatched");
    const event = f.logs.events.find((entry) => entry.op === "chat.tool-mutation.projected");
    expect(formatActivityLogProofLine(event ?? {})).not.toContain(f.id);
  });
  it("keeps an ended turn's dispatched call unknown, whatever the card says", () => {
    const f = observedMutationFixture();
    const journal = f.store.chatToolMutations;
    if (journal === undefined) throw new Error("Missing mutation owner");
    expect(journal.beginDispatch(f.intent.invocationId, () => true)).toBe(true);
    f.db.prepare("UPDATE chat_messages SET client_turn_state = 'failed' WHERE id = ?").run(f.id);
    expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.mutationOutcome).toBe(
      "unknown",
    );
  });
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
  // The projection is never persisted, so a polling client re-derives it on every read; the
  // observation is evidence once, not once per poll.
  it("records a projected outcome once however often the message is read", () => {
    const f = observedMutationFixture();
    const journal = f.store.chatToolMutations;
    if (journal === undefined) throw new Error("Missing mutation owner");
    expect(journal.beginDispatch(f.intent.invocationId, () => true)).toBe(true);
    journal.acknowledge(f.intent.invocationId, 201);
    for (let read = 0; read < 25; read++)
      expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.mutationOutcome).toBe(
        "succeeded-unconfirmed",
      );
    const projected = (): number =>
      f.logs.events.filter((entry) => entry.op === "chat.tool-mutation.projected").length;
    expect(projected()).toBe(1);
    journal.settle(f.intent.invocationId, "succeeded");
    for (let read = 0; read < 25; read++)
      expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.mutationOutcome).toBe(
        "succeeded",
      );
    expect(projected()).toBe(2);
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

describe("transcript byte reservation (#4175)", () => {
  it("reserves at least a worst-case stored exchange", () => {
    const maxResultBytes = 262_144;
    const descriptor = {
      toolRef: { canonicalId: "keiko.jira.search", contractVersion: 1 },
      bounds: { maxArgumentBytes: 262_144, maxResultBytes, maxResultCount: 1, maxDurationMs: 1 },
      inputSchema: { description: "s".repeat(8_192) },
    } as unknown as ToolDescriptor;
    const largeCall = { ...call, arguments: { jql: '"'.repeat(100_000) } };
    const stored = {
      call: largeCall,
      result: { ...result(), data: { text: "x".repeat(maxResultBytes - 16) } },
      resultBinding: { descriptor, projectionDigest: "c".repeat(64) },
      approval: {
        ...approval({ id: "m", chatId: "c" } as ReturnType<typeof fixture>),
        excludedItemRefs: Array.from({ length: 32 }, (_, index) => `ref-${String(index)}`),
      },
      mutationOutcome: "unknown",
    };
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThanOrEqual(
      chatToolExchangeReservation(largeCall, descriptor),
    );
    // Reads at the full result bound fit far fewer than the 250 admitted calls, so the turn ends
    // as budget-exhausted before persistence could refuse a started call.
    const fitting = Math.floor(
      (CHAT_TOOL_TRANSCRIPT_MAX_BYTES - CHAT_TOOL_TRANSCRIPT_BASE_BYTES) /
        chatToolExchangeReservation(call, descriptor),
    );
    expect(fitting).toBeGreaterThan(0);
    expect(fitting).toBeLessThan(CHAT_TOOL_TURN_BUDGET.maxToolCalls);
  });
});

function interruptedDraftReceipt(): {
  result: ToolResultEnvelope;
  binding: ToolResultValidationBinding;
} {
  const descriptor = JIRA_MUTATION_DECLARATIONS.find(
    (tool) => tool.name === "jira.draft",
  )?.descriptor;
  if (descriptor === undefined) throw new TypeError("Missing draft descriptor");
  const terminal = validateToolResultEnvelope({
    ...result(),
    status: "timeout",
    reason: "deadline-exceeded",
    effectStarted: true,
    toolRef: descriptor.toolRef,
    projectionDigest: "c".repeat(64),
  });
  if (terminal.projectionDigest === null) throw new TypeError("Missing fixture digest");
  const binding = { descriptor, projectionDigest: terminal.projectionDigest };
  return { result: validateToolResultEnvelope(terminal, binding), binding };
}
const DRAFT_PROGRESS = {
  outcome: "unknown",
  items: [{ ref: "epic", state: "uncertain", issueKey: "SYN-1", messages: ["private-token"] }],
};
describe("interrupted draft receipt retention", () => {
  it("retains the bound acknowledgement through the credential floor without changing timeout or audit privacy", () => {
    const f = fixture();
    startDraft(f);
    const terminal = interruptedDraftReceipt();
    const update = {
      kind: "settled" as const,
      callId: draftCall.id,
      ...terminal,
      mutationOutcome: "succeeded-unconfirmed" as const,
      draftProgress: DRAFT_PROGRESS,
    };
    f.store.updateChatToolTranscript(f.id, update, "draft-receipt-proof");
    const saved = f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0];
    expect(saved).toMatchObject({
      result: { status: "timeout", data: null },
      mutationOutcome: "succeeded-unconfirmed",
      draftProgress: {
        outcome: "unknown",
        items: [{ ref: "epic", state: "uncertain", issueKey: "SYN-1", messages: ["[REDACTED]"] }],
      },
    });
    expect(f.logs.lines().join("\n")).not.toMatch(/SYN-1|private-token/);
    expect(
      f.logs.events.filter((event) => event.op === "chat.tool-transcript.updated").at(-1),
    ).toMatchObject({ extra: { draftReceiptCount: 1 } });
    // A duplicate settlement is allowed; it cannot replace known keys or drop the receipt.
    f.store.updateChatToolTranscript(f.id, update, "draft-receipt-duplicate");
    expect(() => {
      f.store.updateChatToolTranscript(
        f.id,
        {
          ...update,
          draftProgress: {
            ...DRAFT_PROGRESS,
            items: [{ ref: "epic", state: "created", issueKey: "SYN-2" }],
          },
        },
        "draft-receipt-conflict",
      );
    }).toThrow("identity conflict");
    const { draftProgress: _progress, ...withoutProgress } = update;
    expect(() => {
      f.store.updateChatToolTranscript(f.id, withoutProgress, "draft-receipt-drop");
    }).toThrow();
  });
  it("refuses draft progress attached to a different stored tool call", () => {
    const f = fixture();
    f.store.updateChatToolTranscript(f.id, { kind: "started", call }, "foreign-call-started");
    expect(() => {
      f.store.updateChatToolTranscript(
        f.id,
        {
          kind: "settled",
          callId: call.id,
          ...interruptedDraftReceipt(),
          mutationOutcome: "succeeded-unconfirmed",
          draftProgress: DRAFT_PROGRESS,
        },
        "foreign-call-receipt",
      );
    }).toThrow();
    const saved = f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0];
    expect(saved?.call).toEqual(call);
    expect(saved?.result).toBeUndefined();
    expect(saved?.draftProgress).toBeUndefined();
  });
  it.each([
    "wrong-tool",
    "missing-binding",
    "no-effect",
    "not-dispatched",
    "bad-schema",
    "oversized",
  ] as const)("refuses %s receipt data instead of broadening a catalog result", (kind) => {
    const f = fixture();
    startDraft(f);
    const terminal = interruptedDraftReceipt();
    const candidate = {
      kind: "settled" as const,
      callId: draftCall.id,
      ...terminal,
      mutationOutcome: "succeeded-unconfirmed" as const,
      draftProgress: DRAFT_PROGRESS,
    };
    const bad: unknown =
      kind === "wrong-tool"
        ? {
            ...candidate,
            result: {
              ...terminal.result,
              toolRef: { canonicalId: "keiko.jira.comment", contractVersion: 3 },
            },
          }
        : kind === "missing-binding"
          ? { ...candidate, binding: undefined }
          : kind === "no-effect"
            ? { ...candidate, result: { ...terminal.result, effectStarted: false } }
            : kind === "not-dispatched"
              ? { ...candidate, mutationOutcome: "not-dispatched" }
              : kind === "bad-schema"
                ? { ...candidate, draftProgress: { outcome: "invented" } }
                : {
                    ...candidate,
                    draftProgress: { outcome: "unknown", guidance: "x".repeat(300000) },
                  };
    expect(() => {
      f.store.updateChatToolTranscript(f.id, bad as typeof candidate, "draft-receipt-refusal");
    }).toThrow();
    expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.result).toBeUndefined();
  });
});

function contractApproval(f: ReturnType<typeof fixture>): {
  approval: ChatToolWriteApprovalView;
  operationBinding: NonNullable<ReturnType<typeof jiraOperationBindingForTool>>;
} {
  const view = approval(f);
  const operationBinding = jiraOperationBindingForTool(view.operation);
  if (operationBinding === undefined) throw new TypeError("Missing operation contract");
  const intent = jiraChatWriteAction({
    actionId: view.invocationId,
    idempotencyKey: "synthetic-contract-approval",
    tool: view.operation,
    argumentsDigest: sha256Hex(canonicalise(mutationCall.arguments)),
    operationBinding,
  });
  if (intent === undefined) throw new TypeError("Missing governed write intent");
  return { approval: { ...view, actionDigest: intent.actionDigest }, operationBinding };
}

describe("persisted Jira operation approval contracts", () => {
  it("captures a read with its schema snapshot and refuses write metadata or an effect claim", () => {
    const f = fixture();
    const contract = jiraOperationForTool("jira.projects");
    if (contract === undefined) throw new Error("Expected read contract");
    const binding = { descriptor: contract.declaration.descriptor, projectionDigest: "a".repeat(64) };
    const call = { id: "mcp-read-synthetic", name: "jira_projects", arguments: {} };
    const data = { outcome: "succeeded", items: [], startAt: 0, total: 0, operationBinding: contract.binding };
    const result = validateToolResultEnvelope({
      schemaVersion: 1, invocationId: call.id, toolRef: binding.descriptor.toolRef,
      projectionDigest: binding.projectionDigest, status: "completed", reason: "none",
      effectStarted: false, data, page: { truncated: false, reason: "none", cursor: null },
      metrics: { inputBytes: 2, outputBytes: Buffer.byteLength(JSON.stringify(data)), resultCount: 0, durationMs: 0 },
    }, binding);
    const captured = { kind: "captured", call, result, binding } as const;
    f.store.updateChatToolTranscript(f.id, captured, "native-read");
    expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges).toEqual([{ call, result }]);
    expect(() => f.store.updateChatToolTranscript(f.id, {
      ...captured, mutationOutcome: "succeeded",
    }, "native-read")).toThrow();
    expect(() => f.store.updateChatToolTranscript(f.id, {
      ...captured, operationBinding: contract.binding,
    }, "native-read")).toThrow();
    expect(() => f.store.updateChatToolTranscript(f.id, {
      ...captured, result: { ...result, effectStarted: true },
    }, "native-read")).toThrow();
    expect(() => f.store.updateChatToolTranscript(f.id, {
      ...captured, call: { ...call, name: "jira_guessed" },
    }, "native-read")).toThrow();
    expect(chatToolTranscriptOccupancy(f.db, f.id).exchangeCount).toBe(1);
  });

  it("captures a native result atomically with its private snapshot and no intermediate start", () => {
    const f = fixture();
    const contract = jiraOperationForTool("jira.comment");
    const prior = mutationResult();
    if (contract === undefined || prior.projectionDigest === null) throw new Error("Expected snapshot");
    const binding = { descriptor: contract.declaration.descriptor, projectionDigest: prior.projectionDigest };
    const nativeCall = { ...mutationCall, id: "mcp-synthetic-native-call" };
    const result = validateToolResultEnvelope({ ...prior, invocationId: nativeCall.id,
      toolRef: binding.descriptor.toolRef }, binding);
    const captured = { kind: "captured", call: nativeCall, result, binding,
      nativeArgumentsDigest: sha256Hex(canonicalise(nativeCall.arguments)),
      operationBinding: contract.binding, mutationOutcome: "not-dispatched" } as const;
    f.store.updateChatToolTranscript(f.id, captured, "native-result");
    const stored = f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0];
    expect(stored).toMatchObject({ call: nativeCall, result, mutationOutcome: "not-dispatched" });
    expect(stored).not.toHaveProperty("operationBinding");
    expect(stored).not.toHaveProperty("resultBinding");
    expect(stored).not.toHaveProperty("nativeArgumentsDigest");
    expect(chatToolTranscriptOccupancy(f.db, f.id)).toEqual({
      exchangeCount: 1,
      bytes: Buffer.byteLength(String(f.db.prepare("SELECT tool_transcript_json AS json FROM chat_messages WHERE id=?")
        .get(f.id)?.json)),
    });
    expect(f.logs.events.filter((event) => event.op === "chat.tool-transcript.updated")
      .map((event) => event.extra?.phase)).toEqual(["captured"]);
    expect(() => f.store.updateChatToolTranscript(f.id, { ...captured,
      call: { ...mutationCall, id: "invalid-capture" },
      result: { ...result, status: "failed", reason: "provider-reported-error", page: null,
        data: { unexpected: "private-token" } } satisfies ToolResultEnvelope,
    }, "native-result")).toThrow();
    expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges).toHaveLength(1);
    expect(JSON.stringify(f.logs.events)).not.toContain("private-token");
    expect(() => f.store.updateChatToolTranscript(f.id, {
      kind: "captured", call: nativeCall, result, binding,
    }, "native-result")).toThrow();
  });

  it.each(["jira.create-project", "jira.update-project"] as const)(
    "binds a hyphenated project operation to its normalized call alias: %s",
    (operation) => {
      const f = fixture();
      const projectCall = {
        id: "project-call",
        name: operation.replace(/[.-]/gu, "_"),
        arguments: { projectIdOrKey: "SYN", name: "Updated" },
      };
      const operationBinding = jiraOperationBindingForTool(operation);
      if (operationBinding === undefined) throw new TypeError("Missing project contract");
      const view = {
        ...approval(f),
        operation,
        invocationId: sha256Hex(canonicalise({ messageId: f.id, callId: projectCall.id })),
        actionDigest: jiraOperationActionDigest(
          operation,
          sha256Hex(canonicalise(projectCall.arguments)),
          operationBinding,
        ),
      };
      f.store.updateChatToolTranscript(
        f.id,
        { kind: "started", call: projectCall, operationBinding },
        "project-alias",
      );
      f.store.updateChatToolTranscript(
        f.id,
        { kind: "write-approval", callId: projectCall.id, approval: view },
        "project-alias",
      );
      expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.approval).toEqual(view);
    },
  );

  it("pins the prepared source before approval and keeps it private across history reads", () => {
    const f = fixture();
    const bound = contractApproval(f);
    const sourceDigest = "a".repeat(64);
    f.store.updateChatToolTranscript(
      f.id,
      { kind: "started", call: mutationCall, operationBinding: bound.operationBinding },
      "source-proof",
    );
    const prepared = { kind: "write-prepared" as const, callId: mutationCall.id, sourceDigest };
    f.store.updateChatToolTranscript(f.id, prepared, "source-proof");
    f.store.updateChatToolTranscript(f.id, prepared, "source-proof");
    const reviewed = {
      ...bound.approval,
      actionDigest: jiraOperationActionDigest(
        bound.approval.operation,
        sha256Hex(canonicalise(mutationCall.arguments)),
        bound.operationBinding,
        sourceDigest,
      ),
    };
    f.store.updateChatToolTranscript(
      f.id,
      { kind: "write-approval", callId: mutationCall.id, approval: reviewed },
      "source-proof",
    );
    const exchange = f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0];
    expect(exchange?.approval).toEqual(reviewed);
    expect(exchange).not.toHaveProperty("sourceDigest");
    expect(() => {
      f.store.updateChatToolTranscript(
        f.id,
        { ...prepared, sourceDigest: "b".repeat(64) },
        "source-proof",
      );
    }).toThrow();
    const row = f.db
      .prepare("SELECT tool_transcript_json AS json FROM chat_messages WHERE id = ?")
      .get(f.id) as { json: string };
    const stored = JSON.parse(row.json) as { exchanges: { sourceDigest: string }[] };
    expect(stored.exchanges[0]?.sourceDigest).toBe(sourceDigest);
    if (stored.exchanges[0] === undefined) throw new TypeError("Missing exchange");
    stored.exchanges[0].sourceDigest = "b".repeat(64);
    f.db
      .prepare("UPDATE chat_messages SET tool_transcript_json = ? WHERE id = ?")
      .run(JSON.stringify(stored), f.id);
    expect(() => f.store.findMessageById(f.id)).toThrow();
  });

  it.each(["approved", "settled", "foreign", "unbound", "malformed"] as const)(
    "refuses a source snapshot that is %s before it can change reviewed history",
    (kind) => {
      const f = fixture();
      const bound = contractApproval(f);
      const ownCall =
        kind === "foreign" ? { ...mutationCall, name: "mcp_synthetic_write" } : mutationCall;
      f.store.updateChatToolTranscript(
        f.id,
        {
          kind: "started",
          call: ownCall,
          ...(kind === "foreign" || kind === "unbound"
            ? {}
            : { operationBinding: bound.operationBinding }),
        },
        "source-refusal",
      );
      if (kind === "approved")
        f.store.updateChatToolTranscript(
          f.id,
          { kind: "write-approval", callId: mutationCall.id, approval: bound.approval },
          "source-refusal",
        );
      if (kind === "settled")
        f.store.updateChatToolTranscript(
          f.id,
          { kind: "settled", callId: mutationCall.id, result: result() },
          "source-refusal",
        );
      expect(() => {
        f.store.updateChatToolTranscript(
          f.id,
          {
            kind: "write-prepared",
            callId: mutationCall.id,
            sourceDigest: kind === "malformed" ? "invalid" : "a".repeat(64),
          },
          "source-refusal",
        );
      }).toThrow();
    },
  );

  it("pins the write contract before its first approval and refuses replacement or omission", () => {
    const f = fixture();
    const bound = contractApproval(f);
    const start = {
      kind: "started" as const,
      call: mutationCall,
      operationBinding: bound.operationBinding,
    };
    f.store.updateChatToolTranscript(f.id, start, "captured-contract");
    f.store.updateChatToolTranscript(f.id, start, "captured-contract");
    expect(() => {
      f.store.updateChatToolTranscript(
        f.id,
        { kind: "started", call: mutationCall },
        "captured-contract",
      );
    }).toThrow("Tool call identity conflict");
    const operationBinding = { ...bound.operationBinding, contractDigest: "e".repeat(64) };
    expect(() => {
      f.store.updateChatToolTranscript(
        f.id,
        {
          kind: "write-approval",
          callId: mutationCall.id,
          operationBinding,
          approval: {
            ...bound.approval,
            actionDigest: jiraOperationActionDigest(
              bound.approval.operation,
              sha256Hex(canonicalise(mutationCall.arguments)),
              operationBinding,
            ),
          },
        },
        "captured-contract",
      );
    }).toThrow("Tool approval identity conflict");
  });

  it("preserves the external MCP approval digest without accepting a Jira snapshot", () => {
    const f = fixture();
    const mcpCall = { ...mutationCall, name: "mcp_synthetic_write" };
    const identity = mcpChatWriteAction({
      actionId: sha256Hex(canonicalise({ messageId: f.id, callId: mcpCall.id })),
      idempotencyKey: "external-approval",
      name: mcpCall.name,
      serverName: "synthetic",
      toolName: "write",
      risk: "write",
      argumentsDigest: sha256Hex(canonicalise(mcpCall.arguments)),
    });
    const view = approval(f);
    const mcpApproval = {
      kind: "mcp-chat-write" as const,
      approvalId: view.approvalId,
      chatId: f.chatId,
      configurationDigest: "c".repeat(64),
      requestedAt: view.requestedAt,
      expiresAt: view.expiresAt,
      state: view.state,
      ...identity,
    };
    f.store.updateChatToolTranscript(f.id, { kind: "started", call: mcpCall }, "mcp-proof");
    const update = { kind: "write-approval" as const, callId: mcpCall.id, approval: mcpApproval };
    f.store.updateChatToolTranscript(f.id, update, "mcp-proof");
    expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.approval).toEqual(
      mcpApproval,
    );
    expect(() => {
      f.store.updateChatToolTranscript(
        f.id,
        {
          ...update,
          operationBinding: contractApproval(f).operationBinding,
        },
        "mcp-proof",
      );
    }).toThrow("Tool approval identity conflict");
  });

  it("saves a current contract-bound approval and keeps its binding private across state transitions", () => {
    const f = fixture();
    const bound = contractApproval(f);
    f.store.updateChatToolTranscript(
      f.id,
      { kind: "started", call: mutationCall },
      "contract-proof",
    );
    const update = { kind: "write-approval" as const, callId: mutationCall.id, ...bound };
    f.store.updateChatToolTranscript(f.id, update, "contract-proof");
    expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.approval).toEqual(
      bound.approval,
    );
    expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]).not.toHaveProperty(
      "operationBinding",
    );
    saveApproval(f, { ...bound.approval, state: "expired" });
    expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.approval?.state).toBe(
      "expired",
    );
    const row = f.db
      .prepare("SELECT tool_transcript_json AS json FROM chat_messages WHERE id = ?")
      .get(f.id) as { json: string };
    expect(JSON.parse(row.json)).toMatchObject({
      exchanges: [{ operationBinding: bound.operationBinding }],
    });
  });

  it("reads legacy approval history without giving it a current operation binding", () => {
    const f = fixture();
    const view = startWrite(f);
    expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.approval).toEqual(view);
    expect(view.actionDigest).not.toBe(contractApproval(f).approval.actionDigest);
  });

  it("reads a retired contract snapshot while the write owner refuses it for execution", () => {
    const f = fixture();
    const bound = contractApproval(f);
    const operationBinding = { ...bound.operationBinding, contractDigest: "d".repeat(64) };
    const argumentsDigest = sha256Hex(canonicalise(mutationCall.arguments));
    const historical = {
      ...bound.approval,
      actionDigest: jiraOperationActionDigest(
        bound.approval.operation,
        argumentsDigest,
        operationBinding,
      ),
      state: "expired" as const,
    };
    f.db.prepare("UPDATE chat_messages SET tool_transcript_json = ? WHERE id = ?").run(
      JSON.stringify({
        schemaVersion: 1,
        exchanges: [
          {
            call: mutationCall,
            approval: historical,
            operationBinding: operationBinding,
          },
        ],
      }),
      f.id,
    );
    expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.approval).toEqual(
      historical,
    );
    expect(
      jiraChatWriteAction({
        actionId: historical.invocationId,
        idempotencyKey: "retired-contract",
        tool: historical.operation,
        argumentsDigest,
        operationBinding,
      }),
    ).toBeUndefined();
  });

  it.each(["missing", "digest", "identity", "extra-field"] as const)(
    "refuses a stored approval with a %s contract snapshot",
    (kind) => {
      const f = fixture();
      const bound = contractApproval(f);
      const changed =
        kind === "missing"
          ? undefined
          : kind === "digest"
            ? { ...bound.operationBinding, contractDigest: "e".repeat(64) }
            : kind === "identity"
              ? { ...bound.operationBinding, identity: "POST /retired" }
              : { ...bound.operationBinding, endpoint: "untrusted" };
      f.db.prepare("UPDATE chat_messages SET tool_transcript_json = ? WHERE id = ?").run(
        JSON.stringify({
          schemaVersion: 1,
          exchanges: [
            {
              call: mutationCall,
              approval: bound.approval,
              operationBinding: changed,
            },
          ],
        }),
        f.id,
      );
      expect(() => f.store.findMessageById(f.id)).toThrow("Stored Chat tool transcript is invalid");
    },
  );

  it("does not replace the contract snapshot of an existing approval", () => {
    const f = fixture();
    const bound = contractApproval(f);
    f.store.updateChatToolTranscript(
      f.id,
      { kind: "started", call: mutationCall },
      "contract-proof",
    );
    const update = { kind: "write-approval" as const, callId: mutationCall.id, ...bound };
    f.store.updateChatToolTranscript(f.id, update, "contract-proof");
    const operationBinding = { ...bound.operationBinding, contractDigest: "e".repeat(64) };
    expect(() => {
      f.store.updateChatToolTranscript(
        f.id,
        {
          ...update,
          operationBinding,
          approval: {
            ...bound.approval,
            state: "approved",
            actionDigest: jiraOperationActionDigest(
              bound.approval.operation,
              sha256Hex(canonicalise(mutationCall.arguments)),
              operationBinding,
            ),
          },
        },
        "contract-proof",
      );
    }).toThrow("Tool approval identity conflict");
    expect(f.store.findMessageById(f.id)?.toolTranscript?.exchanges[0]?.approval).toEqual(
      bound.approval,
    );
  });
});
