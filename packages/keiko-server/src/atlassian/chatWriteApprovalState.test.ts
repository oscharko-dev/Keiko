import type {
  JiraChatToolAuthoritySubject,
  JiraChatToolWriteApprovalView,
} from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  createFileServerLogSink,
  createServerLogger,
  setServerLogger,
} from "../observability/index.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  readPersistedActivityLog,
  persistedActivityLogLines,
} from "../../../../tests/support/activity-log-proof.js";
import { chatAuthorityFixture } from "../editor/chatAuthority.test-support.js";
import {
  AtlassianActionApprovalRegistry,
  ATLASSIAN_ACTION_APPROVAL_MAX_PENDING,
  ATLASSIAN_ACTION_APPROVAL_TTL_MS,
} from "./actionApprovals.js";
import { projectChatWriteApproval, type ChatWriteApprovalEntry } from "./chatWriteApprovalState.js";

const NOW = 1700000000000;
type JiraWriteFixture = ChatWriteApprovalEntry & {
  readonly subject: JiraChatToolAuthoritySubject;
  readonly approval: JiraChatToolWriteApprovalView;
};
function pending(id = "write-1"): JiraWriteFixture {
  const envelope = chatAuthorityFixture();
  const subject = envelope.subject;
  return {
    subject,
    authority: { runId: envelope.runId, envelopeDigest: "b".repeat(64) },
    approvalProofDigest: null,
    approval: {
      kind: "jira-chat-write",
      approvalId: id,
      chatId: subject.chatId,
      podId: subject.podId,
      bindingGeneration: subject.bindingGeneration,
      authenticationGeneration: subject.authenticationGeneration,
      invocationId: "invocation-1",
      operation: "jira.comment",
      actionDigest: "d".repeat(64),
      requestedAt: NOW,
      expiresAt: NOW + ATLASSIAN_ACTION_APPROVAL_TTL_MS,
      state: "pending",
    },
  };
}
function retainedEntry(
  registry: AtlassianActionApprovalRegistry,
  id: string,
): ChatWriteApprovalEntry {
  const value = registry.getChatWriteApproval(id);
  if (value === undefined) throw new Error("Missing retained approval");
  return value;
}
function accept(
  registry: AtlassianActionApprovalRegistry,
  entry: ChatWriteApprovalEntry,
  correlation?: string,
): void {
  expect(
    registry.acceptChatWriteApproval(
      entry.approval.approvalId,
      entry.subject,
      entry.authority,
      entry.approval,
      "f".repeat(64),
      correlation,
    ).ok,
  ).toBe(true);
}
function claim(
  registry: AtlassianActionApprovalRegistry,
  entry: ChatWriteApprovalEntry,
  correlation?: string,
): ReturnType<AtlassianActionApprovalRegistry["claimChatWriteApproval"]> {
  return registry.claimChatWriteApproval(
    entry.approval.approvalId,
    entry.subject,
    entry.authority,
    entry.approval,
    correlation,
  );
}

describe("retained concrete Chat write approvals", () => {
  it("cannot claim before approval, claims exactly once, and validates repeat effect checks", () => {
    const registry = new AtlassianActionApprovalRegistry(() => NOW);
    const entry = pending();
    expect(registry.createChatWriteApproval(entry).ok).toBe(true);
    expect(claim(registry, entry).ok).toBe(false);
    accept(registry, entry);
    const result = claim(registry, entry);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Missing write claim");
    expect(claim(registry, entry).ok).toBe(false);
    for (let index = 0; index < 3; index++)
      expect(
        registry.isChatWriteClaimCurrent(
          result.claim,
          entry.subject,
          entry.authority,
          entry.approval,
        ),
      ).toBe(true);
    expect(
      registry.isChatWriteClaimCurrent(
        { ...result.claim, claimId: "forged" },
        entry.subject,
        entry.authority,
        entry.approval,
      ),
    ).toBe(false);
    expect(
      projectChatWriteApproval(retainedEntry(registry, entry.approval.approvalId)),
    ).not.toHaveProperty("claimId");
  });

  it.each([
    "actor",
    "chat",
    "pod",
    "binding",
    "credential",
    "authority",
    "action",
    "invocation",
    "operation",
  ] as const)("refuses changed %s facts at decision and claim", (changed) => {
    const registry = new AtlassianActionApprovalRegistry(() => NOW);
    const entry = pending();
    registry.createChatWriteApproval(entry);
    const subject = { ...entry.subject };
    const authority = { ...entry.authority };
    const action = { ...entry.approval };
    if (changed === "actor") subject.actorDigest = "e".repeat(64);
    if (changed === "chat") subject.chatId = "other-chat";
    if (changed === "pod") subject.podId = "d5f5681e-ce98-4c3c-b27e-51d707c9d019";
    if (changed === "binding") subject.bindingGeneration++;
    if (changed === "credential") subject.authenticationGeneration++;
    if (changed === "authority") authority.envelopeDigest = "e".repeat(64);
    if (changed === "action") action.actionDigest = "e".repeat(64);
    if (changed === "invocation") action.invocationId = "other-invocation";
    if (changed === "operation") action.operation = "jira.edit";
    expect(
      registry.acceptChatWriteApproval(
        entry.approval.approvalId,
        subject,
        authority,
        action,
        "f".repeat(64),
      ).ok,
    ).toBe(false);
    accept(registry, entry);
    expect(
      registry.claimChatWriteApproval(entry.approval.approvalId, subject, authority, action).ok,
    ).toBe(false);
  });

  it("snapshots caller-owned objects and omits private authority/proof from the browser view", () => {
    const registry = new AtlassianActionApprovalRegistry(() => NOW);
    const entry = pending();
    registry.createChatWriteApproval(entry);
    Object.assign(entry.approval, { actionDigest: "e".repeat(64) });
    Object.assign(entry.subject, { chatId: "changed" });
    const retained = retainedEntry(registry, entry.approval.approvalId);
    expect(retained.approval.actionDigest).toBe("d".repeat(64));
    expect(retained.subject.chatId).toBe("chat-1");
    expect(Object.isFrozen(retained.subject)).toBe(true);
    expect(Object.keys(projectChatWriteApproval(retained))).not.toEqual(
      expect.arrayContaining(["subject", "authority", "approvalProofDigest"]),
    );
  });

  describe("draft deselection (#4178)", () => {
    function draftEntry(refs?: readonly string[]): JiraWriteFixture {
      const entry = pending("draft-1");
      return {
        ...entry,
        approval: { ...entry.approval, operation: "jira.draft" },
        ...(refs === undefined ? {} : { draftItemRefs: refs }),
      };
    }
    function acceptWith(
      registry: AtlassianActionApprovalRegistry,
      entry: ChatWriteApprovalEntry,
      excluded: readonly string[],
    ): ReturnType<AtlassianActionApprovalRegistry["acceptChatWriteApproval"]> {
      return registry.acceptChatWriteApproval(
        entry.approval.approvalId,
        entry.subject,
        entry.authority,
        entry.approval,
        "f".repeat(64),
        "deselection",
        excluded,
      );
    }

    it.each([
      ["an unknown ref", ["epic", "elsewhere"]],
      ["a repeated ref", ["epic", "epic"]],
    ])("refuses %s and keeps the entry pending", (_, excluded) => {
      const registry = new AtlassianActionApprovalRegistry(() => NOW);
      const entry = draftEntry(["epic", "story"]);
      registry.createChatWriteApproval(entry);
      expect(acceptWith(registry, entry, excluded).ok).toBe(false);
      expect(retainedEntry(registry, "draft-1").approval.state).toBe("pending");
      expect(retainedEntry(registry, "draft-1").approval).not.toHaveProperty("excludedItemRefs");
    });

    it("refuses a deselection on a non-draft approval and on a draft without recorded refs", () => {
      const registry = new AtlassianActionApprovalRegistry(() => NOW);
      const comment = pending("comment-1");
      registry.createChatWriteApproval(comment);
      expect(acceptWith(registry, comment, ["epic"]).ok).toBe(false);
      expect(retainedEntry(registry, "comment-1").approval.state).toBe("pending");
      const bare = draftEntry();
      registry.createChatWriteApproval(bare);
      expect(acceptWith(registry, bare, ["epic"]).ok).toBe(false);
      expect(retainedEntry(registry, "draft-1").approval.state).toBe("pending");
    });

    it("accepts a subset of the draft's refs, keeps them private and still admits no deselection", () => {
      const registry = new AtlassianActionApprovalRegistry(() => NOW);
      const entry = draftEntry(["epic", "story", "task"]);
      registry.createChatWriteApproval(entry);
      const accepted = acceptWith(registry, entry, ["story", "task"]);
      expect(accepted).toMatchObject({
        ok: true,
        approval: { state: "approved", excludedItemRefs: ["story", "task"] },
      });
      expect(retainedEntry(registry, "draft-1").draftItemRefs).toEqual(["epic", "story", "task"]);
      expect(projectChatWriteApproval(retainedEntry(registry, "draft-1"))).not.toHaveProperty(
        "draftItemRefs",
      );
      const whole = draftEntry(["epic"]);
      const other = new AtlassianActionApprovalRegistry(() => NOW);
      other.createChatWriteApproval(whole);
      expect(acceptWith(other, whole, []).ok).toBe(true);
    });
  });

  it("does not turn rejection or expiry into another pending approval", () => {
    let now = NOW;
    const registry = new AtlassianActionApprovalRegistry(() => now);
    const entry = pending();
    registry.createChatWriteApproval(entry);
    expect(
      registry.rejectChatWriteApproval(
        entry.approval.approvalId,
        entry.subject,
        entry.authority,
        entry.approval,
      ).ok,
    ).toBe(true);
    expect(registry.createChatWriteApproval(entry).ok).toBe(false);
    expect(claim(registry, entry).ok).toBe(false);
    now = entry.approval.expiresAt;
    expect(registry.getChatWriteApproval(entry.approval.approvalId)).toBeUndefined();
    expect(registry.createChatWriteApproval(entry).ok).toBe(false);
  });

  it.each(["revoke", "reset", "expire"] as const)("invalidates a claimed token on %s", (reason) => {
    let now = NOW;
    const registry = new AtlassianActionApprovalRegistry(() => now);
    const entry = pending();
    registry.createChatWriteApproval(entry);
    accept(registry, entry);
    const result = claim(registry, entry);
    if (!result.ok) throw new Error("Missing claim");
    if (reason === "revoke") expect(registry.revokeChatApprovals(entry.subject.chatId)).toBe(1);
    if (reason === "reset") registry.reset();
    if (reason === "expire") now = entry.approval.expiresAt;
    expect(
      registry.isChatWriteClaimCurrent(
        result.claim,
        entry.subject,
        entry.authority,
        entry.approval,
      ),
    ).toBe(false);
  });

  it("keeps independent Chats/registries isolated and uses the existing bounded capacity", () => {
    const registry = new AtlassianActionApprovalRegistry(() => NOW);
    const other = new AtlassianActionApprovalRegistry(() => NOW);
    const entry = pending();
    other.createChatWriteApproval(entry);
    for (let index = 0; index < ATLASSIAN_ACTION_APPROVAL_MAX_PENDING; index++)
      expect(registry.createChatWriteApproval(pending(`write-${String(index)}`)).ok).toBe(true);
    expect(registry.createChatWriteApproval(pending("overflow"))).toEqual({
      ok: false,
      reason: "capacity-exhausted",
    });
    registry.revokeChatApprovals("other-chat");
    expect(registry.getChatWriteApproval("write-1")?.approval.state).toBe("pending");
    registry.reset();
    expect(other.getChatWriteApproval(entry.approval.approvalId)?.approval.state).toBe("pending");
  });

  it("wakes pending waiters on human decisions and lifecycle loss", async () => {
    const registry = new AtlassianActionApprovalRegistry(() => NOW);
    const entry = pending();
    registry.createChatWriteApproval(entry);
    const woke = vi.fn();
    const wait = registry
      .waitForChatWriteApproval(entry.approval.approvalId, new AbortController().signal)
      .then(woke);
    expect(woke).not.toHaveBeenCalled();
    registry.revokeChatApprovals(entry.subject.chatId);
    await wait;
    expect(woke).toHaveBeenCalledOnce();
  });
});

it("reconstructs request, human acceptance, claim and revocation without content", () => {
  const root = mkdtempSync(join(tmpdir(), "keiko-write-approval-"));
  const sink = createFileServerLogSink(root, { level: "debug" });
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  const registry = new AtlassianActionApprovalRegistry(() => NOW);
  const entry = pending();
  const correlation = "chat-write-approval-proof";
  try {
    registry.createChatWriteApproval(entry, correlation);
    accept(registry, entry, correlation);
    claim(registry, entry, correlation);
    registry.revokeChatApprovals(entry.subject.chatId, correlation);
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(root),
      "chat.tool-authority.operation",
    );
    const records = lines.map((line) =>
      expectActivityLogProof("chat.tool-authority.operation.write-approval", line),
    );
    expect(records.map((line) => line.approvalState)).toEqual([
      "pending",
      "approved",
      "claimed",
      "revoked",
    ]);
    expect(records.every((line) => line.correlationId === correlation)).toBe(true);
    expect(records.every((line) => line.actionDigest === entry.approval.actionDigest)).toBe(true);
    for (const raw of [
      entry.subject.chatId,
      entry.subject.podId,
      entry.approval.approvalId,
      entry.authority.runId,
    ])
      expect(lines.join("\n")).not.toContain(raw);
  } finally {
    sink.close?.();
    resetServerLogger();
    rmSync(root, { recursive: true, force: true });
  }
});

it("records a refused draft deselection as an invalid write approval without naming refs (#4178)", () => {
  const root = mkdtempSync(join(tmpdir(), "keiko-write-deselection-"));
  const sink = createFileServerLogSink(root, { level: "debug" });
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  const registry = new AtlassianActionApprovalRegistry(() => NOW);
  const base = pending("draft-log");
  const entry = {
    ...base,
    approval: { ...base.approval, operation: "jira.draft" as const },
    draftItemRefs: ["epic"],
  };
  const correlation = "chat-write-deselection-refused";
  try {
    registry.createChatWriteApproval(entry, correlation);
    const refused = registry.acceptChatWriteApproval(
      entry.approval.approvalId,
      entry.subject,
      entry.authority,
      entry.approval,
      "f".repeat(64),
      correlation,
      ["unknown-ref-marker"],
    );
    expect(refused.ok).toBe(false);
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(root),
      "chat.tool-authority.operation",
    );
    const records = lines.map((line) =>
      expectActivityLogProof("chat.tool-authority.operation.write-approval", line),
    );
    expect(records.map((line) => line.outcome)).toEqual(["review-required", "invalid"]);
    expect(records.every((line) => line.correlationId === correlation)).toBe(true);
    expect(lines.join("\n")).not.toContain("unknown-ref-marker");
    expect(lines.join("\n")).not.toContain("epic");
  } finally {
    sink.close?.();
    resetServerLogger();
    rmSync(root, { recursive: true, force: true });
  }
});
