// Issue #502, Epic #491 (ADR-0065) — the Voice ↔ Discussion intelligence binding. It is the
// deterministic, synchronous, content-free seam that lets a SPOKEN turn drive the SAME discussion
// intelligence the text path uses (AC2: reuse, not a parallel stack). It owns no transport, no clock,
// no audio, and no write path: it consumes the leaf contract `discussion-intelligence.ts` exactly as
// the server orchestration (#502 Artifact 2) does, observes the #499 turn manager's content-free
// `VoiceTurnSnapshot` for barge-in / recovery, and reads spoken text ONLY through the committed-only
// boundary `selectCommittedVoiceTranscript`.
//
// Three guarantees are load-bearing.
// (1) TEXT-FIRST DORMANCY (AC1): `voiceCanDriveDiscussion(profile)` gates the binding; for `none` and
//     `speech-output` the binding does zero discussion work — it never selects a mode from a spoken
//     intent and never derives committed input — so Keiko's discussion modes remain fully usable as
//     text without this seam.
// (2) COMMITTED-ONLY INPUT (AC5): spoken text enters discussion ONLY via
//     `selectCommittedVoiceTranscript(segments).text`. Partial, stable, discarded, redacted, and
//     provider-error segments are structurally excluded by the contract projection, so an in-flight or
//     unreviewed transcript can never become discussion input.
// (3) INTERRUPTION RECOVERY WITHOUT CONTEXT LOSS (AC4): when the turn manager reports `interrupted` or
//     `recovering`, the active `DiscussionTurnContext` is moved to `interrupted` (mode / topicId /
//     turnIndex preserved); when `recovering` clears the SAME context is restored to `recovered`. The
//     barge-in → recover round-trip yields an identical mode / topicId / turnIndex.
//
// No new authority (AC: voice adds no authority): the binding never produces a write, a model call, or
// a workflow effect. A spoken "decide → act" intent still flows through the existing governed
// WorkflowHandoff path (#503); routing that intent is OUT OF SCOPE here and the binding deliberately
// has no path to reach it. The visible composer mode-selector render surface is likewise DEFERRED
// (documented seam) — this issue keeps `globals.css` and the visual-regression proofs untouched, the
// same runtime-mechanics posture as #498 / #499 / #500.

import type { VoiceProfile } from "@/lib/types";
import {
  type DiscussionMode,
  type DiscussionModePlan,
  type DiscussionTurnContext,
  type DiscussionTurnStatus,
  type VoiceTranscriptSegment,
  applyDiscussionInterruption,
  applyDiscussionRecovery,
  beginDiscussionTurn,
  discussionModePlan,
  resolveDiscussionTurn,
  selectCommittedVoiceTranscript,
  voiceCanDriveDiscussion,
} from "@oscharko-dev/keiko-contracts";
import type { VoiceTurnSnapshot } from "./voice-turn-manager";

// ─── Spoken discussion intents (semantic, not the wire encoding) ─────────────────
// The small closed set of spoken requests that select a discussion mode. The consuming hook maps these
// from a committed transcript classification or an explicit composer affordance; the binding never sees
// raw text here. Each intent names the discussion mode it requests, which is how the SAME
// `DISCUSSION_MODE_PLANS` contract — not a parallel voice stack — drives behaviour (AC2).
export type VoiceDiscussionIntent =
  | "request-challenge"
  | "request-review"
  | "request-decide"
  | "request-brainstorm"
  | "request-evidence-check";

export const VOICE_DISCUSSION_INTENTS: readonly VoiceDiscussionIntent[] = [
  "request-challenge",
  "request-review",
  "request-decide",
  "request-brainstorm",
  "request-evidence-check",
] as const;

// Total map keyed by intent (an unmapped intent is a compile error). Each intent resolves to exactly one
// `DiscussionMode`, so the binding adds NO mode vocabulary of its own.
const INTENT_TO_MODE: Record<VoiceDiscussionIntent, DiscussionMode> = {
  "request-challenge": "challenge",
  "request-review": "review",
  "request-decide": "decide",
  "request-brainstorm": "brainstorm",
  "request-evidence-check": "evidence-check",
};

export function isVoiceDiscussionIntent(value: unknown): value is VoiceDiscussionIntent {
  return (
    typeof value === "string" && (VOICE_DISCUSSION_INTENTS as readonly string[]).includes(value)
  );
}

// ─── Content-free observer (mirrors the #499 / #500 observers) ───────────────────
// Every field is an enum or an integer; no mode-selection ever leaks text, topic content, or transcript.
// `committedChars` is a character COUNT of the committed projection, never the text itself.
export interface DiscussionVoiceModeEvent {
  readonly mode: DiscussionMode;
  readonly mandatedFacetCount: number;
}

export interface DiscussionVoiceTurnEvent {
  readonly from: DiscussionTurnStatus;
  readonly to: DiscussionTurnStatus;
  readonly turnIndex: number;
}

export interface DiscussionVoiceInputEvent {
  readonly committedChars: number;
  readonly committedSegments: number;
}

export interface DiscussionVoiceObserver {
  onModeSelected?(event: DiscussionVoiceModeEvent): void;
  onTurnStatus?(event: DiscussionVoiceTurnEvent): void;
  onCommittedInput?(event: DiscussionVoiceInputEvent): void;
}

// ─── Construction ────────────────────────────────────────────────────────────────
export interface DiscussionVoiceBindingOptions {
  readonly profile: VoiceProfile;
  readonly observer?: DiscussionVoiceObserver | undefined;
}

// Read-only view for the consuming hook. `active` mirrors `voiceCanDriveDiscussion`; `turn` is the
// active discussion turn context (undefined when none has begun); `selectedMode` is the last mode a
// spoken intent selected.
export interface DiscussionVoiceSnapshot {
  readonly profile: VoiceProfile;
  readonly active: boolean;
  readonly selectedMode: DiscussionMode | undefined;
  readonly turn: DiscussionTurnContext | undefined;
}

export interface DiscussionVoiceBinding {
  // Whether a spoken turn may drive discussion for this profile (AC1 dormancy when false).
  canDrive(): boolean;
  // Map a spoken intent to a discussion mode, returning the contract plan. Dormant profiles return
  // undefined (no mode selected, no observer call) so the text path remains the sole driver.
  selectDiscussionMode(intent: VoiceDiscussionIntent): DiscussionModePlan | undefined;
  // Begin (or restart) the active discussion turn for the currently selected mode. Returns undefined
  // when dormant or before any mode has been selected.
  beginTurn(topicId: string, turnIndex: number): DiscussionTurnContext | undefined;
  // The committed-only spoken text (AC5). Never returns partial / stable / discarded / redacted text.
  committedInput(segments: readonly VoiceTranscriptSegment[]): string;
  // Observe the #499 turn-manager snapshot: interrupt the active discussion turn on barge-in /
  // recovering, restore it (same mode / topicId / turnIndex) when recovering clears (AC4).
  observeTurn(snapshot: VoiceTurnSnapshot): DiscussionTurnContext | undefined;
  // Mark the active discussion turn resolved (terminal). Returns the resolved context, or undefined.
  resolveTurn(): DiscussionTurnContext | undefined;
  snapshot(): DiscussionVoiceSnapshot;
  reset(): void;
}

interface DiscussionVoiceState {
  selectedMode: DiscussionMode | undefined;
  turn: DiscussionTurnContext | undefined;
  // Whether the last observed snapshot reported the turn manager as recovering / interrupted, so the
  // binding can detect the recovering→cleared edge that triggers recovery without a clock.
  interrupted: boolean;
}

function freshState(): DiscussionVoiceState {
  return { selectedMode: undefined, turn: undefined, interrupted: false };
}

// A snapshot interrupts the discussion turn when the turn manager is mid-barge-in or reconnecting.
function snapshotIsInterrupting(snapshot: VoiceTurnSnapshot): boolean {
  return snapshot.state === "interrupted" || snapshot.recovering;
}

export function createDiscussionVoiceBinding(
  options: DiscussionVoiceBindingOptions,
): DiscussionVoiceBinding {
  const { profile } = options;
  const observer = options.observer;
  const active = voiceCanDriveDiscussion(profile);
  let state = freshState();

  function snapshot(): DiscussionVoiceSnapshot {
    return { profile, active, selectedMode: state.selectedMode, turn: state.turn };
  }

  function selectDiscussionMode(intent: VoiceDiscussionIntent): DiscussionModePlan | undefined {
    if (!active) {
      return undefined;
    }
    const mode = INTENT_TO_MODE[intent];
    const plan = discussionModePlan(mode);
    // `selectedMode` reflects the LAST spoken intent — it is the mode the NEXT `beginTurn` will use. It
    // deliberately does NOT retroactively change an in-progress turn's `turn.mode`, which is fixed at
    // `beginTurn` time so an interrupt/recover round-trip preserves the mode the turn started with (AC4).
    state.selectedMode = mode;
    observer?.onModeSelected?.({ mode, mandatedFacetCount: plan.mandatedFacets.length });
    return plan;
  }

  function beginTurn(topicId: string, turnIndex: number): DiscussionTurnContext | undefined {
    if (!active || state.selectedMode === undefined) {
      return undefined;
    }
    const turn = beginDiscussionTurn(state.selectedMode, topicId, turnIndex);
    state.turn = turn;
    state.interrupted = false;
    observer?.onTurnStatus?.({ from: turn.status, to: turn.status, turnIndex: turn.turnIndex });
    return turn;
  }

  function committedInput(segments: readonly VoiceTranscriptSegment[]): string {
    if (!active) {
      return "";
    }
    const projection = selectCommittedVoiceTranscript(segments);
    observer?.onCommittedInput?.({
      committedChars: projection.text.length,
      committedSegments: projection.segmentCount,
    });
    return projection.text;
  }

  // Apply the recovery transition and fire the content-free turn-status observer when the status
  // actually changed (the contract helpers return the input unchanged on an illegal transition).
  function applyTurnTransition(
    next: DiscussionTurnContext,
    previous: DiscussionTurnContext,
  ): DiscussionTurnContext {
    state.turn = next;
    if (next.status !== previous.status) {
      observer?.onTurnStatus?.({
        from: previous.status,
        to: next.status,
        turnIndex: next.turnIndex,
      });
    }
    return next;
  }

  function observeTurn(turnSnapshot: VoiceTurnSnapshot): DiscussionTurnContext | undefined {
    const current = state.turn;
    if (!active || current === undefined) {
      return current;
    }
    const interrupting = snapshotIsInterrupting(turnSnapshot);
    if (interrupting) {
      const next = applyDiscussionInterruption(current);
      // Only latch `interrupted` when the transition actually fired. A barge-in on a terminal
      // (resolved) turn is a no-op (the contract returns the input unchanged), so latching here would
      // spuriously trigger a recovery on the next non-interrupting snapshot. Gate on the real change.
      if (next.status === "interrupted" && next !== current) {
        state.interrupted = true;
      }
      return applyTurnTransition(next, current);
    }
    // The recovering→cleared edge restores the SAME mode / topicId / turnIndex (AC4 no-context-loss).
    if (state.interrupted) {
      state.interrupted = false;
      return applyTurnTransition(applyDiscussionRecovery(current), current);
    }
    return current;
  }

  function resolveTurn(): DiscussionTurnContext | undefined {
    const current = state.turn;
    if (!active || current === undefined) {
      return current;
    }
    return applyTurnTransition(resolveDiscussionTurn(current), current);
  }

  function reset(): void {
    state = freshState();
  }

  return {
    canDrive: (): boolean => active,
    selectDiscussionMode,
    beginTurn,
    committedInput,
    observeTurn,
    resolveTurn,
    snapshot,
    reset,
  };
}
