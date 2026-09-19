import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictationRecorder, DictationSession } from "./dictation-recorder";
import type { VoiceActivityDetector } from "./voice-activity-detector";
import { claimVoiceCapture, resetVoiceCaptureOwnerForTests } from "./voice-capture-owner";
import { useBatchVoiceDialogue } from "./useBatchVoiceDialogue";

const silentVad: VoiceActivityDetector = {
  start: () => ({ stop: (): void => {} }),
};

function fakeRecorder(): {
  readonly recorder: DictationRecorder;
  readonly starts: ReturnType<typeof vi.fn>;
} {
  const session: DictationSession = {
    stop: async () => ({ audioBase64: "QUJDRA==", mimeType: "audio/webm", durationMs: 500 }),
    cancel: (): void => {},
  };
  const starts = vi.fn(async () => session);
  return { recorder: { start: starts }, starts };
}

afterEach(() => {
  resetVoiceCaptureOwnerForTests();
});

describe("turn-based Digital Twin", () => {
  it("retains a transcript when the canonical queue rejects it", async () => {
    const lease = Symbol("dialogue");
    expect(claimVoiceCapture("chat-a", lease)).toBe(true);
    const { recorder } = fakeRecorder();
    const submit = vi.fn(() => undefined);
    const { result, unmount } = renderHook(() =>
      useBatchVoiceDialogue({
        captureOwner: "chat-a",
        captureLease: lease,
        submit,
        prepareCanonicalVoiceHasher: async () => {},
        dictation: {
          createRecorder: () => recorder,
          transcribe: async () => ({ transcript: "keep these words" }),
          vad: silentVad,
        },
      }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.dictation.phase).toBe("recording"));
    act(() => result.current.dictation.stop());
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(result.current.failedTranscript).toBe("keep these words");
    expect(result.current.error).toMatch(/could not be queued/u);
    unmount();
  });

  it("prepares canonical hashing before opening the microphone and ignores a cancelled start", async () => {
    const lease = Symbol("dialogue");
    expect(claimVoiceCapture("chat-a", lease)).toBe(true);
    const { recorder, starts } = fakeRecorder();
    let resolvePreparation: (() => void) | undefined;
    const prepareCanonicalVoiceHasher = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    const { result, unmount } = renderHook(() =>
      useBatchVoiceDialogue({
        captureOwner: "chat-a",
        captureLease: lease,
        submit: vi.fn(),
        prepareCanonicalVoiceHasher,
        dictation: { createRecorder: () => recorder, transcribe: vi.fn(), vad: silentVad },
      }),
    );

    act(() => result.current.start());
    expect(prepareCanonicalVoiceHasher).toHaveBeenCalledOnce();
    expect(starts).not.toHaveBeenCalled();
    act(() => result.current.stop());
    await act(async () => resolvePreparation?.());
    expect(starts).not.toHaveBeenCalled();
    unmount();
  });

  it("sends a completed STT turn through canonical chat and resumes after its spoken answer", async () => {
    const lease = Symbol("dialogue");
    expect(claimVoiceCapture("chat-a", lease)).toBe(true);
    const { recorder, starts } = fakeRecorder();
    const submit = vi.fn(async () => ({
      status: "completed" as const,
      assistantMessageId: "answer-a",
    }));
    const { result, unmount } = renderHook(() =>
      useBatchVoiceDialogue({
        captureOwner: "chat-a",
        captureLease: lease,
        submit,
        dictation: {
          createRecorder: () => recorder,
          transcribe: async () => ({ transcript: "spoken question" }),
          vad: silentVad,
        },
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.dictation.phase).toBe("recording"));
    act(() => result.current.dictation.stop());
    await waitFor(() => expect(submit).toHaveBeenCalledWith("spoken question"));
    await waitFor(() => expect(result.current.waitingForAnswer).toBe(true));
    expect(starts).toHaveBeenCalledTimes(1);

    act(() => result.current.onSpeechSettled("unrelated-answer"));
    expect(starts).toHaveBeenCalledTimes(1);
    act(() => result.current.onSpeechSettled("answer-a"));
    await waitFor(() => expect(starts).toHaveBeenCalledTimes(2));
    expect(result.current.waitingForAnswer).toBe(false);
    unmount();
  });

  it("discards a late transcription when the user leaves during STT", async () => {
    const lease = Symbol("dialogue");
    expect(claimVoiceCapture("chat-a", lease)).toBe(true);
    const { recorder } = fakeRecorder();
    let resolveTranscript: ((value: { readonly transcript: string }) => void) | undefined;
    const transcribe = vi.fn(
      () =>
        new Promise<{ readonly transcript: string }>((resolve) => {
          resolveTranscript = resolve;
        }),
    );
    const submit = vi.fn(async () => ({
      status: "completed" as const,
      assistantMessageId: "answer-a",
    }));
    const { result, unmount } = renderHook(() =>
      useBatchVoiceDialogue({
        captureOwner: "chat-a",
        captureLease: lease,
        submit,
        dictation: { createRecorder: () => recorder, transcribe, vad: silentVad },
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.dictation.phase).toBe("recording"));
    act(() => result.current.dictation.stop());
    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    act(() => result.current.stop());
    await act(async () => resolveTranscript?.({ transcript: "private late question" }));
    expect(submit).not.toHaveBeenCalled();
    expect(result.current.dictation.phase).toBe("idle");
    unmount();
  });
});
