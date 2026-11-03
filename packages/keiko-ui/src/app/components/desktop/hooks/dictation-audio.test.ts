import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeDictationAudio } from "./dictation-audio";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

vi.mock("@/lib/client-diagnostics", () => ({
  reportClientDiagnostic: vi.fn(),
  recordClientDiagnosticLoss: vi.fn(),
}));

function stubAudio(duration = 0.001, samples = new Float32Array(16)): void {
  const buffer = { duration, getChannelData: (): Float32Array => samples };
  vi.stubGlobal(
    "OfflineAudioContext",
    class {
      destination = {};
      decodeAudioData = vi.fn(async () => buffer);
      createBufferSource = (): object => ({ connect: vi.fn(), start: vi.fn() });
      startRendering = vi.fn(async () => buffer);
    },
  );
}

function bytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (): void => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom does not implement the browser's Blob.arrayBuffer method.
  vi.stubGlobal(
    "Blob",
    class extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        return Promise.resolve(new ArrayBuffer(this.size));
      }
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("normalizeDictationAudio", () => {
  it("reports a local binary read failure without a provider call", async () => {
    stubAudio();
    vi.spyOn(Blob.prototype, "arrayBuffer").mockRejectedValue(new Error("binary read failed"));
    await expect(normalizeDictationAudio(new Blob(["audio"]))).rejects.toThrow(
      "binary read failed",
    );
  });

  it("writes an interoperable 16 kHz mono PCM16 WAV and clips sample amplitudes", async () => {
    stubAudio(6 / 16000, new Float32Array([-2, -0.5, 0, 0.5, 2, 0]));
    const result = await normalizeDictationAudio(new Blob(["browser codec bytes"]));
    const view = new DataView(await bytes(result));
    expect(result.type).toBe("audio/wav");
    expect(result.size).toBe(56);
    expect(view.getUint32(4, true)).toBe(48);
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(12);
    expect([44, 46, 48, 50, 52, 54].map((offset) => view.getInt16(offset, true))).toEqual([
      -32768, -16384, 0, 16383, 32767, 0,
    ]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 126])(
    "rejects invalid or oversized decoded duration %s before rendering",
    async (duration) => {
      stubAudio(duration);
      await expect(normalizeDictationAudio(new Blob(["encoded audio"]))).rejects.toThrow(
        RangeError,
      );
    },
  );

  it.each([0, 4_000_001])("rejects an encoded clip of %s bytes before decoding", async (size) => {
    await expect(normalizeDictationAudio(new Blob([new Uint8Array(size)]))).rejects.toThrow(
      RangeError,
    );
  });

  it("keeps a full two-minute dictation within the existing four-megabyte limit", async () => {
    stubAudio(120, new Float32Array(1_920_000));
    const result = await normalizeDictationAudio(new Blob(["two-minute encoded clip"]));
    expect(result.size).toBe(3_840_044);
  });

  it("surfaces decoder errors without uploading the incompatible original container", async () => {
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData = vi.fn(async () => {
          throw new DOMException("codec refused", "EncodingError");
        });
      },
    );
    await expect(normalizeDictationAudio(new Blob(["invalid audio"]))).rejects.toThrow(
      "codec refused",
    );
    expect(reportClientDiagnostic).toHaveBeenCalledWith("Dictation audio normalization failed.", {
      kind: "other",
      errorKind: "validation-failed",
      errorEvidence: expect.objectContaining({ errorClass: "Error" }),
    });
    expect(JSON.stringify(vi.mocked(reportClientDiagnostic).mock.calls)).not.toContain(
      "codec refused",
    );
  });
});
