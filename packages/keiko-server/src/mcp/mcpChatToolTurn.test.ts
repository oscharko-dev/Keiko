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
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { ExternalMcpConnection } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { buildUiHandlerDeps, type UiHandlerDeps } from "../deps.js";
import { handleRegenerateDesktopChat, handleSendDesktopChat } from "../chat-handlers.js";
import { mockRequest, mockResponse } from "../_support.js";
import type { RouteContext } from "../routes.js";
import { handleDecideChatReadConsent } from "../atlassian/chatReadConsentRoutes.js";
import { handleDecideChatWriteApproval } from "../atlassian/chatWriteApprovalRoutes.js";
import { installJiraChatCatalogRuntime } from "../atlassian/jiraChatCatalogRuntime.js";
import { installMcpChatCatalogRuntime } from "./mcpChatCatalogRuntime.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});
const MODEL = "synthetic-mcp-chat";
function context(body: Record<string, unknown>, params: Record<string, string> = {}): RouteContext {
  return {
    req: mockRequest({ body: JSON.stringify(body) }),
    res: mockResponse().res,
    params,
    url: new URL("http://127.0.0.1/api/desktop/chat"),
    correlationId: "mcp-chat-test",
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
function model(calls: GatewayCallRequest[], write: boolean): ModelPort {
  return {
    call: (request): Promise<NormalizedResponse> => {
      calls.push(request);
      const admission = request.attemptAdmission?.({ promptTokens: 100, maxOutputTokens: 100 });
      const response: NormalizedResponse = {
        modelId: MODEL,
        content: "Observed MCP result.",
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "synthetic-response",
          promptTokens: 100,
          completionTokens: 10,
          latencyMs: 1,
          costClass: "low",
        },
      };
      admission?.settle(response.usage, true, "observed");
      if (calls.length > 1) return Promise.resolve(response);
      if (request.toolCatalog?.kind !== "bound") throw new Error("Expected real bound MCP catalog");
      const tool = request.toolCatalog.projection.tools.find((entry) =>
        entry.alias.includes(write ? "create_note" : "get_status"),
      );
      if (tool === undefined) throw new Error("Expected discovered MCP tool");
      const bridge = createGatewayToolCatalogBridge({ ...request, stream: false }, Date.now);
      return Promise.resolve({
        ...response,
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          bridge.bind({
            id: "mcp-call-1",
            name: tool.alias,
            arguments: write ? { text: "synthetic note" } : {},
          }),
        ],
      });
    },
  };
}
function fixture(
  write = false,
  responseLoss = false,
): {
  deps: UiHandlerDeps;
  root: string;
  chatId: string;
  calls: GatewayCallRequest[];
  effects: string[];
  server: McpServerDefinition;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-mcp-chat-")));
  const calls: GatewayCallRequest[] = [];
  const base = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui.db"),
    env: { KEIKO_STATE_DIR: root },
    modelPortFactory: () => model(calls, write),
  });
  const server: McpServerDefinition = {
    name: "synthetic",
    description: "Synthetic MCP fixture",
    enabled: true,
    transport: { kind: "local", command: [process.execPath], environment: {} },
    tools: { get_status: "read", create_note: "write" },
  };
  const settings = base.mcpSettings;
  if (settings === undefined) throw new Error("Missing MCP settings owner");
  const snapshot = settings.read("mcp-chat-test");
  settings.update(
    { expectedRevision: snapshot.revision, servers: [server], secrets: {} },
    "mcp-chat-test",
  );
  const effects: string[] = [];
  const connection: ExternalMcpConnection = {
    tools: [
      {
        name: "get_status",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
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
    call: (name, args, invocation) => {
      if (!invocation.beforeEffect()) throw new Error("Missing MCP authority");
      effects.push(name);
      if (responseLoss) return Promise.reject(new Error("Synthetic response lost after effect"));
      return Promise.resolve({
        content: [
          {
            type: "text",
            text:
              name === "get_status"
                ? "synthetic-ready"
                : typeof args.text === "string"
                  ? args.text
                  : "unexpected",
          },
        ],
      });
    },
    close: () => Promise.resolve(),
  };
  const connections: NonNullable<UiHandlerDeps["mcpConnections"]> = {
    connect: () => Promise.resolve(connection),
    generation: (definition, correlation) => settings.generation(definition, correlation),
    serve: () => Promise.resolve(new Response(null, { status: 404 })),
    close: () => Promise.resolve(),
  };
  const deps = installMcpChatCatalogRuntime(Object.assign(base, { mcpConnections: connections }), {
    primary: createBufferedServerLogSink(),
    diagnostics: { record: (): void => undefined },
  });
  expect(deps).toBe(base);
  cleanup.push(async () => {
    await deps.dispose?.();
    rmSync(root, { recursive: true, force: true });
  });
  configure(deps);
  deps.store.createProject(root);
  const chat = deps.store.createChat(root, "Synthetic MCP", MODEL);
  return { deps, root, chatId: chat.id, calls, effects, server };
}
function send(
  f: ReturnType<typeof fixture>,
  clientTurnId = "mcp-human-turn",
): ReturnType<typeof handleSendDesktopChat> {
  return handleSendDesktopChat(
    context({
      chatId: f.chatId,
      projectPath: f.root,
      modelId: MODEL,
      content: "Use the configured MCP tool",
      clientTurnId,
      memory: { enabled: false, budgetTokens: 0, mode: "governed-assist", context: {} },
    }),
    f.deps,
  );
}
async function approveRead(f: ReturnType<typeof fixture>): Promise<void> {
  await vi.waitFor(() => {
    expect(f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.readGrant?.state).toBe(
      "pending",
    );
  });
  const grant = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.readGrant;
  if (grant === undefined) throw new Error("Missing read disclosure");
  expect(grant.kind).toBe("mcp-chat-read");
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
  ).toBe(200);
}

it("runs a configured MCP read through ordinary Chat without a Pod or Coding session", async () => {
  const f = fixture();
  const pending = send(f);
  void pending.catch(() => undefined);
  await approveRead(f);
  expect((await pending).status).toBe(200);
  expect(f.effects).toEqual(["get_status"]);
  expect(
    f.calls[1]?.messages.some(
      (message) => message.role === "tool" && message.content.includes("synthetic-ready"),
    ),
  ).toBe(true);
  expect(f.deps.store.findChatById(f.chatId)?.jiraPodBinding).toBeUndefined();
  expect(f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.result?.status).toBe(
    "completed",
  );
});

it("keeps a configured mutation effect at zero until its exact approval, then journals once", async () => {
  const f = fixture(true);
  const pending = send(f);
  void pending.catch(() => undefined);
  await approveRead(f);
  await vi.waitFor(() => {
    expect(
      f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.approval?.state,
    ).toBe("pending");
  });
  const approval = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.approval;
  if (approval === undefined) throw new Error("Missing write approval");
  expect(approval.kind).toBe("mcp-chat-write");
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
  ).toBe(200);
  expect((await pending).status).toBe(200);
  expect(f.effects).toEqual(["create_note"]);
  expect(f.deps.store.chatToolMutations?.find(approval.invocationId)).toMatchObject({
    sourceKind: "configured-mcp",
    podId: null,
    httpStatus: null,
    protocolOutcome: "success",
    outcome: "succeeded",
  });
  expect(
    f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.mutationOutcome,
  ).toBe("succeeded");
  expect((await send(f)).status).toBe(200);
  expect(f.effects).toEqual(["create_note"]);
});

it("revokes a pending consent when an unrelated configured server is added", async () => {
  const f = fixture();
  const pending = send(f);
  void pending.catch(() => undefined);
  await vi.waitFor(() => {
    expect(f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.readGrant?.state).toBe(
      "pending",
    );
  });
  const snapshot = f.deps.mcpSettings?.read("mcp-chat-test");
  if (snapshot === undefined) throw new Error("Missing settings");
  f.deps.mcpSettings?.update(
    {
      expectedRevision: snapshot.revision,
      servers: [f.server, { ...f.server, name: "another" }],
      secrets: {},
    },
    "mcp-chat-test",
  );
  await pending;
  expect(f.effects).toEqual([]);
  expect(f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.readGrant?.state).not.toBe(
    "granted",
  );
});

async function pendingWrite(f: ReturnType<typeof fixture>): Promise<ChatToolWriteApprovalView> {
  await vi.waitFor(() => {
    expect(
      f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.approval?.state,
    ).toBe("pending");
  });
  const approval = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.approval;
  if (approval === undefined) throw new Error("Missing write approval");
  return approval;
}
async function decideWrite(
  f: ReturnType<typeof fixture>,
  approval: Awaited<ReturnType<typeof pendingWrite>>,
): ReturnType<typeof handleDecideChatWriteApproval> {
  return handleDecideChatWriteApproval(
    context(
      { decision: "approve", actionDigest: approval.actionDigest },
      { approvalId: approval.approvalId },
    ),
    f.deps,
  );
}

it.each(["replace", "delete"] as const)(
  "revokes a pending write when Settings %s the configured server",
  async (change) => {
    const f = fixture(true);
    const pending = send(f);
    void pending.catch(() => undefined);
    await approveRead(f);
    const approval = await pendingWrite(f);
    const settings = f.deps.mcpSettings;
    if (settings === undefined) throw new Error("Missing settings");
    const replacement: McpServerDefinition = {
      ...f.server,
      transport: { kind: "local", command: [process.execPath, "--no-warnings"], environment: {} },
    };
    settings.update(
      {
        expectedRevision: settings.read("mcp-chat-test").revision,
        servers: change === "delete" ? [] : [replacement],
        secrets: {},
      },
      "mcp-chat-test",
    );
    await pending;
    expect(f.effects).toEqual([]);
    expect((await decideWrite(f, approval)).status).not.toBe(200);
    expect(f.deps.store.chatToolMutations?.find(approval.invocationId)).toBeUndefined();
  },
);

it("retains an unknown remote effect and never writes again on duplicate delivery or regenerate", async () => {
  const f = fixture(true, true);
  const pending = send(f);
  void pending.catch(() => undefined);
  await approveRead(f);
  const approval = await pendingWrite(f);
  expect((await decideWrite(f, approval)).status).toBe(200);
  expect((await pending).status).toBe(200);
  expect(f.effects).toEqual(["create_note"]);
  expect(f.deps.store.chatToolMutations?.find(approval.invocationId)).toMatchObject({
    sourceKind: "configured-mcp",
    phase: "settled",
    protocolOutcome: null,
    outcome: "unknown",
  });
  const original = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0];
  expect(original?.mutationOutcome).toBe("unknown");
  expect((await send(f)).status).toBe(200);
  const assistant = f.deps.store
    .listMessages(f.chatId)
    .find((message) => message.role === "assistant");
  if (assistant === undefined) throw new Error("Missing assistant answer");
  const regenerated = await handleRegenerateDesktopChat(
    context({
      chatId: f.chatId,
      projectPath: f.root,
      modelId: MODEL,
      assistantMessageId: assistant.id,
      clientTurnId: "mcp-regenerated-turn",
      memory: { enabled: false, budgetTokens: 0, mode: "governed-assist", context: {} },
    }),
    f.deps,
  );
  expect(regenerated.status).toBe(200);
  expect(f.calls.at(-1)?.toolCatalog).toBeUndefined();
  expect(f.effects).toEqual(["create_note"]);
  expect(f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]).toEqual(original);
});

it("preserves dependency graph identity and disposes each runtime without recursion", async () => {
  const f = fixture();
  const dispose = vi.fn(() => Promise.resolve());
  const deps = { ...f.deps, dispose };
  const log = {
    primary: createBufferedServerLogSink(),
    diagnostics: { record: (): void => undefined },
  };
  expect(installJiraChatCatalogRuntime(deps, log)).toBe(deps);
  expect(installMcpChatCatalogRuntime(deps, log)).toBe(deps);
  await deps.dispose();
  expect(dispose).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "revokes pending consent at the invocation deadline (write=%s)",
  async (write) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const f = fixture(write);
      const pending = send(f);
      void pending.catch(() => undefined);
      if (write) {
        await approveRead(f);
        await pendingWrite(f);
      } else {
        await vi.waitFor(() => {
          expect(f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.readGrant?.state).toBe(
            "pending",
          );
        });
      }
      await vi.advanceTimersByTimeAsync(60_001);
      await pending;
      const transcript = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript;
      expect(write ? transcript?.exchanges[0]?.approval?.state : transcript?.readGrant?.state).toBe(
        "revoked",
      );
      expect(f.effects).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  },
);
