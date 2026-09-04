import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  parseGatewayConfig,
  type GatewayConfig,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  chatTurnShapeFields,
  handleCreateDesktopChat,
  handleSendDesktopChat,
  parseClientTurnId,
  parseExpectedGroundingScopeIdentity,
} from "./chat-handlers.js";
import { buildRedactor, buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "./diagnostics-log.js";
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

function requestContext(body: Record<string, unknown>): RouteContext {
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
    correlationId: undefined,
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
): Promise<Awaited<ReturnType<typeof handleSendDesktopChat>>> {
  return handleSendDesktopChat(
    requestContext({
      chatId: fixture.chatId,
      projectPath: fixture.projectPath,
      modelId: "breaker-chat",
      content,
    }),
    fixture.deps,
  );
}

describe("desktop chat production gateway reuse", () => {
  it("keeps user content off the provider while probing an unready model on demand", async () => {
    const fixture = await createGatewayBreakerFixture();
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    try {
      fixture.deps.gatewayConfig?.clearVerifiedCapability("breaker-chat");
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const createRejected = await handleCreateDesktopChat(
        requestContext({
          modelId: "breaker-chat",
          projectPath: fixture.projectPath,
          title: "must not be created",
        }),
        fixture.deps,
      );
      const rejected = await sendBreakerChat(fixture, "must not leave the server");

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
          status: 400,
          errorKind: "model-not-ready",
          extra: { reason: "readiness", modelKind: "chat" },
        }),
      );
    } finally {
      vi.unstubAllGlobals();
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
