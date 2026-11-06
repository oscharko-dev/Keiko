import { describe, expect, it } from "vitest";
import type {
  ChatMessage,
  ChatToolExchange,
  DesktopChatStreamWriteApprovalEvent,
  DesktopChatStreamReadConsentEvent,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  knowledgeTurnCoverage,
  knowledgeCoverageIssues,
} from "@oscharko-dev/keiko-contracts/runtime/knowledge-turn-coverage";
import {
  applyChatReadConsent,
  applyChatToolExchange,
  applyChatWriteApproval,
  chatToolReadGrants,
} from "./chat-tool-events";

const event: DesktopChatStreamWriteApprovalEvent["data"] = {
  messageId: "server-message",
  call: {
    id: "call-1",
    name: "jira_edit",
    arguments: { issueKey: "LAB-1", fields: { summary: "Reviewed change" } },
  },
  approval: {
    kind: "jira-chat-write",
    approvalId: "approval-1",
    chatId: "chat-1",
    podId: "11111111-1111-4111-8111-111111111111",
    bindingGeneration: 1,
    authenticationGeneration: 1,
    invocationId: "action-1",
    operation: "jira.edit",
    actionDigest: "a".repeat(64),
    requestedAt: 1000,
    expiresAt: 2000,
    state: "pending",
  },
};
const message: ChatMessage = {
  id: "optimistic",
  chatId: "chat-1",
  role: "user",
  content: "Edit Jira",
  timestamp: 1000,
  turnState: "pending",
  runId: undefined,
  workflowId: undefined,
  workflowStatus: undefined,
  shortResult: undefined,
  taskType: undefined,
};
describe("canonical Chat write approval events", () => {
  it("populates an optimistic turn with the exact reviewable call and deduplicates repeated events", () => {
    const result = applyChatWriteApproval(message, event);
    expect(result.id).toBe("server-message");
    expect(result.toolTranscript?.exchanges).toEqual([
      { call: event.call, approval: event.approval },
    ]);
    expect(applyChatWriteApproval(result, event)).toEqual(result);
  });
  it("never reopens a completed turn or admits an approval from another Chat", () => {
    const terminal = { ...message, turnState: "completed" } as const;
    expect(applyChatWriteApproval(terminal, event)).toBe(terminal);
    expect(
      applyChatWriteApproval(message, {
        ...event,
        approval: { ...event.approval, chatId: "other" },
      }),
    ).toBe(message);
  });
  it("preserves settled remote outcomes and terminal approval states after late pending events", () => {
    const entry = {
      call: event.call,
      approval: { ...event.approval, state: "claimed" as const },
      mutationOutcome: "succeeded" as const,
    };
    const settled = {
      ...message,
      toolTranscript: { schemaVersion: 1 as const, exchanges: [entry] },
    };
    expect(applyChatWriteApproval(settled, event).toolTranscript?.exchanges[0]).toBe(entry);
    const revoked = {
      ...entry,
      mutationOutcome: undefined,
      approval: { ...entry.approval, state: "revoked" as const },
    };
    const pending = {
      ...message,
      toolTranscript: { schemaVersion: 1 as const, exchanges: [revoked] },
    };
    expect(applyChatWriteApproval(pending, event).toolTranscript?.exchanges[0]).toBe(revoked);
  });
});

const jiraRead: DesktopChatStreamReadConsentEvent["data"] = {
  messageId: "server-message",
  grant: {
    kind: "jira-chat-read",
    grantId: "jira-read",
    chatId: "chat-1",
    podId: "11111111-1111-4111-8111-111111111111",
    bindingGeneration: 1,
    authenticationGeneration: 1,
    state: "pending",
    disclosureVersion: "jira-chat-read-v1",
    requestedAt: 1000,
    expiresAt: 2000,
  },
};
const mcpRead: DesktopChatStreamReadConsentEvent["data"] = {
  messageId: "server-message",
  grant: {
    kind: "mcp-chat-read",
    grantId: "mcp-read",
    chatId: "chat-1",
    configurationDigest: "b".repeat(64),
    state: "pending",
    disclosureVersion: "mcp-chat-read-v1",
    requestedAt: 1000,
    expiresAt: 2000,
  },
};
describe("independent Chat source consent events", () => {
  it("retains both sources when the second event arrives and replaces only its own source", () => {
    const first = applyChatReadConsent(message, jiraRead);
    const both = applyChatReadConsent(first, mcpRead);
    const approved = { ...jiraRead.grant, state: "granted" as const };
    const updated = applyChatReadConsent(both, { ...jiraRead, grant: approved });
    expect(chatToolReadGrants(both.toolTranscript)).toEqual([jiraRead.grant, mcpRead.grant]);
    expect(chatToolReadGrants(updated.toolTranscript)).toEqual([approved, mcpRead.grant]);
    expect(updated.toolTranscript?.readGrant).toEqual(approved);
    expect(applyChatReadConsent(updated, jiraRead)).toBe(updated);
  });
  it("preserves an older single-source persisted grant when another source arrives", () => {
    const legacy = {
      ...message,
      toolTranscript: {
        schemaVersion: 1 as const,
        exchanges: [],
        readGrant: jiraRead.grant,
      },
    };
    expect(chatToolReadGrants(legacy.toolTranscript)).toEqual([jiraRead.grant]);
    expect(chatToolReadGrants(applyChatReadConsent(legacy, mcpRead).toolTranscript)).toEqual([
      jiraRead.grant,
      mcpRead.grant,
    ]);
  });
  it("never revives revoked consent but permits a distinct new consent request", () => {
    const revoked = applyChatReadConsent(message, {
      ...mcpRead,
      grant: { ...mcpRead.grant, state: "revoked" },
    });
    expect(
      applyChatReadConsent(revoked, {
        ...mcpRead,
        grant: { ...mcpRead.grant, state: "granted" },
      }),
    ).toBe(revoked);
    const fresh = { ...mcpRead.grant, grantId: "replacement-read" };
    expect(
      chatToolReadGrants(
        applyChatReadConsent(revoked, {
          ...mcpRead,
          grant: fresh,
        }).toolTranscript,
      ),
    ).toEqual([fresh]);
  });
  it("ignores foreign-Chat and completed-turn events", () => {
    expect(
      applyChatReadConsent(message, {
        ...mcpRead,
        grant: { ...mcpRead.grant, chatId: "other-chat" },
      }),
    ).toBe(message);
    const completed = { ...message, turnState: "completed" as const };
    expect(applyChatReadConsent(completed, mcpRead)).toBe(completed);
  });
});
describe("a running turn's tool calls", () => {
  const started = { messageId: "server-message", exchange: { call: event.call } };
  it("shows a call as it starts, on the server's message", () => {
    const result = applyChatToolExchange(message, started);
    expect(result.id).toBe("server-message");
    expect(result.turnState).toBe("pending");
    expect(result.toolTranscript?.exchanges).toEqual([{ call: event.call }]);
  });
  it("settles the same call in place and keeps its approval, which has its own event", () => {
    const approved = applyChatWriteApproval(message, event);
    const settled = applyChatToolExchange(approved, {
      messageId: "server-message",
      exchange: { call: event.call, mutationOutcome: "unknown" },
    });
    expect(settled.toolTranscript?.exchanges).toEqual([
      { call: event.call, approval: event.approval, mutationOutcome: "unknown" },
    ]);
  });
  it("never reopens a finished turn", () => {
    const terminal = { ...message, turnState: "failed" } as const;
    expect(applyChatToolExchange(terminal, started)).toBe(terminal);
  });
});

function knowledgeReadReceipt(): ChatToolExchange {
  return {
    call: { id: "knowledge-1", name: "knowledge_documents", arguments: { view: "read" } },
    result: {
      schemaVersion: 1,
      invocationId: "knowledge-result",
      projectionDigest: null,
      toolRef: { canonicalId: "keiko.knowledge.documents", contractVersion: 1 },
      status: "completed",
      reason: "none",
      effectStarted: false,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 0, durationMs: 1 },
      page: { truncated: true, reason: "result-cap", cursor: null },
      data: { outcome: "succeeded", view: "read", nextCursor: "next-page", items: [] },
    },
  };
}

it.each(["completed", "failed", "cancelled"] as const)(
  "keeps identical coverage across streamed receipts, %s settlement and canonical reload",
  (turnState) => {
    const exchange = knowledgeReadReceipt();
    const streamed = applyChatToolExchange(message, { messageId: "server-message", exchange });
    const terminal: ChatMessage = { ...streamed, turnState };
    const restored = JSON.parse(JSON.stringify(terminal)) as ChatMessage;
    const coverage = knowledgeTurnCoverage(streamed.toolTranscript?.exchanges ?? []);
    expect(knowledgeCoverageIssues(coverage)).toEqual([{ kind: "pending-reads", count: 1 }]);
    expect(knowledgeTurnCoverage(restored.toolTranscript?.exchanges ?? [])).toEqual(coverage);
    expect(restored.toolTranscript?.exchanges).toEqual([exchange]);
    expect(applyChatToolExchange(restored, { messageId: "server-message", exchange })).toBe(
      restored,
    );
  },
);
