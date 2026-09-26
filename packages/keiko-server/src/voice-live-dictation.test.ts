import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
// Unit coverage for the pure request-shape helpers in the live dictation control plane (Keiko
// Voice P3). The WebSocket upgrade/session machinery itself is exercised end to end elsewhere
// (voice-control-ws.test.ts); this file targets the small standalone validators.

import { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import {
  createVoiceLiveDictationPlane,
  liveDictationSessionAtCap,
  liveDictationSocketExceedsCap,
  MAX_ACTIVE_LIVE_DICTATION_SESSIONS,
  MAX_OPEN_LIVE_DICTATION_SOCKETS,
  resolveRequestedTranscriptionLanguage,
  VOICE_LIVE_TRANSCRIBE_PATH,
} from "./voice-live-dictation.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

describe("resolveRequestedTranscriptionLanguage", () => {
  it("returns undefined when no language was requested", () => {
    expect(resolveRequestedTranscriptionLanguage(undefined)).toBeUndefined();
  });

  it("returns the validated hint when present and well-formed", () => {
    expect(resolveRequestedTranscriptionLanguage("en-US")).toBe("en-US");
  });

  it("returns null when a language was requested but is malformed", () => {
    expect(resolveRequestedTranscriptionLanguage("1")).toBeNull();
  });

  it("returns null when a language was requested but is not a string", () => {
    expect(resolveRequestedTranscriptionLanguage(42)).toBeNull();
  });
});

describe("live dictation admission limits (#3190)", () => {
  it("caps only validated sessions at the sibling realtime limit", () => {
    expect(MAX_ACTIVE_LIVE_DICTATION_SESSIONS).toBe(64);
    expect(liveDictationSessionAtCap(MAX_ACTIVE_LIVE_DICTATION_SESSIONS - 1)).toBe(false);
    expect(liveDictationSessionAtCap(MAX_ACTIVE_LIVE_DICTATION_SESSIONS)).toBe(true);
  });

  it("keeps a separate, looser cap on raw sockets", () => {
    expect(MAX_OPEN_LIVE_DICTATION_SOCKETS).toBe(MAX_ACTIVE_LIVE_DICTATION_SESSIONS * 4);
    expect(liveDictationSocketExceedsCap(MAX_OPEN_LIVE_DICTATION_SOCKETS)).toBe(false);
    expect(liveDictationSocketExceedsCap(MAX_OPEN_LIVE_DICTATION_SOCKETS + 1)).toBe(true);
  });
});

// Activity Log proofs (#3532) for the live-dictation admission plane. `rejectForCapacity` and
// `startInitialFrameDeadline` are private methods of the plane implementation, so they are driven
// through the one exported entry point that reaches them: `createVoiceLiveDictationPlane(...)
// .handleUpgrade(req, sock, head)`, the same seam `server.ts` calls on a real HTTP upgrade. The
// fake socket is a real `node:stream.Duplex` (not a mock of `ws`'s internals), so `ws`'s own
// `WebSocketServer.handleUpgrade` performs a real handshake against it — no real network/port is
// ever opened.
describe("voice-live-dictation Activity Log proofs (#3532)", () => {
  const TEST_PORT = 41_999;
  // RFC 6455 §1.2's example Sec-WebSocket-Key: the base64 of its sample nonce, derived here so the
  // file carries no key-shaped literal for the secret scan to read as a credential.
  const TEST_WS_KEY = Buffer.from("the sample nonce").toString("base64");

  const REALTIME_CAPABLE_CONFIG: GatewayConfig = {
    providers: [
      {
        modelId: "keiko-realtime",
        baseUrl: "https://realtime.example.com",
        apiKey: "rt-secret-token-1234567890",
        timeoutMs: 1_000,
        maxRetries: 2,
        retryBaseDelayMs: 10,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
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

  // A real (fake-transport) Duplex, so `ws`'s own handshake/receiver code runs unmodified — only
  // the byte transport is fake. Mirrors the established `Duplex`-subclass fake socket in
  // coding-app-session/sessionStreamLifecycle.test.ts.
  class FakeUpgradeSocket extends Duplex {
    public override _read(): void {
      // This fake transport never produces inbound bytes; neither proof below needs a client frame
      // to arrive on the wire.
    }

    public override _write(
      _chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      callback();
    }
  }

  function liveDictationDeps(): UiHandlerDeps {
    return {
      config: REALTIME_CAPABLE_CONFIG,
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
      modelPortFactory: () => undefined,
      store: createInMemoryUiStore(),
    };
  }

  // Builds one fake upgrade request/socket pair accepted by isAllowedHost + isVoiceRealtimeCapable
  // and by `ws`'s own header validation (a well-formed Sec-WebSocket-Key/Version).
  function fakeUpgrade(): { readonly req: IncomingMessage; readonly socket: FakeUpgradeSocket } {
    const socket = new FakeUpgradeSocket();
    const req = new IncomingMessage(socket as unknown as Socket);
    req.method = "GET";
    req.url = VOICE_LIVE_TRANSCRIBE_PATH;
    req.headers = {
      host: `127.0.0.1:${String(TEST_PORT)}`,
      origin: `http://127.0.0.1:${String(TEST_PORT)}`,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": TEST_WS_KEY,
      "sec-websocket-version": "13",
    };
    return { req, socket };
  }

  function captureServerLog(): BufferedServerLogSink {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    return sink;
  }

  afterEach(() => {
    resetServerLogger();
    vi.useRealTimers();
  });

  it("resolves voice.live-dictation.capacity-rejected.count once the open-socket ceiling is exceeded (#3190)", () => {
    const sink = captureServerLog();
    const deps = liveDictationDeps();
    const plane = createVoiceLiveDictationPlane({ port: TEST_PORT, handlerDeps: () => deps });
    vi.useFakeTimers();

    for (let admitted = 0; admitted < MAX_OPEN_LIVE_DICTATION_SOCKETS; admitted += 1) {
      const { req, socket } = fakeUpgrade();
      plane.handleUpgrade(req, socket, Buffer.alloc(0));
    }
    expect(sink.events).toHaveLength(0);

    const { req, socket } = fakeUpgrade();
    const accepted = plane.handleUpgrade(req, socket, Buffer.alloc(0));
    expect(accepted).toBe(true);

    const rejections = sink.events.filter(
      (event) => event.op === "voice.live-dictation.capacity-rejected",
    );
    expect(rejections).toHaveLength(1);
    const persisted = expectActivityLogProof(
      "voice.live-dictation.capacity-rejected.count",
      formatActivityLogProofLine(rejections[0] ?? {}),
    );
    expect(persisted).toMatchObject({
      reason: "socket-cap",
      observedCount: MAX_OPEN_LIVE_DICTATION_SOCKETS + 1,
      errorKind: "rate-limited",
    });
  });

  it("resolves voice.live-dictation.initial-frame-timeout.deadline when no session.create frame arrives in time", () => {
    const sink = captureServerLog();
    const deps = liveDictationDeps();
    const plane = createVoiceLiveDictationPlane({
      port: TEST_PORT,
      handlerDeps: () => deps,
      initialFrameTimeoutMs: 1_000,
    });
    vi.useFakeTimers();

    const { req, socket } = fakeUpgrade();
    plane.handleUpgrade(req, socket, Buffer.alloc(0));
    expect(sink.events).toHaveLength(0);
    vi.advanceTimersByTime(1_000);

    const timeouts = sink.events.filter(
      (event) => event.op === "voice.live-dictation.initial-frame-timeout",
    );
    expect(timeouts).toHaveLength(1);
    const persisted = expectActivityLogProof(
      "voice.live-dictation.initial-frame-timeout.deadline",
      formatActivityLogProofLine(timeouts[0] ?? {}),
    );
    expect(persisted).toMatchObject({
      op: "voice.live-dictation.initial-frame-timeout",
      errorKind: "timeout",
    });
  });
});
