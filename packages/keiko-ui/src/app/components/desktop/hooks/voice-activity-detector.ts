// Issue #1556 — voice-activity detection (VAD) for the colleague-like dialogue turn loop. It turns the
// turn-based STT path hands-free: while the user is recording, a trailing silence after detected speech
// ends the turn automatically, so the user no longer has to tap the mic a second time to stop.
//
// The browser detector is an injectable seam (like the dictation recorder and the realtime audio sink):
// production wires a WebAudio AnalyserNode and samples short-term RMS energy; tests inject a fake that
// fires scripted events. The DECISION logic lives in the pure, fully unit-tested `VoiceActivityState`
// (no WebAudio, no clock), so the only untested part is the thin AnalyserNode glue.
//
// It analyses the existing dictation microphone stream and never opens its own — capture ownership and
// teardown stay with the dictation recorder. No audio leaves the browser and nothing is persisted.

export type VoiceActivityEvent = "speech-onset" | "end-of-turn";

export interface VoiceActivityThresholds {
  // Normalised RMS (0..1) at or above which a sample counts as speech.
  readonly rmsThreshold: number;
  // Sustained above-threshold duration before `speech-onset` fires (debounces transient noise).
  readonly onsetMs: number;
  // Trailing below-threshold duration after speech before `end-of-turn` fires.
  readonly trailingSilenceMs: number;
}

// Conservative defaults tuned for headset / laptop dictation: ~0.014 RMS gate, a short onset debounce,
// and an ~800ms end-of-turn pause (natural between-sentence gaps stay within the turn).
export const DEFAULT_VAD_THRESHOLDS: VoiceActivityThresholds = {
  rmsThreshold: 0.014,
  onsetMs: 150,
  trailingSilenceMs: 800,
};

// A live VAD monitor over one stream. `stop()` releases the analysis resources only — the caller still
// owns (and stops) the underlying MediaStream tracks.
export interface VoiceActivityMonitor {
  stop(): void;
}

export interface VoiceActivityDetector {
  // Begin monitoring `stream`, invoking `onEvent` for each detected transition. Returns a monitor whose
  // `stop()` releases the WebAudio resources. Must never throw to the caller (a VAD failure simply leaves
  // the manual mic tap as the way to end a turn).
  start(stream: MediaStream, onEvent: (event: VoiceActivityEvent) => void): VoiceActivityMonitor;
}

// Pure VAD state machine over a stream of RMS samples. `feed` returns the event (if any) this sample
// triggers. `end-of-turn` fires only AFTER speech was detected (so initial silence never ends a turn).
// No clock and no allocation per sample — directly unit-testable.
export class VoiceActivityState {
  private heardSpeech = false;
  private aboveMs = 0;
  private belowMs = 0;

  constructor(private readonly thresholds: VoiceActivityThresholds) {}

  feed(rms: number, dtMs: number): VoiceActivityEvent | undefined {
    if (rms >= this.thresholds.rmsThreshold) {
      this.aboveMs += dtMs;
      this.belowMs = 0;
      if (!this.heardSpeech && this.aboveMs >= this.thresholds.onsetMs) {
        this.heardSpeech = true;
        return "speech-onset";
      }
      return undefined;
    }
    this.aboveMs = 0;
    if (!this.heardSpeech) {
      return undefined;
    }
    this.belowMs += dtMs;
    if (this.belowMs >= this.thresholds.trailingSilenceMs) {
      // One end-of-turn per speech episode; reset so a later utterance can be detected afresh.
      this.heardSpeech = false;
      this.belowMs = 0;
      return "end-of-turn";
    }
    return undefined;
  }
}

// How often the browser detector samples the analyser. Doubles as the `dt` fed to the state machine, so
// no wall-clock read is needed (keeps the detector deterministic and dependency-free).
const SAMPLE_INTERVAL_MS = 50;
const ANALYSER_FFT_SIZE = 1024;

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sum += samples[i]! * samples[i]!;
  }
  return Math.sqrt(sum / samples.length);
}

// True when the running browser exposes the WebAudio APIs the detector needs.
function voiceActivityDetectionSupported(): boolean {
  return typeof AudioContext !== "undefined";
}

// Production detector backed by a WebAudio AnalyserNode. Constructed lazily by the dictation hook so a
// no-voice / unsupported environment never touches WebAudio.
export function createBrowserVoiceActivityDetector(
  thresholds: VoiceActivityThresholds = DEFAULT_VAD_THRESHOLDS,
): VoiceActivityDetector {
  return {
    start(stream, onEvent): VoiceActivityMonitor {
      if (!voiceActivityDetectionSupported()) {
        return { stop: (): void => {} };
      }
      let context: AudioContext;
      try {
        context = new AudioContext();
      } catch {
        return { stop: (): void => {} };
      }
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = ANALYSER_FFT_SIZE;
      source.connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      const state = new VoiceActivityState(thresholds);

      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buffer);
        const event = state.feed(rms(buffer), SAMPLE_INTERVAL_MS);
        if (event !== undefined) {
          onEvent(event);
        }
      }, SAMPLE_INTERVAL_MS);

      return {
        stop(): void {
          clearInterval(timer);
          try {
            source.disconnect();
          } catch {
            // ignore — already disconnected
          }
          void context.close().catch(() => {
            // ignore — already closed
          });
        },
      };
    },
  };
}
