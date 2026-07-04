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
  // When enabled, raise the effective speech gate above the learned stationary noise floor. The fixed
  // rmsThreshold remains a lower bound, so callers can still pin deterministic behavior in tests.
  readonly adaptiveNoiseFloor?: boolean | undefined;
  readonly noiseFloorMultiplier?: number | undefined;
  readonly noiseFloorMinRms?: number | undefined;
  readonly noiseFloorMaxRms?: number | undefined;
}

// Conservative defaults tuned for headset / laptop dictation: ~0.014 RMS gate, a short onset debounce,
// and an ~800ms end-of-turn pause (natural between-sentence gaps stay within the turn).
export const DEFAULT_VAD_THRESHOLDS: VoiceActivityThresholds = {
  rmsThreshold: 0.014,
  onsetMs: 150,
  trailingSilenceMs: 800,
  adaptiveNoiseFloor: true,
  noiseFloorMultiplier: 1.8,
  noiseFloorMinRms: 0.004,
  noiseFloorMaxRms: 0.05,
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
  private noiseFloor: number;

  constructor(private readonly thresholds: VoiceActivityThresholds) {
    this.noiseFloor = Math.max(thresholds.noiseFloorMinRms ?? 0, thresholds.rmsThreshold * 0.75);
  }

  private effectiveThreshold(): number {
    if (this.thresholds.adaptiveNoiseFloor !== true) {
      return this.thresholds.rmsThreshold;
    }
    const multiplier = this.thresholds.noiseFloorMultiplier ?? 1.8;
    return Math.max(this.thresholds.rmsThreshold, this.noiseFloor * multiplier);
  }

  private observeNoise(rms: number): void {
    if (this.thresholds.adaptiveNoiseFloor !== true || !Number.isFinite(rms)) {
      return;
    }
    const min = this.thresholds.noiseFloorMinRms ?? 0;
    const max = this.thresholds.noiseFloorMaxRms ?? Math.max(this.thresholds.rmsThreshold, min);
    const bounded = Math.min(max, Math.max(min, rms));
    this.noiseFloor = this.noiseFloor * 0.92 + bounded * 0.08;
  }

  feed(rms: number, dtMs: number): VoiceActivityEvent | undefined {
    const speechThreshold = this.effectiveThreshold();
    if (rms >= speechThreshold) {
      this.aboveMs += dtMs;
      this.belowMs = 0;
      if (!this.heardSpeech && this.aboveMs >= this.thresholds.onsetMs) {
        this.heardSpeech = true;
        return "speech-onset";
      }
      return undefined;
    }
    this.observeNoise(rms);
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
      let source: MediaStreamAudioSourceNode;
      let analyser: AnalyserNode;
      try {
        source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = ANALYSER_FFT_SIZE;
        source.connect(analyser);
      } catch {
        void context.close().catch(() => {
          // A detector setup failure must not fail the realtime session.
        });
        return { stop: (): void => {} };
      }
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
