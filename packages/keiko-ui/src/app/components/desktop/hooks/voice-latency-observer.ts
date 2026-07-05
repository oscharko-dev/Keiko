// Voice latency instrumentation (Plan §1 "instrument first") — a content-free timing layer for the
// dictate and realtime voice paths.
//
// This layer records WHEN well-known lifecycle marks happen (mic click, permission grant, first audio
// level, RTC connected, first assistant audio, interrupt ack, …) so the perceived latency of both voice
// paths can be measured and regressions caught — WITHOUT ever touching content. It is load-bearing for
// the privacy contract: no transcript, no SDP/ICE string, no audio frame, and no free text ever enters
// here. Only the mark enum literal and a monotonic millisecond timestamp are recorded, and only enum
// literals + millisecond deltas leave (to an optional sink). The clock is injectable so the layer is
// fully deterministic under test. There is no network egress and no logging in this module — a caller
// that wants to forward the derived legs supplies a sink and owns that decision.

// The content-free marks across both voice paths. Named exactly per the plan's event vocabulary.
export type VoiceLatencyMark =
  // ─── Dictate capture path ───
  | "mic_click" // user pressed the mic affordance
  | "permission_granted" // getUserMedia resolved
  | "media_recorder_start" // MediaRecorder emitted its 'start' event
  | "first_audio_level" // analyser produced its first level sample (capture verified live)
  | "first_chunk" // first encoded dataavailable chunk
  | "stop_pressed" // user (or auto/VAD) requested stop
  | "postroll_done" // post-roll window elapsed, capture flushed
  | "upload_start" // transcription request dispatched
  | "upload_end" // transcription response received
  | "stt_first_delta" // first streamed transcript delta (if streaming)
  | "live_transcription_delta" // first live realtime dictation transcript delta
  | "live_transcription_final" // final live realtime dictation transcript available
  | "stt_final" // final transcript available for review
  // ─── Realtime path ───
  | "rtc_offer_created" // local SDP offer built (ICE gathered)
  | "ice_complete" // ICE gathering completed
  | "ws_open" // control-plane transport open
  | "sdp_answer" // provider SDP answer applied
  | "rtc_connected" // RTCPeerConnection reached 'connected'
  | "datachannel_open" // provider sideband data channel open
  | "session_updated" // provider acknowledged session.update
  | "session_ready" // hook dispatched 'connected' (session usable)
  | "user_speech_start" // provider/local VAD detected user speech onset
  | "vad_stop" // end-of-turn detected
  | "first_assistant_audio" // first assistant audio output of a turn
  | "interrupt_sent" // barge-in cancel dispatched
  | "interrupt_ack"; // provider acknowledged the cancel

export interface VoiceLatencySample {
  readonly mark: VoiceLatencyMark;
  // Milliseconds since the observer's first mark (monotonic, non-negative, integer). Content-free.
  readonly atMs: number;
}

// A derived latency leg between two marks. Content-free — the whole point of the layer.
export interface VoiceLatencyLeg {
  readonly from: VoiceLatencyMark;
  readonly to: VoiceLatencyMark;
  readonly ms: number;
}

// Where derived timings go. Both callbacks receive only enum literals and millisecond integers. A sink
// is optional; without one the observer still records marks for in-process inspection (snapshot/legMs).
export interface VoiceLatencyObserverSink {
  onMark?(sample: VoiceLatencySample): void;
  onLeg?(leg: VoiceLatencyLeg): void;
}

export interface VoiceLatencyObserverOptions {
  // Injectable monotonic clock (ms). Defaults to performance.now() (falling back to Date.now()).
  readonly now?: (() => number) | undefined;
  readonly sink?: VoiceLatencyObserverSink | undefined;
  // Leg definitions auto-emitted when their `to` mark lands and `from` is already recorded. Defaults to
  // DEFAULT_VOICE_LATENCY_LEGS (the perceptually meaningful legs of both paths).
  readonly legs?: readonly (readonly [VoiceLatencyMark, VoiceLatencyMark])[] | undefined;
}

export interface VoiceLatencyObserver {
  // Record a mark at the current clock time. Safe to call unconditionally; content-free by construction.
  mark(mark: VoiceLatencyMark): void;
  // The measured leg between two recorded marks (last occurrences), or undefined if either is missing.
  legMs(from: VoiceLatencyMark, to: VoiceLatencyMark): number | undefined;
  // All recorded marks in order (for tests / in-process diagnostics). A fresh array each call.
  snapshot(): readonly VoiceLatencySample[];
  // Clear all recorded marks and the timing origin (e.g. at the start of a new dictate cycle / session).
  reset(): void;
}

// The perceptually meaningful legs, auto-emitted to the sink as soon as both endpoints are known.
export const DEFAULT_VOICE_LATENCY_LEGS: readonly (readonly [
  VoiceLatencyMark,
  VoiceLatencyMark,
])[] = [
  // Dictate: how long until the mic is verifiably capturing (the "swallowed first words" window).
  ["mic_click", "first_audio_level"],
  // Dictate: stop → reviewable transcript (the visible round trip).
  ["stop_pressed", "stt_final"],
  ["stop_pressed", "live_transcription_final"],
  ["mic_click", "live_transcription_delta"],
  ["upload_start", "upload_end"],
  // Realtime: click → usable session, and the SDP negotiation sub-leg.
  ["mic_click", "session_ready"],
  ["rtc_offer_created", "sdp_answer"],
  ["rtc_connected", "session_ready"],
  // Realtime: end-of-turn → first assistant audio (TTFA), and barge-in latency.
  ["vad_stop", "first_assistant_audio"],
  ["interrupt_sent", "interrupt_ack"],
];

function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

// A no-op observer for code paths that do not want instrumentation (keeps call sites unconditional
// without allocating a recorder). Every method is inert.
export const NOOP_VOICE_LATENCY_OBSERVER: VoiceLatencyObserver = {
  mark(): void {},
  legMs(): number | undefined {
    return undefined;
  },
  snapshot(): readonly VoiceLatencySample[] {
    return [];
  },
  reset(): void {},
};

export function createVoiceLatencyObserver(
  options: VoiceLatencyObserverOptions = {},
): VoiceLatencyObserver {
  const now = options.now ?? defaultNow;
  const sink = options.sink;
  const legs = options.legs ?? DEFAULT_VOICE_LATENCY_LEGS;
  let origin: number | undefined;
  // Last occurrence per mark drives leg computation; the ordered sample list is for diagnostics.
  const lastAt = new Map<VoiceLatencyMark, number>();
  const samples: VoiceLatencySample[] = [];

  function mark(m: VoiceLatencyMark): void {
    const t = now();
    if (origin === undefined) {
      origin = t;
    }
    const atMs = Math.max(0, Math.round(t - origin));
    lastAt.set(m, atMs);
    samples.push({ mark: m, atMs });
    sink?.onMark?.({ mark: m, atMs });
    for (const [from, to] of legs) {
      if (to !== m) {
        continue;
      }
      const fromMs = lastAt.get(from);
      // Only emit a non-negative leg whose `from` genuinely preceded this `to` (guards a stale `from`
      // from a previous cycle producing a spurious or negative interval).
      if (fromMs !== undefined && fromMs <= atMs) {
        sink?.onLeg?.({ from, to, ms: atMs - fromMs });
      }
    }
  }

  function legMs(from: VoiceLatencyMark, to: VoiceLatencyMark): number | undefined {
    const a = lastAt.get(from);
    const b = lastAt.get(to);
    if (a === undefined || b === undefined || b < a) {
      return undefined;
    }
    return b - a;
  }

  function snapshot(): readonly VoiceLatencySample[] {
    return samples.slice();
  }

  function reset(): void {
    origin = undefined;
    lastAt.clear();
    samples.length = 0;
  }

  return { mark, legMs, snapshot, reset };
}
