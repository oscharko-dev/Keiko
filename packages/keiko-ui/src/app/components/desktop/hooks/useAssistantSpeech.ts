// Issue #1558, Epic #1556 (ADR-0095) — the audio integration that makes the assistant speech-output
// playback controller actually speak. It wraps the deterministic `useVoicePlayback` reducer (Issue
// #501) and adds the missing piece that issue deferred: a provider-driven audio engine. When the
// deployment advertises speech output and a fresh, COMPLETE assistant message is visible in the
// transcript, this hook synthesizes that exact text through the BFF synthesis route, plays the
// returned audio through a single HTMLAudioElement, and drives the reducer through its
// prepare → play-started → complete / fail lifecycle.
//
// The spoken output cannot diverge from the visible text (AC2): the synthesis input is the assistant
// message's rendered `content`, keyed by its stable message id, so a turn is spoken at most once and
// always speaks the text the reader sees. Stopping, muting, unmounting, or switching sessions releases
// the audio element, revokes the object URL, and aborts any pending synthesis fetch (AC3). A provider
// or playback failure transitions the reducer to `failed`, which renders the "shown as text" fallback
// while the written answer stays untouched (AC4). The hook holds no credential and never persists the
// synthesized audio: the object URL lives only for the duration of one spoken turn.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VoicePersona } from "@oscharko-dev/keiko-contracts";
import type { VoiceProfile } from "@/lib/types";
import { ApiError, synthesizeAssistantSpeech, type VoiceSpeechResult } from "@/lib/api";
import { decodeBase64ArrayBuffer } from "@/lib/bytes";
import type { VoiceTurnManagerEngine } from "./voice-turn-manager";
import { useVoicePlayback, type VoicePlaybackBinding } from "./useVoicePlayback";
import type { VoicePlaybackFailureKind } from "./voice-playback-state";
import {
  createBrowserAssistantSpeechStreamingSink,
  type AssistantSpeechStreamingSink,
} from "./assistant-speech-streaming";

type CurrentRef<T> = { current: T };

// The minimal audio-element surface the engine drives. `HTMLAudioElement` satisfies it structurally,
// so production passes `new Audio()`; tests inject a controllable fake without a real media element.
export interface AssistantSpeechAudioElement {
  src: string;
  muted: boolean;
  play: () => Promise<void> | void;
  pause: () => void;
  onplaying: (() => void) | null;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

export interface UseAssistantSpeechOptions {
  // The effective voice profile resolved by `useVoiceCapability`. A non-playback profile yields a
  // dormant controller and the engine never runs (AC1).
  readonly profile: VoiceProfile;
  // Whether the deployment advertises speech output (the same gate that renders the controls). When
  // false the engine is inert and no synthesis is ever requested.
  readonly enabled: boolean;
  // The exact visible text of the latest COMPLETE assistant message, or undefined while none is
  // settled. This is the only text ever synthesized, so the spoken answer matches the transcript (AC2).
  readonly text: string | undefined;
  // The stable id of that assistant message. A turn is spoken once per (id), so re-renders, mute
  // toggles, and autoscroll never re-trigger synthesis.
  readonly messageId: string | undefined;
  // "replay if permitted": whether deployment policy allows replaying a settled spoken response.
  readonly replayAllowed?: boolean | undefined;
  // Issue #1559 — the selected product voice persona to speak with, when the deployment offers a choice.
  // Content-free: it is forwarded to the BFF synthesis route, which resolves the voice id; the browser
  // never sees a voice id. Undefined keeps the provider-default voice (existing callers unchanged).
  readonly persona?: VoicePersona | undefined;
  // Optional #499 turn manager to receive assistant-speech and interruption signals (AC2).
  readonly turnManager?: VoiceTurnManagerEngine | undefined;
  // Test seams. Production uses the BFF synthesis client, `new Audio()`, and the URL object-store.
  readonly synthesize?:
    ((text: string, signal: AbortSignal) => Promise<VoiceSpeechResult>) | undefined;
  readonly createAudio?: (() => AssistantSpeechAudioElement) | undefined;
  readonly createObjectUrl?: ((blob: Blob) => string) | undefined;
  readonly revokeObjectUrl?: ((url: string) => void) | undefined;
  // Optional streamed-PCM playback sink (AudioWorklet). When it engages, audio starts on the first
  // chunk and barge-in is sub-frame; when it is unavailable (no WebAudio, e.g. under test) or fails up
  // front, the engine falls back to the buffered <audio> path below. Tests inject a fake sink.
  readonly createStreamingSink?: (() => AssistantSpeechStreamingSink | undefined) | undefined;
}

// Builds the default BFF synthesis seam bound to the current persona. A persona is included in the
// request only when one is selected (Issue #1559); omitting it preserves the provider-default voice for
// callers that do not offer a persona choice.
function makeDefaultSynthesize(
  persona: VoicePersona | undefined,
): (text: string, signal: AbortSignal) => Promise<VoiceSpeechResult> {
  return (text, signal) =>
    synthesizeAssistantSpeech(persona === undefined ? { text } : { text, persona }, signal);
}

function defaultCreateAudio(): AssistantSpeechAudioElement {
  // HTMLAudioElement satisfies this surface at runtime; the only difference is that its event handlers
  // accept a wider `(event) => ...` signature than the zero-argument handlers the engine assigns, which
  // is assignment-compatible at runtime. The cast keeps the test seam's handler type simple to call.
  return new Audio() as unknown as AssistantSpeechAudioElement;
}

function defaultCreateObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

function defaultRevokeObjectUrl(url: string): void {
  URL.revokeObjectURL(url);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

// Maps a synthesis failure to a content-free playback failure kind. The BFF returns coded, secret-free
// envelopes (VOICE_RATE_LIMITED / VOICE_TIMEOUT / VOICE_UNAVAILABLE / VOICE_PROVIDER_ERROR); anything
// else — including a blocked autoplay or a decode error — is an internal failure. Either way the
// written answer stays visible (AC4).
function failureFromError(error: unknown): VoicePlaybackFailureKind {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "VOICE_RATE_LIMITED":
        return "rate-limited";
      case "VOICE_TIMEOUT":
        return "timeout";
      case "VOICE_UNAVAILABLE":
        return "unavailable";
      default:
        return "provider-error";
    }
  }
  return "internal";
}

interface HandledTurn {
  readonly id: string | undefined;
  readonly nonce: number;
}

// Wires the buffered <audio> element's terminal event handlers for one synthesis turn. Hoisted out of
// the effect (rather than left as inline closures on `.then`) to keep function nesting under the
// S2004 limit; `cancelledRef` is read at fire time, not at attachment time, so a turn cancelled after
// attachment (effect re-run / unmount / stop) still short-circuits the handler.
function attachBufferedAudioHandlers(
  audio: AssistantSpeechAudioElement,
  playbackRef: CurrentRef<VoicePlaybackBinding>,
  teardown: () => void,
  cancelledRef: CurrentRef<boolean>,
): void {
  audio.onplaying = (): void => {
    if (!cancelledRef.current) {
      playbackRef.current.playStarted();
    }
  };
  audio.onended = (): void => {
    if (!cancelledRef.current) {
      playbackRef.current.complete();
      teardown();
    }
  };
  audio.onerror = (): void => {
    if (!cancelledRef.current) {
      playbackRef.current.fail("internal");
      teardown();
    }
  };
}

// Starts buffered playback and routes a blocked/failed `play()` (e.g. an autoplay policy) through the
// same failure path as a decode or provider error. Extracted alongside `attachBufferedAudioHandlers`
// for the same nesting reason.
function playBufferedAudio(
  audio: AssistantSpeechAudioElement,
  playbackRef: CurrentRef<VoicePlaybackBinding>,
  teardown: () => void,
  cancelledRef: CurrentRef<boolean>,
): Promise<void> {
  return Promise.resolve(audio.play()).catch((error: unknown) => {
    if (!cancelledRef.current && !isAbortError(error)) {
      playbackRef.current.fail("internal");
      teardown();
    }
  });
}

export function useAssistantSpeech(options: UseAssistantSpeechOptions): VoicePlaybackBinding {
  const { profile, enabled, text, messageId, replayAllowed, turnManager, persona } = options;

  const playback = useVoicePlayback({ profile, replayAllowed, turnManager });

  // Keep the latest binding and seams in refs so the engine effect and the stable control callbacks
  // read current values without listing them as dependencies (which would churn the effect).
  const playbackRef = useRef<VoicePlaybackBinding>(playback);
  playbackRef.current = playback;
  // The default seam is rebuilt when the persona changes so the next synthesized turn speaks with the
  // newly selected voice; an explicit test seam (options.synthesize) always wins.
  const synthesizeRef = useRef(options.synthesize ?? makeDefaultSynthesize(persona));
  synthesizeRef.current = options.synthesize ?? makeDefaultSynthesize(persona);
  const createAudioRef = useRef(options.createAudio ?? defaultCreateAudio);
  createAudioRef.current = options.createAudio ?? defaultCreateAudio;
  const createUrlRef = useRef(options.createObjectUrl ?? defaultCreateObjectUrl);
  createUrlRef.current = options.createObjectUrl ?? defaultCreateObjectUrl;
  const revokeUrlRef = useRef(options.revokeObjectUrl ?? defaultRevokeObjectUrl);
  revokeUrlRef.current = options.revokeObjectUrl ?? defaultRevokeObjectUrl;

  const audioRef = useRef<AssistantSpeechAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);
  const handledRef = useRef<HandledTurn>({ id: undefined, nonce: 0 });
  const [replayNonce, setReplayNonce] = useState(0);

  // Created once: the streamed-PCM sink, or undefined when WebAudio/AudioWorklet is unavailable (e.g.
  // under test) — in which case the engine always uses the buffered path below.
  const streamingSinkInitRef = useRef(false);
  const streamingSinkRef = useRef<AssistantSpeechStreamingSink | undefined>(undefined);
  if (!streamingSinkInitRef.current) {
    streamingSinkInitRef.current = true;
    streamingSinkRef.current = (
      options.createStreamingSink ?? createBrowserAssistantSpeechStreamingSink
    )();
  }
  // Read the current persona inside the engine effect without making it an effect dependency (mirrors
  // the synthesizeRef pattern, so a persona change never re-triggers a turn that handledRef already owns).
  const personaRef = useRef(persona);
  personaRef.current = persona;

  // Releases the audio element, revokes the object URL, and aborts any pending synthesis fetch. Safe to
  // call repeatedly: every reference is cleared and re-checked. This is the single teardown used by the
  // effect cleanup (unmount / message switch) and by the stop / mute / interrupt controls (AC3).
  const teardown = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Flush the streamed-PCM queue immediately (sub-frame barge-in) when one is active.
    streamingSinkRef.current?.stop();
    const audio = audioRef.current;
    if (audio !== null) {
      audio.onplaying = null;
      audio.onended = null;
      audio.onerror = null;
      try {
        audio.pause();
      } catch {
        // ignore — pausing an already-released element is harmless
      }
      audio.src = "";
      audioRef.current = null;
    }
    if (urlRef.current !== null) {
      revokeUrlRef.current(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const available = playback.snapshot.available;

  useEffect(() => {
    const pb = playbackRef.current;
    if (
      !enabled ||
      !available ||
      messageId === undefined ||
      text === undefined ||
      text.trim().length === 0
    ) {
      return;
    }
    // Speak each message once per replay nonce: re-renders, autoscroll, and mute toggles never
    // re-synthesize a message that was already handled.
    if (handledRef.current.id === messageId && handledRef.current.nonce === replayNonce) {
      return;
    }
    const isReplay = handledRef.current.id === messageId;
    handledRef.current = { id: messageId, nonce: replayNonce };
    // Muted records the user's preference for whether a spoken response begins. A message that arrives
    // muted is marked handled but never spoken; an explicit replay speaks regardless.
    if (pb.snapshot.muted && !isReplay) {
      return;
    }

    const cancelledRef: CurrentRef<boolean> = { current: false };
    const controller = new AbortController();
    abortRef.current = controller;
    pb.prepare();

    // The buffered fallback: synthesize the whole clip, then play it through one HTMLAudioElement.
    // `cancelledRef` covers an effect re-run / unmount; `controller.signal.aborted` covers a stop /
    // mute / interrupt that aborted this turn — either way a late provider answer must not start
    // playback.
    const runBuffered = (): void => {
      const audio = createAudioRef.current();
      audio.muted = false;
      audioRef.current = audio;
      Promise.resolve(synthesizeRef.current(text, controller.signal))
        .then((result) => {
          if (cancelledRef.current || controller.signal.aborted) {
            return undefined;
          }
          const blob = new Blob([decodeBase64ArrayBuffer(result.audio)], {
            type: result.mimeType,
          });
          const url = createUrlRef.current(blob);
          urlRef.current = url;
          audio.src = url;
          attachBufferedAudioHandlers(audio, playbackRef, teardown, cancelledRef);
          return playBufferedAudio(audio, playbackRef, teardown, cancelledRef);
        })
        .catch((error: unknown) => {
          if (cancelledRef.current || isAbortError(error)) {
            return;
          }
          playbackRef.current.fail(failureFromError(error));
          teardown();
        });
    };

    const sink = streamingSinkRef.current;
    if (sink === undefined) {
      runBuffered();
    } else {
      // Try the streamed-PCM sink first; if it does not engage (unsupported / failed to start), fall
      // back to the buffered path so a turn is never silently dropped.
      void sink
        .play(
          { text, ...(personaRef.current !== undefined ? { persona: personaRef.current } : {}) },
          controller.signal,
          {
            onStart: (): void => {
              if (!cancelledRef.current) {
                playbackRef.current.playStarted();
              }
            },
            onEnded: (): void => {
              if (!cancelledRef.current) {
                playbackRef.current.complete();
                teardown();
              }
            },
            onError: (): void => {
              if (!cancelledRef.current && !controller.signal.aborted) {
                playbackRef.current.fail("internal");
                teardown();
              }
            },
          },
        )
        .then((engaged) => {
          if (!engaged && !cancelledRef.current && !controller.signal.aborted) {
            runBuffered();
          }
        })
        .catch(() => {
          if (!cancelledRef.current && !controller.signal.aborted) {
            runBuffered();
          }
        });
    }

    return () => {
      cancelledRef.current = true;
      teardown();
    };
  }, [enabled, available, text, messageId, replayNonce, teardown]);

  useEffect(
    () => () => {
      streamingSinkRef.current?.dispose();
      streamingSinkRef.current = undefined;
    },
    [],
  );

  const setMuted = useCallback(
    (muted: boolean) => {
      playbackRef.current.setMuted(muted);
      if (muted) {
        teardown();
        if (playbackRef.current.snapshot.active) {
          playbackRef.current.stop();
        }
      }
    },
    [teardown],
  );

  const toggleMute = useCallback(() => {
    setMuted(!playbackRef.current.snapshot.muted);
  }, [setMuted]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    playbackRef.current.pause();
  }, []);

  const resume = useCallback(() => {
    const audio = audioRef.current;
    if (audio !== null) {
      Promise.resolve(audio.play()).catch(() => {
        // a blocked resume surfaces through the existing failure path on the next tick
      });
    }
    playbackRef.current.resume();
  }, []);

  const stop = useCallback(() => {
    teardown();
    playbackRef.current.stop();
  }, [teardown]);

  const interrupt = useCallback(
    (atMs?: number) => {
      teardown();
      playbackRef.current.interrupt(atMs);
    },
    [teardown],
  );

  const replay = useCallback(() => {
    setReplayNonce((nonce) => nonce + 1);
    playbackRef.current.replay();
  }, []);

  return useMemo<VoicePlaybackBinding>(
    () => ({
      snapshot: playback.snapshot,
      toggleMute,
      setMuted,
      pause,
      resume,
      stop,
      interrupt,
      replay,
      prepare: playback.prepare,
      playStarted: playback.playStarted,
      complete: playback.complete,
      fail: playback.fail,
      reset: playback.reset,
    }),
    [playback, toggleMute, setMuted, pause, resume, stop, interrupt, replay],
  );
}
