// WebSocket control/signaling seam for live dictation. This is the transcription-only sibling of
// voice-realtime-client.ts: it opens the dedicated BFF path, creates a full-realtime media posture
// solely for microphone/WebRTC capture, exchanges SDP, and then leaves transcript events to the
// provider data channel. It never sends chat context, persona, assistant instructions, tools, raw
// audio, provider credentials, or transcript text.

import {
  DEFAULT_VOICE_PROTOCOL_TIMEOUTS,
  VOICE_PROTOCOL_VERSION,
  isVoiceControlMessage,
  type VoiceControlMessage,
} from "@oscharko-dev/keiko-contracts";

const LIVE_TRANSCRIBE_PATH = "/api/voice/transcribe/live";
const NEGOTIATE_TIMEOUT_MS = DEFAULT_VOICE_PROTOCOL_TIMEOUTS.signalingMs;

export class VoiceLiveDictationControlError extends Error {
  constructor(
    public readonly reason: "unavailable" | "negotiation-failed" | "connection-failed",
    message: string,
  ) {
    super(message);
    this.name = "VoiceLiveDictationControlError";
  }
}

export interface VoiceLiveDictationControlClient {
  negotiate(offerSdp: string): Promise<string>;
  close(): void;
}

type WebSocketFactory = (url: string) => WebSocket;

function buildWsUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${LIVE_TRANSCRIBE_PATH}`;
}

function buildSessionCreatePayload(
  sessionId: string,
  idempotencyKey: string,
  transcriptionLanguage: string | undefined,
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
    ...(transcriptionLanguage !== undefined ? { transcriptionLanguage } : {}),
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

export function createBrowserVoiceLiveDictationControlClient(
  socketFactory?: WebSocketFactory,
  transcriptionLanguage?: string,
): VoiceLiveDictationControlClient {
  const factory = socketFactory ?? ((url: string) => new WebSocket(url));
  let ws: WebSocket | undefined;
  const sessionId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  let nextOfferSeq = 1;

  return {
    negotiate(offerSdp: string): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const offerSeq = nextOfferSeq;
        nextOfferSeq += 1;

        try {
          ws = factory(buildWsUrl());
        } catch (error) {
          reject(
            new VoiceLiveDictationControlError(
              "unavailable",
              error instanceof Error ? error.message : "Live dictation control could not open.",
            ),
          );
          return;
        }

        let opened = false;
        let sessionCreated = false;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
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
          resolve(sdp);
        };
        const rejectOnce = (error: VoiceLiveDictationControlError): void => {
          if (settled) return;
          settled = true;
          clearTimer();
          reject(error);
        };

        timer = setTimeout(() => {
          timer = undefined;
          try {
            ws?.close();
          } catch {
            // Ignore — already closing.
          }
          rejectOnce(
            new VoiceLiveDictationControlError(
              "connection-failed",
              "Live dictation negotiation timed out.",
            ),
          );
        }, NEGOTIATE_TIMEOUT_MS);

        ws.addEventListener("error", () => {
          if (!opened) {
            rejectOnce(
              new VoiceLiveDictationControlError(
                "unavailable",
                "Live dictation control connection failed.",
              ),
            );
            return;
          }
          rejectOnce(
            new VoiceLiveDictationControlError(
              "connection-failed",
              "Live dictation control connection was lost.",
            ),
          );
        });

        ws.addEventListener("close", () => {
          if (!opened) {
            rejectOnce(
              new VoiceLiveDictationControlError(
                "unavailable",
                "Live dictation control connection was closed.",
              ),
            );
            return;
          }
          rejectOnce(
            new VoiceLiveDictationControlError(
              "connection-failed",
              "Live dictation control connection closed during negotiation.",
            ),
          );
        });

        ws.addEventListener("open", () => {
          opened = true;
          ws?.send(
            JSON.stringify(
              buildSessionCreatePayload(sessionId, idempotencyKey, transcriptionLanguage),
            ),
          );
        });

        ws.addEventListener("message", (event: MessageEvent) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
          } catch {
            rejectOnce(
              new VoiceLiveDictationControlError(
                "connection-failed",
                "Received an unparseable live dictation control message.",
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
            rejectOnce(
              new VoiceLiveDictationControlError(reason, `Live dictation error: ${errorMsg.code}`),
            );
            return;
          }

          if (msg.kind === "session.created") {
            sessionCreated = true;
            ws?.send(JSON.stringify(buildSdpOfferPayload(sessionId, offerSeq, offerSdp)));
            return;
          }

          if (msg.kind === "signal.sdp.answer" && sessionCreated) {
            const answerMsg = msg as Extract<VoiceControlMessage, { kind: "signal.sdp.answer" }>;
            resolveOnce(answerMsg.sdp);
          }
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
