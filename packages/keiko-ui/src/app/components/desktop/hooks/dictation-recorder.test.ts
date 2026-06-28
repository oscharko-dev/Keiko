// Issue #495 — the browser microphone capture adapter. Exercises createBrowserDictationRecorder with
// stubbed getUserMedia + MediaRecorder globals (jsdom implements Blob + FileReader), covering the
// support probe, a full capture → base64 cycle, track teardown, MIME negotiation, cancel, and the
// permission-denied / no-microphone / unsupported / generic error classification.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserDictationRecorder,
  DictationRecorderError,
  dictationCaptureSupported,
} from "./dictation-recorder";

type Listener = (event: unknown) => void;

class FakeMediaRecorder {
  static isTypeSupported = vi.fn((type: string): boolean => type === "audio/webm;codecs=opus");
  public state: "inactive" | "recording" = "inactive";
  public readonly mimeType: string;
  private readonly listeners: Record<string, Listener[]> = {};

  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "";
  }

  addEventListener(type: string, cb: Listener): void {
    (this.listeners[type] ??= []).push(cb);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.emit("dataavailable", {
      data: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
    });
    this.emit("stop", {});
  }

  private emit(type: string, event: unknown): void {
    for (const cb of this.listeners[type] ?? []) {
      cb(event);
    }
  }
}

function stubMedia(
  getUserMedia: () => Promise<MediaStream>,
  track = { stop: vi.fn() },
): typeof track {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(getUserMedia) },
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  return track;
}

function fakeStream(track: { stop: () => void }): MediaStream {
  return { getTracks: () => [track] } as unknown as MediaStream;
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Remove the navigator.mediaDevices stub so support probes in other suites are unaffected.
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "mediaDevices");
});

describe("dictationCaptureSupported", () => {
  it("is true when getUserMedia and MediaRecorder are present", () => {
    stubMedia(async () => fakeStream({ stop: vi.fn() }));
    expect(dictationCaptureSupported()).toBe(true);
  });

  it("is false when MediaRecorder is absent", () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });
    vi.stubGlobal("MediaRecorder", undefined);
    expect(dictationCaptureSupported()).toBe(false);
  });
});

describe("createBrowserDictationRecorder", () => {
  it("captures audio and returns base64 + mime + duration, releasing the track", async () => {
    const track = { stop: vi.fn() };
    stubMedia(async () => fakeStream(track), track);
    const recorder = createBrowserDictationRecorder();
    const session = await recorder.start();
    const capture = await session.stop();
    expect(capture.audioBase64).toBe("AQID"); // base64 of [1,2,3]
    expect(capture.mimeType).toBe("audio/webm;codecs=opus");
    expect(capture.durationMs).toBeGreaterThan(0);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("negotiates the first supported MIME type", async () => {
    stubMedia(async () => fakeStream({ stop: vi.fn() }));
    const recorder = createBrowserDictationRecorder();
    const session = await recorder.start();
    await session.stop();
    expect(FakeMediaRecorder.isTypeSupported).toHaveBeenCalledWith("audio/webm;codecs=opus");
  });

  it("cancel releases the track without producing a capture", async () => {
    const track = { stop: vi.fn() };
    stubMedia(async () => fakeStream(track), track);
    const recorder = createBrowserDictationRecorder();
    const session = await recorder.start();
    session.cancel();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("classifies a denied permission", async () => {
    const denied = new Error("denied");
    denied.name = "NotAllowedError";
    stubMedia(() => Promise.reject(denied));
    const recorder = createBrowserDictationRecorder();
    await expect(recorder.start()).rejects.toMatchObject({ reason: "permission-denied" });
  });

  it("classifies a missing microphone", async () => {
    const missing = new Error("none");
    missing.name = "NotFoundError";
    stubMedia(() => Promise.reject(missing));
    const recorder = createBrowserDictationRecorder();
    await expect(recorder.start()).rejects.toMatchObject({ reason: "no-microphone" });
  });

  it("classifies an unexpected getUserMedia failure as capture-failed", async () => {
    stubMedia(() => Promise.reject(new Error("boom")));
    const recorder = createBrowserDictationRecorder();
    await expect(recorder.start()).rejects.toMatchObject({ reason: "capture-failed" });
  });

  it("reports unsupported when MediaRecorder is unavailable", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });
    vi.stubGlobal("MediaRecorder", undefined);
    const recorder = createBrowserDictationRecorder();
    await expect(recorder.start()).rejects.toMatchObject({ reason: "unsupported" });
  });

  it("throws a DictationRecorderError instance on failure", async () => {
    stubMedia(() => Promise.reject(new Error("x")));
    const recorder = createBrowserDictationRecorder();
    const error = await recorder.start().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DictationRecorderError);
  });
});
