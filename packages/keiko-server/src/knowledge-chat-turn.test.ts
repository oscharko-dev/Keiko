import {
  createGroundedSynthesisCallBudget,
  createGroundedSynthesisAttemptAdmission,
} from "./grounded-answer.js";
import {
  callGroundedSynthesisModel,
  callPluralGroundedSynthesis,
} from "./grounded-plural-synthesis.js";
import { conversationForGateway, usableGatewayTurns } from "./conversation-gateway.js";
import {
  captureConversationReadinessAdmission,
  withConversationReadinessAdmission,
  ConversationModelNotReadyError,
} from "./conversation-readiness-admission.js";
import { realpathSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { EditorAgentGovernedAuthorityReference } from "@oscharko-dev/keiko-contracts";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import type { ExternalMcpConnection } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { installMcpChatCatalogRuntime } from "./mcp/mcpChatCatalogRuntime.js";
import { reserveCurrentKnowledgeChatAuthority } from "./knowledge-chat-authority.js";
import {
  knowledgeDocumentSnapshot,
  knowledgeDocumentScope,
  knowledgeDocumentRevision,
} from "./knowledge-document-source.js";
import {
  createDefaultChatCapability,
  findConfiguredCapability,
  CallerAttemptAdmissionError,
  ProviderError,
  createGatewayToolCatalogBridge,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
  type GatewayCallRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { podFixture, specification, type PodFixture } from "./_requirementSupport.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { createChatToolTurn } from "./chat-tool-runtime.js";
import { CatalogDispatchFault } from "./tool-catalog/catalogToolErrors.js";
import { installKnowledgeChatCatalogRuntime } from "./knowledge-chat-catalog.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { chatConnectorTools } from "./chat-context-connectors.js";
import {
  deriveContextProfile,
  deriveContextProfileFromCapability,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";

import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});
const MODEL = "knowledge-only-model";
function configure(
  deps: UiHandlerDeps,
  maxOutputTokens = 1024,
  contextWindow = 4096,
  toolCalling = true,
): void {
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
          maxOutputTokens,
          contextWindow,
          toolCalling,
          ...(toolCalling
            ? {
                toolCallingVerification: {
                  status: "verified",
                  checkedAt: new Date().toISOString(),
                  probe: "gateway-tool-calling-v1",
                  configurationFingerprint: toolCallingConfigurationFingerprint(provider),
                },
              }
            : {}),
        },
      ],
    }),
    true,
  );
}
async function fixture(
  documentCount = 1,
  maxOutputTokens = 1024,
  contextWindow = 4096,
): Promise<{ pod: PodFixture; deps: UiHandlerDeps }> {
  const pod = await podFixture(
    Array.from({ length: documentCount }, (_, index) => ({
      capsuleId: index === 0 ? "knowledge-chat-pod" : `knowledge-chat-pod-${String(index)}`,
      text: specification(3).text,
    })),
  );
  const runtimeDir = realpathSync(pod.runtimeDir);
  const base = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: `${runtimeDir}/evidence`,
    uiDbPath: `${runtimeDir}/runtime-ui.db`,
    env: { KEIKO_STATE_DIR: runtimeDir },
  });
  const deps = installKnowledgeChatCatalogRuntime(Object.assign(base, pod.deps), {
    primary: createBufferedServerLogSink(),
    diagnostics: { record: () => undefined },
  });
  configure(deps, maxOutputTokens, contextWindow);
  cleanup.push(async () => {
    await deps.dispose?.();
    pod.cleanup();
  });
  return { pod, deps };
}
function model(
  calls: GatewayCallRequest[],
  toolName: string,
  args: Record<string, string>,
): ModelPort {
  return {
    call: (request): Promise<NormalizedResponse> => {
      calls.push(request);
      const admission = request.attemptAdmission?.({ promptTokens: 100, maxOutputTokens: 100 });
      const response: NormalizedResponse = {
        modelId: MODEL,
        content: "Observed the Knowledge Pod documents.",
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: `knowledge-response-${String(calls.length)}`,
          promptTokens: 100,
          completionTokens: 10,
          latencyMs: 1,
          costClass: "low",
        },
      };
      admission?.settle(response.usage, true, "observed");
      if (calls.length > 1) return Promise.resolve(response);
      if (request.toolCatalog?.kind !== "bound") throw new Error("Expected real bound MCP catalog");
      const entry = request.toolCatalog.projection.tools.find(
        (tool) => tool.toolRef.canonicalId === `keiko.${toolName}`,
      );
      if (entry === undefined) throw new Error("Expected Knowledge tool");
      const bridge = createGatewayToolCatalogBridge({ ...request, stream: false }, Date.now);
      return Promise.resolve({
        ...response,
        content: "",
        finishReason: "tool_calls",
        toolCalls: [bridge.bind({ id: "knowledge-call", name: entry.alias, arguments: args })],
      });
    },
  };
}
function assertRuntimeContext(
  request: GatewayCallRequest | undefined,
  history: Parameters<typeof usableGatewayTurns>[0],
  human: GatewayCallRequest["messages"][number],
  original: string,
): void {
  expect(request?.messages.filter((message) => message.role === "user").at(-1)).toEqual(human);
  const projection = usableGatewayTurns(history)[0]?.content;
  expect(projection).toContain('"role":"tool"');
  expect(projection).toContain("knowledge-chat-pod.md");
  expect(
    conversationForGateway(history)
      .filter((message) => message.role === "user")
      .at(-1)?.content,
  ).toBe(original);
}

it("does not admit a Knowledge tool turn when no catalog is available", async () => {
  const { pod, deps } = await fixture();
  configure(deps, 1024, 4096, false);
  const { knowledgeChatCatalog, ...withoutCatalog } = deps;
  expect(knowledgeChatCatalog).toBeDefined();
  expect(deps.store.findChatById(pod.chatId)?.localKnowledgeScopes).toHaveLength(1);
  const accepted = deps.store.admitChatTurn("knowledge-no-catalog", {
    chatId: pod.chatId,
    role: "user",
    content: "Read the attached document",
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (accepted.kind !== "admitted") throw new TypeError("Expected accepted human turn");
  const factory = vi.fn(() => undefined);
  const turn = await createChatToolTurn(
    { ...withoutCatalog, modelPortFactory: factory },
    MODEL,
    accepted.userMessage,
    new AbortController().signal,
    "knowledge-no-catalog",
  );
  expect(turn).toBeUndefined();
  expect(factory).not.toHaveBeenCalled();
});

it("refuses connected Knowledge-only tools with an accurate service-neutral message when tool calling is unavailable", async () => {
  const { pod, deps } = await fixture();
  configure(deps, 1024, 4096, false);
  const chat = deps.store.findChatById(pod.chatId);
  expect(chat?.jiraPodBinding).toBeUndefined();
  expect(chat?.localKnowledgeScopes).toHaveLength(1);
  const accepted = deps.store.admitChatTurn("knowledge-no-tools", {
    chatId: pod.chatId,
    role: "user",
    content: "Read the attached document",
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (accepted.kind !== "admitted") throw new TypeError("Expected accepted human turn");
  const factory = vi.fn(() => undefined);
  Object.assign(deps, { modelPortFactory: factory });
  const refused = createChatToolTurn(
    deps,
    MODEL,
    accepted.userMessage,
    new AbortController().signal,
    "knowledge-no-tool-calling",
  );
  await expect(refused).rejects.toBeInstanceOf(ConversationModelNotReadyError);
  await expect(refused).rejects.toMatchObject({
    requiredCapability: "tool-calling",
    message: "The selected model cannot use the connected tools. Choose a model with tool calling.",
  });
  expect(factory).not.toHaveBeenCalled();
});

it.each([
  { tool: "knowledge.requirements", args: {} },
  { tool: "knowledge.documents", args: { view: "inventory" } },
])("executes $tool through the real MCP catalog in a Pod-only Chat", async ({ tool, args }) => {
  const { pod, deps } = await fixture();
  const accepted = deps.store.admitChatTurn(`human-${tool}`, {
    chatId: pod.chatId,
    role: "user",
    content: "Read the attached documents",
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (accepted.kind !== "admitted") throw new Error("Expected human turn");
  const calls: GatewayCallRequest[] = [];
  const turn = await createChatToolTurn(
    deps,
    MODEL,
    accepted.userMessage,
    new AbortController().signal,
    "knowledge-mcp-proof",
  );
  if (turn === undefined) throw new Error("Expected Knowledge-only turn");
  const humanMessage = {
    role: "user" as const,
    content: "Read the documents",
    contentParts: [
      { type: "image_url" as const, image_url: { url: "data:image/png;base64,AAAA" } },
    ],
  };
  const response = await turn.call(
    turn.meter(model(calls, tool, args)),
    { modelId: MODEL, messages: [humanMessage] },
    new AbortController().signal,
  );
  assertRuntimeContext(
    calls[0],
    deps.store.listMessages(pod.chatId),
    humanMessage,
    accepted.userMessage.content,
  );
  expect(response.content).toBe("Observed the Knowledge Pod documents.");
  expect(calls).toHaveLength(2);
  const transcript = deps.store.findMessageById(accepted.userMessage.id)?.toolTranscript;
  expect(transcript?.exchanges[0]?.result?.status).toBe("completed");
  expect(
    calls[1]?.messages.some(
      (message) => message.role === "tool" && message.content.includes("succeeded"),
    ),
  ).toBe(true);
  expect(deps.store.findChatById(pod.chatId)?.jiraPodBinding).toBeUndefined();
  expect(transcript?.readGrant).toBeUndefined();
});
it("sends the runtime inventory as the same prompt prefix in consecutive turns", async () => {
  const { pod, deps } = await fixture();
  const runtimePrefix = async (key: string): Promise<GatewayCallRequest["messages"]> => {
    const accepted = deps.store.admitChatTurn(key, {
      chatId: pod.chatId,
      role: "user",
      content: "Read the attached documents",
      timestamp: Date.now(),
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    if (accepted.kind !== "admitted") throw new Error("Expected human turn");
    const calls: GatewayCallRequest[] = [];
    const turn = await createChatToolTurn(
      deps,
      MODEL,
      accepted.userMessage,
      new AbortController().signal,
      `knowledge-prefix-${key}`,
    );
    if (turn === undefined) throw new Error("Expected Knowledge-only turn");
    await turn.call(
      turn.meter(model(calls, "knowledge.documents", { view: "inventory" })),
      { modelId: MODEL, messages: [{ role: "user", content: "Read the documents" }] },
      new AbortController().signal,
    );
    const messages = calls[0]?.messages ?? [];
    // Everything before the human message: instruction plus the runtime inventory pair.
    return messages.slice(
      0,
      messages.findIndex((message) => message.role === "user"),
    );
  };
  const first = await runtimePrefix("prefix-first");
  const second = await runtimePrefix("prefix-second");
  expect(first.some((message) => message.role === "tool")).toBe(true);
  expect(second).toEqual(first);
});
it("accounts for Knowledge tool definitions without admitting a host", async () => {
  const { pod, deps } = await fixture();
  const profile = deriveContextProfile({
    maxInputTokens: 32_000,
    reservedOutputTokens: 2000,
    safetyMarginTokens: 1000,
  });
  const tools = chatConnectorTools(
    deps,
    deps.store.findChatById(pod.chatId),
    profile.tokenAccounting,
    "knowledge-context-proof",
  );
  expect(tools.connectors).toEqual([
    { kind: "knowledge", toolCount: 3, tokens: expect.any(Number) as number },
  ]);
  expect(tools.tokens).toBeGreaterThan(0);
});

function requiredReviewOwners(deps: UiHandlerDeps): {
  readonly settings: NonNullable<UiHandlerDeps["mcpSettings"]>;
  readonly registry: NonNullable<UiHandlerDeps["agentAuthorityRegistry"]>;
} {
  const settings = deps.mcpSettings;
  const registry = deps.agentAuthorityRegistry;
  if (settings === undefined || registry === undefined) throw new Error("Expected source owners");
  return { settings, registry };
}
function rotateBeforeReview(deps: UiHandlerDeps, rotate: boolean, round: number): void {
  if (!rotate || round !== 2) return;
  const holder = deps.gatewayConfig;
  if (holder === undefined) throw new Error("Expected gateway configuration");
  vi.spyOn(holder, "generation").mockReturnValue(holder.generation() + 1);
}

function reviewAttempt(
  request: GatewayCallRequest,
): ReturnType<NonNullable<GatewayCallRequest["attemptAdmission"]>> {
  const admission = request.attemptAdmission?.({ promptTokens: 100, maxOutputTokens: 100 });
  if (request.attemptAdmission !== undefined && admission === undefined)
    throw new CallerAttemptAdmissionError("Fixture caller grant exhausted before dispatch");
  expect(admission?.maxOutputTokens).toBe(25);
  return admission;
}
function expectReviewFits(
  deps: UiHandlerDeps,
  request: GatewayCallRequest | undefined,
  expectedOutput = 1024,
): void {
  const config = deps.gatewayConfig?.current();
  const capability = config === undefined ? undefined : findConfiguredCapability(config, MODEL);
  if (request === undefined || capability?.kind !== "chat")
    throw new Error("Expected review capability");
  expect(request.maxOutputTokens).toBe(expectedOutput);
  const profile = deriveContextProfileFromCapability(capability);
  expect(
    countGatewayPromptTokens(request) + (request.maxOutputTokens ?? 0) + profile.safetyMarginTokens,
  ).toBeLessThanOrEqual(profile.maxInputTokens);
}
function expectRemainingReviewAuthority(
  deps: UiHandlerDeps,
  pod: PodFixture,
  reference: EditorAgentGovernedAuthorityReference | undefined,
  remaining: number,
): void {
  if (reference === undefined) throw new Error("Expected retained Knowledge authority");
  const reserve = (promptTokens: number): ReturnType<typeof reserveCurrentKnowledgeChatAuthority> =>
    reserveCurrentKnowledgeChatAuthority(
      deps,
      pod.chatId,
      reference,
      { toolCalls: 0, promptTokens, patchBytes: 0 },
      new Date().toISOString(),
      "knowledge-source-proof",
    );
  expect(reserve(remaining + 1).ok).toBe(false);
  expect(reserve(remaining).ok).toBe(true);
}

it.each([
  {
    rotate: false,
    callerCalls: 4,
    maxOutputTokens: 1024,
    contextWindow: 4096,
    expectedOutput: 1024,
  },
  {
    rotate: true,
    callerCalls: 4,
    maxOutputTokens: 1024,
    contextWindow: 4096,
    expectedOutput: 1024,
  },
  {
    rotate: false,
    callerCalls: 2,
    maxOutputTokens: 1024,
    contextWindow: 4096,
    expectedOutput: 1024,
  },
  {
    rotate: false,
    callerCalls: 4,
    maxOutputTokens: 16_384,
    contextWindow: 131_072,
    expectedOutput: 8192,
  },
])(
  "shares review admission with external MCP tools (rotated: $rotate, caller calls: $callerCalls, output: $maxOutputTokens)",
  async ({ rotate, callerCalls, maxOutputTokens, contextWindow, expectedOutput }) => {
    const { pod, deps } = await fixture(1, maxOutputTokens, contextWindow);
    const { settings, registry } = requiredReviewOwners(deps);
    const server: McpServerDefinition = {
      name: "synthetic",
      description: "Read-only test tools",
      enabled: true,
      transport: { kind: "local", command: [process.execPath], environment: {} },
      tools: { status: "read" },
    };
    settings.update(
      {
        expectedRevision: settings.read("knowledge-source-proof").revision,
        servers: [server],
        secrets: {},
      },
      "knowledge-source-proof",
    );
    const connection: ExternalMcpConnection = {
      signal: new AbortController().signal,
      tools: [
        {
          name: "status",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
      call: () => Promise.resolve({}),
      close: () => Promise.resolve(),
    };
    Object.assign(deps, {
      chatToolTurnBudget: {
        maxRuntimeMs: 60_000,
        maxToolCalls: 10,
        maxPromptTokens: 1000,
        maxPatchBytes: 0,
      },
      mcpConnections: {
        inspect: () => [],
        connect: () => Promise.resolve(connection),
        generation: () => new AbortController().signal,
        serve: () => Promise.resolve(new Response(null, { status: 404 })),
        close: () => Promise.resolve(),
      },
    });
    installMcpChatCatalogRuntime(deps, {
      primary: createBufferedServerLogSink(),
      diagnostics: { record: () => undefined },
    });
    let references: readonly EditorAgentGovernedAuthorityReference[] = [];
    const register = registry.registerChatSources.bind(registry);
    vi.spyOn(registry, "registerChatSources").mockImplementation((...args) => {
      const result = register(...args);
      if (result.ok) references = result.authorityRefs;
      return result;
    });
    let reviewArguments: Record<string, string> = {};
    pod.withStore((store) => {
      const document = knowledgeDocumentSnapshot(deps, store, pod.chatId).documents[0];
      if (document === undefined) throw new Error("Expected source document");
      reviewArguments = {
        documentScope: knowledgeDocumentScope(document),
        revisionDigest: knowledgeDocumentRevision(document),
      };
    });
    const outer: GatewayCallRequest[] = [];
    const semantic: GatewayCallRequest[] = [];
    const testModel: ModelPort = {
      call: (request): Promise<NormalizedResponse> => {
        const admission = reviewAttempt(request);
        const response: NormalizedResponse = {
          modelId: MODEL,
          content: "Observed Knowledge review proposals.",
          finishReason: "stop",
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: "combined-review-model",
            promptTokens: 100,
            completionTokens: 10,
            latencyMs: 1,
            costClass: "low",
          },
        };
        admission?.settle(response.usage, true, "observed");
        if (request.toolCatalog?.kind !== "bound") {
          semantic.push(request);
          const review = {
            complete: true,
            findings: [
              {
                kind: "acceptance-criterion",
                anchors: [0],
                proposal: "Verify the documented processing deadline.",
                question: "",
              },
            ],
          };
          return Promise.resolve({
            ...response,
            content: JSON.stringify(review),
            structuredOutput: review,
          });
        }
        outer.push(request);
        expect(
          request.toolCatalog.projection.tools.some((tool) => tool.alias.includes("status")),
        ).toBe(true);
        if (outer.length > 2) return Promise.resolve(response);
        rotateBeforeReview(deps, rotate, outer.length);
        const toolName = outer.length === 1 ? "knowledge.documents" : "knowledge.review";
        const tool = request.toolCatalog.projection.tools.find(
          (entry) => entry.toolRef.canonicalId === `keiko.${toolName}`,
        );
        if (tool === undefined) throw new Error("Expected combined Knowledge tool");
        const bridge = createGatewayToolCatalogBridge({ ...request, stream: false }, Date.now);
        return Promise.resolve({
          ...response,
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            bridge.bind({
              id: `combined-${String(outer.length)}`,
              name: tool.alias,
              arguments: outer.length === 1 ? { view: "inventory" } : reviewArguments,
            }),
          ],
        });
      },
    };
    Object.assign(deps, { modelPortFactory: () => testModel });
    const admitted = deps.store.admitChatTurn("combined-human-turn", {
      chatId: pod.chatId,
      role: "user",
      content: "Review the attached document",
      timestamp: Date.now(),
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    if (admitted.kind !== "admitted") throw new Error("Expected turn");
    const turn = await createChatToolTurn(
      deps,
      MODEL,
      admitted.userMessage,
      new AbortController().signal,
      "knowledge-source-proof",
    );
    if (turn === undefined) throw new Error("Expected combined turn");
    deps.gatewayConfig?.recordVerifiedCapability(
      MODEL,
      { conversationReady: true },
      new Date().toISOString(),
    );
    const admittedModel = captureConversationReadinessAdmission(deps, MODEL);
    if ("status" in admittedModel) throw new Error("Expected admitted model");
    const checkedModel = withConversationReadinessAdmission(testModel, MODEL, admittedModel, deps);
    let reserved = 0;
    const callerSettlement = vi.fn(() => undefined);
    const callerAdmission = vi.fn(() => {
      if (reserved >= callerCalls) return undefined;
      reserved++;
      return { maxOutputTokens: 25, settle: callerSettlement };
    });
    const work = turn.call(
      turn.meter(checkedModel),
      {
        modelId: MODEL,
        messages: [{ role: "user", content: "Review the document" }],
        attemptAdmission: callerAdmission,
      },
      new AbortController().signal,
    );
    if (rotate) {
      await expect(work).rejects.toBeInstanceOf(ConversationModelNotReadyError);
      expect(semantic).toHaveLength(0);
      return;
    }
    if (callerCalls === 2) {
      await expect(work).rejects.toBeInstanceOf(CallerAttemptAdmissionError);
      expect(outer).toHaveLength(2);
      expect(semantic).toHaveLength(0);
      expect(callerSettlement).toHaveBeenCalledTimes(2);
      expectRemainingReviewAuthority(deps, pod, references[0], 800);
      return;
    }
    await work;
    expect(outer).toHaveLength(3);
    expect(semantic).toHaveLength(1);
    expect(callerAdmission).toHaveBeenCalledTimes(outer.length + semantic.length);
    expect(callerSettlement).toHaveBeenCalledTimes(4);
    expect(semantic[0]?.modelId).toBe(MODEL);
    expectReviewFits(deps, semantic[0], expectedOutput);
    expect(
      deps.store
        .findMessageById(admitted.userMessage.id)
        ?.toolTranscript?.exchanges.map((exchange) => exchange.result?.status),
    ).toEqual(["completed", "completed", "completed"]);
    expectRemainingReviewAuthority(deps, pod, references[0], 600);
  },
);

it.each(["call", "stream", "meter"] as const)(
  "charges the runtime inventory to a one-tool envelope before %s re-entry",
  async (entry) => {
    const { pod, deps } = await fixture();
    Object.assign(deps, {
      chatToolTurnBudget: {
        maxRuntimeMs: 60_000,
        maxToolCalls: 1,
        maxPromptTokens: 100_000,
        maxPatchBytes: 0,
      },
    });
    const accepted = deps.store.admitChatTurn("runtime-inventory-budget", {
      chatId: pod.chatId,
      role: "user",
      content: "List the selected documents",
      timestamp: Date.now(),
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    if (accepted.kind !== "admitted") throw new Error("Expected human turn");
    const turn = await createChatToolTurn(
      deps,
      MODEL,
      accepted.userMessage,
      new AbortController().signal,
      "runtime-inventory-budget",
    );
    if (turn === undefined) throw new Error("Expected Knowledge turn");
    const calls: GatewayCallRequest[] = [];
    const answer = await turn.call(
      turn.meter(model(calls, "knowledge.documents", { view: "inventory" })),
      { modelId: MODEL, messages: [{ role: "user", content: "List the selected documents" }] },
      new AbortController().signal,
    );
    expect(calls).toHaveLength(0);
    const exchanges = deps.store.findMessageById(accepted.userMessage.id)?.toolTranscript
      ?.exchanges;
    expect(exchanges).toHaveLength(1);
    expect(exchanges?.[0]).toMatchObject({
      call: { name: "knowledge_documents" },
      result: { status: "completed" },
    });
    expect(answer.content).toContain("this turn used up its tool-call or prompt budget");
    expect(answer.content).not.toContain("Source coverage:");
    expect(turn.endedEarly).toBe(true);
    if (entry === "call") {
      await expect(
        turn.call(
          turn.meter(model(calls, "knowledge.documents", { view: "inventory" })),
          { modelId: MODEL, messages: [{ role: "user", content: "Continue the ended turn" }] },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(CallerAttemptAdmissionError);
    } else if (entry === "meter") {
      const dispatched = vi.fn();
      const metered = turn.meter({
        call: (request): Promise<NormalizedResponse> => {
          const reservation = request.attemptAdmission?.({ promptTokens: 1, maxOutputTokens: 1 });
          if (reservation === undefined)
            throw new CallerAttemptAdmissionError("Synthetic ended grant refused");
          dispatched();
          throw new TypeError("An ended turn dispatched provider work");
        },
      });
      await expect(
        metered.call(
          { modelId: MODEL, messages: [{ role: "user", content: "Continue the ended turn" }] },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(CallerAttemptAdmissionError);
      expect(dispatched).not.toHaveBeenCalled();
    } else {
      const provider = vi.fn<NonNullable<ModelPort["callStream"]>>();
      const consume = async (): Promise<void> => {
        for await (const event of turn.stream(
          provider,
          { modelId: MODEL, messages: [{ role: "user", content: "Continue the ended turn" }] },
          new AbortController().signal,
        )) {
          if (event.type === "done") return;
        }
      };
      await expect(consume()).rejects.toBeInstanceOf(CallerAttemptAdmissionError);
      expect(provider).not.toHaveBeenCalled();
    }
    expect(calls).toHaveLength(0);
  },
);

function installSemanticExternalCatalog(deps: UiHandlerDeps): void {
  const { settings } = requiredReviewOwners(deps);
  settings.update(
    {
      expectedRevision: settings.read("semantic-ledger-proof").revision,
      servers: [
        {
          name: "semantic-external",
          description: "Read-only test tools",
          enabled: true,
          transport: { kind: "local", command: [process.execPath], environment: {} },
          tools: { status: "read" },
        },
      ],
      secrets: {},
    },
    "semantic-ledger-proof",
  );
  const connection: ExternalMcpConnection = {
    signal: new AbortController().signal,
    tools: [
      {
        name: "status",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
    ],
    call: () => Promise.resolve({}),
    close: () => Promise.resolve(),
  };
  Object.assign(deps, {
    mcpConnections: {
      inspect: () => [],
      connect: () => Promise.resolve(connection),
      generation: () => new AbortController().signal,
      serve: () => Promise.resolve(new Response(null, { status: 404 })),
      close: () => Promise.resolve(),
    },
  });
  installMcpChatCatalogRuntime(deps, {
    primary: createBufferedServerLogSink(),
    diagnostics: { record: () => undefined },
  });
}

it.each([
  { complete: true, external: false, failure: "none" },
  { complete: false, external: false, failure: "none" },
  { complete: true, external: true, failure: "none" },
  { complete: true, external: false, failure: "invalid" },
  { complete: true, external: false, failure: "provider" },
])(
  "keeps three semantic window attempts inside the tool envelope before final synthesis (complete: $complete, external: $external, failure: $failure)",
  async ({ complete, external, failure }) => {
    const { pod, deps } = await fixture(3);
    Object.assign(deps, {
      chatToolTurnBudget: {
        maxRuntimeMs: 60_000,
        maxToolCalls: 10,
        maxPromptTokens: 1000,
        maxPatchBytes: 0,
      },
    });
    if (external) installSemanticExternalCatalog(deps);
    const { registry } = requiredReviewOwners(deps);
    let authority: EditorAgentGovernedAuthorityReference | undefined;
    const register = registry.registerChat.bind(registry);
    vi.spyOn(registry, "registerChat").mockImplementation((...args) => {
      const result = register(...args);
      if (result.ok) authority = result.authorityRef;
      return result;
    });
    const registerSources = registry.registerChatSources.bind(registry);
    vi.spyOn(registry, "registerChatSources").mockImplementation((...args) => {
      const result = registerSources(...args);
      if (result.ok) authority = result.authorityRefs[0];
      return result;
    });
    let argumentsByDocument: Record<string, string>[] = [];
    pod.withStore((store) => {
      argumentsByDocument = knowledgeDocumentSnapshot(deps, store, pod.chatId).documents.map(
        (document) => ({
          documentScope: knowledgeDocumentScope(document),
          revisionDigest: knowledgeDocumentRevision(document),
        }),
      );
    });
    const calls: GatewayCallRequest[] = [];
    let outer = 0;
    let reviewed = 0;
    const testModel: ModelPort = {
      call: (request): Promise<NormalizedResponse> => {
        const reservation = request.attemptAdmission?.({
          promptTokens: 100,
          maxOutputTokens: 25,
        });
        if (reservation === undefined)
          throw new CallerAttemptAdmissionError("Fixture caller grant exhausted before dispatch");
        calls.push(request);
        const response: NormalizedResponse = {
          modelId: MODEL,
          content: "The reviewed source proposals are ready.",
          finishReason: "stop",
          toolCalls: [],
          structuredOutput: null,
          usage: {
            requestId: `review-${String(calls.length)}`,
            promptTokens: 100,
            completionTokens: 10,
            latencyMs: 1,
            costClass: "low",
          },
        };
        reservation.settle(response.usage, true, "observed");
        if (request.toolCatalog?.kind !== "bound") {
          reviewed++;
          if (failure !== "none" && reviewed <= 2) {
            if (failure === "provider") {
              const error = new ProviderError("Synthetic nested provider failure", 503);
              error.partialUsage = { promptTokens: 100, completionTokens: 10, streamedChars: 0 };
              return Promise.reject(error);
            }
            return Promise.resolve({ ...response, content: "Invalid structured review" });
          }
          return Promise.resolve({
            ...response,
            content: JSON.stringify({ complete, findings: [] }),
          });
        }
        const args = argumentsByDocument[outer++];
        if (args === undefined) return Promise.resolve(response);
        const entry = request.toolCatalog.projection.tools.find(
          (candidate) => candidate.toolRef.canonicalId === "keiko.knowledge.review",
        );
        if (entry === undefined) throw new Error("Expected semantic review tool");
        const bridge = createGatewayToolCatalogBridge({ ...request, stream: false }, Date.now);
        return Promise.resolve({
          ...response,
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            bridge.bind({
              id: `semantic-${String(outer)}`,
              name: entry.alias,
              arguments: args,
            }),
          ],
        });
      },
    };
    Object.assign(deps, { modelPortFactory: () => testModel });
    const accepted = deps.store.admitChatTurn("semantic-ledger-owner", {
      chatId: pod.chatId,
      role: "user",
      content: "Review the attached source documents and report proposals.",
      timestamp: Date.now(),
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    if (accepted.kind !== "admitted") throw new Error("Expected accepted turn");
    const signal = new AbortController().signal;
    const turn = await createChatToolTurn(
      deps,
      MODEL,
      accepted.userMessage,
      signal,
      "semantic-ledger-proof",
    );
    if (turn === undefined) throw new Error("Expected accepted Knowledge tool turn");
    const budget = createGroundedSynthesisCallBudget();
    const tracker = createGroundedSynthesisAttemptAdmission(budget, {
      inputTokensMax: 1000,
      outputTokensMax: 1000,
    });
    const result = await callGroundedSynthesisModel(
      turn.meter(testModel),
      {
        modelId: MODEL,
        messages: [{ role: "user", content: "Review the attached source documents" }],
        attemptAdmission: tracker.admission,
      },
      signal,
      tracker,
      turn,
    );
    expect(result.content).toContain("reviewed source proposals");
    expect(result.usage).toMatchObject({ promptTokens: 700, completionTokens: 70 });
    expect(reviewed).toBe(3);
    expect(calls).toHaveLength(7);
    expect(budget.remaining()).toBe(1);
    expect(budget.pendingUsage()).toEqual({
      promptTokens: failure === "none" ? 100 : 300,
      completionTokens: failure === "none" ? 10 : 30,
    });
    const reference = authority;
    if (reference === undefined) throw new Error("Expected accepted source authority");
    const reserve = (
      promptTokens: number,
    ): ReturnType<typeof reserveCurrentKnowledgeChatAuthority> =>
      reserveCurrentKnowledgeChatAuthority(
        deps,
        pod.chatId,
        reference,
        { toolCalls: 0, promptTokens, patchBytes: 0 },
        new Date().toISOString(),
        "semantic-ledger-proof",
      );
    expect(reserve(301).ok).toBe(false);
    expect(reserve(300).ok).toBe(true);
    // Synthesis has its own pending usage; the turn registry above accounts for every tool round.
    const pendingSynthesis = budget.pendingUsage();
    const remainingInput = 1000 - pendingSynthesis.promptTokens;
    const remainingOutput = 1000 - pendingSynthesis.completionTokens;
    expect(
      tracker.admission({ promptTokens: remainingInput + 1, maxOutputTokens: 25 }),
    ).toBeUndefined();
    const finalGrant = tracker.admission({ promptTokens: remainingInput, maxOutputTokens: 25 });
    expect(finalGrant?.maxOutputTokens).toBe(Math.min(25, remainingOutput));
    expect(tracker.admission({ promptTokens: 1, maxOutputTokens: 1 })).toBeUndefined();
    expect(budget.takeUsage()).toEqual({
      promptTokens: 700,
      completionTokens: 70,
    });
  },
);

function applyCitationRepairAdmissionState(
  deps: UiHandlerDeps,
  chatId: string,
  controller: AbortController,
  state: string,
): void {
  if (state === "authority-revoked") deps.agentAuthorityRegistry?.revokeChatAuthorities(chatId);
  if (state === "generation-changed") {
    const holder = deps.gatewayConfig;
    if (holder === undefined) throw new Error("Expected gateway configuration");
    vi.spyOn(holder, "generation").mockReturnValue(holder.generation() + 1);
  }
  if (state === "human-stop") controller.abort();
}

function assertCitationRepairToolTranscriptAbsent(deps: UiHandlerDeps, messageId: string): void {
  expect(deps.store.findMessageById(messageId)?.toolTranscript?.exchanges).toBeUndefined();
}

it.each([
  "allowed",
  "caller-refused",
  "authority-revoked",
  "generation-changed",
  "human-stop",
  "deadline",
  "unexpected-tool",
] as const)("keeps citation repair inside the existing model admission (%s)", async (state) => {
  const { pod, deps } = await fixture();
  Object.assign(deps, {
    chatToolTurnBudget: {
      maxRuntimeMs: 60_000,
      maxToolCalls: 10,
      maxPromptTokens: 100,
      maxPatchBytes: 0,
    },
  });
  const accepted = deps.store.admitChatTurn(`citation-repair-${state}`, {
    chatId: pod.chatId,
    role: "user",
    content: "Explain the source.",
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (accepted.kind !== "admitted") throw new Error("Expected accepted turn");
  const controller = new AbortController();
  const turn = await createChatToolTurn(
    deps,
    MODEL,
    accepted.userMessage,
    controller.signal,
    "citation-repair-admission",
  );
  if (turn === undefined) throw new Error("Expected Knowledge tool turn");
  const toolLoop = vi.spyOn(turn, "call");
  deps.gatewayConfig?.recordVerifiedCapability(
    MODEL,
    { conversationReady: true },
    new Date().toISOString(),
  );
  const readiness = captureConversationReadinessAdmission(deps, MODEL);
  if ("status" in readiness) throw new Error("Expected admitted model");
  const sent: GatewayCallRequest[] = [];
  const model: ModelPort = {
    call: (request): Promise<NormalizedResponse> => {
      const reservation = request.attemptAdmission?.({ promptTokens: 60, maxOutputTokens: 7 });
      if (reservation === undefined)
        throw new CallerAttemptAdmissionError("Fixture admission refused before dispatch");
      expect(reservation.maxOutputTokens).toBe(7);
      sent.push(request);
      const response: NormalizedResponse = {
        modelId: MODEL,
        content: "Feature returns true [1].",
        finishReason: "stop",
        toolCalls:
          state === "unexpected-tool"
            ? [
                {
                  id: "changed-write",
                  name: "jira_comment",
                  arguments: { body: "Changed repair comment" },
                },
              ]
            : [],
        structuredOutput: null,
        usage: {
          requestId: "repair-admission",
          promptTokens: 60,
          completionTokens: 3,
          latencyMs: 1,
          costClass: "low",
        },
      };
      reservation.settle(response.usage, true, "observed");
      return Promise.resolve(response);
    },
  };
  const checked = withConversationReadinessAdmission(turn.meter(model), MODEL, readiness, deps);
  const budget = createGroundedSynthesisCallBudget();
  applyCitationRepairAdmissionState(deps, pod.chatId, controller, state);
  const invoke = (): Promise<NormalizedResponse> =>
    callPluralGroundedSynthesis({
      purpose: "citation-repair",
      deps: { ...deps, chatToolTurn: turn },
      evidenceCount: 1,
      model: checked,
      signal: controller.signal,
      budget,
      grants: {
        inputTokensMax: state === "caller-refused" ? 1 : 1000,
        outputTokensMax: 7,
        ...(state === "deadline" ? { deadlineAtMs: Date.now() - 1 } : {}),
      },
      accounting: undefined,
      request: {
        modelId: MODEL,
        messages: [{ role: "user", content: "Insert citation markers only." }],
        maxOutputTokens: 7,
      },
    });
  if (state === "allowed") {
    await invoke();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.toolCatalog).toBeUndefined();
    expect(budget.pendingUsage()).toEqual({ promptTokens: 60, completionTokens: 3 });
    // The same turn has only forty prompt tokens left; repair cannot acquire a fresh envelope.
    await expect(invoke()).rejects.toBeInstanceOf(CallerAttemptAdmissionError);
    expect(sent).toHaveLength(1);
  } else {
    await expect(invoke()).rejects.toThrow();
    expect(sent).toHaveLength(state === "unexpected-tool" ? 1 : 0);
    if (state === "unexpected-tool")
      expect(budget.pendingUsage()).toEqual({ promptTokens: 60, completionTokens: 3 });
  }
  expect(toolLoop).not.toHaveBeenCalled();
  assertCitationRepairToolTranscriptAbsent(deps, accepted.userMessage.id);
});

async function inventoryAdmissionFixture(): Promise<{
  readonly pod: PodFixture;
  readonly deps: UiHandlerDeps;
  readonly turn: NonNullable<Awaited<ReturnType<typeof createChatToolTurn>>>;
  readonly calls: GatewayCallRequest[];
  readonly request: GatewayCallRequest;
  readonly accepted: Extract<
    ReturnType<UiHandlerDeps["store"]["admitChatTurn"]>,
    { readonly kind: "admitted" }
  >;
}> {
  const { pod, deps } = await fixture();
  const accepted = deps.store.admitChatTurn("inventory-admission", {
    chatId: pod.chatId,
    role: "user",
    content: "Read the selected sources",
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (accepted.kind !== "admitted") throw new TypeError("Expected accepted human turn");
  const turn = await createChatToolTurn(
    deps,
    MODEL,
    accepted.userMessage,
    new AbortController().signal,
    "inventory-admission",
  );
  if (turn === undefined) throw new TypeError("Expected Knowledge turn");
  const calls: GatewayCallRequest[] = [];
  const request = {
    modelId: MODEL,
    messages: [{ role: "user" as const, content: accepted.userMessage.content }],
  };
  return { pod, deps, turn, calls, request, accepted };
}

it("does not retain rejected inventory preparation across a safe turn re-entry", async () => {
  const f = await inventoryAdmissionFixture();
  const failed = new TypeError("Synthetic pre-dispatch persistence failure");
  vi.spyOn(f.deps.store, "updateChatToolTranscript").mockImplementationOnce(() => {
    throw failed;
  });
  const admittedModel = f.turn.meter(model(f.calls, "knowledge.documents", { view: "inventory" }));
  await expect(f.turn.call(admittedModel, f.request, new AbortController().signal)).rejects.toBe(
    failed,
  );
  expect(f.calls).toHaveLength(0);
  const answer = await f.turn.call(admittedModel, f.request, new AbortController().signal);
  expect(answer.content).toContain("Observed the Knowledge Pod");
  expect(f.calls).toHaveLength(2);
});

it.each(["cancelled", "deadline", "capability-changed"] as const)(
  "refuses runtime inventory before dispatch when %s",
  async (state) => {
    const f = await inventoryAdmissionFixture();
    const controller = new AbortController();
    if (state === "cancelled") controller.abort();
    if (state === "deadline") vi.spyOn(Date, "now").mockReturnValue(f.turn.deadlineAtMs);
    if (state === "capability-changed") configure(f.deps, 1024, 4096, false);
    await expect(
      f.turn.call(
        f.turn.meter(model(f.calls, "knowledge.documents", { view: "inventory" })),
        f.request,
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(CatalogDispatchFault);
    expect(f.calls).toHaveLength(0);
    expect(f.deps.store.findMessageById(f.accepted.userMessage.id)?.toolTranscript).toBeUndefined();
  },
);

it("does not register source authority when catalog preparation fails", async () => {
  const { pod, deps } = await fixture();
  const accepted = deps.store.admitChatTurn("catalog-before-authority", {
    chatId: pod.chatId,
    role: "user",
    content: "Read documents",
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (
    accepted.kind !== "admitted" ||
    deps.knowledgeChatCatalog === undefined ||
    deps.agentAuthorityRegistry === undefined
  )
    throw new TypeError("Expected Knowledge owners");
  const register = vi.spyOn(deps.agentAuthorityRegistry, "registerChat");
  const failure = new TypeError("Synthetic catalog preparation failure");
  vi.spyOn(deps.knowledgeChatCatalog, "get").mockRejectedValueOnce(failure);
  await expect(
    createChatToolTurn(
      deps,
      MODEL,
      accepted.userMessage,
      new AbortController().signal,
      "catalog-before-authority",
    ),
  ).rejects.toBe(failure);
  expect(register).not.toHaveBeenCalled();
});
