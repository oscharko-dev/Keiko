import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  parseGatewayConfig,
  type GatewayConfig,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  applyGitChangeDescription,
  chatTurnShapeFields,
  captureDesktopChatExecutionAdmission,
  createHandleGitChangeApplyDescription,
  handleCreateDesktopChat,
  handleSendDesktopChat,
  parseClientTurnId,
  parseExpectedGroundingScopeIdentity,
} from "./chat-handlers.js";
import { buildRedactor, buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
// Final-audit F5 (#3400): the production-composition proof for the Chat apply path reuses the
// SAME real fixture and route handlers prDescriptionRoutes.test.ts already proves a full
// preview -> approve -> apply round trip against (a real git repo, a real GitHub-shaped body-only
// PATCH capture) — never a second, hand-rolled description-service fixture.
import { DescriptionFixture } from "./gitDelivery/prDescriptionTestSupport.js";
import {
  createHandlePrDescriptionApprove,
  createHandlePrDescriptionPreview,
  type PrDescriptionRouteOptions,
} from "./gitDelivery/prDescriptionRoutes.js";
import { permittedGitDeliveryAuthority } from "./gitDelivery/runBoundAuthority.test-support.js";
import { codingWorkbenchRemoteDigest } from "./coding-context/githubIssueResolution.js";
import type { ChatGitChangeScope } from "./store/index.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "./diagnostics-log.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "./observability/index.js";
import type { RouteContext } from "./routes.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";

const VALID_GROUNDING_SCOPE_IDENTITY = `gsi-v1:${"a".repeat(64)}`;
const INVALID_CLIENT_TURN_ID = {
  status: 400,
  body: {
    error: {
      code: "BAD_REQUEST",
      message: "clientTurnId must be a bounded non-blank string.",
    },
  },
} as const;

describe("parseClientTurnId", (): void => {
  it("preserves bounded opaque identifiers without normalizing their identity", (): void => {
    const paddedOpaqueId = "  opaque-id  ";
    const maximumLengthId = "x".repeat(MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS);

    expect(parseClientTurnId(undefined)).toBeUndefined();
    expect(parseClientTurnId(paddedOpaqueId)).toBe(paddedOpaqueId);
    expect(parseClientTurnId(maximumLengthId)).toBe(maximumLengthId);
  });

  it.each([
    null,
    "",
    " \t\r\n",
    "\u00a0\ufeff\u3000",
    "x".repeat(MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS + 1),
  ])("rejects an invalid identifier %#", (value): void => {
    expect(parseClientTurnId(value)).toEqual(INVALID_CLIENT_TURN_ID);
  });
});

describe("parseExpectedGroundingScopeIdentity", (): void => {
  it("passes through an omitted or valid server-issued identity", (): void => {
    expect(parseExpectedGroundingScopeIdentity(undefined)).toBeUndefined();
    expect(parseExpectedGroundingScopeIdentity(VALID_GROUNDING_SCOPE_IDENTITY)).toBe(
      VALID_GROUNDING_SCOPE_IDENTITY,
    );
  });

  it.each([null, "", "gsi-v1:not-a-digest", `gsi-v1:${"a".repeat(63)}`, { value: "forged" }])(
    "rejects an invalid or forged identity %#",
    (value): void => {
      expect(parseExpectedGroundingScopeIdentity(value)).toEqual({
        status: 400,
        body: {
          error: {
            code: "BAD_REQUEST",
            message: "expectedGroundingScopeIdentity must be a valid server-issued identity.",
          },
        },
      });
    },
  );
});

function requestContext(body: Record<string, unknown>, correlationId?: string): RouteContext {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  const res = {
    destroyed: false,
    closed: false,
    writableEnded: false,
    once(): void {
      // The exercised handler does not register response events on this deterministic stub.
    },
    off(): void {
      // The exercised handler does not unregister response events on this deterministic stub.
    },
  };
  return {
    correlationId,
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    params: {},
    url: new URL("http://127.0.0.1/api/desktop/chat"),
  };
}

function gatewayErrorCode(result: Awaited<ReturnType<typeof handleSendDesktopChat>>): unknown {
  const body = result.body as { readonly error?: { readonly code?: unknown } };
  return body.error?.code;
}

interface GatewayBreakerFixture {
  readonly root: string;
  readonly projectPath: string;
  readonly chatId: string;
  readonly deps: UiHandlerDeps;
}

function configureBreakerGateway(deps: UiHandlerDeps): void {
  const runtimeConfig = deps.gatewayConfig;
  if (runtimeConfig === undefined) throw new Error("expected runtime gateway config");
  runtimeConfig.set(
    parseGatewayConfig({
      providers: [
        {
          modelId: "breaker-chat",
          baseUrl: "https://provider.example.invalid/v1",
          apiKey: "fake-test-key",
          timeoutMs: 5_000,
          maxRetries: 0,
          retryBaseDelayMs: 1,
        },
      ],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 1 },
    }),
    true,
  );
  runtimeConfig.recordVerifiedCapability(
    "breaker-chat",
    { conversationReady: true },
    "2026-08-16T00:00:00.000Z",
    runtimeConfig.generation(),
  );
}

async function createGatewayBreakerFixture(): Promise<GatewayBreakerFixture> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-chat-breaker-"));
  const projectPath = join(root, "repo");
  let deps: UiHandlerDeps | undefined;
  try {
    mkdirSync(projectPath);
    deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: join(root, "evidence"),
      uiDbPath: join(root, "ui.db"),
      env: {},
    });
    configureBreakerGateway(deps);
    deps.store.createProject(projectPath, "repo");
    const chat = deps.store.createChat(projectPath, "Breaker", "breaker-chat");
    return { root, projectPath, chatId: chat.id, deps };
  } catch (error) {
    try {
      await deps?.dispose?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    throw error;
  }
}

async function disposeGatewayBreakerFixture(fixture: GatewayBreakerFixture): Promise<void> {
  try {
    await fixture.deps.dispose?.();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function sendBreakerChat(
  fixture: GatewayBreakerFixture,
  content: string,
  correlationId?: string,
): Promise<Awaited<ReturnType<typeof handleSendDesktopChat>>> {
  return handleSendDesktopChat(
    requestContext(
      {
        chatId: fixture.chatId,
        projectPath: fixture.projectPath,
        modelId: "breaker-chat",
        content,
      },
      correlationId,
    ),
    fixture.deps,
  );
}

describe("desktop chat production gateway reuse", () => {
  it("logs the returned grounding rejection instead of concurrent model unreadiness", async () => {
    const fixture = await createGatewayBreakerFixture();
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    try {
      fixture.deps.gatewayConfig?.clearVerifiedCapability("breaker-chat");
      const chat = fixture.deps.store.updateChat(fixture.chatId, {
        connectedScope: {
          kind: "workspace-root",
          relativePaths: [],
          connectedAtMs: 42,
        },
      });

      const result = captureDesktopChatExecutionAdmission(
        {
          chatId: fixture.chatId,
          projectPath: fixture.projectPath,
          content: "body must stay out of evidence",
          modelId: "breaker-chat",
          documentContext: [],
          attachments: [],
          memory: undefined,
          discussionMode: undefined,
        },
        chat,
        "breaker-chat",
        fixture.deps,
        { operation: "chat.send.rejected", correlationId: "corr-grounding-changed" },
      );

      expect(result).toMatchObject({
        status: 409,
        body: { error: { code: "GROUNDING_SCOPE_CHANGED" } },
      });
      expect(sink.events).toContainEqual(
        expect.objectContaining({
          category: "gateway",
          op: "chat.send.rejected",
          correlationId: "corr-grounding-changed",
          status: 409,
          errorKind: "grounding-scope-changed",
          extra: { reason: "grounding-scope", modelKind: "chat" },
        }),
      );
      expect(JSON.stringify(sink.events)).not.toContain("body must stay out of evidence");
    } finally {
      resetServerLogger();
      await disposeGatewayBreakerFixture(fixture);
    }
  });

  it("keeps user content off the provider while probing an unready model on demand", async () => {
    const fixture = await createGatewayBreakerFixture();
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    try {
      fixture.deps.gatewayConfig?.clearVerifiedCapability("breaker-chat");
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const createRejected = await handleCreateDesktopChat(
        requestContext(
          {
            modelId: "breaker-chat",
            projectPath: fixture.projectPath,
            title: "must not be created",
          },
          "corr-create-unready",
        ),
        fixture.deps,
      );
      const rejected = await sendBreakerChat(
        fixture,
        "must not leave the server",
        "corr-send-unready",
      );

      expect(createRejected).toEqual({
        status: 400,
        body: {
          error: {
            code: "BAD_REQUEST",
            message:
              "The selected model failed its live readiness check. Open Settings > Models and run the readiness check to see the provider status.",
          },
        },
      });
      expect(rejected).toEqual({
        status: 400,
        body: {
          error: {
            code: "BAD_REQUEST",
            message:
              "The selected model failed its live readiness check. Open Settings > Models and run the readiness check to see the provider status.",
          },
        },
      });
      // Relocated pin (fresh-install on-demand readiness): a never-observed model now gets a
      // bounded on-demand READINESS PROBE before the honest rejection — so outbound calls may
      // happen, but they carry only the static probe prompt. The load-bearing invariant is
      // unchanged and strengthened below: the USER'S content never reaches the provider, on
      // any call, in any body — and the probe outcome is recorded so retries stay probe-free.
      // Evidence the on-demand probe actually happened, bounded: the create attempt probes
      // once; the send attempt hits the recorded not-ready observation without re-probing.
      expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(4);
      for (const call of fetchSpy.mock.calls) {
        const init = call[1] as { body?: unknown } | undefined;
        const body = typeof init?.body === "string" ? init.body : "";
        expect(body).not.toContain("must not leave the server");
        expect(body).not.toContain("must not be created");
      }
      expect(
        fixture.deps.gatewayConfig?.verifiedCapability("breaker-chat")?.fields.conversationReady,
      ).not.toBe(true);
      expect(JSON.stringify(rejected.body)).not.toContain("must not leave the server");
      expect(sink.events).toContainEqual(
        expect.objectContaining({
          category: "gateway",
          op: "chat.creation.rejected",
          correlationId: "corr-create-unready",
          status: 400,
          errorKind: "model-not-ready",
          extra: { reason: "readiness", modelKind: "chat" },
        }),
      );
      expect(sink.events).toContainEqual(
        expect.objectContaining({
          category: "gateway",
          op: "chat.send.rejected",
          correlationId: "corr-send-unready",
          status: 400,
          errorKind: "model-not-ready",
          extra: { reason: "readiness", modelKind: "chat" },
        }),
      );
      expect(JSON.stringify(sink.events)).not.toContain("must not leave the server");
    } finally {
      vi.unstubAllGlobals();
      resetServerLogger();
      await disposeGatewayBreakerFixture(fixture);
    }
  });

  it("logs an invalid model creation rejection with the undefined-context fallback", async () => {
    const fixture = await createGatewayBreakerFixture();
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    try {
      const rejected = await handleCreateDesktopChat(
        requestContext({
          modelId: "missing-model",
          projectPath: fixture.projectPath,
          title: "must not be created",
        }),
        fixture.deps,
      );

      expect(rejected).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
      expect(sink.events).toContainEqual(
        expect.objectContaining({
          category: "gateway",
          op: "chat.creation.rejected",
          correlationId: UNKNOWN_CORRELATION_ID,
          status: 400,
          errorKind: "invalid-model",
          extra: { reason: "configuration", modelKind: "unknown" },
        }),
      );
    } finally {
      resetServerLogger();
      await disposeGatewayBreakerFixture(fixture);
    }
  });

  it("defaults an omitted modelId to a conversation-ready chat model", async () => {
    const fixture = await createGatewayBreakerFixture();
    try {
      const runtimeConfig = fixture.deps.gatewayConfig;
      if (runtimeConfig === undefined) throw new Error("expected runtime gateway config");
      runtimeConfig.set(
        parseGatewayConfig({
          providers: [
            {
              modelId: "breaker-chat",
              baseUrl: "https://provider.example.invalid/v1",
              apiKey: "fake-test-key",
              timeoutMs: 5_000,
              maxRetries: 0,
              retryBaseDelayMs: 1,
            },
            {
              modelId: "ready-chat",
              baseUrl: "https://provider.example.invalid/v1",
              apiKey: "fake-test-key",
              timeoutMs: 5_000,
              maxRetries: 0,
              retryBaseDelayMs: 1,
            },
          ],
        }),
        true,
      );
      // Only the SECOND configured chat model has a current successful probe: the optional
      // public modelId must not funnel the request into the unready first model's 400 while
      // a usable model exists.
      runtimeConfig.recordVerifiedCapability(
        "ready-chat",
        { conversationReady: true },
        "2026-08-16T00:00:00.000Z",
        runtimeConfig.generation(),
      );

      const created = await handleCreateDesktopChat(
        requestContext({ projectPath: fixture.projectPath, title: "defaulted model" }),
        fixture.deps,
      );

      expect(created.status).toBe(201);
      const body = created.body as { readonly chat?: { readonly selectedModel?: unknown } };
      expect(body.chat?.selectedModel).toBe("ready-chat");
    } finally {
      await disposeGatewayBreakerFixture(fixture);
    }
  });

  it("opens one shared breaker across separate route requests", async () => {
    const fixture = await createGatewayBreakerFixture();
    try {
      const fetchSpy = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: "unavailable" } }), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchSpy);
      for (let index = 0; index < 5; index += 1) {
        const result = await sendBreakerChat(fixture, `failure ${String(index)}`);
        expect(gatewayErrorCode(result)).toBe("GATEWAY_PROVIDER_ERROR");
        expect(fetchSpy).toHaveBeenCalledTimes(index + 1);
      }

      const rejected = await sendBreakerChat(fixture, "must fail before transport");
      expect(gatewayErrorCode(rejected)).toBe("GATEWAY_CIRCUIT_OPEN");
      // KEIKO-0353: a circuit-open failure must surface as 503 "temporarily unavailable"
      // like a transport failure does — not 502, which the pre-fix code returned because
      // CircuitOpenError has retryable=false (the breaker's internal auto-recovery signal,
      // not the client's "give up" signal).
      expect(rejected.status).toBe(503);
      expect(fetchSpy).toHaveBeenCalledTimes(5);
    } finally {
      vi.unstubAllGlobals();
      await disposeGatewayBreakerFixture(fixture);
    }
  });
});

// ADR-0173 D5 g9 — `chatTurnShapeFields` is the exact production formula `chat.turn.started`
// logs; these tests derive their expectations by calling it directly rather than restating the
// counting logic as a second copy that could drift from it (AGENTS.md §7).
describe("chatTurnShapeFields", () => {
  it("counts a 3-message turn by role and totals a single image attachment", () => {
    const messages = [{ role: "system" }, { role: "user" }, { role: "assistant" }];
    const attachments = [
      { kind: "image" as const, mimeType: "image/png", sizeBytes: 40_000 },
      { kind: "document" as const, mimeType: "application/pdf", sizeBytes: 12_000 },
    ];

    expect(chatTurnShapeFields(messages, attachments)).toEqual({
      messageCount: 3,
      roleCounts: { system: 1, user: 1, assistant: 1, tool: 0 },
      toolCount: 0,
      imageAttachmentCount: 1,
      imageAttachmentBytes: 40_000,
    });
  });

  it("sums bytes across multiple image attachments and ignores an unrecognised role", () => {
    const messages = [{ role: "system" }, { role: "tool" }, { role: "unknown-role" }];
    const attachments = [
      { kind: "image" as const, mimeType: "image/png", sizeBytes: 1_000 },
      { kind: "image" as const, mimeType: "image/jpeg", sizeBytes: 2_500 },
    ];

    const fields = chatTurnShapeFields(messages, attachments);
    expect(fields.messageCount).toBe(3);
    expect(fields.roleCounts).toEqual({ system: 1, user: 0, assistant: 0, tool: 1 });
    expect(fields.toolCount).toBe(1);
    expect(fields.imageAttachmentCount).toBe(2);
    expect(fields.imageAttachmentBytes).toBe(3_500);
  });

  it("returns zeroed counts for an empty turn", () => {
    expect(chatTurnShapeFields([], [])).toEqual({
      messageCount: 0,
      roleCounts: { system: 0, user: 0, assistant: 0, tool: 0 },
      toolCount: 0,
      imageAttachmentCount: 0,
      imageAttachmentBytes: 0,
    });
  });
});

function turnShapeGatewayConfig(modelId: string): GatewayConfig {
  return {
    // `listConfiguredCapabilities` cross-references `capabilities` against `providers` by
    // `modelId` (`model-selection.ts`) — a capability with no matching provider entry is
    // filtered out of the registry, so `modelCapabilityRegistry` would see this model as
    // "not chat-capable" without one, even though this test never dials out to it.
    providers: [
      {
        modelId,
        baseUrl: "https://provider.example.invalid/v1",
        apiKey: "unused-test-key",
        timeoutMs: 5_000,
        maxRetries: 0,
        retryBaseDelayMs: 1,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
    capabilities: [
      {
        id: modelId,
        kind: "chat",
        contextWindow: 64_000,
        maxOutputTokens: 4_096,
        toolCalling: false,
        structuredOutput: false,
        streaming: true,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: false,
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "test",
        preferredUseCases: [],
        knownLimitations: [],
      },
    ],
  };
}

function turnShapeModel(): ModelPort {
  return {
    call(request): Promise<NormalizedResponse> {
      return Promise.resolve({
        modelId: request.modelId,
        content: "Hallo!",
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "turn-shape-test",
          promptTokens: 3,
          completionTokens: 2,
          latencyMs: 5,
          costClass: "low",
        },
      });
    },
  };
}

describe("chat.turn.started", () => {
  afterEach(() => {
    resetServerLogger();
  });

  it("logs messageCount/roleCounts once per turn, keyed to the request correlation id", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const modelId = "turn-shape-chat";
    const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-chat-turn-shape-"));
    const projectPath = join(root, "repo");
    try {
      mkdirSync(projectPath);
      const store = createInMemoryUiStore();
      store.createProject(projectPath, "repo");
      const chat = store.createChat(projectPath, "Turn shape", modelId);
      const deps: UiHandlerDeps = {
        config: turnShapeGatewayConfig(modelId),
        configPresent: true,
        evidenceStore: {
          put: () => "",
          list: () => [],
          get: () => undefined,
          delete: () => undefined,
        },
        env: {},
        redactor: buildRedactor({}),
        registry: createRunRegistry(),
        modelPortFactory: () => turnShapeModel(),
        store,
      };
      // A prior completed turn — sent through the SAME production path, not hand-seeded into the
      // store — so the second turn's assembled prompt carries 4 messages: the fixed system
      // prompt, the prior user+assistant pair, and the current user message being sent. The exact
      // "3-message" formula case is covered precisely by chatTurnShapeFields above; this send only
      // needs a real, non-trivial shape to prove the wiring counts what the assembled prompt
      // actually contains, not a restated expectation.
      const priorResult = await handleSendDesktopChat(
        {
          ...requestContext({
            chatId: chat.id,
            projectPath,
            modelId,
            content: "What is on the roadmap?",
          }),
          correlationId: "turn-shape-prior",
        },
        deps,
      );
      if (priorResult.status !== 200) {
        throw new Error(
          `expected the seeded prior turn to succeed: ${JSON.stringify(priorResult)}`,
        );
      }
      const result = await handleSendDesktopChat(
        {
          ...requestContext({ chatId: chat.id, projectPath, modelId, content: "Hello there" }),
          correlationId: "turn-shape-correlation-1",
        },
        deps,
      );
      expect(result.status).toBe(200);
      const events = sink.events.filter(
        (event) =>
          event.op === "chat.turn.started" && event.correlationId === "turn-shape-correlation-1",
      );
      expect(events).toHaveLength(1);
      const [event] = events;
      if (event === undefined) throw new Error("expected a chat.turn.started event");
      expect(event.category).toBe("gateway");
      expect(event.extra).toEqual({
        messageCount: 4,
        roleCounts: { system: 1, user: 2, assistant: 1, tool: 0 },
        toolCount: 0,
        imageAttachmentCount: 0,
        imageAttachmentBytes: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ADR-0173 D5 g25 — the buffered `/api/desktop/chat` path used to map a GatewayError straight to
// an HTTP body with no operator diagnostic at all, unlike the SSE `/api/desktop/chat/stream` path
// (`chat-stream-handlers.test.ts` pins that side). This is the fails-before proof for the shared
// symmetry fix: before it, `events` below stayed empty on a RateLimitError.
describe("desktopChatErrorResult gateway diagnostic symmetry", () => {
  it("emits the same diagnostic shape as the streaming path on a RateLimitError", async () => {
    const fixture = await createGatewayBreakerFixture();
    try {
      const events: ServerDiagnosticRecord[] = [];
      const diagnostics: ServerDiagnosticSink = {
        record: (record): void => {
          events.push(record);
        },
      };
      const deps: UiHandlerDeps = { ...fixture.deps, diagnostics };
      const fetchSpy = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: "slow down" } }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "2" },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const result = await handleSendDesktopChat(
        {
          ...requestContext({
            chatId: fixture.chatId,
            projectPath: fixture.projectPath,
            modelId: "breaker-chat",
            content: "please respond",
          }),
          correlationId: "rate-limit-correlation-1",
        },
        deps,
      );

      expect(gatewayErrorCode(result)).toBe("GATEWAY_RATE_LIMIT");
      expect(result.status).toBe(503);
      expect(events).toHaveLength(1);
      const [event] = events;
      if (event === undefined) throw new Error("expected a diagnostic record");
      expect(event.correlationId).toBe("rate-limit-correlation-1");
      expect(event.operation).toBe("POST /api/desktop/chat");
      expect(event.source).toBe("chat.send");
      expect(event.errorClass).toBe("RateLimitError");
    } finally {
      vi.unstubAllGlobals();
      await disposeGatewayBreakerFixture(fixture);
    }
  });
});

// Issue #3400 (epic #3384, contract correction 4) — a Chat turn on a git-change-connected chat
// must re-derive the server-minted description authority before any snapshot content reaches the
// Model Gateway. Before this admission gate existed, a chat carrying `gitChangeScopes` sent its
// turn straight to the gateway like any other chat; these tests prove the gate now denies it
// closed (no authority port is wired in `buildUiHandlerDeps` yet — #3399's own production-wiring
// item — so "no port" must mean "no admission", never a silent bypass) and never reaches the
// network to do so.
describe("git-change description-authority admission (#3400)", () => {
  function attachGitChangeScope(deps: UiHandlerDeps, chatId: string): void {
    deps.store.updateChat(chatId, {
      gitChangeScopes: [
        {
          kind: "git-change",
          relationshipId: "rel-1",
          remoteDigest: "d".repeat(64),
          comparisonLabel: "main...feature/x",
          baseRef: "main",
          headRef: "feature/x",
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          mergeBaseSha: "c".repeat(40),
          snapshotDigest: "e".repeat(64),
          fileCount: 1,
          totalFiles: 1,
          omittedFiles: 0,
          truncatedFiles: 0,
          descriptionStatus: "current",
          connectedAtMs: 10,
        },
      ],
    });
  }

  it("denies the turn before any network call when no description authority port is wired", async () => {
    const fixture = await createGatewayBreakerFixture();
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const fetchSpy = vi.fn(() => {
      throw new Error("must not reach the network");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      attachGitChangeScope(fixture.deps, fixture.chatId);
      const result = await sendBreakerChat(fixture, "refine the description", "corr-git-change-1");

      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({
        error: { code: "GIT_CHANGE_DESCRIPTION_AUTHORITY_DENIED" },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sink.events).toContainEqual(
        expect.objectContaining({
          category: "security",
          op: "pr-description.chat.turn.denied",
          correlationId: "corr-git-change-1",
          errorKind: "model-egress-denied",
          extra: { relationshipId: "rel-1" },
        }),
      );
    } finally {
      vi.unstubAllGlobals();
      resetServerLogger();
      await disposeGatewayBreakerFixture(fixture);
    }
  });

  // #3400/#3401 final-audit F1: before this discriminant existed, an expired description
  // authority record and no record at all were indistinguishable at the Chat admission — both
  // logged the SAME generic `errorKind: "authority-denied"`. This is the failing-before case: a
  // port that can tell a record for this exact scope existed and has passed its `expiresAt` must
  // deny with `authority-expired`, never the generic absent reason.
  it("denies with authority-expired when the description authority record has expired", async () => {
    const fixture = await createGatewayBreakerFixture();
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const fetchSpy = vi.fn(() => {
      throw new Error("must not reach the network");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      attachGitChangeScope(fixture.deps, fixture.chatId);
      const expiredDeps = {
        ...fixture.deps,
        gitChangeDescriptionAuthorityPort: {
          current: (): undefined => undefined,
          expired: (): boolean => true,
        },
      } as unknown as UiHandlerDeps;
      const result = await handleSendDesktopChat(
        requestContext(
          {
            chatId: fixture.chatId,
            projectPath: fixture.projectPath,
            modelId: "breaker-chat",
            content: "refine the description",
          },
          "corr-git-change-expired",
        ),
        expiredDeps,
      );

      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({
        error: { code: "GIT_CHANGE_DESCRIPTION_AUTHORITY_DENIED" },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sink.events).toContainEqual(
        expect.objectContaining({
          category: "security",
          op: "pr-description.chat.turn.denied",
          correlationId: "corr-git-change-expired",
          errorKind: "authority-expired",
          extra: { relationshipId: "rel-1" },
        }),
      );
    } finally {
      vi.unstubAllGlobals();
      resetServerLogger();
      await disposeGatewayBreakerFixture(fixture);
    }
  });

  it("admits the turn once a live description authority record exists for the exact scope", async () => {
    const fixture = await createGatewayBreakerFixture();
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    try {
      attachGitChangeScope(fixture.deps, fixture.chatId);
      const admittingDeps = {
        ...fixture.deps,
        gitChangeDescriptionAuthorityPort: {
          current: (): { readonly effectiveMode: string } => ({ effectiveMode: "governed-assist" }),
        },
      } as unknown as UiHandlerDeps;
      const fetchSpy = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: "still no real provider" } }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "1" },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const result = await handleSendDesktopChat(
        requestContext(
          {
            chatId: fixture.chatId,
            projectPath: fixture.projectPath,
            modelId: "breaker-chat",
            content: "refine the description",
          },
          "corr-git-change-2",
        ),
        admittingDeps,
      );

      // Admitted past the gate, so execution proceeds to the real gateway path (and fails there
      // for the unrelated reason that no provider is actually configured) rather than being
      // denied by the git-change gate itself.
      expect(result.body).not.toMatchObject({
        error: { code: "GIT_CHANGE_DESCRIPTION_AUTHORITY_DENIED" },
      });
      expect(fetchSpy).toHaveBeenCalled();
      expect(sink.events).toContainEqual(
        expect.objectContaining({
          category: "security",
          op: "pr-description.chat.turn.admitted",
          correlationId: "corr-git-change-2",
          extra: { relationshipId: "rel-1" },
        }),
      );
    } finally {
      vi.unstubAllGlobals();
      resetServerLogger();
      await disposeGatewayBreakerFixture(fixture);
    }
  });

  it("never gates a normal chat with no connected git-change scope", async () => {
    const fixture = await createGatewayBreakerFixture();
    try {
      const result = await sendBreakerChat(fixture, "hello", "corr-no-git-change");
      expect(result.body).not.toMatchObject({
        error: { code: "GIT_CHANGE_DESCRIPTION_AUTHORITY_DENIED" },
      });
    } finally {
      await disposeGatewayBreakerFixture(fixture);
    }
  });
});

// Frozen Product Decision 6 / issue correction 1 — the apply action is a body-only description
// application (#3399's service), never the coupled title+body+base `executeGovernedPullRequest`
// path. `executeGovernedPullRequestSpy` below mocks the ENTIRE module chat-handlers.ts would have
// to import to reach that path, so a call through it during `applyGitChangeDescription` would be
// directly observable — proving the absence is not merely "no import happens to exist today".
const executeGovernedPullRequestSpy = vi.hoisted(() => vi.fn());
// F5's own preview -> approve -> apply round trip (below) exercises the REAL
// `PrDescriptionApplicationService.allowed()`, which reads the REAL `KEIKO_DEFAULT_PR_POLICY_PACK`
// through this exact module — so only `executeGovernedPullRequest` is replaced; the real pack
// (and everything else this module exports) passes through via `importActual`, never a
// hand-rolled `{}` stand-in that would throw inside `assertPolicyPackMintable`.
vi.mock("./gitDelivery/prExecution.js", async () => {
  const actual = await vi.importActual<typeof import("./gitDelivery/prExecution.js")>(
    "./gitDelivery/prExecution.js",
  );
  // Delegates to the REAL implementation by default -- the older tests below never reach it at
  // all (a fully fake service), while F5's real end-to-end tests need the real body-only PATCH to
  // actually execute; both keep full call-observability through the same spy.
  executeGovernedPullRequestSpy.mockImplementation(actual.executeGovernedPullRequest);
  return { ...actual, executeGovernedPullRequest: executeGovernedPullRequestSpy };
});

// The GitHub-reader grant itself is proven elsewhere (gitChangeRoutes.test.ts, coding-context's own
// suite); stubbed here — mirroring gitChangeRoutes.test.ts's own convention for this exact module —
// so this file's F5 tests isolate what THEY must prove: admission, service reuse, and the one-use
// approval reaching `executeApproved`.
vi.mock("./coding-context/githubIssueReaderAuthorization.js", () => ({
  isGitHubIssueReaderAuthorized: (): boolean => true,
  githubRemoteOwnerAndRepoFor: (): Promise<string> => Promise.resolve("owner/repo"),
}));

describe("applyGitChangeDescription routes only through the description application service (#3400)", () => {
  afterEach(() => {
    executeGovernedPullRequestSpy.mockClear();
  });

  it("returns undefined and calls no PR-update adapter when the service is not yet composed", () => {
    const result = applyGitChangeDescription({} as UiHandlerDeps, "proposal-1", {});
    expect(result).toBeUndefined();
    expect(executeGovernedPullRequestSpy).not.toHaveBeenCalled();
  });

  it("calls the port's executeApproved and never executeGovernedPullRequest", async () => {
    const executeApproved = vi.fn((): Promise<{ readonly outcome: string }> =>
      Promise.resolve({ outcome: "applied" }),
    );
    const deps = {
      prDescriptionApplicationService: { executeApproved },
    } as unknown as UiHandlerDeps;
    const lease = { token: "lease-1" };

    const result = await applyGitChangeDescription(deps, "proposal-1", lease);

    expect(result).toEqual({ outcome: "applied" });
    expect(executeApproved).toHaveBeenCalledWith("proposal-1", lease);
    expect(executeApproved).toHaveBeenCalledTimes(1);
    expect(executeGovernedPullRequestSpy).not.toHaveBeenCalled();
  });
});

// Final-audit F5 (#3400): `applyGitChangeDescription` above had zero production callers.
// `createHandleGitChangeApplyDescription` is the real handler Chat reaches for the apply action —
// proven here against a REAL `PrDescriptionApplicationService` (the `DescriptionFixture` prDescriptionRoutes.test.ts
// itself proves a full preview -> approve -> apply round trip against) reused through the SAME
// admitted, per-(project, repository, PR) service factory, never a second surface.
describe("createHandleGitChangeApplyDescription — the real handler Chat reaches (final-audit F5)", () => {
  let fixture: DescriptionFixture;
  let store: ReturnType<typeof createInMemoryUiStore>;
  let projectId: string;

  beforeEach(() => {
    fixture = new DescriptionFixture();
    store = createInMemoryUiStore();
    projectId = store.createProject(fixture.root).path;
    executeGovernedPullRequestSpy.mockClear();
  });
  afterEach(() => {
    fixture.close();
    store.close();
  });

  function fixtureDeps(): UiHandlerDeps {
    return {
      config: undefined,
      configPresent: false,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: {},
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: () => undefined,
      store,
      gitDeliveryAuthority: permittedGitDeliveryAuthority(
        () => projectId,
        () => fixture.root,
        "autonomous-delivery",
        {
          headRef: "feature",
          baseRef: "main",
          allowDetachedHead: false,
          allowedPrefixes: ["feature"],
        },
      ),
    };
  }

  function fixtureOptions(): PrDescriptionRouteOptions {
    return { execution: {}, serviceFactory: () => fixture.service };
  }

  function connectedScope(relationshipId: string): ChatGitChangeScope {
    return {
      kind: "git-change",
      relationshipId,
      remoteDigest: codingWorkbenchRemoteDigest("owner/repo"),
      comparisonLabel: "PR #123",
      baseRef: "main",
      headRef: "feature",
      baseSha: fixture.remote.identity.baseSha,
      headSha: fixture.remote.identity.headSha,
      mergeBaseSha: fixture.remote.identity.baseSha,
      snapshotDigest: "a".repeat(64),
      pullRequestNumber: 123,
      fileCount: 1,
      totalFiles: 1,
      omittedFiles: 0,
      truncatedFiles: 0,
      descriptionStatus: "current",
      connectedAtMs: Date.now(),
    };
  }

  async function heldProposalId(deps: UiHandlerDeps): Promise<string> {
    const previewRes = await createHandlePrDescriptionPreview(fixtureOptions())(
      requestContext({
        schemaVersion: "1",
        projectId,
        ownerAndRepo: "owner/repo",
        prNumber: 123,
        language: "en",
      }),
      deps,
    );
    const proposalId = (previewRes.body as { preview: { proposalId: string } }).preview.proposalId;
    await createHandlePrDescriptionApprove(fixtureOptions())(
      requestContext({
        schemaVersion: "1",
        projectId,
        ownerAndRepo: "owner/repo",
        prNumber: 123,
        proposalId,
      }),
      deps,
    );
    return proposalId;
  }

  it("reaches executeApproved with a one-use approval and applies the real body-only PATCH", async () => {
    const deps = fixtureDeps();
    const chat = store.createChat(projectId, "t", "m");
    const relationshipId = "rel-apply-1";
    store.updateChat(chat.id, { gitChangeScopes: [connectedScope(relationshipId)] });
    const proposalId = await heldProposalId(deps);

    const applyHandler = createHandleGitChangeApplyDescription(fixtureOptions());
    const result = await applyHandler(
      requestContext({ schemaVersion: "1", chatId: chat.id, relationshipId, proposalId }),
      deps,
    );

    expect(result.status).toBe(200);
    expect((result.body as { outcome: string }).outcome).toBe("observed");
    expect(fixture.writes).toHaveLength(1);

    // The SAME approval is one-use: a second apply with the SAME proposal id must not re-execute.
    const replay = await applyHandler(
      requestContext({ schemaVersion: "1", chatId: chat.id, relationshipId, proposalId }),
      deps,
    );
    expect(replay.status).toBe(409);
    expect(fixture.writes).toHaveLength(1);
    // The one real effect was already counted above; the replay reaches no second execution.
    expect(executeGovernedPullRequestSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks with 404 when the relationship names no connected git-change scope", async () => {
    const deps = fixtureDeps();
    const chat = store.createChat(projectId, "t", "m");

    const applyHandler = createHandleGitChangeApplyDescription(fixtureOptions());
    const result = await applyHandler(
      requestContext({
        schemaVersion: "1",
        chatId: chat.id,
        relationshipId: "rel-unknown",
        proposalId: "proposal-x",
      }),
      deps,
    );

    expect(result.status).toBe(404);
    expect(executeGovernedPullRequestSpy).not.toHaveBeenCalled();
  });

  it("blocks with 409 when the connected scope has no resolved pull request", async () => {
    const deps = fixtureDeps();
    const chat = store.createChat(projectId, "t", "m");
    const relationshipId = "rel-no-pr";
    // exactOptionalPropertyTypes: an unresolved PR is represented by OMITTING
    // `pullRequestNumber`, never by assigning it `undefined`.
    const { pullRequestNumber, ...scope } = connectedScope(relationshipId);
    void pullRequestNumber;
    store.updateChat(chat.id, { gitChangeScopes: [scope] });

    const applyHandler = createHandleGitChangeApplyDescription(fixtureOptions());
    const result = await applyHandler(
      requestContext({
        schemaVersion: "1",
        chatId: chat.id,
        relationshipId,
        proposalId: "proposal-x",
      }),
      deps,
    );

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: "GIT_CHANGE_APPLY_UNAVAILABLE" } });
  });

  // Approval-required: a proposal that was never previewed/approved for this (project, repository,
  // PR) has no consumable one-use lease -- apply must never fall through to a default/implicit
  // approval. Distinct from the one-use replay proof above (a proposal consumed ONCE already);
  // this proves the FIRST call with an unapproved id is refused just as closed.
  it("blocks with 409 when the proposal was never approved (approval-required)", async () => {
    const deps = fixtureDeps();
    const chat = store.createChat(projectId, "t", "m");
    const relationshipId = "rel-never-approved";
    store.updateChat(chat.id, { gitChangeScopes: [connectedScope(relationshipId)] });

    const applyHandler = createHandleGitChangeApplyDescription(fixtureOptions());
    const result = await applyHandler(
      requestContext({
        schemaVersion: "1",
        chatId: chat.id,
        relationshipId,
        proposalId: "never-previewed-or-approved",
      }),
      deps,
    );

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: "GIT_CHANGE_APPLY_UNKNOWN_PROPOSAL" } });
    expect(fixture.writes).toHaveLength(0);
    expect(executeGovernedPullRequestSpy).not.toHaveBeenCalled();
  });

  // Epic negative qualification: #3399's own body-only apply effect (prDescriptionEffects.ts's
  // `applyDescription`) reuses `executeGovernedPullRequest` as its underlying git-mutation
  // primitive -- the SAME shared function every governed PR route uses -- so "never reached" is
  // the wrong invariant to pin (a prior version of this test asserted exactly that against a fully
  // FAKE injected service that could never call anything, which is why it never caught this: it
  // passed identically whether the real path was wired or not, proving nothing about production).
  // The invariant this item's write scope can actually enforce is the CONSTRAINED shape reaching
  // that call: `kind: "pr-update"` only (never "merge"/"commit"/"push"/"pr-create"/"pr-mark-ready"),
  // an empty `title` (no rename), and the identical base/head the connected scope already carries
  // (no re-target) -- so even though Chat's apply shares the primitive, it can never drive it into
  // a branch/commit/push/PR-create/merge/close effect.
  it("constrains the underlying git-mutation call to a body-only pr-update -- never merge/commit/push/PR-create/close", async () => {
    const deps = fixtureDeps();
    const chat = store.createChat(projectId, "t", "m");
    const relationshipId = "rel-negative";
    const scope = connectedScope(relationshipId);
    store.updateChat(chat.id, { gitChangeScopes: [scope] });
    const proposalId = await heldProposalId(deps);

    const applyHandler = createHandleGitChangeApplyDescription(fixtureOptions());
    const result = await applyHandler(
      requestContext({ schemaVersion: "1", chatId: chat.id, relationshipId, proposalId }),
      deps,
    );
    expect(result.status).toBe(200);

    expect(executeGovernedPullRequestSpy).toHaveBeenCalledTimes(1);
    const [request] = executeGovernedPullRequestSpy.mock.calls[0] as [Record<string, unknown>];
    expect(request).toMatchObject({
      kind: "pr-update",
      title: "",
      baseBranchName: scope.baseRef,
      headBranchName: scope.headRef,
      convertToDraft: false,
      convertFromDraft: false,
    });
    // The captured remote write carries the PR identity plus body only -- no title, base, or
    // merge/close-shaped field ever reaches the adapter.
    const write = fixture.writes[0] as Record<string, unknown> | undefined;
    expect(write).toBeDefined();
    expect(write).toHaveProperty("body");
    for (const forbidden of ["title", "base", "baseBranchName", "mergeMethod", "closeIssue"]) {
      expect(write).not.toHaveProperty(forbidden);
    }
  });

  // A request smuggling an operation-shaped field (mirrors prDescriptionRoutes.ts's own
  // "binding smuggling" guard) is rejected before any scope lookup or service resolution runs.
  it("rejects a request carrying an extra field before any lookup runs", async () => {
    const deps = fixtureDeps();
    const applyHandler = createHandleGitChangeApplyDescription(fixtureOptions());
    const result = await applyHandler(
      requestContext({
        schemaVersion: "1",
        chatId: "chat-1",
        relationshipId: "rel-1",
        proposalId: "proposal-1",
        mergeMethod: "squash",
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(executeGovernedPullRequestSpy).not.toHaveBeenCalled();
  });
});

// ADR-0173 D5 g25 — scheduling wrapper around `enrichChatCompactionWithModelSummary`
// (`chat-handlers.ts`'s own `logCompactionSummaryFailure`, mirroring `recordPostCommitMemoryFailure`
// at chat-handlers.ts:1444-1452). `enrichChatCompactionWithModelSummary` already absorbs every
// failure it can reach internally (see chat-compaction-model-summary.test.ts), so this wrapper's
// own catch is exercised here by mocking that import — the only way to reach it without relying on
// an internal implementation detail of the mocked module.
describe("logCompactionSummaryFailure", () => {
  afterEach(() => {
    vi.doUnmock("./chat-compaction-model-summary.js");
    vi.resetModules();
  });

  it("routes a scheduled-enrichment rejection through the diagnostic sink instead of console.warn", async () => {
    // `chat-handlers.js` (and its static import of `chat-compaction-model-summary.js`) is already
    // cached from this file's top-level imports; the cache must be cleared BEFORE re-importing,
    // or the fresh import below would resolve to the same already-loaded, unmocked module graph.
    vi.resetModules();
    const enrichChatCompactionWithModelSummary = vi.fn((): Promise<void> =>
      Promise.reject(new Error("scheduled enrichment blew up")),
    );
    vi.doMock("./chat-compaction-model-summary.js", () => ({
      enrichChatCompactionWithModelSummary,
    }));
    const { recordChatCompaction } = await import("./chat-handlers.js");
    const events: ServerDiagnosticRecord[] = [];
    const diagnostics: ServerDiagnosticSink = {
      record: (record): void => {
        events.push(record);
      },
    };
    const deps = {
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: {},
      redactor: (value: unknown): unknown => value,
      diagnostics,
    } as unknown as UiHandlerDeps;

    recordChatCompaction(deps, {
      compaction: {
        laneId: "history-summary",
        reason: "exceeded effective input budget",
        itemsBefore: 2,
        itemsAfter: 1,
        tokensBefore: 100,
        tokensAfter: 20,
        preservedFacts: [],
        decisions: [],
      },
      request: { chatId: "chat-scheduling-failure-1" },
      modelId: "scheduling-failure-model",
      messageCount: 1,
      startedAt: Date.now(),
      historyPrefix: [],
      correlationId: "scheduling-failure-correlation-1",
    } as never);

    // The failure surfaces via a detached `setImmediate` + a rejected promise's `.catch`; give
    // both a turn of the event loop to run before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const scheduled = events.filter(
      (event) => event.operation === "chat.compaction.summary.scheduled",
    );
    expect(scheduled).toHaveLength(1);
    const [event] = scheduled;
    if (event === undefined) throw new Error("expected a diagnostic record");
    expect(event.correlationId).toBe("scheduling-failure-correlation-1");
    expect(event.source).toBe("chat.compaction.model-summary");
    expect(event.errorClass).toBe("Error");
    expect(enrichChatCompactionWithModelSummary).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({ correlationId: "scheduling-failure-correlation-1" }),
    );
  });

  it("no longer logs a scheduled-enrichment failure through console.warn", () => {
    const source = readFileSync(new URL("./chat-handlers.ts", import.meta.url), "utf8");
    expect(source).not.toContain("console.warn(");
  });
});
