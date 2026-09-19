import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictationRecorder, DictationSession } from "./dictation-recorder";
import type { VoiceActivityDetector } from "./voice-activity-detector";
import { claimVoiceCapture, resetVoiceCaptureOwnerForTests } from "./voice-capture-owner";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import { useBatchVoiceDialogue } from "./useBatchVoiceDialogue";
import type { SendMessageOutcome } from "./useChatSession";

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
  resetClientDiagnosticWriter();
});

describe("turn-based Digital Twin", () => {
  it("retains a transcript when the canonical queue rejects it", async () => {
    const lease = Symbol("dialogue");
    expect(claimVoiceCapture("chat-a", lease)).toBe(true);
    const { recorder } = fakeRecorder();
    const submit = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockResolvedValueOnce({ status: "completed", assistantMessageId: "retry-answer" });
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
    await waitFor(() => expect(result.current.failedTranscript).toBe("keep these words"));
    expect(result.current.error).toMatch(/could not be queued/u);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.dictation.phase).toBe("recording"));
    act(() => result.current.dictation.stop());
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.waitingForAnswer).toBe(true));
    act(() => result.current.onSpeechSettled("retry-answer"));
    expect(result.current.waitingForAnswer).toBe(false);
    unmount();
  });

  it.each([
    {
      label: "a failed canonical delivery",
      firstDelivery: (): Promise<SendMessageOutcome> => Promise.resolve({ status: "failed" }),
    },
    {
      label: "a rejected canonical delivery",
      firstDelivery: (): Promise<SendMessageOutcome> => Promise.reject(new Error("network")),
    },
  ])("recovers from $label and re-arms capture on retry", async ({ firstDelivery }) => {
    const lease = Symbol("dialogue");
    expect(claimVoiceCapture("chat-a", lease)).toBe(true);
    const { recorder } = fakeRecorder();
    const submit = vi
      .fn()
      .mockImplementationOnce(firstDelivery)
      .mockResolvedValueOnce({ status: "completed", assistantMessageId: "retry-answer" });
    const { result, unmount } = renderHook(() =>
      useBatchVoiceDialogue({
        captureOwner: "chat-a",
        captureLease: lease,
        submit,
        prepareCanonicalVoiceHasher: async () => {},
        dictation: {
          createRecorder: () => recorder,
          transcribe: async () => ({ transcript: "retry these words" }),
          vad: silentVad,
        },
      }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.dictation.phase).toBe("recording"));
    act(() => result.current.dictation.stop());
    await waitFor(() => expect(result.current.failedTranscript).toBe("retry these words"));
    expect(result.current.waitingForAnswer).toBe(false);
    expect(result.current.error).toMatch(/retry or continue in text/u);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.dictation.phase).toBe("recording"));
    expect(result.current.failedTranscript).toBeUndefined();
    act(() => result.current.dictation.stop());
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.waitingForAnswer).toBe(true));
    act(() => result.current.onSpeechSettled("retry-answer"));
    expect(result.current.waitingForAnswer).toBe(false);
    unmount();
  });

  it("retries canonical hasher preparation before opening the microphone", async () => {
    const lease = Symbol("dialogue");
    expect(claimVoiceCapture("chat-a", lease)).toBe(true);
    const { recorder, starts } = fakeRecorder();
    const prepare = vi
      .fn()
      .mockRejectedValueOnce(new Error("hashing unavailable"))
      .mockResolvedValueOnce(undefined);
    const { result, unmount } = renderHook(() =>
      useBatchVoiceDialogue({
        captureOwner: "chat-a",
        captureLease: lease,
        submit: vi.fn(),
        prepareCanonicalVoiceHasher: prepare,
        dictation: { createRecorder: () => recorder, transcribe: vi.fn(), vad: silentVad },
      }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.error).toMatch(/could not be prepared/u));
    expect(result.current.preparing).toBe(false);
    expect(starts).not.toHaveBeenCalled();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.dictation.phase).toBe("recording"));
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeUndefined();
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
    const submit = vi.fn(async (_text: string, _correlationId: string) => ({
      status: "completed" as const,
      assistantMessageId: "answer-a",
    }));
    const diagnostics: Array<{
      readonly correlationId: string | undefined;
      readonly stage: string | undefined;
    }> = [];
    resetClientDiagnosticWriter();
    setClientDiagnosticWriter((_message, meta) => {
      diagnostics.push({ correlationId: meta?.correlationId, stage: meta?.voiceDialogueStage });
    });
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
    await waitFor(() => expect(submit).toHaveBeenCalledWith("spoken question", expect.any(String)));
    const correlationId = submit.mock.calls[0]?.[1];
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(diagnostics).toContainEqual({ correlationId, stage: "turn-submitted" });
    await waitFor(() => expect(result.current.waitingForAnswer).toBe(true));
    expect(starts).toHaveBeenCalledTimes(1);

    act(() => result.current.onSpeechSettled("unrelated-answer"));
    expect(starts).toHaveBeenCalledTimes(1);
    act(() => result.current.onSpeechSettled("answer-a"));
    await waitFor(() => expect(starts).toHaveBeenCalledTimes(2));
    expect(result.current.waitingForAnswer).toBe(false);
    expect(diagnostics).toContainEqual({ correlationId, stage: "answer-ready" });
    expect(diagnostics).toContainEqual({ correlationId, stage: "playback-settled" });
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
