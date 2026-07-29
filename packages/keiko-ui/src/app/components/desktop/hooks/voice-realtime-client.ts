// Issue #497, Epic #491 — the injectable WebSocket control/signaling seam for the realtime Voice
// Digital Twin. This module owns ONLY the control-plane WebSocket: it opens the WS, runs the
// proxied-SDP handshake (session.create → signal.sdp.offer → receives signal.sdp.answer), resolves
// with the answer SDP, and then stays quiet. It never touches raw audio or the media plane (AC1).
// Native WebSocket only — no third-party package added (supply-chain invariant).

import {
  DEFAULT_VOICE_PROTOCOL_TIMEOUTS,
  VOICE_PROTOCOL_VERSION,
  decodeVoiceControlMessage,
  type VoiceSessionChatContext,
} from "@oscharko-dev/keiko-contracts";

// Upper bound on the whole proxied-SDP handshake (open → session.created → answer). A server that
// accepts the upgrade but then stalls (no session.created / no answer) would otherwise leave the
// caller hanging on "negotiating" forever; this fails it closed so the composer can degrade to text.
const NEGOTIATE_TIMEOUT_MS = DEFAULT_VOICE_PROTOCOL_TIMEOUTS.signalingMs;

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
  // A transport recovery detaches but preserves the server-side replay identity. Every deliberate
  // teardown is terminal and sends session.close before closing the socket.
  close(options?: { readonly resumable?: boolean | undefined }): void;
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
  chatContext?: VoiceSessionChatContext,
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
    ...(chatContext !== undefined ? { chatContext } : {}),
  };
}

function buildSdpOfferPayload(
  sessionId: string,
  seq: number,
  sdp: string,
): Record<string, unknown> {
  return {
    protocolVersion: VOICE_PROTOCOL_VERSION,
    sessionId,
    seq,
    direction: "client-to-host",
    kind: "signal.sdp.offer",
    sdp,
  };
}

function buildSessionClosePayload(sessionId: string, seq: number): Record<string, unknown> {
  return {
    protocolVersion: VOICE_PROTOCOL_VERSION,
    sessionId,
    seq,
    direction: "client-to-host",
    kind: "session.close",
    reason: "client-request",
  };
}

// Factory. Accepts an optional injected WebSocket-like factory for tests; defaults to the global
// WebSocket so no real URL is opened unless the real browser client is used.
export function createBrowserVoiceControlClient(
  socketFactory?: WebSocketFactory,
  chatContext?: VoiceSessionChatContext,
): VoiceControlClient {
  const factory = socketFactory ?? ((url: string) => new WebSocket(url));
  let ws: WebSocket | undefined;
  const sessionId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  let nextClientSeq = 1;
  let cancelPendingNegotiation: (() => void) | undefined;

  return {
    negotiate(offerSdp: string): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const offerSeq = nextClientSeq;
        nextClientSeq += 1;
        let socket: WebSocket;

        try {
          socket = factory(buildWsUrl());
          ws = socket;
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
        let settled = false;

        // Settle exactly once and clear the handshake timeout. Closing a settled socket is the caller's
        // job (close()); the timeout path closes it itself before rejecting.
        let timer: ReturnType<typeof setTimeout> | undefined;
        let pendingCancellation: (() => void) | undefined;
        const clearTimer = (): void => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
        };
        const resolveOnce = (sdp: string): void => {
          if (settled) return;
          settled = true;
          clearTimer();
          if (cancelPendingNegotiation === pendingCancellation) {
            cancelPendingNegotiation = undefined;
          }
          resolve(sdp);
        };
        const rejectOnce = (error: VoiceControlError): void => {
          if (settled) return;
          settled = true;
          clearTimer();
          if (cancelPendingNegotiation === pendingCancellation) {
            cancelPendingNegotiation = undefined;
          }
          reject(error);
        };
        pendingCancellation = (): void => {
          rejectOnce(
            new VoiceControlError("connection-failed", "Voice control negotiation was closed."),
          );
        };
        cancelPendingNegotiation = pendingCancellation;
        timer = setTimeout(() => {
          timer = undefined;
          rejectOnce(
            new VoiceControlError("connection-failed", "Voice control negotiation timed out."),
          );
          try {
            socket.close();
          } catch {
            // Ignore — already closing.
          }
        }, NEGOTIATE_TIMEOUT_MS);

        socket.addEventListener("error", () => {
          if (!opened) {
            rejectOnce(new VoiceControlError("unavailable", "Voice control connection failed."));
          } else {
            rejectOnce(
              new VoiceControlError("connection-failed", "Voice control connection was lost."),
            );
          }
        });

        socket.addEventListener("close", () => {
          if (!opened) {
            rejectOnce(
              new VoiceControlError("unavailable", "Voice control connection was closed."),
            );
          } else {
            // Closed after open but before the answer: the handshake was lost — fail fast instead of
            // waiting out the negotiation timeout. A no-op once the negotiation has already resolved.
            rejectOnce(
              new VoiceControlError(
                "connection-failed",
                "Voice control connection closed during negotiation.",
              ),
            );
          }
        });

        socket.addEventListener("open", () => {
          if (settled) return;
          opened = true;
          socket.send(
            JSON.stringify(buildSessionCreatePayload(sessionId, idempotencyKey, chatContext)),
          );
        });

        socket.addEventListener("message", (event: MessageEvent) => {
          if (settled) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
          } catch {
            rejectOnce(
              new VoiceControlError(
                "connection-failed",
                "Received an unparseable control message.",
              ),
            );
            return;
          }

          const msg = decodeVoiceControlMessage(parsed);
          if (msg === undefined) {
            return;
          }

          if (msg.kind === "error") {
            const reason =
              msg.code === "negotiation-failed" ? "negotiation-failed" : "connection-failed";
            rejectOnce(new VoiceControlError(reason, `Voice control error: ${msg.code}`));
            return;
          }

          if (msg.kind === "session.created") {
            if (sessionCreated) return;
            sessionCreated = true;
            // Send the SDP offer once the session is established.
            socket.send(JSON.stringify(buildSdpOfferPayload(sessionId, offerSeq, offerSdp)));
            return;
          }

          if (msg.kind === "signal.sdp.answer" && sessionCreated) {
            resolveOnce(msg.sdp);
          }

          // "capability.offer" and "media.track.state" (negotiating) are expected and ignored.
        });
      });
    },

    close(options = {}): void {
      cancelPendingNegotiation?.();
      if (options.resumable !== true && ws !== undefined) {
        try {
          ws.send(JSON.stringify(buildSessionClosePayload(sessionId, nextClientSeq)));
          nextClientSeq += 1;
        } catch {
          // A socket that never opened has no server-side session to terminate.
        }
      }
      try {
        ws?.close();
      } catch {
        // Ignore — already closed.
      }
      ws = undefined;
    },
  };
}
