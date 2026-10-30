import { afterEach, describe, expect, it } from "vitest";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import type {
  McpServerDefinition,
  McpSettingsSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { createInMemoryUiStore } from "../store/index.js";
import { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import { AtlassianActionApprovalRegistry } from "../atlassian/actionApprovals.js";
import {
  isCurrentMcpChatReadGrant,
  mintAcceptedMcpChatAuthority,
  requestMcpChatReadGrant,
  reserveCurrentMcpChatAuthority,
  resolveCurrentMcpChatAuthority,
  type McpChatAuthorityDeps,
} from "./mcpChatAuthority.js";
import {
  isCurrentMcpChatWriteApproval,
  requestMcpChatWriteApproval,
} from "./mcpChatWriteApproval.js";
import { handleDecideChatReadConsent } from "../atlassian/chatReadConsentRoutes.js";
import { handleDecideChatWriteApproval } from "../atlassian/chatWriteApprovalRoutes.js";
import { mockRequest, mockResponse } from "../_support.js";
import type { UiHandlerDeps } from "../deps.js";
import type { RouteContext } from "../routes.js";
import type { ChatReadGrantEntry } from "../atlassian/chatReadGrantState.js";

const stores: ReturnType<typeof createInMemoryUiStore>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const CORRELATION = "mcp-chat-authority-proof";
interface Fixture {
  readonly deps: McpChatAuthorityDeps;
  readonly registry: AtlassianActionApprovalRegistry;
  readonly chat: ReturnType<McpChatAuthorityDeps["store"]["createChat"]>;
  readonly now: number;
  readonly turn: Parameters<typeof mintAcceptedMcpChatAuthority>[1];
  readonly accepted: Extract<ReturnType<typeof mintAcceptedMcpChatAuthority>, { ok: true }>;
  readonly changeActor: () => void;
  readonly changeSettings: () => void;
  readonly disconnect: () => void;
}
function fixture(
  mode: CodingWorkbenchMode = "governed-assist",
  ceiling: CodingWorkbenchMode = "autonomous-delivery",
  discovery?: "automatic",
): Fixture {
  const store = createInMemoryUiStore();
  stores.push(store);
  const project = store.createProject(process.cwd());
  const created = store.createChat(project.path, "Synthetic MCP", "synthetic-model");
  const chat = store.updateChat(created.id, { toolMode: mode });
  const now = Date.now();
  const admitted = store.admitChatTurn("mcp-authority-turn", {
    chatId: chat.id,
    role: "user",
    content: "Synthetic tool request",
    timestamp: now,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (admitted.kind !== "admitted") throw new Error("Expected accepted turn");
  const server: McpServerDefinition = {
    name: "synthetic",
    description: "Synthetic test tools",
    enabled: true,
    transport: { kind: "local", command: ["/synthetic/mcp"], environment: {} },
    tools: discovery === "automatic" ? {} : { write: "write", read: "read" },
    ...(discovery === undefined ? {} : { discovery }),
  };
  let settings: McpSettingsSnapshot = { revision: "a".repeat(64), servers: [server] };
  let actor = "synthetic-operator";
  const registry = new AtlassianActionApprovalRegistry(() => now);
  const deps: McpChatAuthorityDeps = {
    store,
    serverPrincipal: () => actor,
    agentAuthorityRegistry: new EditorAgentAuthorityRegistry(),
    atlassianActionApprovalRegistry: registry,
    autonomousDeliveryDeploymentCeiling: ceiling,
    mcpSettings: {
      read: () => settings,
      generation: () => new AbortController().signal,
      revoke: (): void => undefined,
      revisionSignal: () => new AbortController().signal,
      secret: () => undefined,
      update: () => ({ ok: false, snapshot: settings }),
    },
  };
  const turn = {
    chatId: chat.id,
    userMessageId: admitted.userMessage.id,
    startedAtMs: now,
    nowMs: now,
    correlationId: CORRELATION,
  };
  const accepted = mintAcceptedMcpChatAuthority(deps, turn);
  if (!accepted.ok) throw new Error("Expected MCP authority");
  return {
    deps,
    registry,
    chat,
    now,
    turn,
    accepted,
    changeActor: (): void => {
      actor = "other-operator";
    },
    changeSettings: (): void => {
      settings = { ...settings, revision: "b".repeat(64) };
    },
    disconnect: (): void => {
      settings = { ...settings, servers: [] };
    },
  };
}
function nowIso(f: ReturnType<typeof fixture>): string {
  return new Date(f.now).toISOString();
}
function read(f: ReturnType<typeof fixture>): ReturnType<typeof requestMcpChatReadGrant> {
  return requestMcpChatReadGrant(f.deps, f.chat.id, f.accepted.reference, nowIso(f), CORRELATION);
}
function consent(f: ReturnType<typeof fixture>): ChatReadGrantEntry {
  const requested = read(f);
  if (requested.kind !== "review-required") throw new Error("Expected disclosure");
  const entry = f.registry.getChatReadGrant(requested.grant.grantId);
  if (entry === undefined) throw new Error("Missing consent");
  expect(
    f.registry.acceptChatReadGrant(
      entry.grant.grantId,
      entry.grant.subject,
      entry.authority,
      "f".repeat(64),
      CORRELATION,
    ).ok,
  ).toBe(true);
  const granted = f.registry.getChatReadGrant(entry.grant.grantId);
  if (granted === undefined) throw new Error("Missing retained consent");
  return granted;
}
const ACTION = {
  invocationId: "synthetic-invocation",
  operation: "mcp_synthetic_write_123",
  actionDigest: "d".repeat(64),
};
function write(f: ReturnType<typeof fixture>): ReturnType<typeof requestMcpChatWriteApproval> {
  return requestMcpChatWriteApproval(
    f.deps,
    f.chat.id,
    f.accepted.reference,
    ACTION,
    nowIso(f),
    CORRELATION,
  );
}

describe("configured MCP ordinary Chat authority", () => {
  it("uses the existing accepted-turn registry without a Pod or workspace", () => {
    const f = fixture();
    expect(f.accepted.envelope.subject).toMatchObject({
      kind: "configured-mcp",
      configurationDigest: "a".repeat(64),
    });
    expect(f.accepted.envelope.subject).not.toHaveProperty("podId");
    expect(
      resolveCurrentMcpChatAuthority(
        f.deps,
        f.chat.id,
        f.accepted.reference,
        nowIso(f),
        CORRELATION,
      ).ok,
    ).toBe(true);
    expect(read(f).kind).toBe("review-required");
  });
  it("admits configured automatic discovery before it has cached tool names", () => {
    const f = fixture("governed-assist", "autonomous-delivery", "automatic");
    expect(f.accepted.envelope.subject.configurationDigest).toBe("a".repeat(64));
    expect(read(f).kind).toBe("review-required");
  });
  it.each(["actor", "configuration", "disconnect", "mode", "closed"])(
    "invalidates authority after %s changes",
    (change) => {
      const f = fixture();
      if (change === "actor") f.changeActor();
      if (change === "configuration") f.changeSettings();
      if (change === "disconnect") f.disconnect();
      if (change === "mode")
        f.deps.store.updateChat(f.chat.id, { toolMode: "autonomous-delivery" });
      if (change === "closed") f.deps.store.updateChat(f.chat.id, { status: "closed" });
      expect(
        resolveCurrentMcpChatAuthority(
          f.deps,
          f.chat.id,
          f.accepted.reference,
          nowIso(f),
          CORRELATION,
        ).ok,
      ).toBe(false);
      expect(read(f).kind).toBe("denied");
    },
  );
  it("does not reset its budget when the same accepted message is admitted again", () => {
    const f = fixture();
    const budget = f.accepted.envelope.budget;
    expect(
      reserveCurrentMcpChatAuthority(
        f.deps,
        f.chat.id,
        f.accepted.reference,
        { toolCalls: budget.maxToolCalls, promptTokens: 0, patchBytes: 0 },
        nowIso(f),
        CORRELATION,
      ).ok,
    ).toBe(true);
    const again = mintAcceptedMcpChatAuthority(f.deps, f.turn);
    expect(again.ok).toBe(true);
    expect(
      reserveCurrentMcpChatAuthority(
        f.deps,
        f.chat.id,
        f.accepted.reference,
        { toolCalls: 1, promptTokens: 0, patchBytes: 0 },
        nowIso(f),
        CORRELATION,
      ).ok,
    ).toBe(false);
  });
  it("rejects non-current messages and settings changes instead of minting a second envelope", () => {
    const f = fixture();
    expect(mintAcceptedMcpChatAuthority(f.deps, { ...f.turn, userMessageId: "missing" }).ok).toBe(
      false,
    );
    f.changeSettings();
    expect(mintAcceptedMcpChatAuthority(f.deps, f.turn).ok).toBe(false);
  });
  it.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
    "requires disclosure before any write in %s",
    (mode) => {
      const f = fixture(mode);
      expect(write(f).kind).toBe("denied");
      consent(f);
      expect(write(f).kind).toBe(mode === "autonomous-delivery" ? "allowed" : "review-required");
    },
  );
  it("binds and consumes approval once, refusing changed arguments and configuration", () => {
    const f = fixture();
    consent(f);
    const requested = write(f);
    if (requested.kind !== "review-required") throw new Error("Expected write approval");
    const entry = f.registry.getChatWriteApproval(requested.approval.approvalId);
    if (entry === undefined) throw new Error("Missing approval");
    expect(
      f.registry.acceptChatWriteApproval(
        entry.approval.approvalId,
        entry.subject,
        entry.authority,
        ACTION,
        "f".repeat(64),
        CORRELATION,
      ).ok,
    ).toBe(true);
    expect(
      f.registry.claimChatWriteApproval(entry.approval.approvalId, entry.subject, entry.authority, {
        ...ACTION,
        actionDigest: "c".repeat(64),
      }).ok,
    ).toBe(false);
    expect(
      f.registry.claimChatWriteApproval(
        entry.approval.approvalId,
        entry.subject,
        entry.authority,
        ACTION,
      ).ok,
    ).toBe(true);
    expect(
      f.registry.claimChatWriteApproval(
        entry.approval.approvalId,
        entry.subject,
        entry.authority,
        ACTION,
      ).ok,
    ).toBe(false);
    f.changeSettings();
    expect(isCurrentMcpChatWriteApproval(f.deps, entry, nowIso(f), CORRELATION)).toBe(false);
  });
  it("reissues disclosure when a pending request's origin authority was revoked", () => {
    const f = fixture();
    const pending = read(f);
    if (pending.kind !== "review-required") throw new Error("Expected disclosure");
    f.deps.agentAuthorityRegistry?.revoke(f.accepted.reference);
    const next = f.deps.agentAuthorityRegistry?.registerChat(
      { ...f.accepted.envelope, runId: "next-accepted-mcp-turn" },
      "autonomous-delivery",
      nowIso(f),
      CORRELATION,
    );
    if (next?.ok !== true) throw new Error("Expected next authority");
    const replacement = requestMcpChatReadGrant(
      f.deps,
      f.chat.id,
      next.authorityRef,
      nowIso(f),
      CORRELATION,
    );
    expect(replacement.kind).toBe("review-required");
    if (replacement.kind !== "review-required") throw new Error("Expected new disclosure");
    expect(replacement.grant.grantId).not.toBe(pending.grant.grantId);
    expect(f.registry.getChatReadGrant(pending.grant.grantId)?.grant.state).toBe("revoked");
  });
  it("keeps granted consent across turns but never after its expiry", () => {
    const f = fixture();
    const entry = consent(f);
    f.deps.agentAuthorityRegistry?.revoke(f.accepted.reference);
    expect(isCurrentMcpChatReadGrant(f.deps, entry, nowIso(f), CORRELATION)).toBe(true);
    expect(
      isCurrentMcpChatReadGrant(
        f.deps,
        entry,
        new Date(entry.grant.expiresAt).toISOString(),
        CORRELATION,
      ),
    ).toBe(false);
    expect(isCurrentMcpChatReadGrant(f.deps, entry, "invalid-date", CORRELATION)).toBe(false);
  });
  it("keeps an explicit narrower deployment ceiling over a Full access selection", () => {
    const f = fixture("autonomous-delivery", "governed-assist");
    expect(f.accepted.envelope.effectiveMode).toBe("governed-assist");
    expect(read(f).kind).toBe("review-required");
    consent(f);
    expect(write(f).kind).toBe("review-required");
  });
  it("does not transfer retained consent to a changed configuration", () => {
    const f = fixture();
    const entry = consent(f);
    expect(read(f).kind).toBe("granted");
    f.changeSettings();
    expect(isCurrentMcpChatReadGrant(f.deps, entry, nowIso(f), CORRELATION)).toBe(false);
  });
  it("retains and rechecks the new subject through the same approval routes", async () => {
    const f = fixture();
    const requested = read(f);
    if (requested.kind !== "review-required") throw new Error("Expected disclosure");
    const context = (approvalId: string, body: unknown): RouteContext => ({
      req: mockRequest({ body: JSON.stringify(body) }),
      res: mockResponse().res,
      params: { approvalId },
      url: new URL("http://localhost/approval"),
      correlationId: CORRELATION,
    });
    const deps = f.deps as UiHandlerDeps;
    expect(
      (
        await handleDecideChatReadConsent(
          context(requested.grant.grantId, {
            decision: "approve",
            disclosureVersion: "jira-chat-read-v1",
          }),
          deps,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await handleDecideChatReadConsent(
          context(requested.grant.grantId, {
            decision: "approve",
            disclosureVersion: "mcp-chat-read-v1",
          }),
          deps,
        )
      ).status,
    ).toBe(200);
    const action = write(f);
    if (action.kind !== "review-required") throw new Error("Expected write");
    expect(
      (
        await handleDecideChatWriteApproval(
          context(action.approval.approvalId, {
            decision: "approve",
            actionDigest: ACTION.actionDigest,
          }),
          deps,
        )
      ).status,
    ).toBe(200);
    f.changeSettings();
    expect(
      (
        await handleDecideChatWriteApproval(
          context(action.approval.approvalId, {
            decision: "approve",
            actionDigest: ACTION.actionDigest,
          }),
          deps,
        )
      ).status,
    ).toBe(404);
  });
});
