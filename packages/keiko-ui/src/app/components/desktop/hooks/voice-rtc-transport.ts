// Issue #497, Epic #491 — the injectable native-WebRTC seam for the realtime Voice Digital Twin.
//
// Isolates the only code that touches browser media hardware (getUserMedia, RTCPeerConnection) behind
// a small, injectable interface so the realtime state machine (useRealtimeVoice) and its tests never
// depend on real hardware. Native browser APIs only — no third-party package is added (supply-chain
// invariant). The seam uses proxied-SDP negotiation: the browser creates an offer, waits for ICE
// gathering to complete (non-trickle), then sends the complete SDP to the BFF. The BFF returns an
// answer which the browser applies via setRemoteDescription.

import {
  createBrowserVoiceActivityDetector,
  type VoiceActivityEvent,
  type VoiceActivityMonitor,
} from "./voice-activity-detector";

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
  setInputMuted?(muted: boolean): void;
  onConnectionStateChange(cb: (state: RTCPeerConnectionState) => void): void;
  onLocalVoiceActivity?(cb: (event: VoiceActivityEvent) => void): void;
  onDataChannelEvent?(cb: (event: unknown) => void): void;
  onDataChannelStateChange?(cb: (state: RTCDataChannelState) => void): void;
  sendDataChannelEvent?(event: unknown): boolean;
  close(): void;
}

// The capture seam. `connect()` acquires the microphone, builds a peer connection, creates a local
// SDP offer (waiting for ICE gathering to complete), and resolves with the session. Rejects with a
// `VoiceRtcError` on denial / missing device / unsupported browser.
export interface VoiceRtcTransport {
  connect(options?: { readonly signal?: AbortSignal | undefined }): Promise<VoiceRtcSession>;
}

// True when the running browser exposes the required real-time media APIs.
export function realtimeVoiceTransportSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.mediaDevices !== undefined &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof RTCPeerConnection !== "undefined" &&
    typeof RTCPeerConnection.prototype.addTransceiver === "function"
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

// Realtime microphone constraints. Canonical TTS may play locally while capture is active, so echo
// cancellation prevents that playback and room noise from creating false speech onsets. Mono is
// sufficient for speech and halves the uplink. Bare `{ audio: true }` negotiates none of these.
const REALTIME_INPUT_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

// Acquire the microphone with the realtime input constraints, falling back to the unconstrained mic only
// when a device/driver cannot satisfy them (OverconstrainedError) — so a constrained-but-capable
// device gets echo cancellation while an inflexible one still connects rather than failing the session.
function abortError(): DOMException {
  return new DOMException("Realtime voice startup was cancelled.", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw abortError();
  }
}

async function abortableMediaStream(
  input: Promise<MediaStream>,
  signal: AbortSignal | undefined,
): Promise<MediaStream> {
  if (signal === undefined) {
    return input;
  }
  throwIfAborted(signal);
  return new Promise<MediaStream>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    input
      .then((stream) => {
        signal.removeEventListener("abort", onAbort);
        if (settled || signal.aborted) {
          stopTracks(stream);
          reject(abortError());
          return;
        }
        settled = true;
        resolve(stream);
      })
      .catch((error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        reject(error);
      });
  });
}

async function acquireMicrophone(signal?: AbortSignal | undefined): Promise<MediaStream> {
  try {
    return await abortableMediaStream(
      navigator.mediaDevices.getUserMedia({ audio: REALTIME_INPUT_AUDIO_CONSTRAINTS }),
      signal,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "OverconstrainedError") {
      return abortableMediaStream(navigator.mediaDevices.getUserMedia({ audio: true }), signal);
    }
    throw error;
  }
}

// Non-trickle ICE gathering: wait until pc.iceGatheringState is "complete" before resolving with
// the local description. A bounded fallback timeout (~2 s) avoids hanging forever if the browser
// never fires the event (e.g. in a headless test environment with no network interfaces).
const ICE_GATHER_TIMEOUT_MS = 2_000;
const MAX_QUEUED_DATA_CHANNEL_EVENTS = 50;
// Provider data is hostile until parsed. This leaves ample room for the 256 kB transcript contract
// plus JSON escaping while preventing ignored assistant/audio events from becoming a parse-time DoS.
const MAX_INBOUND_DATA_CHANNEL_EVENT_BYTES = 2_000_000;
const INPUT_MUTE_RAMP_SECONDS = 0.035;
const APPROVED_VOICE_RTC_ICE_SERVERS: RTCIceServer[] = [];
const DATA_CHANNEL_EVENT_ENCODER = new TextEncoder();
const INVALID_DATA_CHANNEL_EVENT = Object.freeze({ type: "error" });
Object.freeze(APPROVED_VOICE_RTC_ICE_SERVERS);

// docs/voice/protocol.md §10 is the policy link: the browser must not introduce STUN/TURN or
// browser-direct media egress by configuration drift. SDP negotiation remains proxied through the BFF.
export const APPROVED_VOICE_RTC_CONFIGURATION: RTCConfiguration = Object.freeze({
  iceServers: APPROVED_VOICE_RTC_ICE_SERVERS,
});

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonRecord, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isDisabledAutomaticResponse(value: JsonRecord): boolean {
  return value.create_response === false && value.interrupt_response === false;
}

function isApprovedServerVad(value: JsonRecord): boolean {
  return (
    hasOnlyKeys(value, [
      "type",
      "threshold",
      "prefix_padding_ms",
      "silence_duration_ms",
      "create_response",
      "interrupt_response",
    ]) &&
    value.type === "server_vad" &&
    isFiniteNumber(value.threshold) &&
    value.threshold >= 0 &&
    value.threshold <= 1 &&
    isNonNegativeInteger(value.prefix_padding_ms) &&
    isNonNegativeInteger(value.silence_duration_ms) &&
    isDisabledAutomaticResponse(value)
  );
}

function isApprovedSemanticVad(value: JsonRecord): boolean {
  return (
    hasOnlyKeys(value, ["type", "eagerness", "create_response", "interrupt_response"]) &&
    value.type === "semantic_vad" &&
    (value.eagerness === "low" || value.eagerness === "medium" || value.eagerness === "high") &&
    isDisabledAutomaticResponse(value)
  );
}

function isApprovedTurnDetection(value: unknown): boolean {
  return isRecord(value) && (isApprovedServerVad(value) || isApprovedSemanticVad(value));
}

function isApprovedSessionUpdate(event: JsonRecord): boolean {
  if (!hasOnlyKeys(event, ["type", "session"]) || event.type !== "session.update") {
    return false;
  }
  const session = event.session;
  if (!isRecord(session) || !hasOnlyKeys(session, ["type", "audio"])) {
    return false;
  }
  if (session.type !== "realtime") {
    return false;
  }
  if (session.audio === undefined) {
    return true;
  }
  const audio = session.audio;
  if (!isRecord(audio) || !hasOnlyKeys(audio, ["input"])) {
    return false;
  }
  const input = audio.input;
  return (
    isRecord(input) &&
    hasOnlyKeys(input, ["turn_detection"]) &&
    isApprovedTurnDetection(input.turn_detection)
  );
}

function serializeApprovedDataChannelEvent(event: unknown): string | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  const isCommit = hasOnlyKeys(event, ["type"]) && event.type === "input_audio_buffer.commit";
  if (!isCommit && !isApprovedSessionUpdate(event)) {
    return undefined;
  }
  return JSON.stringify(event);
}

function parseBoundedDataChannelEvent(data: unknown): unknown {
  if (typeof data !== "string" || data.length > MAX_INBOUND_DATA_CHANNEL_EVENT_BYTES) {
    return INVALID_DATA_CHANNEL_EVENT;
  }
  if (DATA_CHANNEL_EVENT_ENCODER.encode(data).byteLength > MAX_INBOUND_DATA_CHANNEL_EVENT_BYTES) {
    return INVALID_DATA_CHANNEL_EVENT;
  }
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return INVALID_DATA_CHANNEL_EVENT;
  }
}

type BrowserAudioContextConstructor = new (contextOptions?: AudioContextOptions) => AudioContext;

interface VoiceInputPipeline {
  readonly senderStream: MediaStream;
  readonly monitorStream: MediaStream;
  setMuted(muted: boolean): void;
  close(): void;
}

function audioTracks(stream: MediaStream): MediaStreamTrack[] {
  return typeof stream.getAudioTracks === "function" ? stream.getAudioTracks() : stream.getTracks();
}

function browserAudioContextConstructor(): BrowserAudioContextConstructor | undefined {
  const scope = globalThis as typeof globalThis & {
    readonly AudioContext?: BrowserAudioContextConstructor | undefined;
    readonly webkitAudioContext?: BrowserAudioContextConstructor | undefined;
  };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

function createFallbackInputPipeline(stream: MediaStream): VoiceInputPipeline {
  return {
    senderStream: stream,
    monitorStream: stream,
    setMuted(muted: boolean): void {
      for (const track of audioTracks(stream)) {
        track.enabled = !muted;
      }
    },
    close(): void {},
  };
}

function createGainInputPipeline(stream: MediaStream): VoiceInputPipeline | undefined {
  const Context = browserAudioContextConstructor();
  if (Context === undefined) {
    return undefined;
  }
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let gain: GainNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  try {
    context = new Context();
    source = context.createMediaStreamSource(stream);
    gain = context.createGain();
    destination = context.createMediaStreamDestination();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(destination);
  } catch {
    try {
      source?.disconnect();
      gain?.disconnect();
    } catch {
      // Best-effort cleanup before falling back to track.enabled muting.
    }
    void context?.close().catch(() => {
      // A failed setup must not retain a partially-created AudioContext.
    });
    return undefined;
  }
  return {
    senderStream: destination.stream,
    monitorStream: destination.stream,
    setMuted(muted: boolean): void {
      const target = muted ? 0 : 1;
      const now = context.currentTime;
      if (context.state === "suspended") {
        void context.resume().catch(() => {
          // Muting should remain best-effort; the sender track stays live either way.
        });
      }
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(target, now + INPUT_MUTE_RAMP_SECONDS);
    },
    close(): void {
      try {
        source.disconnect();
        gain.disconnect();
      } catch {
        // Already disconnected.
      }
      stopTracks(destination.stream);
      void context.close().catch(() => {
        // The original microphone tracks are stopped by the owning session cleanup.
      });
    },
  };
}

function createInputPipeline(stream: MediaStream): VoiceInputPipeline {
  return createGainInputPipeline(stream) ?? createFallbackInputPipeline(stream);
}

function waitForIceGathering(
  pc: RTCPeerConnection,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: DOMException): void => {
      if (fallback !== undefined) clearTimeout(fallback);
      pc.removeEventListener("icegatheringstatechange", onChange);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    // Resolve once, removing the listener so it never outlives ICE completion (and never re-fires on a
    // later gathering transition, e.g. a network-interface change). The fallback timeout removes it too.
    const onChange = (): void => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const onAbort = (): void => {
      finish(abortError());
    };
    fallback = setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", onChange);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

function audioMediaSections(sdp: string): readonly string[] {
  return sdp.split(/(?=^m=)/gmu).filter((section) => section.startsWith("m=audio "));
}

function mediaDirections(section: string): readonly RTCRtpTransceiverDirection[] {
  const matches = section.match(/^a=(sendrecv|sendonly|recvonly|inactive)$/gmu) ?? [];
  return matches.map((match) => match.slice(2) as RTCRtpTransceiverDirection);
}

function requireAudioDirection(
  sdp: string,
  direction: RTCRtpTransceiverDirection,
  description: string,
): void {
  const audio = audioMediaSections(sdp);
  const invalid = audio.some((section) => {
    const directions = mediaDirections(section);
    return directions.length !== 1 || directions[0] !== direction;
  });
  if (audio.length === 0 || invalid) {
    throw new VoiceRtcError(
      "negotiation-failed",
      `${description} does not enforce media-input-only audio.`,
    );
  }
}

function addSendOnlyAudioTracks(pc: RTCPeerConnection, senderStream: MediaStream): void {
  if (typeof pc.addTransceiver !== "function") {
    throw new VoiceRtcError(
      "unsupported",
      "This browser cannot enforce media-input-only real-time voice.",
    );
  }
  for (const track of senderStream.getTracks()) {
    const transceiver = pc.addTransceiver(track, {
      direction: "sendonly",
      streams: [senderStream],
    });
    if (transceiver.direction !== "sendonly") {
      throw new VoiceRtcError(
        "negotiation-failed",
        "The browser did not create a send-only audio transceiver.",
      );
    }
  }
}

function buildSession(
  pc: RTCPeerConnection,
  stream: MediaStream,
  inputPipeline: VoiceInputPipeline,
  dataChannel: RTCDataChannel,
): VoiceRtcSession {
  const localDescription = pc.localDescription;
  if (localDescription === null) {
    throw new VoiceRtcError("connection-failed", "Local SDP description is unavailable.");
  }
  const offerSdp = localDescription.sdp;

  let connectionStateCb: ((state: RTCPeerConnectionState) => void) | undefined;
  let localVoiceActivityMonitor: VoiceActivityMonitor | undefined;
  let dataChannelEventCb: ((event: unknown) => void) | undefined;
  let dataChannelStateCb: ((state: RTCDataChannelState) => void) | undefined;
  const queuedDataChannelEvents: string[] = [];

  pc.onconnectionstatechange = () => {
    if (connectionStateCb !== undefined) {
      connectionStateCb(pc.connectionState);
    }
  };

  const flushQueuedDataChannelEvents = (): void => {
    if (dataChannel.readyState !== "open") {
      return;
    }
    while (queuedDataChannelEvents.length > 0) {
      const queued = queuedDataChannelEvents.shift();
      if (queued !== undefined) {
        dataChannel.send(queued);
      }
    }
  };

  const emitDataChannelState = (): void => {
    if (dataChannel.readyState === "open") {
      flushQueuedDataChannelEvents();
    }
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
    dataChannelEventCb(parseBoundedDataChannelEvent(event.data));
  });

  return {
    offerSdp,
    async applyAnswer(sdp: string): Promise<void> {
      // A send-only offer permits the provider to receive microphone audio, never to send an
      // assistant media track back. Reject a permissive or directionless answer before the browser
      // can apply it, even if a provider attempts to widen the negotiated media channel.
      requireAudioDirection(sdp, "recvonly", "Remote SDP answer");
      await pc.setRemoteDescription({ type: "answer", sdp });
    },
    setInputMuted(muted: boolean): void {
      inputPipeline.setMuted(muted);
    },
    onConnectionStateChange(cb: (state: RTCPeerConnectionState) => void): void {
      connectionStateCb = cb;
    },
    onLocalVoiceActivity(cb: (event: VoiceActivityEvent) => void): void {
      localVoiceActivityMonitor?.stop();
      localVoiceActivityMonitor = createBrowserVoiceActivityDetector().start(
        inputPipeline.monitorStream,
        cb,
      );
    },
    onDataChannelEvent(cb: (event: unknown) => void): void {
      dataChannelEventCb = cb;
    },
    onDataChannelStateChange(cb: (state: RTCDataChannelState) => void): void {
      dataChannelStateCb = cb;
      cb(dataChannel.readyState);
    },
    sendDataChannelEvent(event: unknown): boolean {
      const serialized = serializeApprovedDataChannelEvent(event);
      if (serialized === undefined) {
        return false;
      }
      if (dataChannel.readyState === "open") {
        dataChannel.send(serialized);
        return true;
      }
      if (dataChannel.readyState === "connecting") {
        if (queuedDataChannelEvents.length >= MAX_QUEUED_DATA_CHANNEL_EVENTS) {
          return false;
        }
        queuedDataChannelEvents.push(serialized);
        return true;
      }
      return false;
    },
    close(): void {
      // Stop all sender tracks so the OS-level "recording" indicator clears immediately.
      localVoiceActivityMonitor?.stop();
      localVoiceActivityMonitor = undefined;
      inputPipeline.close();
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
    async connect(options?: {
      readonly signal?: AbortSignal | undefined;
    }): Promise<VoiceRtcSession> {
      const signal = options?.signal;
      if (!realtimeVoiceTransportSupported()) {
        throw new VoiceRtcError("unsupported", "This browser does not support real-time voice.");
      }

      let stream: MediaStream;
      try {
        stream = await acquireMicrophone(signal);
      } catch (error) {
        throw new VoiceRtcError(
          classifyGetUserMediaError(error),
          "Microphone access is unavailable.",
        );
      }

      let pc: RTCPeerConnection | undefined;
      let dataChannel: RTCDataChannel | undefined;
      let inputPipeline: VoiceInputPipeline | undefined;
      try {
        throwIfAborted(signal);
        inputPipeline = createInputPipeline(stream);
        pc = new RTCPeerConnection(APPROVED_VOICE_RTC_CONFIGURATION);
        addSendOnlyAudioTracks(pc, inputPipeline.senderStream);
        // OpenAI-compatible Realtime sideband channel. Provider lifecycle and transcript events arrive
        // here; raw audio remains exclusively on the WebRTC media tracks.
        dataChannel = pc.createDataChannel("oai-events");
        const offer = await pc.createOffer();
        throwIfAborted(signal);
        await pc.setLocalDescription(offer);
        throwIfAborted(signal);
        await waitForIceGathering(pc, signal);
        throwIfAborted(signal);
        requireAudioDirection(pc.localDescription?.sdp ?? "", "sendonly", "Local SDP offer");
        return buildSession(pc, stream, inputPipeline, dataChannel);
      } catch (error) {
        inputPipeline?.close();
        stopTracks(stream);
        try {
          dataChannel?.close();
        } catch {
          // Best-effort teardown of a partially-created data channel.
        }
        pc?.close();
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
