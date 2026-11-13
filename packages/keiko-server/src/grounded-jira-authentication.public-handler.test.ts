import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  createDefaultChatCapability,
  createGatewayToolCatalogBridge,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
  type GatewayCallRequest,
  type GatewayStreamChunk,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { handleSendDesktopChat } from "./chat-handlers.js";
import { handleSendDesktopChatStream } from "./chat-stream-handlers.js";
import { STREAMING } from "./routes.js";
import { mockRequest, mockResponse } from "./_support.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { buildAtlassianConnectorCredentialDeps } from "./atlassian/wiring.js";
import { createAtlassianCredentialMetadataStore } from "./atlassian/credentialMetadataStore.js";
import { jiraChatActorDigest, type JiraLivePodCredential } from "./atlassian/jiraPodAccess.js";
import { invalidateJiraPodChats } from "./atlassian/jiraPodLifecycle.js";
import { interruptChangedChatGenerations, runSerializedChatTurn } from "./chat-turn-serializer.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";

const MODEL = "grounded-jira-authentication";
const cleanups: (() => Promise<void>)[] = [];

interface Fixture {
  readonly deps: UiHandlerDeps;
  readonly context: RouteContext;
  readonly chatId: string;
  readonly authRef: string;
  readonly calls: GatewayCallRequest[];
  readonly fetches: string[];
  readonly log: BufferedServerLogSink;
  readonly diagnostics: ServerDiagnosticRecord[];
}

interface ResponseHooks {
  beforeResponse?: () => void;
  afterInvalidation?: () => void;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  resetServerLogger();
});

function configure(deps: UiHandlerDeps): void {
  const provider = {
    modelId: MODEL,
    baseUrl: "https://model.example.invalid/v1",
    apiKey: "synthetic-unused",
    timeoutMs: 120_000,
    maxRetries: 2,
    retryBaseDelayMs: 100,
  };
  const runtime = deps.gatewayConfig;
  if (runtime === undefined) throw new TypeError("Missing gateway configuration");
  runtime.set(
    parseGatewayConfig({
      providers: [provider],
      capabilities: [
        {
          ...createDefaultChatCapability(MODEL),
          toolCalling: true,
          contextWindow: 32768,
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
  runtime.recordVerifiedCapability(
    MODEL,
    { conversationReady: true },
    new Date().toISOString(),
    runtime.generation(),
  );
}

function projectModel(calls: GatewayCallRequest[]): ModelPort {
  const call = (request: GatewayCallRequest): Promise<NormalizedResponse> => {
    calls.push(request);
    const reservation = request.attemptAdmission?.({ promptTokens: 100, maxOutputTokens: 100 });
    const response: NormalizedResponse = {
      modelId: MODEL,
      content: "",
      finishReason: "tool_calls",
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
    reservation?.settle(response.usage, true, "observed");
    if (request.toolCatalog?.kind !== "bound")
      throw new TypeError("Missing bound Jira tool catalog");
    const project = request.toolCatalog.projection.tools.find(
      (entry) => entry.toolRef.canonicalId === "keiko.jira.projects",
    );
    const tool =
      project ??
      request.toolCatalog.projection.tools.find(
        (entry) => entry.toolRef.canonicalId === "keiko.jira.describe",
      );
    if (tool === undefined) throw new TypeError("Missing Jira projects tool");
    const bridge = createGatewayToolCatalogBridge({ ...request, stream: false }, Date.now);
    return Promise.resolve({
      ...response,
      toolCalls: [
        bridge.bind({
          id: `jira-call-${String(calls.length)}`,
          name: tool.alias,
          arguments: project === undefined ? { identities: ["GET /rest/api/2/project"] } : {},
        }),
      ],
    });
  };
  return {
    call,
    callStream: async function* (request): AsyncGenerator<GatewayStreamChunk> {
      yield { type: "done", response: await call(request) };
    },
  };
}

function fixture(status: number, anonymous: boolean, hooks: ResponseHooks = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-grounded-jira-auth-")));
  const calls: GatewayCallRequest[] = [];
  const fetches: string[] = [];
  const diagnostics: ServerDiagnosticRecord[] = [];
  const log = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink: log, level: "info" }));
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(root, "state", "evidence"),
    uiDbPath: join(root, "state", "ui.db"),
    env: { KEIKO_STATE_DIR: join(root, "state") },
    modelPortFactory: () => projectModel(calls),
    diagnostics: {
      record: (record): void => {
        diagnostics.push(record);
      },
    },
  });
  cleanups.push(async () => {
    await deps.dispose?.();
    rmSync(root, { recursive: true, force: true });
  });
  configure(deps);
  const credentials = credentialsFor(deps, root, status, anonymous, fetches, log, hooks);
  if (deps.atlassianConnectorCredentials === undefined)
    throw new TypeError("Missing composed credential owner");
  Object.assign(deps.atlassianConnectorCredentials, credentials);
  const created = verifiedCredential(deps, root);
  return {
    deps,
    authRef: created.authRef,
    calls,
    fetches,
    log,
    diagnostics,
    ...connectedChat(deps, root, created.livePod.podId),
  };
}

function verifiedCredential(deps: UiHandlerDeps, root: string): JiraLivePodCredential {
  const credentials = deps.atlassianConnectorCredentials;
  const actorDigest = jiraChatActorDigest(deps);
  if (credentials === undefined) throw new TypeError("Missing credential custody");
  if (actorDigest === undefined) throw new TypeError("Missing local principal");
  const created = credentials.custody.create(
    {
      provider: "jira",
      deployment: "data-center",
      authScheme: "bearer-pat",
      displayName: "Synthetic Jira",
      baseUrl: "https://jira.example.invalid",
      apiToken: "synthetic-jira-pat",
      livePodCreationRequestId: randomUUID(),
    },
    actorDigest,
  );
  if (created.deployment !== "data-center" || created.livePod === undefined)
    throw new TypeError("Missing Jira Live Pod");
  createAtlassianCredentialMetadataStore({
    configPath: join(root, "gateway.json"),
  }).bindTargetAdmission(created, { baseUrl: created.baseUrl, addressClass: "public" });
  const ticket = credentials.custody.beginVerification(created.authRef);
  if (ticket === undefined) throw new TypeError("Missing verification ticket");
  credentials.custody.finishVerification(created.authRef, 1, ticket.revision, "ok");
  return { ...created, livePod: created.livePod };
}

function connectedChat(
  deps: UiHandlerDeps,
  root: string,
  podId: string,
): Pick<Fixture, "context" | "chatId"> {
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  deps.store.createProject(workspace);
  writeFileSync(join(workspace, "scope.txt"), "Synthetic acceptance requirement.\n");
  const chat = deps.store.createChat(workspace, "Grounded authentication", MODEL);
  deps.store.updateChat(
    chat.id,
    {
      jiraPodId: podId,
      toolMode: "autonomous-delivery",
      connectedScopes: [
        { kind: "files", root: workspace, relativePaths: ["scope.txt"], connectedAtMs: 1 },
      ],
    },
    { verifiedJiraPod: { podId, authenticationGeneration: 1 } },
  );
  return {
    chatId: chat.id,
    context: {
      req: mockRequest({
        body: JSON.stringify({ chatId: chat.id, content: "List Jira projects" }),
      }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://localhost/api/chats/messages/grounded"),
      correlationId: "grounded-jira-authentication-proof",
    },
  };
}

function credentialsFor(
  deps: UiHandlerDeps,
  root: string,
  status: number,
  anonymous: boolean,
  fetches: string[],
  log: BufferedServerLogSink,
  hooks: ResponseHooks,
): NonNullable<UiHandlerDeps["atlassianConnectorCredentials"]> {
  return buildAtlassianConnectorCredentialDeps({
    configPath: join(root, "gateway.json"),
    env: { KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: randomBytes(32).toString("base64") },
    egress: () => undefined,
    activityLog: log,
    onLivePodInvalidated: (podId, generation, correlationId, reason): void => {
      invalidateJiraPodChats(deps.store, podId, generation, correlationId, deps, reason);
      hooks.afterInvalidation?.();
    },
    fetchImpl: (_url, init): Promise<Response> => {
      fetches.push(init?.method ?? "GET");
      hooks.beforeResponse?.();
      return Promise.resolve(
        new Response("[]", { status, headers: anonymous ? { "X-AUSERNAME": "anonymous" } : {} }),
      );
    },
  });
}

// An authentication failure on a Chat read (HTTP 401, or an anonymous 200) is decided by one
// same-generation identity probe after the original request (#4353).
const READ_AND_IDENTITY_PROBE = ["GET", "GET"];

async function ask(f: Fixture): Promise<RouteResult> {
  const result = await handleGroundedAsk(f.context, f.deps);
  // The HTTP cancellation can win before the tool settles; wait behind its retained Chat lock.
  await runSerializedChatTurn(f.deps, f.chatId, new AbortController().signal, () => undefined);
  return result;
}

describe("grounded Jira authentication failure", () => {
  it.each([
    { status: 200, anonymous: true },
    { status: 401, anonymous: false },
  ])("surfaces a reconnect error after HTTP $status (anonymous: $anonymous)", async (remote) => {
    const f = fixture(remote.status, remote.anonymous);
    const result = await ask(f);
    expect(f.fetches).toEqual(READ_AND_IDENTITY_PROBE);
    expect(f.deps.atlassianConnectorCredentials?.custody.getMetadata(f.authRef)).toMatchObject({
      generation: 2,
      livePod: { verificationStatus: "auth-failed" },
    });
    expect(result).toMatchObject({
      status: 409,
      body: {
        error: {
          code: "JIRA_AUTHENTICATION_FAILED",
          message:
            "Jira authentication failed. The token may have expired or been revoked: open the Knowledge Pods hub, replace the token and verify the connection. This Chat and its draft are kept.",
        },
      },
    });
    expect(f.calls.at(-1)?.toolCatalog?.kind).toBe("bound");
    expect(f.log.events.find((event) => event.op === "atlassian.connection.checked")).toMatchObject(
      {
        extra: { action: "request", outcome: "auth-failed" },
      },
    );
    expect(f.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "JIRA_AUTHENTICATION_FAILED",
        correlationId: f.context.correlationId,
        operation: "POST /api/chats/messages/grounded",
        source: "chat.turn.authentication",
      }),
    );
  });

  it("keeps an explicit disconnect as cancellation", async () => {
    const hooks: ResponseHooks = {};
    const f = fixture(401, false, hooks);
    hooks.beforeResponse = (): void => {
      f.context.res.emit("close");
    };
    expect(await ask(f)).toMatchObject({
      status: 499,
      body: { error: { code: "CANCELLED" } },
    });
    expect(f.calls.at(-1)?.toolCatalog?.kind).toBe("bound");
    expect(f.fetches).toEqual(["GET"]);
    expect(f.diagnostics.some((record) => record.code === "JIRA_AUTHENTICATION_FAILED")).toBe(
      false,
    );
  });

  it.each(["mode-change", "pod-removed"] as const)(
    "keeps an unrelated %s as cancellation",
    async (cause) => {
      const hooks: ResponseHooks = {};
      const f = fixture(200, false, hooks);
      hooks.beforeResponse = (): void => {
        const previous = f.deps.store.findChatById(f.chatId);
        if (previous === undefined) throw new TypeError("Missing connected Chat");
        const current = f.deps.store.updateChat(
          f.chatId,
          cause === "mode-change" ? { toolMode: "governed-assist" } : { jiraPodId: null },
        );
        interruptChangedChatGenerations(f.deps, previous, current, f.context.correlationId);
      };
      expect(await ask(f)).toMatchObject({
        status: 499,
        body: { error: { code: "CANCELLED" } },
      });
      expect(f.calls.at(-1)?.toolCatalog?.kind).toBe("bound");
      expect(f.fetches).toEqual(["GET"]);
      expect(f.deps.atlassianConnectorCredentials?.custody.getMetadata(f.authRef)).toMatchObject({
        generation: 1,
        livePod: { verificationStatus: "ok" },
      });
      expect(f.diagnostics.some((record) => record.code === "JIRA_AUTHENTICATION_FAILED")).toBe(
        false,
      );
    },
  );
});

function normalChatContext(f: Fixture): {
  context: RouteContext;
  response: ReturnType<typeof mockResponse>;
} {
  const chat = f.deps.store.updateChat(f.chatId, { connectedScopes: [] });
  const response = mockResponse({ captureBody: true });
  return {
    response,
    context: {
      ...f.context,
      req: mockRequest({
        body: JSON.stringify({
          chatId: f.chatId,
          projectPath: chat.projectPath,
          content: "List Jira projects",
        }),
      }),
      res: response.res,
    },
  };
}

describe("ordinary Jira Chat authentication failure", () => {
  it.each([
    { status: 401, anonymous: false },
    { status: 200, anonymous: true },
  ])("preserves buffered HTTP $status authentication failure", async (remote) => {
    const f = fixture(remote.status, remote.anonymous);
    const { context } = normalChatContext(f);
    const result = await handleSendDesktopChat(context, f.deps);
    await runSerializedChatTurn(f.deps, f.chatId, new AbortController().signal, () => undefined);
    expect(f.fetches).toEqual(READ_AND_IDENTITY_PROBE);
    expect(result).toMatchObject({
      status: 409,
      body: { error: { code: "JIRA_AUTHENTICATION_FAILED", correlationId: context.correlationId } },
    });
  });

  it.each([
    { status: 401, anonymous: false },
    { status: 200, anonymous: true },
  ])(
    "preserves streamed HTTP $status authentication failure after headers start",
    async (remote) => {
      const f = fixture(remote.status, remote.anonymous);
      const { context, response } = normalChatContext(f);
      const result = await handleSendDesktopChatStream(context, f.deps);
      await runSerializedChatTurn(f.deps, f.chatId, new AbortController().signal, () => undefined);
      expect(result).toBe(STREAMING);
      expect(response.statusCode()).toBe(200);
      expect(f.fetches).toEqual(READ_AND_IDENTITY_PROBE);
      expect(response.body()).toContain("event: error\n");
      expect(response.body()).toContain('"code":"JIRA_AUTHENTICATION_FAILED"');
      expect(response.body()).not.toContain("event: cancelled");
      expect(response.body()).not.toContain("event: done");
    },
  );

  it("retains the observed cause when verification succeeds before the cancelled handler settles", async () => {
    const hooks: ResponseHooks = {};
    const f = fixture(401, false, hooks);
    hooks.afterInvalidation = (): void => {
      const custody = f.deps.atlassianConnectorCredentials?.custody;
      const ticket = custody?.beginVerification(f.authRef, 2);
      if (ticket === undefined) throw new TypeError("Missing re-verification ticket");
      expect(custody?.finishVerification(f.authRef, 2, ticket.revision, "ok")).toBe(true);
    };
    expect(await ask(f)).toMatchObject({
      status: 409,
      body: { error: { code: "JIRA_AUTHENTICATION_FAILED" } },
    });
    expect(f.deps.atlassianConnectorCredentials?.custody.getMetadata(f.authRef)).toMatchObject({
      livePod: { verificationStatus: "ok" },
    });
    expect(f.fetches).toEqual(READ_AND_IDENTITY_PROBE);
  });
});
