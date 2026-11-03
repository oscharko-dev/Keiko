import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultChatCapability,
  createGatewayToolCatalogBridge,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
  type GatewayCallRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { DEFAULT_LIMITS, type ModelPort } from "@oscharko-dev/keiko-harness";
import type {
  ChatToolReadGrantView,
  ChatToolWriteApprovalView,
} from "@oscharko-dev/keiko-contracts";
import type { ExternalMcpConnection } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import type {
  AtlassianCredentialMetadata,
  AtlassianHttpBodyPort,
} from "@oscharko-dev/keiko-connectors";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { handleSendDesktopChat } from "./chat-handlers.js";
import { handleUpdateChat } from "./store-handlers.js";
import { deriveChatGroundingScopeIdentity } from "./store/chat-grounding-scope-identity.js";
import { mockRequest, mockResponse } from "./_support.js";
import type { RouteContext } from "./routes.js";
import { jiraChatActorDigest } from "./atlassian/jiraPodAccess.js";
import { handleDecideChatReadConsent } from "./atlassian/chatReadConsentRoutes.js";
import { handleDecideChatWriteApproval } from "./atlassian/chatWriteApprovalRoutes.js";
import { installMcpChatCatalogRuntime } from "./mcp/mcpChatCatalogRuntime.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";

const MODEL = "synthetic-combined-chat";
const POD = "d5f5681e-ce98-4c3c-b27e-51d707c9d018";
const CORRELATION = "combined-chat-proof";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});
interface Options {
  readonly write?: boolean;
  readonly repeat?: boolean;
  readonly batchSize?: number;
  readonly promptTokens?: number;
  readonly beforeMcpWriteResult?: () => Promise<void>;
}
function context(body: Record<string, unknown>, params: Record<string, string> = {}): RouteContext {
  return {
    req: mockRequest({ body: JSON.stringify(body) }),
    res: mockResponse().res,
    params,
    url: new URL("http://127.0.0.1/api/desktop/chat"),
    correlationId: CORRELATION,
  };
}
function configure(deps: UiHandlerDeps): void {
  const provider = {
    modelId: MODEL,
    baseUrl: "https://model.example.invalid/v1",
    apiKey: "synthetic-unused",
    timeoutMs: 5000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
  deps.gatewayConfig?.set(
    parseGatewayConfig({
      providers: [provider],
      capabilities: [
        {
          ...createDefaultChatCapability(MODEL),
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
  deps.gatewayConfig?.recordVerifiedCapability(
    MODEL,
    { conversationReady: true },
    new Date().toISOString(),
    deps.gatewayConfig.generation(),
  );
}
function model(calls: GatewayCallRequest[], options: Options): ModelPort {
  const promptTokens = options.promptTokens ?? 100;
  const batchSize = options.batchSize ?? 2;
  return {
    call: (request): Promise<NormalizedResponse> => {
      calls.push(request);
      const admission = request.attemptAdmission?.({ promptTokens, maxOutputTokens: 100 });
      const response: NormalizedResponse = {
        modelId: MODEL,
        content: "Both source observations are available.",
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: `request-${String(calls.length)}`,
          promptTokens,
          completionTokens: 10,
          latencyMs: 1,
          costClass: "low",
        },
      };
      admission?.settle(response.usage, true, "observed");
      if (calls.length > 1 && options.repeat !== true) return Promise.resolve(response);
      if (request.toolCatalog?.kind !== "bound") throw new Error("Expected shared bound catalog");
      const jira = request.toolCatalog.projection.tools.find(
        (entry) =>
          entry.toolRef.canonicalId ===
          (options.write === true ? "keiko.jira.comment" : "keiko.jira.projects"),
      );
      const mcp = request.toolCatalog.projection.tools.find((entry) =>
        entry.alias.includes(options.write === true ? "create_note" : "get_status"),
      );
      if (jira === undefined || mcp === undefined) throw new Error("Both sources must be offered");
      const bridge = createGatewayToolCatalogBridge({ ...request, stream: false }, Date.now);
      return Promise.resolve({
        ...response,
        content: "",
        finishReason: "tool_calls",
        toolCalls: Array.from({ length: batchSize }, (_, index) => {
          const external = index % 2 === 0;
          return bridge.bind({
            id: `call-${String(calls.length)}-${String(index)}`,
            name: (external ? mcp : jira).alias,
            arguments:
              options.write === true
                ? external
                  ? { text: "Synthetic combined note" }
                  : { issueKey: "KEIKO-1", body: "Synthetic combined comment" }
                : {},
          });
        }),
      });
    },
  };
}
function credential(deps: UiHandlerDeps): AtlassianCredentialMetadata {
  const ownerDigest = jiraChatActorDigest(deps);
  if (ownerDigest === undefined) throw new Error("Missing principal");
  return {
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
      creationRequestId: "d5f5681e-ce98-4c3c-b27e-51d707c9d019",
      verificationRevision: 1,
      verificationInProgress: false,
      verificationStatus: "ok",
    },
  };
}
interface Fixture {
  readonly deps: UiHandlerDeps;
  readonly chatId: string;
  readonly root: string;
  readonly calls: GatewayCallRequest[];
  readonly effects: string[];
}
function fixture(options: Options = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-combined-chat-")));
  const calls: GatewayCallRequest[] = [];
  const effects: string[] = [];
  const base = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui.db"),
    env: { KEIKO_STATE_DIR: root },
    modelPortFactory: () => model(calls, options),
  });
  const settings = base.mcpSettings;
  if (settings === undefined) throw new Error("Missing MCP settings owner");
  const server: McpServerDefinition = {
    name: "synthetic",
    description: "Synthetic combined fixture",
    enabled: true,
    transport: { kind: "local", command: [process.execPath], environment: {} },
    tools: { get_status: "read", create_note: "write" },
  };
  settings.update(
    { expectedRevision: settings.read(CORRELATION).revision, servers: [server], secrets: {} },
    CORRELATION,
  );
  const connection: ExternalMcpConnection = {
    signal: new AbortController().signal,
    tools: [
      {
        name: "get_status",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "create_note",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", maxLength: 64 } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    ],
    call: async (name, _args, invocation) => {
      if (!invocation.beforeEffect()) throw new Error("Expected admitted MCP effect");
      effects.push(name === "get_status" ? "mcp-read" : "mcp-write");
      if (name === "create_note") await options.beforeMcpWriteResult?.();
      return { content: [{ type: "text", text: "synthetic-mcp-observation" }] };
    },
    close: () => Promise.resolve(),
  };
  const connections: NonNullable<UiHandlerDeps["mcpConnections"]> = {
    inspect: () => [],
    connect: () => Promise.resolve(connection),
    generation: (definition, correlation) => settings.generation(definition, correlation),
    serve: () => Promise.resolve(new Response(null, { status: 404 })),
    close: () => Promise.resolve(),
  };
  const deps = installMcpChatCatalogRuntime(Object.assign(base, { mcpConnections: connections }), {
    primary: createBufferedServerLogSink(),
    diagnostics: { record: (): void => undefined },
  });
  cleanup.push(async () => {
    await deps.dispose?.();
    rmSync(root, { recursive: true, force: true });
  });
  configure(deps);
  deps.store.createProject(root);
  const chat = deps.store.createChat(root, "Synthetic combined", MODEL);
  deps.store.updateChat(
    chat.id,
    { jiraPodId: POD },
    { verifiedJiraPod: { podId: POD, authenticationGeneration: 1 } },
  );
  const credentials = deps.atlassianConnectorCredentials;
  if (credentials === undefined) throw new Error("Missing credential owner");
  vi.spyOn(credentials.custody, "list").mockImplementation(() => [credential(deps)]);
  vi.spyOn(credentials, "httpBodyPortFactory").mockImplementation(
    (_metadata, _correlation, lifecycle) =>
      (request): ReturnType<AtlassianHttpBodyPort> => {
        if (lifecycle?.beforeDispatch?.(request) !== true)
          throw new Error("Expected Jira dispatch admission");
        const write = request.method !== "GET";
        effects.push(write ? "jira-write" : "jira-read");
        const status = write ? 201 : 200;
        lifecycle.onResponse?.(request, status);
        const bodyText =
          options.write === true
            ? JSON.stringify({ id: "10001", body: "Synthetic combined comment" })
            : "[]";
        return Promise.resolve({
          kind: "response",
          status,
          bodyText,
          bodyBytes: Buffer.byteLength(bodyText),
          truncated: false,
        });
      },
  );
  return { deps, chatId: chat.id, root, calls, effects };
}
function send(f: Fixture): ReturnType<typeof handleSendDesktopChat> {
  return handleSendDesktopChat(
    context({
      chatId: f.chatId,
      projectPath: f.root,
      modelId: MODEL,
      content: "Use both explicitly connected sources",
      clientTurnId: "combined-human-turn",
      memory: { enabled: false, budgetTokens: 0, mode: "governed-assist", context: {} },
    }),
    f.deps,
  );
}
async function pendingRead(
  f: Fixture,
  kind: ChatToolReadGrantView["kind"],
): Promise<ChatToolReadGrantView> {
  const current = (): ChatToolReadGrantView | undefined =>
    f.deps.store
      .listMessages(f.chatId)[0]
      ?.toolTranscript?.readGrants?.find(
        (grant) => grant.kind === kind && grant.state === "pending",
      );
  await vi.waitFor(() => {
    expect(current()).toBeDefined();
  });
  const grant = current();
  if (grant === undefined) throw new Error("Missing source disclosure");
  return grant;
}
async function approveRead(f: Fixture, kind: ChatToolReadGrantView["kind"]): Promise<void> {
  const grant = await pendingRead(f, kind);
  expect(
    (
      await handleDecideChatReadConsent(
        context(
          { decision: "approve", disclosureVersion: grant.disclosureVersion },
          { approvalId: grant.grantId },
        ),
        f.deps,
      )
    ).status,
  ).toBe(200);
}
async function approveWrite(f: Fixture, kind: ChatToolWriteApprovalView["kind"]): Promise<void> {
  const current = (): ChatToolWriteApprovalView | undefined =>
    f.deps.store
      .listMessages(f.chatId)[0]
      ?.toolTranscript?.exchanges.find(
        (exchange) => exchange.approval?.kind === kind && exchange.approval.state === "pending",
      )?.approval;
  await vi.waitFor(() => {
    expect(current()).toBeDefined();
  });
  const approval = current();
  if (approval === undefined) throw new Error("Missing action approval");
  expect(
    (
      await handleDecideChatWriteApproval(
        context(
          { decision: "approve", actionDigest: approval.actionDigest },
          { approvalId: approval.approvalId },
        ),
        f.deps,
      )
    ).status,
  ).toBe(200);
}
async function expectFirstMutationAwaitingResult(f: Fixture): Promise<void> {
  await vi.waitFor(() => {
    expect(f.effects).toEqual(["mcp-write"]);
  });
  const blocked = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript;
  // The remote effect has started, but its result/receipt/journal settlement is still pending.
  // The second source must not even publish a call or request its read/action consent yet.
  expect(blocked?.exchanges.map((exchange) => exchange.call.id)).toEqual(["call-1-0"]);
  expect(blocked?.exchanges[0]?.result).toBeUndefined();
  expect(blocked?.readGrants?.map((grant) => grant.kind)).toEqual(["mcp-chat-read"]);
  expect(f.calls).toHaveLength(1);
}
it("offers both sources through one ordinary Chat handler and retains independent disclosures", async () => {
  const f = fixture();
  const pending = send(f);
  void pending.catch(() => undefined);
  await vi.waitFor(() => {
    expect(f.calls[0]).toBeDefined();
  });
  const offered = f.calls[0]?.toolCatalog;
  if (offered?.kind !== "bound") throw new Error("Expected a bound combined catalog");
  expect(
    offered.projection.tools.some((entry) => entry.alias.startsWith("mcp_")),
    "Configured MCP tools must remain offered in a Jira-bound Chat",
  ).toBe(true);
  expect(
    offered.projection.tools.some((entry) => entry.toolRef.canonicalId === "keiko.jira.projects"),
  ).toBe(true);
  await pendingRead(f, "mcp-chat-read");
  expect(f.effects).toEqual([]);
  await approveRead(f, "mcp-chat-read");
  await pendingRead(f, "jira-chat-read");
  expect(f.effects).toEqual(["mcp-read"]);
  await approveRead(f, "jira-chat-read");
  expect((await pending).status).toBe(200);
  expect(f.effects).toEqual(["mcp-read", "jira-read"]);
  const transcript = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript;
  expect(transcript?.readGrants?.map(({ kind, state }) => ({ kind, state }))).toEqual([
    { kind: "mcp-chat-read", state: "granted" },
    { kind: "jira-chat-read", state: "granted" },
  ]);
  expect(transcript?.exchanges.map((exchange) => exchange.result?.status)).toEqual([
    "completed",
    "completed",
  ]);
  expect(
    f.calls[1]?.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId),
  ).toEqual(["call-1-0", "call-1-1"]);
});
it("approves and journals writes from both sources independently on the same accepted turn", async () => {
  let releaseFirst!: () => void;
  const firstResult = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const f = fixture({ write: true, beforeMcpWriteResult: () => firstResult });
  const pending = send(f);
  void pending.catch(() => undefined);
  try {
    await approveRead(f, "mcp-chat-read");
    expect(f.effects).toEqual([]);
    await approveWrite(f, "mcp-chat-write");
    await expectFirstMutationAwaitingResult(f);
  } finally {
    releaseFirst();
  }
  await pendingRead(f, "jira-chat-read");
  expect(f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]).toMatchObject({
    mutationOutcome: "succeeded",
    result: { status: "completed" },
  });
  await approveRead(f, "jira-chat-read");
  expect(f.effects).toEqual(["mcp-write"]);
  await approveWrite(f, "jira-chat-write");
  expect((await pending).status).toBe(200);
  expect(f.effects).toEqual(["mcp-write", "jira-write", "jira-read"]);
  const exchanges = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges;
  expect(exchanges?.map((exchange) => exchange.mutationOutcome)).toEqual([
    "succeeded",
    "succeeded",
  ]);
  expect(
    exchanges?.map((exchange) =>
      f.deps.store.chatToolMutations?.find(exchange.approval?.invocationId ?? "missing"),
    ),
  ).toEqual([
    expect.objectContaining({ sourceKind: "configured-mcp", podId: null, outcome: "succeeded" }),
    expect.objectContaining({ podId: POD, operation: "jira.comment", outcome: "succeeded" }),
  ]);
  expect((await send(f)).status).toBe(200);
  expect(f.effects).toEqual(["mcp-write", "jira-write", "jira-read"]);
});
it.each(["jira", "mcp"] as const)(
  "stops both sources when %s scope changes while disclosure is pending",
  async (source) => {
    const f = fixture();
    const pending = send(f);
    void pending.catch(() => undefined);
    const grant = await pendingRead(f, "mcp-chat-read");
    if (source === "mcp") {
      const settings = f.deps.mcpSettings;
      if (settings === undefined) throw new Error("Missing MCP settings");
      settings.update(
        { expectedRevision: settings.read(CORRELATION).revision, servers: [], secrets: {} },
        CORRELATION,
      );
    } else {
      const chat = f.deps.store.findChatById(f.chatId);
      if (chat === undefined) throw new Error("Missing Chat");
      const update = context({
        jiraPodId: null,
        expectedGroundingScopeIdentity: deriveChatGroundingScopeIdentity(chat),
      });
      update.url.searchParams.set("id", f.chatId);
      expect((await handleUpdateChat(update, f.deps)).status).toBe(200);
    }
    await pending;
    expect(f.effects).toEqual([]);
    expect(
      (
        await handleDecideChatReadConsent(
          context(
            { decision: "approve", disclosureVersion: grant.disclosureVersion },
            { approvalId: grant.grantId },
          ),
          f.deps,
        )
      ).status,
    ).not.toBe(200);
  },
);
it("shares the physical tool limit across alternating Jira and MCP calls", async () => {
  const f = fixture({ repeat: true, batchSize: DEFAULT_LIMITS.maxToolCalls });
  const pending = send(f);
  void pending.catch(() => undefined);
  await approveRead(f, "mcp-chat-read");
  await approveRead(f, "jira-chat-read");
  await pending;
  expect(f.effects).toHaveLength(DEFAULT_LIMITS.maxToolCalls);
  expect(new Set(f.effects)).toEqual(new Set(["mcp-read", "jira-read"]));
  expect(f.calls).toHaveLength(2);
});
it("keeps the prompt allowance shared when source execution changes", async () => {
  const f = fixture({ repeat: true, promptTokens: 60_000 });
  const pending = send(f);
  void pending.catch(() => undefined);
  await approveRead(f, "mcp-chat-read");
  await approveRead(f, "jira-chat-read");
  await pending;
  expect(f.effects).toEqual(["mcp-read", "jira-read"]);
  expect(f.calls).toHaveLength(2);
});
