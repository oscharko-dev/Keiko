import { describe, expect, it } from "vitest";
import {
  CHAT_TOOL_WRITE_APPROVAL_STATES,
  validateChatToolWriteApprovalDecision,
  validateChatToolWriteApprovalView,
  type ChatToolWriteApprovalView,
} from "./chat-tool-authority.js";

function approval(): ChatToolWriteApprovalView {
  return {
    kind: "jira-chat-write",
    approvalId: "approval-1",
    chatId: "chat-1",
    podId: "d5f5681e-ce98-4c3c-b27e-51d707c9d018",
    bindingGeneration: 1,
    authenticationGeneration: 2,
    invocationId: "action-1",
    operation: "jira.comment",
    actionDigest: "a".repeat(64),
    requestedAt: 1700000000000,
    expiresAt: 1700000600000,
    state: "pending",
  };
}

describe("concrete Jira Chat write approval", () => {
  it.each(CHAT_TOOL_WRITE_APPROVAL_STATES)(
    "preserves the %s state independently of remote success",
    (state) => {
      const value = { ...approval(), state };
      expect(validateChatToolWriteApprovalView(value)).toEqual({ ok: true, value });
    },
  );
  it.each([
    { actorDigest: "a".repeat(64) },
    { authority: "private" },
    { approvalId: "" },
    { operation: "jira.search" },
    { state: "succeeded" },
    { actionDigest: "unknown" },
    { bindingGeneration: 0 },
    { authenticationGeneration: -1 },
    { requestedAt: Number.NaN },
    { expiresAt: 1700000000000 },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
  ])("refuses malformed or private projection data %#", (patch) => {
    expect(validateChatToolWriteApprovalView({ ...approval(), ...patch }).ok).toBe(false);
  });
  it("requires own facts and keeps hostile unknown field names out of diagnostics", () => {
    expect(validateChatToolWriteApprovalView(Object.create(approval())).ok).toBe(false);
    const result = validateChatToolWriteApprovalView({ ...approval(), "private-material": true });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private-material");
  });
  it.each(["approve", "reject"])("requires the exact action digest for %s", (decision) => {
    const value = { decision, actionDigest: "b".repeat(64) };
    expect(validateChatToolWriteApprovalDecision(value)).toEqual({ ok: true, value });
    expect(validateChatToolWriteApprovalDecision({ decision }).ok).toBe(false);
    expect(validateChatToolWriteApprovalDecision({ ...value, actor: "caller" }).ok).toBe(false);
  });
});
