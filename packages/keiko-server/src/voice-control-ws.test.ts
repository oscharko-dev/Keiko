// Integration tests for the capability-gated WebSocket voice control upgrade (Issue #497). Boots the
// real BFF (createUiServer) on a loopback ephemeral port and connects a real `ws` client, asserting
// the upgrade is hard-rejected for every non-full-realtime deployment / bad origin / wrong path, and
// accepted only for a full-realtime deployment on a loopback origin — then drives the proxied-SDP
// handshake end to end. This is the security-critical gate (ADR-0058 D3/D6, AC1/AC3).

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { WebSocket } from "ws";
import { createUiServer, UI_HOST } from "./server.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { Chat } from "./store/index.js";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";

const ANSWER_SDP =
  "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const OFFER_SDP =
  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

function voiceConfig(realtime: boolean): GatewayConfig {
  return {
    providers: [
      {
        modelId: "keiko-realtime",
        baseUrl: "https://realtime.example.com",
        apiKey: "rt-secret-token-1234567890",
        timeoutMs: 1000,
        maxRetries: 2,
        retryBaseDelayMs: 10,
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
        ...(realtime ? { supportsRealtimeVoice: true } : {}),
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
    chatContext: {
      chatId,
      memory: { enabled: true, budgetTokens: 1200 },
    },
    ...extra,
  });
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
    expect(offer.kind).toBe("capability.offer");
    ws.close();
  });
});

describe("WebSocket voice control upgrade — protocol behavior", () => {
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
    const port = await boot(
      deps,
    );
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

  it("rejects a session.create whose profile/negotiation is inconsistent", async () => {
    const { deps, chat } = depsWithChat({ config: voiceConfig(true), configPresent: true });
    const port = await boot(deps);
    const { ws: socket, next } = expectOpen(await connect(port));
    socket.send(sessionCreate(chat.id, { requestedProfile: "speech-to-text" }));
    const message = await next();
    expect(message).toMatchObject({ kind: "error", code: "not-allowed-for-profile" });
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
