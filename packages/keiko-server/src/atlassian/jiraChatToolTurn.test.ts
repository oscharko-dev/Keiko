import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { JiraChatToolTurn } from "./jiraChatToolTurn.js";
import { findMessageById as readStoredMessage } from "../store/messages.js";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { handleDecideChatWriteApproval } from "./chatWriteApprovalRoutes.js";
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
import type {
  ChatToolExchange,
  DesktopChatSendResponse,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { buildUiHandlerDeps, type UiHandlerDeps } from "../deps.js";
import { handleSendDesktopChat } from "../chat-handlers.js";
import { mockRequest, mockResponse } from "../_support.js";
import type { RouteContext, RouteResult } from "../routes.js";
import type {
  AtlassianCredentialMetadata,
  AtlassianHttpBodyPort,
} from "@oscharko-dev/keiko-connectors";
import { jiraChatActorDigest } from "./jiraPodAccess.js";
import { handleDecideChatReadConsent } from "./chatReadConsentRoutes.js";

type ToolProof = boolean | "missing" | "stale" | "unsupported" | "mismatched";
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
function configure(deps: UiHandlerDeps, proof: ToolProof = true): void {
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
          toolCalling: proof !== "unsupported",
          streaming: true,
          ...(proof === "missing"
            ? {}
            : {
                toolCallingVerification: {
                  status: proof === false ? "unverified" : "verified",
                  checkedAt: new Date(
                    proof === "stale" ? Date.now() - 2 * 24 * 60 * 60 * 1000 : Date.now(),
                  ).toISOString(),
                  probe: "gateway-tool-calling-v1",
                  configurationFingerprint:
                    proof === "mismatched"
                      ? "f".repeat(64)
                      : toolCallingConfigurationFingerprint(provider),
                },
              }),
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
function syntheticModel(calls: GatewayCallRequest[], mutation: boolean): ModelPort {
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
      (entry) =>
        entry.toolRef.canonicalId === (mutation ? "keiko.jira.comment" : "keiko.jira.projects"),
    );
    if (tool === undefined) throw new Error("Missing offered Jira projects tool");
    return {
      ...base,
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        bridge.bind({
          id: `call-${String(calls.length)}`,
          name: tool.alias,
          arguments: mutation ? { issueKey: "KEIKO-1", body: "Synthetic approved comment" } : {},
        }),
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
function fixture(
  mutation = false,
  writeResponse?: Promise<void>,
): {
  deps: UiHandlerDeps;
  chatId: string;
  root: string;
  calls: GatewayCallRequest[];
  requests: () => number;
  writes: () => number;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-jira-chat-turn-"));
  const calls: GatewayCallRequest[] = [];
  const model = syntheticModel(calls, mutation);
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui.db"),
    env: { KEIKO_STATE_DIR: root },
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
  let writes = 0;
  vi.spyOn(credentials, "httpBodyPortFactory").mockImplementation(
    (_metadata, _correlationId, lifecycle) =>
      async (request): ReturnType<AtlassianHttpBodyPort> => {
        if (lifecycle?.beforeDispatch?.(request) !== true)
          throw new Error("Expected dispatch admission");
        requests++;
        const write = request.method !== "GET";
        if (write) {
          writes++;
          await writeResponse;
        }
        const status = write ? 201 : 200;
        lifecycle.onResponse?.(request, status);
        const bodyText = mutation
          ? JSON.stringify({ id: "10001", body: "Synthetic approved comment" })
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
  return { deps, chatId: chat.id, root, calls, requests: () => requests, writes: () => writes };
}
function send(
  f: ReturnType<typeof fixture>,
  clientTurnId: string,
): ReturnType<typeof handleSendDesktopChat> {
  return handleSendDesktopChat(sendContext(f, clientTurnId), f.deps);
}
function sendContext(f: ReturnType<typeof fixture>, clientTurnId: string): RouteContext {
  return context(sendBody(f, clientTurnId));
}
function sendBody(f: ReturnType<typeof fixture>, clientTurnId: string): Record<string, unknown> {
  return {
    chatId: f.chatId,
    projectPath: f.root,
    modelId: MODEL,
    content: "List Jira projects",
    clientTurnId,
    memory: { enabled: false, budgetTokens: 0, mode: "governed-assist", context: {} },
  };
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
  it.each([false, "missing", "stale", "unsupported", "mismatched"] as const)(
    "rejects a bound Chat with %s tool proof before any model or Jira call",
    async (proof) => {
      const f = fixture();
      configure(f.deps, proof);
      const result = await send(f, "unverified-model-turn");
      expect(result).toMatchObject({
        status: 400,
        body: {
          error: {
            code: "CONVERSATION_UNAVAILABLE_MODEL",
          },
        },
      });
      expect(JSON.stringify(result.body)).toContain("verified tool calling");
      expect(JSON.stringify(result.body)).toContain("disconnect the Jira Pod");
      expect(f.calls).toHaveLength(0);
      expect(f.requests()).toBe(0);
      expect(f.deps.store.listMessages(f.chatId)[0]?.turnState).toBe("failed");
    },
  );
  it("preserves ordinary unbound Chat without tool-calling proof", async () => {
    const f = fixture();
    f.deps.store.updateChat(f.chatId, { jiraPodId: null });
    configure(f.deps, false);
    expect((await send(f, "unbound-model-turn")).status).toBe(200);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.toolCatalog).toBeUndefined();
    expect(f.requests()).toBe(0);
  });
});

describe("normal streamed Chat through the owned Jira catalog", () => {
  it.each([false, "missing", "stale", "unsupported", "mismatched"] as const)(
    "refuses streamed Chat with %s tool proof before SSE or model dispatch",
    async (proof) => {
      const f = fixture();
      configure(f.deps, proof);
      const response = mockResponse({ captureBody: true });
      const result = await handleSendDesktopChatStream(
        { ...sendContext(f, "unverified-stream"), res: response.res },
        f.deps,
      );
      expect(result).toMatchObject({
        status: 400,
        body: { error: { code: "CONVERSATION_UNAVAILABLE_MODEL" } },
      });
      expect(response.body()).toBe("");
      expect(f.calls).toHaveLength(0);
      expect(f.requests()).toBe(0);
      expect(f.deps.store.listMessages(f.chatId)[0]?.turnState).toBe("failed");
    },
  );

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

it("discovers the five governed mutations through the ordinary Chat-owned MCP catalog", async () => {
  const f = fixture();
  const managed = await f.deps.jiraChatCatalog?.get();
  expect(managed?.catalog.descriptors.map((entry) => entry.toolRef.canonicalId)).toEqual(
    expect.arrayContaining([
      "keiko.jira.create",
      "keiko.jira.edit",
      "keiko.jira.assign",
      "keiko.jira.comment",
      "keiko.jira.transition",
    ]),
  );
});

async function approveReadForWrite(f: ReturnType<typeof fixture>): Promise<void> {
  await vi.waitFor(() => {
    expect(f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.readGrant?.state).toBe(
      "pending",
    );
  });
  expect(f.writes()).toBe(0);
  const grant = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.readGrant;
  if (grant === undefined) throw new Error("Missing write-turn read consent");
  await handleDecideChatReadConsent(
    context(
      { decision: "approve", disclosureVersion: grant.disclosureVersion },
      { approvalId: grant.grantId },
    ),
    f.deps,
  );
}
async function decidePendingWrite(
  f: ReturnType<typeof fixture>,
  decision: "approve" | "reject",
): Promise<void> {
  await vi.waitFor(() => {
    expect(
      f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.approval?.state,
    ).toBe("pending");
  });
  expect(f.writes()).toBe(0);
  const approval = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.approval;
  if (approval === undefined) throw new Error("Missing exact write approval");
  expect(
    (
      await handleDecideChatWriteApproval(
        context(
          { decision, actionDigest: approval.actionDigest },
          { approvalId: approval.approvalId },
        ),
        f.deps,
      )
    ).status,
  ).toBe(200);
}

function assertObservedWrite(f: ReturnType<typeof fixture>): void {
  const exchange = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0];
  expect(exchange?.mutationOutcome).toBe("succeeded");
  expect(exchange?.result?.status).toBe("completed");
  expect(f.calls[1]?.messages.find((message) => message.role === "tool")?.content).toContain(
    '"mutationOutcome":"succeeded"',
  );
}

describe("normal Chat write approval and durable outcome", () => {
  it.each(
    (["governed-assist", "supervised-coding", "autonomous-delivery"] as const).flatMap((mode) => [
      { mode, streamed: false },
      { mode, streamed: true },
    ]),
  )(
    "executes one approved effect in mode $mode (streamed=$streamed) through the production catalog",
    async ({ mode, streamed }) => {
      const f = fixture(true);
      f.deps.store.updateChat(f.chatId, { toolMode: mode });
      const response = mockResponse({ captureBody: true });
      const request = sendContext(f, `write-${mode}-${String(streamed)}`);
      const pending = streamed
        ? handleSendDesktopChatStream({ ...request, res: response.res }, f.deps)
        : handleSendDesktopChat(request, f.deps);
      void pending.catch(() => undefined);
      await approveReadForWrite(f);
      if (mode !== "autonomous-delivery") await decidePendingWrite(f, "approve");
      const completed = await pending;
      if (streamed) {
        expect(response.body()).toContain("event: done");
        if (mode !== "autonomous-delivery")
          expect(response.body()).toContain("event: tool-write-approval");
      } else expect(completed).toMatchObject({ status: 200 });
      expect(f.writes()).toBe(1);
      assertObservedWrite(f);
      expect(firstToolExchange(f).approval?.state).toBe(
        mode === "autonomous-delivery" ? undefined : "claimed",
      );
      const modelCalls = f.calls.length;
      const replay = await handleSendDesktopChat(
        sendContext(f, `write-${mode}-${String(streamed)}`),
        f.deps,
      );
      expect(replay.status).toBe(200);
      expect(f.calls).toHaveLength(modelCalls);
      expect(f.writes()).toBe(1);
    },
  );
});

it("keeps a rejected normal Chat write free of remote effects", async () => {
  const f = fixture(true);
  const pending = handleSendDesktopChat(sendContext(f, "rejected-write"), f.deps);
  void pending.catch(() => undefined);
  await approveReadForWrite(f);
  await decidePendingWrite(f, "reject");
  await pending;
  expect(f.writes()).toBe(0);
  expect(f.requests()).toBe(0);
  const exchange = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0];
  expect(exchange?.approval?.state).toBe("rejected");
  expect(exchange?.result?.status).toBe("denied");
});

function firstToolExchange(f: ReturnType<typeof fixture>): ChatToolExchange {
  const exchange = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0];
  if (exchange === undefined) throw new Error("Missing tool exchange");
  return exchange;
}

it("retains late acknowledged Jira effects after the Chat has already been cancelled", async () => {
  let release = (): void => {
    throw new Error("Missing response gate");
  };
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(true, delayed);
  const response = mockResponse({ captureBody: true });
  const pending = handleSendDesktopChatStream(
    { ...sendContext(f, "late-response-write"), res: response.res },
    f.deps,
  );
  void pending.catch(() => undefined);
  await approveReadForWrite(f);
  await decidePendingWrite(f, "approve");
  await vi.waitFor(() => {
    expect(f.writes()).toBe(1);
  });
  response.res.destroy();
  await pending;
  await vi.waitFor(() => {
    expect(f.deps.store.listMessages(f.chatId)[0]?.turnState).toBe("cancelled");
  });
  const message = f.deps.store.listMessages(f.chatId)[0];
  const exchange = firstToolExchange(f);
  if (message === undefined) throw new Error("Missing cancelled turn");
  expect(exchange.result?.data).toBeNull();
  const identity = sha256Hex(canonicalise({ messageId: message.id, callId: exchange.call.id }));
  release();
  await vi.waitFor(() => {
    expect(f.deps.store.chatToolMutations?.find(identity)?.outcome).toBe("succeeded-unconfirmed");
  });
  expect(firstToolExchange(f).mutationOutcome).toBe("succeeded-unconfirmed");
  const reader = new DatabaseSync(join(f.root, "ui.db"), { readOnly: true });
  try {
    expect(
      readStoredMessage(reader, message.id)?.toolTranscript?.exchanges[0]?.mutationOutcome,
    ).toBe("succeeded-unconfirmed");
  } finally {
    reader.close();
  }
  expect(f.writes()).toBe(1);
});

function consentState(f: ReturnType<typeof fixture>, mutation: boolean): string | undefined {
  const transcript = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript;
  return mutation ? transcript?.exchanges[0]?.approval?.state : transcript?.readGrant?.state;
}
async function awaitPendingConsent(
  f: ReturnType<typeof fixture>,
  mutation: boolean,
): Promise<void> {
  if (mutation) await approveReadForWrite(f);
  await vi.waitFor(() => {
    expect(consentState(f, mutation)).toBe("pending");
  });
}
function expectCancelledConsent(
  f: ReturnType<typeof fixture>,
  mutation: boolean,
  turnState: string,
): void {
  const message = f.deps.store.listMessages(f.chatId)[0];
  expect(message?.turnState).toBe(turnState);
  expect(consentState(f, mutation)).toBe("revoked");
  if (mutation) expect(message?.toolTranscript?.readGrant?.state).toBe("granted");
  expect(firstToolExchange(f).result?.status).toBe("cancelled");
  expect(f.requests()).toBe(0);
  expect(f.writes()).toBe(0);
  expect(f.calls).toHaveLength(1);
}

describe.each([false, true])("consent cancellation (stream=%s)", (stream) => {
  it.each([
    { mutation: false, cause: "disconnect" },
    { mutation: true, cause: "disconnect" },
    { mutation: false, cause: "budget" },
    { mutation: true, cause: "budget" },
  ])("drains $cause while mutation=$mutation without dispatch", async ({ mutation, cause }) => {
    const f = fixture(mutation);
    const budget = new AbortController();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked only with explicit this via original.call below.
    const original = JiraChatToolTurn.prototype.call;
    vi.spyOn(JiraChatToolTurn.prototype, "call").mockImplementation(function (
      this: JiraChatToolTurn,
      model,
      request,
      signal,
      observe,
    ): Promise<NormalizedResponse> {
      return original.call(this, model, request, AbortSignal.any([signal, budget.signal]), observe);
    });
    const registry = f.deps.atlassianActionApprovalRegistry;
    if (registry === undefined) throw new Error("Missing approval owner");
    const method = mutation ? "waitForChatWriteApproval" : "waitForChatReadGrant";
    const wait = registry[method].bind(registry);
    let waitFinished = false;
    vi.spyOn(registry, method).mockImplementation(async (...args): Promise<void> => {
      try {
        await wait(...args);
      } finally {
        waitFinished = true;
      }
    });
    const response = mockResponse({ captureBody: true });
    const ctx = { ...sendContext(f, `cancel-${cause}-${String(mutation)}`), res: response.res };
    const pending = stream
      ? handleSendDesktopChatStream(ctx, f.deps)
      : handleSendDesktopChat(ctx, f.deps);
    let finished = false;
    // Buffered unexpected-error mapping belongs to the HTTP boundary; this observer also
    // drains a rejected handler before the isolated database is closed.
    const drained = pending
      .catch(() => undefined)
      .finally(() => {
        finished = true;
      });
    try {
      await awaitPendingConsent(f, mutation);
      if (cause === "budget") budget.abort();
      else response.res.destroy();
      await vi.waitFor(
        () => {
          expect(waitFinished).toBe(true);
          expect(finished).toBe(true);
        },
        { timeout: 500, interval: 10 },
      );
      await drained;
      expectCancelledConsent(f, mutation, cause === "disconnect" ? "cancelled" : "failed");
    } finally {
      response.res.destroy();
      await drained;
    }
  });
});

it.each([false, true])(
  "drains a real buffered HTTP disconnect while mutation=%s",
  async (mutation) => {
    const f = fixture(mutation);
    let running: Promise<RouteResult> | undefined;
    let bodyComplete = false;
    let bodyAborted = false;
    const server = createServer((req, res) => {
      req.once("end", () => {
        bodyComplete = req.complete;
      });
      req.once("aborted", () => {
        bodyAborted = true;
      });
      running = handleSendDesktopChat(
        {
          req,
          res,
          params: {},
          url: new URL("http://127.0.0.1/api/desktop/chat"),
          correlationId: "http-consent-cancellation",
        },
        f.deps,
      );
      void running
        .then((result) => {
          if (!res.destroyed) res.writeHead(result.status).end(JSON.stringify(result.body));
        })
        .catch(() => {
          res.destroy();
        });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing isolated HTTP listener");
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${String(address.port)}/api/desktop/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sendBody(f, "real-http-disconnect")),
      signal: controller.signal,
    }).catch(() => undefined);
    try {
      await awaitPendingConsent(f, mutation);
      controller.abort();
      await request;
      await vi.waitFor(() => {
        expect(f.deps.store.listMessages(f.chatId)[0]?.turnState).toBe("cancelled");
      });
      await running;
      expectCancelledConsent(f, mutation, "cancelled");
      expect(bodyComplete).toBe(true);
      expect(bodyAborted).toBe(false);
    } finally {
      controller.abort();
      await request;
      await running?.catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  },
);
