// Unit tests for the realtime voice control-plane protocol state machine (Issue #497). Exercises the
// VoiceControlConnection directly with a fake socket and an injected negotiation seam — no real
// WebSocket server — covering session lifecycle, proxied-SDP signaling, capability gating, idempotency,
// reviewable-text sanitisation, the replay buffer, and deterministic teardown.

import { describe, expect, it, vi } from "vitest";
import {
  sweepControlHeartbeat,
  VoiceControlConnection,
  type VoiceControlSocket,
} from "./voice-realtime.js";
import type { RealtimeNegotiationOutcome } from "@oscharko-dev/keiko-model-gateway";
import type { VoiceControlMessage, VoicePersona } from "@oscharko-dev/keiko-contracts";

const OFFER_SDP =
  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const ANSWER_SDP =
  "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

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
  providerLocality: "azure-foundry" | undefined;
  persona: VoicePersona | undefined;
  hostSeq: number;
  lastClientSeq: number;
  replay: VoiceControlMessage[];
  detachedAt: number | undefined;
}

function makeSession(overrides: Partial<TestSession> = {}): TestSession {
  return {
    sessionId: "sess-1",
    idempotencyKey: "idem-1",
    profile: "full-realtime",
    providerLocality: "azure-foundry",
    persona: undefined,
    hostSeq: 0,
    lastClientSeq: 0,
    replay: [],
    detachedAt: undefined,
    ...overrides,
  };
}

function ok(): RealtimeNegotiationOutcome {
  return { ok: true, value: { answerSdp: ANSWER_SDP } };
}

function okAsync(): Promise<RealtimeNegotiationOutcome> {
  return Promise.resolve(ok());
}

function connect(options?: {
  negotiate?: (
    offerSdp: string,
    persona: VoicePersona | undefined,
    signal: AbortSignal,
  ) => Promise<RealtimeNegotiationOutcome>;
  redact?: (value: unknown) => unknown;
  session?: TestSession;
}): { socket: FakeSocket; session: TestSession; conn: VoiceControlConnection } {
  const socket = new FakeSocket();
  const session = options?.session ?? makeSession();
  const conn = new VoiceControlConnection({
    socket,
    session: session,
    negotiate: options?.negotiate ?? okAsync,
    redact: options?.redact ?? ((value: unknown): unknown => value),
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
      capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
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
});

describe("VoiceControlConnection proxied-SDP signaling", () => {
  it("negotiates an SDP offer and returns the answer with live media-track state", async () => {
    const negotiate = vi.fn(
      (
        _offerSdp: string,
        _persona: VoicePersona | undefined,
        _signal: AbortSignal,
      ): Promise<RealtimeNegotiationOutcome> => okAsync(),
    );
    const { socket, session, conn } = connect({ negotiate });
    conn.start(false);
    socket.sent.length = 0;
    await conn.receive(clientMessage("signal.sdp.offer", 1, { sdp: OFFER_SDP }));
    expect(negotiate).toHaveBeenCalledTimes(1);
    // offer + the session's (here undefined) persona + the abort signal.
    expect(negotiate).toHaveBeenCalledWith(OFFER_SDP, undefined, expect.anything());
    expect(kinds(socket)).toEqual([
      "media.track.state",
      "signal.sdp.answer",
      "media.track.state",
      "media.track.state",
    ]);
    const answer = socket.sent[1] as unknown as Record<string, unknown>;
    expect(answer).toMatchObject({ kind: "signal.sdp.answer", sdp: ANSWER_SDP });
    // The ephemeral, secret-bearing SDP answer is never buffered into the replay record (AC6).
    expect(session.replay.some((m) => m.kind === "signal.sdp.answer")).toBe(false);
  });

  it("threads the session's selected persona to the negotiation seam (realtime honors the voice choice)", async () => {
    const negotiate = vi.fn(
      (
        _offerSdp: string,
        _persona: VoicePersona | undefined,
        _signal: AbortSignal,
      ): Promise<RealtimeNegotiationOutcome> => okAsync(),
    );
    const { conn } = connect({ negotiate, session: makeSession({ persona: "female" }) });
    conn.start(false);
    await conn.receive(clientMessage("signal.sdp.offer", 1, { sdp: OFFER_SDP }));
    expect(negotiate).toHaveBeenCalledWith(OFFER_SDP, "female", expect.anything());
  });

  it("answers a negotiation failure with error negotiation-failed and an ended track", async () => {
    const { socket, conn } = connect({
      negotiate: (): Promise<RealtimeNegotiationOutcome> =>
        Promise.resolve({ ok: false, kind: "transport" }),
    });
    conn.start(false);
    socket.sent.length = 0;
    await conn.receive(clientMessage("signal.sdp.offer", 1, { sdp: OFFER_SDP }));
    expect(kinds(socket)).toEqual(["media.track.state", "error", "media.track.state"]);
    expect((socket.sent[1] as unknown as Record<string, unknown>).code).toBe("negotiation-failed");
  });

  it("rejects a malformed SDP offer without calling the provider", async () => {
    const negotiate = vi.fn(okAsync);
    const { socket, conn } = connect({ negotiate });
    conn.start(false);
    socket.sent.length = 0;
    await conn.receive(clientMessage("signal.sdp.offer", 1, { sdp: "not-an-sdp" }));
    expect(negotiate).not.toHaveBeenCalled();
    expect(kinds(socket)).toEqual(["error"]);
    expect((socket.sent[0] as unknown as Record<string, unknown>).code).toBe("invalid-message");
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

  it("acknowledges capability.select and an interrupt, and ignores ICE / partial transcript", async () => {
    const { socket, conn } = connect();
    conn.start(false);
    socket.sent.length = 0;
    await conn.receive(clientMessage("capability.select", 1, { profile: "full-realtime" }));
    await conn.receive(clientMessage("control.interrupt", 2, { atMs: 120 }));
    await conn.receive(clientMessage("signal.ice.candidate", 3, { candidate: "candidate:..." }));
    await conn.receive(clientMessage("transcript.partial", 4, { text: "hel" }));
    expect(kinds(socket)).toEqual(["policy.decision", "playback.state"]);
    expect((socket.sent[0] as unknown as Record<string, unknown>).decision).toBe("allow");
    expect((socket.sent[1] as unknown as Record<string, unknown>).state).toBe("interrupted");
  });
});

describe("VoiceControlConnection transcripts, replay & teardown", () => {
  it("sanitises a committed transcript and records it into the replay buffer without echoing", async () => {
    const { socket, session, conn } = connect();
    conn.start(false);
    socket.sent.length = 0;
    // A bidi-override + zero-width injection in the transcript text.
    await conn.receive(clientMessage("transcript.committed", 1, { text: "ok‮text​ done" }));
    // Not echoed back to the connected client...
    expect(socket.sent).toHaveLength(0);
    // ...but recorded (sanitised) into the reconnect replay buffer.
    const recorded = session.replay.find((m) => m.kind === "transcript.committed") as
      | Record<string, unknown>
      | undefined;
    expect(recorded).toBeDefined();
    expect(recorded?.text).toBe("oktext done");
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
    const dead = { isAlive: false, ping: vi.fn(), terminate: vi.fn() };
    const live = { isAlive: true, ping: vi.fn(), terminate: vi.fn() };
    sweepControlHeartbeat([dead, live]);
    expect(dead.terminate).toHaveBeenCalledTimes(1);
    expect(dead.ping).not.toHaveBeenCalled();
    expect(live.terminate).not.toHaveBeenCalled();
    expect(live.ping).toHaveBeenCalledTimes(1);
    // The live socket must answer THIS ping (isAlive re-armed to false) or be terminated next sweep.
    expect(live.isAlive).toBe(false);
  });

  it("treats a freshly-connected socket (isAlive undefined) as live", () => {
    const fresh: {
      isAlive?: boolean;
      ping: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
    } = { ping: vi.fn(), terminate: vi.fn() };
    sweepControlHeartbeat([fresh]);
    expect(fresh.terminate).not.toHaveBeenCalled();
    expect(fresh.ping).toHaveBeenCalledTimes(1);
    expect(fresh.isAlive).toBe(false);
  });
});
