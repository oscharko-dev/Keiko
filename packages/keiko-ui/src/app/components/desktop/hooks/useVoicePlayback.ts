// Issue #501, Epic #491 — React binding for the assistant speech-output playback controller.
//
// `useVoicePlayback` owns a single `createVoicePlaybackController` instance for the resolved voice
// profile and mirrors its content-free snapshot into React state, so the presentational `VoicePlayback`
// components render from a stable, deterministic source. It NEVER touches audio, a provider, or a
// credential: the controller it drives is a pure reducer, and the optional `turnManager` binding only
// forwards content-free turn-notification signals (AC2). In the currently deployed STT-only environment
// the resolved profile is not playback-capable, so the controller is dormant in `unavailable` and the
// hook returns an inert snapshot — the composer stays clean and fully text-capable (AC1).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VoiceProfile } from "@/lib/types";
import type { VoiceTurnManagerEngine } from "./voice-turn-manager";
import {
  type VoicePlaybackCommand,
  type VoicePlaybackController,
  type VoicePlaybackFailureKind,
  type VoicePlaybackSnapshot,
  createVoicePlaybackController,
  forwardVoicePlaybackToTurnManager,
} from "./voice-playback-state";

export interface UseVoicePlaybackOptions {
  // The effective voice profile resolved by `useVoiceCapability`. A non-playback profile (`none`,
  // `speech-to-text`) yields a dormant controller (AC1).
  readonly profile: VoiceProfile;
  // "replay if permitted": whether deployment policy allows replaying a settled spoken response.
  readonly replayAllowed?: boolean | undefined;
  // Optional #499 turn manager to receive assistant-speech and interruption state changes (AC2). The
  // render-path wiring of a live turn manager is owned by later issues; the binding is injectable so the
  // integration is exercised deterministically without a live conversation.
  readonly turnManager?: VoiceTurnManagerEngine | undefined;
}

export interface VoicePlaybackBinding {
  readonly snapshot: VoicePlaybackSnapshot;
  // User controls (Deliverable: interrupt / stop / mute / replay).
  readonly toggleMute: () => void;
  readonly setMuted: (muted: boolean) => void;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly stop: () => void;
  readonly interrupt: (atMs?: number) => void;
  readonly replay: () => void;
  // Provider / lifecycle drivers (called by the audio integration when it lands; kept here so the whole
  // lifecycle is reachable from one binding).
  readonly prepare: () => void;
  readonly playStarted: () => void;
  readonly complete: () => void;
  readonly fail: (failure: VoicePlaybackFailureKind) => void;
  readonly reset: () => void;
}

export function useVoicePlayback(options: UseVoicePlaybackOptions): VoicePlaybackBinding {
  const { profile, replayAllowed, turnManager } = options;

  // One controller per (profile, replayAllowed). Re-created only when those change, mirroring the
  // memoized controller construction in `useRealtimeVoice`.
  const controller: VoicePlaybackController = useMemo(
    () => createVoicePlaybackController({ profile, replayAllowed }),
    [profile, replayAllowed],
  );

  const [snapshot, setSnapshot] = useState<VoicePlaybackSnapshot>(() => controller.snapshot());

  // Keep the latest snapshot in sync when the controller identity changes (profile switch).
  useEffect(() => {
    setSnapshot(controller.snapshot());
  }, [controller]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    (command: VoicePlaybackCommand) => {
      const result = controller.dispatch(command);
      if (turnManager !== undefined) {
        forwardVoicePlaybackToTurnManager(result, turnManager);
      }
      if (mountedRef.current) {
        setSnapshot(result.snapshot);
      }
    },
    [controller, turnManager],
  );

  const toggleMute = useCallback(() => {
    run({ kind: "set-muted", muted: !controller.snapshot().muted });
  }, [controller, run]);

  const setMuted = useCallback((muted: boolean) => run({ kind: "set-muted", muted }), [run]);
  const pause = useCallback(() => run({ kind: "pause" }), [run]);
  const resume = useCallback(() => run({ kind: "resume" }), [run]);
  const stop = useCallback(() => run({ kind: "stop" }), [run]);
  const interrupt = useCallback((atMs?: number) => run({ kind: "interrupt", atMs }), [run]);
  const replay = useCallback(() => run({ kind: "replay" }), [run]);
  const prepare = useCallback(() => run({ kind: "prepare" }), [run]);
  const playStarted = useCallback(() => run({ kind: "play-started" }), [run]);
  const complete = useCallback(() => run({ kind: "complete" }), [run]);
  const fail = useCallback(
    (failure: VoicePlaybackFailureKind) => run({ kind: "fail", failure }),
    [run],
  );
  const reset = useCallback(() => {
    controller.reset();
    if (mountedRef.current) {
      setSnapshot(controller.snapshot());
    }
  }, [controller]);

  return {
    snapshot,
    toggleMute,
    setMuted,
    pause,
    resume,
    stop,
    interrupt,
    replay,
    prepare,
    playStarted,
    complete,
    fail,
    reset,
  };
}
