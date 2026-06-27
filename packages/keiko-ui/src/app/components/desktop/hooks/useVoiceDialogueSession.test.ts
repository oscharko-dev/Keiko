// Issue #1560 (ADR-0090) — the thin dialogue-session hook. Drives the REAL hook with injected fake
// dictation recorder, transcribe/synthesize seams, and a controllable fake audio element (no real media
// APIs). Proves: the fallback-matrix availability gate (AC4); the spoken turn loop (mic → preview →
// committed text sent via the existing chat lifecycle, AC2); barge-in routing to playback + chat (AC1);
// and the idempotent master cleanup on stop / unmount / capability loss (AC3).

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCapabilityResolution } from "@/lib/types";
import type { DictationRecorder, DictationSession } from "./dictation-recorder";
import type { AssistantSpeechAudioElement } from "./useAssistantSpeech";
import {
  useVoiceDialogueSession,
  type DialogueChatSession,
  type UseVoiceDialogueSessionOptions,
} from "./useVoiceDialogueSession";

// ─── Capability fixtures ────────────────────────────────────────────────────────
const PERSONAS = ["male", "female", "neutral"] as const;

const FULL_REALTIME_NO_WEBRTC: VoiceCapabilityResolution = {
  available: true,
  profile: "full-realtime",
  capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
  transport: { websocketControl: true, webrtcMedia: false },
  availableVoicePersonas: PERSONAS,
};

const STT: VoiceCapabilityResolution = {
  available: true,
  profile: "speech-to-text",
  capabilities: { speechToText: true, speechOutput: false, realtimeVoice: false },
  transport: { websocketControl: true, webrtcMedia: false },
  availableVoicePersonas: PERSONAS,
};

// ─── Fake media surfaces ────────────────────────────────────────────────────────
class FakeAudio implements AssistantSpeechAudioElement {
  src = "";
  muted = false;
  playCount = 0;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play(): Promise<void> {
    this.playCount += 1;
    return Promise.resolve();
  }
  pause(): void {}
  firePlaying(): void {
    this.onplaying?.();
  }
  fireEnded(): void {
    this.onended?.();
  }
}

interface RecorderHarness {
  readonly recorder: DictationRecorder;
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly cancel: ReturnType<typeof vi.fn>;
}

function makeRecorder(): RecorderHarness {
  const stop = vi.fn(async () => ({
    audioBase64: "AAAA",
    mimeType: "audio/webm",
    durationMs: 500,
  }));
  const cancel = vi.fn();
  const session: DictationSession = { stop, cancel };
  const start = vi.fn(async () => session);
  const recorder: DictationRecorder = { start };
  return { recorder, start, stop, cancel };
}

interface ChatHarness {
  readonly session: DialogueChatSession;
  readonly sendMessage: ReturnType<typeof vi.fn>;
  readonly cancelSend: ReturnType<typeof vi.fn>;
}

function makeChatSession(overrides: Partial<DialogueChatSession> = {}): ChatHarness {
  const sendMessage = vi.fn(async () => {});
  const cancelSend = vi.fn();
  const session: DialogueChatSession = {
    sendStatus: "idle",
    sending: false,
    sendMessage,
    cancelSend,
    ...overrides,
  };
  return { session, sendMessage, cancelSend };
}

interface Harness {
  readonly options: UseVoiceDialogueSessionOptions;
  readonly recorder: RecorderHarness;
  readonly audios: FakeAudio[];
  readonly onLeave: ReturnType<typeof vi.fn>;
  readonly chat: ChatHarness;
  readonly transcribe: ReturnType<typeof vi.fn>;
}

function harness(
  overrides: Partial<UseVoiceDialogueSessionOptions> = {},
  chatOverrides: Partial<DialogueChatSession> = {},
): Harness {
  const recorder = makeRecorder();
  const audios: FakeAudio[] = [];
  const onLeave = vi.fn();
  const chat = makeChatSession(chatOverrides);
  const transcribe = vi.fn(async () => ({ transcript: "open the deploy log" }));
  const options: UseVoiceDialogueSessionOptions = {
    capability: FULL_REALTIME_NO_WEBRTC,
    active: true,
    persona: "male",
    session: chat.session,
    answerText: undefined,
    answerId: undefined,
    onLeave,
    createRecorder: () => recorder.recorder,
    transcribe,
    synthesize: vi.fn(async () => ({ audio: btoa("AUDIO"), mimeType: "audio/mpeg" })),
    createAudio: () => {
      const audio = new FakeAudio();
      audios.push(audio);
      return audio;
    },
    createObjectUrl: () => "blob:dialogue",
    revokeObjectUrl: () => undefined,
    ...overrides,
  };
  return { options, recorder, audios, onLeave, chat, transcribe };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "Blob",
    class {
      constructor(
        public readonly parts: unknown[],
        public readonly options?: { type?: string },
      ) {}
    },
  );
  // dictationCaptureSupported() gates the matrix on a capture-capable browser; jsdom lacks both, so
  // stub them (mirrors the other voice hook suites). The fake recorder is injected separately.
  vi.stubGlobal("MediaRecorder", class {});
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Availability gate (AC4) ──────────────────────────────────────────────────────
describe("useVoiceDialogueSession — availability (AC4)", () => {
  it("is unavailable for a non-dialogue profile (STT-only)", () => {
    const h = harness({ capability: STT });
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));
    expect(result.current.dialogueAvailable).toBe(false);
  });

  it("is available for full-realtime WITHOUT WebRTC media (the STT+TTS fallback fix)", () => {
    const h = harness();
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));
    expect(result.current.dialogueAvailable).toBe(true);
  });

  it("is unavailable for an undefined resolution", () => {
    const h = harness({ capability: undefined });
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));
    expect(result.current.dialogueAvailable).toBe(false);
  });

  it("does not start capture when onListen fires while inactive", () => {
    const h = harness({ active: false });
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));
    act(() => result.current.onListen());
    expect(h.recorder.start).not.toHaveBeenCalled();
  });
});

// ─── Spoken turn loop (AC1/AC2) ─────────────────────────────────────────────────────
describe("useVoiceDialogueSession — spoken turn loop (AC1/AC2)", () => {
  it("onListen starts capture and takes the floor to listening", async () => {
    const h = harness();
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));
    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });
    expect(h.recorder.start).toHaveBeenCalledTimes(1);
    expect(result.current.listening).toBe(true);
  });

  it("a second onListen ends the turn and sends the committed transcript via the chat lifecycle (AC2)", async () => {
    const h = harness();
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));
    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });
    // End the user turn → transcribe → preview → user-end-of-turn → send.
    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    // Issue #1561 — the committed transcript is handed to the chat send directly as `text` so it carries
    // the same context a typed turn would, and never strands on a stale draft.
    expect(h.chat.sendMessage).toHaveBeenCalledWith({ text: "open the deploy log" });
    expect(h.chat.sendMessage).toHaveBeenCalledTimes(1);
    // The end-of-turn advanced the floor off listening (full-realtime floor path, D4).
    expect(result.current.listening).toBe(false);
  });

  it("never sends an empty transcript (committed-only invariant, D10)", async () => {
    const h = harness({ transcribe: vi.fn(async () => ({ transcript: "   " })) });
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));
    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });
    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(h.chat.sendMessage).not.toHaveBeenCalled();
  });

  it("speaks the settled answer and reaches the speaking floor", async () => {
    const h = harness({ answerText: "Here is the deploy log.", answerId: "a1" });
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));
    await flush();
    await act(async () => {
      h.audios[0]?.firePlaying();
      await Promise.resolve();
    });
    expect(result.current.speaking).toBe(true);
    expect(result.current.canInterrupt).toBe(true);
  });
});

// ─── Barge-in (AC1, D6) ─────────────────────────────────────────────────────────────
describe("useVoiceDialogueSession — barge-in (AC1, D6)", () => {
  it("onInterrupt while the assistant speaks stops playback and cancels an in-flight send", async () => {
    const h = harness({ answerText: "A long spoken answer.", answerId: "a1" }, { sending: true });
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));
    await flush();
    await act(async () => {
      h.audios[0]?.firePlaying();
      await Promise.resolve();
    });
    expect(result.current.speaking).toBe(true);
    act(() => result.current.onInterrupt());
    expect(h.chat.cancelSend).toHaveBeenCalledTimes(1);
    expect(result.current.speaking).toBe(false);
  });

  it("a mic activation during speaking barges in (stops playback) then listens", async () => {
    const h = harness({ answerText: "A long spoken answer.", answerId: "a1" }, { sending: true });
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));
    await flush();
    await act(async () => {
      h.audios[0]?.firePlaying();
      await Promise.resolve();
    });
    expect(result.current.speaking).toBe(true);
    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });
    expect(h.chat.cancelSend).toHaveBeenCalled();
    expect(result.current.listening).toBe(true);
  });
});

// ─── Master cleanup (AC3, D9) ─────────────────────────────────────────────────────
describe("useVoiceDialogueSession — master cleanup (AC3, D9)", () => {
  it("onStop cancels dictation, resets the floor, and notifies the host", async () => {
    const h = harness();
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));
    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });
    act(() => result.current.onStop());
    expect(h.recorder.cancel).toHaveBeenCalled();
    expect(h.onLeave).toHaveBeenCalledTimes(1);
    expect(result.current.turnSnapshot.state).toBe("idle");
    expect(result.current.listening).toBe(false);
  });

  it("is idempotent: a second onStop performs no further work beyond a safe re-run", async () => {
    const h = harness();
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));
    act(() => result.current.onStop());
    const leaveCalls = h.onLeave.mock.calls.length;
    act(() => result.current.onStop());
    expect(h.onLeave.mock.calls.length).toBe(leaveCalls + 1);
    expect(result.current.turnSnapshot.state).toBe("idle");
  });

  it("tears down and leaves when the deployment flips unavailable mid-session (AC3/AC4)", async () => {
    const h = harness();
    const { result, rerender } = renderHook(
      (props: UseVoiceDialogueSessionOptions) => useVoiceDialogueSession(props),
      { initialProps: h.options },
    );
    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });
    rerender({ ...h.options, capability: STT });
    expect(h.recorder.cancel).toHaveBeenCalled();
    expect(h.onLeave).toHaveBeenCalled();
    expect(result.current.dialogueAvailable).toBe(false);
  });

  it("cancels dictation on unmount (D9)", async () => {
    const h = harness();
    const { result, unmount } = renderHook(() => useVoiceDialogueSession(h.options));
    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });
    unmount();
    expect(h.recorder.cancel).toHaveBeenCalled();
  });
});

// ─── Provider-error + capture-race robustness (Scope: handle provider error without leaking) ──────
describe("useVoiceDialogueSession — provider failure and capture race", () => {
  it("drives the floor to recovering when dictation transcription fails (no strand in listening)", async () => {
    const h = harness({ transcribe: vi.fn(() => Promise.reject(new Error("provider down"))) });
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));
    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });
    // End the turn → transcribe rejects → dictation enters `error` → provider-failure → recovering.
    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(result.current.listening).toBe(false);
    expect(result.current.turnSnapshot.state).toBe("recovering");
    // The failure edge never sends a (non-existent) committed transcript.
    expect(h.chat.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores a re-tap while a capture start is in flight (no second getUserMedia stream)", async () => {
    const h = harness();
    // A start() that never resolves keeps dictation in the `requesting` permission window.
    h.recorder.start.mockImplementation(() => new Promise<never>(() => undefined));
    const { result } = renderHook(() => useVoiceDialogueSession(h.options));
    await act(async () => {
      result.current.onListen();
      await Promise.resolve();
    });
    // A second activation during `requesting` must be ignored, not open a second capture stream.
    act(() => result.current.onListen());
    expect(h.recorder.start).toHaveBeenCalledTimes(1);
  });
});
