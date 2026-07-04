// Issue #503, Epic #491 (ADR-0108) — the Voice ↔ Spoken-action-governance binding. It is the
// deterministic, synchronous, content-free seam that lets a SPOKEN turn PROPOSE a governed action while
// guaranteeing voice can never EXECUTE one or bypass any existing gate. It mirrors the #502
// discussion-voice binding exactly: a factory closure with a content-free observer, dormant for
// non-capturing profiles, and reading spoken text ONLY through the committed-only boundary
// `selectCommittedVoiceTranscript`. It owns no transport, no clock, no audio, no crypto, and no write
// path — it consumes the leaf contract `voice-action-intent.ts` exactly as the server governance
// (#503 Artifact 2) does, and observes the #499 turn manager's content-free `VoiceTurnSnapshot` for
// barge-in / turn-advance invalidation.
//
// Four guarantees are load-bearing.
// (1) TEXT-FIRST DORMANCY (AC1): `voiceCanProposeAction(profile)` gates the binding; for `none` and
//     `speech-output` every mutator returns undefined and no observer fires, so the text governance path
//     remains the sole driver and a spoken action is structurally impossible.
// (2) COMMITTED-ONLY INPUT (AC2): a proposal is derived ONLY from
//     `selectCommittedVoiceTranscript(segments)`. Partial, stable, discarded, redacted, and
//     provider-error segments are structurally excluded by the contract projection, so partial text can
//     never become a proposal.
// (3) CONFIRMATION DISCIPLINE (AC3): a mutating / destructive / external-effect / unknown proposal opens
//     `awaiting-confirmation`; `confirm()` only advances when a proposal exists and is non-terminal.
// (4) STALE-INTENT PREVENTION (AC4): the active proposal is bound to the deterministic canonical
//     confirmation string `canonicalizeSpokenActionConfirmation`. A correction that changes the
//     committed text / turnIndex / effectClass changes that string → `applyCommitted` moves the proposal
//     to `superseded`. A barge-in moves it to `interrupted`; a turn advancing past the proposal's
//     turnIndex moves it to `expired`. None of these can silently route stale intent.
//
// No new authority: the binding never produces a write, a model call, or a workflow effect. A confirmed
// proposal still flows through the existing governed WorkflowHandoff path (server Artifact 2); routing is
// OUT OF SCOPE here and the binding deliberately has no path to reach it. The visible confirmation render
// surface is DEFERRED (documented seam) — this issue keeps `globals.css` and the visual-regression
// proofs untouched, the same runtime-mechanics posture as #498 / #499 / #500 / #502.

import type { VoiceProfile } from "@/lib/types";
import {
  type SpokenActionEffectClass,
  type SpokenActionProposal,
  type SpokenActionState,
  type VoiceTranscriptSegment,
  type VoiceTranscriptSource,
  canTransitionSpokenAction,
  canonicalizeSpokenActionConfirmation,
  isTerminalSpokenActionState,
  normalizeSpokenActionProposal,
  selectCommittedVoiceTranscript,
  voiceCanProposeAction,
} from "@oscharko-dev/keiko-contracts";
import type { VoiceTurnSnapshot } from "./voice-turn-manager";

// ─── Content-free observer (mirrors the #499 / #500 / #502 observers) ─────────────
// Every field is an enum or an integer; no event field carries committed text, a digest, or transcript.
// `committedChars` is a character COUNT of the committed projection, never the text itself.
export interface VoiceActionIntentProposedEvent {
  readonly effectClass: SpokenActionEffectClass;
  readonly requiresConfirmation: boolean;
  readonly committedChars: number;
  readonly committedSegments: number;
}

export interface VoiceActionIntentStateEvent {
  readonly from: SpokenActionState;
  readonly to: SpokenActionState;
  readonly turnIndex: number;
}

export interface VoiceActionIntentObserver {
  onProposed?(event: VoiceActionIntentProposedEvent): void;
  onStateChange?(event: VoiceActionIntentStateEvent): void;
}

// ─── Construction ────────────────────────────────────────────────────────────────
export interface VoiceActionIntentBindingOptions {
  readonly profile: VoiceProfile;
  readonly observer?: VoiceActionIntentObserver | undefined;
}

// Read-only view for the consuming hook. `active` mirrors `voiceCanProposeAction`; `proposal` is the
// active normalized proposal (undefined when none is open); `state` is its current lifecycle state.
export interface VoiceActionIntentSnapshot {
  readonly profile: VoiceProfile;
  readonly active: boolean;
  readonly proposal: SpokenActionProposal | undefined;
  readonly state: SpokenActionState | undefined;
}

export interface VoiceActionIntentBinding {
  // Whether a spoken turn may propose an action for this profile (AC1 dormancy when false).
  canPropose(): boolean;
  // Normalize a committed transcript into a proposal (AC2 committed-only). Returns undefined when
  // dormant or when the committed projection carries no text. Replaces any prior active proposal.
  propose(
    segments: readonly VoiceTranscriptSegment[],
    turnIndex: number,
    source: VoiceTranscriptSource,
  ): SpokenActionProposal | undefined;
  // Explicitly confirm a confirmation-requiring proposal (AC3): awaiting-confirmation → confirmed.
  // Returns the new state, or undefined when there is no confirmable proposal.
  confirm(): SpokenActionState | undefined;
  // Cancel a non-terminal proposal. Returns the new state, or undefined when none is active.
  cancel(): SpokenActionState | undefined;
  // Re-run the committed projection against a corrected/extended transcript (AC4). When the canonical
  // confirmation binding changes, the active proposal is superseded. Returns the resulting state.
  applyCommitted(segments: readonly VoiceTranscriptSegment[]): SpokenActionState | undefined;
  // Observe the #499 turn-manager snapshot: a barge-in interrupts the proposal; a turn advancing past
  // the proposal's turnIndex expires it (AC4). Returns the resulting state, or undefined when none.
  observeTurn(snapshot: VoiceTurnSnapshot): SpokenActionState | undefined;
  snapshot(): VoiceActionIntentSnapshot;
  reset(): void;
}

// The active proposal travels with its current lifecycle state and canonical confirmation binding as one
// object, so narrowing `active !== undefined` narrows all three together (no defensive re-checks).
interface ActiveVoiceAction {
  readonly proposal: SpokenActionProposal;
  state: SpokenActionState;
  // The canonical confirmation string, retained so a correction can be detected as a binding change
  // without re-storing the committed text on the binding itself.
  readonly binding: string;
}

// A snapshot interrupts the proposal when the turn manager is mid-barge-in or reconnecting.
function snapshotIsInterrupting(snapshot: VoiceTurnSnapshot): boolean {
  return snapshot.state === "interrupted" || snapshot.recovering;
}

export function createVoiceActionIntentBinding(
  options: VoiceActionIntentBindingOptions,
): VoiceActionIntentBinding {
  const { profile } = options;
  const observer = options.observer;
  const canPropose = voiceCanProposeAction(profile);
  let action: ActiveVoiceAction | undefined;

  function snapshot(): VoiceActionIntentSnapshot {
    return {
      profile,
      active: canPropose,
      proposal: action?.proposal,
      state: action?.state,
    };
  }

  // Move the active proposal to a new lifecycle state, firing the content-free observer only when the
  // transition is legal and actually changes the state. Illegal transitions (e.g. invalidating a
  // terminal proposal) are no-ops that leave the binding untouched.
  function transition(current: ActiveVoiceAction, to: SpokenActionState): SpokenActionState {
    const from = current.state;
    if (from === to || !canTransitionSpokenAction(from, to)) {
      return from;
    }
    current.state = to;
    observer?.onStateChange?.({ from, to, turnIndex: current.proposal.turnIndex });
    return to;
  }

  function propose(
    segments: readonly VoiceTranscriptSegment[],
    turnIndex: number,
    source: VoiceTranscriptSource,
  ): SpokenActionProposal | undefined {
    if (!canPropose) {
      return undefined;
    }
    const projection = selectCommittedVoiceTranscript(segments);
    const proposal = normalizeSpokenActionProposal(projection, profile, turnIndex, source);
    if (proposal === undefined) {
      return undefined;
    }
    // A prior non-terminal proposal is ending: emit its terminal `superseded` transition before
    // installing the new one, so a lifecycle observer never sees a live proposal silently vanish.
    if (action !== undefined && !isTerminalSpokenActionState(action.state)) {
      transition(action, "superseded");
    }
    action = {
      proposal,
      state: proposal.state,
      binding: canonicalizeSpokenActionConfirmation(proposal.confirmationInput),
    };
    observer?.onProposed?.({
      effectClass: proposal.effectClass,
      requiresConfirmation: proposal.requiresConfirmation,
      committedChars: proposal.committedChars,
      committedSegments: proposal.committedSegmentCount,
    });
    return proposal;
  }

  function confirm(): SpokenActionState | undefined {
    return action === undefined ? undefined : transition(action, "confirmed");
  }

  function cancel(): SpokenActionState | undefined {
    return action === undefined ? undefined : transition(action, "cancelled");
  }

  // AC4 correction guard. Re-derive the committed proposal; if its canonical confirmation binding
  // differs from the active one, a correction has voided the prior intent → supersede it. An identical
  // binding (no semantic change) leaves the proposal untouched. A projection that no longer yields a
  // proposal (committed text removed) also supersedes the active intent.
  function applyCommitted(
    segments: readonly VoiceTranscriptSegment[],
  ): SpokenActionState | undefined {
    const current = action;
    if (current === undefined) {
      return undefined;
    }
    const projection = selectCommittedVoiceTranscript(segments);
    const next = normalizeSpokenActionProposal(
      projection,
      profile,
      current.proposal.turnIndex,
      current.proposal.source,
    );
    const nextBinding =
      next === undefined ? undefined : canonicalizeSpokenActionConfirmation(next.confirmationInput);
    if (nextBinding === current.binding) {
      return current.state;
    }
    return transition(current, "superseded");
  }

  function observeTurn(turnSnapshot: VoiceTurnSnapshot): SpokenActionState | undefined {
    const current = action;
    if (current === undefined) {
      return undefined;
    }
    if (snapshotIsInterrupting(turnSnapshot)) {
      return transition(current, "interrupted");
    }
    // A turn advancing strictly past the proposal's turn expires it: the spoken intent belonged to an
    // earlier turn and must never route against a later one (AC4).
    if (turnSnapshot.turnIndex > current.proposal.turnIndex) {
      return transition(current, "expired");
    }
    return current.state;
  }

  function reset(): void {
    action = undefined;
  }

  return {
    canPropose: (): boolean => canPropose,
    propose,
    confirm,
    cancel,
    applyCommitted,
    observeTurn,
    snapshot,
    reset,
  };
}
