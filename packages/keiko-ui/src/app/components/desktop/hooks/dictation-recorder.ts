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
  | "permission-denied"
  | "no-microphone"
  | "unsupported"
  | "capture-failed";

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
  stop(): Promise<DictationCapture>;
  cancel(): void;
}

// The capture seam. `start` requests microphone permission and begins capture, rejecting with a
// `DictationRecorderError` on denial / missing device / unsupported browser. Capture begins only once
// the returned promise resolves, so the caller can tie the "recording" UI state to an explicit user
// gesture (AC3 — capture never starts in the background).
export interface DictationRecorder {
  start(): Promise<DictationSession>;
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

function beginSession(stream: MediaStream): DictationSession {
  const mimeType = selectMimeType();
  const recorder =
    mimeType === "" ? new MediaRecorder(stream) : new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });
  const startedAt = Date.now();
  recorder.start();

  let settled = false;

  return {
    async stop(): Promise<DictationCapture> {
      if (settled) {
        throw new DictationRecorderError("capture-failed", "The recording is no longer active.");
      }
      settled = true;
      const stopped = waitForStop(recorder);
      recorder.stop();
      try {
        await stopped;
      } finally {
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
      stopTracks(stream);
    },
  };
}

// Production recorder backed by native browser APIs. Constructed lazily by `useDictation` so a
// no-voice / unsupported environment never touches the media APIs.
export function createBrowserDictationRecorder(): DictationRecorder {
  return {
    async start(): Promise<DictationSession> {
      if (!dictationCaptureSupported()) {
        throw new DictationRecorderError(
          "unsupported",
          "This browser does not support microphone capture.",
        );
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        throw new DictationRecorderError(
          classifyGetUserMediaError(error),
          "Microphone access is unavailable.",
        );
      }
      try {
        return beginSession(stream);
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
