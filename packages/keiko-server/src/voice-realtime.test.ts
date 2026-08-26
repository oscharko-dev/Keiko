// Unit tests for the media-only realtime Voice control-plane protocol state machine. The fake socket
// and injected negotiation seam exercise lifecycle, SDP signaling, content-free capability offers,
// content-free replay, idempotency, and deterministic teardown without network, media, or paid calls.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sweepControlHeartbeat,
  VoiceControlConnection,
  type VoiceControlSocket,
} from "./voice-realtime.js";
import type { RealtimeNegotiationOutcome } from "@oscharko-dev/keiko-model-gateway";
import type { VoiceControlMessage, VoiceSessionChatContext } from "@oscharko-dev/keiko-contracts";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "./diagnostics-log.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
} from "./observability/index.js";

const OFFER_SDP =
  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendonly\r\n";
const ANSWER_SDP =
  "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n";

class FakeSocket implements VoiceControlSocket {
  readonly sent: VoiceControlMessage[] = [];
  readonly closes: { code: number; reason: string }[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as VoiceControlMessage);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
}

interface TestSession {
  sessionId: string;
  idempotencyKey: string;
  profile: "full-realtime";
  capabilities: {
    speechToText: boolean;
    speechOutput: boolean;
    realtimeVoice: boolean;
  };
  providerLocality: "azure-foundry" | undefined;
  chatContext: VoiceSessionChatContext | undefined;
  hostSeq: number;
  lastClientSeq: number;
  replay: VoiceControlMessage[];
  replayStart: number;
  detachedAt: number | undefined;
  terminal: boolean;
}

function makeSession(overrides: Partial<TestSession> = {}): TestSession {
  return {
    sessionId: "sess-1",
    idempotencyKey: "idem-1",
    profile: "full-realtime",
    capabilities: { speechToText: true, speechOutput: false, realtimeVoice: true },
    providerLocality: "azure-foundry",
    chatContext: undefined,
    hostSeq: 0,
    lastClientSeq: 0,
    replay: [],
    replayStart: 0,
    detachedAt: undefined,
    terminal: false,
    ...overrides,
  };
}

function ok(): RealtimeNegotiationOutcome {
  return { ok: true, value: { answerSdp: ANSWER_SDP } };
}

function okAsync(): Promise<RealtimeNegotiationOutcome> {
  return Promise.resolve(ok());
}

interface PendingNegotiation {
  readonly signal: AbortSignal;
  readonly resolve: (outcome: RealtimeNegotiationOutcome) => void;
}

function pendingNegotiationHarness(): {
  readonly calls: PendingNegotiation[];
  readonly negotiate: (
    offerSdp: string,
    chatContext: VoiceSessionChatContext | undefined,
    signal: AbortSignal,
  ) => Promise<RealtimeNegotiationOutcome>;
} {
  const calls: PendingNegotiation[] = [];
  return {
    calls,
    negotiate: (_offerSdp, _chatContext, signal) =>
      new Promise((resolve) => {
        calls.push({ signal, resolve });
      }),
  };
}

function resolvePendingNegotiations(calls: readonly PendingNegotiation[]): void {
  for (const call of calls) call.resolve(ok());
}

// Default connection-scoped correlation id used by tests that don't care about its exact value —
// distinct from any protocol code/kind string so an accidental field mix-up is easy to spot.
const TEST_CORRELATION_ID = "conn-correlation-id-1";

function connect(options?: {
  negotiate?: (
    offerSdp: string,
    chatContext: VoiceSessionChatContext | undefined,
    signal: AbortSignal,
  ) => Promise<RealtimeNegotiationOutcome>;
  redact?: (value: unknown) => unknown;
  session?: TestSession;
  correlationId?: string;
  diagnostics?: ServerDiagnosticSink | undefined;
}): { socket: FakeSocket; session: TestSession; conn: VoiceControlConnection } {
  const socket = new FakeSocket();
  const session = options?.session ?? makeSession();
  const conn = new VoiceControlConnection({
    socket,
    session,
    negotiate: options?.negotiate ?? okAsync,
    redact: options?.redact ?? ((value: unknown): unknown => value),
    correlationId: options?.correlationId ?? TEST_CORRELATION_ID,
    diagnostics: options?.diagnostics,
  });
  return { socket, session, conn };
}

function clientMessage(kind: string, seq: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocolVersion: "1",
    sessionId: "sess-1",
    seq,
    direction: "client-to-host",
    kind,
    ...extra,
  });
}

function kinds(socket: FakeSocket): string[] {
  return socket.sent.map((message) => message.kind);
}

describe("VoiceControlConnection.start", () => {
  it("announces session.created (loopback-websocket / webrtc / proxied-sdp) and capability.offer", () => {
    const { socket, conn } = connect();
    conn.start(false);
    expect(kinds(socket)).toEqual(["session.created", "capability.offer"]);
    const created = socket.sent[0] as unknown as Record<string, unknown>;
    expect(created).toMatchObject({
      kind: "session.created",
      profile: "full-realtime",
      controlTransport: "loopback-websocket",
      mediaTransport: "webrtc",
      negotiationMode: "proxied-sdp",
      providerLocality: "azure-foundry",
      direction: "host-to-client",
      protocolVersion: "1",
    });
    // Host sequence numbers are monotonic per direction.
    expect(socket.sent.map((message) => message.seq)).toEqual([0, 1]);
    const offer = socket.sent[1] as unknown as Record<string, unknown>;
    expect(offer).toMatchObject({
      kind: "capability.offer",
      capabilities: {
        speechToText: true,
        speechOutput: false,
        realtimeVoice: true,
      },
    });
  });

  it("announces the exact resolved TTS posture instead of inferring speech output from Realtime", () => {
    const session = makeSession({
      capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
    });
    const { socket, conn } = connect({ session });

    conn.start(false);

    expect(socket.sent[1]).toMatchObject({
      kind: "capability.offer",
      capabilities: session.capabilities,
    });
  });

  it("re-delivers the buffered replayable events before announcing on a resume", () => {
    const session = makeSession();
    const c1 = connect({ session });
    c1.conn.start(false); // buffers session.created + capability.offer (both replayable)
    expect(session.replay.map((m) => m.kind)).toEqual(["session.created", "capability.offer"]);

    // A reconnect on a fresh socket resumes the same session record.
    const c2 = connect({ session });
    c2.conn.start(true);
    // The two buffered events are re-delivered first, then the new session.created + capability.offer.
    expect(kinds(c2.socket)).toEqual([
      "session.created",
      "capability.offer",
      "session.created",
      "capability.offer",
    ]);
  });

  it("keeps replay overflow ordered without shifting the replay array", async () => {
    const session = makeSession();
    const c1 = connect({ session });
    c1.conn.start(false);

    for (let i = 0; i < 205; i += 1) {
      await c1.conn.receive(
        clientMessage("capability.select", i + 1, { profile: "full-realtime" }),
      );
    }

    expect(session.replay).toHaveLength(200);
    expect(session.replayStart).toBeGreaterThan(0);

    const c2 = connect({ session });
    c2.conn.start(true);
    const replayed = c2.socket.sent.slice(0, 200);
    expect(replayed.map((message) => message.seq)).toEqual(
      Array.from({ length: 200 }, (_unused, index) => index + 7),
    );
  });
});

describe("VoiceControlConnection proxied-SDP signaling", () => {
  it("negotiates an SDP offer and returns the answer with live media-track state", async () => {
    const negotiate = vi.fn(
      (
        _offerSdp: string,
        _chatContext: VoiceSessionChatContext | undefined,
        _signal: AbortSignal,
      ): Promise<RealtimeNegotiationOutcome> => okAsync(),
    );
    const { socket, session, conn } = connect({ negotiate });
    conn.start(false);
    socket.sent.length = 0;
    await conn.receive(clientMessage("signal.sdp.offer", 1, { sdp: OFFER_SDP }));
    expect(negotiate).toHaveBeenCalledTimes(1);
    // Realtime receives only the SDP, canonical chat identity, and abort signal — no persona.
    expect(negotiate).toHaveBeenCalledWith(OFFER_SDP, undefined, expect.anything());
    expect(kinds(socket)).toEqual(["media.track.state", "signal.sdp.answer", "media.track.state"]);
    const answer = socket.sent[1] as unknown as Record<string, unknown>;
    expect(answer).toMatchObject({ kind: "signal.sdp.answer", sdp: ANSWER_SDP });
    // The ephemeral, secret-bearing SDP answer is never buffered into the replay record (AC6).
    expect(session.replay.some((m) => m.kind === "signal.sdp.answer")).toBe(false);
  });

  it("forwards only the canonical chat identity", async () => {
    const chatContext: VoiceSessionChatContext = { chatId: "chat-1" };
    const negotiate = vi.fn(
      (
        _offerSdp: string,
        _chatContext: VoiceSessionChatContext | undefined,
        _signal: AbortSignal,
      ): Promise<RealtimeNegotiationOutcome> => okAsync(),
    );
    const { conn } = connect({ negotiate, session: makeSession({ chatContext }) });

    conn.start(false);
    await conn.receive(clientMessage("signal.sdp.offer", 1, { sdp: OFFER_SDP }));

    expect(negotiate).toHaveBeenCalledWith(OFFER_SDP, chatContext, expect.anything());
    expect(negotiate.mock.calls[0]).toHaveLength(3);
  });

  it("answers a negotiation failure with error negotiation-failed, the connection's correlation id, and an ended track", async () => {
    const { socket, conn } = connect({
      negotiate: (): Promise<RealtimeNegotiationOutcome> =>
        Promise.resolve({ ok: false, kind: "transport" }),
      correlationId: "negotiation-fail-corr-1",
    });
    conn.start(false);
    socket.sent.length = 0;
    await conn.receive(clientMessage("signal.sdp.offer", 1, { sdp: OFFER_SDP }));
    expect(kinds(socket)).toEqual(["media.track.state", "error", "media.track.state"]);
    const failure = socket.sent[1] as unknown as Record<string, unknown>;
    expect(failure.code).toBe("negotiation-failed");
    expect(failure.correlationId).toBe("negotiation-fail-corr-1");
  });

  // RB-6 / ADR-0173 D5 regression pin: the correlation id is resolved ONCE per WebSocket connection
  // (at handleUpgrade, injected here as the connection's constructor option), never re-minted per
  // failure. Before the fix each negotiation failure on the same connection would have carried an
  // unrelated fresh id; this proves a second failure on the same connection still matches the first.
  it("reuses the same connection-scoped correlation id across repeated negotiation failures", async () => {
    const { socket, conn } = connect({
      negotiate: (): Promise<RealtimeNegotiationOutcome> =>
        Promise.resolve({ ok: false, kind: "transport" }),
      correlationId: "repeated-failure-corr-1",
    });
    conn.start(false);
    socket.sent.length = 0;

    await conn.receive(clientMessage("signal.sdp.offer", 1, { sdp: OFFER_SDP }));
    const firstFailure = socket.sent[1] as unknown as Record<string, unknown>;
    expect(firstFailure.code).toBe("negotiation-failed");
    expect(firstFailure.correlationId).toBe("repeated-failure-corr-1");

    socket.sent.length = 0;
    await conn.receive(clientMessage("signal.sdp.offer", 2, { sdp: OFFER_SDP }));
    const secondFailure = socket.sent[1] as unknown as Record<string, unknown>;
    expect(secondFailure.code).toBe("negotiation-failed");
    expect(secondFailure.correlationId).toBe("repeated-failure-corr-1");
    expect(secondFailure.correlationId).toBe(firstFailure.correlationId);
  });

  it("rejects a malformed SDP offer without calling the provider or attaching a correlation id", async () => {
    const negotiate = vi.fn(okAsync);
    const { socket, conn } = connect({ negotiate });
    conn.start(false);
    socket.sent.length = 0;
    await conn.receive(clientMessage("signal.sdp.offer", 1, { sdp: "not-an-sdp" }));
    expect(negotiate).not.toHaveBeenCalled();
    expect(kinds(socket)).toEqual(["error"]);
    const failure = socket.sent[0] as unknown as Record<string, unknown>;
    expect(failure.code).toBe("invalid-message");
    expect(failure).not.toHaveProperty("correlationId");
  });

  it.each([
    ["permissive", OFFER_SDP.replace("a=sendonly", "a=sendrecv")],
    ["duplicate", `${OFFER_SDP}a=sendonly\r\n`],
    ["conflicting", `${OFFER_SDP}a=recvonly\r\n`],
  ])("rejects a %s client audio direction before provider egress", async (_kind, sdp) => {
    const negotiate = vi.fn(okAsync);
    const { socket, conn } = connect({ negotiate });
    conn.start(false);
    socket.sent.length = 0;

    await conn.receive(clientMessage("signal.sdp.offer", 1, { sdp }));

    expect(negotiate).not.toHaveBeenCalled();
    expect(kinds(socket)).toEqual(["error"]);
    expect((socket.sent[0] as unknown as Record<string, unknown>).code).toBe("invalid-message");
  });

  it.each([
    ["permissive", ANSWER_SDP.replace("a=recvonly", "a=sendrecv")],
    ["duplicate", `${ANSWER_SDP}a=recvonly\r\n`],
    ["conflicting", `${ANSWER_SDP}a=sendonly\r\n`],
  ])("rejects a %s provider audio direction before client egress", async (_kind, sdp) => {
    const { socket, conn } = connect({
      negotiate: (): Promise<RealtimeNegotiationOutcome> =>
        Promise.resolve({
          ok: true,
          value: { answerSdp: sdp },
        }),
    });
    conn.start(false);
    socket.sent.length = 0;

    await conn.receive(clientMessage("signal.sdp.offer", 1, { sdp: OFFER_SDP }));

    expect(kinds(socket)).toEqual(["media.track.state", "error", "media.track.state"]);
    expect((socket.sent[1] as unknown as Record<string, unknown>).code).toBe("negotiation-failed");
    expect(kinds(socket)).not.toContain("signal.sdp.answer");
  });

  it("drops a negotiation result superseded by control.cancel", async () => {
    let resolveNegotiate: ((outcome: RealtimeNegotiationOutcome) => void) | undefined;
    const negotiate = (): Promise<RealtimeNegotiationOutcome> =>
      new Promise((resolve) => {
        resolveNegotiate = resolve;
      });
    const { socket, conn } = connect({ negotiate });
    conn.start(false);
    socket.sent.length = 0;
    const offer = conn.receive(clientMessage("signal.sdp.offer", 1, { sdp: OFFER_SDP }));
    await conn.receive(clientMessage("control.cancel", 2));
    resolveNegotiate?.(ok());
    await offer;
    // Only the initial negotiating track-state was sent; the late answer was dropped.
    expect(kinds(socket)).toEqual(["media.track.state"]);
  });

  it("aborts an in-flight negotiation when a valid second offer supersedes it", async () => {
    const pending = pendingNegotiationHarness();
    const { socket, conn } = connect({ negotiate: pending.negotiate });
    conn.start(false);
    socket.sent.length = 0;

    const first = conn.receive(clientMessage("signal.sdp.offer", 1, { sdp: OFFER_SDP }));
    const second = conn.receive(clientMessage("signal.sdp.offer", 2, { sdp: OFFER_SDP }));

    expect(pending.calls).toHaveLength(2);
    expect(pending.calls[0]?.signal.aborted).toBe(true);
    expect(pending.calls[1]?.signal.aborted).toBe(false);
    resolvePendingNegotiations(pending.calls);
    await Promise.all([first, second]);
    expect(kinds(socket).filter((kind) => kind === "signal.sdp.answer")).toHaveLength(1);
  });

  it("aborts every superseded negotiation when the client cancels", async () => {
    const pending = pendingNegotiationHarness();
    const { socket, conn } = connect({ negotiate: pending.negotiate });
    conn.start(false);
    socket.sent.length = 0;

    const first = conn.receive(clientMessage("signal.sdp.offer", 1, { sdp: OFFER_SDP }));
    const second = conn.receive(clientMessage("signal.sdp.offer", 2, { sdp: OFFER_SDP }));
    await conn.receive(clientMessage("control.cancel", 3));

    expect(pending.calls).toHaveLength(2);
    expect(pending.calls.every((call) => call.signal.aborted)).toBe(true);
    resolvePendingNegotiations(pending.calls);
    await Promise.all([first, second]);
    expect(kinds(socket)).toEqual(["media.track.state", "media.track.state"]);
  });

  it("aborts every superseded negotiation when the connection disconnects", async () => {
    const pending = pendingNegotiationHarness();
    const { socket, conn } = connect({ negotiate: pending.negotiate });
    conn.start(false);
    socket.sent.length = 0;

    const first = conn.receive(clientMessage("signal.sdp.offer", 1, { sdp: OFFER_SDP }));
    const second = conn.receive(clientMessage("signal.sdp.offer", 2, { sdp: OFFER_SDP }));
    conn.dispose();

    expect(pending.calls).toHaveLength(2);
    expect(pending.calls.every((call) => call.signal.aborted)).toBe(true);
    resolvePendingNegotiations(pending.calls);
    await Promise.all([first, second]);
    expect(kinds(socket)).toEqual(["media.track.state", "media.track.state"]);
  });
});

describe("VoiceControlConnection protocol gating & idempotency", () => {
  it("answers an unsupported protocol version with error unsupported-version and closes", async () => {
    const { socket, conn } = connect();
    conn.start(false);
    socket.sent.length = 0;
    await conn.receive(
      JSON.stringify({
        protocolVersion: "2",
        sessionId: "sess-1",
        seq: 1,
        direction: "client-to-host",
        kind: "signal.sdp.offer",
        sdp: OFFER_SDP,
      }),
    );
    expect((socket.sent[0] as unknown as Record<string, unknown>).code).toBe("unsupported-version");
    expect(socket.closes[0]?.code).toBe(1008);
  });

  it("closes on an unparseable frame with an invalid-message error", async () => {
    const { socket, conn } = connect();
    conn.start(false);
    socket.sent.length = 0;
    await conn.receive("{ not json");
    expect((socket.sent[0] as unknown as Record<string, unknown>).code).toBe("invalid-message");
    expect(socket.closes[0]?.code).toBe(1008);
  });

  it("rejects a follow-up frame addressed to another session", async () => {
    const { socket, conn } = connect();
    conn.start(false);
    socket.sent.length = 0;

    await conn.receive(
      clientMessage("capability.select", 1, {
        sessionId: "sess-other",
        profile: "full-realtime",
      }),
    );

    expect((socket.sent[0] as unknown as Record<string, unknown>).code).toBe("invalid-message");
    expect(socket.closes[0]?.code).toBe(1008);
  });

  it("rejects a host-originated frame arriving on the client socket", async () => {
    const { socket, conn } = connect();
    conn.start(false);
    socket.sent.length = 0;

    await conn.receive(
      clientMessage("capability.select", 1, {
        direction: "host-to-client",
        profile: "full-realtime",
      }),
    );

    expect((socket.sent[0] as unknown as Record<string, unknown>).code).toBe("invalid-message");
    expect(socket.closes[0]?.code).toBe(1008);
  });

  it("ignores a stale or duplicate client sequence (idempotency on sessionId,seq)", async () => {
    const negotiate = vi.fn(okAsync);
    const { socket, conn } = connect({ negotiate });
    conn.start(false);
    await conn.receive(clientMessage("signal.sdp.offer", 5, { sdp: OFFER_SDP }));
    negotiate.mockClear();
    socket.sent.length = 0;
    // Re-send the same seq: must be ignored, never re-negotiated.
    await conn.receive(clientMessage("signal.sdp.offer", 5, { sdp: OFFER_SDP }));
    await conn.receive(clientMessage("signal.sdp.offer", 3, { sdp: OFFER_SDP }));
    expect(negotiate).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(0);
  });

  it("acknowledges content-free controls and rejects transcript content", async () => {
    const { socket, conn } = connect();
    conn.start(false);
    socket.sent.length = 0;
    await conn.receive(clientMessage("capability.select", 1, { profile: "full-realtime" }));
    await conn.receive(clientMessage("control.interrupt", 2, { atMs: 120 }));
    await conn.receive(clientMessage("signal.ice.candidate", 3, { candidate: "candidate:..." }));
    await conn.receive(clientMessage("transcript.partial", 4, { text: "hel" }));
    expect(kinds(socket)).toEqual(["policy.decision", "error"]);
    expect((socket.sent[0] as unknown as Record<string, unknown>).decision).toBe("allow");
    expect((socket.sent[1] as unknown as Record<string, unknown>).code).toBe(
      "not-allowed-for-profile",
    );
  });

  it("KEIKO-0661: denies a capability.select for a profile the session did not negotiate", async () => {
    // The realtime transport binds one session to one profile ("full-realtime"). Before the fix,
    // any capability.select (even for a different profile the session was never negotiated for)
    // returned {decision: "allow"} unconditionally. Now the response must be {decision: "deny"}
    // for a mismatched profile.
    const { socket, conn } = connect();
    conn.start(false);
    socket.sent.length = 0;

    await conn.receive(clientMessage("capability.select", 1, { profile: "speech-to-text" }));

    expect(socket.sent).toHaveLength(1);
    const decision = socket.sent[0] as unknown as Record<string, unknown>;
    expect(decision.kind).toBe("policy.decision");
    expect(decision.decision).toBe("deny");
  });
});

describe("VoiceControlConnection replay & teardown", () => {
  it("rejects client transcript frames without retaining customer text for replay", async () => {
    const { socket, session, conn } = connect();
    conn.start(false);
    socket.sent.length = 0;
    const sentinel = "unique raw customer transcript sentinel";

    await conn.receive(clientMessage("transcript.partial", 1, { text: sentinel }));
    await conn.receive(clientMessage("transcript.committed", 2, { text: sentinel }));

    expect(socket.sent).toHaveLength(2);
    expect(
      socket.sent.map(
        (message) => (message as Extract<VoiceControlMessage, { kind: "error" }>).code,
      ),
    ).toEqual(["not-allowed-for-profile", "not-allowed-for-profile"]);
    expect(session.replay.some((message) => message.kind.startsWith("transcript."))).toBe(false);
    expect(JSON.stringify(session.replay)).not.toContain(sentinel);

    const resumed = connect({ session });
    resumed.conn.start(true);
    expect(resumed.socket.sent.some((message) => message.kind.startsWith("transcript."))).toBe(
      false,
    );
    expect(JSON.stringify(resumed.socket.sent)).not.toContain(sentinel);
  });

  it("closes the session on session.close and emits session.closed", async () => {
    const { socket, conn } = connect();
    conn.start(false);
    socket.sent.length = 0;
    await conn.receive(clientMessage("session.close", 1, { reason: "client-request" }));
    expect((socket.sent[0] as unknown as Record<string, unknown>).kind).toBe("session.closed");
    expect(socket.closes[0]?.code).toBe(1000);
  });

  it("applies the injected redactor to every outbound frame", () => {
    const redact = vi.fn((value: unknown) => value);
    const { socket, conn } = connect({ redact });
    conn.start(false);
    expect(redact).toHaveBeenCalledTimes(socket.sent.length);
    expect(socket.sent.length).toBeGreaterThan(0);
  });

  it("stops sending after dispose (deterministic teardown)", async () => {
    const { socket, conn } = connect();
    conn.start(false);
    conn.dispose();
    socket.sent.length = 0;
    await conn.receive(clientMessage("capability.select", 1, { profile: "full-realtime" }));
    expect(socket.sent).toHaveLength(0);
  });
});

describe("sweepControlHeartbeat (liveness)", () => {
  it("terminates a socket that missed the previous ping; re-arms and pings a live one", () => {
    const deadPing = vi.fn<() => void>();
    const deadTerminate = vi.fn<() => void>();
    const livePing = vi.fn<() => void>();
    const liveTerminate = vi.fn<() => void>();
    const dead = { isAlive: false, ping: deadPing, terminate: deadTerminate };
    const live = { isAlive: true, ping: livePing, terminate: liveTerminate };
    sweepControlHeartbeat([dead, live]);
    expect(deadTerminate).toHaveBeenCalledTimes(1);
    expect(deadPing).not.toHaveBeenCalled();
    expect(liveTerminate).not.toHaveBeenCalled();
    expect(livePing).toHaveBeenCalledTimes(1);
    // The live socket must answer THIS ping (isAlive re-armed to false) or be terminated next sweep.
    expect(live.isAlive).toBe(false);
  });

  it("treats a freshly-connected socket (isAlive undefined) as live", () => {
    const ping = vi.fn<() => void>();
    const terminate = vi.fn<() => void>();
    const fresh: { isAlive?: boolean; ping: () => void; terminate: () => void } = {
      ping,
      terminate,
    };
    sweepControlHeartbeat([fresh]);
    expect(terminate).not.toHaveBeenCalled();
    expect(ping).toHaveBeenCalledTimes(1);
    expect(fresh.isAlive).toBe(false);
  });
});

// w4b-voice-realtime (#2902): voice-realtime.ts had zero logging or diagnostic emission of any
// kind — mirrors voice-live-dictation.ts's reportNegotiationFailure pattern at session start,
// session end, and negotiation failure, reusing the connection-scoped correlation id (RB-6 /
// ADR-0173 D5) rather than minting anything new here.
describe("VoiceControlConnection diagnostics (w4b-voice-realtime)", () => {
  function captureServerLog(): BufferedServerLogSink {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    return sink;
  }

  afterEach(() => {
    resetServerLogger();
  });

  it("emits a structured diagnostic carrying the connection's correlation id on negotiation failure", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const diagnostics: ServerDiagnosticSink = { record: (record) => records.push(record) };
    const { conn } = connect({
      negotiate: (): Promise<RealtimeNegotiationOutcome> =>
        Promise.resolve({ ok: false, kind: "transport" }),
      correlationId: "diag-negotiation-fail-1",
      diagnostics,
    });
    conn.start(false);

    await conn.receive(clientMessage("signal.sdp.offer", 1, { sdp: OFFER_SDP }));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      correlationId: "diag-negotiation-fail-1",
      operation: "voice.realtime.negotiate",
      source: "voice.realtime",
      code: "transport",
    });
  });

  it("brackets a normal session lifecycle with a session-start and a session-end line", () => {
    const sink = captureServerLog();
    const { conn } = connect({ correlationId: "diag-lifecycle-1" });

    conn.start(false);
    conn.dispose();

    const ops = sink.events.map((event) => event.op);
    expect(ops).toEqual(["voice.realtime.session-started", "voice.realtime.session-ended"]);
    expect(sink.events[0]).toMatchObject({
      category: "http",
      op: "voice.realtime.session-started",
      correlationId: "diag-lifecycle-1",
    });
    expect(sink.events[1]).toMatchObject({
      category: "http",
      op: "voice.realtime.session-ended",
      correlationId: "diag-lifecycle-1",
    });
  });
});
