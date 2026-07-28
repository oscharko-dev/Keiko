import { describe, expect, it } from "vitest";
import { VOICE_PROTOCOL_VERSION } from "@oscharko-dev/keiko-contracts";
import {
  createBrowserVoiceLiveDictationControlClient,
  VoiceLiveDictationControlError,
} from "./voice-live-dictation-client";

type WsListener = (event: unknown) => void;

class FakeWebSocket {
  private readonly listeners: Record<string, WsListener[]> = {};
  readonly sent: string[] = [];
  closed = false;

  addEventListener(type: string, listener: WsListener): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  fire(type: string, data?: unknown): void {
    for (const listener of this.listeners[type] ?? []) {
      listener(data === undefined ? {} : { data: JSON.stringify(data) });
    }
  }
}

function serverMessage(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    protocolVersion: VOICE_PROTOCOL_VERSION,
    sessionId: "sess-live-1",
    seq: 0,
    direction: "host-to-client",
    kind,
    ...payload,
  };
}

function negotiateUntilServerError(correlationId: unknown): Promise<unknown> {
  const socket = new FakeWebSocket();
  const client = createBrowserVoiceLiveDictationControlClient(
    () => socket as unknown as WebSocket,
    "en",
  );
  const outcome = client.negotiate("v=0\r\nlive-offer").catch((error: unknown) => error);
  socket.fire("open");
  socket.fire(
    "message",
    serverMessage("session.created", {
      profile: "full-realtime",
      controlTransport: "loopback-websocket",
      mediaTransport: "webrtc",
      negotiationMode: "proxied-sdp",
    }),
  );
  socket.fire(
    "message",
    serverMessage("error", {
      code: "negotiation-failed",
      correlationId,
    }),
  );
  return outcome;
}

describe("createBrowserVoiceLiveDictationControlClient", () => {
  it("carries a bounded server correlation id into the UI error", async () => {
    const error = await negotiateUntilServerError("dictation-corr-2806");

    expect(error).toBeInstanceOf(VoiceLiveDictationControlError);
    expect(error).toMatchObject({
      reason: "negotiation-failed",
      correlationId: "dictation-corr-2806",
    });
  });

  it("drops an unbounded correlation id at the browser trust boundary", async () => {
    const error = await negotiateUntilServerError("provider detail ".repeat(20));

    expect(error).toBeInstanceOf(VoiceLiveDictationControlError);
    expect(error).toMatchObject({ reason: "negotiation-failed" });
    expect((error as VoiceLiveDictationControlError).correlationId).toBeUndefined();
  });
});
