// Issue #495 — the browser microphone capture adapter. Exercises createBrowserDictationRecorder with
// stubbed getUserMedia + MediaRecorder globals (jsdom implements Blob + FileReader), covering the
// support probe, a full capture → base64 cycle, track teardown, MIME negotiation, cancel, and the
// permission-denied / no-microphone / unsupported / generic error classification.

import { afterEach, describe, expect, it, vi } from "vitest";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import {
  createBrowserDictationRecorder,
  DictationRecorderError,
  dictationCaptureSupported,
} from "./dictation-recorder";

type Listener = (event: unknown) => void;

class FakeMediaRecorder {
  static isTypeSupported = vi.fn((type: string): boolean => type === "audio/webm;codecs=opus");
  static instances: FakeMediaRecorder[] = [];
  public state: "inactive" | "recording" = "inactive";
  public readonly mimeType: string;
  public startTimeslice: number | undefined;
  public requestDataCalls = 0;
  private readonly listeners: Record<string, Listener[]> = {};

  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "";
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(type: string, cb: Listener): void {
    (this.listeners[type] ??= []).push(cb);
  }

  start(timeslice?: number): void {
    this.startTimeslice = timeslice;
    this.state = "recording";
    this.emit("start", {});
  }

  requestData(): void {
    this.requestDataCalls += 1;
  }

  stop(): void {
    this.state = "inactive";
    this.emit("dataavailable", {
      data: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
    });
    this.emit("stop", {});
  }

  fail(error: unknown): void {
    this.emit("error", { error });
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.isTypeSupported.mockClear();
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
  it("renews silent audio with overlapping encoders on the same live microphone", async () => {
    vi.useFakeTimers();
    const track = { stop: vi.fn() };
    stubMedia(async () => fakeStream(track), track);
    const session = await createBrowserDictationRecorder().start();
    const renewal = session.renewSilence?.(() => true);
    await vi.advanceTimersByTimeAsync(500);
    expect(await renewal).toBe(500);
    expect(FakeMediaRecorder.instances.map((recorder) => recorder.state)).toEqual([
      "inactive",
      "recording",
    ]);
    expect(track.stop).not.toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    session.cancel();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it.each(["speech", "cancel"])(
    "retains the prefix or cancels both encoders when %s arrives during renewal",
    async (action) => {
      vi.useFakeTimers();
      const track = { stop: vi.fn() };
      stubMedia(async () => fakeStream(track), track);
      const session = await createBrowserDictationRecorder().start();
      let silent = true;
      const renewal = session.renewSilence?.(() => silent);
      await vi.advanceTimersByTimeAsync(100);
      if (action === "cancel") session.cancel();
      else silent = false;
      await vi.advanceTimersByTimeAsync(400);
      expect(await renewal).toBeUndefined();
      expect(FakeMediaRecorder.instances[1]?.state).toBe("inactive");
      expect(FakeMediaRecorder.instances[0]?.state).toBe(
        action === "cancel" ? "inactive" : "recording",
      );
      session.cancel();
      expect(track.stop).toHaveBeenCalledOnce();
    },
  );

  it.each(
    (
      ["replacement-start-failed", "previous-stop-failed", "replacement-stop-failed"] as const
    ).flatMap((reason) => [
      {
        reason,
        cause: new DOMException("private device detail", "InvalidStateError"),
        captureError: "invalid-state",
      },
      { reason, cause: new TypeError("private device detail"), captureError: "type-error" },
      { reason, cause: new RangeError("private device detail"), captureError: "range-error" },
    ]),
  )(
    "classifies $reason / $captureError and preserves the native cause in memory",
    async ({ reason, cause, captureError }) => {
      vi.useFakeTimers();
      stubMedia(async () => fakeStream({ stop: vi.fn() }));
      const session = await createBrowserDictationRecorder().start();
      let silent = true;
      const fail = (): never => {
        throw cause;
      };
      const spy =
        reason === "replacement-start-failed"
          ? vi.spyOn(FakeMediaRecorder.prototype, "start").mockImplementationOnce(fail)
          : vi.spyOn(FakeMediaRecorder.prototype, "stop").mockImplementationOnce(fail);
      try {
        const renewal = session.renewSilence?.(() => silent)?.catch((error: unknown) => error);
        const expected = {
          name: "DictationRecorderError",
          captureReason: reason,
          captureError,
          cause,
          message: "Audio capture renewal failed.",
        };
        if (reason === "replacement-stop-failed") silent = false;
        await vi.advanceTimersByTimeAsync(500);
        expect(await renewal).toMatchObject(expected);
      } finally {
        spy.mockRestore();
        session.cancel();
      }
    },
  );

  it("distinguishes replacement construction from replacement start failures", async () => {
    stubMedia(async () => fakeStream({ stop: vi.fn() }));
    const session = await createBrowserDictationRecorder().start();
    const cause = new TypeError("private constructor detail");
    class BrokenRecorder extends FakeMediaRecorder {
      constructor(stream: unknown, options?: { mimeType?: string }) {
        super(stream, options);
        throw cause;
      }
    }
    vi.stubGlobal("MediaRecorder", BrokenRecorder);
    try {
      await expect(session.renewSilence?.(() => true)).rejects.toMatchObject({
        captureReason: "replacement-create-failed",
        captureError: "type-error",
        cause,
      });
    } finally {
      session.cancel();
    }
  });

  it.each(["initial", "renewal", "stop"] as const)(
    "retains asynchronous native error evidence during %s",
    async (phase) => {
      const track = { stop: vi.fn() };
      stubMedia(async () => fakeStream(track));
      const recorder = createBrowserDictationRecorder();
      const session = phase === "initial" ? undefined : await recorder.start();
      const cause = new DOMException("private device detail", "NotReadableError");
      Object.defineProperty(cause, "stack", {
        value: `NotReadableError: private device detail\n    at start (${location.origin}/_next/static/chunks/1wntg-7ptuw73.js:21:456)`,
      });
      const spy = vi
        .spyOn(FakeMediaRecorder.prototype, phase === "stop" ? "stop" : "start")
        .mockImplementationOnce(function (this: FakeMediaRecorder): void {
          queueMicrotask(() => this.fail(cause));
        });
      try {
        const attempt =
          phase === "initial"
            ? recorder.start()
            : phase === "renewal"
              ? session?.renewSilence?.(() => true)
              : session?.stop();
        const error: unknown = await Promise.resolve(attempt).catch((error: unknown) => error);
        expect(error).toMatchObject({
          name: "DictationRecorderError",
          captureError: "not-readable",
        });
        if (phase === "renewal")
          expect(error).toMatchObject({ captureReason: "replacement-start-failed" });
        const evidence = clientErrorEvidence(error);
        expect(evidence.causeChain).toContain("NotReadableError");
        expect(evidence.frames).toContain(
          "dist/ui/static/_next/static/chunks/1wntg-7ptuw73.js:21:456",
        );
        expect(JSON.stringify(evidence)).not.toContain("private device detail");
      } finally {
        spy.mockRestore();
        session?.cancel();
      }
      expect(track.stop).toHaveBeenCalledOnce();
    },
  );

  it("captures audio and returns base64 + mime + duration, releasing the track", async () => {
    const track = { stop: vi.fn() };
    stubMedia(async () => fakeStream(track), track);
    const recorder = createBrowserDictationRecorder();
    const session = await recorder.start({ timesliceMs: 125 });
    const capture = await session.stop();
    expect(capture.audioBase64).toBe("AQID"); // base64 of [1,2,3]
    expect(capture.mimeType).toBe("audio/webm;codecs=opus");
    expect(capture.durationMs).toBeGreaterThan(0);
    expect(FakeMediaRecorder.instances[0]?.startTimeslice).toBe(125);
    expect(FakeMediaRecorder.instances[0]?.requestDataCalls).toBeGreaterThan(0);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("uses incremental chunks and surfaces encoded chunk callbacks without persisting them", async () => {
    const onChunk = vi.fn();
    stubMedia(async () => fakeStream({ stop: vi.fn() }));
    const recorder = createBrowserDictationRecorder();
    const session = await recorder.start({ onChunk });
    await session.stop();
    expect(FakeMediaRecorder.instances[0]?.startTimeslice).toBe(250);
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
  });

  it("signals onReady once capture is live (immediate fallback when no analyser is available)", async () => {
    const onReady = vi.fn();
    stubMedia(async () => fakeStream({ stop: vi.fn() }));
    const recorder = createBrowserDictationRecorder();
    const session = await recorder.start({ onReady });
    // No AudioContext in this environment → readiness is signalled immediately after the start event
    // rather than blocking on an analyser sample that will never arrive, so the UI never sticks.
    expect(onReady).toHaveBeenCalledTimes(1);
    await session.stop();
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

  it("preserves a native permission-denied DOMException", async () => {
    const cause = new DOMException("private permission detail", "NotAllowedError");
    stubMedia(() => Promise.reject(cause));
    await expect(createBrowserDictationRecorder().start()).rejects.toMatchObject({
      reason: "permission-denied",
      cause,
    });
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
