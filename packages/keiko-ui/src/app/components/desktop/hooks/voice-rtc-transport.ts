// Issue #497, Epic #491 — the injectable native-WebRTC seam for the realtime Voice Digital Twin.
//
// Isolates the only code that touches browser media hardware (getUserMedia, RTCPeerConnection) behind
// a small, injectable interface so the realtime state machine (useRealtimeVoice) and its tests never
// depend on real hardware. Native browser APIs only — no third-party package is added (supply-chain
// invariant). The seam uses proxied-SDP negotiation: the browser creates an offer, waits for ICE
// gathering to complete (non-trickle), then sends the complete SDP to the BFF. The BFF returns an
// answer which the browser applies via setRemoteDescription.

// Why a realtime connection could not start. Each maps to a specific non-blocking error in the
// composer; the realtime transport stays clean and fully text-capable in every case (AC4).
//   - "permission-denied"    — the user or deployment policy denied microphone access.
//   - "no-microphone"        — no usable audio input device is present.
//   - "unsupported"          — the browser does not expose getUserMedia / RTCPeerConnection.
//   - "negotiation-failed"   — the SDP handshake with the BFF did not succeed.
//   - "connection-failed"    — any other failure (RTCPeerConnection error, ice, etc.).
export type VoiceRtcStartFailure =
  | "permission-denied"
  | "no-microphone"
  | "unsupported"
  | "negotiation-failed"
  | "connection-failed";

export class VoiceRtcError extends Error {
  constructor(
    public readonly reason: VoiceRtcStartFailure,
    message: string,
  ) {
    super(message);
    this.name = "VoiceRtcError";
  }
}

// An active WebRTC session. Once `connect()` resolves, `offerSdp` holds the complete local SDP
// (ICE candidates already gathered — non-trickle proxied-SDP mode). The caller sends it to the
// server, gets back an answer, and calls `applyAnswer`. Event callbacks must be registered before
// `applyAnswer` is called to avoid missing early connection-state events.
export interface VoiceRtcSession {
  readonly offerSdp: string;
  applyAnswer(sdp: string): Promise<void>;
  onRemoteTrack(cb: (stream: MediaStream) => void): void;
  onConnectionStateChange(cb: (state: RTCPeerConnectionState) => void): void;
  onDataChannelEvent?(cb: (event: unknown) => void): void;
  onDataChannelStateChange?(cb: (state: RTCDataChannelState) => void): void;
  sendDataChannelEvent?(event: unknown): boolean;
  close(): void;
}

// The capture seam. `connect()` acquires the microphone, builds a peer connection, creates a local
// SDP offer (waiting for ICE gathering to complete), and resolves with the session. Rejects with a
// `VoiceRtcError` on denial / missing device / unsupported browser.
export interface VoiceRtcTransport {
  connect(): Promise<VoiceRtcSession>;
}

// True when the running browser exposes the required real-time media APIs.
export function realtimeVoiceTransportSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.mediaDevices !== undefined &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof RTCPeerConnection !== "undefined"
  );
}

function classifyGetUserMediaError(error: unknown): VoiceRtcStartFailure {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "permission-denied";
  }
  if (
    name === "NotFoundError" ||
    name === "OverconstrainedError" ||
    name === "DevicesNotFoundError"
  ) {
    return "no-microphone";
  }
  return "connection-failed";
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

// Full-duplex voice capture constraints. In a realtime dialogue the assistant's audio plays through
// the user's speakers and would otherwise feed back into the microphone — the model then hears itself,
// producing false barge-ins and garbled, "choppy" dialogue. Enabling the browser's echo canceller,
// noise suppression, and auto gain control is the standard fix; mono is sufficient for speech and
// halves the uplink. Bare `{ audio: true }` (the previous behavior) negotiates none of these.
const FULL_DUPLEX_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

// Acquire the microphone with the full-duplex constraints, falling back to the unconstrained mic only
// when a device/driver cannot satisfy them (OverconstrainedError) — so a constrained-but-capable
// device gets echo cancellation while an inflexible one still connects rather than failing the session.
async function acquireMicrophone(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: FULL_DUPLEX_AUDIO_CONSTRAINTS });
  } catch (error) {
    if (error instanceof Error && error.name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    throw error;
  }
}

// Non-trickle ICE gathering: wait until pc.iceGatheringState is "complete" before resolving with
// the local description. A bounded fallback timeout (~2 s) avoids hanging forever if the browser
// never fires the event (e.g. in a headless test environment with no network interfaces).
const ICE_GATHER_TIMEOUT_MS = 2_000;

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  return new Promise<void>((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    let fallback: ReturnType<typeof setTimeout> | undefined;
    // Resolve once, removing the listener so it never outlives ICE completion (and never re-fires on a
    // later gathering transition, e.g. a network-interface change). The fallback timeout removes it too.
    const onChange = (): void => {
      if (pc.iceGatheringState !== "complete") {
        return;
      }
      if (fallback !== undefined) {
        clearTimeout(fallback);
      }
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    fallback = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

function buildSession(
  pc: RTCPeerConnection,
  stream: MediaStream,
  dataChannel: RTCDataChannel,
): VoiceRtcSession {
  const localDescription = pc.localDescription;
  if (localDescription === null) {
    throw new VoiceRtcError("connection-failed", "Local SDP description is unavailable.");
  }
  const offerSdp = localDescription.sdp;

  let remoteTrackCb: ((stream: MediaStream) => void) | undefined;
  let connectionStateCb: ((state: RTCPeerConnectionState) => void) | undefined;
  let dataChannelEventCb: ((event: unknown) => void) | undefined;
  let dataChannelStateCb: ((state: RTCDataChannelState) => void) | undefined;

  pc.ontrack = (event) => {
    const firstStream = event.streams[0];
    if (remoteTrackCb !== undefined && firstStream !== undefined) {
      remoteTrackCb(firstStream);
    }
  };

  pc.onconnectionstatechange = () => {
    if (connectionStateCb !== undefined) {
      connectionStateCb(pc.connectionState);
    }
  };

  const emitDataChannelState = (): void => {
    if (dataChannelStateCb !== undefined) {
      dataChannelStateCb(dataChannel.readyState);
    }
  };
  dataChannel.addEventListener("open", emitDataChannelState);
  dataChannel.addEventListener("closing", emitDataChannelState);
  dataChannel.addEventListener("close", emitDataChannelState);
  dataChannel.addEventListener("error", emitDataChannelState);
  dataChannel.addEventListener("message", (event: MessageEvent) => {
    if (dataChannelEventCb === undefined) {
      return;
    }
    const raw = typeof event.data === "string" ? event.data : String(event.data);
    try {
      dataChannelEventCb(JSON.parse(raw));
    } catch {
      dataChannelEventCb(raw);
    }
  });

  return {
    offerSdp,
    async applyAnswer(sdp: string): Promise<void> {
      await pc.setRemoteDescription({ type: "answer", sdp });
    },
    onRemoteTrack(cb: (stream: MediaStream) => void): void {
      remoteTrackCb = cb;
    },
    onConnectionStateChange(cb: (state: RTCPeerConnectionState) => void): void {
      connectionStateCb = cb;
    },
    onDataChannelEvent(cb: (event: unknown) => void): void {
      dataChannelEventCb = cb;
    },
    onDataChannelStateChange(cb: (state: RTCDataChannelState) => void): void {
      dataChannelStateCb = cb;
    },
    sendDataChannelEvent(event: unknown): boolean {
      if (dataChannel.readyState !== "open") {
        return false;
      }
      dataChannel.send(JSON.stringify(event));
      return true;
    },
    close(): void {
      // Stop all sender tracks so the OS-level "recording" indicator clears immediately.
      stopTracks(stream);
      try {
        dataChannel.close();
      } catch {
        // Ignore — already closed.
      }
      pc.close();
    },
  };
}

// Production transport backed by native browser APIs. Constructed lazily by `useRealtimeVoice`
// so a no-voice / unsupported environment never touches the media APIs.
export function createBrowserVoiceRtcTransport(): VoiceRtcTransport {
  return {
    async connect(): Promise<VoiceRtcSession> {
      if (!realtimeVoiceTransportSupported()) {
        throw new VoiceRtcError("unsupported", "This browser does not support real-time voice.");
      }

      let stream: MediaStream;
      try {
        stream = await acquireMicrophone();
      } catch (error) {
        throw new VoiceRtcError(
          classifyGetUserMediaError(error),
          "Microphone access is unavailable.",
        );
      }

      let pc: RTCPeerConnection;
      let dataChannel: RTCDataChannel;
      try {
        pc = new RTCPeerConnection();
        for (const track of stream.getTracks()) {
          pc.addTrack(track, stream);
        }
        // OpenAI-compatible Realtime sideband channel. Provider lifecycle and transcript events arrive
        // here; raw audio remains exclusively on the WebRTC media tracks.
        dataChannel = pc.createDataChannel("oai-events");
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc);
        return buildSession(pc, stream, dataChannel);
      } catch (error) {
        stopTracks(stream);
        if (error instanceof VoiceRtcError) {
          throw error;
        }
        throw new VoiceRtcError(
          "connection-failed",
          error instanceof Error ? error.message : "WebRTC connection could not start.",
        );
      }
    },
  };
}
