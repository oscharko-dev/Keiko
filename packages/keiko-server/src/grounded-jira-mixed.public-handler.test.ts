import type { MemoryId, ProjectId, UserId } from "@oscharko-dev/keiko-contracts/memory";
import { randomBytes, randomUUID } from "node:crypto";
import { handleUpdateChat } from "./store-handlers.js";
import { deriveChatGroundingScopeIdentity } from "./store/chat-grounding-scope-identity.js";
import { interruptChatGenerations } from "./chat-turn-serializer.js";
import {
  handleCreateAtlassianConnectorCredential,
  handleDeleteAtlassianConnectorCredential,
  handleUpdateAtlassianConnectorCredential,
  handleVerifyAtlassianConnectorCredential,
} from "./atlassian/credentialRoutes.js";
import { AtlassianActionApprovalRegistry } from "./atlassian/actionApprovals.js";
import { EditorAgentAuthorityRegistry } from "./editor/agentAuthorityRegistry.js";
import { createJiraChatCatalogRuntime } from "./atlassian/jiraChatCatalogRuntime.js";
import { projectChatReadGrant } from "./atlassian/chatReadGrantState.js";
import { processServerLogSink } from "./process-log-sink.js";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { defaultServerDiagnosticSink } from "./diagnostics-log.js";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";
import { handleSendDesktopChat } from "./chat-handlers.js";
import { handleSendDesktopChatStream } from "./chat-stream-handlers.js";
import { handleDecideChatWriteApproval } from "./atlassian/chatWriteApprovalRoutes.js";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
} from "@oscharko-dev/keiko-model-gateway";
import type {
  AtlassianHttpBodyPort,
  AtlassianCredentialMetadata,
} from "@oscharko-dev/keiko-connectors";
import type { ChatToolExchange, GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { handleGroundedAsk, modelWindowAwareBudget } from "./grounded-qa.js";
import { mockRequest, mockResponse } from "./_support.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { jiraChatActorDigest } from "./atlassian/jiraPodAccess.js";
import { handleDecideChatReadConsent } from "./atlassian/chatReadConsentRoutes.js";
import {
  QUALIFICATION_SPEND_BUDGET_USD_ENV,
  QUALIFICATION_SPEND_LEDGER_PATH_ENV,
} from "./gateway-spend-budget.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const MODEL = "mixed-chat-proof";
// The former fixed coding-harness caps (30 calls, 300 s), now supplied as the turn's Authority
// Envelope budget (#4175). These pins keep their invariants against an explicit envelope.
const THIRTY_CALL_BUDGET = {
  maxRuntimeMs: 300_000,
  maxToolCalls: 30,
  maxPromptTokens: 100_000,
  maxPatchBytes: 0,
} as const;
const POD = "d5f5681e-ce98-4c3c-b27e-51d707c9d018";
const CITED =
  "Feature returns true [src/Feature.ts:1].\n\nJira tool result: project SYN is visible.";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  // Let the existing post-commit Memory owner run its scheduled work before closing the vault.
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (const dispose of cleanup.splice(0)) await dispose();
  resetServerLogger();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each(["new-turn", "fresh-registries"] as const)(
  "reuses still-valid read consent for a real mixed Gateway call after %s",
  async (kind) => {
    const f = runtime();
    const original = approvalOwner(f.deps);
    const firstDecision = vi.spyOn(original, "waitForChatReadGrant");
    provider();
    const request = {
      chatId: f.chatId,
      content: "Read the feature and Jira projects.",
      modelId: MODEL,
    };
    expect((await handleGroundedAsk(context(request), f.deps)).status).toBe(200);
    expect(firstDecision).toHaveBeenCalledTimes(1);
    const first = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.readGrant;
    if (first === undefined) throw new Error("Missing consent projection");
    let deps = f.deps;
    if (kind === "fresh-registries") {
      original.dispose();
      deps = restartConsentGraph(deps);
    }
    const owner = approvalOwner(deps);
    const furtherDecision = vi
      .spyOn(owner, "waitForChatReadGrant")
      .mockRejectedValue(new Error("A valid Chat consent must not request another approval"));
    furtherDecision.mockClear();
    const requests = provider();
    const result = await handleGroundedAsk(context(request), deps);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(requests).toHaveLength(2);
    expect(f.jiraRequests).toEqual(["GET", "GET"]);
    expect(furtherDecision).not.toHaveBeenCalled();
    const retained = owner.getChatReadGrant(first.grantId);
    if (retained === undefined) throw new Error("Missing retained consent");
    expect(projectChatReadGrant(retained.grant)).toEqual(first);
    assertContinuedObservation(deps, f.chatId);
    if (kind === "fresh-registries") assertOriginAuthorityNotRestored(deps, retained);
    owner.dispose();
  },
);

function assertContinuedObservation(deps: UiHandlerDeps, chatId: string): void {
  const last = deps.store
    .listMessages(chatId)
    .filter((message) => message.role === "user")
    .at(-1);
  expect(last?.toolTranscript?.exchanges[0]?.result?.status).toBe("completed");
}

function secondBoundChat(f: ReturnType<typeof runtime>, separatePod: boolean): string {
  const credentials = f.deps.atlassianConnectorCredentials;
  if (credentials === undefined) throw new Error("Missing credential owner");
  const original = metadata(f.deps);
  if (original.deployment !== "data-center") throw new Error("Missing Data Center fixture");
  const originalPod = original.livePod;
  if (originalPod === undefined) throw new Error("Missing original verified Pod");
  const next: AtlassianCredentialMetadata = separatePod
    ? {
        ...original,
        authRef: "second-synthetic-credential",
        baseUrl: "https://second-jira.example.invalid",
        livePod: {
          ...originalPod,
          podId: "d5f5681e-ce98-4c3c-b27e-51d707c9d028",
          creationRequestId: "d5f5681e-ce98-4c3c-b27e-51d707c9d029",
        },
      }
    : original;
  vi.mocked(credentials.custody.list).mockReturnValue(separatePod ? [original, next] : [original]);
  const chat = f.deps.store.createChat(f.root, "Second isolated Chat", MODEL);
  const podId = next.livePod?.podId;
  if (podId === undefined) throw new Error("Missing verified Pod");
  f.deps.store.updateChat(
    chat.id,
    {
      connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 0 },
      jiraPodId: podId,
    },
    { verifiedJiraPod: { podId, authenticationGeneration: 1 } },
  );
  return chat.id;
}

function interleavedReadBarrier(f: ReturnType<typeof runtime>): {
  readonly release: () => void;
  readonly waiting: () => boolean;
  readonly observed: string[];
} {
  const owner = f.deps.atlassianConnectorCredentials;
  if (owner === undefined) throw new Error("Missing credential owner");
  const original = vi.mocked(owner.httpBodyPortFactory).getMockImplementation();
  if (original === undefined) throw new Error("Missing independent Jira fixture");
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (release === undefined) throw new Error("Missing independent response barrier");
  const observed: string[] = [];
  let waiting = false;
  vi.mocked(owner.httpBodyPortFactory).mockImplementation((credential, correlation, lifecycle) => {
    const port = original(credential, correlation, lifecycle);
    return async (request): ReturnType<AtlassianHttpBodyPort> => {
      if (!waiting) {
        waiting = true;
        await gate;
      }
      observed.push(credential.authRef);
      return port(request);
    };
  });
  return { release, waiting: () => waiting, observed };
}

it.each([false, true])(
  "isolates parallel mixed Chat grants and MCP contexts with separate Pod=%s and reversed completion",
  async (separatePod) => {
    const f = runtime();
    const second = secondBoundChat(f, separatePod);
    const barrier = interleavedReadBarrier(f);
    const calls = provider(["tool", "tool", "answer", "answer"]);
    const request = { content: "Read the feature and Jira projects.", modelId: MODEL };
    const first = handleGroundedAsk(context({ ...request, chatId: f.chatId }), f.deps);
    try {
      await vi.waitFor(
        () => {
          expect(barrier.waiting()).toBe(true);
        },
        { timeout: 5000 },
      );
      const completed = await handleGroundedAsk(context({ ...request, chatId: second }), f.deps);
      expect(completed.status, JSON.stringify(completed.body)).toBe(200);
      expect(
        f.deps.store.listMessages(f.chatId).some((message) => message.role === "assistant"),
      ).toBe(false);
    } finally {
      barrier.release();
    }
    const completed = await first;
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(calls).toHaveLength(4);
    expect(barrier.observed).toEqual([
      separatePod ? "second-synthetic-credential" : "synthetic-credential",
      "synthetic-credential",
    ]);
    const transcripts = [f.chatId, second].map((id) => {
      const transcript = f.deps.store
        .listMessages(id)
        .find((message) => message.role === "user")?.toolTranscript;
      expect(transcript?.readGrant).toMatchObject({ chatId: id, state: "granted" });
      expect(transcript?.exchanges[0]?.result?.status).toBe("completed");
      return transcript;
    });
    expect(transcripts[0]?.readGrant?.grantId).not.toBe(transcripts[1]?.readGrant?.grantId);
    expect(transcripts[0]?.exchanges[0]?.call.id).not.toBe(transcripts[1]?.exchanges[0]?.call.id);
    expect(f.jiraRequests).toEqual(["GET", "GET"]);
  },
);

function assertOriginAuthorityNotRestored(
  deps: UiHandlerDeps,
  entry: import("./atlassian/chatReadGrantState.js").ChatReadGrantEntry,
): void {
  expect(
    deps.agentAuthorityRegistry?.resolveChat(
      entry.authority,
      entry.grant.subject,
      "autonomous-delivery",
      new Date().toISOString(),
    ).ok,
  ).toBe(false);
}

function approvalOwner(deps: UiHandlerDeps): AtlassianActionApprovalRegistry {
  if (deps.atlassianActionApprovalRegistry === undefined) throw new Error("Missing approval owner");
  return deps.atlassianActionApprovalRegistry;
}

function restartConsentGraph(deps: UiHandlerDeps): UiHandlerDeps {
  const next = {
    ...deps,
    agentAuthorityRegistry: new EditorAgentAuthorityRegistry(),
    atlassianActionApprovalRegistry: new AtlassianActionApprovalRegistry(
      Date.now,
      deps.store.chatToolReadGrants,
    ),
  };
  const catalog = createJiraChatCatalogRuntime(next, {
    primary: processServerLogSink(),
    diagnostics: defaultServerDiagnosticSink,
  });
  cleanup.push(() => catalog.close());
  return { ...next, jiraChatCatalog: catalog };
}

function context(body: Record<string, unknown>, approvalId?: string): RouteContext {
  return {
    req: mockRequest({ body: JSON.stringify(body) }),
    res: mockResponse().res,
    url: new URL("http://127.0.0.1/api/chats/messages/grounded"),
    params: approvalId === undefined ? {} : { approvalId },
    correlationId: "mixed-chat-proof",
  };
}
function metadata(deps: UiHandlerDeps): AtlassianCredentialMetadata {
  const ownerDigest = jiraChatActorDigest(deps);
  if (ownerDigest === undefined) throw new Error("Missing operator");
  return {
    schemaVersion: "1",
    authRef: "synthetic-credential",
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
      creationRequestId: "d5f5681e-ce98-4c3c-b27e-51d707c9d019",
      verificationRevision: 1,
      verificationInProgress: false,
      verificationStatus: "ok",
    },
  };
}
function runtime(
  mutation = false,
  deployment: Readonly<Record<string, string>> = {},
): {
  deps: UiHandlerDeps;
  chatId: string;
  root: string;
  jiraRequests: string[];
} {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-mixed-chat-"));
  const state = mkdtempSync(join(realpathSync(tmpdir()), "keiko-mixed-state-"));
  vi.stubEnv("KEIKO_STATE_DIR", state);
  resetServerLogger();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "Feature.ts"), "export function Feature() { return true; }\n");
  const deps = buildUiHandlerDeps({
    configPath: join(state, "gateway.json"),
    evidenceDir: join(state, "evidence"),
    uiDbPath: join(state, "ui.db"),
    env: {
      ...deployment,
      KEIKO_STATE_DIR: state,
      [QUALIFICATION_SPEND_BUDGET_USD_ENV]: "100",
      [QUALIFICATION_SPEND_LEDGER_PATH_ENV]: join(state, "spend.db"),
    },
  });
  cleanup.push(async () => {
    await deps.dispose?.();
    resetServerLogger();
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });
  configure(deps);
  deps.store.createProject(root);
  const chat = deps.store.createChat(root, "Mixed Chat", MODEL);
  deps.store.updateChat(
    chat.id,
    {
      connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 0 },
      jiraPodId: POD,
    },
    { verifiedJiraPod: { podId: POD, authenticationGeneration: 1 } },
  );
  const credentials = deps.atlassianConnectorCredentials;
  const approvals = deps.atlassianActionApprovalRegistry;
  if (credentials === undefined || approvals === undefined) throw new Error("Missing owners");
  vi.spyOn(credentials.custody, "list").mockReturnValue([metadata(deps)]);
  const jiraRequests: string[] = [];
  vi.spyOn(credentials, "httpBodyPortFactory").mockImplementation(
    (_metadata, _correlation, lifecycle) =>
      (request): ReturnType<AtlassianHttpBodyPort> => {
        expect(lifecycle?.beforeDispatch?.(request)).toBe(true);
        jiraRequests.push(request.method);
        const status = request.method === "GET" ? 200 : 201;
        lifecycle?.onResponse?.(request, status);
        const bodyText = JSON.stringify(
          mutation
            ? { id: "10001", body: "Synthetic approved comment" }
            : [{ id: "10000", key: "SYN", name: "Synthetic Project" }],
        );
        return Promise.resolve({
          kind: "response",
          status,
          bodyText,
          bodyBytes: Buffer.byteLength(bodyText),
          truncated: false,
        });
      },
  );
  vi.spyOn(approvals, "waitForChatReadGrant").mockImplementation(async (id) => {
    const result = await handleDecideChatReadConsent(
      context({ decision: "approve", disclosureVersion: "jira-chat-read-v1" }, id),
      deps,
    );
    expect(result.status).toBe(200);
  });
  vi.spyOn(approvals, "waitForChatWriteApproval").mockImplementation(async (id) => {
    const entry = approvals.getChatWriteApproval(id);
    if (entry === undefined) throw new Error("Missing write approval");
    const result = await handleDecideChatWriteApproval(
      context({ decision: "approve", actionDigest: entry.approval.actionDigest }, id),
      deps,
    );
    expect(result.status).toBe(200);
  });
  return { deps, chatId: chat.id, root, jiraRequests };
}

function credentialContext(authRef: string, body: Record<string, unknown> = {}): RouteContext {
  return { ...context(body), params: { authRef } };
}
type OwnedJiraCredential = Extract<
  AtlassianCredentialMetadata,
  { readonly deployment: "data-center" }
>;
type OwnedRuntime = ReturnType<typeof runtime> & {
  readonly pods: readonly [OwnedJiraCredential, OwnedJiraCredential];
  readonly chats: readonly [string, string, string];
};
function realCustodyOwner(
  f: ReturnType<typeof runtime>,
): NonNullable<UiHandlerDeps["atlassianConnectorCredentials"]> {
  const owner = f.deps.atlassianConnectorCredentials;
  if (owner === undefined) throw new Error("Missing real credential owner");
  return owner;
}
async function patchOwnedChat(
  f: ReturnType<typeof runtime>,
  chatId: string,
  podId: string | null,
): Promise<void> {
  const existing = f.deps.store.findChatById(chatId);
  if (existing === undefined) throw new Error("Missing existing Chat");
  const response = await handleUpdateChat(
    {
      ...context({
        jiraPodId: podId,
        expectedGroundingScopeIdentity: deriveChatGroundingScopeIdentity(existing),
      }),
      url: new URL(`http://127.0.0.1/api/chats?id=${encodeURIComponent(chatId)}`),
    },
    f.deps,
  );
  expect(response.status).toBe(200);
}
async function createOwnedPod(
  f: ReturnType<typeof runtime>,
  label: string,
): Promise<OwnedJiraCredential> {
  const created = await handleCreateAtlassianConnectorCredential(
    context({
      displayName: label,
      provider: "jira",
      deployment: "data-center",
      authScheme: "bearer-pat",
      baseUrl: `https://${label}.example.invalid`,
      apiToken: "synthetic-custody-pat",
      livePodCreationRequestId: randomUUID(),
    }),
    f.deps,
  );
  expect(created.status).toBe(200);
  const authRef = (created.body as { readonly authRef: string }).authRef;
  const verified = await handleVerifyAtlassianConnectorCredential(
    credentialContext(authRef),
    f.deps,
  );
  expect(verified.body).toMatchObject({ status: "ok" });
  const stored = realCustodyOwner(f).custody.getMetadata(authRef);
  if (stored?.deployment !== "data-center" || stored.livePod === undefined)
    throw new Error("Missing verified owned Pod");
  return stored;
}
function enableRealCustody(f: ReturnType<typeof runtime>): void {
  const owner = realCustodyOwner(f);
  vi.mocked(owner.custody.list).mockRestore();
  const original = vi.mocked(owner.httpBodyPortFactory).getMockImplementation();
  if (original === undefined) throw new Error("Missing remote HTTP fixture");
  vi.mocked(owner.httpBodyPortFactory).mockImplementation((...args) => {
    const port = original(...args);
    return (request): ReturnType<AtlassianHttpBodyPort> => {
      const path = new URL(request.url).pathname;
      if (!path.endsWith("/serverInfo") && !path.endsWith("/myself")) return port(request);
      const bodyText = JSON.stringify(
        path.endsWith("/serverInfo")
          ? { version: "10.3.26", versionNumbers: [10, 3, 26], deploymentType: "Server" }
          : { name: "synthetic-user", key: "synthetic-key", active: true },
      );
      return Promise.resolve({
        kind: "response",
        status: 200,
        bodyText,
        bodyBytes: Buffer.byteLength(bodyText),
        truncated: false,
      });
    };
  });
}
async function ownedRuntime(mutation: boolean, pendingApproval = false): Promise<OwnedRuntime> {
  const f = runtime(mutation, {
    KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: randomBytes(32).toString("base64"),
  });
  enableRealCustody(f);
  if (pendingApproval) vi.spyOn(approvalOwner(f.deps), "waitForChatWriteApproval").mockRestore();
  const pods = [
    await createOwnedPod(f, "first-owned"),
    await createOwnedPod(f, "other-owned"),
  ] as const;
  const chats = [
    f.chatId,
    f.deps.store.createChat(f.root, "Same Pod", MODEL).id,
    f.deps.store.createChat(f.root, "Other Pod", MODEL).id,
  ] as const;
  for (const [index, chatId] of chats.entries()) {
    const pod = pods[index === 2 ? 1 : 0].livePod;
    if (pod === undefined) throw new Error("Missing owned Pod binding");
    await patchOwnedChat(f, chatId, pod.podId);
  }
  return { ...f, pods, chats };
}
function ownedExchange(f: ReturnType<typeof runtime>, chatId: string): ChatToolExchange {
  const exchange = f.deps.store.listMessages(chatId).find((message) => message.role === "user")
    ?.toolTranscript?.exchanges[0];
  if (exchange === undefined) throw new Error("Missing normal Chat exchange");
  return exchange;
}
function startOwnedTurn(f: ReturnType<typeof runtime>, chatId: string): Promise<RouteResult> {
  const pending = handleSendDesktopChat(
    context({
      chatId,
      projectPath: f.root,
      content: "Use the requested Jira tool once.",
      modelId: MODEL,
      clientTurnId: randomUUID(),
    }),
    f.deps,
  );
  void pending.catch(() => undefined);
  return pending;
}
async function waitPendingWrite(
  f: ReturnType<typeof runtime>,
  chatId: string,
): Promise<NonNullable<ChatToolExchange["approval"]>> {
  await vi.waitFor(() => {
    expect(ownedExchange(f, chatId).approval?.state).toBe("pending");
  });
  const approval = ownedExchange(f, chatId).approval;
  if (approval === undefined) throw new Error("Missing concrete approval");
  return approval;
}

function expectRevokedOwnedWrites(f: OwnedRuntime): void {
  for (const id of f.chats.slice(0, 2)) {
    expect(ownedExchange(f, id).approval?.state).toBe("revoked");
    expect(ownedExchange(f, id).result?.status).toBe("cancelled");
    expect(f.deps.store.findChatById(id)?.jiraPodBinding?.authenticationGeneration).toBe(2);
  }
}
it("rotates real custody during pending normal Chat writes and preserves the other Pod", async () => {
  const f = await ownedRuntime(true, true);
  const other = f.chats[2];
  const credential = f.pods[0];
  const otherBefore = structuredClone(f.deps.store.findChatById(other)?.jiraPodBinding);
  provider(["write", "write", "write", "answer"]);
  const pending: Promise<RouteResult>[] = [];
  try {
    for (const id of f.chats) {
      pending.push(startOwnedTurn(f, id));
      await waitPendingWrite(f, id);
    }
    const retained = await waitPendingWrite(f, other);
    const rotated = await handleUpdateAtlassianConnectorCredential(
      credentialContext(credential.authRef, {
        expectedGeneration: 1,
        apiToken: "synthetic-replacement-pat",
      }),
      f.deps,
    );
    expect(rotated.status).toBe(200);
    await Promise.all(pending.slice(0, 2));
    expectRevokedOwnedWrites(f);
    expect(f.deps.store.findChatById(other)?.jiraPodBinding).toEqual(otherBefore);
    expect(f.jiraRequests).toEqual([]);
    expect(ownedExchange(f, other).approval?.state).toBe("pending");
    const approved = await handleDecideChatWriteApproval(
      context({ decision: "approve", actionDigest: retained.actionDigest }, retained.approvalId),
      f.deps,
    );
    expect(approved.status).toBe(200);
    await pending[2];
    expect(f.jiraRequests.filter((method) => method === "POST")).toHaveLength(1);
    expect(ownedExchange(f, other).mutationOutcome).toBe("succeeded");
  } finally {
    for (const id of f.chats) interruptChatGenerations(f.deps, id);
    await Promise.allSettled(pending);
  }
});

function holdOwnedResponse(
  f: ReturnType<typeof runtime>,
  authRef: string,
  method: "GET" | "POST",
  privateBody?: string,
): { readonly release: () => void; readonly reached: () => boolean } {
  const owner = realCustodyOwner(f);
  const original = vi.mocked(owner.httpBodyPortFactory).getMockImplementation();
  if (original === undefined) throw new Error("Missing original remote transport");
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (release === undefined) throw new Error("Missing response barrier");
  let reached = false;
  vi.mocked(owner.httpBodyPortFactory).mockImplementation((credential, correlation, lifecycle) => {
    const port = original(credential, correlation, lifecycle);
    return async (request): ReturnType<AtlassianHttpBodyPort> => {
      const result = await port(request);
      if (credential.authRef !== authRef || request.method !== method) return result;
      reached = true;
      await gate;
      if (privateBody === undefined || result.kind !== "response") return result;
      return { ...result, bodyText: privateBody, bodyBytes: Buffer.byteLength(privateBody) };
    };
  });
  return { release, reached: (): boolean => reached };
}

it("discards a delayed normal Chat read after the real disconnect route while another Pod completes", async () => {
  const f = await ownedRuntime(false);
  const credential = f.pods[0];
  const other = f.chats[2];
  const privateLabel = "Isolated delayed Jira project";
  const barrier = holdOwnedResponse(
    f,
    credential.authRef,
    "GET",
    JSON.stringify([{ id: "10001", key: "PRIVATE", name: privateLabel }]),
  );
  const calls = provider(["tool", "tool", "answer"]);
  const pending = startOwnedTurn(f, f.chatId);
  try {
    await vi.waitFor(() => {
      expect(barrier.reached()).toBe(true);
    });
    expect((await startOwnedTurn(f, other)).status).toBe(200);
    await patchOwnedChat(f, f.chatId, null);
    await pending;
  } finally {
    barrier.release();
    interruptChatGenerations(f.deps, f.chatId);
    await pending;
  }
  // Consume the released SDK/provider promise chain before checking its private result stayed discarded.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(ownedExchange(f, f.chatId).result?.status).toBe("cancelled");
  expect(ownedExchange(f, other).result?.status).toBe("completed");
  expect(f.jiraRequests).toEqual(["GET", "GET"]);
  expect(JSON.stringify(calls)).not.toContain(privateLabel);
  expect(JSON.stringify(f.deps.store.listMessages(f.chatId))).not.toContain(privateLabel);
});

it("retains acknowledged mutation uncertainty after deletion through the real custody route", async () => {
  const f = await ownedRuntime(true);
  const credential = f.pods[0];
  const barrier = holdOwnedResponse(f, credential.authRef, "POST");
  provider(["write", "answer"]);
  const pending = startOwnedTurn(f, f.chatId);
  try {
    await vi.waitFor(() => {
      expect(barrier.reached()).toBe(true);
    });
    const deleted = await handleDeleteAtlassianConnectorCredential(
      credentialContext(credential.authRef),
      f.deps,
    );
    expect(deleted.status).toBe(200);
    await pending;
  } finally {
    barrier.release();
    interruptChatGenerations(f.deps, f.chatId);
    await pending;
  }
  await vi.waitFor(() => {
    expect(ownedExchange(f, f.chatId).mutationOutcome).toBe("succeeded-unconfirmed");
  });
  expect(ownedExchange(f, f.chatId).result?.status).toBe("cancelled");
  expect(f.jiraRequests.filter((method) => method === "POST")).toHaveLength(1);
  expect(realCustodyOwner(f).custody.getMetadata(credential.authRef)).toBeUndefined();
});

function configure(deps: UiHandlerDeps, modelRetries = 0, contextWindow = 32768): void {
  const provider = {
    modelId: MODEL,
    baseUrl: "https://mixed.example.invalid/v1",
    apiKey: "fixture",
    timeoutMs: 5000,
    maxRetries: modelRetries,
    retryBaseDelayMs: 1,
  };
  const config = deps.gatewayConfig;
  if (config === undefined) throw new Error("Missing gateway");
  config.set(
    parseGatewayConfig({
      providers: [provider],
      groundedAnswers: { ownAssessment: "disabled" },
      capabilities: [
        {
          ...createDefaultChatCapability(MODEL),
          contextWindow,
          maxOutputTokens: 1024,
          pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
          toolCalling: true,
          toolCallingVerification: {
            status: "verified",
            checkedAt: new Date().toISOString(),
            probe: "gateway-tool-calling-v1",
            configurationFingerprint: toolCallingConfigurationFingerprint(provider),
          },
        },
      ],
    }),
    true,
  );
  config.recordVerifiedCapability(
    MODEL,
    { conversationReady: true },
    new Date().toISOString(),
    config.generation(),
  );
}
function outputCap(body: string): number {
  const request = JSON.parse(body) as {
    readonly max_tokens?: number;
    readonly max_completion_tokens?: number;
  };
  return request.max_tokens ?? request.max_completion_tokens ?? 0;
}
function isProductiveRequest(body: string): boolean {
  return (
    body.includes("File: src/Feature.ts") ||
    body.includes("Citations:") ||
    body.includes('"tools":') ||
    body.includes('"role":"tool"')
  );
}
function providerBody(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "";
}
function isToolStep(body: string, step: ProviderStep): boolean {
  return body.includes('"tools":') && (step === "tool" || step === "write" || step === "malformed");
}
function toolArguments(step: ProviderStep, commentBody: string): string {
  if (step === "write") return JSON.stringify({ issueKey: "KEIKO-1", body: commentBody });
  return step === "malformed" ? '{"maxResults":0}' : "{}";
}
function responseContent(
  body: string,
  step: ProviderStep,
  steps: readonly ProviderStep[],
  answerContent?: string,
): string {
  if (answerContent !== undefined) return answerContent;
  return body.includes("Citations:")
    ? "Feature returns true [1]. Jira tool result: project SYN is visible."
    : finalContent(step, steps);
}
function finalContent(step: ProviderStep, steps: readonly ProviderStep[]): string {
  if (step === "uncited") return "Feature returns true.";
  return steps.includes("uncited") ? "Feature returns true [src/Feature.ts:1]." : CITED;
}
type ProviderStep =
  "tool" | "write" | "malformed" | "answer" | "uncited" | "overflow" | "exhausted";
interface ProviderOptions {
  readonly toolCount?: number;
  readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number };
  readonly onRequest?: (body: string, index: number) => void;
}
function reportedProviderUsage(
  usage = { prompt_tokens: 1, completion_tokens: 1 },
): Readonly<Record<string, number>> {
  return { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens };
}
// A reasoning model that spent its whole output budget on reasoning: no text, no tool call.
function exhaustedOutputResponse(): Response {
  return Response.json({
    id: "mixed-response",
    model: MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "", reasoning_content: "thinking at length" },
        finish_reason: "length",
      },
    ],
    usage: reportedProviderUsage({ prompt_tokens: 1, completion_tokens: 4096 }),
  });
}
function failedStepResponse(step: ProviderStep): Response | undefined {
  if (step === "exhausted") return exhaustedOutputResponse();
  if (step !== "overflow") return undefined;
  return Response.json(
    {
      error: {
        message: "max_tokens=1000000000 cannot be greater than max_model_len=8192.",
        code: "400",
      },
    },
    { status: 400 },
  );
}
function provider(
  steps: readonly ProviderStep[] = ["tool", "answer"],
  answerContent?: string,
  commentBody = "Synthetic approved comment",
  options: ProviderOptions = {},
): string[] {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((_url, init) => {
      const body = providerBody(init);
      const productive = isProductiveRequest(body);
      const step = productive ? (steps[requests.length] ?? "answer") : "answer";
      if (productive) {
        requests.push(body);
        options.onRequest?.(body, requests.length);
      }
      const failure = failedStepResponse(step);
      if (failure !== undefined) return Promise.resolve(failure);
      const tools = isToolStep(body, step);
      return Promise.resolve(
        Response.json({
          id: "mixed-response",
          model: MODEL,
          choices: [
            {
              index: 0,
              message: tools
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: Array.from({ length: options.toolCount ?? 1 }, (_, index) => ({
                      id: `mixed-call-${String(requests.length)}${index === 0 ? "" : `-${String(index)}`}`,
                      type: "function",
                      function: {
                        name: step === "write" ? "jira_comment" : "jira_projects",
                        arguments: toolArguments(step, commentBody),
                      },
                    })),
                  }
                : {
                    role: "assistant",
                    content: responseContent(body, step, steps, answerContent),
                  },
              finish_reason: tools ? "tool_calls" : "stop",
            },
          ],
          usage: reportedProviderUsage(productive ? options.usage : undefined),
        }),
      );
    }),
  );
  return requests;
}

// #4175: a confirmed Jira tool round is charged to and bounded by the turn's Authority Envelope,
// so it no longer spends the grounded answer's own token grant; the envelope still ends the turn.
function fullWindowToolRound(
  f: ReturnType<typeof runtime>,
  dimension: "input" | "output",
): string[] {
  const budget = modelWindowAwareBudget(f.deps, MODEL);
  return provider(["tool", "answer"], undefined, undefined, {
    usage: {
      prompt_tokens: dimension === "input" ? budget.modelInputTokensMax : 1,
      completion_tokens: dimension === "output" ? budget.modelOutputTokensMax : 1,
    },
  });
}
function askFeatureAndProjects(f: ReturnType<typeof runtime>): Promise<RouteResult> {
  return handleGroundedAsk(
    context({
      chatId: f.chatId,
      modelId: MODEL,
      content: "Explain src/Feature.ts and list the Jira projects.",
    }),
    f.deps,
  );
}

it.each(["input", "output"] as const)(
  "charges a successful Jira observation's %s tokens to the turn envelope, not the answer's grant",
  async (dimension) => {
    const f = runtime();
    const requests = fullWindowToolRound(f, dimension);
    const result = await askFeatureAndProjects(f);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("File: src/Feature.ts");
    expect(f.jiraRequests).toEqual(["GET"]);
    expect(result.status).toBe(200);
    expect(f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges).toMatchObject([
      { result: { status: "completed" } },
    ]);
  },
);

it("answers from the transcript when tool rounds spend the envelope's prompt budget", async () => {
  const f = runtime();
  const budget = modelWindowAwareBudget(f.deps, MODEL);
  Object.assign(f.deps, {
    chatToolTurnBudget: { ...THIRTY_CALL_BUDGET, maxPromptTokens: budget.modelInputTokensMax + 10 },
  });
  const requests = fullWindowToolRound(f, "input");
  const result = await askFeatureAndProjects(f);
  // The envelope refuses the next model round itself; no further provider or Jira work happens.
  expect(requests).toHaveLength(1);
  expect(f.jiraRequests).toEqual(["GET"]);
  expect(result.status).toBe(200);
  expect(JSON.stringify(result.body)).toContain("used up its tool-call or prompt budget");
  expect(f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges).toMatchObject([
    { result: { status: "completed" } },
  ]);
});

it("retains the thirty-call envelope Jira allowance across mixed model rounds and rejects the next batch", async () => {
  const f = runtime();
  Object.assign(f.deps, { chatToolTurnBudget: THIRTY_CALL_BUDGET });
  configure(f.deps, 0, 131072);
  const requests = provider(
    Array.from({ length: 8 }, () => "tool"),
    undefined,
    undefined,
    {
      toolCount: 5,
    },
  );
  const result = await handleGroundedAsk(
    context({
      chatId: f.chatId,
      modelId: MODEL,
      content: "Explain src/Feature.ts and list the Jira projects.",
    }),
    f.deps,
  );
  // Six rounds of five calls exhaust the envelope; the turn stops before a seventh model round
  // that could no longer act (#4175), so no further batch is even requested.
  expect(requests).toHaveLength(6);
  expect(f.jiraRequests).toHaveLength(30);
  expect(f.jiraRequests.every((method) => method === "GET")).toBe(true);
  expect(result.status).toBe(200);
  expect(JSON.stringify(result.body)).toContain("used up its tool-call or prompt budget");
  const exchanges = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges;
  expect(exchanges).toHaveLength(30);
  expect(exchanges?.every((exchange) => exchange.result?.status === "completed")).toBe(true);
});

it("keeps physical retrieval and its exhausted excerpt allowance through mixed tool and answer phases", async () => {
  const f = runtime();
  configure(f.deps, 0, 262144);
  mkdirSync(join(f.root, "facts"));
  for (let index = 0; index < 40; index++) {
    writeFileSync(
      join(f.root, "facts", `feature-${String(index).padStart(2, "0")}.ts`),
      `export const Feature = "${"x".repeat(5000)}";\n`,
    );
  }
  const readBytes = nodeWorkspaceFs.readFileBytes;
  if (readBytes === undefined) throw new Error("Missing descriptor byte reader");
  let reads = 0;
  vi.spyOn(nodeWorkspaceFs, "readFileBytes").mockImplementation(async (...args) => {
    if (args[0].startsWith(f.root)) reads++;
    return readBytes(...args);
  });
  const readsBeforeModels: number[] = [];
  const requests = provider(
    ["tool", "answer"],
    "Feature is defined [facts/feature-00.ts:1]. Jira tool result: project SYN is visible.",
    undefined,
    { onRequest: () => readsBeforeModels.push(reads) },
  );
  const result = await handleGroundedAsk(
    context({
      chatId: f.chatId,
      modelId: MODEL,
      content: "List all Feature definitions and Jira projects.",
    }),
    f.deps,
  );
  expect(result.status).toBe(200);
  expect(requests).toHaveLength(2);
  expect(f.jiraRequests).toEqual(["GET"]);
  expect(reads).toBeGreaterThan(0);
  expect(readsBeforeModels).toEqual([reads, reads]);
  const answer = result.body as GroundedAnswer;
  expect(answer.groundingKind).toBe("connected-context");
  if (answer.groundingKind !== "connected-context") throw new Error("Missing connected pack");
  expect(answer.contextPack.budget.excerptBytesMax).toBe(131072);
  expect(answer.contextPack.usage.excerptBytes).toBeLessThanOrEqual(131072);
  expect(answer.contextPack.omittedCounts["budget-exhausted"]).toBeGreaterThan(0);
  expect(answer.contextPack.usage.filesRead).toBeGreaterThan(0);
  expect(answer.contextPack.usage.searchCalls).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request).toContain(
      `excerpt bytes ${String(answer.contextPack.usage.excerptBytes)}/131072`,
    );
    expect(request).toContain(`files read ${String(answer.contextPack.usage.filesRead)}`);
  }
  expect(answer.contextPack.usage.searchCalls).toBeLessThanOrEqual(
    answer.contextPack.budget.searchCallsMax,
  );
});

async function startDeadlineMixedTurn(): Promise<{
  readonly f: ReturnType<typeof runtime>;
  readonly requests: string[];
  readonly pending: Promise<RouteResult>;
  readonly startedAt: number;
}> {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(new DOMException("Deadline reached", "TimeoutError"));
    }, milliseconds);
    return controller.signal;
  });
  const f = runtime();
  Object.assign(f.deps, { chatToolTurnBudget: THIRTY_CALL_BUDGET });
  const startedAt = Date.now();
  const registry = approvalOwner(f.deps);
  const waitForRead = vi.spyOn(registry, "waitForChatReadGrant");
  const decide = waitForRead.getMockImplementation();
  if (decide === undefined) throw new Error("Missing consent fixture");
  waitForRead.mockImplementation(async (...args) => {
    await vi.advanceTimersByTimeAsync(299000);
    return decide(...args);
  });
  const requests = provider();
  const nativeFetch = vi.mocked(fetch).getMockImplementation();
  if (nativeFetch === undefined) throw new Error("Missing provider fixture");
  vi.mocked(fetch).mockImplementation(async (...args) => {
    const response = await nativeFetch(...args);
    if (!isProductiveRequest(providerBody(args[1])) || requests.length !== 2) return response;
    const signal = args[1]?.signal;
    if (signal === undefined || signal === null) throw new Error("Missing synthesis cancellation");
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("Cancelled", "AbortError"),
          );
        },
        { once: true },
      );
    });
  });
  const pending = handleGroundedAsk(
    context({
      chatId: f.chatId,
      modelId: MODEL,
      content: "Explain src/Feature.ts and list the Jira projects.",
    }),
    f.deps,
  );
  void pending.catch(() => undefined);
  await vi.waitFor(
    () => {
      expect(requests).toHaveLength(2);
    },
    { interval: 1 },
  );
  expect(Date.now() - startedAt).toBeLessThan(300000);
  // The narrower per-tool timeout has already expired; Data synthesis may still run in
  // the original turn's last milliseconds. That phase must not receive a fresh deadline.
  expect(f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges).toMatchObject([
    { result: { status: "timeout" } },
  ]);
  return { f, requests, pending, startedAt };
}

it("answers mixed synthesis from its transcript at the accepted turn deadline after time spent awaiting read consent", async () => {
  const { f, requests, pending, startedAt } = await startDeadlineMixedTurn();
  try {
    await vi.advanceTimersByTimeAsync(1001);
    const result = await pending;
    // #4175 relocates this pin's terminal expectation: the exchange above settled, so the
    // deadline ends the turn with its deterministic transcript answer on the grounded path
    // instead of a 499. Every no-further-work assertion below is unchanged.
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).toContain("this turn reached its time limit");
    expect(requests).toHaveLength(2);
    expect(f.jiraRequests).toEqual([]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300000);
    expect(f.deps.store.listMessages(f.chatId)[0]?.turnState).toBe("completed");
  } finally {
    interruptChatGenerations(f.deps, f.chatId);
    await pending;
  }
});

it("keeps a human stop during mixed synthesis a cancellation although an exchange settled", async () => {
  const { f, requests, pending } = await startDeadlineMixedTurn();
  try {
    interruptChatGenerations(f.deps, f.chatId);
    const result = await pending;
    expect(result).toMatchObject({ status: 499, body: { error: { code: "CANCELLED" } } });
    expect(requests).toHaveLength(2);
    expect(f.jiraRequests).toEqual([]);
    // The serialized turn answers the stop at once; the in-flight turn settles its state after.
    await vi.waitFor(
      () => {
        expect(f.deps.store.listMessages(f.chatId)[0]?.turnState).toBe("cancelled");
      },
      { interval: 1 },
    );
  } finally {
    await pending;
  }
});

it("repairs one invalid native model call before normal Chat dispatches any Jira effect", async () => {
  const f = runtime();
  configure(f.deps, 1);
  const requests = provider(["malformed", "tool", "answer"]);
  const native = vi.mocked(fetch).getMockImplementation();
  if (native === undefined) throw new Error("Missing native model transport");
  const effectCounts: number[] = [];
  vi.mocked(fetch).mockImplementation((url, init) => {
    if (isProductiveRequest(providerBody(init))) effectCounts.push(f.jiraRequests.length);
    return native(url, init);
  });
  const response = await startOwnedTurn(f, f.chatId);
  expect(response.status).toBe(200);
  expect(requests).toHaveLength(3);
  expect(effectCounts).toEqual([0, 0, 1]);
  expect(requests[1]).toContain("rejected before execution");
  expect(requests[1]).toContain("maxResults");
  // The rejected call is corrected orchestration and the corrected call a confirmed tool round, so
  // neither shrinks the answer's output cap; their usage stays charged (pinned in
  // grounded-synthesis-call-budget.test.ts, "announced correction").
  expect(outputCap(requests[2] ?? "{}")).toBe(outputCap(requests[0] ?? "{}"));
  expect(f.jiraRequests).toEqual(["GET"]);
  expect(ownedExchange(f, f.chatId)).toMatchObject({
    call: { id: "mixed-call-2" },
    result: { status: "completed" },
  });
  expect(JSON.stringify(f.deps.store.listMessages(f.chatId))).not.toContain("mixed-call-1");
});

it.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
  "refuses an unreviewable secret-bearing write after additional store redaction in %s",
  async (mode) => {
    const secret = "synthetic-opaque-value-4081";
    const f = runtime(true, { FIGMA_ACCESS_TOKEN: secret });
    f.deps.store.updateChat(f.chatId, { toolMode: mode });
    const update = f.deps.store.updateChatToolTranscript;
    const boundBodies: unknown[] = [];
    vi.spyOn(f.deps.store, "updateChatToolTranscript").mockImplementation((...args) => {
      if (args[1].kind === "started") boundBodies.push(args[1].call.arguments.body);
      update(...args);
    });
    const requests = provider(["write", "answer"], undefined, secret);
    const response = await handleSendDesktopChat(
      context({
        chatId: f.chatId,
        projectPath: f.root,
        content: "Explain src/Feature.ts.",
        modelId: MODEL,
        clientTurnId: `redacted-action-${mode}`,
      }),
      f.deps,
    );
    expect(response.status).toBe(200);
    // The real gateway bound this opaque value; only the broader store secret floor knows it.
    expect(boundBodies).toEqual([secret]);
    const messages = f.deps.store.listMessages(f.chatId);
    const exchange = messages[0]?.toolTranscript?.exchanges[0];
    expect(exchange?.call.arguments.body).not.toBe(secret);
    expect(exchange?.result?.status).toBe("denied");
    expect(exchange?.approval).toBeUndefined();
    expect(f.jiraRequests).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(messages)).not.toContain(secret);
    expect(requests.join("\n")).not.toContain(secret);
  },
);

describe("mixed Jira and Data scope through the production gateway", () => {
  it("retrieves the existing evidence pack before Jira orchestration and preserves separate citations", async () => {
    const f = runtime();
    const requests = provider();
    const response = await handleGroundedAsk(
      context({
        chatId: f.chatId,
        content: "Explain src/Feature.ts and list the Jira projects.",
        modelId: MODEL,
      }),
      f.deps,
    );
    expect(response.status).toBe(200);
    expect(f.jiraRequests).toEqual(["GET"]);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.includes("File: src/Feature.ts"))).toBe(true);
    expect(requests[0]).toContain('"tools":');
    expect(requests[1]).toContain('"role":"tool"');
    expect((response.body as GroundedAnswer).content).toContain("Jira tool result");
    expect(JSON.stringify((response.body as GroundedAnswer).citations)).not.toContain("jira");
    expect(
      f.deps.store.listMessages(f.chatId).find((message) => message.role === "user")?.toolTranscript
        ?.exchanges,
    ).toHaveLength(1);
  });
});

it("keeps tool orchestration outside the one answer plus one repair synthesis ceiling", async () => {
  const f = runtime();
  const requests = provider(["tool", "tool", "uncited", "answer"]);
  const response = await handleGroundedAsk(
    context({
      chatId: f.chatId,
      content: "Explain src/Feature.ts and list Jira projects.",
      modelId: MODEL,
    }),
    f.deps,
  );
  expect(response.status).toBe(200);
  expect(requests).toHaveLength(4);
  const caps = requests.map(outputCap);
  expect(caps.every((cap) => cap > 0)).toBe(true);
  // Confirmed tool rounds are charged to the turn's Authority Envelope (#4175), so they leave the
  // answer's output grant intact; the uncited answer itself still narrows its repair.
  expect(caps[1]).toBe(caps[0]);
  expect(caps[2]).toBe(caps[1]);
  expect(caps[3]).toBeLessThan(caps[2] ?? 0);
  expect(f.jiraRequests).toEqual(["GET", "GET"]);
  expect((response.body as GroundedAnswer).content).toContain("[src/Feature.ts:1]");
});

it("dispatches the one steered repair of a tool round that exhausted its output budget", async () => {
  const f = runtime();
  const requests = provider(["tool", "exhausted", "tool", "answer"]);
  const response = await handleGroundedAsk(
    context({
      chatId: f.chatId,
      content: "Explain src/Feature.ts and list Jira projects.",
      modelId: MODEL,
    }),
    f.deps,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  // tool round, the exhausted round, its ONE steered repair (a tool call), then the answer.
  expect(requests).toHaveLength(4);
  expect(requests[2]).toContain("output budget");
  expect(f.jiraRequests).toEqual(["GET", "GET"]);
  expect((response.body as GroundedAnswer).content).toContain("[src/Feature.ts:1]");
});

it("grants a tool round only one steered repair and fails closed when the repair is exhausted too", async () => {
  const f = runtime();
  const requests = provider(["tool", "exhausted", "exhausted", "tool", "answer"]);
  const response = await handleGroundedAsk(
    context({
      chatId: f.chatId,
      content: "Explain src/Feature.ts and list Jira projects.",
      modelId: MODEL,
    }),
    f.deps,
  );
  expect(response.status).toBe(200);
  expect((response.body as GroundedAnswer).content).toContain("ran out of output budget");
  // tool round, the exhausted round and its ONE repair; no third attempt for that round.
  expect(requests).toHaveLength(3);
  expect(f.jiraRequests).toEqual(["GET"]);
});

// #4173 lab (Qwen, 17:13): a tool call the catalog rejects before execution is as unusable as an
// exhausted round. Its schema correction must not count it against the synthesis grant, or the
// second correction of one turn is refused (and was logged as a context-window denial).
it("admits every schema correction of a tool turn that carries connected sources", async () => {
  const f = runtime();
  configure(f.deps, 1);
  const requests = provider(["tool", "malformed", "tool", "malformed", "tool", "answer"]);
  const response = await handleGroundedAsk(
    context({
      chatId: f.chatId,
      content: "Explain src/Feature.ts and list Jira projects.",
      modelId: MODEL,
    }),
    f.deps,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(requests, JSON.stringify(response.body).slice(0, 600)).toHaveLength(6);
  expect(requests[2]).toContain("rejected before execution");
  expect(requests[4]).toContain("rejected before execution");
  expect(f.jiraRequests).toEqual(["GET", "GET", "GET"]);
  expect((response.body as GroundedAnswer).content).toContain("[src/Feature.ts:1]");
});

it("charges physical overflow before a tool response and denies a third synthesis attempt", async () => {
  const f = runtime();
  const requests = provider(["overflow", "tool", "uncited", "answer"]);
  const response = await handleGroundedAsk(
    context({
      chatId: f.chatId,
      content: "Explain src/Feature.ts and list Jira projects.",
      modelId: MODEL,
    }),
    f.deps,
  );
  expect(response.status).toBe(200);
  expect(requests).toHaveLength(3);
  expect(f.jiraRequests).toEqual(["GET"]);
  expect((response.body as GroundedAnswer).content).not.toContain("Jira tool result");
});

function assertPreservedWriteContinuation(requests: readonly string[]): void {
  for (const request of requests.slice(1)) {
    expect(request).toContain('"id":"mixed-call-1"');
    expect(request).toContain('"tool_call_id":"mixed-call-1"');
    expect(request).toContain('"role":"tool"');
  }
  // The confirmed write round is the envelope's; the overflow attempt stays charged to the grant.
  expect(outputCap(requests[1] ?? "{}")).toBe(outputCap(requests[0] ?? "{}"));
  expect(outputCap(requests[2] ?? "{}")).toBeLessThanOrEqual(outputCap(requests[1] ?? "{}"));
}

it.each(["answer", "uncited"] as const)(
  "retains a committed mutation across context overflow and bounded %s synthesis",
  async (answer) => {
    const f = runtime(true);
    const requests = provider(["write", "overflow", answer, "answer"]);
    const body = {
      chatId: f.chatId,
      projectPath: f.root,
      content: "Explain src/Feature.ts and add the Jira comment.",
      modelId: MODEL,
      clientTurnId: `mixed-write-overflow-${answer}`,
    };
    const response = await handleSendDesktopChat(context(body), f.deps);
    expect(response.status).toBe(200);
    // The overflow and its physical retry spend both synthesis attempts. An uncited retry
    // cannot reset that meter by requesting a fourth provider call for citation repair.
    expect(requests).toHaveLength(3);
    expect(f.jiraRequests.filter((method) => method !== "GET")).toEqual(["POST"]);
    const messages = f.deps.store.listMessages(f.chatId);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.turnState).toBe("completed");
    expect(messages[0]?.toolTranscript?.exchanges).toHaveLength(1);
    expect(messages[0]?.toolTranscript?.exchanges[0]).toMatchObject({
      call: { id: "mixed-call-1", name: "jira_comment" },
      mutationOutcome: "succeeded",
      result: { status: "completed" },
    });
    assertPreservedWriteContinuation(requests);
    expect((await handleSendDesktopChat(context(body), f.deps)).status).toBe(200);
    expect(requests).toHaveLength(3);
    expect(f.jiraRequests.filter((method) => method !== "GET")).toEqual(["POST"]);
    expect(f.deps.store.listMessages(f.chatId)).toEqual(messages);
  },
);

it("falls back before admission and replays the same mixed canonical turn without a second write", async () => {
  const f = runtime(true);
  const requests = provider(["write", "answer"]);
  const body = {
    chatId: f.chatId,
    projectPath: f.root,
    content: "Explain src/Feature.ts and add the Jira comment.",
    modelId: MODEL,
    clientTurnId: "mixed-once",
  };
  const stream = await handleSendDesktopChatStream(context(body), f.deps);
  expect(stream).toMatchObject({ status: 400, body: { error: { code: "STREAMING_UNSUPPORTED" } } });
  expect(requests).toHaveLength(0);
  expect(f.jiraRequests).toHaveLength(0);
  expect(f.deps.store.listMessages(f.chatId)).toHaveLength(0);
  const response = await handleSendDesktopChat(context(body), f.deps);
  expect(response.status).toBe(200);
  expect(requests).toHaveLength(2);
  expect(f.jiraRequests.filter((method) => method !== "GET")).toEqual(["POST"]);
  const messages = f.deps.store.listMessages(f.chatId);
  expect(messages).toHaveLength(2);
  expect(messages[0]?.toolTranscript?.exchanges[0]?.mutationOutcome).toBe("succeeded");
  expect((await handleSendDesktopChat(context(body), f.deps)).status).toBe(200);
  expect(requests).toHaveLength(2);
  expect(f.jiraRequests.filter((method) => method !== "GET")).toEqual(["POST"]);
  expect(f.deps.store.listMessages(f.chatId)).toHaveLength(2);
});

async function connectDataPod(
  f: ReturnType<typeof runtime>,
  text: string,
  keepFolder = false,
): Promise<void> {
  const store = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: dirname(f.deps.uiDbPath ?? "") }),
  });
  try {
    const pod = await seedCapsuleWithVectors(store, { displayName: "Synthetic Data Pod", text });
    updateCapsuleState(store, pod.capsuleId, "ready");
    f.deps.store.updateChat(f.chatId, {
      ...(keepFolder ? {} : { connectedScope: null }),
      localKnowledgeScopes: [{ kind: "capsule", capsuleId: pod.capsuleId, connectedAtMs: 1 }],
    });
  } finally {
    store.close();
  }
}

it("uses the existing local Data-Pod evidence pack with Jira and keeps its numeric citations", async () => {
  const f = runtime();
  await connectDataPod(f, "Feature returns true. Feature is a function.");
  const requests = provider();
  const result = await handleGroundedAsk(
    context({
      chatId: f.chatId,
      content: "What does Feature return? Also list Jira projects.",
      modelId: MODEL,
    }),
    f.deps,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(f.jiraRequests).toEqual(["GET"]);
  expect(requests).toHaveLength(2);
  const answer = result.body as GroundedAnswer;
  expect(answer.groundingKind).toBe("local-knowledge");
  expect(answer.content).toContain("Jira tool result");
  expect(answer.citations).toHaveLength(1);
  expect(JSON.stringify(answer.citations)).not.toContain("jira");
});

it("preserves Data-only desktop refusal and tool-free grounded synthesis", async () => {
  const f = runtime();
  f.deps.store.updateChat(f.chatId, { jiraPodId: null });
  const requests = provider(["answer"]);
  const body = {
    chatId: f.chatId,
    projectPath: f.root,
    content: "Explain src/Feature.ts",
    modelId: MODEL,
  };
  expect((await handleSendDesktopChat(context(body), f.deps)).status).toBe(409);
  expect(f.deps.store.listMessages(f.chatId)).toHaveLength(0);
  expect((await handleGroundedAsk(context(body), f.deps)).status).toBe(200);
  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toContain('"tools":');
  expect(f.jiraRequests).toHaveLength(0);
});

it.each(["empty", "unmatched"] as const)(
  "executes permitted Jira reads after %s folder evidence without creating Data citations",
  async (source) => {
    const f = runtime();
    if (source === "empty") rmSync(join(f.root, "src"), { recursive: true });
    else {
      writeFileSync(join(f.root, "empty.txt"), "");
      f.deps.store.updateChat(f.chatId, {
        connectedScope: { kind: "files", relativePaths: ["empty.txt"], connectedAtMs: 0 },
      });
    }
    const requests = provider(["tool", "answer"], "Jira tool result: project SYN is visible.");
    const response = await handleGroundedAsk(
      context({ chatId: f.chatId, content: "List the Jira projects.", modelId: MODEL }),
      f.deps,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(f.jiraRequests).toEqual(["GET"]);
    expect(requests).toHaveLength(2);
    const answer = response.body as GroundedAnswer;
    expect(answer.content).toContain("Jira tool result");
    expect(answer.citations).toEqual([]);
    expect(answer.evidenceRunId).toBeUndefined();
  },
);

it("keeps exact write approval and one remote effect when the connected folder has no evidence", async () => {
  const f = runtime(true);
  rmSync(join(f.root, "src"), { recursive: true });
  const requests = provider(["write", "answer"], "Jira tool result: the comment was added.");
  const body = {
    chatId: f.chatId,
    content: "Add the synthetic Jira comment.",
    modelId: MODEL,
    clientTurnId: "empty-data-write",
  };
  const response = await handleGroundedAsk(context(body), f.deps);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(f.jiraRequests.filter((method) => method !== "GET")).toEqual(["POST"]);
  expect(requests).toHaveLength(2);
  expect((response.body as GroundedAnswer).citations).toEqual([]);
  const approval = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.approval;
  expect(approval).toBeDefined();
  expect(
    f.deps.atlassianActionApprovalRegistry?.getChatWriteApproval(approval?.approvalId ?? "")
      ?.approval.state,
  ).toBe("claimed");
  expect((await handleGroundedAsk(context(body), f.deps)).status).toBe(200);
  expect(f.jiraRequests.filter((method) => method !== "GET")).toEqual(["POST"]);
});

it.each([false, true])(
  "answers Jira from an empty Data-Pod pack with hybrid=%s and no false Memory attribution",
  async (hybrid) => {
    const f = runtime();
    rmSync(join(f.root, "src"), { recursive: true });
    await connectDataPod(f, "Orchids grow in violet garden beds.", hybrid);
    const requests = provider(["tool", "answer"], "Jira tool result: project SYN is visible.");
    const response = await handleGroundedAsk(
      context({ chatId: f.chatId, content: "List Jira projects.", modelId: MODEL }),
      f.deps,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(f.jiraRequests).toEqual(["GET"]);
    expect(requests).toHaveLength(2);
    const answer = response.body as GroundedAnswer;
    expect(answer.content).toContain("Jira tool result");
    expect(answer.citations).toEqual([]);
    expect(JSON.stringify(answer)).not.toContain("answer-only-memory");
    expect(answer.memory).toBeUndefined();
  },
);

it("abstains when a tool-only empty-pack model invents an answer without invoking Jira", async () => {
  const f = runtime();
  rmSync(join(f.root, "src"), { recursive: true });
  const requests = provider(["answer"], "Invented Jira source fact.");
  const result = await handleGroundedAsk(
    context({ chatId: f.chatId, content: "List Jira projects.", modelId: MODEL }),
    f.deps,
  );
  expect(result.status).toBe(200);
  expect(requests).toHaveLength(1);
  expect(f.jiraRequests).toEqual([]);
  expect((result.body as GroundedAnswer).content).not.toContain("Invented");
  expect((result.body as GroundedAnswer).citations).toEqual([]);
});

it.each([403, 200])(
  "requires successful published Jira evidence after HTTP %s, including empty lists",
  async (status) => {
    const f = runtime();
    rmSync(join(f.root, "src"), { recursive: true });
    jiraHttpResult(f, status, status === 200 ? [] : {});
    const answer =
      status === 200
        ? "The connected Jira contains no projects."
        : "Invented Jira fact: project SYN was released.";
    const requests = provider(["tool", "answer"], answer);
    const result = await handleGroundedAsk(
      context({ chatId: f.chatId, content: "List Jira projects.", modelId: MODEL }),
      f.deps,
    );
    expect(result.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(f.jiraRequests).toEqual(["GET"]);
    const content = (result.body as GroundedAnswer).content;
    if (status === 200) expect(content).toBe(answer);
    else expect(content).not.toContain("Invented Jira fact");
    expect((result.body as GroundedAnswer).citations).toEqual([]);
    expect(
      f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.result?.status,
    ).toBe(status === 200 ? "completed" : "failed");
  },
);

function jiraHttpResult(f: ReturnType<typeof runtime>, status: number, body: unknown): void {
  const credentials = f.deps.atlassianConnectorCredentials;
  if (credentials === undefined) throw new Error("Missing HTTP owner");
  vi.spyOn(credentials, "httpBodyPortFactory").mockImplementation(
    (_metadata, _correlation, lifecycle) =>
      (request): ReturnType<AtlassianHttpBodyPort> => {
        expect(lifecycle?.beforeDispatch?.(request)).toBe(true);
        f.jiraRequests.push(request.method);
        lifecycle?.onResponse?.(request, status);
        const bodyText = JSON.stringify(body);
        return Promise.resolve({
          kind: "response",
          status,
          bodyText,
          bodyBytes: Buffer.byteLength(bodyText),
          truncated: false,
        });
      },
  );
}

it("keeps an acknowledged but unconfirmed mixed write in its card without factual synthesis or replay", async () => {
  const f = runtime(true);
  rmSync(join(f.root, "src"), { recursive: true });
  jiraHttpResult(f, 201, {});
  const requests = provider(
    ["write", "answer"],
    "Invented confirmation: the comment was definitely added.",
  );
  const body = {
    chatId: f.chatId,
    content: "Add a Jira comment.",
    modelId: MODEL,
    clientTurnId: "unconfirmed-mixed-write",
  };
  const result = await handleGroundedAsk(context(body), f.deps);
  expect(result.status).toBe(200);
  expect(requests).toHaveLength(2);
  expect((result.body as GroundedAnswer).content).not.toContain("Invented confirmation");
  const exchange = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0];
  expect(exchange?.mutationOutcome).toBe("succeeded-unconfirmed");
  expect(f.jiraRequests).toEqual(["POST"]);
  expect((await handleGroundedAsk(context(body), f.deps)).status).toBe(200);
  expect(f.jiraRequests).toEqual(["POST"]);
});

it("retains Data-only empty-pack abstention and the missing selected path denial", async () => {
  const f = runtime();
  rmSync(join(f.root, "src"), { recursive: true });
  const requests = provider();
  f.deps.store.updateChat(f.chatId, {
    connectedScope: { kind: "files", relativePaths: ["src/Missing.ts"], connectedAtMs: 0 },
  });
  const body = { chatId: f.chatId, content: "List Jira projects.", modelId: MODEL };
  expect((await handleGroundedAsk(context(body), f.deps)).status).toBe(400);
  f.deps.store.updateChat(f.chatId, {
    jiraPodId: null,
    connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 0 },
  });
  expect((await handleGroundedAsk(context(body), f.deps)).status).toBe(200);
  expect(requests).toEqual([]);
  expect(f.jiraRequests).toEqual([]);
});

it("rejects a bound mixed model without verified tool capability before any provider or Jira effect", async () => {
  const f = runtime();
  rmSync(join(f.root, "src"), { recursive: true });
  const config = f.deps.gatewayConfig;
  const current = config?.current();
  if (config === undefined || current === undefined) throw new Error("Missing gateway");
  config.set(
    parseGatewayConfig({
      ...current,
      capabilities: current.capabilities?.map((capability) =>
        capability.kind === "chat"
          ? { ...capability, toolCallingVerification: undefined }
          : capability,
      ),
    }),
    true,
  );
  config.recordVerifiedCapability(
    MODEL,
    { conversationReady: true },
    new Date().toISOString(),
    config.generation(),
  );
  const requests = provider();
  const result = await handleGroundedAsk(
    context({ chatId: f.chatId, content: "List Jira projects.", modelId: MODEL }),
    f.deps,
  );
  expect(result).toMatchObject({
    status: 400,
    body: { error: { code: "CONVERSATION_UNAVAILABLE_MODEL" } },
  });
  expect(JSON.stringify(result.body)).toContain("verified tool calling");
  expect(requests).toEqual([]);
  expect(f.jiraRequests).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps Memory capture governed when an empty-pack Jira turn has Full access", async () => {
  const f = runtime(true);
  rmSync(join(f.root, "src"), { recursive: true });
  f.deps.store.updateChat(f.chatId, { toolMode: "autonomous-delivery" });
  provider(["write", "answer"], "Jira tool result: the comment was added.");
  const result = await handleGroundedAsk(
    context({
      chatId: f.chatId,
      content: "remember that release checks use vitest. Add the Jira comment.",
      modelId: MODEL,
      memory: {
        enabled: true,
        budgetTokens: 1200,
        mode: "autonomous-delivery",
        context: {
          userId: "local-operator",
          workspaceId: f.root,
          projectId: f.root,
          conversationId: f.chatId,
        },
      },
    }),
    { ...f.deps, memoryDeploymentCeiling: "governed-assist" },
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(f.jiraRequests.filter((method) => method !== "GET")).toEqual(["POST"]);
  expect(
    f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.approval,
  ).toBeUndefined();
  const vault = f.deps.memoryVault;
  if (vault === undefined) throw new Error("Missing Memory vault");
  const memories = vault.listMemoriesAcrossScopes(vault.listMemoryScopes());
  expect(memories.length).toBeGreaterThan(0);
  expect(memories.every((memory) => memory.status === "proposed")).toBe(true);
  expect((result.body as GroundedAnswer).memory?.context.memories).toEqual([]);
});

it("abstains from fabricated Jira facts after refused consent with empty Data evidence", async () => {
  const f = runtime();
  rmSync(join(f.root, "src"), { recursive: true });
  const registry = f.deps.atlassianActionApprovalRegistry;
  if (registry === undefined) throw new Error("Missing approval owner");
  vi.spyOn(registry, "waitForChatReadGrant").mockImplementation(async (id) => {
    expect(
      (
        await handleDecideChatReadConsent(
          context({ decision: "reject", disclosureVersion: "jira-chat-read-v1" }, id),
          f.deps,
        )
      ).status,
    ).toBe(200);
  });
  const requests = provider(["tool", "answer"], "Invented Jira fact: project SYN was released.");
  const result = await handleGroundedAsk(
    context({ chatId: f.chatId, content: "List Jira projects.", modelId: MODEL }),
    f.deps,
  );
  expect(result.status).toBe(200);
  expect(requests).toHaveLength(2);
  expect(f.jiraRequests).toEqual([]);
  expect((result.body as GroundedAnswer).content).not.toContain("Invented Jira fact");
  expect((result.body as GroundedAnswer).citations).toEqual([]);
  expect(f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.result?.status).toBe(
    "denied",
  );
});

it.each(["disabled", "outside-scope"] as const)(
  "does not attach %s Memory when Jira enables an empty-evidence answer",
  async (kind) => {
    const f = runtime();
    rmSync(join(f.root, "src"), { recursive: true });
    const vault = f.deps.memoryVault;
    if (vault === undefined) throw new Error("Missing Memory vault");
    const canary = "PRIVATE_MEMORY_CANARY_RESERVED_TO_ANOTHER_SOURCE";
    vault.insertMemory({
      id: "isolated-memory" as MemoryId,
      schemaVersion: "1",
      scope:
        kind === "disabled"
          ? { kind: "user", userId: "local-operator" as UserId }
          : { kind: "project", projectId: "another-project" as ProjectId },
      type: "preference",
      body: canary,
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: 1,
        confidence: 1,
        sensitivity: "public",
      },
      validity: { validFrom: 1 },
      status: "accepted",
      pinned: true,
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    });
    const requests = provider(["tool", "answer"], "Jira tool result: project SYN is visible.");
    const result = await handleGroundedAsk(
      context({
        chatId: f.chatId,
        content: "List Jira projects.",
        modelId: MODEL,
        memory: {
          enabled: kind !== "disabled",
          budgetTokens: 1200,
          mode: "autonomous-delivery",
          context: {
            userId: "local-operator",
            workspaceId: f.root,
            projectId: f.root,
            conversationId: f.chatId,
          },
        },
      }),
      { ...f.deps, memoryDeploymentCeiling: "governed-assist" },
    );
    expect(result.status).toBe(200);
    expect(f.jiraRequests).toEqual(["GET"]);
    expect(requests.join(" ")).not.toContain(canary);
    expect((result.body as GroundedAnswer).memory?.context.memories).toEqual([]);
    expect(JSON.stringify(result.body)).not.toContain(canary);
  },
);

it.each(["default", "preserve"] as const)(
  "keeps %s document policy and the credential floor across real mixed Jira rounds",
  async (policy) => {
    const secret = "synthetic-configured-infrastructure-value";
    const phone = "+49 30 12345678";
    const f = runtime(false, {
      KEIKO_DEFAULT_API_KEY: secret,
      ...(policy === "preserve" ? { KEIKO_CONTENT_REDACTION: "off" } : {}),
    });
    writeFileSync(
      join(f.root, "src", "Feature.ts"),
      [
        "export function Feature() { return true; }",
        `// Contact: ${phone}`,
        `// Infrastructure credential: ${secret}`,
        "",
      ].join("\n"),
    );
    const requests = provider(
      ["tool", "answer"],
      `${CITED} Contact: ${phone}; credential: ${secret}`,
    );
    const result = await handleGroundedAsk(
      context({
        chatId: f.chatId,
        content: "Explain src/Feature.ts and list Jira projects.",
        modelId: MODEL,
      }),
      f.deps,
    );
    expect(result.status).toBe(200);
    expect(f.jiraRequests).toEqual(["GET"]);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.includes(phone))).toBe(policy === "preserve");
    expect(requests.every((request) => !request.includes(secret))).toBe(true);
    const answer = result.body as GroundedAnswer;
    expect(answer.content.includes(phone)).toBe(policy === "preserve");
    expect(answer.content).not.toContain(secret);
    const stored = f.deps.store.listMessages(f.chatId);
    expect(stored.find((message) => message.role === "assistant")?.content.includes(phone)).toBe(
      policy === "preserve",
    );
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(answer.citations)).not.toContain("jira");
  },
);
