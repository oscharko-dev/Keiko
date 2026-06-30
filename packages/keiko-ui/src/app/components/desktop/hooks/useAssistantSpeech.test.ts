// Issue #1558 — the assistant speech-output audio engine. Verifies it synthesizes the exact visible
// assistant text (AC2), plays it through the lifecycle (AC1), releases the audio element / object URL /
// pending fetch on stop, mute, session switch, and unmount (AC3), and degrades to the visible text on a
// provider or playback failure (AC4). A controllable fake audio element and an injected synthesize seam
// keep the test deterministic with no real media element or network.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoicePersona } from "@oscharko-dev/keiko-contracts";
import { ApiError, synthesizeAssistantSpeech } from "@/lib/api";
import {
  useAssistantSpeech,
  type AssistantSpeechAudioElement,
  type UseAssistantSpeechOptions,
} from "./useAssistantSpeech";
import type {
  AssistantSpeechStreamHandlers,
  AssistantSpeechStreamingSink,
} from "./assistant-speech-streaming";

// Issue #1559 persona routing is proved against the REAL production synthesize path: the BFF client
// `synthesizeAssistantSpeech` is mocked so the hook's own `makeDefaultSynthesize(persona)` closure runs
// and we assert the exact wire request it builds. Other suites inject their own `synthesize` seam and
// are unaffected. `ApiError` is preserved for the failure suite.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/api");
  return { ...actual, synthesizeAssistantSpeech: vi.fn() };
});

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

// ─── Issue #1559 — persona routing (authoritative, deterministic proof) ─────────────────────────
//
// ChatWindow wires `persona: voiceDialog.active ? voiceDialog.persona : undefined` into
// `useAssistantSpeech`. These tests verify that the hook correctly forwards the persona into every
// `synthesizeAssistantSpeech` call. They use the injected `synthesize` seam (no network) and a
// FakeAudio so nothing touches the real BFF or HTMLMediaElement — deterministic under jsdom.

describe("useAssistantSpeech — Issue #1559 persona routing", () => {
  const mockedSynthesize = vi.mocked(synthesizeAssistantSpeech);

  beforeEach(() => {
    mockedSynthesize.mockReset();
    mockedSynthesize.mockResolvedValue({ audio: audioBase64(), mimeType: "audio/mpeg" });
  });

  // Options that exercise the REAL production path: NO `synthesize` seam is injected, so the hook
  // builds its own `makeDefaultSynthesize(persona)` closure and calls the (mocked) BFF client
  // `synthesizeAssistantSpeech`. Only the audio element and object-URL are stubbed (jsdom has no media
  // engine). A mutation that drops the persona forwarding therefore fails these assertions.
  function realPathOptions(
    overrides: Partial<UseAssistantSpeechOptions> = {},
  ): UseAssistantSpeechOptions {
    return {
      profile: "speech-output",
      enabled: true,
      text: "The assistant answer.",
      messageId: "msg-persona-1",
      createAudio: () => new FakeAudio(),
      createObjectUrl: () => "blob:persona-test",
      revokeObjectUrl: vi.fn(),
      ...overrides,
    };
  }

  it("forwards the selected persona to synthesizeAssistantSpeech (Issue #1559 AC2 routing)", async () => {
    renderHook(() => useAssistantSpeech(realPathOptions({ persona: "male" })));
    await flush();
    expect(mockedSynthesize).toHaveBeenCalledTimes(1);
    expect(mockedSynthesize).toHaveBeenCalledWith(
      { text: "The assistant answer.", persona: "male" },
      expect.any(AbortSignal),
    );
  });

  it("omits the persona field entirely when no persona is selected (provider-default voice)", async () => {
    renderHook(() => useAssistantSpeech(realPathOptions({ persona: undefined })));
    await flush();
    expect(mockedSynthesize).toHaveBeenCalledTimes(1);
    const request = mockedSynthesize.mock.calls[0]![0];
    expect(request).toEqual({ text: "The assistant answer." });
    expect(request).not.toHaveProperty("persona");
  });

  it("reads the persona fresh on each new turn (mutation-robust)", async () => {
    const { rerender } = renderHook(
      ({ mid, persona }: { mid: string; persona: VoicePersona | undefined }) =>
        useAssistantSpeech(realPathOptions({ messageId: mid, text: "Turn text.", persona })),
      { initialProps: { mid: "msg-a", persona: "female" as VoicePersona | undefined } },
    );
    await flush();
    rerender({ mid: "msg-b", persona: "neutral" });
    await flush();

    expect(mockedSynthesize).toHaveBeenCalledTimes(2);
    expect(mockedSynthesize).toHaveBeenNthCalledWith(
      1,
      { text: "Turn text.", persona: "female" },
      expect.any(AbortSignal),
    );
    expect(mockedSynthesize).toHaveBeenNthCalledWith(
      2,
      { text: "Turn text.", persona: "neutral" },
      expect.any(AbortSignal),
    );
  });
});

function makeFakeStreamingSink(engage: boolean): {
  sink: AssistantSpeechStreamingSink;
  handlers: () => AssistantSpeechStreamHandlers | undefined;
  stops: () => number;
  disposes: () => number;
} {
  let captured: AssistantSpeechStreamHandlers | undefined;
  let stops = 0;
  let disposes = 0;
  return {
    sink: {
      play: (_input, _signal, handlers): Promise<boolean> => {
        captured = handlers;
        return Promise.resolve(engage);
      },
      stop: (): void => {
        stops += 1;
      },
      positionMs: (): number | undefined => undefined,
      dispose: (): void => {
        disposes += 1;
      },
    },
    handlers: () => captured,
    stops: () => stops,
    disposes: () => disposes,
  };
}

describe("useAssistantSpeech — streamed PCM playback", () => {
  it("uses the streaming sink when it engages and drives the playback lifecycle (no buffered work)", async () => {
    const fake = makeFakeStreamingSink(true);
    const h = harness({ createStreamingSink: () => fake.sink });
    const { result } = renderHook(() => useAssistantSpeech(h.options));
    await flush();
    // Streaming took over — the buffered synthesize + audio element are never touched.
    expect(h.synthCalls).toHaveLength(0);
    expect(h.audios).toHaveLength(0);
    expect(result.current.snapshot.phase).toBe("preparing");

    act(() => fake.handlers()?.onStart());
    expect(result.current.snapshot.phase).toBe("speaking");
    act(() => fake.handlers()?.onEnded());
    expect(result.current.snapshot.phase).toBe("complete");
  });

  it("falls back to the buffered path when the streaming sink does not engage", async () => {
    const fake = makeFakeStreamingSink(false);
    const h = harness({ createStreamingSink: () => fake.sink });
    const { result } = renderHook(() => useAssistantSpeech(h.options));
    await flush();
    await flush();
    expect(h.synthCalls).toHaveLength(1);
    expect(h.audios).toHaveLength(1);
    act(() => h.audios[0]?.firePlaying());
    expect(result.current.snapshot.phase).toBe("speaking");
  });

  it("flushes the streaming sink on stop (sub-frame barge-in)", async () => {
    const fake = makeFakeStreamingSink(true);
    const h = harness({ createStreamingSink: () => fake.sink });
    const { result } = renderHook(() => useAssistantSpeech(h.options));
    await flush();
    act(() => fake.handlers()?.onStart());
    act(() => result.current.stop());
    expect(fake.stops()).toBeGreaterThanOrEqual(1);
  });

  it("disposes the streaming sink on unmount", async () => {
    const fake = makeFakeStreamingSink(true);
    const h = harness({ createStreamingSink: () => fake.sink });
    const { unmount } = renderHook(() => useAssistantSpeech(h.options));
    await flush();

    unmount();

    expect(fake.disposes()).toBe(1);
  });
});
