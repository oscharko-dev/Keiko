import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictationCapture, DictationRecorder, DictationSession } from "./dictation-recorder";
import type { VoiceActivityDetector, VoiceActivityEvent } from "./voice-activity-detector";
import { claimVoiceCapture, resetVoiceCaptureOwnerForTests } from "./voice-capture-owner";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import { useBatchVoiceDialogue, type BatchVoiceDialogue } from "./useBatchVoiceDialogue";
import type { SendMessageOutcome } from "./useChatSession";

const silentVad: VoiceActivityDetector = {
  start: () => ({ stop: (): void => {} }),
};

function fakeRecorder(): {
  readonly recorder: DictationRecorder;
  readonly starts: ReturnType<typeof vi.fn>;
} {
  const session: DictationSession = {
    stop: async (): Promise<DictationCapture> => ({
      audioBase64: "QUJDRA==",
      mimeType: "audio/webm",
      durationMs: 500,
    }),
    cancel: (): void => {},
  };
  const starts = vi.fn(async () => session);
  return { recorder: { start: starts }, starts };
}

afterEach(() => {
  resetVoiceCaptureOwnerForTests();
  resetClientDiagnosticWriter();
  vi.useRealTimers();
});

describe("turn-based Digital Twin", () => {
  it("reports capture renewal failure under the active dialogue identity", async () => {
    vi.useFakeTimers();
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    const failure = new Error("private recorder detail", {
      cause: new TypeError("private native detail"),
    });
    const recorder = fakeRecorder().recorder;
    const { result, unmount } = renderHook(() =>
      useBatchVoiceDialogue({
        captureOwner: "renewal-failure",
        captureLease: Symbol.for("renewal-failure"),
        submit: vi.fn(),
        prepareCanonicalVoiceHasher: async () => {},
        dictation: {
          vad: { start: () => ({ available: true, stop: (): void => {} }) },
          createRecorder: () => ({
            start: async (options): Promise<DictationSession> => ({
              ...(await recorder.start(options)),
              stream: { getTracks: () => [] } as unknown as MediaStream,
              renewSilence: async (): Promise<never> => {
                throw failure;
              },
            }),
          }),
        },
      }),
    );
    act(() => result.current.start());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
    });
    expect(result.current.dictation.phase).toBe("error");
    const started = writer.mock.calls.find(([, meta]) => meta?.voiceDialogueStage === "started");
    expect(started?.[1]?.correlationId).toBeTypeOf("string");
    expect(writer).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        kind: "voice-dialogue",
        voiceDialogueStage: "capture-renewal-failed",
        voiceCaptureReason: "unknown-failure",
        errorEvidence: expect.objectContaining({ errorClass: "Error", causeChain: ["TypeError"] }),
        correlationId: started?.[1]?.correlationId,
      }),
    );
    expect(JSON.stringify(writer.mock.calls)).not.toContain("private recorder detail");
    unmount();
  });

  it("logs the automatic capture bound with the unavailable detector reason", async () => {
    vi.useFakeTimers();
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    const recorder = fakeRecorder().recorder;
    const { result, unmount } = renderHook(() =>
      useBatchVoiceDialogue({
        captureOwner: "unavailable-vad",
        captureLease: Symbol("unavailable-vad"),
        submit: vi.fn(),
        prepareCanonicalVoiceHasher: async () => {},
        dictation: {
          vad: silentVad,
          transcribe: async () => ({ transcript: "" }),
          createRecorder: () => ({
            start: async (options): Promise<DictationSession> => ({
              ...(await recorder.start(options)),
              stream: {} as MediaStream,
            }),
          }),
        },
      }),
    );
    act(() => result.current.start());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    const started = writer.mock.calls.find(([, meta]) => meta?.voiceDialogueStage === "started");
    expect(writer).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        voiceDialogueStage: "capture-bound-reached",
        voiceCaptureReason: "vad-unavailable",
        correlationId: started?.[1]?.correlationId,
      }),
    );
    unmount();
  });

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
      label: "a cancelled canonical delivery",
      stage: "delivery-cancelled",
      firstDelivery: (): Promise<SendMessageOutcome> =>
        Promise.resolve({ status: "cancelled", userPersisted: true }),
    },
    {
      label: "a failed canonical delivery",
      stage: "delivery-failed",
      firstDelivery: (): Promise<SendMessageOutcome> => Promise.resolve({ status: "failed" }),
    },
    {
      label: "a rejected canonical delivery",
      stage: "delivery-rejected",
      firstDelivery: (): Promise<SendMessageOutcome> => Promise.reject(new Error("network")),
    },
  ])("recovers from $label and re-arms capture on retry", async ({ firstDelivery, stage }) => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
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
    expect(writer).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ voiceDialogueStage: stage }),
    );
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
    const parentCorrelations: Array<string | undefined> = [];
    const diagnostics: Array<{
      readonly correlationId: string | undefined;
      readonly stage: string | undefined;
    }> = [];
    resetClientDiagnosticWriter();
    vi.useRealTimers();
    setClientDiagnosticWriter((_message, meta) => {
      diagnostics.push({ correlationId: meta?.correlationId, stage: meta?.voiceDialogueStage });
      if (meta?.voiceDialogueStage === "turn-submitted")
        parentCorrelations.push(meta.parentCorrelationId);
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
    expect(parentCorrelations).toEqual([
      diagnostics.find((event) => event.stage === "started")?.correlationId,
    ]);
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

  it.each(["speech-onset", "button", "natural-completion"] as const)(
    "preserves capture through %s without dropping or restarting its first words",
    async (action) => {
      const lease = Symbol("dialogue");
      expect(claimVoiceCapture("chat-a", lease)).toBe(true);
      const events: ((event: VoiceActivityEvent) => void)[] = [];
      const vad: VoiceActivityDetector = {
        start: (_stream, onEvent) => {
          events.push(onEvent);
          return { stop: vi.fn() };
        },
      };
      const cancel = vi.fn();
      const starts = vi.fn(async () => ({
        stream: {} as MediaStream,
        stop: async (): Promise<DictationCapture> => ({
          audioBase64: "QUJDRA==",
          mimeType: "audio/webm",
          durationMs: 500,
        }),
        cancel,
      }));
      const interrupt = vi.fn();
      const submit = vi.fn(async () => ({
        status: "completed" as const,
        assistantMessageId: "answer-a",
      }));
      const { result, rerender, unmount } = renderHook(
        ({ active }): BatchVoiceDialogue =>
          useBatchVoiceDialogue({
            captureOwner: "chat-a",
            captureLease: lease,
            submit,
            playback: { active, interrupt },
            prepareCanonicalVoiceHasher: async () => {},
            dictation: {
              createRecorder: () => ({ start: starts }),
              transcribe: async () => ({ transcript: "Thank you, that is enough." }),
              vad,
            },
          }),
        { initialProps: { active: false } },
      );
      act(() => result.current.start());
      await waitFor(() => expect(result.current.dictation.phase).toBe("recording"));
      act(() => result.current.dictation.stop());
      await waitFor(() => expect(submit).toHaveBeenCalledOnce());
      rerender({ active: true });
      await waitFor(() => expect(starts).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(result.current.dictation.phase).toBe("recording"));
      if (action === "speech-onset") act(() => events.at(-1)?.("speech-onset"));
      else if (action === "button") act(() => result.current.interrupt());
      else act(() => result.current.onSpeechSettled("answer-a"));
      const interruptions = action === "natural-completion" ? 0 : 1;
      expect(interrupt).toHaveBeenCalledTimes(interruptions);
      expect(result.current.waitingForAnswer).toBe(false);
      expect(cancel).not.toHaveBeenCalled();
      act(() => result.current.onSpeechSettled("answer-a"));
      expect(starts).toHaveBeenCalledTimes(2);
      rerender({ active: false });
      act(() => events.at(-1)?.("end-of-turn"));
      await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
      expect(submit).toHaveBeenLastCalledWith("Thank you, that is enough.", expect.any(String));
      unmount();
      act(() => events.at(-1)?.("speech-onset"));
      expect(interrupt).toHaveBeenCalledTimes(interruptions);
    },
  );

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
