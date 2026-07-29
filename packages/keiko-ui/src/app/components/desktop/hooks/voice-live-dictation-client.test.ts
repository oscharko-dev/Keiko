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
  socket.fire("close");
  return outcome;
}

describe("createBrowserVoiceLiveDictationControlClient", () => {
  it("accepts correlation ids at the exact browser trust-boundary limits", async (): Promise<void> => {
    for (const correlationId of ["a", "a".repeat(128)]) {
      const error = await negotiateUntilServerError(correlationId);

      expect(error).toBeInstanceOf(VoiceLiveDictationControlError);
      expect(error).toMatchObject({
        reason: "negotiation-failed",
        correlationId,
      });
    }
  });

  it("drops empty, oversized, non-string, and hostile correlation ids", async (): Promise<void> => {
    const invalidIds: readonly unknown[] = [
      "",
      "a".repeat(129),
      42,
      null,
      "provider detail",
      "<script>alert(1)</script>",
      "line\nbreak",
    ];
    for (const correlationId of invalidIds) {
      const error = await negotiateUntilServerError(correlationId);

      expect(error).toBeInstanceOf(VoiceLiveDictationControlError);
      expect(error).toMatchObject({ reason: "negotiation-failed" });
      expect((error as VoiceLiveDictationControlError).correlationId).toBeUndefined();
    }
  });
});
