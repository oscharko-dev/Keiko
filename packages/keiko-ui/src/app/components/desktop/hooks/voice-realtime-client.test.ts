// Issue #497 — the WebSocket control/signaling client. Uses an injected fake WebSocket to drive the
// full proxied-SDP handshake without a real server. Covers: happy path returns the answer SDP,
// server error{code:negotiation-failed} rejects with reason "negotiation-failed", WS closing before
// open rejects with reason "unavailable", and close() closes the WebSocket.

import { describe, expect, it, vi } from "vitest";
import { createBrowserVoiceControlClient, VoiceControlError } from "./voice-realtime-client";
import {
  DEFAULT_VOICE_PROTOCOL_TIMEOUTS,
  VOICE_PROTOCOL_VERSION,
} from "@oscharko-dev/keiko-contracts";

type WsListener = (event: unknown) => void;

// A fake WebSocket that captures listeners and exposes helpers to fire them from tests.
class FakeWebSocket {
  public static readonly instances: FakeWebSocket[] = [];

  private readonly listeners: Record<string, WsListener[]> = {};
  public readonly url: string;
  public closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: WsListener): void {
    (this.listeners[type] ??= []).push(cb);
  }

  send(_data: string): void {}

  close(): void {
    this.closed = true;
  }

  // Test helpers to simulate server events.
  fireOpen(): void {
    for (const cb of this.listeners["open"] ?? []) cb({});
  }

  fireMessage(data: unknown): void {
    for (const cb of this.listeners["message"] ?? []) cb({ data: JSON.stringify(data) });
  }

  fireError(): void {
    for (const cb of this.listeners["error"] ?? []) cb({});
  }

  fireClose(): void {
    for (const cb of this.listeners["close"] ?? []) cb({});
  }
}

function makeFactory(): { factory: (url: string) => WebSocket; latest: () => FakeWebSocket } {
  FakeWebSocket.instances.length = 0;
  const factory = (url: string) => new FakeWebSocket(url) as unknown as WebSocket;
  const latest = (): FakeWebSocket => {
    const inst = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (inst === undefined) throw new Error("No FakeWebSocket instance created");
    return inst;
  };
  return { factory, latest };
}

// Helper: build a valid server message envelope.
function serverMsg(kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: VOICE_PROTOCOL_VERSION,
    sessionId: "srv-session",
    seq: 0,
    direction: "host-to-client",
    kind,
    ...extra,
  };
}

describe("createBrowserVoiceControlClient", () => {
  it("runs the full happy handshake and resolves with the answer SDP", async () => {
    const { factory, latest } = makeFactory();
    const client = createBrowserVoiceControlClient(factory);
    const negotiatePromise = client.negotiate("v=0\r\noffer-sdp");

    const ws = latest();
    // Simulate WS open + session.created + (optionally capability.offer) + signal.sdp.answer
    ws.fireOpen();
    ws.fireMessage(
      serverMsg("session.created", {
        profile: "full-realtime",
        controlTransport: "loopback-websocket",
        mediaTransport: "webrtc",
        negotiationMode: "proxied-sdp",
      }),
    );
    // capability.offer is ignored; media.track.state is ignored.
    ws.fireMessage(
      serverMsg("capability.offer", {
        profile: "full-realtime",
        capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
      }),
    );
    ws.fireMessage(serverMsg("signal.sdp.answer", { sdp: "v=0\r\nanswer-sdp" }));

    const answerSdp = await negotiatePromise;
    expect(answerSdp).toBe("v=0\r\nanswer-sdp");
  });

  it("rejects with 'negotiation-failed' when the server sends an error of that code", async () => {
    const { factory, latest } = makeFactory();
    const client = createBrowserVoiceControlClient(factory);
    const negotiatePromise = client.negotiate("v=0\r\noffer-sdp");

    const ws = latest();
    ws.fireOpen();
    ws.fireMessage(
      serverMsg("session.created", {
        profile: "full-realtime",
        controlTransport: "loopback-websocket",
        mediaTransport: "webrtc",
        negotiationMode: "proxied-sdp",
      }),
    );
    ws.fireMessage(serverMsg("error", { code: "negotiation-failed" }));

    await expect(negotiatePromise).rejects.toMatchObject({ reason: "negotiation-failed" });
  });

  it("rejects with 'connection-failed' for a generic server error code", async () => {
    const { factory, latest } = makeFactory();
    const client = createBrowserVoiceControlClient(factory);
    const negotiatePromise = client.negotiate("v=0\r\noffer-sdp");

    const ws = latest();
    ws.fireOpen();
    ws.fireMessage(
      serverMsg("session.created", {
        profile: "full-realtime",
        controlTransport: "loopback-websocket",
        mediaTransport: "webrtc",
        negotiationMode: "proxied-sdp",
      }),
    );
    ws.fireMessage(serverMsg("error", { code: "internal" }));

    await expect(negotiatePromise).rejects.toMatchObject({ reason: "connection-failed" });
  });

  it("rejects with 'unavailable' when the WebSocket fires error before open", async () => {
    const { factory, latest } = makeFactory();
    const client = createBrowserVoiceControlClient(factory);
    const negotiatePromise = client.negotiate("v=0\r\noffer-sdp");

    const ws = latest();
    ws.fireError(); // before open

    await expect(negotiatePromise).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("rejects with 'unavailable' when the WebSocket closes before open", async () => {
    const { factory, latest } = makeFactory();
    const client = createBrowserVoiceControlClient(factory);
    const negotiatePromise = client.negotiate("v=0\r\noffer-sdp");

    const ws = latest();
    ws.fireClose(); // before open

    await expect(negotiatePromise).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("rejects with a VoiceControlError instance on failure", async () => {
    const { factory, latest } = makeFactory();
    const client = createBrowserVoiceControlClient(factory);
    const negotiatePromise = client.negotiate("v=0\r\noffer-sdp");

    const ws = latest();
    ws.fireError(); // triggers unavailable

    const error = await negotiatePromise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VoiceControlError);
  });

  it("close() closes the WebSocket", async () => {
    const { factory, latest } = makeFactory();
    const client = createBrowserVoiceControlClient(factory);
    // Start a negotiate then close immediately.
    void client.negotiate("v=0\r\noffer").catch(() => {});
    const ws = latest();
    ws.fireError(); // settle the promise
    client.close();
    expect(ws.closed).toBe(true);
  });

  it("sends session.create on WS open with correct protocol version", async () => {
    const { factory, latest } = makeFactory();
    const sendSpy = vi.fn();
    const client = createBrowserVoiceControlClient(factory);
    void client.negotiate("v=0\r\noffer").catch(() => {});

    const ws = latest();
    ws.send = sendSpy;
    ws.fireOpen();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const firstCall = sendSpy.mock.calls[0];
    const firstArg = firstCall !== undefined ? (firstCall[0] as string) : "";
    const parsed = JSON.parse(firstArg) as Record<string, unknown>;
    expect(parsed.protocolVersion).toBe(VOICE_PROTOCOL_VERSION);
    expect(parsed.kind).toBe("session.create");
    expect(parsed.direction).toBe("client-to-host");
    expect(parsed.seq).toBe(0);

    // Clean up — fire close so the promise doesn't linger.
    ws.fireClose();
  });

  it("includes the selected persona (content-free) in session.create when provided", async () => {
    const { factory, latest } = makeFactory();
    const sendSpy = vi.fn();
    const client = createBrowserVoiceControlClient(factory, "female");
    void client.negotiate("v=0\r\noffer").catch(() => {});
    const ws = latest();
    ws.send = sendSpy;
    ws.fireOpen();
    const parsed = JSON.parse(sendSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(parsed.kind).toBe("session.create");
    expect(parsed.persona).toBe("female");
    ws.fireClose();
  });

  it("omits persona from session.create when none is selected (default voice)", async () => {
    const { factory, latest } = makeFactory();
    const sendSpy = vi.fn();
    const client = createBrowserVoiceControlClient(factory);
    void client.negotiate("v=0\r\noffer").catch(() => {});
    const ws = latest();
    ws.send = sendSpy;
    ws.fireOpen();
    const parsed = JSON.parse(sendSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect("persona" in parsed).toBe(false);
    ws.fireClose();
  });

  it("reuses resume identifiers and increments SDP offer sequence across repeated negotiations", async () => {
    const { factory, latest } = makeFactory();
    const client = createBrowserVoiceControlClient(factory);

    const firstSent: Record<string, unknown>[] = [];
    const first = client.negotiate("v=0\r\nfirst-offer");
    const firstWs = latest();
    firstWs.send = (data: string): void => {
      firstSent.push(JSON.parse(data) as Record<string, unknown>);
    };
    firstWs.fireOpen();
    firstWs.fireMessage(serverMsg("session.created"));
    firstWs.fireMessage(serverMsg("signal.sdp.answer", { sdp: "v=0\r\nfirst-answer" }));
    await expect(first).resolves.toBe("v=0\r\nfirst-answer");

    const secondSent: Record<string, unknown>[] = [];
    const second = client.negotiate("v=0\r\nsecond-offer");
    const secondWs = latest();
    secondWs.send = (data: string): void => {
      secondSent.push(JSON.parse(data) as Record<string, unknown>);
    };
    secondWs.fireOpen();
    secondWs.fireMessage(serverMsg("session.created"));
    secondWs.fireMessage(serverMsg("signal.sdp.answer", { sdp: "v=0\r\nsecond-answer" }));
    await expect(second).resolves.toBe("v=0\r\nsecond-answer");

    expect(firstSent[0]?.kind).toBe("session.create");
    expect(secondSent[0]?.kind).toBe("session.create");
    expect(secondSent[0]?.sessionId).toBe(firstSent[0]?.sessionId);
    expect(secondSent[0]?.idempotencyKey).toBe(firstSent[0]?.idempotencyKey);
    expect(firstSent[1]).toMatchObject({ kind: "signal.sdp.offer", seq: 1 });
    expect(secondSent[1]).toMatchObject({ kind: "signal.sdp.offer", seq: 2 });
  });

  it("rejects connection-failed and closes the socket when the handshake stalls past the timeout", async () => {
    vi.useFakeTimers();
    try {
      const { factory, latest } = makeFactory();
      const client = createBrowserVoiceControlClient(factory);
      const settled = client.negotiate("v=0\r\noffer");
      // Attach the rejection expectation BEFORE the timer fires so the rejection is never momentarily
      // unhandled (vitest reports a transiently-unhandled rejection as a false-positive error).
      const rejection = expect(settled).rejects.toMatchObject({ reason: "connection-failed" });
      const ws = latest();
      ws.fireOpen(); // opens + sends session.create, but the server never replies
      await vi.advanceTimersByTimeAsync(DEFAULT_VOICE_PROTOCOL_TIMEOUTS.signalingMs + 50);
      await rejection;
      expect(ws.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout on a successful handshake (does not close a live socket later)", async () => {
    vi.useFakeTimers();
    try {
      const { factory, latest } = makeFactory();
      const client = createBrowserVoiceControlClient(factory);
      const settled = client.negotiate("v=0\r\noffer");
      const ws = latest();
      ws.fireOpen();
      ws.fireMessage(serverMsg("session.created"));
      ws.fireMessage(serverMsg("signal.sdp.answer", { sdp: "v=0\r\nanswer" }));
      await expect(settled).resolves.toBe("v=0\r\nanswer");
      await vi.advanceTimersByTimeAsync(DEFAULT_VOICE_PROTOCOL_TIMEOUTS.signalingMs + 50);
      expect(ws.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
