// Issue #497, Epic #491 — the injectable WebSocket control/signaling seam for the realtime Voice
// Digital Twin. This module owns ONLY the control-plane WebSocket: it opens the WS, runs the
// proxied-SDP handshake (session.create → signal.sdp.offer → receives signal.sdp.answer), resolves
// with the answer SDP, and then stays quiet. It never touches raw audio or the media plane (AC1).
// Native WebSocket only — no third-party package added (supply-chain invariant).

import {
  VOICE_PROTOCOL_VERSION,
  type VoiceControlMessage,
  type VoicePersona,
  isVoiceControlMessage,
} from "@oscharko-dev/keiko-contracts";

export class VoiceControlError extends Error {
  constructor(
    // "unavailable"         — the WS upgrade was rejected (server not capable / WS closed before open).
    // "negotiation-failed"  — the server replied with error{code:"negotiation-failed"}.
    // "connection-failed"   — any other WS or protocol failure.
    public readonly reason: "unavailable" | "negotiation-failed" | "connection-failed",
    message: string,
  ) {
    super(message);
    this.name = "VoiceControlError";
  }
}

// A live WebSocket-backed control client. `negotiate` runs the full handshake and resolves with the
// server's answer SDP; `close` tears down the WebSocket (safe to call at any time).
export interface VoiceControlClient {
  negotiate(offerSdp: string): Promise<string>;
  close(): void;
}

// WebSocket factory seam — defaults to the global WebSocket; override in tests.
type WebSocketFactory = (url: string) => WebSocket;

function buildWsUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/voice/control`;
}

function buildSessionCreatePayload(
  sessionId: string,
  idempotencyKey: string,
  persona?: VoicePersona,
): Record<string, unknown> {
  return {
    protocolVersion: VOICE_PROTOCOL_VERSION,
    sessionId,
    seq: 0,
    direction: "client-to-host",
    kind: "session.create",
    idempotencyKey,
    requestedProfile: "full-realtime",
    negotiationMode: "proxied-sdp",
    // Content-free persona enum so the host can resolve the realtime voice to the user's choice.
    ...(persona !== undefined ? { persona } : {}),
  };
}

function buildSdpOfferPayload(sessionId: string, sdp: string): Record<string, unknown> {
  return {
    protocolVersion: VOICE_PROTOCOL_VERSION,
    sessionId,
    seq: 1,
    direction: "client-to-host",
    kind: "signal.sdp.offer",
    sdp,
  };
}

// Factory. Accepts an optional injected WebSocket-like factory for tests; defaults to the global
// WebSocket so no real URL is opened unless the real browser client is used.
export function createBrowserVoiceControlClient(
  socketFactory?: WebSocketFactory,
  persona?: VoicePersona,
): VoiceControlClient {
  const factory = socketFactory ?? ((url: string) => new WebSocket(url));
  let ws: WebSocket | undefined;

  return {
    negotiate(offerSdp: string): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const sessionId = crypto.randomUUID();
        const idempotencyKey = crypto.randomUUID();

        try {
          ws = factory(buildWsUrl());
        } catch (error) {
          reject(
            new VoiceControlError(
              "unavailable",
              error instanceof Error ? error.message : "WebSocket could not be opened.",
            ),
          );
          return;
        }

        // Whether we've got past the "open" event — if we close before open we report "unavailable".
        let opened = false;
        let sessionCreated = false;

        ws.addEventListener("error", () => {
          if (!opened) {
            reject(new VoiceControlError("unavailable", "Voice control connection failed."));
          } else {
            reject(
              new VoiceControlError("connection-failed", "Voice control connection was lost."),
            );
          }
        });

        ws.addEventListener("close", () => {
          if (!opened) {
            reject(new VoiceControlError("unavailable", "Voice control connection was closed."));
          }
        });

        ws.addEventListener("open", () => {
          opened = true;
          ws?.send(JSON.stringify(buildSessionCreatePayload(sessionId, idempotencyKey, persona)));
        });

        ws.addEventListener("message", (event: MessageEvent) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
          } catch {
            reject(
              new VoiceControlError(
                "connection-failed",
                "Received an unparseable control message.",
              ),
            );
            return;
          }

          if (!isVoiceControlMessage(parsed)) {
            return;
          }

          const msg = parsed as VoiceControlMessage;

          if (msg.kind === "error") {
            const errorMsg = msg as Extract<VoiceControlMessage, { kind: "error" }>;
            const reason =
              errorMsg.code === "negotiation-failed" ? "negotiation-failed" : "connection-failed";
            reject(new VoiceControlError(reason, `Voice control error: ${errorMsg.code}`));
            return;
          }

          if (msg.kind === "session.created") {
            sessionCreated = true;
            // Send the SDP offer once the session is established.
            ws?.send(JSON.stringify(buildSdpOfferPayload(sessionId, offerSdp)));
            return;
          }

          if (msg.kind === "signal.sdp.answer" && sessionCreated) {
            const answerMsg = msg as Extract<VoiceControlMessage, { kind: "signal.sdp.answer" }>;
            resolve(answerMsg.sdp);
            return;
          }

          // "capability.offer" and "media.track.state" (negotiating) are expected and ignored.
        });
      });
    },

    close(): void {
      try {
        ws?.close();
      } catch {
        // Ignore — already closed.
      }
      ws = undefined;
    },
  };
}
