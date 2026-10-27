import { handleSendDesktopChatStream } from "../chat-stream-handlers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultChatCapability,
  createGatewayToolCatalogBridge,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
  type GatewayCallRequest,
  type GatewayStreamChunk,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { DesktopChatSendResponse } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { buildUiHandlerDeps, type UiHandlerDeps } from "../deps.js";
import { handleSendDesktopChat } from "../chat-handlers.js";
import { mockRequest, mockResponse } from "../_support.js";
import type { RouteContext } from "../routes.js";
import type {
  AtlassianCredentialMetadata,
  AtlassianHttpBodyPort,
} from "@oscharko-dev/keiko-connectors";
import { jiraChatActorDigest } from "./jiraPodAccess.js";
import { handleDecideChatReadConsent } from "./chatReadConsentRoutes.js";

const MODEL = "synthetic-jira-chat";
const POD = "d5f5681e-ce98-4c3c-b27e-51d707c9d018";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});
function context(body: Record<string, unknown>, params: Record<string, string> = {}): RouteContext {
  return {
    req: mockRequest({ body: JSON.stringify(body) }),
    res: mockResponse().res,
    params,
    url: new URL("http://127.0.0.1/api/desktop/chat"),
    correlationId: "jira-chat-loop-proof",
  };
}
function configure(deps: UiHandlerDeps, verified = true): void {
  const provider = {
    modelId: MODEL,
    baseUrl: "https://model.example.invalid/v1",
    apiKey: "synthetic-unused",
    timeoutMs: 5000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
  const runtime = deps.gatewayConfig;
  if (runtime === undefined) throw new Error("Missing config");
  runtime.set(
    parseGatewayConfig({
      providers: [provider],
      capabilities: [
        {
          ...createDefaultChatCapability(MODEL),
          toolCalling: true,
          streaming: true,
          toolCallingVerification: {
            status: verified ? "verified" : "unverified",
            checkedAt: new Date().toISOString(),
            probe: "gateway-tool-calling-v1",
            configurationFingerprint: toolCallingConfigurationFingerprint(provider),
          },
        },
      ],
    }),
    true,
  );
  runtime.recordVerifiedCapability(
    MODEL,
    { conversationReady: true },
    new Date().toISOString(),
    runtime.generation(),
  );
}
function metadata(deps: UiHandlerDeps): AtlassianCredentialMetadata {
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
function syntheticModel(calls: GatewayCallRequest[]): ModelPort {
  const respond = (request: GatewayCallRequest): NormalizedResponse => {
    calls.push(request);
    const reservation = request.attemptAdmission?.({ promptTokens: 100, maxOutputTokens: 500 });
    const base: NormalizedResponse = {
      modelId: MODEL,
      content: "No Jira projects are visible.",
      finishReason: "stop",
      toolCalls: [],
      structuredOutput: null,
      usage: {
        requestId: `request-${String(calls.length)}`,
        promptTokens: 100,
        completionTokens: 10,
        latencyMs: 1,
        costClass: "low",
      },
    };
    reservation?.settle(base.usage, true, "observed");
    if (request.toolCatalog?.kind !== "bound" || calls.length % 2 === 0) return base;
    expect(reservation).toBeDefined();
    const bridge = createGatewayToolCatalogBridge({ ...request, stream: false }, Date.now);
    const tool = request.toolCatalog.projection.tools.find(
      (entry) => entry.toolRef.canonicalId === "keiko.jira.projects",
    );
    if (tool === undefined) throw new Error("Missing offered Jira projects tool");
    return {
      ...base,
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        bridge.bind({ id: `call-${String(calls.length)}`, name: tool.alias, arguments: {} }),
      ],
    };
  };
  const call = (request: GatewayCallRequest): Promise<NormalizedResponse> =>
    Promise.resolve(respond(request));
  return { call, callStream: (request) => syntheticStream(call(request)) };
}
async function* syntheticStream(
  response: Promise<NormalizedResponse>,
): AsyncIterable<GatewayStreamChunk> {
  const resolved = await response;
  if (resolved.content.length > 0) yield { type: "delta", token: resolved.content };
  yield { type: "done", response: resolved };
}
function fixture(): {
  deps: UiHandlerDeps;
  chatId: string;
  root: string;
  calls: GatewayCallRequest[];
  requests: () => number;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-jira-chat-turn-"));
  const calls: GatewayCallRequest[] = [];
  const model = syntheticModel(calls);
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui.db"),
    env: {},
    modelPortFactory: () => model,
  });
  cleanups.push(async () => {
    await deps.dispose?.();
    rmSync(root, { recursive: true, force: true });
  });
  configure(deps);
  deps.store.createProject(root);
  const chat = deps.store.createChat(root, "Synthetic Jira", MODEL);
  deps.store.updateChat(
    chat.id,
    { jiraPodId: POD },
    { verifiedJiraPod: { podId: POD, authenticationGeneration: 1 } },
  );
  const credentials = deps.atlassianConnectorCredentials;
  if (credentials === undefined) throw new Error("Missing credential owner");
  vi.spyOn(credentials.custody, "list").mockImplementation(() => [metadata(deps)]);
  let requests = 0;
  vi.spyOn(credentials, "httpBodyPortFactory").mockImplementation(
    (_metadata, _correlationId, lifecycle) =>
      (request): ReturnType<AtlassianHttpBodyPort> => {
        if (lifecycle?.beforeDispatch?.(request) !== true)
          throw new Error("Expected dispatch admission");
        requests++;
        return Promise.resolve({
          kind: "response",
          status: 200,
          bodyText: "[]",
          bodyBytes: 2,
          truncated: false,
        });
      },
  );
  return { deps, chatId: chat.id, root, calls, requests: () => requests };
}
function send(
  f: ReturnType<typeof fixture>,
  clientTurnId: string,
): ReturnType<typeof handleSendDesktopChat> {
  return handleSendDesktopChat(sendContext(f, clientTurnId), f.deps);
}
function sendContext(f: ReturnType<typeof fixture>, clientTurnId: string): RouteContext {
  return context({
    chatId: f.chatId,
    projectPath: f.root,
    modelId: MODEL,
    content: "List Jira projects",
    clientTurnId,
    memory: { enabled: false, budgetTokens: 0, mode: "governed-assist", context: {} },
  });
}
describe("normal buffered Chat through the owned Jira catalog", () => {
  it("waits for real consent, executes through MCP, persists pairs and reuses consent next turn", async () => {
    const f = fixture();
    const pending = send(f, "human-turn-one");
    void pending.catch(() => undefined);
    await vi.waitFor(() => {
      expect(f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.readGrant?.state).toBe(
        "pending",
      );
    });
    expect(f.requests()).toBe(0);
    const grant = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.readGrant;
    if (grant === undefined) throw new Error("Missing pending consent");
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
    const completed = await pending;
    expect(completed.status).toBe(200);
    expect((completed.body as DesktopChatSendResponse).messages[0]?.turnState).toBe("completed");
    expect(f.requests()).toBe(1);
    expect(
      f.calls[1]?.messages.some(
        (message) => message.role === "tool" && message.toolCallId === "call-1",
      ),
    ).toBe(true);
    expect(
      f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.result?.status,
    ).toBe("completed");
    expect((await send(f, "human-turn-two")).status).toBe(200);
    expect(f.requests()).toBe(2);
    expect(
      f.deps.store
        .listMessages(f.chatId)
        .filter((message) => message.toolTranscript?.readGrant !== undefined),
    ).toHaveLength(1);
    expect((await send(f, "human-turn-two")).status).toBe(200);
    expect(f.requests()).toBe(2);
  });
  it("does not advertise tools to a model without current tool-call proof", async () => {
    const f = fixture();
    configure(f.deps, false);
    expect((await send(f, "unverified-model-turn")).status).toBe(200);
    expect(f.calls.every((request) => request.toolCatalog === undefined)).toBe(true);
    expect(f.requests()).toBe(0);
  });
});

describe("normal streamed Chat through the owned Jira catalog", () => {
  it("publishes consent while waiting, then completes through the same MCP loop", async () => {
    const f = fixture();
    const response = mockResponse({ captureBody: true });
    const pending = handleSendDesktopChatStream(
      { ...sendContext(f, "streamed-human-turn"), res: response.res },
      f.deps,
    );
    void pending.catch(() => undefined);
    await vi.waitFor(() => {
      expect(response.body()).toContain("event: tool-read-consent");
    });
    expect(f.requests()).toBe(0);
    const grant = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.readGrant;
    if (grant === undefined) throw new Error("Missing streamed grant");
    await handleDecideChatReadConsent(
      context(
        { decision: "approve", disclosureVersion: grant.disclosureVersion },
        { approvalId: grant.grantId },
      ),
      f.deps,
    );
    await pending;
    expect(f.requests()).toBe(1);
    expect(response.body()).toContain('"state":"granted"');
    expect(response.body()).toContain("event: done");
    expect(response.body()).toContain("No Jira projects are visible.");
    expect(response.body()).not.toContain("resultBinding");
    expect(f.deps.store.listMessages(f.chatId)[0]?.turnState).toBe("completed");
  });
  it("cancels a disconnected consent wait without a Jira request", async () => {
    const f = fixture();
    const response = mockResponse({ captureBody: true });
    const pending = handleSendDesktopChatStream(
      { ...sendContext(f, "disconnected-human-turn"), res: response.res },
      f.deps,
    );
    void pending.catch(() => undefined);
    await vi.waitFor(() => {
      expect(response.body()).toContain("event: tool-read-consent");
    });
    response.res.destroy();
    await pending;
    expect(f.requests()).toBe(0);
    await vi.waitFor(() => {
      expect(f.deps.store.listMessages(f.chatId)[0]?.turnState).toBe("cancelled");
    });
  });
});
