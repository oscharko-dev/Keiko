import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Gateway,
  createDefaultChatCapability,
  createGatewayToolCatalogBridge,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
  type GatewayCallRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { updateCapsuleState } from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { JiraHumanInputView } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ExternalMcpConnection } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import type {
  AtlassianCredentialMetadata,
  AtlassianHttpBodyPort,
} from "@oscharko-dev/keiko-connectors";
import type { ChatMessage } from "./store/index.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { handleSendDesktopChat } from "./chat-handlers.js";
import { handleUpdateChat } from "./store-handlers.js";
import { deriveChatGroundingScopeIdentity } from "./store/chat-grounding-scope-identity.js";
import { mockRequest, mockResponse } from "./_support.js";
import type { RouteContext } from "./routes.js";
import { jiraChatActorDigest } from "./atlassian/jiraPodAccess.js";
import { handleDecideChatWriteApproval } from "./atlassian/chatWriteApprovalRoutes.js";
import { installMcpChatCatalogRuntime } from "./mcp/mcpChatCatalogRuntime.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { conversationForGateway } from "./conversation-gateway.js";
import { jiraOperationContracts, jiraOperationForTool } from "./atlassian/jiraManagedProvider.js";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { NO_LOCAL_VAULT_KEYCHAIN } from "@oscharko-dev/keiko-security/secret-vault";
import { buildAtlassianConnectorCredentialDeps } from "./atlassian/wiring.js";
import { createAtlassianCredentialMetadataStore } from "./atlassian/credentialMetadataStore.js";
import {
  handleSubmitJiraHumanInput,
  handleGetJiraHumanInput,
  handleCancelJiraHumanInput,
} from "./atlassian/jiraHumanInputRoutes.js";
import { jiraOperationActionDigest } from "./atlassian/jiraOperationRegistry.js";
import * as requirementBinding from "./atlassian/jiraChatRequirementBinding.js";
import { openKnowledgeStoreForDeps } from "./local-knowledge-store-open.js";
import { specification } from "./_requirementSupport.js";
import { createGatewayAtlassianHttpBodyPort } from "./atlassian/httpPort.js";
import {
  syntheticJira,
  SYNTHETIC_JIRA_BASE_URL,
} from "../../../tests/support/jira-synthetic-draft-remote.js";

const MODEL = "synthetic-combined-chat";
const POD = "d5f5681e-ce98-4c3c-b27e-51d707c9d018";
const CORRELATION = "combined-chat-proof";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});
interface Options {
  readonly demandDiscovery?: boolean;
  readonly jiraAction?: {
    readonly canonicalId: "keiko.jira.draft" | "keiko.jira.attach" | "keiko.jira.update.myself";
    readonly arguments: () => Record<string, unknown>;
  };
  readonly reasoningHistory?: "required-with-tools" | undefined;
  /** A scripted single-tool conversation: the tool to call in model round `round`, if any. */
  readonly steps?: (
    round: number,
  ) => { canonicalId: string; args: Record<string, unknown> } | undefined;
  readonly write?: boolean;
  readonly repeat?: boolean;
  readonly batchSize?: number;
  readonly promptTokens?: number;
  readonly beforeMcpWriteResult?: () => Promise<void>;
  readonly budget?: NonNullable<UiHandlerDeps["chatToolTurnBudget"]>;
  /** Leave the Chat without an explicit mode, so it resolves the default (Full access). */
  readonly defaultMode?: boolean;
}
// A narrow composed envelope budget keeps the shared-bound pins exact and fast (#4175).
const NARROW_BUDGET = {
  maxRuntimeMs: 300_000,
  maxToolCalls: 30,
  maxPromptTokens: 100_000,
  maxPatchBytes: 0,
} as const;
function context(body: Record<string, unknown>, params: Record<string, string> = {}): RouteContext {
  return {
    req: mockRequest({ body: JSON.stringify(body) }),
    res: mockResponse().res,
    params,
    url: new URL("http://127.0.0.1/api/desktop/chat"),
    correlationId: CORRELATION,
  };
}
function configure(deps: UiHandlerDeps, reasoningHistory?: "required-with-tools"): void {
  const provider = {
    modelId: MODEL,
    baseUrl: "https://model.example.invalid/v1",
    apiKey: "synthetic-unused",
    timeoutMs: 5000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    reasoningHistory,
  };
  deps.gatewayConfig?.set(
    parseGatewayConfig({
      providers: [provider],
      capabilities: [
        {
          ...createDefaultChatCapability(MODEL),
          contextWindow: 32768,
          ...(reasoningHistory === undefined
            ? {}
            : { contextWindow: 128_000, maxOutputTokens: 4_096 }),
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
function discoveryResponse(
  request: GatewayCallRequest,
  options: Options,
  round: number,
  response: NormalizedResponse,
): NormalizedResponse | undefined {
  if (options.demandDiscovery !== true || round !== 1) return undefined;
  const bridge = createGatewayToolCatalogBridge({ ...request, stream: false }, Date.now);
  return {
    ...response,
    content: "",
    finishReason: "tool_calls",
    toolCalls: [
      bridge.bind({
        id: "select-projects",
        name: "jira_describe",
        arguments: { identities: ["GET /rest/api/2/project"] },
      }),
    ],
  };
}

function modelFinished(options: Options, round: number): boolean {
  return options.repeat !== true && round > (options.demandDiscovery === true ? 2 : 1);
}
function settledResponse(
  request: GatewayCallRequest,
  round: number,
  promptTokens: number,
): NormalizedResponse {
  const admission = request.attemptAdmission?.({ promptTokens, maxOutputTokens: 100 });
  const response: NormalizedResponse = {
    modelId: MODEL,
    content: "Both source observations are available.",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    reasoning: "Inspect both configured sources.",
    usage: {
      requestId: `request-${String(round)}`,
      promptTokens,
      completionTokens: 10,
      latencyMs: 1,
      costClass: "low",
    },
  };
  admission?.settle(response.usage, true, "observed");
  return response;
}
function model(calls: GatewayCallRequest[], options: Options): ModelPort {
  const promptTokens = options.promptTokens ?? 100;
  const batchSize = options.batchSize ?? 2;
  return {
    call: (request): Promise<NormalizedResponse> => {
      calls.push(request);
      const response = settledResponse(request, calls.length, promptTokens);
      if (options.steps !== undefined)
        return Promise.resolve(
          scriptedStep(request, response, options.steps(calls.length), calls.length),
        );
      if (modelFinished(options, calls.length)) return Promise.resolve(response);
      if (request.toolCatalog?.kind !== "bound") throw new Error("Expected shared bound catalog");
      const discovery = discoveryResponse(request, options, calls.length, response);
      if (discovery !== undefined) return Promise.resolve(discovery);
      const jira = request.toolCatalog.projection.tools.find(
        (entry) =>
          entry.toolRef.canonicalId ===
          (options.jiraAction?.canonicalId ??
            (options.write === true ? "keiko.jira.comment" : "keiko.jira.projects")),
      );
      const mcp = request.toolCatalog.projection.tools.find((entry) =>
        entry.alias.includes(options.write === true ? "create_note" : "get_status"),
      );
      if (jira === undefined || mcp === undefined) throw new Error("Both sources must be offered");
      const bridge = createGatewayToolCatalogBridge({ ...request, stream: false }, Date.now);
      return Promise.resolve({
        ...response,
        content: options.reasoningHistory === undefined ? "" : "Inspecting both sources.",
        finishReason: "tool_calls",
        toolCalls: Array.from({ length: batchSize }, (_, index) => {
          const external = index % 2 === 0;
          return bridge.bind({
            id: `call-${String(calls.length)}-${String(index)}`,
            name: (external ? mcp : jira).alias,
            arguments:
              !external && options.jiraAction !== undefined
                ? options.jiraAction.arguments()
                : options.write === true
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
function scriptedStep(
  request: GatewayCallRequest,
  response: NormalizedResponse,
  step: { canonicalId: string; args: Record<string, unknown> } | undefined,
  round: number,
): NormalizedResponse {
  if (step === undefined) return response;
  if (request.toolCatalog?.kind !== "bound") throw new Error("Expected shared bound catalog");
  const tool = request.toolCatalog.projection.tools.find(
    (entry) => entry.toolRef.canonicalId === step.canonicalId,
  );
  if (tool === undefined) throw new Error(`Missing offered ${step.canonicalId}`);
  const bridge = createGatewayToolCatalogBridge({ ...request, stream: false }, Date.now);
  return {
    ...response,
    content: "",
    finishReason: "tool_calls",
    toolCalls: [
      bridge.bind({ id: `step-${String(round)}`, name: tool.alias, arguments: step.args }),
    ],
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
  /** Grant ids the server accepted itself, in order; no human ever decides a read grant. */
  readonly acceptedReadGrants: string[];
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
  const deps = installMcpChatCatalogRuntime(
    Object.assign(base, {
      mcpConnections: connections,
      ...(options.budget === undefined ? {} : { chatToolTurnBudget: options.budget }),
    }),
    {
      primary: createBufferedServerLogSink(),
      diagnostics: { record: (): void => undefined },
    },
  );
  cleanup.push(async () => {
    await deps.dispose?.();
    rmSync(root, { recursive: true, force: true });
  });
  configure(deps, options.reasoningHistory);
  preselectKnownFixtureTools(deps, options);
  deps.store.createProject(root);
  const chat = deps.store.createChat(root, "Synthetic combined", MODEL);
  deps.store.updateChat(
    chat.id,
    options.defaultMode === true
      ? { jiraPodId: POD }
      : { jiraPodId: POD, toolMode: "governed-assist" },
    { verifiedJiraPod: { podId: POD, authenticationGeneration: 1 } },
  );
  const acceptedReadGrants: string[] = [];
  const registry = deps.atlassianActionApprovalRegistry;
  if (registry === undefined) throw new Error("Missing approval registry");
  const accept = registry.acceptChatReadGrant.bind(registry);
  vi.spyOn(registry, "acceptChatReadGrant").mockImplementation((grantId, ...rest) => {
    acceptedReadGrants.push(grantId);
    return accept(grantId, ...rest);
  });
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
  return { deps, chatId: chat.id, root, calls, effects, acceptedReadGrants };
}
function preselectKnownFixtureTools(deps: UiHandlerDeps, options: Options): void {
  if (options.demandDiscovery === true) return;
  const catalog = deps.jiraChatCatalog;
  if (catalog === undefined) throw new TypeError("Missing Jira catalog");
  vi.spyOn(catalog, "get").mockImplementation(() =>
    catalog.select(
      jiraOperationContracts()
        .filter(
          (entry) =>
            options.jiraAction === undefined ||
            entry.declaration.descriptor.toolRef.canonicalId === options.jiraAction.canonicalId,
        )
        .map((entry) => entry.binding.identity),
    ),
  );
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
function acceptedReadGrants(f: Fixture): readonly { kind: string; state: string }[] {
  return f.acceptedReadGrants.map((grantId) => {
    const grant = f.deps.atlassianActionApprovalRegistry?.getChatReadGrant(grantId)?.grant;
    if (grant === undefined) throw new Error("Missing accepted read grant");
    return { kind: grant.kind, state: grant.state };
  });
}
async function pendingWrite(
  f: Fixture,
  kind: ChatToolWriteApprovalView["kind"],
): Promise<ChatToolWriteApprovalView> {
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
  return approval;
}
async function approveWrite(f: Fixture, kind: ChatToolWriteApprovalView["kind"]): Promise<void> {
  const approval = await pendingWrite(f, kind);
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

const PRIVATE_PROFILE = {
  key: "private-actor-key",
  name: "Native Private Actor",
  displayName: "Original private actor",
  active: false,
} as const;
const PRIVATE_PASSWORD = "synthetic-human-only-profile-password";

function privateProfileFixture(defaultMode: boolean, unchanged = false) {
  const displayName = unchanged ? PRIVATE_PROFILE.displayName : "Reviewed private actor";
  const argumentsValue = {
    expectedActorKey: PRIVATE_PROFILE.key,
    expectedUser: PRIVATE_PROFILE,
    displayName,
  };
  const f = fixture({
    defaultMode,
    jiraAction: {
      canonicalId: "keiko.jira.update.myself",
      arguments: () => argumentsValue,
    },
  });
  const configPath = join(f.root, "private-credentials.json");
  const requests: { method: string; path: string }[] = [];
  let observedName: string = PRIVATE_PROFILE.displayName;
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(url)).pathname;
    requests.push({ method, path });
    if (path !== "/rest/api/2/myself") throw new TypeError("Unexpected private profile route");
    if (method === "GET") return Response.json({ ...PRIVATE_PROFILE, displayName: observedName });
    if (method !== "PUT") throw new TypeError("Unexpected private profile method");
    expect(JSON.parse(String(init?.body))).toEqual({ displayName, password: PRIVATE_PASSWORD });
    observedName = displayName;
    return new Response(null, { status: 204 });
  });
  const credentials = buildAtlassianConnectorCredentialDeps({
    configPath,
    env: { KEIKO_STATE_DIR: f.root },
    egress: () => undefined,
    keychainAccess: NO_LOCAL_VAULT_KEYCHAIN,
    fetchImpl,
  });
  const existing = f.deps.atlassianConnectorCredentials;
  const principal = jiraChatActorDigest(f.deps);
  if (existing === undefined || principal === undefined)
    throw new TypeError("Missing Jira composition");
  Object.assign(existing, credentials);
  const created = credentials.custody.create(
    {
      provider: "jira",
      deployment: "data-center",
      authScheme: "bearer-pat",
      displayName: "Synthetic private Jira",
      baseUrl: "https://jira.example.invalid",
      apiToken: "synthetic-private-profile-pat",
      livePodCreationRequestId: "61188dd4-2703-4279-9c02-7828eccf6325",
    },
    principal,
  );
  const verification = credentials.custody.beginVerification(created.authRef);
  if (
    created.deployment !== "data-center" ||
    created.livePod === undefined ||
    verification === undefined
  )
    throw new TypeError("Missing private Pod");
  createAtlassianCredentialMetadataStore({ configPath }).bindTargetAdmission(created, {
    baseUrl: created.baseUrl,
    addressClass: "public",
  });
  credentials.custody.finishVerification(
    created.authRef,
    created.generation,
    verification.revision,
    "ok",
  );
  f.deps.store.updateChat(
    f.chatId,
    { jiraPodId: created.livePod.podId },
    {
      verifiedJiraPod: {
        podId: created.livePod.podId,
        authenticationGeneration: created.generation,
      },
    },
  );
  return { ...f, argumentsValue, requests };
}

function privateProfileExchange(f: Fixture): ChatToolExchange | undefined {
  return f.deps.store
    .listMessages(f.chatId)[0]
    ?.toolTranscript?.exchanges.find((exchange) => exchange.call.name === "jira_update_myself");
}

async function pendingPrivateInput(f: Fixture): Promise<JiraHumanInputView> {
  await vi.waitFor(() => {
    expect(privateProfileExchange(f)?.humanInput?.state).toBe("awaiting-input");
  });
  const view = privateProfileExchange(f)?.humanInput;
  if (view === undefined) throw new TypeError("Missing private input request");
  return view;
}

function submitPrivateProfileInput(f: Fixture, view: JiraHumanInputView) {
  return handleSubmitJiraHumanInput(
    context(
      {
        expectedRevision: view.revision,
        values: { password: PRIVATE_PASSWORD },
      },
      { requestId: view.requestId },
    ),
    f.deps,
  );
}

it.each([false, true])(
  "binds private input and journal revision through a mixed Chat (allowed=%s)",
  async (defaultMode) => {
    const f = privateProfileFixture(defaultMode);
    const pending = send(f);
    void pending.catch(() => undefined);
    const input = await pendingPrivateInput(f);
    expect(f.effects).toEqual(["mcp-read"]);
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
    expect(privateProfileExchange(f)?.approval).toBeUndefined();
    expect(privateProfileExchange(f)?.result).toBeUndefined();
    expect(privateProfileExchange(f)?.mutationOutcome).toBeUndefined();
    expect((await submitPrivateProfileInput(f, input)).status).toBe(200);
    if (!defaultMode) await approveWrite(f, "jira-chat-write");
    expect((await pending).status).toBe(200);
    const exchange = privateProfileExchange(f);
    const message = f.deps.store.listMessages(f.chatId)[0];
    const contract = jiraOperationForTool("jira.update-myself");
    if (exchange?.humanInput === undefined || message === undefined || contract === undefined)
      throw new TypeError("Missing retained private exchange");
    expect(exchange.humanInput.state).toBe("consumed");
    expect(exchange.humanInput.revision).not.toBe(input.revision);
    expect(exchange).toMatchObject({
      mutationOutcome: "succeeded",
      result: { status: "completed" },
    });
    const invocationId = sha256Hex(
      canonicalise({ messageId: message.id, callId: exchange.call.id }),
    );
    const argumentsDigest = sha256Hex(canonicalise(f.argumentsValue));
    const digest = jiraOperationActionDigest(
      "jira.update-myself",
      argumentsDigest,
      contract.binding,
      undefined,
      exchange.humanInput.revision,
    );
    expect(f.deps.store.chatToolMutations?.find(invocationId)).toMatchObject({
      actionDigest: digest,
      phase: "settled",
      outcome: "succeeded",
    });
    expect(digest).not.toBe(
      jiraOperationActionDigest("jira.update-myself", argumentsDigest, contract.binding),
    );
    if (defaultMode) expect(exchange.approval).toBeUndefined();
    else expect(exchange.approval?.actionDigest).toBe(digest);
    expect(f.requests.filter((request) => request.method === "PUT")).toEqual([
      { method: "PUT", path: "/rest/api/2/myself" },
    ]);
    expect(
      JSON.stringify({ messages: f.deps.store.listMessages(f.chatId), modelCalls: f.calls }),
    ).not.toContain(PRIVATE_PASSWORD);
    expect((await send(f)).status).toBe(200);
    expect(f.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
    expect((await submitPrivateProfileInput(f, exchange.humanInput)).status).not.toBe(200);
  },
);

it("keeps an exact profile no-op free of private input in the mixed Chat", async () => {
  const f = privateProfileFixture(true, true);
  expect((await send(f)).status).toBe(200);
  expect(f.effects).toEqual(["mcp-read"]);
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  expect(privateProfileExchange(f)?.humanInput).toBeUndefined();
  expect(privateProfileExchange(f)?.mutationOutcome).toBe("not-dispatched");
});

it("rejects mixed-Chat private input after the bound Jira scope is revoked", async () => {
  const f = privateProfileFixture(true);
  const pending = send(f);
  void pending.catch(() => undefined);
  const input = await pendingPrivateInput(f);
  const chat = f.deps.store.findChatById(f.chatId);
  if (chat === undefined) throw new TypeError("Missing mixed Chat");
  const update = context({
    jiraPodId: null,
    expectedGroundingScopeIdentity: deriveChatGroundingScopeIdentity(chat),
  });
  update.url.searchParams.set("id", f.chatId);
  expect((await handleUpdateChat(update, f.deps)).status).toBe(200);
  await pending;
  expect((await submitPrivateProfileInput(f, input)).status).not.toBe(200);
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  expect(JSON.stringify(f.deps.store.listMessages(f.chatId))).not.toContain(PRIVATE_PASSWORD);
});

it("clears ready private input after a pre-dispatch mixed-Chat revocation and permits owner cleanup after the turn", async () => {
  const f = privateProfileFixture(false);
  const pending = send(f);
  void pending.catch(() => undefined);
  const input = await pendingPrivateInput(f);
  expect((await submitPrivateProfileInput(f, input)).status).toBe(200);
  await vi.waitFor(() => {
    expect(privateProfileExchange(f)?.approval).toBeDefined();
  });
  const inputs = f.deps.atlassianConnectorCredentials?.custody.humanInputs;
  if (inputs === undefined) throw new TypeError("Missing input custody");
  const cancel = vi.spyOn(inputs, "cancel");
  const chat = f.deps.store.findChatById(f.chatId);
  if (chat === undefined) throw new TypeError("Missing mixed Chat");
  const update = context({
    jiraPodId: null,
    expectedGroundingScopeIdentity: deriveChatGroundingScopeIdentity(chat),
  });
  update.url.searchParams.set("id", f.chatId);
  expect((await handleUpdateChat(update, f.deps)).status).toBe(200);
  await pending;
  expect(cancel).toHaveBeenCalledWith(
    input.requestId,
    expect.objectContaining({ operation: "jira.update-myself" }),
  );
  const cleanup = await handleCancelJiraHumanInput(
    context({}, { requestId: input.requestId }),
    f.deps,
  );
  expect(cleanup).toMatchObject({ status: 200, body: { state: "cancelled" } });
  expect((await submitPrivateProfileInput(f, input)).status).not.toBe(200);
  const principal = f.deps.serverPrincipal;
  Object.assign(f.deps, { serverPrincipal: () => "different-ended-input-owner" });
  try {
    expect(
      (await handleCancelJiraHumanInput(context({}, { requestId: input.requestId }), f.deps))
        .status,
    ).toBe(404);
  } finally {
    Object.assign(f.deps, { serverPrincipal: principal });
  }
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  expect(JSON.stringify({ cleanup, messages: f.deps.store.listMessages(f.chatId) })).not.toContain(
    PRIVATE_PASSWORD,
  );
});

it("keeps protected input metadata private from a different local principal", async () => {
  const f = privateProfileFixture(true);
  const pending = send(f);
  void pending.catch(() => undefined);
  const input = await pendingPrivateInput(f);
  const originalPrincipal = f.deps.serverPrincipal;
  Object.assign(f.deps, { serverPrincipal: () => "different-private-input-owner" });
  try {
    const inspect = await handleGetJiraHumanInput(
      context({}, { requestId: input.requestId }),
      f.deps,
    );
    expect(inspect.status).toBe(404);
    const submit = await submitPrivateProfileInput(f, input);
    expect(submit.status).toBe(404);
    expect(JSON.stringify({ inspect, submit })).not.toContain(PRIVATE_PASSWORD);
  } finally {
    Object.assign(f.deps, { serverPrincipal: originalPrincipal });
  }
  await handleCancelJiraHumanInput(context({}, { requestId: input.requestId }), f.deps);
  await pending;
  expect(f.requests.every((request) => request.method === "GET")).toBe(true);
});
it("refuses a stale protected revision without replacing the held input", async () => {
  const f = privateProfileFixture(true);
  const pending = send(f);
  void pending.catch(() => undefined);
  const input = await pendingPrivateInput(f);
  expect(
    (
      await submitPrivateProfileInput(f, {
        ...input,
        revision: "87654321-1234-4123-8123-123456789abc",
      })
    ).status,
  ).toBe(409);
  expect(privateProfileExchange(f)?.humanInput).toEqual(input);
  expect((await submitPrivateProfileInput(f, input)).status).toBe(200);
  await pending;
  expect(f.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  expect(JSON.stringify(f.deps.store.listMessages(f.chatId))).not.toContain(PRIVATE_PASSWORD);
});
it("rechecks the bound Pod after awaiting a delayed protected-input body", async () => {
  const f = privateProfileFixture(true);
  const pending = send(f);
  void pending.catch(() => undefined);
  const input = await pendingPrivateInput(f);
  const stream = new PassThrough();
  const request = handleSubmitJiraHumanInput(
    {
      ...context({}, { requestId: input.requestId }),
      req: stream as unknown as IncomingMessage,
    },
    f.deps,
  );
  expect(stream.listenerCount("data")).toBe(1);
  const chat = f.deps.store.findChatById(f.chatId);
  if (chat === undefined) throw new TypeError("Missing delayed private-input Chat");
  const update = context({
    jiraPodId: null,
    expectedGroundingScopeIdentity: deriveChatGroundingScopeIdentity(chat),
  });
  update.url.searchParams.set("id", f.chatId);
  expect((await handleUpdateChat(update, f.deps)).status).toBe(200);
  stream.end(
    JSON.stringify({ expectedRevision: input.revision, values: { password: PRIVATE_PASSWORD } }),
  );
  expect((await request).status).toBe(409);
  await pending;
  expect(f.requests.every((item) => item.method === "GET")).toBe(true);
  expect(JSON.stringify(f.deps.store.listMessages(f.chatId))).not.toContain(PRIVATE_PASSWORD);
});

async function expectFirstMutationAwaitingResult(f: Fixture): Promise<void> {
  await vi.waitFor(() => {
    expect(f.effects).toEqual(["mcp-write"]);
  });
  const blocked = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript;
  // The remote effect has started, but its result/receipt/journal settlement is still pending.
  // The second source must not even publish a call or request its read grant/action approval yet.
  expect(blocked?.exchanges.map((exchange) => exchange.call.id)).toEqual(["call-1-0"]);
  expect(blocked?.exchanges[0]?.result).toBeUndefined();
  expect(blocked?.readGrants?.map(({ kind, state }) => ({ kind, state }))).toEqual([
    { kind: "mcp-chat-read", state: "granted" },
  ]);
  expect(acceptedReadGrants(f).map(({ kind }) => kind)).toEqual(["mcp-chat-read-grant"]);
  expect(f.calls).toHaveLength(1);
}
it("offers both sources through one ordinary Chat handler and grants each first read without a decision", async () => {
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
  expect((await pending).status).toBe(200);
  expect(f.effects).toEqual(["mcp-read", "jira-read"]);
  const transcript = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript;
  // The connection is the consent: each grant is recorded granted and nothing waited for a human.
  expect(transcript?.readGrants?.map(({ kind, state }) => ({ kind, state }))).toEqual([
    { kind: "mcp-chat-read", state: "granted" },
    { kind: "jira-chat-read", state: "granted" },
  ]);
  expect(acceptedReadGrants(f)).toEqual([
    { kind: "mcp-chat-read-grant", state: "granted" },
    { kind: "jira-chat-read-grant", state: "granted" },
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
it("keeps external MCP tools available while Jira typed schemas are selected between rounds", async () => {
  const f = fixture({ demandDiscovery: true });
  expect((await send(f)).status).toBe(200);
  expect(f.effects).toEqual(["mcp-read", "jira-read"]);
  expect(f.calls).toHaveLength(3);
  const first = f.calls[0]?.toolCatalog;
  const second = f.calls[1]?.toolCatalog;
  if (first?.kind !== "bound" || second?.kind !== "bound")
    throw new TypeError("Expected round catalogs");
  expect(first.projection.tools.map((tool) => tool.alias)).not.toContain("jira_projects");
  expect(second.projection.tools.map((tool) => tool.alias)).toContain("jira_projects");
  expect(
    second.projection.tools
      .filter((tool) => tool.alias.startsWith("mcp_"))
      .map((tool) => tool.alias),
  ).toEqual(
    first.projection.tools
      .filter((tool) => tool.alias.startsWith("mcp_"))
      .map((tool) => tool.alias),
  );
});
it("resolves Full access for a Chat without a mode and runs both writes without an approval", async () => {
  const f = fixture({ write: true, defaultMode: true });
  expect(f.deps.store.findChatById(f.chatId)?.toolMode).toBe("autonomous-delivery");
  expect((await send(f)).status).toBe(200);
  expect(f.effects).toEqual(["mcp-write", "jira-write", "jira-read"]);
  const transcript = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript;
  expect(transcript?.readGrants?.every((grant) => grant.state === "granted")).toBe(true);
  expect(transcript?.exchanges.map((exchange) => exchange.approval?.state)).not.toContain(
    "pending",
  );
  expect(transcript?.exchanges.map((exchange) => exchange.mutationOutcome)).toEqual([
    "succeeded",
    "succeeded",
  ]);
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
    await approveWrite(f, "mcp-chat-write");
    await expectFirstMutationAwaitingResult(f);
  } finally {
    releaseFirst();
  }
  await vi.waitFor(() => {
    expect(f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]).toMatchObject({
      mutationOutcome: "succeeded",
      result: { status: "completed" },
    });
  });
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
  "stops both sources when %s scope changes while a write approval is pending",
  async (source) => {
    const f = fixture({ write: true });
    const pending = send(f);
    void pending.catch(() => undefined);
    const approval = await pendingWrite(f, "mcp-chat-write");
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
        await handleDecideChatWriteApproval(
          context(
            { decision: "approve", actionDigest: approval.actionDigest },
            { approvalId: approval.approvalId },
          ),
          f.deps,
        )
      ).status,
    ).not.toBe(200);
  },
);
it("shares the envelope's physical tool limit across alternating Jira and MCP calls", async () => {
  const f = fixture({ repeat: true, batchSize: NARROW_BUDGET.maxToolCalls, budget: NARROW_BUDGET });
  const pending = send(f);
  void pending.catch(() => undefined);
  await pending;
  expect(f.effects).toHaveLength(NARROW_BUDGET.maxToolCalls);
  expect(new Set(f.effects)).toEqual(new Set(["mcp-read", "jira-read"]));
  // No further model round is requested once the shared tool-call budget is spent.
  expect(f.calls).toHaveLength(1);
});
it("keeps the prompt allowance shared when source execution changes", async () => {
  const f = fixture({ repeat: true, promptTokens: 60_000, budget: NARROW_BUDGET });
  const pending = send(f);
  void pending.catch(() => undefined);
  await pending;
  expect(f.effects).toEqual(["mcp-read", "jira-read"]);
  expect(f.calls).toHaveLength(2);
});

it("preserves complete parallel assistant exchanges through real Gateway and reloaded Chat history", async () => {
  const f = fixture({ reasoningHistory: "required-with-tools" });
  const config = f.deps.gatewayConfig?.current();
  if (config === undefined) throw new TypeError("Missing gateway fixture config");
  const upstream = model(f.calls, { reasoningHistory: "required-with-tools" });
  const gateway = new Gateway(config, {
    adapter: {
      call: (request): Promise<NormalizedResponse> =>
        upstream.call(
          { ...request, attemptAdmission: undefined },
          request.cancellationSignal ?? new AbortController().signal,
        ),
    },
  });
  const qualified = {
    ...f,
    deps: {
      ...f.deps,
      modelPortFactory: (): ModelPort => ({
        call: (request): Promise<NormalizedResponse> => gateway.chat(request),
      }),
    },
  };
  expect((await send(qualified)).status).toBe(200);
  const completed = f.calls[1]?.messages.find(
    (message) => message.role === "assistant" && message.toolCalls !== undefined,
  );
  expect(completed).toMatchObject({
    content: "Inspecting both sources.",
    reasoningContent: "Inspect both configured sources.",
  });
  expect(completed?.toolCalls).toHaveLength(2);
  const first = f.calls[0];
  if (first === undefined) throw new TypeError("Missing initial Chat call");
  await expect(
    gateway.chat({
      ...first,
      attemptAdmission: undefined,
      messages: [
        ...conversationForGateway(f.deps.store.listMessages(f.chatId)),
        { role: "user", content: "Continue inspecting." },
      ],
    }),
  ).resolves.toMatchObject({ content: "Both source observations are available." });
  expect(
    f.calls[2]?.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.reasoningContent),
  ).toEqual(["Inspect both configured sources.", "Inspect both configured sources."]);
  expect(JSON.stringify(f.deps.store.listMessages(f.chatId))).not.toContain(
    "Inspect both configured sources.",
  );
});

// The public combined source path must retain Jira's existing review owners (#4173/4176/4178).
// No test imports another test module, and the external MCP fixture remains the same real binder.
describe("combined Jira review admission parity", () => {
  function turnExchanges(f: Fixture): readonly ChatToolExchange[] {
    return (
      f.deps.store.listMessages(f.chatId).find((message) => message.toolTranscript !== undefined)
        ?.toolTranscript?.exchanges ?? []
    );
  }
  function jiraExchange(f: Fixture): ChatToolExchange | undefined {
    return f.deps.store
      .listMessages(f.chatId)[0]
      ?.toolTranscript?.exchanges.find(
        (exchange) => exchange.call.name === "jira_draft" || exchange.call.name === "jira_attach",
      );
  }
  async function observedJiraExchange(f: Fixture): Promise<ChatToolExchange> {
    await vi.waitFor(
      () => {
        const exchange = jiraExchange(f);
        expect(exchange?.approval ?? exchange?.result).toBeDefined();
      },
      { timeout: 5_000, interval: 10 },
    );
    const exchange = jiraExchange(f);
    if (exchange === undefined) throw new TypeError("Missing observed Jira exchange");
    return exchange;
  }
  async function settlePendingJira(f: Fixture, pending: ReturnType<typeof send>): Promise<void> {
    let terminal = false;
    void pending.then(
      () => {
        terminal = true;
      },
      () => {
        terminal = true;
      },
    );
    // A broken guard may publish an approval after a held metadata request resumes. Observe that
    // transition too, rather than sampling once and hanging on an unapproved human decision.
    await vi.waitFor(
      () => {
        expect(terminal || jiraExchange(f)?.approval?.state === "pending").toBe(true);
      },
      { timeout: 5_000, interval: 10 },
    );
    const approval = jiraExchange(f)?.approval;
    if (approval?.state === "pending")
      await handleDecideChatWriteApproval(
        context(
          { decision: "reject", actionDigest: approval.actionDigest },
          {
            approvalId: approval.approvalId,
          },
        ),
        f.deps,
      );
    await vi.waitFor(
      () => {
        expect(terminal).toBe(true);
      },
      { timeout: 5_000, interval: 10 },
    );
    await pending.catch(() => undefined);
  }
  function useDraftRemote(f: Fixture): ReturnType<typeof syntheticJira> {
    const jira = syntheticJira();
    const credentials = f.deps.atlassianConnectorCredentials;
    if (credentials === undefined) throw new TypeError("Missing credential owner");
    vi.mocked(credentials.httpBodyPortFactory).mockImplementation(
      (_metadata, correlationId, lifecycle) =>
        createGatewayAtlassianHttpBodyPort({
          ...lifecycle,
          correlationId,
          baseUrl: SYNTHETIC_JIRA_BASE_URL,
          authRef: "synthetic-ref",
          credentials: {
            resolveForExecution: () => ({ scheme: "bearer-pat", apiToken: "synthetic-test-pat" }),
          },
          fetchImpl: jira.fetch,
        }),
    );
    return jira;
  }
  async function connectRequirementSource(f: Fixture): Promise<void> {
    const session = openKnowledgeStoreForDeps(f.deps);
    try {
      const pod = await seedCapsuleWithVectors(session.store, {
        displayName: "Reviewed requirements.md",
        text: specification(1).text,
      });
      updateCapsuleState(session.store, pod.capsuleId, "ready");
      const chat = f.deps.store.findChatById(f.chatId);
      if (chat === undefined) throw new TypeError("Missing combined-source Chat");
      const selected = await handleUpdateChat(
        {
          ...context({
            localKnowledgeScopes: [{ kind: "capsule", capsuleId: pod.capsuleId, connectedAtMs: 1 }],
            expectedGroundingScopeIdentity: deriveChatGroundingScopeIdentity(chat),
          }),
          url: new URL(`http://127.0.0.1/api/chats?id=${encodeURIComponent(f.chatId)}`),
        },
        f.deps,
      );
      expect(selected.status).toBe(200);
    } finally {
      session.close();
    }
  }
  function changeRequirementSource(f: Fixture): void {
    const session = openKnowledgeStoreForDeps(f.deps);
    try {
      session.store._internal.db
        .prepare("UPDATE documents SET safe_display_name = ?")
        .run("Changed requirements.md");
      session.store._internal.db
        .prepare("UPDATE capsules SET updated_at = updated_at + 1000")
        .run();
    } finally {
      session.close();
    }
  }
  it.each([false, true])(
    "preserves the selected requirement source and item guard in the mixed draft path (drift=%s)",
    async (drift) => {
      const checkedRefs: (string | undefined)[] = [];
      const createPreparation = requirementBinding.createJiraChatSourcePreparation;
      vi.spyOn(requirementBinding, "createJiraChatSourcePreparation").mockImplementation(
        (options) => {
          const source = createPreparation(options);
          return {
            ...source,
            current: (prepared, itemRef) => {
              checkedRefs.push(itemRef);
              return source.current(prepared, itemRef);
            },
          };
        },
      );
      const f = fixture({
        jiraAction: {
          canonicalId: "keiko.jira.draft",
          arguments: () => ({
            items: [
              {
                ref: "traced-story",
                projectId: "10000",
                issueTypeId: "10001",
                fields: {
                  summary: "Traced Story",
                  description: {
                    format: "markdown",
                    text: "## Criteria\n- Thema 1 ist verfügbar.\n- Fehler zu Thema 1 werden gemeldet.",
                  },
                },
                requirementIds: ["LH-001"],
              },
            ],
          }),
        },
      });
      const jira = useDraftRemote(f);
      await connectRequirementSource(f);
      const pending = send(f);
      void pending.catch(() => undefined);
      try {
        const approval = (await observedJiraExchange(f)).approval;
        if (approval === undefined) throw new TypeError("Missing source-bound draft approval");
        expect(jira.posts()).toEqual([]);
        if (drift) changeRequirementSource(f);
        const decision = await handleDecideChatWriteApproval(
          context(
            {
              decision: "approve",
              actionDigest: approval.actionDigest,
            },
            { approvalId: approval.approvalId },
          ),
          f.deps,
        );
        expect(decision.status).toBe(200);
        expect((await pending).status).toBe(200);
        expect(f.effects).toEqual(["mcp-read"]);
        if (drift) {
          expect(jira.posts()).toEqual([]);
          expect(jiraExchange(f)?.mutationOutcome).not.toBe("succeeded");
          expect(jiraExchange(f)?.result?.status).not.toBe("completed");
        } else {
          expect(checkedRefs).toContain("traced-story");
          expect(jira.posts()).toHaveLength(1);
          expect(jira.issues[0]?.fields.description).toContain("Keiko traceability");
          expect(jira.issues[0]?.fields.description).toContain("LH-001");
          expect(jiraExchange(f)).toMatchObject({
            mutationOutcome: "succeeded",
            result: { status: "completed", data: { createdCount: 1, failedCount: 0 } },
          });
        }
      } finally {
        await settlePendingJira(f, pending);
      }
    },
  );
  it("refuses an invalid saved template before any combined-path Jira write approval", async () => {
    const f = fixture({
      jiraAction: {
        canonicalId: "keiko.jira.draft",
        arguments: () => ({
          items: [
            {
              ref: "story",
              projectId: "10000",
              issueTypeId: "10001",
              fields: { summary: "Reviewed Story", description: "## Context\nKnown context." },
            },
          ],
        }),
      },
    });
    const jira = useDraftRemote(f);
    const markdown = [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "issueType: Story",
      "activateOn: [create]",
      "requiredFields: [Description]",
      "---",
      "# Story template",
      "## Context",
      "## Acceptance criteria",
    ].join("\n");
    f.deps.store.markdownSkills.import({
      fileName: "combined-story-template.md",
      contentBase64: Buffer.from(markdown).toString("base64"),
    });
    expect(f.deps.store.markdownSkills.jiraTemplates()).toHaveLength(1);
    const pending = send(f);
    void pending.catch(() => undefined);
    try {
      const exchange = await observedJiraExchange(f);
      expect(exchange.approval).toBeUndefined();
      const violations: unknown = expect.arrayContaining([
        expect.objectContaining({
          ruleId: "section-missing",
          subject: "Acceptance criteria",
          template: "SYN/Story",
        }),
      ]);
      expect(exchange.result?.data).toMatchObject({
        outcome: "rejected",
        items: [
          {
            ref: "story",
            violations,
          },
        ],
      });
      expect((await pending).status).toBe(200);
      expect(jira.posts()).toEqual([]);
      expect(f.effects).toEqual(["mcp-read"]);
    } finally {
      await settlePendingJira(f, pending);
    }
  });
  it("presents the connected file's name, size and digest in a combined-path Jira attachment approval", async () => {
    const body = "Synthetic reviewed attachment.";
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "keiko-combined-attachment-")));
    cleanup.push(() => {
      rmSync(folder, { recursive: true, force: true });
      return Promise.resolve();
    });
    mkdirSync(join(folder, "docs"));
    writeFileSync(join(folder, "docs", "report.txt"), body);
    let connect = (): void => undefined;
    const f = fixture({
      jiraAction: {
        canonicalId: "keiko.jira.attach",
        arguments: () => {
          connect();
          return {
            issueKey: "KEIKO-1",
            source: { kind: "connected-file", path: "docs/report.txt" },
          };
        },
      },
    });
    connect = (): void => {
      f.deps.store.updateChat(f.chatId, {
        connectedScopes: [
          { kind: "workspace-root", root: folder, relativePaths: [], connectedAtMs: 1 },
        ],
      });
    };
    const credentials = f.deps.atlassianConnectorCredentials;
    if (credentials === undefined) throw new TypeError("Missing credential owner");
    vi.mocked(credentials.httpBodyPortFactory).mockImplementation(
      (_metadata, _correlation, lifecycle) =>
        (request): ReturnType<AtlassianHttpBodyPort> => {
          if (lifecycle?.beforeDispatch?.(request) !== true)
            throw new TypeError("Expected actual attachment read admission");
          if (request.method !== "GET") throw new TypeError("Rejected preview must never upload");
          const response = JSON.stringify(
            new URL(request.url).pathname.endsWith("/attachment/meta")
              ? { enabled: true, uploadLimit: 1e6 }
              : { id: "10001", key: "KEIKO-1", fields: { attachment: [] } },
          );
          lifecycle.onResponse?.(request, 200);
          return Promise.resolve({
            kind: "response",
            status: 200,
            bodyText: response,
            bodyBytes: Buffer.byteLength(response),
            truncated: false,
          });
        },
    );
    const pending = send(f);
    void pending.catch(() => undefined);
    try {
      const exchange = await observedJiraExchange(f);
      expect(exchange.approval).toMatchObject({
        kind: "jira-chat-write",
        operation: "jira.attach",
        state: "pending",
        attachment: {
          name: "report.txt",
          sizeBytes: Buffer.byteLength(body),
          sha256: sha256Hex(body),
        },
      });
      expect(exchange.result).toBeUndefined();
      expect(JSON.stringify(exchange.call.arguments)).not.toContain(body);
      expect(f.effects).toEqual(["mcp-read"]);
    } finally {
      await settlePendingJira(f, pending);
    }
    expect(jiraExchange(f)?.approval?.state).toBe("rejected");
  });
  it("refuses the held attachment metadata read after the configured MCP source generation is revoked", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "keiko-combined-revoked-attachment-")));
    cleanup.push(() => {
      rmSync(folder, { recursive: true, force: true });
      return Promise.resolve();
    });
    mkdirSync(join(folder, "docs"));
    writeFileSync(join(folder, "docs", "report.txt"), "Synthetic attachment.");
    let connect = (): void => undefined;
    const f = fixture({
      jiraAction: {
        canonicalId: "keiko.jira.attach",
        arguments: () => {
          connect();
          return {
            issueKey: "KEIKO-1",
            source: { kind: "connected-file", path: "docs/report.txt" },
          };
        },
      },
    });
    connect = (): void => {
      f.deps.store.updateChat(f.chatId, {
        connectedScopes: [
          { kind: "workspace-root", root: folder, relativePaths: [], connectedAtMs: 1 },
        ],
      });
    };
    const credentials = f.deps.atlassianConnectorCredentials;
    const settings = f.deps.mcpSettings;
    if (credentials === undefined || settings === undefined)
      throw new TypeError("Missing source owners");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let limitRequested = false;
    let dispatched = 0;
    const admissions: boolean[] = [];
    vi.mocked(credentials.httpBodyPortFactory).mockImplementation(
      (_metadata, _correlation, lifecycle) =>
        async (request): ReturnType<AtlassianHttpBodyPort> => {
          if (request.method !== "GET") throw new TypeError("Revoked source must never upload");
          limitRequested = true;
          await held;
          const admitted = lifecycle?.beforeDispatch?.(request) === true;
          admissions.push(admitted);
          if (!admitted) return { kind: "network-error" };
          dispatched++;
          const response = JSON.stringify({ enabled: true, uploadLimit: 1e6 });
          lifecycle.onResponse?.(request, 200);
          return {
            kind: "response",
            status: 200,
            bodyText: response,
            bodyBytes: Buffer.byteLength(response),
            truncated: false,
          };
        },
    );
    const pending = send(f);
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => {
        expect(limitRequested).toBe(true);
      });
      expect(jiraExchange(f)?.approval).toBeUndefined();
      const snapshot = settings.read(CORRELATION);
      settings.update(
        { expectedRevision: snapshot.revision, servers: [], secrets: {} },
        CORRELATION,
      );
      release();
      await settlePendingJira(f, pending);
      expect(admissions).toEqual([false]);
      expect(dispatched).toBe(0);
      expect(jiraExchange(f)?.approval).toBeUndefined();
      expect(f.effects).toEqual(["mcp-read"]);
    } finally {
      release();
      await settlePendingJira(f, pending);
    }
  });
  it("retains stored draft refs and applies the human's dependent-item deselection on the combined path", async () => {
    let reference: Record<string, unknown> = {};
    const f = fixture({
      jiraAction: { canonicalId: "keiko.jira.draft", arguments: () => reference },
    });
    const jira = useDraftRemote(f);
    const staged = f.deps.jiraDraftStore?.append(f.chatId, undefined, "combined-fingerprint", [
      { ref: "epic", projectId: "10000", issueTypeId: "10001", fields: { summary: "Epic" } },
      {
        ref: "child",
        projectId: "10000",
        issueTypeId: "10001",
        fields: { summary: "Child" },
        parent: { fieldId: "parent", ref: "epic" },
      },
      { ref: "loose", projectId: "10000", issueTypeId: "10001", fields: { summary: "Loose" } },
    ]);
    if (staged?.ok !== true) throw new TypeError("Expected an actual stored draft");
    reference = { draftId: staged.draft.id, draftDigest: staged.draft.digest };
    const pending = send(f);
    void pending.catch(() => undefined);
    try {
      const exchange = await observedJiraExchange(f);
      const approval = exchange.approval;
      expect(approval).toMatchObject({
        kind: "jira-chat-write",
        operation: "jira.draft",
        state: "pending",
      });
      if (approval === undefined) throw new TypeError("Missing draft approval");
      expect(exchange.call.arguments).toEqual(reference);
      expect(
        f.deps.atlassianActionApprovalRegistry?.getChatWriteApproval(approval.approvalId),
      ).toMatchObject({ draftItemRefs: ["epic", "child", "loose"] });
      expect(jira.posts()).toEqual([]);
      const decision = await handleDecideChatWriteApproval(
        context(
          { decision: "approve", actionDigest: approval.actionDigest, excludedItemRefs: ["epic"] },
          {
            approvalId: approval.approvalId,
          },
        ),
        f.deps,
      );
      expect(decision.status).toBe(200);
      expect((await pending).status).toBe(200);
      expect(jira.posts().map((post) => post.fields)).toMatchObject([{ summary: "Loose" }]);
      expect(jira.issues).toHaveLength(1);
      expect(jiraExchange(f)).toMatchObject({
        mutationOutcome: "succeeded",
        approval: { state: "claimed", excludedItemRefs: ["epic"] },
        result: { status: "completed", data: { excludedCount: 2, createdCount: 1 } },
      });
      expect(f.effects).toEqual(["mcp-read"]);
    } finally {
      await settlePendingJira(f, pending);
    }
  });

  it("names the active citation sources of a staged draft on the combined Jira, MCP and Knowledge route (F7)", async () => {
    const stagedItem = (description: string): Record<string, unknown> => ({
      ref: "epic",
      projectId: "10000",
      issueTypeId: "10001",
      fields: { summary: "Epic", description },
    });
    const reference = (f: Fixture): Record<string, unknown> => {
      const staged = turnExchanges(f).find((exchange) => exchange.call.name === "jira_draft_stage");
      const data = staged?.result?.status === "completed" ? staged.result.data : undefined;
      const { draftId, draftDigest } = (data ?? {}) as Record<string, string | undefined>;
      return { draftId, draftDigest };
    };
    const holder: { fixture?: Fixture } = {};
    const f = fixture({
      steps: (round) => {
        if (round === 1)
          return {
            canonicalId: "keiko.jira.draft.stage",
            args: { items: [stagedItem("Goal [1].")] },
          };
        return round === 2 && holder.fixture !== undefined
          ? { canonicalId: "keiko.jira.draft", args: reference(holder.fixture) }
          : undefined;
      },
    });
    holder.fixture = f;
    const jira = useDraftRemote(f);
    f.deps.store.createMessage({
      chatId: f.chatId,
      role: "assistant",
      content: "Goal [1].",
      timestamp: 1,
      groundedAnswer: {
        groundingKind: "local-knowledge",
        citations: [{ marker: "[1]", label: "Spec A.pdf · page 2" }],
      } as unknown as NonNullable<ChatMessage["groundedAnswer"]>,
    } as Parameters<typeof f.deps.store.createMessage>[0]);
    const pending = send(f);
    void pending.catch(() => undefined);
    try {
      const approval = await vi.waitFor(
        () => {
          const pendingApproval = turnExchanges(f).find(
            (exchange) => exchange.call.name === "jira_draft",
          )?.approval;
          expect(pendingApproval?.state).toBe("pending");
          return pendingApproval;
        },
        { timeout: 8_000, interval: 10 },
      );
      if (approval === undefined) throw new TypeError("Missing draft approval");
      const stored = f.deps.jiraDraftStore?.peek(String(reference(f).draftId), f.chatId);
      expect(JSON.stringify(stored)).toContain("Goal (Spec A.pdf · page 2).");
      expect(JSON.stringify(stored)).not.toContain("Goal [1]");
      expect(stored?.digest).toBe(reference(f).draftDigest);
      expect(jira.posts()).toEqual([]);
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
      expect((await pending).status).toBe(200);
      expect(jira.posts().map((post) => post.fields)).toMatchObject([
        { description: "Goal (Spec A.pdf · page 2)." },
      ]);
    } finally {
      await settlePendingJira(f, pending);
    }
  });
});
