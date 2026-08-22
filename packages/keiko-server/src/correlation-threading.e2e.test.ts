// Wave 3 ACCEPTANCE TEST (epic #3233, ADR-0173 D5, final-design.md §7) — proves, against the REAL
// `createUiServer` route handler (never a bare handler function call), that ONE correlation id
// threads end to end: from an inbound HTTP/WS header, through the BFF, through the model gateway's
// own activity-log lines, and back onto the response — and that a forced provider failure's
// redacted diagnostic record and the gateway's own retry line carry that id plus the provider-
// detail fields g26 added. Where an assertion cannot pass because the wiring g26/g9 promises is
// not (yet) built, the assertion is left exactly as specified — never weakened — so a fix makes it
// go green rather than a rewrite making it agree with the gap.
//
// Doubles used throughout are either a hand-rolled fake `ModelPort` (a bare object implementing the
// port) or a REAL `Gateway` instance wired with a fake `ProviderAdapter` / `createScriptedGatewayFetch`
// (ADR-0173 §7.3) — never a mocked HTTP layer — so the gateway's own logging code actually runs.

import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { GatewayModelPort, type ModelPort } from "@oscharko-dev/keiko-harness";
import {
  Gateway,
  createScriptedGatewayClock,
  createScriptedGatewayFetch,
  type GatewayConfig,
  type GatewayReplayScriptEntry,
  type ModelProviderConfig,
  type NormalizedResponse,
  type ProviderAdapter,
  type RealtimeNegotiationOutcome,
} from "@oscharko-dev/keiko-model-gateway";
import { RateLimitError } from "@oscharko-dev/keiko-security/errors/gateway";

import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import { createUiServer, UI_HOST } from "./server.js";
import { buildCspHeader } from "./csp.js";
import { CORRELATION_HEADER } from "./correlation.js";
import { VOICE_LIVE_TRANSCRIBE_PATH } from "./voice-live-dictation.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
  type ServerLogEvent,
} from "./observability/index.js";
import { closeUiTestServer, startUiTestServer } from "./ui-test-server/_support.js";

const OFFER_SDP =
  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendonly\r\n";

// ─── Shared config/double builders ──────────────────────────────────────────────

function bffGatewayConfig(modelId: string, supportsImageInput = false): GatewayConfig {
  return {
    providers: [
      {
        modelId,
        baseUrl: "https://bff-provider.example.invalid/v1",
        apiKey: "unused-bff-test-key",
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
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        supportsImageInput,
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

function gatewayProvider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    modelId: "gw-model",
    baseUrl: "https://provider.example.invalid/v1",
    apiKey: "gw-test-secret-key-1234567890ab",
    timeoutMs: 30_000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

function gatewayLevelConfig(providers: readonly ModelProviderConfig[]): GatewayConfig {
  return {
    providers: [...providers],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
  };
}

function okResponse(modelId: string, content: string): NormalizedResponse {
  return {
    modelId,
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "gw-test-request",
      promptTokens: 3,
      completionTokens: 2,
      latencyMs: 4,
      costClass: "low",
    },
  };
}

function fakeAdapter(impl: ProviderAdapter["call"]): ProviderAdapter {
  return { call: impl };
}

function okChatBody(content: string): unknown {
  return {
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  };
}

function minimalDeps(overrides: Partial<UiHandlerDeps>): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    ...overrides,
  };
}

// Seeds exactly ONE prior turn that contributes exactly ONE gateway message: a legacy (no
// client_turn_id) user/assistant pair whose assistant half is the exact legacy-empty-response
// placeholder `usableGatewayMessages` (conversation-gateway.ts) drops via
// `isLegacyEmptyAssistantPlaceholder`. The store's scan layer (messages.ts's
// `scanLegacyGatewayRow`) still counts the pair as ONE eligible history unit, but only the user
// half survives into the assembled prompt — giving a real, production-path-derived odd total
// (system + priorUser + currentUser = 3) instead of guessing at internal counting rules.
function seedLegacyPriorTurn(store: UiStore, chatId: string): void {
  const seededAt = Date.now() - 60_000;
  const base = {
    chatId,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
  store.createMessage({ ...base, role: "user", content: "Earlier question", timestamp: seededAt });
  store.createMessage({
    ...base,
    role: "assistant",
    content: "The model returned an empty response.",
    timestamp: seededAt + 1_000,
  });
}

// ─── Server lifecycle ───────────────────────────────────────────────────────────

let activeServer: Server | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  resetServerLogger();
  if (activeServer !== undefined) {
    await closeUiTestServer(activeServer);
    activeServer = undefined;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempProjectDir(prefix: string): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  tempDirs.push(root);
  const projectPath = join(root, "repo");
  mkdirSync(projectPath);
  return projectPath;
}

async function boot(
  handlerDeps: UiHandlerDeps,
  activityLog?: BufferedServerLogSink,
): Promise<number> {
  const staticRoot = mkdtempSync(join(realpathSync(tmpdir()), "keiko-correlation-static-"));
  tempDirs.push(staticRoot);
  const started = await startUiTestServer({
    staticRoot,
    csp: buildCspHeader([]),
    handlerDeps,
    ...(activityLog === undefined ? {} : { activityLog }),
  });
  activeServer = started.server;
  return started.port;
}

function baseUrl(port: number): string {
  return `http://${UI_HOST}:${String(port)}`;
}

function jsonHeaders(correlationId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Keiko-CSRF": "1",
    [CORRELATION_HEADER]: correlationId,
  };
}

// `startUiTestServer` (used by `boot` above) binds an ephemeral port by mutating its
// `UiServerDeps.port` field AFTER `createUiServer` has already run — fine for the HTTP path,
// which re-reads `deps.port` on every request, but NOT for the voice planes: `createUiServer`
// captures `deps.port` BY VALUE, once, into `createVoicePlanes(deps.port, handlerDeps)` at
// construction time, so a WS upgrade's own `isAllowedHost` check would keep comparing against the
// port-0 snapshot forever and hard-reject every upgrade with a 404. Mirrors
// voice-control-ws.test.ts's own `boot()`: probe an ephemeral port, close that throwaway server,
// then construct the REAL server with the correct port already baked in.
async function bootForVoice(handlerDeps: UiHandlerDeps): Promise<number> {
  const staticRoot = mkdtempSync(join(realpathSync(tmpdir()), "keiko-correlation-voice-static-"));
  tempDirs.push(staticRoot);
  const csp = buildCspHeader([]);
  const probe = createUiServer({ staticRoot, csp, port: 0, handlerDeps });
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, UI_HOST, () => {
      resolve((probe.address() as AddressInfo).port);
    });
  });
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  const listening = createUiServer({ staticRoot, csp, port, handlerDeps });
  activeServer = listening;
  await new Promise<void>((resolve) => {
    listening.listen(port, UI_HOST, resolve);
  });
  return port;
}

// Polls the buffered sink instead of assuming synchronous availability: `gateway.*`/`chat.turn.*`
// lines are written before the response leaves, but the `http`/`request` line is written from
// `res.on("close")`, which can fire a tick after `fetch()`'s promise settles (AGENTS.md §9 — await
// a condition instead of sleeping).
async function waitForEvent(
  sink: BufferedServerLogSink,
  predicate: (event: ServerLogEvent) => boolean,
  timeoutMs = 2_000,
): Promise<ServerLogEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = sink.events.find(predicate);
    if (found !== undefined) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the expected activity log event");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

// ─── WS helpers (mirrors voice-control-ws.test.ts's proven `connect`/`expectOpen`) ─────────────

interface WsClient {
  readonly opened: boolean;
  readonly ws?: WebSocket;
  readonly next?: () => Promise<Record<string, unknown>>;
}

function connectWs(
  port: number,
  options: { readonly path: string; readonly headers?: Record<string, string> },
): Promise<WsClient> {
  const headers: Record<string, string> = {
    Origin: `http://${UI_HOST}:${String(port)}`,
    ...(options.headers ?? {}),
  };
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${UI_HOST}:${String(port)}${options.path}`, { headers });
    const queue: Record<string, unknown>[] = [];
    const waiters: ((message: Record<string, unknown>) => void)[] = [];
    ws.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter(message);
      } else {
        queue.push(message);
      }
    });
    const next = (): Promise<Record<string, unknown>> => {
      const queued = queue.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      return new Promise((resolveMessage) => waiters.push(resolveMessage));
    };
    ws.once("open", () => {
      resolve({ opened: true, ws, next });
    });
    ws.once("unexpected-response", () => {
      ws.terminate();
      resolve({ opened: false });
    });
    ws.once("error", () => {
      resolve({ opened: false });
    });
  });
}

interface OpenWsClient {
  readonly ws: WebSocket;
  readonly next: () => Promise<Record<string, unknown>>;
}

function expectOpen(client: WsClient): OpenWsClient {
  if (!client.opened || client.ws === undefined || client.next === undefined) {
    throw new Error("expected the WebSocket upgrade to be accepted");
  }
  return { ws: client.ws, next: client.next };
}

function voiceRealtimeConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: "keiko-realtime-e2e",
        baseUrl: "https://realtime.example.invalid",
        apiKey: "rt-e2e-secret-token-1234567890",
        timeoutMs: 1_000,
        maxRetries: 0,
        retryBaseDelayMs: 10,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
    capabilities: [
      {
        id: "keiko-realtime-e2e",
        kind: "voice",
        contextWindow: 0,
        maxOutputTokens: 0,
        toolCalling: false,
        structuredOutput: false,
        streaming: false,
        supportsImageInput: false,
        supportsDocumentInput: false,
        supportsSpeechInput: true,
        supportsRealtimeVoice: true,
        realtimeTranscriptionModel: "configured-realtime-transcription",
        voiceProviderLocality: "azure-foundry",
        workflowEligible: false,
        costClass: "low",
        latencyClass: "fast",
        throughputHint: "azure foundry realtime",
        preferredUseCases: ["Conversation"],
        knownLimitations: [],
      },
    ],
  };
}

function liveSessionCreate(): string {
  return JSON.stringify({
    protocolVersion: "1",
    sessionId: "sess-e2e-1",
    seq: 0,
    direction: "client-to-host",
    kind: "session.create",
    idempotencyKey: "idem-e2e-1",
    requestedProfile: "full-realtime",
    negotiationMode: "proxied-sdp",
  });
}

function offerFrame(seq: number): string {
  return JSON.stringify({
    protocolVersion: "1",
    sessionId: "sess-e2e-1",
    seq,
    direction: "client-to-host",
    kind: "signal.sdp.offer",
    sdp: OFFER_SDP,
  });
}

// ─── (1) desktop chat turn — one correlation id end to end (ADR-0173 D5 §7.1, §7.4) ─────────────

describe("desktop chat turn — one correlation id end to end", () => {
  it("threads a client-supplied X-Keiko-Correlation-Id onto the http line, gateway.chat.completed, and the response header", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));

    const modelId = "correlation-thread-model";
    const projectPath = tempProjectDir("keiko-correlation-thread-");
    const store = createInMemoryUiStore();
    store.createProject(projectPath, "repo");
    const chat = store.createChat(projectPath, "Thread", modelId);

    const gateway = new Gateway(gatewayLevelConfig([gatewayProvider({ modelId })]), {
      adapter: fakeAdapter(() => Promise.resolve(okResponse(modelId, "hello there"))),
      clock: createScriptedGatewayClock(),
      log: sink,
    });
    const modelPort: ModelPort = new GatewayModelPort(gateway);

    const port = await boot(
      minimalDeps({
        config: bffGatewayConfig(modelId),
        configPresent: true,
        store,
        modelPortFactory: () => modelPort,
      }),
      sink,
    );

    const correlationId = "e2e-correlation-thread-0001";
    const res = await fetch(`${baseUrl(port)}/api/desktop/chat`, {
      method: "POST",
      headers: jsonHeaders(correlationId),
      body: JSON.stringify({ chatId: chat.id, projectPath, modelId, content: "Hello" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-keiko-correlation-id")).toBe(correlationId);

    const httpLine = await waitForEvent(
      sink,
      (event) =>
        event.category === "http" &&
        event.op === "request" &&
        event.correlationId === correlationId,
    );
    expect(httpLine.op).toBe("request");

    const completed = await waitForEvent(sink, (event) => event.op === "gateway.chat.completed");
    expect(completed.correlationId).toBe(correlationId);
  });
});

// ─── (2a) forced RateLimitError — diagnostic record field wiring (ADR-0173 D5 g26) ──────────────

describe("forced RateLimitError — diagnostic record field wiring", () => {
  it("keeps the request's correlation id on the diagnostic record and carries retryAfterMs/httpStatus", async () => {
    const modelId = "rate-limit-diagnostic-model";
    const projectPath = tempProjectDir("keiko-correlation-ratelimit-");
    const store = createInMemoryUiStore();
    store.createProject(projectPath, "repo");
    const chat = store.createChat(projectPath, "Rate limited", modelId);

    const diagnostics: ServerDiagnosticRecord[] = [];
    const rateLimitedModel: ModelPort = {
      call: () => Promise.reject(new RateLimitError("provider rate limited", 4_000)),
    };

    const port = await boot(
      minimalDeps({
        config: bffGatewayConfig(modelId),
        configPresent: true,
        store,
        modelPortFactory: () => rateLimitedModel,
        diagnostics: { record: (record): void => void diagnostics.push(record) },
      }),
    );

    const correlationId = "e2e-correlation-ratelimit-0001";
    const res = await fetch(`${baseUrl(port)}/api/desktop/chat`, {
      method: "POST",
      headers: jsonHeaders(correlationId),
      body: JSON.stringify({
        chatId: chat.id,
        projectPath,
        modelId,
        content: "Trigger a rate limit",
      }),
    });

    expect(res.status).toBe(503);
    expect(diagnostics).toHaveLength(1);
    const [record] = diagnostics;
    expect(record).toBeDefined();
    expect(record?.correlationId).toBe(correlationId);

    // g26 (final-design.md §2, ServerDiagnosticRecord v2): httpStatus/retryAfterMs are derived
    // through `describeError` → `providerErrorDetail()` (keiko-model-gateway/resilience.ts), the
    // SAME instanceof-based derivation `gateway.retry.*` lines use. `httpStatus` is read off BOTH
    // `ProviderError` and `RateLimitError`: a rate-limited call is always HTTP 429 by definition,
    // so this diagnostic record carries httpStatus=429 alongside retryAfterMs — a replay-script
    // consumer (`GatewayReplayAttempt.httpStatus`) never has to infer the status from
    // `errorKind === GATEWAY_RATE_LIMIT`.
    const detail = record as unknown as {
      readonly httpStatus?: number;
      readonly retryAfterMs?: number;
    };
    expect(detail.retryAfterMs).toBe(4_000);
    expect(detail.httpStatus).toBe(429);
  });
});

// ─── (2b) scripted 429-then-200 — gateway.retry.scheduled field wiring (ADR-0173 D5 g26, §7.3) ──

describe("scripted 429-then-200 retry — gateway.retry.scheduled field wiring", () => {
  it("recovers via the real retry path and carries the request's correlation id + httpStatus=429 onto gateway.retry.scheduled", async () => {
    const modelId = "retry-recovery-model";
    const projectPath = tempProjectDir("keiko-correlation-retry-");
    const store = createInMemoryUiStore();
    store.createProject(projectPath, "repo");
    const chat = store.createChat(projectPath, "Retry recovery", modelId);

    const sharedClock = createScriptedGatewayClock();
    const script: readonly GatewayReplayScriptEntry[] = [
      {
        status: 429,
        headers: { "retry-after": "1" },
        bodyJson: { error: { message: "slow down" } },
        latencyMs: 0,
      },
      { status: 200, bodyJson: okChatBody("recovered"), latencyMs: 0 },
    ];
    const fetchImpl = createScriptedGatewayFetch(script, sharedClock);
    const sink = createBufferedServerLogSink();
    const gateway = new Gateway(
      gatewayLevelConfig([gatewayProvider({ modelId, maxRetries: 1, retryBaseDelayMs: 1 })]),
      { clock: sharedClock, fetchImpl, log: sink, random: (): number => 0.5 },
    );
    const modelPort: ModelPort = new GatewayModelPort(gateway);

    const port = await boot(
      minimalDeps({
        config: bffGatewayConfig(modelId),
        configPresent: true,
        store,
        modelPortFactory: () => modelPort,
      }),
    );

    const correlationId = "e2e-correlation-retry-0001";
    const res = await fetch(`${baseUrl(port)}/api/desktop/chat`, {
      method: "POST",
      headers: jsonHeaders(correlationId),
      body: JSON.stringify({ chatId: chat.id, projectPath, modelId, content: "Please recover" }),
    });

    expect(res.status).toBe(200);
    const scheduled = await waitForEvent(sink, (event) => event.op === "gateway.retry.scheduled");
    expect(scheduled.correlationId).toBe(correlationId);
    // g26: resilience.ts's providerErrorDetail() reads httpStatus off a RateLimitError instance
    // too, deliberately — the 429 response mapped here to RateLimitError
    // (packages/keiko-model-gateway/src/openai-adapter.ts, response.status === 429) is always HTTP
    // 429 by definition, so the scheduled retry line carries httpStatus=429 alongside the
    // provider-supplied retryAfterMs, instead of forcing a consumer to infer the status from
    // errorKind === GATEWAY_RATE_LIMIT.
    expect(scheduled.extra?.httpStatus).toBe(429);
    expect(scheduled.extra?.retryAfterMs).toBe(1_000);
  });
});

// ─── (3) chat.turn.started shape fields (ADR-0173 D5 g9) ────────────────────────────────────────

describe("chat.turn.started shape fields — 3-message turn with one image attachment", () => {
  it("logs messageCount=3, imageAttachmentCount=1, keyed to the request correlation id", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));

    const modelId = "turn-shape-image-model";
    const projectPath = tempProjectDir("keiko-correlation-turnshape-");
    const store = createInMemoryUiStore();
    store.createProject(projectPath, "repo");
    const chat = store.createChat(projectPath, "Turn shape", modelId);
    seedLegacyPriorTurn(store, chat.id);

    const gateway = new Gateway(gatewayLevelConfig([gatewayProvider({ modelId })]), {
      adapter: fakeAdapter(() => Promise.resolve(okResponse(modelId, "looked at it"))),
      clock: createScriptedGatewayClock(),
      log: sink,
    });
    const modelPort: ModelPort = new GatewayModelPort(gateway);

    const port = await boot(
      minimalDeps({
        config: bffGatewayConfig(modelId, true),
        configPresent: true,
        store,
        modelPortFactory: () => modelPort,
      }),
      sink,
    );

    const correlationId = "e2e-correlation-turnshape-0001";
    // `chat.turn.started` is logged from the BASE assembly, before image content parts are
    // spliced in (chat-handlers.ts's own comment on `logChatTurnStarted`'s call site) — so it is
    // written even though this send goes on to be refused at the UNRELATED image-delivery-
    // authority gate a few lines later (no `attachmentAuthority`/`attachmentIntent` supplied here;
    // that gate is a distinct security check this test does not exercise). The response status is
    // therefore deliberately not asserted here — only the shape fields the gateway op carries.
    await fetch(`${baseUrl(port)}/api/desktop/chat`, {
      method: "POST",
      headers: jsonHeaders(correlationId),
      body: JSON.stringify({
        chatId: chat.id,
        projectPath,
        modelId,
        content: "Look at this",
        attachments: [{ kind: "image", mimeType: "image/png", sizeBytes: 1_024 }],
      }),
    });

    const started = await waitForEvent(
      sink,
      (event) => event.op === "chat.turn.started" && event.correlationId === correlationId,
    );
    expect(started.category).toBe("gateway");
    expect(started.extra).toMatchObject({ messageCount: 3, imageAttachmentCount: 1 });
  });
});

// ─── (4) voice live-dictation WS upgrade — one correlation id across two diagnostics (g15) ──────

describe("voice live-dictation WS upgrade — one correlation id across two diagnostics", () => {
  it("carries the client-supplied X-Keiko-Correlation-Id onto two successive negotiation-failure diagnostics", async () => {
    const diagnostics: ServerDiagnosticRecord[] = [];
    const port = await bootForVoice(
      minimalDeps({
        config: voiceRealtimeConfig(),
        configPresent: true,
        diagnostics: { record: (record): void => void diagnostics.push(record) },
        voiceRealtimeNegotiationRequest: (): Promise<RealtimeNegotiationOutcome> =>
          Promise.resolve({ ok: false, kind: "wrong-header" }),
      }),
    );

    const correlationId = "e2e-correlation-voice-0001";
    const { ws: socket, next } = expectOpen(
      await connectWs(port, {
        path: VOICE_LIVE_TRANSCRIBE_PATH,
        headers: { [CORRELATION_HEADER]: correlationId },
      }),
    );

    socket.send(liveSessionCreate());
    await next(); // session.created
    await next(); // capability.offer

    socket.send(offerFrame(1));
    await next(); // media.track.state negotiating
    const firstFailure = await next();
    await next(); // media.track.state ended

    socket.send(offerFrame(2));
    await next(); // media.track.state negotiating
    const secondFailure = await next();
    await next(); // media.track.state ended

    expect(firstFailure.correlationId).toBe(correlationId);
    expect(secondFailure.correlationId).toBe(correlationId);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]?.correlationId).toBe(correlationId);
    expect(diagnostics[1]?.correlationId).toBe(correlationId);
    socket.close();
  });
});
