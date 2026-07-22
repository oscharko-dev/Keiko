// Media-only Realtime Voice state-machine tests. The fake transport exercises WebRTC lifecycle,
// VAD, and provider transcription without opening a microphone, socket, model, or paid resource.

import { act, renderHook, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_PROTOCOL_TIMEOUTS } from "@oscharko-dev/keiko-contracts";
import { MAX_DESKTOP_CHAT_INPUT_CHARS } from "@oscharko-dev/keiko-contracts/bff-wire";
import { useRealtimeVoice } from "./useRealtimeVoice";
import { VoiceControlError, type VoiceControlClient } from "./voice-realtime-client";
import { VoiceRtcError, type VoiceRtcSession, type VoiceRtcTransport } from "./voice-rtc-transport";

const ICE_GRACE_ABOVE_MS = 6_000;
const SESSION_READY_WARMUP_MS = 150;
const CANONICAL_TURN_CONTINUATION_GRACE_MS = 1_600;
const CANONICAL_TURN_ID_PATTERN = /^client-turn-[a-f0-9]{32}-(?:\d+|[a-f0-9]{64}(?:-\d+)?)$/u;

interface CapturedCanonicalTurn {
  readonly turnId: string;
  readonly text: string;
}

interface FakeSession {
  readonly session: VoiceRtcSession;
  readonly fireConnectionState: (state: RTCPeerConnectionState) => void;
  readonly fireLocalVoiceActivity: (activity: "speech-onset" | "end-of-turn") => void;
  readonly fireDataChannelEvent: (event: unknown) => void;
  readonly fireDataChannelState: (state: RTCDataChannelState) => void;
  readonly sendDataChannelEvent: ReturnType<typeof vi.fn>;
  readonly setInputMuted: ReturnType<typeof vi.fn>;
  readonly applyAnswer: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
}

function makeFakeSession(
  options: { readonly exposeDataChannelState?: boolean | undefined } = {},
): FakeSession {
  let connectionStateCallback: ((state: RTCPeerConnectionState) => void) | undefined;
  let localVoiceActivityCallback: ((activity: "speech-onset" | "end-of-turn") => void) | undefined;
  let dataChannelEventCallback: ((event: unknown) => void) | undefined;
  let dataChannelStateCallback: ((state: RTCDataChannelState) => void) | undefined;
  const applyAnswer = vi.fn(async (_sdp: string): Promise<void> => {});
  const sendDataChannelEvent = vi.fn((_event: unknown) => true);
  const setInputMuted = vi.fn();
  const close = vi.fn();
  const session: VoiceRtcSession = {
    offerSdp: "v=0\r\nfake-offer",
    applyAnswer,
    setInputMuted,
    onLocalVoiceActivity(callback): void {
      localVoiceActivityCallback = callback;
    },
    onConnectionStateChange(callback): void {
      connectionStateCallback = callback;
    },
    onDataChannelEvent(callback): void {
      dataChannelEventCallback = callback;
    },
    ...(options.exposeDataChannelState === true
      ? {
          onDataChannelStateChange(callback: (state: RTCDataChannelState) => void): void {
            dataChannelStateCallback = callback;
            callback("connecting");
          },
        }
      : {}),
    sendDataChannelEvent,
    close,
  };
  return {
    session,
    fireConnectionState: (state) => connectionStateCallback?.(state),
    fireLocalVoiceActivity: (activity) => localVoiceActivityCallback?.(activity),
    fireDataChannelEvent: (event) => dataChannelEventCallback?.(event),
    fireDataChannelState: (state) => dataChannelStateCallback?.(state),
    sendDataChannelEvent,
    setInputMuted,
    applyAnswer,
    close,
  };
}

function makeFakeTransport(options: {
  readonly session?: VoiceRtcSession | undefined;
  readonly connectError?: unknown;
}): VoiceRtcTransport {
  return {
    connect: vi.fn(async () => {
      if (options.connectError !== undefined) throw options.connectError;
      if (options.session === undefined) throw new Error("fake session missing");
      return options.session;
    }),
  };
}

function makeFakeControl(
  options: {
    readonly negotiateResult?: string | undefined;
    readonly negotiateError?: unknown;
  } = {},
): { readonly client: VoiceControlClient; readonly close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  return {
    client: {
      negotiate: vi.fn(async (): Promise<string> => {
        if (options.negotiateError !== undefined) throw options.negotiateError;
        return options.negotiateResult ?? "v=0\r\nfake-answer";
      }),
      close,
    },
    close,
  };
}

function renderVoice(options: {
  readonly fake: FakeSession;
  readonly canStartCapture?: Parameters<typeof useRealtimeVoice>[0]["canStartCapture"];
  readonly onCanonicalUserTurn?: Parameters<typeof useRealtimeVoice>[0]["onCanonicalUserTurn"];
  readonly turnDetectionProfile?:
    Parameters<typeof useRealtimeVoice>[0]["turnDetectionProfile"] | undefined;
}): ReturnType<typeof renderHook<ReturnType<typeof useRealtimeVoice>, unknown>> {
  const transport = makeFakeTransport({ session: options.fake.session });
  const { client } = makeFakeControl();
  return renderHook(() =>
    useRealtimeVoice({
      createTransport: () => transport,
      createControl: () => client,
      canStartCapture: options.canStartCapture,
      onCanonicalUserTurn: options.onCanonicalUserTurn,
      turnDetectionProfile: options.turnDetectionProfile,
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useRealtimeVoice media-only session", () => {
  it("negotiates and becomes connected after RTC readiness and warm-up", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const { result } = renderVoice({ fake });

    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => {
      fake.fireConnectionState("connected");
      vi.advanceTimersByTime(SESSION_READY_WARMUP_MS);
    });

    await vi.waitFor(() => expect(result.current.phase).toBe("connected"));
    expect(fake.applyAnswer).toHaveBeenCalledWith("v=0\r\nfake-answer");
  });

  it("waits for data-channel open and session.updated when that acknowledgement is exposed", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession({ exposeDataChannelState: true });
    const { result } = renderVoice({ fake });

    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => {
      fake.fireConnectionState("connected");
      vi.advanceTimersByTime(SESSION_READY_WARMUP_MS);
      fake.fireDataChannelState("open");
    });
    expect(result.current.phase).toBe("negotiating");
    act(() => fake.fireDataChannelEvent({ type: "session.updated" }));

    await vi.waitFor(() => expect(result.current.phase).toBe("connected"));
  });

  it.each(["balanced", "headset", "laptop", "noisy", "semantic"] as const)(
    "keeps provider responses and interruption disabled for the %s VAD profile",
    async (turnDetectionProfile) => {
      const fake = makeFakeSession({ exposeDataChannelState: true });
      const { result } = renderVoice({ fake, turnDetectionProfile });

      act(() => result.current.start());
      await waitFor(() => expect(result.current.phase).toBe("negotiating"));
      act(() => fake.fireDataChannelState("open"));

      expect(fake.sendDataChannelEvent).toHaveBeenCalledWith({
        type: "session.update",
        session: {
          type: "realtime",
          audio: {
            input: {
              turn_detection: expect.objectContaining({
                type: turnDetectionProfile === "semantic" ? "semantic_vad" : "server_vad",
                interrupt_response: false,
                create_response: false,
              }),
            },
          },
        },
      });
    },
  );

  it("leaves server-owned VAD tuning untouched when no profile was selected", async () => {
    const fake = makeFakeSession({ exposeDataChannelState: true });
    const { result } = renderVoice({ fake });

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => fake.fireDataChannelState("open"));

    expect(fake.sendDataChannelEvent).toHaveBeenCalledWith({
      type: "session.update",
      session: { type: "realtime" },
    });
  });

  it("never registers provider audio output or reacts to assistant/tool response events", async () => {
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn();
    const { result } = renderVoice({ fake, onCanonicalUserTurn });

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => {
      fake.fireDataChannelEvent({ type: "response.output_audio_transcript.done", transcript: "x" });
      fake.fireDataChannelEvent({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "forbidden-call",
          name: "search_keiko_grounding",
          arguments: "{}",
        },
      });
      fake.fireDataChannelEvent({ type: "response.done", response: { status: "completed" } });
    });

    expect(onCanonicalUserTurn).not.toHaveBeenCalled();
    const outbound = JSON.stringify(fake.sendDataChannelEvent.mock.calls);
    expect(outbound).not.toContain("response.create");
    expect(outbound).not.toContain("response.cancel");
    expect(outbound).not.toContain("function_call_output");
    expect(result.current.speaking).toBe(false);
    expect(result.current.canInterrupt).toBe(false);
  });

  it("mutes only the input capture track", async () => {
    const fake = makeFakeSession();
    const { result } = renderVoice({ fake });

    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => result.current.toggleMute());
    expect(result.current.muted).toBe(true);
    expect(fake.setInputMuted).toHaveBeenLastCalledWith(true);
    act(() => result.current.toggleMute());
    expect(fake.setInputMuted).toHaveBeenLastCalledWith(false);
  });

  it("raises barge-in once when local and provider VAD report the same speech onset", async () => {
    const fake = makeFakeSession();
    const onUserSpeechStart = vi.fn();
    const transport = makeFakeTransport({ session: fake.session });
    const { client } = makeFakeControl();
    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
        onUserSpeechStart,
      }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("negotiating"));

    act(() => {
      fake.fireLocalVoiceActivity("speech-onset");
      fake.fireDataChannelEvent({ type: "input_audio_buffer.speech_started" });
    });
    expect(onUserSpeechStart).toHaveBeenCalledOnce();
    act(() => {
      fake.fireLocalVoiceActivity("end-of-turn");
      fake.fireDataChannelEvent({ type: "input_audio_buffer.speech_stopped" });
      fake.fireDataChannelEvent({ type: "input_audio_buffer.speech_started" });
    });
    expect(onUserSpeechStart).toHaveBeenCalledTimes(2);
  });

  it("starts the first barge-in of a new session after stopping during active speech", async () => {
    const fake = makeFakeSession();
    const onUserSpeechStart = vi.fn();
    const transport = makeFakeTransport({ session: fake.session });
    const { client } = makeFakeControl();
    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
        onUserSpeechStart,
      }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => fake.fireDataChannelEvent({ type: "input_audio_buffer.speech_started" }));
    expect(onUserSpeechStart).toHaveBeenCalledOnce();

    act(() => {
      result.current.stop();
      result.current.start();
    });
    await waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
    act(() => fake.fireDataChannelEvent({ type: "input_audio_buffer.speech_started" }));

    expect(onUserSpeechStart).toHaveBeenCalledTimes(2);
  });
});

describe("useRealtimeVoice canonical transcript delivery", () => {
  it("dispatches one settled final transcript through the canonical chat callback", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn().mockResolvedValue("completed");
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));

    act(() =>
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "user-final",
        transcript: "Search the connected repository.",
      }),
    );
    expect(result.current.partialUserTranscript).toBe("Search the connected repository.");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
    expect(onCanonicalUserTurn).toHaveBeenCalledWith({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: "Search the connected repository.",
    });
    expect(result.current.partialUserTranscript).toBeUndefined();
  });

  it("coalesces final segments across a natural speaking pause", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn().mockResolvedValue("completed");
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));

    act(() => {
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "segment-one",
        transcript: "I would like to know",
      });
      vi.advanceTimersByTime(1_000);
      fake.fireDataChannelEvent({ type: "input_audio_buffer.speech_started" });
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "segment-two",
        transcript: "to know which add-ons are relevant.",
      });
      fake.fireDataChannelEvent({ type: "input_audio_buffer.speech_stopped" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledWith({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: "I would like to know which add-ons are relevant.",
    });
  });

  it("keeps a late final held while the next utterance is still VAD-active", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn((_turn: CapturedCanonicalTurn): boolean => true);
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));

    act(() => {
      fake.fireDataChannelEvent({ type: "input_audio_buffer.speech_started" });
      fake.fireDataChannelEvent({ type: "input_audio_buffer.speech_stopped" });
      fake.fireDataChannelEvent({ type: "input_audio_buffer.speech_started" });
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "late-final-a",
        transcript: "First fragment",
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS * 2);
    });
    expect(onCanonicalUserTurn).not.toHaveBeenCalled();

    act(() => {
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "final-b",
        transcript: "continued after a long pause.",
      });
      fake.fireDataChannelEvent({ type: "input_audio_buffer.speech_stopped" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
    expect(onCanonicalUserTurn).toHaveBeenCalledWith({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: "First fragment continued after a long pause.",
    });
  });

  it("matches continuation overlap independently of the browser locale", async () => {
    vi.useFakeTimers();
    const nativeLocaleLower = String.prototype.toLocaleLowerCase;
    vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function (
      this: string,
    ): string {
      return nativeLocaleLower.call(this, "tr-TR");
    });
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn().mockResolvedValue("completed");
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));

    act(() => {
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "locale-one",
        transcript: "Keep ID I",
      });
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "locale-two",
        transcript: "id i stable",
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledWith({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: "Keep ID I stable",
    });
  });

  it("matches canonically equivalent Unicode without rewriting the first final", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn().mockResolvedValue("completed");
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));

    act(() => {
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "unicode-one",
        transcript: "Please ask Jos\u00e9",
      });
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "unicode-two",
        transcript: "ask Jose\u0301 tomorrow",
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledWith({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: "Please ask Jos\u00e9 tomorrow",
    });
  });

  it.each([
    ["The code is 42", "42 not 24", "The code is 42 not 24"],
    [
      "Call PaymentService",
      "PaymentService after validation",
      "Call PaymentService after validation",
    ],
    ["Ask Oliver", "Oliver can confirm", "Ask Oliver can confirm"],
    ["Tell me the", "the latest status", "Tell me the the latest status"],
  ])("handles distinctive one-token overlap: %s + %s", async (first, second, expected) => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn().mockResolvedValue("completed");
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));

    act(() => {
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "single-one",
        transcript: first,
      });
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "single-two",
        transcript: second,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledWith({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: expected,
    });
  });

  it("keeps a failed interim transcript visible but waits for a real final", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn().mockResolvedValue("completed");
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));

    act(() => {
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "fallback-user",
        delta: "Keep this reviewed partial",
      });
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.failed",
        item_id: "fallback-user",
        error: { message: "provider-controlled-detail" },
      });
    });
    await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    expect(onCanonicalUserTurn).not.toHaveBeenCalled();
    expect(result.current.partialUserTranscript).toBe("Keep this reviewed partial");

    act(() =>
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "fallback-user",
        transcript: "Keep this complete final.",
      }),
    );
    await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);

    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
    expect(onCanonicalUserTurn).toHaveBeenCalledWith({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: "Keep this complete final.",
    });
  });

  it("never promotes an interim delta and releases media after a generic provider error", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn();
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => {
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "provider-error-partial",
        delta: "Unfinished fact that must not enter memory.",
      });
      fake.fireDataChannelEvent({
        type: "error",
        error: { message: "provider-controlled-detail" },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS * 2);
    });

    expect(onCanonicalUserTurn).not.toHaveBeenCalled();
    expect(result.current.partialUserTranscript).toBe(
      "Unfinished fact that must not enter memory.",
    );
    expect(result.current.phase).toBe("error");
    expect(fake.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deduplicates a repeated provider final by item id", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn().mockResolvedValue("completed");
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    const finalEvent = {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "replayed",
      transcript: "Persist exactly once.",
    };

    act(() => {
      fake.fireDataChannelEvent(finalEvent);
      fake.fireDataChannelEvent(finalEvent);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
  });

  it("deduplicates anonymous replay but gives a later identical utterance a fresh turn id", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn();
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    const anonymousFinal = {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Repeatable legitimate fact.",
    };

    act(() => {
      fake.fireDataChannelEvent(anonymousFinal);
      fake.fireDataChannelEvent(anonymousFinal);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });
    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
    const firstTurnId = onCanonicalUserTurn.mock.calls[0]?.[0].turnId;

    act(() => {
      fake.fireDataChannelEvent({ type: "input_audio_buffer.speech_started" });
      fake.fireDataChannelEvent(anonymousFinal);
      fake.fireDataChannelEvent({ type: "input_audio_buffer.speech_stopped" });
    });
    await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);

    expect(onCanonicalUserTurn).toHaveBeenCalledTimes(2);
    expect(onCanonicalUserTurn.mock.calls[1]?.[0].turnId).not.toBe(firstTurnId);
  });

  it("keeps canonical turn identities collision-proof when a provider item id repeats after remount", async () => {
    vi.useFakeTimers();
    const providerFinal = {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "provider-session-local-item",
      transcript: "First session utterance.",
    };
    const firstFake = makeFakeSession();
    const firstDelivery = vi.fn();
    const firstVoice = renderVoice({ fake: firstFake, onCanonicalUserTurn: firstDelivery });
    act(() => firstVoice.result.current.start());
    await vi.waitFor(() => expect(firstVoice.result.current.phase).toBe("negotiating"));
    act(() => firstFake.fireDataChannelEvent(providerFinal));
    await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    const firstTurnId = firstDelivery.mock.calls[0]?.[0].turnId;
    firstVoice.unmount();

    const secondFake = makeFakeSession();
    const secondDelivery = vi.fn();
    const secondVoice = renderVoice({ fake: secondFake, onCanonicalUserTurn: secondDelivery });
    act(() => secondVoice.result.current.start());
    await vi.waitFor(() => expect(secondVoice.result.current.phase).toBe("negotiating"));
    act(() =>
      secondFake.fireDataChannelEvent({
        ...providerFinal,
        transcript: "Second session utterance.",
      }),
    );
    await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);

    expect(firstTurnId).toMatch(CANONICAL_TURN_ID_PATTERN);
    expect(secondDelivery.mock.calls[0]?.[0].turnId).toMatch(CANONICAL_TURN_ID_PATTERN);
    expect(secondDelivery.mock.calls[0]?.[0].turnId).not.toBe(firstTurnId);
  });

  it("never promotes a hostile provider item id to the canonical chat identity", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn().mockResolvedValue("completed");
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    const opaqueItemId = "provider\r\nX-Forged: yes/🚨\u0000";

    act(() =>
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: opaqueItemId,
        transcript: "Treat the identity as opaque.",
      }),
    );
    await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);

    expect(onCanonicalUserTurn).toHaveBeenCalledWith({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: "Treat the identity as opaque.",
    });
    expect(onCanonicalUserTurn.mock.calls[0]?.[0].turnId).not.toBe(opaqueItemId);
  });

  it("keeps large cumulative deltas within the hard cap visible without dispatching interim text", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn();
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    const half = "a".repeat(Math.floor(MAX_DESKTOP_CHAT_INPUT_CHARS / 2) - 1);

    act(() => {
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "oversized",
        delta: half,
      });
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "oversized",
        delta: half,
      });
    });

    expect(onCanonicalUserTurn).not.toHaveBeenCalled();
    expect(result.current.partialUserTranscript).toBe(`${half}${half}`);
    expect(result.current.phase).toBe("negotiating");
  });

  it("fails visibly and retains bounded review text when a final exceeds the hard cap", async () => {
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn();
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    const overLimit = "a".repeat(MAX_DESKTOP_CHAT_INPUT_CHARS + 1);

    act(() =>
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "hard-cap-overflow",
        transcript: overLimit,
      }),
    );

    expect(onCanonicalUserTurn).not.toHaveBeenCalled();
    expect(result.current.partialUserTranscript).toBe(overLimit.slice(0, -1));
    expect(result.current.phase).toBe("error");
  });

  it("preserves individually valid finals when their continuation aggregate exceeds the cap", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn((_turn: CapturedCanonicalTurn): boolean => true);
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    const first = "a".repeat(200_000);
    const second = "b".repeat(100_000);

    act(() => {
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "aggregate-first",
        transcript: first,
      });
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "aggregate-second",
        transcript: second,
      });
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
    expect(onCanonicalUserTurn.mock.calls[0]?.[0]).toEqual({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: first,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledTimes(2);
    expect(onCanonicalUserTurn.mock.calls[1]?.[0]).toEqual({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: second,
    });
    expect(onCanonicalUserTurn.mock.calls[1]?.[0].turnId).not.toBe(
      onCanonicalUserTurn.mock.calls[0]?.[0].turnId,
    );
  });

  it("hands a 16,001-character final off atomically without merging its tail into the next utterance", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn((_turn: CapturedCanonicalTurn): boolean => true);
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    const first = "a".repeat(8_000);
    const second = "b".repeat(8_000);
    const fullTranscript = `${first} ${second}`;

    act(() =>
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "long-final",
        transcript: fullTranscript,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
    const firstTurn = onCanonicalUserTurn.mock.calls[0]?.[0];
    expect(firstTurn?.text).toBe(fullTranscript);
    expect(firstTurn?.turnId).toMatch(CANONICAL_TURN_ID_PATTERN);

    act(() => {
      fake.fireDataChannelEvent({ type: "input_audio_buffer.speech_started" });
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "next-final",
        transcript: "This is a genuinely separate utterance.",
      });
      fake.fireDataChannelEvent({ type: "input_audio_buffer.speech_stopped" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledTimes(2);
    expect(onCanonicalUserTurn.mock.calls[1]?.[0]).toEqual({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: "This is a genuinely separate utterance.",
    });
    expect(onCanonicalUserTurn.mock.calls[1]?.[0].turnId).not.toBe(firstTurn?.turnId);
  });

  it("stops capture at hard outbox backpressure and retries only on explicit control", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi
      .fn((_turn: CapturedCanonicalTurn): boolean => true)
      .mockReturnValueOnce(false);
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() =>
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "backpressured-final",
        transcript: "Keep this final until the canonical queue accepts it.",
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });
    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
    expect(result.current.partialUserTranscript).toBe(
      "Keep this final until the canonical queue accepts it.",
    );
    expect(result.current.phase).toBe("error");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS * 4);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    act(() => result.current.retry());
    await vi.waitFor(() => expect(onCanonicalUserTurn).toHaveBeenCalledTimes(2));
    expect(onCanonicalUserTurn.mock.calls[1]?.[0]).toEqual(onCanonicalUserTurn.mock.calls[0]?.[0]);
    expect(result.current.partialUserTranscript).toBeUndefined();
  });

  it("does not accept another final after hard outbox backpressure stops capture", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn((_turn: CapturedCanonicalTurn): boolean => false);
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() =>
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "settled-backpressure-a",
        transcript: "First settled utterance.",
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
    act(() =>
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "settled-backpressure-b",
        transcript: "Must be ignored after capture stopped.",
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
    expect(result.current.partialUserTranscript).toBe("First settled utterance.");
    expect(fake.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reuses the deterministic identity when an old provider final outlives the 32-item fast cache", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn((_turn: CapturedCanonicalTurn): boolean => true);
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => {
      fake.fireConnectionState("connected");
      vi.advanceTimersByTime(SESSION_READY_WARMUP_MS);
    });
    await vi.waitFor(() => expect(result.current.phase).toBe("connected"));
    const oldest = {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "provider-oldest",
      transcript: "Oldest accepted final.",
    };

    for (let index = 0; index < 40; index += 1) {
      act(() =>
        fake.fireDataChannelEvent(
          index === 0
            ? oldest
            : {
                ...oldest,
                item_id: `provider-${String(index)}`,
                transcript: `Accepted final ${String(index)}.`,
              },
        ),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS + 1);
      });
      expect(
        onCanonicalUserTurn,
        `provider final ${String(index)} was not handed off`,
      ).toHaveBeenCalledTimes(index + 1);
    }
    expect(onCanonicalUserTurn).toHaveBeenCalledTimes(40);
    const oldestTurnId = onCanonicalUserTurn.mock.calls[0]?.[0].turnId;

    act(() => fake.fireDataChannelEvent(oldest));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS * 2);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledTimes(41);
    expect(oldestTurnId).toMatch(CANONICAL_TURN_ID_PATTERN);
    expect(onCanonicalUserTurn.mock.calls[40]?.[0].turnId).toBe(oldestTurnId);
  });

  it("hands a final off exactly once and leaves admission reconciliation to canonical Chat", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn((_turn: CapturedCanonicalTurn): void => undefined);
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() =>
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "chat-owned",
        transcript: "Canonical Chat owns this turn after handoff.",
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS * 100);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
    expect(result.current.partialUserTranscript).toBeUndefined();
  });
});

describe("useRealtimeVoice reconnect and teardown", () => {
  it("deduplicates a provider final replayed by a recoverable replacement session", async () => {
    vi.useFakeTimers();
    const first = makeFakeSession();
    const second = makeFakeSession();
    const transport: VoiceRtcTransport = {
      connect: vi
        .fn<VoiceRtcTransport["connect"]>()
        .mockResolvedValueOnce(first.session)
        .mockResolvedValueOnce(second.session),
    };
    const { client } = makeFakeControl();
    const onCanonicalUserTurn = vi.fn((_turn: CapturedCanonicalTurn): boolean => true);
    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
        onCanonicalUserTurn,
      }),
    );
    const replayedFinal = {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "provider-replayed-after-reconnect",
      transcript: "Persist this provider final only once.",
    };

    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => first.fireDataChannelEvent(replayedFinal));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });
    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();

    act(() => first.fireConnectionState("failed"));
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(second.applyAnswer).toHaveBeenCalledOnce());
    act(() => second.fireDataChannelEvent(replayedFinal));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS * 2);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
  });

  it("uses a fresh canonical namespace after an explicit stop and restart", async () => {
    vi.useFakeTimers();
    const first = makeFakeSession();
    const second = makeFakeSession();
    const transport: VoiceRtcTransport = {
      connect: vi
        .fn<VoiceRtcTransport["connect"]>()
        .mockResolvedValueOnce(first.session)
        .mockResolvedValueOnce(second.session),
    };
    const { client } = makeFakeControl();
    const onCanonicalUserTurn = vi.fn((_turn: CapturedCanonicalTurn): boolean => true);
    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
        onCanonicalUserTurn,
      }),
    );
    const providerFinal = {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "provider-id-reused-in-new-session",
      transcript: "First logical session.",
    };

    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => first.fireDataChannelEvent(providerFinal));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });
    const firstTurnId = onCanonicalUserTurn.mock.calls[0]?.[0].turnId;
    act(() => result.current.stop());

    act(() => result.current.start());
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(second.applyAnswer).toHaveBeenCalledOnce());
    act(() => second.fireDataChannelEvent({ ...providerFinal, transcript: "Second session." }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledTimes(2);
    expect(firstTurnId).toMatch(CANONICAL_TURN_ID_PATTERN);
    expect(onCanonicalUserTurn.mock.calls[1]?.[0].turnId).toMatch(CANONICAL_TURN_ID_PATTERN);
    expect(onCanonicalUserTurn.mock.calls[1]?.[0].turnId).not.toBe(firstTurnId);
  });

  it("keeps a rejected A final separate when chat B replaces a reconnect backoff", async () => {
    vi.useFakeTimers();
    const first = makeFakeSession();
    const second = makeFakeSession();
    const transport: VoiceRtcTransport = {
      connect: vi
        .fn<VoiceRtcTransport["connect"]>()
        .mockResolvedValueOnce(first.session)
        .mockResolvedValueOnce(second.session),
    };
    const { client } = makeFakeControl();
    let acceptA = false;
    const deliverA = vi.fn((_turn: CapturedCanonicalTurn): boolean => acceptA);
    const deliverB = vi.fn((_turn: CapturedCanonicalTurn): boolean => true);
    const { result, rerender } = renderHook(
      (props: { readonly chatId: string }) =>
        useRealtimeVoice({
          createTransport: () => transport,
          createControl: () => client,
          chatContext: { chatId: props.chatId },
          onCanonicalUserTurn: props.chatId === "chat-a" ? deliverA : deliverB,
        }),
      { initialProps: { chatId: "chat-a" } },
    );
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => {
      first.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "a-before-reconnect",
        transcript: "Final captured by chat A.",
      });
      first.fireConnectionState("failed");
    });
    expect(deliverA).toHaveBeenCalledOnce();

    rerender({ chatId: "chat-b" });
    acceptA = true;
    expect(transport.connect).toHaveBeenCalledOnce();
    act(() => result.current.retry());
    await vi.waitFor(() => expect(second.applyAnswer).toHaveBeenCalledOnce());
    act(() =>
      second.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "b-after-reconnect",
        transcript: "Final captured by chat B.",
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });

    expect(deliverA.mock.calls.at(-1)?.[0].text).toBe("Final captured by chat A.");
    expect(deliverB).toHaveBeenCalledOnce();
    expect(deliverB.mock.calls[0]?.[0].text).toBe("Final captured by chat B.");
    expect(deliverA.mock.calls.at(-1)?.[0].turnId).not.toBe(deliverB.mock.calls[0]?.[0].turnId);
  });

  it("keeps a session whose transient RTC disconnect recovers inside the grace window", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const transport = makeFakeTransport({ session: fake.session });
    const { client } = makeFakeControl();
    const { result } = renderHook(() =>
      useRealtimeVoice({ createTransport: () => transport, createControl: () => client }),
    );
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => {
      fake.fireConnectionState("connected");
      vi.advanceTimersByTime(SESSION_READY_WARMUP_MS);
    });
    await vi.waitFor(() => expect(result.current.phase).toBe("connected"));

    act(() => {
      fake.fireConnectionState("disconnected");
      vi.advanceTimersByTime(4_000);
      fake.fireConnectionState("connected");
      vi.advanceTimersByTime(2_000);
    });

    expect(fake.close).not.toHaveBeenCalled();
    expect(transport.connect).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe("connected");
  });

  it.each(["failed", "closed"] as const)(
    "hands off a held final before an RTC %s replacement",
    async (terminalState) => {
      vi.useFakeTimers();
      const fake = makeFakeSession();
      const onCanonicalUserTurn = vi.fn();
      const voice = renderVoice({ fake, onCanonicalUserTurn });
      act(() => voice.result.current.start());
      await vi.waitFor(() => expect(voice.result.current.phase).toBe("negotiating"));

      act(() => {
        fake.fireDataChannelEvent({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: `final-before-${terminalState}`,
          transcript: `Persist before RTC ${terminalState}.`,
        });
        fake.fireDataChannelEvent({ type: "input_audio_buffer.speech_started" });
        fake.fireConnectionState(terminalState);
      });

      expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
      expect(fake.close).toHaveBeenCalledOnce();
      voice.unmount();
    },
  );

  it("keeps a final handed off when replacement negotiation subsequently fails", async () => {
    vi.useFakeTimers();
    const first = makeFakeSession();
    const second = makeFakeSession();
    const transport: VoiceRtcTransport = {
      connect: vi
        .fn<VoiceRtcTransport["connect"]>()
        .mockResolvedValueOnce(first.session)
        .mockResolvedValueOnce(second.session),
    };
    const negotiate = vi
      .fn<VoiceControlClient["negotiate"]>()
      .mockResolvedValueOnce("v=0\r\nfake-answer")
      .mockRejectedValueOnce(new VoiceControlError("negotiation-failed", "Replacement failed."));
    const client: VoiceControlClient = { negotiate, close: vi.fn() };
    const onCanonicalUserTurn = vi.fn();
    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
        onCanonicalUserTurn,
      }),
    );
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => {
      first.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "final-before-reconnect-failure",
        transcript: "Keep this final through reconnect failure.",
      });
      first.fireDataChannelEvent({ type: "input_audio_buffer.speech_started" });
      first.fireConnectionState("disconnected");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ICE_GRACE_ABOVE_MS);
    });
    await vi.waitFor(() => expect(result.current.error?.reason).toBe("negotiation-failed"));
    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
  });

  it("replaces a session whose transcript data channel closes", async () => {
    vi.useFakeTimers();
    const first = makeFakeSession({ exposeDataChannelState: true });
    const second = makeFakeSession({ exposeDataChannelState: true });
    const transport: VoiceRtcTransport = {
      connect: vi
        .fn<VoiceRtcTransport["connect"]>()
        .mockResolvedValueOnce(first.session)
        .mockResolvedValueOnce(second.session),
    };
    const { client } = makeFakeControl();
    const { result } = renderHook(() =>
      useRealtimeVoice({ createTransport: () => transport, createControl: () => client }),
    );
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => {
      first.fireConnectionState("connected");
      first.fireDataChannelState("open");
      first.fireDataChannelEvent({ type: "session.updated" });
      vi.advanceTimersByTime(SESSION_READY_WARMUP_MS);
    });
    await vi.waitFor(() => expect(result.current.phase).toBe("connected"));

    act(() => first.fireDataChannelState("closed"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ICE_GRACE_ABOVE_MS);
    });

    expect(first.close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
  });

  it("stops automatic replacement at the protocol reconnect budget", async () => {
    vi.useFakeTimers();
    const sessionCount = DEFAULT_VOICE_PROTOCOL_TIMEOUTS.maxReconnectAttempts + 1;
    const fakes = Array.from({ length: sessionCount }, () => makeFakeSession());
    let nextSession = 0;
    const connect = vi.fn<VoiceRtcTransport["connect"]>(async () => {
      const session = fakes[nextSession]?.session;
      nextSession += 1;
      if (session === undefined) throw new Error("Reconnect budget exceeded in test.");
      return session;
    });
    const { client } = makeFakeControl();
    const { result } = renderHook(() =>
      useRealtimeVoice({ createTransport: () => ({ connect }), createControl: () => client }),
    );
    act(() => result.current.start());

    for (let attempt = 0; attempt < sessionCount; attempt += 1) {
      const fake = fakes[attempt];
      await vi.waitFor(() => expect(fake?.applyAnswer).toHaveBeenCalledOnce());
      act(() => fake?.fireConnectionState("failed"));
      if (attempt < DEFAULT_VOICE_PROTOCOL_TIMEOUTS.maxReconnectAttempts) {
        const backoffMs = Math.min(
          DEFAULT_VOICE_PROTOCOL_TIMEOUTS.reconnectBackoffInitialMs * 2 ** attempt,
          DEFAULT_VOICE_PROTOCOL_TIMEOUTS.reconnectBackoffMaxMs,
        );
        await act(async () => vi.advanceTimersByTimeAsync(backoffMs));
      }
    }

    expect(connect).toHaveBeenCalledTimes(sessionCount);
    expect(result.current.error?.reason).toBe("connection-failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["missing-ack", "rejected-send"] as const)(
    "bounds incomplete realtime readiness for %s and clears recovery on stop",
    async (scenario) => {
      vi.useFakeTimers();
      const fake = makeFakeSession({ exposeDataChannelState: true });
      if (scenario === "rejected-send") fake.sendDataChannelEvent.mockReturnValue(false);
      const { result } = renderVoice({ fake });
      act(() => result.current.start());
      await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
      await vi.waitFor(() => expect(fake.applyAnswer).toHaveBeenCalledOnce());
      act(() => {
        fake.fireConnectionState("connected");
        fake.fireDataChannelState("open");
        vi.advanceTimersByTime(SESSION_READY_WARMUP_MS);
      });
      expect(result.current.phase).toBe("negotiating");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEFAULT_VOICE_PROTOCOL_TIMEOUTS.signalingMs);
      });

      expect(fake.close).toHaveBeenCalledOnce();
      expect(result.current.phase).toBe("negotiating");
      act(() => result.current.stop());
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("coalesces start calls while microphone acquisition is pending", async () => {
    let resolveSession: ((session: VoiceRtcSession) => void) | undefined;
    const fake = makeFakeSession();
    const transport: VoiceRtcTransport = {
      connect: vi.fn(
        () =>
          new Promise<VoiceRtcSession>((resolve) => {
            resolveSession = resolve;
          }),
      ),
    };
    const { client, close } = makeFakeControl();
    const createControl = vi.fn(() => client);
    const { result } = renderHook(() =>
      useRealtimeVoice({ createTransport: () => transport, createControl }),
    );

    act(() => {
      result.current.start();
      result.current.start();
    });
    expect(transport.connect).toHaveBeenCalledOnce();
    expect(createControl).toHaveBeenCalledOnce();
    await act(async () => {
      resolveSession?.(fake.session);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.phase).toBe("negotiating"));
    expect(close).not.toHaveBeenCalled();
  });

  it("uses the latest same-chat callback snapshot for a final after scope or model refresh", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const transport = makeFakeTransport({ session: fake.session });
    const { client } = makeFakeControl();
    const beforeRefresh = vi.fn(() => true);
    const afterRefresh = vi.fn(() => true);
    const { result, rerender } = renderHook(
      (props: { readonly deliver: typeof beforeRefresh }) =>
        useRealtimeVoice({
          createTransport: () => transport,
          createControl: () => client,
          chatContext: { chatId: "same-chat" },
          onCanonicalUserTurn: props.deliver,
        }),
      { initialProps: { deliver: beforeRefresh } },
    );
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));

    rerender({ deliver: afterRefresh });
    act(() =>
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "after-same-chat-refresh",
        transcript: "Use the refreshed scope and model snapshot.",
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });

    expect(beforeRefresh).not.toHaveBeenCalled();
    expect(afterRefresh).toHaveBeenCalledWith({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: "Use the refreshed scope and model snapshot.",
    });
  });

  it("binds a live session to its starting chat and closes it on chat switch", async () => {
    vi.useFakeTimers();
    const first = makeFakeSession();
    const second = makeFakeSession();
    const transport: VoiceRtcTransport = {
      connect: vi
        .fn<VoiceRtcTransport["connect"]>()
        .mockResolvedValueOnce(first.session)
        .mockResolvedValueOnce(second.session),
    };
    const { client } = makeFakeControl();
    const deliverA = vi.fn().mockResolvedValue("completed");
    const deliverB = vi.fn().mockResolvedValue("completed");
    const { result, rerender } = renderHook(
      (props: { readonly chatId: string; readonly deliver: typeof deliverA }) =>
        useRealtimeVoice({
          createTransport: () => transport,
          createControl: () => client,
          chatContext: { chatId: props.chatId },
          onCanonicalUserTurn: props.deliver,
        }),
      { initialProps: { chatId: "chat-a", deliver: deliverA } },
    );
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() =>
      first.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "settled-in-a",
        transcript: "This final belongs to chat A.",
      }),
    );

    rerender({ chatId: "chat-b", deliver: deliverB });

    expect(first.close).toHaveBeenCalledOnce();
    expect(deliverA).toHaveBeenCalledWith({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: "This final belongs to chat A.",
    });
    act(() =>
      first.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "late-from-a",
        transcript: "Never route this old-session final into B.",
      }),
    );
    expect(deliverA).toHaveBeenCalledOnce();
    expect(deliverB).not.toHaveBeenCalled();

    act(() => result.current.start());
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
    act(() =>
      second.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "final-in-b",
        transcript: "This final belongs to chat B.",
      }),
    );
    await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);

    expect(deliverB).toHaveBeenCalledOnce();
    expect(deliverB).toHaveBeenCalledWith({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: "This final belongs to chat B.",
    });
  });

  it("routes a final arriving between chat rerender and passive cleanup to the starting chat", async () => {
    const fake = makeFakeSession();
    const transport = makeFakeTransport({ session: fake.session });
    const { client } = makeFakeControl();
    const deliverA = vi.fn(() => true);
    const deliverB = vi.fn(() => true);
    const { result, rerender } = renderHook(
      (props: { readonly chatId: string; readonly fireRaceFinal: boolean }) => {
        const voice = useRealtimeVoice({
          createTransport: () => transport,
          createControl: () => client,
          chatContext: { chatId: props.chatId },
          onCanonicalUserTurn: props.chatId === "chat-a" ? deliverA : deliverB,
        });
        useLayoutEffect(() => {
          if (!props.fireRaceFinal) return;
          fake.fireDataChannelEvent({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "render-cleanup-race",
            transcript: "This final was captured by chat A before cleanup.",
          });
        }, [props.fireRaceFinal]);
        return voice;
      },
      { initialProps: { chatId: "chat-a", fireRaceFinal: false } },
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("negotiating"));

    rerender({ chatId: "chat-b", fireRaceFinal: true });

    expect(deliverA).toHaveBeenCalledOnce();
    expect(deliverA).toHaveBeenCalledWith({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: "This final was captured by chat A before cleanup.",
    });
    expect(deliverB).not.toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("flushes an already committed final exactly once when the component unmounts", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn().mockResolvedValue("completed");
    const { result, unmount } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() =>
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "final-before-unmount",
        transcript: "Persist this final before teardown.",
      }),
    );

    unmount();

    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
    expect(onCanonicalUserTurn).toHaveBeenCalledWith({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: "Persist this final before teardown.",
    });
    await vi.runAllTimersAsync();
    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not auto-retry a hard-capacity rejection during unmount or remount", async () => {
    vi.useFakeTimers();
    const firstFake = makeFakeSession();
    const delivery = vi
      .fn((_turn: CapturedCanonicalTurn): boolean => true)
      .mockReturnValueOnce(false);
    const first = renderVoice({ fake: firstFake, onCanonicalUserTurn: delivery });
    act(() => first.result.current.start());
    await vi.waitFor(() => expect(first.result.current.phase).toBe("negotiating"));
    act(() =>
      firstFake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "rejected-before-unmount",
        transcript: "Retain this settled final across the component lifecycle.",
      }),
    );

    first.unmount();
    expect(delivery).toHaveBeenCalledOnce();
    const second = renderVoice({ fake: makeFakeSession(), onCanonicalUserTurn: delivery });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(delivery).toHaveBeenCalledOnce();
    second.unmount();
  });

  it("hands the boundary final to Chat before stopping capture at outbox capacity", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    let captureCapacityAvailable = true;
    const delivery = vi.fn((_turn: CapturedCanonicalTurn): "accepted-stop" => {
      captureCapacityAvailable = false;
      return "accepted-stop";
    });
    const voice = renderVoice({
      fake,
      canStartCapture: () => captureCapacityAvailable,
      onCanonicalUserTurn: delivery,
    });
    act(() => voice.result.current.start());
    await vi.waitFor(() => expect(voice.result.current.phase).toBe("negotiating"));

    act(() =>
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "reserved-boundary-final",
        transcript: "Chat owns this final before capture stops.",
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CANONICAL_TURN_CONTINUATION_GRACE_MS);
    });

    expect(delivery).toHaveBeenCalledOnce();
    expect(delivery).toHaveBeenCalledWith({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: "Chat owns this final before capture stops.",
    });
    expect(voice.result.current.phase).toBe("error");
    expect(voice.result.current.error?.message).toContain("queued in chat");
    expect(voice.result.current.partialUserTranscript).toBeUndefined();
    expect(fake.close).toHaveBeenCalledOnce();

    act(() => voice.result.current.retry());
    expect(voice.result.current.phase).toBe("error");
    expect(fake.applyAnswer).toHaveBeenCalledOnce();

    captureCapacityAvailable = true;
    act(() => voice.result.current.retry());
    await vi.waitFor(() => expect(fake.applyAnswer).toHaveBeenCalledTimes(2));

    voice.unmount();
    await vi.runAllTimersAsync();
    expect(delivery).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not open capture until the canonical Chat outbox has regular capacity", async () => {
    const fake = makeFakeSession();
    let captureCapacityAvailable = false;
    const voice = renderVoice({
      fake,
      canStartCapture: () => captureCapacityAvailable,
    });

    act(() => voice.result.current.start());
    expect(voice.result.current.phase).toBe("error");
    expect(voice.result.current.error?.message).toContain("queued in chat");
    expect(fake.applyAnswer).not.toHaveBeenCalled();

    captureCapacityAvailable = true;
    act(() => voice.result.current.retry());
    await waitFor(() => expect(fake.applyAnswer).toHaveBeenCalledOnce());
    voice.unmount();
  });

  it("does not promote a partial provider delta during unmount or explicit stop", async () => {
    vi.useFakeTimers();
    const unmountFake = makeFakeSession();
    const onUnmountCanonicalTurn = vi.fn();
    const unmounted = renderVoice({
      fake: unmountFake,
      onCanonicalUserTurn: onUnmountCanonicalTurn,
    });
    act(() => unmounted.result.current.start());
    await vi.waitFor(() => expect(unmounted.result.current.phase).toBe("negotiating"));
    act(() =>
      unmountFake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "partial-unmount",
        delta: "This is not a provider final.",
      }),
    );
    unmounted.unmount();

    const stopFake = makeFakeSession();
    const onStopCanonicalTurn = vi.fn();
    const stopped = renderVoice({ fake: stopFake, onCanonicalUserTurn: onStopCanonicalTurn });
    act(() => stopped.result.current.start());
    await vi.waitFor(() => expect(stopped.result.current.phase).toBe("negotiating"));
    act(() => {
      stopFake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "partial-stop",
        delta: "Still not a provider final.",
      });
      stopped.result.current.stop();
    });
    await vi.runAllTimersAsync();

    expect(onUnmountCanonicalTurn).not.toHaveBeenCalled();
    expect(onStopCanonicalTurn).not.toHaveBeenCalled();
    stopped.unmount();
  });

  it("flushes a committed final on explicit stop without waiting for continuation", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    const onCanonicalUserTurn = vi.fn().mockResolvedValue("completed");
    const { result } = renderVoice({ fake, onCanonicalUserTurn });
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => {
      fake.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "final-before-stop",
        transcript: "Persist on mode leave.",
      });
      result.current.stop();
    });

    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(onCanonicalUserTurn).toHaveBeenCalledOnce();
  });

  it("hands off a held final before replacing a failed ICE session", async () => {
    vi.useFakeTimers();
    const first = makeFakeSession();
    const second = makeFakeSession();
    const transport: VoiceRtcTransport = {
      connect: vi
        .fn<VoiceRtcTransport["connect"]>()
        .mockResolvedValueOnce(first.session)
        .mockResolvedValueOnce(second.session),
    };
    const { client, close } = makeFakeControl();
    const onCanonicalUserTurn = vi.fn().mockResolvedValue("completed");
    const { result } = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => transport,
        createControl: () => client,
        onCanonicalUserTurn,
      }),
    );
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => {
      first.fireConnectionState("connected");
      vi.advanceTimersByTime(SESSION_READY_WARMUP_MS);
      first.fireDataChannelEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "held-during-ice",
        transcript: "Persist after reconnect.",
      });
      first.fireDataChannelEvent({ type: "input_audio_buffer.speech_started" });
      first.fireConnectionState("disconnected");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ICE_GRACE_ABOVE_MS);
    });
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
    expect(close).toHaveBeenCalledWith({ resumable: true });
    expect(onCanonicalUserTurn).toHaveBeenCalledWith({
      turnId: expect.stringMatching(CANONICAL_TURN_ID_PATTERN),
      text: "Persist after reconnect.",
    });
  });

  it("ignores terminal callbacks from a replaced session", async () => {
    vi.useFakeTimers();
    const first = makeFakeSession();
    const second = makeFakeSession();
    const transport: VoiceRtcTransport = {
      connect: vi
        .fn<VoiceRtcTransport["connect"]>()
        .mockResolvedValueOnce(first.session)
        .mockResolvedValueOnce(second.session),
    };
    const { client } = makeFakeControl();
    const { result } = renderHook(() =>
      useRealtimeVoice({ createTransport: () => transport, createControl: () => client }),
    );
    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.phase).toBe("negotiating"));
    act(() => first.fireConnectionState("disconnected"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ICE_GRACE_ABOVE_MS);
    });
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));

    act(() => first.fireConnectionState("closed"));
    expect(second.close).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("negotiating");
  });

  it("stop closes resources without sending provider response control", async () => {
    const fake = makeFakeSession();
    const { client, close } = makeFakeControl();
    const transport = makeFakeTransport({ session: fake.session });
    const { result } = renderHook(() =>
      useRealtimeVoice({ createTransport: () => transport, createControl: () => client }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("negotiating"));

    act(() => result.current.stop());

    expect(result.current.phase).toBe("idle");
    expect(fake.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith({ resumable: false });
    expect(JSON.stringify(fake.sendDataChannelEvent.mock.calls)).not.toContain("response.");
  });

  it("closes a transport that resolves after unmount", async () => {
    let resolveSession: ((session: VoiceRtcSession) => void) | undefined;
    const transport: VoiceRtcTransport = {
      connect: vi.fn(
        () =>
          new Promise<VoiceRtcSession>((resolve) => {
            resolveSession = resolve;
          }),
      ),
    };
    const { client } = makeFakeControl();
    const fake = makeFakeSession();
    const { result, unmount } = renderHook(() =>
      useRealtimeVoice({ createTransport: () => transport, createControl: () => client }),
    );
    act(() => result.current.start());
    unmount();
    await act(async () => {
      resolveSession?.(fake.session);
      await Promise.resolve();
    });

    expect(fake.close).toHaveBeenCalledOnce();
  });
});

describe("useRealtimeVoice errors", () => {
  it("maps microphone and control failures to fail-visible states", async () => {
    const microphone = renderHook(() =>
      useRealtimeVoice({
        createTransport: () =>
          makeFakeTransport({
            connectError: new VoiceRtcError("permission-denied", "Microphone permission denied."),
          }),
        createControl: () => makeFakeControl().client,
      }),
    );
    act(() => microphone.result.current.start());
    await waitFor(() => expect(microphone.result.current.error?.reason).toBe("permission-denied"));
    microphone.unmount();

    const fake = makeFakeSession();
    const control = renderHook(() =>
      useRealtimeVoice({
        createTransport: () => makeFakeTransport({ session: fake.session }),
        createControl: () =>
          makeFakeControl({
            negotiateError: new VoiceControlError("negotiation-failed", "Negotiation failed."),
          }).client,
      }),
    );
    act(() => control.result.current.start());
    await waitFor(() => expect(control.result.current.error?.reason).toBe("negotiation-failed"));
  });
});
