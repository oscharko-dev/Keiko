import { describe, expect, it } from "vitest";
import { JIRA_AVATAR_UPLOAD_MUTATIONS } from "./jira-tool-execution.js";
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
  it("has no count limit: a deselection of 1,200 items of a large draft is valid", () => {
    const excludedItemRefs = Array.from({ length: 1200 }, (_, index) => `r${String(index)}`);
    expect(validateChatToolWriteApprovalView({ ...draft, excludedItemRefs }).ok).toBe(true);
    expect(
      validateChatToolWriteApprovalDecision({
        decision: "approve",
        actionDigest: "b".repeat(64),
        excludedItemRefs,
      }).ok,
    ).toBe(true);
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
  it("carries the file's name, size and digest only for governed file upload operations", () => {
    const value = { ...attach, attachment: preview };
    expect(validateChatToolWriteApprovalView(value)).toEqual({ ok: true, value });
    expect(validateChatToolWriteApprovalView({ ...value, operation: "jira.edit" }).ok).toBe(false);
    const email = {
      ...value,
      operation: "jira.upload-email-template-pack",
      attachment: { ...preview, name: "templates.zip" },
    };
    expect(validateChatToolWriteApprovalView(email)).toEqual({ ok: true, value: email });
    for (const operation of [
      "jira.apply-email-template-pack",
      "jira.revert-email-template-pack",
      "jira.set-application-property",
    ])
      expect(validateChatToolWriteApprovalView({ ...email, operation }).ok).toBe(false);
  });
  it.each(JIRA_AVATAR_UPLOAD_MUTATIONS)(
    "preserves exact metadata-only reviewed avatar bytes for %s",
    (operation) => {
      const value = { ...attach, operation, attachment: { ...preview, name: "avatar.png" } };
      expect(validateChatToolWriteApprovalView(value)).toEqual({ ok: true, value });
      expect(
        validateChatToolWriteApprovalView({
          ...value,
          attachment: { ...value.attachment, bytes: "model-content" },
        }).ok,
      ).toBe(false);
      expect(
        validateChatToolWriteApprovalView({ ...value, operation: "jira.create-project-avatar" }).ok,
      ).toBe(false);
      expect(
        validateChatToolWriteApprovalView({ ...value, operation: "jira.crop-temporary-avatar" }).ok,
      ).toBe(false);
    },
  );
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
    expect(
      validateChatToolWriteApprovalView({
        ...attach,
        operation: "jira.upload-email-template-pack",
        attachment,
      }).ok,
    ).toBe(false);
  });
});

it("requires file metadata independently for a Jira email-template upload approval", () => {
  const upload = { ...approval(), operation: "jira.upload-email-template-pack" as const };
  expect(validateChatToolWriteApprovalView(upload).ok).toBe(false);
  expect(
    validateChatToolWriteApprovalView({
      ...upload,
      attachment: { name: "templates.zip", sizeBytes: 20, sha256: "d".repeat(64) },
    }).ok,
  ).toBe(true);
});

it.each(JIRA_AVATAR_UPLOAD_MUTATIONS)(
  "requires actual file preview metadata on %s approvals",
  (operation) => {
    const upload = { ...approval(), operation };
    expect(validateChatToolWriteApprovalView(upload).ok).toBe(false);
    expect(
      validateChatToolWriteApprovalView({
        ...upload,
        attachment: { name: "avatar.png", sizeBytes: 64, sha256: "a".repeat(64) },
      }).ok,
    ).toBe(true);
  },
);

describe("the projects a write approval names (F09)", () => {
  const draft = { ...approval(), operation: "jira.draft" as const };
  const named = { ref: "10002", key: "KEI", name: "Keiko synthetic" };
  // R04: the status change a transition approval covers, named by Jira's own words for the person.
  it("carries the transition's name and target status on a transition approval, or its reference alone", () => {
    const base = { ...approval(), operation: "jira.transition" as const };
    for (const transition of [
      { ref: "11" },
      { ref: "11", name: "Fortschritt starten" },
      { ref: "11", name: "Start progress", targetStatusName: "In Progress" },
    ])
      expect(
        validateChatToolWriteApprovalView({ ...base, transition }).ok,
        JSON.stringify(transition),
      ).toBe(true);
    for (const transition of [
      {},
      { ref: "" },
      { ref: "x11" },
      { ref: "11", name: "" },
      { ref: "11", name: " padded " },
      { ref: "11", targetStatusName: "bad\u0007" },
      { ref: "11", name: "n".repeat(256) },
      { ref: "11", extra: "no" },
      "11",
      ["11"],
    ])
      expect(
        validateChatToolWriteApprovalView({ ...base, transition }).ok,
        JSON.stringify(transition),
      ).toBe(false);
  });

  it("carries the names of the fields and of the issue types the server read, bounded and display-safe", () => {
    const base = { ...approval(), operation: "jira.create" as const };
    expect(
      validateChatToolWriteApprovalView({
        ...base,
        projects: [
          {
            ref: "10000",
            key: "REQ",
            name: "Anforderungen",
            issueTypes: [{ id: "10002", name: "Aufgabe" }],
          },
        ],
        fields: [{ id: "customfield_10112", name: "Geschätzte Punkte" }],
      }).ok,
    ).toBe(true);
    for (const patch of [
      { fields: [] },
      { fields: [{ id: "customfield_1", name: "" }] },
      { fields: [{ id: "bad id", name: "x" }] },
      {
        fields: [
          { id: "a", name: "x" },
          { id: "a", name: "y" },
        ],
      },
      { fields: [{ id: "a", name: "x", extra: 1 }] },
      { fields: "none" },
      { projects: [{ ref: "10000", key: "REQ", issueTypes: [{ id: "1", name: "bad\u0007" }] }] },
    ])
      expect(
        validateChatToolWriteApprovalView({ ...base, ...patch }).ok,
        JSON.stringify(patch),
      ).toBe(false);
  });

  it("accepts a transition only on a jira.transition approval", () => {
    expect(validateChatToolWriteApprovalView({ ...approval(), transition: { ref: "11" } }).ok).toBe(
      false,
    );
  });

  it("carries each project's reference with the key and name the server read, or the reference alone", () => {
    for (const projects of [
      [named],
      [{ ref: "10002" }],
      [{ ref: "10002", key: "KEI" }],
      [named, { ref: "KEI2" }],
    ]) {
      const value = { ...draft, projects };
      expect(validateChatToolWriteApprovalView(value)).toEqual({ ok: true, value });
    }
    expect(validateChatToolWriteApprovalView(draft).ok).toBe(true);
  });
  it.each([
    ["an empty list", []],
    [
      "more projects than a card can name",
      Array.from({ length: 9 }, (_, i) => ({ ref: `P${String(i)}` })),
    ],
    ["a repeated reference", [named, { ref: "10002" }]],
    ["a name without a key", [{ ref: "10002", name: "Keiko synthetic" }]],
    ["a name with a control character", [{ ...named, name: "Keiko\nsynthetic" }]],
    ["a name past the bound", [{ ...named, name: "n".repeat(256) }]],
    ["a surrounding blank in the name", [{ ...named, name: " Keiko " }]],
    ["a reference that is a URL", [{ ref: "https://example.invalid/10002" }]],
    ["a key that is a path", [{ ...named, key: "../KEI" }]],
    ["an unknown member", [{ ...named, lead: "someone" }]],
    ["not a list", "KEI"],
  ])("refuses %s", (_label, projects) => {
    expect(validateChatToolWriteApprovalView({ ...draft, projects }).ok).toBe(false);
  });
});
