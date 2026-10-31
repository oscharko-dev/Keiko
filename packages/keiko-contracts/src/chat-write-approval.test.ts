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

describe("backlog draft deselection (#4178)", () => {
  const draft = { ...approval(), operation: "jira.draft" as const };
  it("carries the deselected draft items on a draft approval only", () => {
    const value = { ...draft, state: "approved" as const, excludedItemRefs: ["task-2", "bug_1"] };
    expect(validateChatToolWriteApprovalView(value)).toEqual({ ok: true, value });
    expect(validateChatToolWriteApprovalView({ ...value, operation: "jira.create" }).ok).toBe(
      false,
    );
  });
  it.each([
    ["not an array", "task"],
    ["an invalid reference", ["1task"]],
    ["a duplicate", ["a", "a"]],
    ["too many", Array.from({ length: 33 }, (_, index) => `r${String(index)}`)],
  ])("refuses a deselection that is %s", (_name, excludedItemRefs) => {
    expect(validateChatToolWriteApprovalView({ ...draft, excludedItemRefs }).ok).toBe(false);
    expect(
      validateChatToolWriteApprovalDecision({
        decision: "approve",
        actionDigest: "b".repeat(64),
        excludedItemRefs,
      }).ok,
    ).toBe(false);
  });
  it("accepts a deselection only with an approval decision", () => {
    const value = { decision: "approve", actionDigest: "b".repeat(64), excludedItemRefs: ["a"] };
    expect(validateChatToolWriteApprovalDecision(value)).toEqual({ ok: true, value });
    expect(validateChatToolWriteApprovalDecision({ ...value, decision: "reject" }).ok).toBe(false);
  });
  it("never accepts a deselection on a configured MCP approval", () => {
    const mcp = {
      kind: "mcp-chat-write",
      approvalId: "approval-1",
      chatId: "chat-1",
      configurationDigest: "c".repeat(64),
      invocationId: "action-1",
      operation: "tool",
      actionDigest: "a".repeat(64),
      requestedAt: 1700000000000,
      expiresAt: 1700000600000,
      state: "pending",
    };
    expect(validateChatToolWriteApprovalView(mcp).ok).toBe(true);
    expect(validateChatToolWriteApprovalView({ ...mcp, excludedItemRefs: [] }).ok).toBe(false);
  });
});

describe("the reviewed file of an attachment approval (#4176)", () => {
  const attach = { ...approval(), operation: "jira.attach" as const };
  const preview = { name: "report.txt", sizeBytes: 1024, sha256: "a".repeat(64) };
  it("carries the file's name, size and digest on an attachment approval only", () => {
    const value = { ...attach, attachment: preview };
    expect(validateChatToolWriteApprovalView(value)).toEqual({ ok: true, value });
    expect(validateChatToolWriteApprovalView({ ...value, operation: "jira.edit" }).ok).toBe(false);
  });
  it.each([
    ["a path as the name", { ...preview, name: "docs/report.txt" }],
    ["an empty file", { ...preview, sizeBytes: 0 }],
    ["a file past the ceiling", { ...preview, sizeBytes: 20 * 1024 * 1024 + 1 }],
    ["a malformed digest", { ...preview, sha256: "XYZ" }],
    ["file content", { ...preview, content: "body" }],
    ["a missing digest", { name: preview.name, sizeBytes: preview.sizeBytes }],
    ["not an object", "report.txt"],
  ])("refuses a preview with %s", (_label, attachment) => {
    expect(validateChatToolWriteApprovalView({ ...attach, attachment }).ok).toBe(false);
  });
});
