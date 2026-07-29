// Integration tests for the capability-gated WebSocket voice control upgrade (Issue #497). Boots the
// real BFF (createUiServer) on a loopback ephemeral port and connects a real `ws` client, asserting
// the upgrade is hard-rejected for every non-full-realtime deployment / bad origin / wrong path, and
// accepted only for a full-realtime deployment on a loopback origin — then drives the proxied-SDP
// handshake end to end. This is the security-critical gate (ADR-0100 D3/D6, AC1/AC3).

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { WebSocket } from "ws";
import { createUiServer, UI_HOST } from "./server.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import { MAX_VOICE_CONTROL_FRAME_BYTES } from "./voice-realtime.js";
import { VOICE_LIVE_TRANSCRIBE_PATH } from "./voice-live-dictation.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { Chat } from "./store/index.js";
import {
  type GatewayConfig,
  type RealtimeNegotiationRequest,
} from "@oscharko-dev/keiko-model-gateway";

const ANSWER_SDP =
  "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n";
const OFFER_SDP =
  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendonly\r\n";

function voiceConfig(
  realtime: boolean,
  providerOverrides: Partial<GatewayConfig["providers"][number]> = {},
  capabilityOverrides: Partial<NonNullable<GatewayConfig["capabilities"]>[number]> = {},
): GatewayConfig {
  return {
    providers: [
      {
        modelId: "keiko-realtime",
        baseUrl: "https://realtime.example.com",
        apiKey: "rt-secret-token-1234567890",
        timeoutMs: 1000,
        maxRetries: 2,
        retryBaseDelayMs: 10,
        ...providerOverrides,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 },
    capabilities: [
      {
        id: "keiko-realtime",
        kind: "voice",
        contextWindow: 0,
        maxOutputTokens: 0,
        toolCalling: false,
        structuredOutput: false,
        streaming: false,
        supportsImageInput: false,
        supportsDocumentInput: false,
        supportsSpeechInput: true,
        ...(realtime
          ? {
              supportsRealtimeVoice: true,
              realtimeTranscriptionModel: "configured-realtime-transcription",
            }
          : {}),
        voiceProviderLocality: "azure-foundry",
        workflowEligible: false,
        costClass: "low",
        latencyClass: "fast",
        throughputHint: "azure foundry realtime",
        preferredUseCases: ["Conversation"],
        knownLimitations: [],
        ...capabilityOverrides,
      },
    ],
  };
}

const CHAT_ONLY_CONFIG: GatewayConfig = {
  providers: [
    {
      modelId: "chat",
      baseUrl: "https://api.example.com",
      apiKey: "chat-token-1234567890",
      timeoutMs: 1000,
      maxRetries: 2,
      retryBaseDelayMs: 10,
    },
  ],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 },
  capabilities: [
    {
      id: "chat",
      kind: "chat",
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      toolCalling: true,
      structuredOutput: true,
      streaming: true,
      supportsImageInput: false,
      supportsDocumentInput: false,
      workflowEligible: false,
      costClass: "medium",
      latencyClass: "standard",
      throughputHint: "",
      preferredUseCases: [],
      knownLimitations: [],
    },
  ],
};

function depsWith(overrides: Partial<UiHandlerDeps>): UiHandlerDeps {
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

function depsWithChat(overrides: Partial<UiHandlerDeps>): { deps: UiHandlerDeps; chat: Chat } {
  const store = createInMemoryUiStore();
  const projectPath = mkdtempSync(join(tmpdir(), "keiko-voice-control-"));
  store.createProject(projectPath, "Voice control test");
  const chat = store.createChat(projectPath, "Voice chat", "chat");
  return { deps: depsWith({ store, ...overrides }), chat };
}

let server: Server | undefined;

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current !== undefined) {
    await new Promise<void>((res) => {
      current.close(() => {
        res();
      });
    });
  }
});

async function boot(handlerDeps: UiHandlerDeps): Promise<number> {
  const staticRoot = tmpdir();
  const csp = "default-src 'none'";
  const probe = createUiServer({ staticRoot, csp, port: 0, handlerDeps });
  const port = await new Promise<number>((res) =>
    probe.listen(0, UI_HOST, () => {
      res((probe.address() as AddressInfo).port);
    }),
  );
  await new Promise<void>((res) =>
    probe.close(() => {
      res();
    }),
  );
  const listening = createUiServer({ staticRoot, csp, port, handlerDeps });
  server = listening;
  await new Promise<void>((res) => {
    listening.listen(port, UI_HOST, res);
  });
  return port;
}

interface Client {
  readonly opened: boolean;
  readonly ws?: WebSocket;
  // Queue-based reader so messages emitted back-to-back are never dropped between awaits.
  readonly next?: () => Promise<Record<string, unknown>>;
}

function connect(
  port: number,
  options: { path?: string; headers?: Record<string, string>; omitOrigin?: boolean } = {},
): Promise<Client> {
  const path = options.path ?? "/api/voice/control";
  // A browser always sends Origin on a WS handshake; default to a loopback Origin so the accept tests
  // mirror a real browser. `omitOrigin` / an explicit Origin header exercise the gate's edge cases.
  const headers: Record<string, string> = {
    ...(options.omitOrigin === true ? {} : { Origin: `http://${UI_HOST}:${String(port)}` }),
    ...(options.headers ?? {}),
  };
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${UI_HOST}:${String(port)}${path}`, { headers });
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

interface OpenClient {
  readonly ws: WebSocket;
  readonly next: () => Promise<Record<string, unknown>>;
}

// Asserts the client opened and narrows ws/next to non-optional (no `!` / `as` needed downstream).
function expectOpen(client: Client): OpenClient {
  expect(client.opened).toBe(true);
  const { ws, next } = client;
  if (ws === undefined || next === undefined) {
    throw new Error("expected an open control client");
  }
  return { ws, next };
}

function nextClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once("close", (code: number) => {
      resolve(code);
    });
  });
}

function sessionCreate(chatId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocolVersion: "1",
    sessionId: "sess-int-1",
    seq: 0,
    direction: "client-to-host",
    kind: "session.create",
    idempotencyKey: "idem-int-1",
    requestedProfile: "full-realtime",
    negotiationMode: "proxied-sdp",
    chatContext: { chatId },
    ...extra,
  });
}

function sessionCreateWithIdentity(
  chatId: string,
  sessionId: string,
  idempotencyKey: string,
): string {
  return sessionCreate(chatId, { sessionId, idempotencyKey });
}

function liveSessionCreate(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocolVersion: "1",
    sessionId: "sess-live-1",
    seq: 0,
    direction: "client-to-host",
    kind: "session.create",
    idempotencyKey: "idem-live-1",
    requestedProfile: "full-realtime",
    negotiationMode: "proxied-sdp",
    ...extra,
  });
}

function expectNoRealtimeAssistantAuthority(request: RealtimeNegotiationRequest | undefined): void {
  const record = request as unknown as Record<string, unknown> | undefined;
  expect(record?.instructions).toBeUndefined();
  expect(record?.voiceId).toBeUndefined();
  expect(record?.tools).toBeUndefined();
  expect(record?.toolChoice).toBeUndefined();
  expect(record?.disableAutomaticResponse).toBeUndefined();
}

describe("WebSocket voice control upgrade — capability gate (AC1/AC3)", () => {
  it("rejects the upgrade for a no-voice (chat-only) deployment", async () => {
    const port = await boot(depsWith({ config: CHAT_ONLY_CONFIG, configPresent: true }));
    const result = await connect(port);
    expect(result.opened).toBe(false);
  });

  it("rejects the upgrade for an STT-only deployment (not full-realtime)", async () => {
    const port = await boot(depsWith({ config: voiceConfig(false), configPresent: true }));
    const result = await connect(port);
    expect(result.opened).toBe(false);
  });

  it("rejects the upgrade when voice is disabled by policy even if realtime-capable", async () => {
    const port = await boot(
      depsWith({
        config: voiceConfig(true),
        configPresent: true,
        env: { KEIKO_VOICE_DISABLED: "1" },
      }),
    );
    const result = await connect(port);
    expect(result.opened).toBe(false);
  });

  it("rejects an upgrade on any other path", async () => {
    const port = await boot(depsWith({ config: voiceConfig(true), configPresent: true }));
    const result = await connect(port, { path: "/api/voice/other" });
    expect(result.opened).toBe(false);
  });

  it("rejects an upgrade carrying a non-loopback Origin (cross-origin defense)", async () => {
    const port = await boot(depsWith({ config: voiceConfig(true), configPresent: true }));
    const result = await connect(port, { headers: { Origin: "http://evil.example.com" } });
    expect(result.opened).toBe(false);
  });

  it("rejects an upgrade with no Origin header (browser always sends one)", async () => {
    const port = await boot(depsWith({ config: voiceConfig(true), configPresent: true }));
    const result = await connect(port, { omitOrigin: true });
    expect(result.opened).toBe(false);
  });

  it("rejects dialogue before session start when the transcription alias is absent", async () => {
    const config = voiceConfig(true, {}, { realtimeTranscriptionModel: undefined });
    const port = await boot(depsWith({ config, configPresent: true }));

    const result = await connect(port);

    expect(result.opened).toBe(false);
  });

  it("accepts the upgrade for a full-realtime deployment and announces the session", async () => {
    const { deps, chat } = depsWithChat({ config: voiceConfig(true), configPresent: true });
    const port = await boot(deps);
    const { ws, next } = expectOpen(await connect(port));
    ws.send(sessionCreate(chat.id));
    const created = await next();
    expect(created).toMatchObject({
      kind: "session.created",
      profile: "full-realtime",
      controlTransport: "loopback-websocket",
      mediaTransport: "webrtc",
      negotiationMode: "proxied-sdp",
    });
    const offer = await next();
    expect(offer).toMatchObject({
      kind: "capability.offer",
      capabilities: {
        speechToText: true,
        speechOutput: false,
        realtimeVoice: true,
      },
    });
    ws.close();
  });
});

describe("WebSocket live dictation upgrade — transcription-only control plane", () => {
  it("rejects the live dictation upgrade for an STT-only deployment", async () => {
    const port = await boot(depsWith({ config: voiceConfig(false), configPresent: true }));
    const result = await connect(port, { path: VOICE_LIVE_TRANSCRIBE_PATH });
    expect(result.opened).toBe(false);
  });

  it("negotiates a transcription-only realtime session without dialogue fields", async () => {
    let seenRequest: RealtimeNegotiationRequest | undefined;
    const egress = {
      httpsProxy: "http://egress-proxy.internal:8080",
      noProxy: ["127.0.0.1"],
    };
    const port = await boot(
      depsWith({
        config: voiceConfig(true, {
          realtimeAuthMode: "ephemeral-session",
          timeoutMs: 30_000,
          egress,
        }),
        configPresent: true,
        voiceRealtimeNegotiationRequest: (request) => {
          seenRequest = request;
          return Promise.resolve({
            ok: true,
            value: { answerSdp: ANSWER_SDP },
          });
        },
      }),
    );
    const { ws: socket, next } = expectOpen(
      await connect(port, { path: VOICE_LIVE_TRANSCRIBE_PATH }),
    );
    socket.send(liveSessionCreate({ transcriptionLanguage: "en" }));
    expect(await next()).toMatchObject({
      kind: "session.created",
      profile: "full-realtime",
      controlTransport: "loopback-websocket",
      mediaTransport: "webrtc",
      negotiationMode: "proxied-sdp",
    });
    expect(await next()).toMatchObject({
      kind: "capability.offer",
      capabilities: {
        speechToText: true,
        speechOutput: false,
        realtimeVoice: true,
      },
    });
    socket.send(
      JSON.stringify({
        protocolVersion: "1",
        sessionId: "sess-live-1",
        seq: 1,
        direction: "client-to-host",
        kind: "signal.sdp.offer",
        sdp: OFFER_SDP,
      }),
    );

    expect(await next()).toMatchObject({
      kind: "media.track.state",
      track: "audio-in",
      state: "negotiating",
    });
    expect(await next()).toMatchObject({ kind: "signal.sdp.answer", sdp: ANSWER_SDP });
    expect(seenRequest).toMatchObject({
      endpoint: "https://realtime.example.com",
      modelId: "keiko-realtime",
      realtimeAuthMode: "ephemeral-session",
      sessionType: "transcription",
      transcriptionModel: "configured-realtime-transcription",
      transcriptionLanguage: "en",
      offerSdp: OFFER_SDP,
      timeoutMs: 12_000,
    });
    expectNoRealtimeAssistantAuthority(seenRequest);
    expect(seenRequest?.transcriptionDelay).toBeUndefined();
    expect(seenRequest?.safetyIdentifier).toBeUndefined();
    expect(seenRequest?.egress).toEqual(egress);
    socket.close();
  });

  it("correlates a provider negotiation failure with a body-free operator diagnostic", async () => {
    const diagnostics: ServerDiagnosticRecord[] = [];
    const port = await boot(
      depsWith({
        config: voiceConfig(true, { apiKey: "provider-secret-never-diagnosed" }),
        configPresent: true,
        diagnostics: { record: (record): void => void diagnostics.push(record) },
        voiceRealtimeNegotiationRequest: () => Promise.resolve({ ok: false, kind: "wrong-header" }),
      }),
    );
    const { ws: socket, next } = expectOpen(
      await connect(port, { path: VOICE_LIVE_TRANSCRIBE_PATH }),
    );
    socket.send(liveSessionCreate());
    await next(); // session.created
    await next(); // capability.offer
    socket.send(
      JSON.stringify({
        protocolVersion: "1",
        sessionId: "sess-live-1",
        seq: 1,
        direction: "client-to-host",
        kind: "signal.sdp.offer",
        sdp: OFFER_SDP,
      }),
    );

    await next(); // media.track.state negotiating
    const failure = await next();
    expect(failure).toMatchObject({
      kind: "error",
      code: "negotiation-failed",
    });
    expect(failure.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await next()).toMatchObject({
      kind: "media.track.state",
      track: "audio-in",
      state: "ended",
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      correlationId: failure.correlationId,
      operation: "voice.live-dictation.negotiate",
      source: "voice.live-dictation",
      errorClass: "LiveDictationNegotiationError",
      code: "wrong-header",
      message: "server-operation-failed",
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("provider-secret-never-diagnosed");
    expect(serialized).not.toContain(OFFER_SDP);
    expect(serialized).not.toContain("realtime.example.com");
    socket.close();
  });

  it("classifies a thrown negotiation failure in one body-free correlated diagnostic", async (): Promise<void> => {
    const diagnostics: ServerDiagnosticRecord[] = [];
    const port = await boot(
      depsWith({
        config: voiceConfig(true),
        configPresent: true,
        diagnostics: { record: (record): void => void diagnostics.push(record) },
        voiceRealtimeNegotiationRequest: async (): Promise<never> => {
          await Promise.resolve();
          throw new Error("provider-secret-throw-never-diagnosed");
        },
      }),
    );
    const { ws: socket, next } = expectOpen(
      await connect(port, { path: VOICE_LIVE_TRANSCRIBE_PATH }),
    );
    socket.send(liveSessionCreate());
    await next(); // session.created
    await next(); // capability.offer
    socket.send(
      JSON.stringify({
        protocolVersion: "1",
        sessionId: "sess-live-1",
        seq: 1,
        direction: "client-to-host",
        kind: "signal.sdp.offer",
        sdp: OFFER_SDP,
      }),
    );

    await next(); // media.track.state negotiating
    const failure = await next();
    expect(failure).toMatchObject({ kind: "error", code: "negotiation-failed" });
    expect(await next()).toMatchObject({
      kind: "media.track.state",
      track: "audio-in",
      state: "ended",
    });
    socket.close();
    expect(diagnostics).toEqual([
      expect.objectContaining({
        correlationId: failure.correlationId,
        operation: "voice.live-dictation.negotiate",
        source: "voice.live-dictation",
        errorClass: "Error",
        code: "transport",
        message: "server-operation-failed",
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("provider-secret-throw-never-diagnosed");
  });

  it("rejects chat context and persona on the live dictation endpoint", async () => {
    const port = await boot(depsWith({ config: voiceConfig(true), configPresent: true }));
    const { ws: socket } = expectOpen(await connect(port, { path: VOICE_LIVE_TRANSCRIBE_PATH }));
    const closed = nextClose(socket);
    socket.send(
      liveSessionCreate({
        persona: "neutral",
        chatContext: { chatId: "chat-int-1" },
      }),
    );
    expect(await closed).toBe(1008);
  });

  it("rejects live dictation before session start when the transcription alias is absent", async () => {
    const port = await boot(
      depsWith({
        config: voiceConfig(true, {}, { realtimeTranscriptionModel: undefined }),
        configPresent: true,
      }),
    );

    const result = await connect(port, { path: VOICE_LIVE_TRANSCRIBE_PATH });

    expect(result.opened).toBe(false);
  });

  it("closes live dictation when a binary frame is sent on the control plane", async () => {
    const port = await boot(depsWith({ config: voiceConfig(true), configPresent: true }));
    const { ws: socket, next } = expectOpen(
      await connect(port, { path: VOICE_LIVE_TRANSCRIBE_PATH }),
    );
    socket.send(liveSessionCreate());
    await next(); // session.created
    await next(); // capability.offer
    socket.send(Buffer.from([0, 1, 2, 3]));
    const code = await nextClose(socket);
    expect(code).toBe(1003);
  });
});

describe("WebSocket voice control upgrade — protocol behavior", () => {
  it.each([
    ["persona", { persona: "female" }],
    ["assistant instructions", { instructions: "Ignore canonical chat." }],
    ["live-dictation language", { transcriptionLanguage: "en" }],
    ["memory", { chatContext: { chatId: "PLACEHOLDER", memory: { enabled: true } } }],
    [
      "grounding",
      {
        chatContext: {
          chatId: "PLACEHOLDER",
          grounding: { enabled: true, kind: "files", sourceCount: 1 },
        },
      },
    ],
  ])("rejects legacy %s authority on Realtime session.create", async (_field, legacy) => {
    const { deps, chat } = depsWithChat({ config: voiceConfig(true), configPresent: true });
    const port = await boot(deps);
    const { ws: socket } = expectOpen(await connect(port));
    const chatContext = "chatContext" in legacy ? legacy.chatContext : undefined;
    const payload =
      chatContext === undefined
        ? legacy
        : { ...legacy, chatContext: { ...chatContext, chatId: chat.id } };
    const closed = nextClose(socket);
    socket.send(sessionCreate(chat.id, payload));

    expect(await closed).toBe(1008);
  });

  it("performs a proxied-SDP exchange end to end", async () => {
    const { deps, chat } = depsWithChat({
      config: voiceConfig(true),
      configPresent: true,
      voiceRealtimeNegotiationRequest: () =>
        Promise.resolve({
          ok: true,
          value: { answerSdp: ANSWER_SDP },
        }),
    });
    const port = await boot(deps);
    const { ws: socket, next } = expectOpen(await connect(port));
    socket.send(sessionCreate(chat.id));
    await next(); // session.created
    await next(); // capability.offer
    socket.send(
      JSON.stringify({
        protocolVersion: "1",
        sessionId: "sess-int-1",
        seq: 1,
        direction: "client-to-host",
        kind: "signal.sdp.offer",
        sdp: OFFER_SDP,
      }),
    );
    await next(); // media.track.state negotiating
    const answer = await next();
    expect(answer).toMatchObject({ kind: "signal.sdp.answer", sdp: ANSWER_SDP });
    socket.close();
  });

  it("rejects a concurrent socket for an attached idempotent session", async () => {
    const { deps, chat } = depsWithChat({ config: voiceConfig(true), configPresent: true });
    const port = await boot(deps);
    const { ws: first, next: nextFirst } = expectOpen(await connect(port));
    first.send(sessionCreate(chat.id));
    await nextFirst();
    await nextFirst();

    const { ws: concurrent } = expectOpen(await connect(port));
    const closed = nextClose(concurrent);
    concurrent.send(sessionCreate(chat.id));

    expect(await closed).toBe(1013);
    first.close();
  });

  it("does not replay a terminally closed session on a later connection", async () => {
    const { deps, chat } = depsWithChat({
      config: voiceConfig(true),
      configPresent: true,
      voiceRealtimeNegotiationRequest: () =>
        Promise.resolve({ ok: true, value: { answerSdp: ANSWER_SDP } }),
    });
    const port = await boot(deps);
    const { ws: first, next: nextFirst } = expectOpen(await connect(port));
    first.send(sessionCreate(chat.id));
    await nextFirst();
    await nextFirst();
    const firstClosed = nextClose(first);
    first.send(
      JSON.stringify({
        protocolVersion: "1",
        sessionId: "sess-int-1",
        seq: 1,
        direction: "client-to-host",
        kind: "session.close",
        reason: "client-request",
      }),
    );
    expect(await nextFirst()).toMatchObject({ kind: "session.closed" });
    expect(await firstClosed).toBe(1000);

    const { ws: reopened, next: nextReopened } = expectOpen(await connect(port));
    try {
      reopened.send(sessionCreate(chat.id));
      expect(await nextReopened()).toMatchObject({ kind: "session.created", seq: 0 });
      expect(await nextReopened()).toMatchObject({ kind: "capability.offer", seq: 1 });
      reopened.send(
        JSON.stringify({
          protocolVersion: "1",
          sessionId: "sess-int-1",
          seq: 1,
          direction: "client-to-host",
          kind: "signal.sdp.offer",
          sdp: OFFER_SDP,
        }),
      );
      expect(await nextReopened()).toMatchObject({
        kind: "media.track.state",
        track: "audio-in",
        state: "negotiating",
      });
    } finally {
      reopened.close();
    }
  });

  it.each(["session", "chat"] as const)(
    "rejects an idempotency key rebound to another %s across reconnect",
    async (mismatch) => {
      const { deps, chat } = depsWithChat({ config: voiceConfig(true), configPresent: true });
      const secondChat = deps.store.createChat(chat.projectPath, "Other voice chat", "chat");
      const port = await boot(deps);
      const identity = {
        sessionId: "sess-bound-1",
        idempotencyKey: "idem-bound-1",
      };
      const { ws: first, next: nextFirst } = expectOpen(await connect(port));
      first.send(sessionCreateWithIdentity(chat.id, identity.sessionId, identity.idempotencyKey));
      await nextFirst();
      await nextFirst();
      const detached = nextClose(first);
      first.close();
      expect(await detached).toBe(1005);

      const { ws: mismatched } = expectOpen(await connect(port));
      const rejected = nextClose(mismatched);
      mismatched.send(
        sessionCreateWithIdentity(
          mismatch === "chat" ? secondChat.id : chat.id,
          mismatch === "session" ? "sess-bound-other" : identity.sessionId,
          identity.idempotencyKey,
        ),
      );
      expect(await rejected).toBe(1008);

      const { ws: resumed, next: nextResumed } = expectOpen(await connect(port));
      try {
        resumed.send(
          sessionCreateWithIdentity(chat.id, identity.sessionId, identity.idempotencyKey),
        );
        expect(await nextResumed()).toMatchObject({ kind: "session.created" });
        expect(await nextResumed()).toMatchObject({ kind: "capability.offer" });
      } finally {
        resumed.close();
      }
    },
  );

  it("passes fail-safe transcription and a client-consistent timeout to realtime negotiation", async () => {
    let seenRequest: RealtimeNegotiationRequest | undefined;
    const { deps, chat } = depsWithChat({
      config: voiceConfig(true, {
        realtimeAuthMode: "ephemeral-session",
        timeoutMs: 30_000,
      }),
      configPresent: true,
      voiceRealtimeNegotiationRequest: (request) => {
        seenRequest = request;
        return Promise.resolve({
          ok: true,
          value: { answerSdp: ANSWER_SDP },
        });
      },
    });
    const port = await boot(deps);
    const { ws: socket, next } = expectOpen(await connect(port));
    socket.send(sessionCreate(chat.id));
    await next(); // session.created
    await next(); // capability.offer
    socket.send(
      JSON.stringify({
        protocolVersion: "1",
        sessionId: "sess-int-1",
        seq: 1,
        direction: "client-to-host",
        kind: "signal.sdp.offer",
        sdp: OFFER_SDP,
      }),
    );
    await next(); // media.track.state negotiating
    await next(); // signal.sdp.answer

    expect(seenRequest).toMatchObject({
      endpoint: "https://realtime.example.com",
      modelId: "keiko-realtime",
      realtimeAuthMode: "ephemeral-session",
      offerSdp: OFFER_SDP,
      transcriptionModel: "configured-realtime-transcription",
      timeoutMs: 12_000,
    });
    expectNoRealtimeAssistantAuthority(seenRequest);
    socket.close();
  });

  it("applies capability-declared semantic VAD and realtime transcription", async () => {
    let seenRequest: RealtimeNegotiationRequest | undefined;
    const { deps, chat } = depsWithChat({
      config: voiceConfig(
        true,
        { realtimeAuthMode: "ephemeral-session" },
        {
          supportsSemanticTurnDetection: true,
          realtimeTranscriptionModel: "domain-realtime-transcribe",
        },
      ),
      configPresent: true,
      voiceRealtimeNegotiationRequest: (request) => {
        seenRequest = request;
        return Promise.resolve({ ok: true, value: { answerSdp: ANSWER_SDP } });
      },
    });
    const port = await boot(deps);
    const { ws: socket, next } = expectOpen(await connect(port));
    socket.send(sessionCreate(chat.id));
    await next();
    await next();
    socket.send(
      JSON.stringify({
        protocolVersion: "1",
        sessionId: "sess-int-1",
        seq: 1,
        direction: "client-to-host",
        kind: "signal.sdp.offer",
        sdp: OFFER_SDP,
      }),
    );
    await next();
    await next();

    expect(seenRequest).toMatchObject({
      transcriptionModel: "domain-realtime-transcribe",
      turnDetection: {
        type: "semantic_vad",
        eagerness: "low",
        interrupt_response: false,
        create_response: false,
      },
    });
    expectNoRealtimeAssistantAuthority(seenRequest);
    socket.close();
  });

  it("keeps the realtime media session tool-free when the provider advertises tool calling", async () => {
    let seenRequest: RealtimeNegotiationRequest | undefined;
    const { deps, chat } = depsWithChat({
      config: voiceConfig(
        true,
        {
          realtimeAuthMode: "ephemeral-session",
        },
        {
          toolCalling: true,
        },
      ),
      configPresent: true,
      voiceRealtimeNegotiationRequest: (request) => {
        seenRequest = request;
        return Promise.resolve({
          ok: true,
          value: { answerSdp: ANSWER_SDP },
        });
      },
    });
    const port = await boot(deps);
    const { ws: socket, next } = expectOpen(await connect(port));
    socket.send(sessionCreate(chat.id));
    await next(); // session.created
    await next(); // capability.offer
    socket.send(
      JSON.stringify({
        protocolVersion: "1",
        sessionId: "sess-int-1",
        seq: 1,
        direction: "client-to-host",
        kind: "signal.sdp.offer",
        sdp: OFFER_SDP,
      }),
    );
    await next(); // media.track.state negotiating
    await next(); // signal.sdp.answer

    expectNoRealtimeAssistantAuthority(seenRequest);
    socket.close();
  });

  it("keeps the media request tool-free when the provider does not advertise tool calling", async () => {
    let seenRequest: RealtimeNegotiationRequest | undefined;
    const { deps, chat } = depsWithChat({
      config: voiceConfig(true, {
        realtimeAuthMode: "ephemeral-session",
      }),
      configPresent: true,
      voiceRealtimeNegotiationRequest: (request) => {
        seenRequest = request;
        return Promise.resolve({
          ok: true,
          value: { answerSdp: ANSWER_SDP },
        });
      },
    });
    const port = await boot(deps);
    const { ws: socket, next } = expectOpen(await connect(port));
    socket.send(sessionCreate(chat.id));
    await next(); // session.created
    await next(); // capability.offer
    socket.send(
      JSON.stringify({
        protocolVersion: "1",
        sessionId: "sess-int-1",
        seq: 1,
        direction: "client-to-host",
        kind: "signal.sdp.offer",
        sdp: OFFER_SDP,
      }),
    );

    expect(await next()).toMatchObject({
      kind: "media.track.state",
      track: "audio-in",
      state: "negotiating",
    });
    expect(await next()).toMatchObject({ kind: "signal.sdp.answer", sdp: ANSWER_SDP });
    expect(await next()).toMatchObject({
      kind: "media.track.state",
      track: "audio-in",
      state: "live",
    });
    expectNoRealtimeAssistantAuthority(seenRequest);
    socket.close();
  });

  it("rejects a session.create whose profile/negotiation is inconsistent", async () => {
    const { deps, chat } = depsWithChat({ config: voiceConfig(true), configPresent: true });
    const port = await boot(deps);
    const { ws: socket } = expectOpen(await connect(port));
    const closed = nextClose(socket);
    socket.send(sessionCreate(chat.id, { requestedProfile: "speech-to-text" }));
    expect(await closed).toBe(1008);
  });

  it("closes an oversized opening control frame before parsing or allocating a session", async () => {
    const negotiate = vi.fn();
    const { deps } = depsWithChat({
      config: voiceConfig(true),
      configPresent: true,
      voiceRealtimeNegotiationRequest: negotiate,
    });
    const port = await boot(deps);
    const { ws: socket } = expectOpen(await connect(port));
    const oversized = JSON.stringify({
      padding: "x".repeat(MAX_VOICE_CONTROL_FRAME_BYTES + 1),
    });
    socket.send(oversized);
    const code = await nextClose(socket);

    expect(code).toBe(1009);
    expect(negotiate).not.toHaveBeenCalled();
  });

  it("closes an oversized subsequent control frame before provider negotiation", async () => {
    const negotiate = vi.fn();
    const { deps, chat } = depsWithChat({
      config: voiceConfig(true),
      configPresent: true,
      voiceRealtimeNegotiationRequest: negotiate,
    });
    const port = await boot(deps);
    const { ws: socket, next } = expectOpen(await connect(port));
    socket.send(sessionCreate(chat.id));
    await next(); // session.created
    await next(); // capability.offer
    const oversized = JSON.stringify({
      protocolVersion: "1",
      sessionId: "sess-int-1",
      seq: 1,
      direction: "client-to-host",
      kind: "signal.sdp.offer",
      sdp: `v=${"x".repeat(MAX_VOICE_CONTROL_FRAME_BYTES + 1)}`,
    });
    socket.send(oversized);
    const code = await nextClose(socket);

    expect(code).toBe(1009);
    expect(negotiate).not.toHaveBeenCalled();
  });

  it("closes the connection when a binary (raw audio) frame is sent on the control plane", async () => {
    const { deps, chat } = depsWithChat({ config: voiceConfig(true), configPresent: true });
    const port = await boot(deps);
    const { ws: socket, next } = expectOpen(await connect(port));
    socket.send(sessionCreate(chat.id));
    await next(); // session.created
    await next(); // capability.offer
    socket.send(Buffer.from([0, 1, 2, 3]));
    const code = await nextClose(socket);
    expect(code).toBe(1003);
  });
});
