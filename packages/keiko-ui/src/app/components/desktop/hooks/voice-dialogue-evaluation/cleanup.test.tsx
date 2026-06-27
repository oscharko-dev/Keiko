// Issue #1563, Epic #1556 — AC3 long-session resource-cleanup proof.
//
// The microphone-lifecycle suite (useVoiceDialogueSession.miclifecycle.test.tsx) proves each release
// path in isolation. This suite proves the AGGREGATE long-session property the issue requires: after a
// many-turn dialogue session is stopped and unmounted, NOTHING leaks — every acquired microphone track
// is released, every audio element is torn down, every synthesized object URL is revoked, every timer is
// drained, and no realtime connection was ever opened (the dialogue path is STT+TTS, ADR-0096 D7).
//
// It drives the REAL useVoiceDialogueSession hook through N spoken turns and N spoken answers with all
// media surfaces injected through the production seam contract, captures a single content-free resource
// ledger after teardown, and scores it with the production evaluation engine (scoreDialogueCleanup). The
// ledger is the leak detector: if any release path regressed, the acquire/release counts diverge and the
// dimension fails. Each counter equals N, so a silently-skipped turn is caught too.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCapabilityResolution } from "@/lib/types";
import type { DictationRecorder, DictationSession } from "../dictation-recorder";
import type { AssistantSpeechAudioElement } from "../useAssistantSpeech";
import {
  useVoiceDialogueSession,
  type DialogueChatSession,
  type UseVoiceDialogueSessionOptions,
} from "../useVoiceDialogueSession";
import { scoreDialogueCleanup, type DialogueCleanupObservation } from "./index";

const PERSONAS = ["male", "female", "neutral"] as const;

const FULL_REALTIME_NO_WEBRTC: VoiceCapabilityResolution = {
  available: true,
  profile: "full-realtime",
  capabilities: { speechToText: true, speechOutput: true, realtimeVoice: true },
  transport: { websocketControl: true, webrtcMedia: false },
  availableVoicePersonas: PERSONAS,
};

// ─── Instrumented resource ledger ─────────────────────────────────────────────────────────────────
interface ResourceLedger {
  micAcquired: number;
  micReleased: number;
  audioCreated: number;
  audioReleased: number;
  urlsCreated: number;
  urlsRevoked: number;
  rtcOpened: number;
}

// An audio element that counts its teardown: production pauses it and clears `src` to "" on teardown, so
// a transition of `src` back to empty after it was set is one release.
class CountingAudio implements AssistantSpeechAudioElement {
  private innerSrc = "";
  muted = false;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(private readonly ledger: ResourceLedger) {}
  get src(): string {
    return this.innerSrc;
  }
  set src(value: string) {
    if (value === "" && this.innerSrc !== "") {
      this.ledger.audioReleased += 1;
    }
    this.innerSrc = value;
  }
  play(): Promise<void> {
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

// A recorder whose every start() acquires one microphone and returns a session that releases exactly
// once (mirrors track.stop() being idempotent). stop() and cancel() are mutually exclusive per turn.
function makeCountingRecorder(ledger: ResourceLedger): DictationRecorder {
  return {
    start: async (): Promise<DictationSession> => {
      ledger.micAcquired += 1;
      let released = false;
      const release = (): void => {
        if (!released) {
          released = true;
          ledger.micReleased += 1;
        }
      };
      return {
        stop: async () => {
          release();
          return { audioBase64: "AAAA", mimeType: "audio/webm", durationMs: 120 };
        },
        cancel: () => {
          release();
        },
      };
    },
  };
}

function makeChatSession(): DialogueChatSession {
  return {
    sendStatus: "idle",
    sending: false,
    sendMessage: vi.fn(async () => {}),
    cancelSend: vi.fn(),
  };
}

interface Harness {
  readonly baseOptions: UseVoiceDialogueSessionOptions;
  readonly ledger: ResourceLedger;
  readonly audios: CountingAudio[];
}

function buildHarness(): Harness {
  const ledger: ResourceLedger = {
    micAcquired: 0,
    micReleased: 0,
    audioCreated: 0,
    audioReleased: 0,
    urlsCreated: 0,
    urlsRevoked: 0,
    rtcOpened: 0,
  };
  const audios: CountingAudio[] = [];
  const recorder = makeCountingRecorder(ledger);
  const baseOptions: UseVoiceDialogueSessionOptions = {
    capability: FULL_REALTIME_NO_WEBRTC,
    active: true,
    persona: "neutral",
    session: makeChatSession(),
    answerText: undefined,
    answerId: undefined,
    onLeave: vi.fn(),
    createRecorder: () => recorder,
    transcribe: vi.fn(async () => ({ transcript: "run the pipeline" })),
    synthesize: vi.fn(async () => ({ audio: btoa("AUDIO"), mimeType: "audio/mpeg" })),
    createAudio: () => {
      ledger.audioCreated += 1;
      const audio = new CountingAudio(ledger);
      audios.push(audio);
      return audio;
    },
    createObjectUrl: () => {
      ledger.urlsCreated += 1;
      return `blob:dialogue-${ledger.urlsCreated}`;
    },
    revokeObjectUrl: () => {
      ledger.urlsRevoked += 1;
    },
  };
  return { baseOptions, ledger, audios };
}

const flush = (): Promise<void> => Promise.resolve();

beforeEach(() => {
  // Fake ONLY the timer APIs the dialogue path uses (the dictation auto-stop setTimeout), so
  // vi.getTimerCount() reports dialogue timer leaks precisely while React's MessageChannel-based
  // scheduler — and @testing-library's async act — keep running on real time.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal(
    "Blob",
    class {
      constructor(
        public readonly parts: unknown[],
        public readonly options?: { type?: string },
      ) {}
    },
  );
  vi.stubGlobal("MediaRecorder", class {});
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Run one spoken turn: tap to start capture (acquire mic), tap again to stop (release mic → transcribe
// → preview → user-end-of-turn → send).
async function runSpokenTurn(result: { current: { onListen: () => void } }): Promise<void> {
  await act(async () => {
    result.current.onListen();
    await flush();
  });
  await act(async () => {
    result.current.onListen();
    await flush();
    await flush();
    await flush();
  });
}

describe("AC3 — long-session cleanup leaves no resource leak", () => {
  it("runs an 8-turn dialogue then stops + unmounts with a fully balanced resource ledger", async () => {
    const turns = 8;
    const rtcCounter = { count: 0 };
    vi.stubGlobal(
      "RTCPeerConnection",
      class {
        constructor() {
          rtcCounter.count += 1;
        }
      },
    );

    const h = buildHarness();
    const { result, rerender, unmount } = renderHook(
      (props: UseVoiceDialogueSessionOptions) => useVoiceDialogueSession(props),
      { initialProps: h.baseOptions },
    );

    for (let turn = 1; turn <= turns; turn += 1) {
      await runSpokenTurn(result);
      // The assistant answers: a new settled message triggers synthesis → one audio element + one URL.
      // Switching the message tears down the previous answer's audio + URL.
      await act(async () => {
        rerender({ ...h.baseOptions, answerText: `Answer ${turn}`, answerId: `m${turn}` });
        await flush();
        await flush();
        await flush();
        await flush();
      });
      await act(async () => {
        h.audios.at(-1)?.firePlaying();
        h.audios.at(-1)?.fireEnded();
        await flush();
      });
    }

    // The dialogue is no longer capturing between turns (the floor advanced past listening).
    expect(result.current.listening).toBe(false);

    // Stop the session (master teardown) and then unmount (idempotent second teardown).
    act(() => result.current.onStop());
    unmount();

    h.ledger.rtcOpened = rtcCounter.count;

    const observation: DialogueCleanupObservation = {
      micAcquired: h.ledger.micAcquired,
      micReleased: h.ledger.micReleased,
      audioElementsCreated: h.ledger.audioCreated,
      audioElementsReleased: h.ledger.audioReleased,
      objectUrlsCreated: h.ledger.urlsCreated,
      objectUrlsRevoked: h.ledger.urlsRevoked,
      pendingTimers: vi.getTimerCount(),
      realtimeConnectionsOpened: h.ledger.rtcOpened,
    };

    // Every turn actually ran (no silent skip), and every resource class balances.
    expect(observation.micAcquired).toBe(turns);
    expect(observation.audioElementsCreated).toBe(turns);
    expect(observation.objectUrlsCreated).toBe(turns);

    const result2 = scoreDialogueCleanup(observation);
    expect(result2).toMatchObject({
      micBalanced: true,
      audioBalanced: true,
      objectUrlsBalanced: true,
      timersDrained: true,
      noRealtimeConnection: true,
      outcome: "pass",
    });
  });

  it("never opens a realtime (WebRTC) connection on the dialogue path", async () => {
    const rtcCounter = { count: 0 };
    vi.stubGlobal(
      "RTCPeerConnection",
      class {
        constructor() {
          rtcCounter.count += 1;
        }
      },
    );
    const h = buildHarness();
    const { result, rerender, unmount } = renderHook(
      (props: UseVoiceDialogueSessionOptions) => useVoiceDialogueSession(props),
      { initialProps: h.baseOptions },
    );
    await runSpokenTurn(result);
    await act(async () => {
      rerender({ ...h.baseOptions, answerText: "Answer", answerId: "m1" });
      await flush();
      await flush();
    });
    unmount();
    expect(rtcCounter.count).toBe(0);
  });
});
