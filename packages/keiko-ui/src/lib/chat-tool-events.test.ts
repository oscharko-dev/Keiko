import { describe, expect, it } from "vitest";
import type {
  ChatMessage,
  DesktopChatStreamWriteApprovalEvent,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { applyChatWriteApproval } from "./chat-tool-events";

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
