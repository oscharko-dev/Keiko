// Issue #495, Epic #491 — the browser microphone capture seam for controlled composer dictation.
//
// This module isolates the only part of the dictation flow that touches browser media hardware
// (`navigator.mediaDevices.getUserMedia` + `MediaRecorder`) behind a small, injectable interface so
// the dictation state machine (`useDictation`) and its tests never depend on real hardware. Capture
// uses native browser APIs only — no third-party recorder package is added (Issue #495 engineering
// note / epic supply-chain invariant). Audio is held only in memory for the duration of one clip and
// is handed to the caller as base64; nothing is written to disk or logged here.

// A finished capture: base64 audio (no `data:` prefix), the chosen container MIME type, and the
// measured clip length. The shape matches `VoiceTranscriptionRequest` so the caller can post it
// directly to the BFF speech-to-text route.
export interface DictationCapture {
  readonly audioBase64: string;
  readonly mimeType: string;
  readonly durationMs: number;
}

// Why a capture could not start. Each maps to a specific, non-blocking composer message — the
// composer stays fully usable in every case (AC4).
//   - "permission-denied" — the user or deployment policy denied microphone access.
//   - "no-microphone"     — no usable audio input device is present.
//   - "unsupported"       — the browser does not expose getUserMedia / MediaRecorder.
//   - "capture-failed"    — capture started but could not be completed.
export type DictationStartFailure =
  "permission-denied" | "no-microphone" | "unsupported" | "capture-failed";

export class DictationRecorderError extends Error {
  constructor(
    public readonly reason: DictationStartFailure,
    message: string,
  ) {
    super(message);
    this.name = "DictationRecorderError";
  }
}

// An active recording. `stop` resolves with the captured clip; `cancel` discards it. Both release the
// microphone track so the OS-level "recording" indicator clears immediately (AC3 "stops visibly").
export interface DictationSession {
  // The live capture stream. Exposed so a dialogue-mode voice-activity detector can analyse the same
  // microphone (it never opens its own) to end the turn on trailing silence. The session still owns
  // teardown — stop()/cancel() release the tracks. Optional only so existing test fakes need not provide
  // it; the production recorder always sets it.
  readonly stream?: MediaStream;
  requestData?(): void;
  stop(): Promise<DictationCapture>;
  cancel(): void;
}

export interface DictationRecorderStartOptions {
  // Request incremental `dataavailable` chunks while recording so the final stop path is not the
  // first time the browser is asked to flush encoded audio.
  readonly timesliceMs?: number | undefined;
  // Fires exactly once, when the MediaRecorder has emitted its `start` event AND the analyser has
  // produced its first level sample — i.e. the capture pipeline is verified live and actually measuring
  // audio. The caller flips its UI from "Preparing mic" to a "ready / speak now" state on this, so the
  // user is only invited to speak once capture is genuinely flowing (addresses swallowed first words).
  readonly onReady?: (() => void) | undefined;
  // Normalized local microphone level in [0,1], derived from short-term RMS. Content-free: never
  // contains raw samples and never leaves the browser unless the caller chooses to render it.
  readonly onAudioLevel?: ((level: number) => void) | undefined;
  // Optional test/telemetry hook for encoded chunk arrival. The hook must not persist the blob.
  readonly onChunk?: ((chunk: Blob) => void) | undefined;
}

// The capture seam. `start` requests microphone permission and begins capture, rejecting with a
// `DictationRecorderError` on denial / missing device / unsupported browser. Capture begins only once
// the returned promise resolves, so the caller can tie the "recording" UI state to an explicit user
// gesture (AC3 — capture never starts in the background).
export interface DictationRecorder {
  start(options?: DictationRecorderStartOptions): Promise<DictationSession>;
}

// MIME container preference order. The browser picks the first it can actually produce; all entries
// are on the BFF's accepted allowlist (voice-handlers.ts ALLOWED_AUDIO_MIME).
const PREFERRED_MIME_TYPES: readonly string[] = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

const DEFAULT_TIMESLICE_MS = 250;
const LEVEL_SAMPLE_INTERVAL_MS = 80;
const LEVEL_ANALYSER_FFT_SIZE = 1024;
const LEVEL_NORMALIZATION_RMS = 0.08;

// True when the running browser can capture dictation audio. The composer gates the microphone
// affordance on this in addition to the server-side capability so it never renders a control the
// browser cannot fulfil (Issue #495 "unsupported by browser permission").
export function dictationCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.mediaDevices !== undefined &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

function selectMimeType(): string {
  for (const candidate of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  // Empty string lets MediaRecorder fall back to its platform default; the produced Blob still
  // carries a concrete type which the caller forwards.
  return "";
}

function classifyGetUserMediaError(error: unknown): DictationStartFailure {
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
  return "capture-failed";
}

// Reads a captured Blob as base64 without a `data:` prefix. Used only in the real browser (the tests
// inject a fake recorder), so the native FileReader path is the simplest reliable encoder.
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new DictationRecorderError("capture-failed", "The captured audio could not be read."));
    };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(
          new DictationRecorderError("capture-failed", "The captured audio could not be read."),
        );
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

// Full-duplex dictation capture constraints. In dialogue mode the assistant's reply plays through the
// speakers while the next turn may be captured, so echo cancellation / noise suppression keep the
// assistant's own audio and room noise out of both the transcript and the voice-activity detector. Mono
// is sufficient for speech. Falls back to the unconstrained mic when a device cannot satisfy them.
const DICTATION_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

async function acquireDictationMicrophone(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: DICTATION_AUDIO_CONSTRAINTS });
  } catch (error) {
    if (error instanceof Error && error.name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    throw error;
  }
}

function waitForStop(recorder: MediaRecorder): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
    recorder.addEventListener(
      "error",
      () => reject(new DictationRecorderError("capture-failed", "Audio capture failed.")),
      { once: true },
    );
  });
}

function waitForStart(recorder: MediaRecorder): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    recorder.addEventListener("start", () => resolve(), { once: true });
    recorder.addEventListener(
      "error",
      () => reject(new DictationRecorderError("capture-failed", "Audio capture failed.")),
      { once: true },
    );
  });
}

interface AudioLevelMonitor {
  stop(): void;
}

function sampleRms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sum += samples[i]! * samples[i]!;
  }
  return Math.sqrt(sum / samples.length);
}

// Builds a short-term RMS level monitor over the capture stream. Returns undefined when the browser
// exposes no AudioContext or analyser setup fails, so the caller can still signal readiness without a
// measured level rather than waiting forever. `onSample` receives a normalized [0,1] level on each tick.
function createAudioLevelMonitor(
  stream: MediaStream,
  onSample: (level: number) => void,
): AudioLevelMonitor | undefined {
  if (typeof AudioContext === "undefined") {
    return undefined;
  }
  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch {
    return undefined;
  }
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = LEVEL_ANALYSER_FFT_SIZE;
    source.connect(analyser);
  } catch {
    void context.close().catch(() => {
      // Level feedback is optional; setup failures must not fail microphone capture.
    });
    return undefined;
  }
  const buffer = new Float32Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buffer);
    const normalized = Math.min(1, sampleRms(buffer) / LEVEL_NORMALIZATION_RMS);
    onSample(Number.isFinite(normalized) ? normalized : 0);
  }, LEVEL_SAMPLE_INTERVAL_MS);
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
}

async function beginSession(
  stream: MediaStream,
  options: DictationRecorderStartOptions = {},
): Promise<DictationSession> {
  const mimeType = selectMimeType();
  const recorder =
    mimeType === "" ? new MediaRecorder(stream) : new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
      options.onChunk?.(event.data);
    }
  });
  const started = waitForStart(recorder);
  recorder.start(options.timesliceMs ?? DEFAULT_TIMESLICE_MS);
  await started;
  const startedAt = Date.now();
  // Ready = start event seen (above) AND the analyser has produced its first sample (below), so the
  // caller only invites the user to speak once capture is verifiably live. Fired at most once.
  let readyFired = false;
  const emitReadyOnce = (): void => {
    if (readyFired) return;
    readyFired = true;
    options.onReady?.();
  };
  const wantsMonitor = options.onAudioLevel !== undefined || options.onReady !== undefined;
  const levelMonitor = wantsMonitor
    ? createAudioLevelMonitor(stream, (level) => {
        emitReadyOnce();
        options.onAudioLevel?.(level);
      })
    : undefined;
  // No analyser available (headless / no AudioContext): capture is still live after the start event, so
  // signal readiness immediately instead of leaving the UI stuck in "Preparing mic".
  if (levelMonitor === undefined) {
    emitReadyOnce();
  }

  let settled = false;

  return {
    stream,
    requestData(): void {
      if (settled || recorder.state !== "recording") {
        return;
      }
      try {
        recorder.requestData();
      } catch {
        // A best-effort flush failure should not prevent the final stop from collecting audio.
      }
    },
    async stop(): Promise<DictationCapture> {
      if (settled) {
        throw new DictationRecorderError("capture-failed", "The recording is no longer active.");
      }
      settled = true;
      const stopped = waitForStop(recorder);
      try {
        if (recorder.state === "recording") {
          recorder.requestData();
        }
      } catch {
        // Ignore; the final stop event still provides the authoritative flush.
      }
      recorder.stop();
      try {
        await stopped;
      } finally {
        levelMonitor?.stop();
        stopTracks(stream);
      }
      const effectiveType = recorder.mimeType !== "" ? recorder.mimeType : mimeType || "audio/webm";
      const blob = new Blob(chunks, { type: effectiveType });
      const audioBase64 = await blobToBase64(blob);
      return {
        audioBase64,
        mimeType: effectiveType,
        durationMs: Math.max(1, Date.now() - startedAt),
      };
    },
    cancel(): void {
      if (settled) {
        return;
      }
      settled = true;
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
      levelMonitor?.stop();
      stopTracks(stream);
    },
  };
}

// Production recorder backed by native browser APIs. Constructed lazily by `useDictation` so a
// no-voice / unsupported environment never touches the media APIs.
export function createBrowserDictationRecorder(): DictationRecorder {
  return {
    async start(options?: DictationRecorderStartOptions): Promise<DictationSession> {
      if (!dictationCaptureSupported()) {
        throw new DictationRecorderError(
          "unsupported",
          "This browser does not support microphone capture.",
        );
      }
      let stream: MediaStream;
      try {
        stream = await acquireDictationMicrophone();
      } catch (error) {
        throw new DictationRecorderError(
          classifyGetUserMediaError(error),
          "Microphone access is unavailable.",
        );
      }
      try {
        return await beginSession(stream, options);
      } catch (error) {
        // MediaRecorder construction / start failed after permission was granted — release the track.
        stopTracks(stream);
        throw new DictationRecorderError(
          "capture-failed",
          error instanceof Error ? error.message : "Audio capture could not start.",
        );
      }
    },
  };
}
