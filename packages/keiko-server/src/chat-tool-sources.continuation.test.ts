import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtlassianCredentialMetadata } from "@oscharko-dev/keiko-connectors";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import type { ChatMessage } from "./store/index.js";
import { entriesFor } from "./chat-approval-continuation-state.js";
import { currentChatSources, type ChatSourcesContext } from "./chat-tool-sources.js";
import { jiraChatActorDigest } from "./atlassian/jiraPodAccess.js";
import {
  mintAcceptedJiraChatAuthority,
  requestJiraChatReadGrant,
} from "./atlassian/jiraChatAuthority.js";
import { requestJiraChatWriteApproval } from "./atlassian/jiraChatWriteApproval.js";
import {
  jiraChatWriteAction,
  jiraChatWritePermission,
  claimJiraChatWrite,
} from "./atlassian/jiraChatCatalogWrite.js";
import { jiraOperationBindingForTool } from "./atlassian/jiraManagedProvider.js";
import {
  createJiraChatCatalogAdmission,
  type JiraChatAdmissionOptions,
  type JiraChatCatalogAction,
  type JiraChatCatalogContext,
} from "./atlassian/jiraChatCatalogConsumer.js";
import {
  handleDecideChatWriteApproval,
  handleGetChatWriteApproval,
} from "./atlassian/chatWriteApprovalRoutes.js";
import * as sessionAuthority from "./coding-app-session/appSessionReadAuthority.js";
import * as mcpAuthority from "./mcp/mcpChatAuthority.js";
import { mockResponse } from "./_support.js";
import type { RouteContext } from "./routes.js";

const POD = "d5f5681e-ce98-4c3c-b27e-51d707c9d018";
const SESSION = "sess_111111111111111111111111";
const cleanups: (() => Promise<void>)[] = [];
interface Fixture {
  readonly deps: UiHandlerDeps;
  readonly message: ChatMessage;
  readonly options: JiraChatAdmissionOptions;
  readonly action: JiraChatCatalogAction;
  readonly context: JiraChatCatalogContext;
  readonly approval: ChatToolWriteApprovalView;
  readonly live: { value: boolean };
  readonly controller: AbortController;
}

function boundChat(deps: UiHandlerDeps, root: string): string {
  deps.store.createProject(root);
  const ownerDigest = jiraChatActorDigest(deps);
  if (ownerDigest === undefined) throw new TypeError("Missing synthetic principal");
  const metadata: AtlassianCredentialMetadata = {
    schemaVersion: "1",
    authRef: "synthetic-reference",
    displayName: "Synthetic Jira",
    baseUrl: "https://jira.example.invalid",
    createdAt: 1,
    generation: 1,
    provider: "jira",
    deployment: "data-center",
    authScheme: "bearer-pat",
    livePod: {
      podId: POD,
      ownerDigest,
      creationRequestId: POD,
      verificationRevision: 1,
      verificationInProgress: false,
      verificationStatus: "ok",
    },
  };
  const credentials = deps.atlassianConnectorCredentials;
  if (credentials === undefined) throw new TypeError("Missing custody owner");
  vi.spyOn(credentials.custody, "list").mockReturnValue([metadata]);
  const chat = deps.store.createChat(root, "Synthetic Chat", "synthetic-model");
  return deps.store.updateChat(
    chat.id,
    { jiraPodId: POD, toolMode: "governed-assist" },
    { verifiedJiraPod: { podId: POD, authenticationGeneration: 1 } },
  ).id;
}

function approvedAction(
  deps: UiHandlerDeps,
  context: JiraChatCatalogContext,
  action: JiraChatCatalogAction,
  approve: boolean,
): ChatToolWriteApprovalView {
  const registry = deps.atlassianActionApprovalRegistry;
  if (registry === undefined) throw new TypeError("Missing approval owner");
  const now = new Date().toISOString();
  const read = requestJiraChatReadGrant(
    deps,
    context.chatId,
    context.authorityReference,
    now,
    "continuation-read",
  );
  if (read.kind === "denied") throw new TypeError("Missing synthetic read grant");
  const retained = registry.getChatReadGrant(read.grant.grantId);
  if (retained === undefined) throw new TypeError("Missing retained grant");
  expect(
    registry.acceptChatReadGrant(
      read.grant.grantId,
      retained.grant.subject,
      retained.authority,
      "b".repeat(64),
    ).ok,
  ).toBe(true);
  const identity = jiraChatWriteAction(action);
  if (identity === undefined) throw new TypeError("Missing production write identity");
  const write = requestJiraChatWriteApproval(
    deps,
    context.chatId,
    context.authorityReference,
    identity,
    now,
    "continuation-write",
  );
  if (write.kind !== "review-required") throw new TypeError("Missing pending approval");
  if (!approve) return write.approval;
  const entry = registry.getChatWriteApproval(write.approval.approvalId);
  if (entry === undefined) throw new TypeError("Missing retained approval");
  const accepted = registry.acceptChatWriteApproval(
    entry.approval.approvalId,
    entry.subject,
    entry.authority,
    entry.approval,
    "c".repeat(64),
  );
  if (!accepted.ok) throw new TypeError("Approval was not accepted");
  return accepted.approval;
}

function fixtureDeps(): { readonly deps: UiHandlerDeps; readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "keiko-continuation-fresh-"));
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui.db"),
    env: {},
    modelPortFactory: () => undefined,
  });
  cleanups.push(async (): Promise<void> => {
    await deps.dispose?.();
    rmSync(root, { recursive: true, force: true });
  });
  Object.assign(deps, {
    serverPrincipal: (): string => "synthetic-owner",
    autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
  });
  return { deps, root };
}

function admittedMessage(deps: UiHandlerDeps, root: string): ChatMessage {
  const chatId = boundChat(deps, root);
  const now = Date.now();
  const admitted = deps.store.admitChatTurn("continuation-test", {
    chatId,
    role: "user",
    content: "Synthetic change",
    timestamp: now,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (admitted.kind !== "admitted") throw new TypeError("Missing admitted turn");
  return admitted.userMessage;
}

function currentContext(
  deps: UiHandlerDeps,
  message: ChatMessage,
  controller: AbortController,
): JiraChatCatalogContext {
  const authority = mintAcceptedJiraChatAuthority(deps, {
    chatId: message.chatId,
    userMessageId: message.id,
    startedAtMs: message.timestamp,
    nowMs: Date.now(),
    correlationId: "continuation-proof",
  });
  if (!authority.ok) throw new TypeError("Missing accepted authority");
  return {
    runId: authority.envelope.runId,
    chatId: message.chatId,
    userMessageId: message.id,
    correlationId: "continuation-proof",
    authority: authority.reference.envelopeDigest,
    authorityReference: authority.reference,
    authorityExpiresAt: authority.envelope.expiresAt,
    deadlineAt: authority.envelope.expiresAt,
    signal: controller.signal,
  };
}

function fixture(approve = true): Fixture {
  const { deps, root } = fixtureDeps();
  const message = admittedMessage(deps, root);
  const controller = new AbortController();
  const context = currentContext(deps, message, controller);
  const binding = jiraOperationBindingForTool("jira.comment");
  if (binding === undefined) throw new TypeError("Missing native comment binding");
  const action: JiraChatCatalogAction = {
    tool: "jira.comment",
    actionId: "synthetic-call",
    idempotencyKey: "synthetic-key",
    argumentsDigest: "a".repeat(64),
    operationBinding: binding,
  };
  const approval = approvedAction(deps, context, action, approve);
  // This fixture isolates fresh session currency. The integrated reload proof owns producing
  // the transcript's canonical call identity; do not copy that producer's private digest formula.
  const findMessage = deps.store.findMessageById.bind(deps.store);
  vi.spyOn(deps.store, "findMessageById").mockImplementation((id) =>
    id !== message.id
      ? findMessage(id)
      : {
          ...message,
          toolTranscript: {
            schemaVersion: 1,
            exchanges: [
              {
                call: { id: "call-1", name: "jira_comment", arguments: {} },
                approval,
              },
            ],
          },
        },
  );
  if (message.canonicalTurnRef === undefined)
    throw new TypeError("Missing canonical turn reference");
  const live = { value: true };
  entriesFor(deps.store).set(message.canonicalTurnRef, {
    message,
    controller,
    sessionId: SESSION,
    live: () => live.value,
    correlationId: "continuation-proof",
    observedApprovalIds: new Set([approval.approvalId]),
  });
  return {
    deps,
    message,
    context,
    action,
    approval,
    controller,
    live,
    options: { deps, context: () => context, now: Date.now },
  };
}

function decisionContext(approval: ChatToolWriteApprovalView): RouteContext {
  const req = new PassThrough() as unknown as IncomingMessage;
  Object.assign(req, { headers: {} });
  const ctx = {
    req,
    res: mockResponse().res,
    params: { approvalId: approval.approvalId },
    url: new URL("http://127.0.0.1/api/atlassian-connectors/chat-write-approval/test"),
    correlationId: "continuation-decision",
  };
  queueMicrotask(() =>
    (req as unknown as PassThrough).end(
      JSON.stringify({ decision: "approve", actionDigest: approval.actionDigest }),
    ),
  );
  return ctx;
}

function registryOf(f: Fixture): NonNullable<UiHandlerDeps["atlassianActionApprovalRegistry"]> {
  const registry = f.deps.atlassianActionApprovalRegistry;
  if (registry === undefined) throw new TypeError("Missing approval registry");
  return registry;
}

function mixedContext(f: Fixture, observe: () => void = () => undefined): ChatSourcesContext {
  const current = mintAcceptedJiraChatAuthority(f.deps, {
    chatId: f.message.chatId,
    userMessageId: f.message.id,
    startedAtMs: f.message.timestamp,
    nowMs: Date.now(),
    correlationId: "continuation-proof",
  });
  if (!current.ok) throw new TypeError("Missing current authority");
  vi.spyOn(mcpAuthority, "resolveCurrentMcpChatAuthority").mockImplementation(() => {
    observe();
    return {
      ok: true,
      envelope: {
        ...current.envelope,
        subject: {
          kind: "configured-mcp",
          actorDigest: current.envelope.subject.actorDigest,
          chatId: f.message.chatId,
          configurationDigest: "d".repeat(64),
        },
      },
    };
  });
  return {
    ...f.context,
    jira: f.context,
    mcp: { ...f.context, userMessageId: f.message.id, configurationDigest: "d".repeat(64) },
  };
}

function readCheck(f: Fixture): () => boolean {
  const binding = jiraOperationBindingForTool("jira.issue");
  if (binding === undefined) throw new TypeError("Missing read binding");
  const action: JiraChatCatalogAction = {
    ...f.action,
    tool: "jira.issue",
    operationBinding: binding,
  };
  const { authorityPort } = createJiraChatCatalogAdmission(f.options);
  return (): boolean => authorityPort.preview(f.context.authority, action).ok;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

describe("retained approval session currency at the owning gates", () => {
  it("preserves the legacy unleased authority path", () => {
    const f = fixture();
    if (f.message.canonicalTurnRef === undefined) throw new TypeError("Missing canonical turn");
    entriesFor(f.deps.store).delete(f.message.canonicalTurnRef);
    f.live.value = false;
    expect(jiraChatWritePermission(f.options, f.action).ok).toBe(true);
    expect(f.controller.signal.aborted).toBe(false);
  });

  it.each(["permission", "claim"] as const)(
    "rechecks the original session synchronously before native %s",
    (gate) => {
      const f = fixture();
      expect(jiraChatWritePermission(f.options, f.action).ok).toBe(true);
      const claim = vi.spyOn(registryOf(f), "claimChatWriteApproval");
      f.live.value = false;
      expect(
        (gate === "permission" ? jiraChatWritePermission : claimJiraChatWrite)(f.options, f.action)
          .ok,
      ).toBe(false);
      expect(claim).not.toHaveBeenCalled();
      expect(f.controller.signal.aborted).toBe(true);
    },
  );

  it.each(["preview", "effect"] as const)(
    "rechecks the original session before a native read %s",
    (gate) => {
      const f = fixture();
      const binding = jiraOperationBindingForTool("jira.issue");
      if (binding === undefined) throw new TypeError("Missing read binding");
      const action: JiraChatCatalogAction = {
        ...f.action,
        tool: "jira.issue",
        operationBinding: binding,
      };
      const { authorityPort } = createJiraChatCatalogAdmission(f.options);
      const admitted = authorityPort.admit(f.context.authority, action);
      if (!admitted.ok) throw new TypeError("Missing positive read admission");
      expect(admitted.mutationGuard.check()).toBe(true);
      const check =
        gate === "preview"
          ? (): boolean => authorityPort.preview(f.context.authority, action).ok
          : admitted.mutationGuard.check;
      f.live.value = false;
      expect(check()).toBe(false);
      expect(f.controller.signal.aborted).toBe(true);
    },
  );

  it("rechecks the original session in the mixed-source effect guard", () => {
    const f = fixture();
    const context = mixedContext(f);
    expect(currentChatSources(f.deps, context)).toBe(true);
    f.live.value = false;
    expect(currentChatSources(f.deps, context)).toBe(false);
    expect(f.controller.signal.aborted).toBe(true);
  });

  it.each(["permission", "claim", "read", "mixed"] as const)(
    "refuses %s when current-state observation itself retires the session",
    (gate) => {
      const f = fixture();
      expect(jiraChatWritePermission(f.options, f.action).ok).toBe(true);
      let revoke = false;
      const context = mixedContext(f, () => {
        if (revoke) f.live.value = false;
      });
      const check =
        gate === "mixed"
          ? (): boolean => currentChatSources(f.deps, context)
          : gate === "read"
            ? readCheck(f)
            : (): boolean =>
                (gate === "claim" ? claimJiraChatWrite : jiraChatWritePermission)(
                  f.options,
                  f.action,
                ).ok;
      if (gate === "mixed") expect(check()).toBe(true);
      else {
        const custody = f.deps.atlassianConnectorCredentials?.custody;
        if (custody === undefined) throw new TypeError("Missing custody");
        const metadata = custody.list();
        vi.mocked(custody.list).mockImplementationOnce(() => {
          f.live.value = false;
          return metadata;
        });
      }
      revoke = true;
      expect(check()).toBe(false);
      expect(f.controller.signal.aborted).toBe(true);
    },
  );

  it.each(["revoked", "revoked-during-state", "foreign-session", "missing-session"] as const)(
    "refuses a %s decision after body parsing",
    async (reason) => {
      const f = fixture(false);
      const observed = vi
        .spyOn(sessionAuthority, "resolveAppSessionReadAuthority")
        .mockReturnValue({
          sessionId: SESSION,
          principalLabel: "synthetic-owner",
          issuedAtMs: 1,
          lastSeenAtMs: 1,
          rotationCount: 0,
        });
      expect(handleGetChatWriteApproval(decisionContext(f.approval), f.deps).status).toBe(200);
      if (reason === "revoked") f.live.value = false;
      else if (reason === "revoked-during-state") {
        const custody = f.deps.atlassianConnectorCredentials?.custody;
        if (custody === undefined) throw new TypeError("Missing custody");
        const metadata = custody.list();
        vi.mocked(custody.list).mockImplementationOnce(() => {
          f.live.value = false;
          return metadata;
        });
      } else
        observed.mockReturnValue(
          reason === "missing-session"
            ? undefined
            : {
                sessionId: "sess_222222222222222222222222",
                principalLabel: "synthetic-owner",
                issuedAtMs: 1,
                lastSeenAtMs: 1,
                rotationCount: 0,
              },
        );
      const accepted = vi.spyOn(registryOf(f), "acceptChatWriteApproval");
      expect(
        (await handleDecideChatWriteApproval(decisionContext(f.approval), f.deps)).status,
      ).toBe(404);
      expect(accepted).not.toHaveBeenCalled();
      expect(
        f.deps.atlassianActionApprovalRegistry?.getChatWriteApproval(f.approval.approvalId)
          ?.approval.state,
      ).toBe("pending");
    },
  );

  it("accepts one decision from the original live session and rejects its replay", async () => {
    const f = fixture(false);
    vi.spyOn(sessionAuthority, "resolveAppSessionReadAuthority").mockReturnValue({
      sessionId: SESSION,
      principalLabel: "synthetic-owner",
      issuedAtMs: 1,
      lastSeenAtMs: 1,
      rotationCount: 0,
    });
    expect((await handleDecideChatWriteApproval(decisionContext(f.approval), f.deps)).status).toBe(
      200,
    );
    expect(claimJiraChatWrite(f.options, f.action).ok).toBe(true);
    expect((await handleDecideChatWriteApproval(decisionContext(f.approval), f.deps)).status).toBe(
      409,
    );
    expect(registryOf(f).getChatWriteApproval(f.approval.approvalId)?.approval.state).toBe(
      "claimed",
    );
    expect(f.controller.signal.aborted).toBe(false);
  });

  it("records review observation only on GET, never on a forged same-session decision", async () => {
    const f = fixture(false);
    const reference = f.message.canonicalTurnRef;
    if (reference === undefined) throw new TypeError("Missing canonical turn");
    const entry = entriesFor(f.deps.store).get(reference);
    if (entry === undefined) throw new TypeError("Missing retained worker");
    entry.observedApprovalIds?.clear();
    vi.spyOn(sessionAuthority, "resolveAppSessionReadAuthority").mockReturnValue({
      sessionId: SESSION,
      principalLabel: "synthetic-owner",
      issuedAtMs: 1,
      lastSeenAtMs: 1,
      rotationCount: 0,
    });
    const forged = decisionContext({ ...f.approval, actionDigest: "0".repeat(64) });
    expect((await handleDecideChatWriteApproval(forged, f.deps)).status).toBe(409);
    expect(entry.observedApprovalIds?.has(f.approval.approvalId)).not.toBe(true);
    expect(registryOf(f).getChatWriteApproval(f.approval.approvalId)?.approval.state).toBe(
      "pending",
    );
    expect(handleGetChatWriteApproval(decisionContext(f.approval), f.deps).status).toBe(200);
    expect(entry.observedApprovalIds?.has(f.approval.approvalId)).toBe(true);
    expect(f.controller.signal.aborted).toBe(false);
  });
});
