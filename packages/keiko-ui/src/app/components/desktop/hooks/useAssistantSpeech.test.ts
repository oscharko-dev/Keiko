// Issue #1558 — the assistant speech-output audio engine. Verifies it synthesizes the exact visible
// assistant text (AC2), plays it through the lifecycle (AC1), releases the audio element / object URL /
// pending fetch on stop, mute, session switch, and unmount (AC3), and degrades to the visible text on a
// provider or playback failure (AC4). A controllable fake audio element and an injected synthesize seam
// keep the test deterministic with no real media element or network.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  useAssistantSpeech,
  type AssistantSpeechAudioElement,
  type UseAssistantSpeechOptions,
} from "./useAssistantSpeech";

class FakeAudio implements AssistantSpeechAudioElement {
  src = "";
  muted = false;
  paused = true;
  playCount = 0;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play(): Promise<void> {
    this.playCount += 1;
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  firePlaying(): void {
    this.onplaying?.();
  }
  fireEnded(): void {
    this.onended?.();
  }
  fireError(): void {
    this.onerror?.();
  }
}

interface SynthCall {
  readonly text: string;
  readonly signal: AbortSignal;
}

function audioBase64(): string {
  return btoa("SYNTHESIZED-AUDIO-BYTES");
}

interface Harness {
  readonly options: UseAssistantSpeechOptions;
  readonly audios: FakeAudio[];
  readonly synthCalls: SynthCall[];
  readonly created: string[];
  readonly revoked: string[];
}

function harness(overrides: Partial<UseAssistantSpeechOptions> = {}): Harness {
  const audios: FakeAudio[] = [];
  const synthCalls: SynthCall[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  let urlSeq = 0;
  const options: UseAssistantSpeechOptions = {
    profile: "speech-output",
    enabled: true,
    text: "The assistant answer.",
    messageId: "m1",
    synthesize: (text, signal) => {
      synthCalls.push({ text, signal });
      return Promise.resolve({ audio: audioBase64(), mimeType: "audio/mpeg" });
    },
    createAudio: () => {
      const audio = new FakeAudio();
      audios.push(audio);
      return audio;
    },
    createObjectUrl: () => {
      urlSeq += 1;
      const url = `blob:audio-${String(urlSeq)}`;
      created.push(url);
      return url;
    },
    revokeObjectUrl: (url) => revoked.push(url),
    ...overrides,
  };
  return { options, audios, synthCalls, created, revoked };
}

// Flushes the synthesis promise chain (synthesize → blob → play) inside act.
async function flush(): Promise<void> {
  await act(async () => {
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useAssistantSpeech — dormant gate (AC1)", () => {
  it("never synthesizes for a non-playback profile", async () => {
    const h = harness({ profile: "speech-to-text" });
    const { result } = renderHook(() => useAssistantSpeech(h.options));
    await flush();
    expect(result.current.snapshot.available).toBe(false);
    expect(h.synthCalls).toHaveLength(0);
  });

  it("never synthesizes when speech output is disabled", async () => {
    const h = harness({ enabled: false });
    renderHook(() => useAssistantSpeech(h.options));
    await flush();
    expect(h.synthCalls).toHaveLength(0);
  });

  it("never synthesizes while no assistant turn is settled", async () => {
    const h = harness({ text: undefined, messageId: undefined });
    renderHook(() => useAssistantSpeech(h.options));
    await flush();
    expect(h.synthCalls).toHaveLength(0);
  });
});

describe("useAssistantSpeech — speak the visible answer (AC1/AC2)", () => {
  it("synthesizes the exact visible text and drives prepare → speaking → complete", async () => {
    const h = harness({ text: "Exactly what the transcript shows." });
    const { result } = renderHook(() => useAssistantSpeech(h.options));
    // The lifecycle arms synchronously on mount.
    expect(result.current.snapshot.phase).toBe("preparing");
    await flush();
    expect(h.synthCalls).toHaveLength(1);
    expect(h.synthCalls[0]?.text).toBe("Exactly what the transcript shows.");
    const audio = h.audios[0];
    expect(audio?.src).toBe(h.created[0]);
    act(() => audio?.firePlaying());
    expect(result.current.snapshot.phase).toBe("speaking");
    expect(result.current.snapshot.spoke).toBe(true);
    act(() => audio?.fireEnded());
    expect(result.current.snapshot.phase).toBe("complete");
    // The object URL is revoked when playback ends (no buffer leak).
    expect(h.revoked).toContain(h.created[0]);
  });

  it("speaks a message only once across re-renders", async () => {
    const h = harness();
    const { rerender } = renderHook(() => useAssistantSpeech(h.options));
    await flush();
    rerender();
    rerender();
    await flush();
    expect(h.synthCalls).toHaveLength(1);
  });
});

describe("useAssistantSpeech — resource release (AC3)", () => {
  it("stop pauses the audio, revokes the URL, aborts the fetch, and cancels the turn", async () => {
    const h = harness();
    const { result } = renderHook(() => useAssistantSpeech(h.options));
    await flush();
    const audio = h.audios[0];
    act(() => audio?.firePlaying());
    act(() => result.current.stop());
    expect(audio?.paused).toBe(true);
    expect(h.revoked).toContain(h.created[0]);
    expect(h.synthCalls[0]?.signal.aborted).toBe(true);
    expect(result.current.snapshot.phase).toBe("canceled");
  });

  it("muting while speaking releases the audio and does not re-synthesize on unmute", async () => {
    const h = harness();
    const { result, rerender } = renderHook(() => useAssistantSpeech(h.options));
    await flush();
    const audio = h.audios[0];
    act(() => audio?.firePlaying());
    act(() => result.current.setMuted(true));
    expect(audio?.paused).toBe(true);
    expect(h.revoked).toContain(h.created[0]);
    expect(result.current.snapshot.muted).toBe(true);
    // Unmuting the same message must not replay it.
    act(() => result.current.setMuted(false));
    rerender();
    await flush();
    expect(h.synthCalls).toHaveLength(1);
  });

  it("a message that arrives while muted is never spoken", async () => {
    const h = harness({ text: undefined, messageId: undefined });
    const { result, rerender } = renderHook(
      (props: UseAssistantSpeechOptions) => useAssistantSpeech(props),
      { initialProps: h.options },
    );
    await flush();
    act(() => result.current.setMuted(true));
    // The assistant message arrives while the user is muted: it is marked seen but never synthesized.
    rerender({ ...h.options, text: "An answer while muted.", messageId: "m1" });
    await flush();
    expect(h.synthCalls).toHaveLength(0);
    // Unmuting that same message must not retroactively speak it.
    act(() => result.current.setMuted(false));
    rerender({ ...h.options, text: "An answer while muted.", messageId: "m1" });
    await flush();
    expect(h.synthCalls).toHaveLength(0);
  });

  it("switching to a new assistant message tears down the previous turn and speaks the new text", async () => {
    const h = harness();
    const { rerender } = renderHook(
      (props: UseAssistantSpeechOptions) => useAssistantSpeech(props),
      {
        initialProps: h.options,
      },
    );
    await flush();
    act(() => h.audios[0]?.firePlaying());
    rerender({ ...h.options, text: "A different, newer answer.", messageId: "m2" });
    await flush();
    // The previous audio and URL were released, the previous fetch aborted...
    expect(h.audios[0]?.paused).toBe(true);
    expect(h.revoked).toContain(h.created[0]);
    expect(h.synthCalls[0]?.signal.aborted).toBe(true);
    // ...and the new visible text is synthesized.
    expect(h.synthCalls).toHaveLength(2);
    expect(h.synthCalls[1]?.text).toBe("A different, newer answer.");
  });

  it("unmounting releases the audio, revokes the URL, and aborts the fetch", async () => {
    const h = harness();
    const { unmount } = renderHook(() => useAssistantSpeech(h.options));
    await flush();
    const audio = h.audios[0];
    act(() => audio?.firePlaying());
    unmount();
    expect(audio?.paused).toBe(true);
    expect(h.revoked).toContain(h.created[0]);
    expect(h.synthCalls[0]?.signal.aborted).toBe(true);
  });

  it("pause and resume drive the audio element and the lifecycle", async () => {
    const h = harness();
    const { result } = renderHook(() => useAssistantSpeech(h.options));
    await flush();
    const audio = h.audios[0];
    act(() => audio?.firePlaying());
    act(() => result.current.pause());
    expect(audio?.paused).toBe(true);
    expect(result.current.snapshot.phase).toBe("paused");
    const playsBefore = audio?.playCount ?? 0;
    act(() => result.current.resume());
    expect(audio?.playCount).toBe(playsBefore + 1);
    expect(result.current.snapshot.phase).toBe("speaking");
  });

  it("interrupt releases resources and transitions to interrupted", async () => {
    const h = harness();
    const { result } = renderHook(() => useAssistantSpeech(h.options));
    await flush();
    const audio = h.audios[0];
    act(() => audio?.firePlaying());
    act(() => result.current.interrupt(900));
    expect(audio?.paused).toBe(true);
    expect(h.revoked).toContain(h.created[0]);
    expect(h.synthCalls[0]?.signal.aborted).toBe(true);
    expect(result.current.snapshot.phase).toBe("interrupted");
  });

  it("toggleMute mutes the snapshot and releases an active turn", async () => {
    const h = harness();
    const { result } = renderHook(() => useAssistantSpeech(h.options));
    await flush();
    const audio = h.audios[0];
    act(() => audio?.firePlaying());
    expect(result.current.snapshot.muted).toBe(false);
    act(() => result.current.toggleMute());
    expect(result.current.snapshot.muted).toBe(true);
    expect(audio?.paused).toBe(true);
    expect(h.revoked).toContain(h.created[0]);
  });
});

describe("useAssistantSpeech — failure degrades to text (AC4)", () => {
  it("maps a provider error to a failed turn without throwing", async () => {
    const h = harness({
      synthesize: (text, signal) => {
        void text;
        void signal;
        return Promise.reject(new ApiError("VOICE_PROVIDER_ERROR", "provider failed", 502));
      },
    });
    const { result } = renderHook(() => useAssistantSpeech(h.options));
    await flush();
    expect(result.current.snapshot.phase).toBe("failed");
    expect(result.current.snapshot.failureKind).toBe("provider-error");
  });

  it("maps a rate-limit error to the rate-limited failure kind", async () => {
    const h = harness({
      synthesize: () => Promise.reject(new ApiError("VOICE_RATE_LIMITED", "rate limited", 429)),
    });
    const { result } = renderHook(() => useAssistantSpeech(h.options));
    await flush();
    expect(result.current.snapshot.phase).toBe("failed");
    expect(result.current.snapshot.failureKind).toBe("rate-limited");
  });

  it("an audio element error fails the turn and releases the URL", async () => {
    const h = harness();
    const { result } = renderHook(() => useAssistantSpeech(h.options));
    await flush();
    const audio = h.audios[0];
    act(() => audio?.fireError());
    expect(result.current.snapshot.phase).toBe("failed");
    expect(result.current.snapshot.failureKind).toBe("internal");
    expect(h.revoked).toContain(h.created[0]);
  });

  it("a blocked autoplay (play rejects) fails the turn and releases the URL", async () => {
    const audios: FakeAudio[] = [];
    const h = harness({
      createAudio: () => {
        const audio = new FakeAudio();
        audio.play = (): Promise<void> => Promise.reject(new Error("autoplay blocked"));
        audios.push(audio);
        return audio;
      },
    });
    const { result } = renderHook(() => useAssistantSpeech(h.options));
    await flush();
    expect(result.current.snapshot.phase).toBe("failed");
    expect(result.current.snapshot.failureKind).toBe("internal");
    expect(h.revoked).toContain(h.created[0]);
  });

  it("ignores a synthesis result that resolves after the turn was stopped", async () => {
    let resolveSynth: ((value: { audio: string; mimeType: string }) => void) | undefined;
    const h = harness({
      synthesize: (_text, signal) => {
        return new Promise((resolve) => {
          resolveSynth = resolve;
          void signal;
        });
      },
    });
    const { result } = renderHook(() => useAssistantSpeech(h.options));
    expect(result.current.snapshot.phase).toBe("preparing");
    act(() => result.current.stop());
    // The provider answers late; the cancelled turn must not start playback.
    await act(async () => {
      resolveSynth?.({ audio: audioBase64(), mimeType: "audio/mpeg" });
      await Promise.resolve();
    });
    expect(h.audios[0]?.playCount ?? 0).toBe(0);
    expect(result.current.snapshot.phase).toBe("canceled");
  });
});
