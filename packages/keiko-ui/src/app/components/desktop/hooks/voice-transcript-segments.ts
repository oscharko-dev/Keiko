// Issue #500, Epic #491 (ADR-0063) — the Voice transcript segment store. It is the deterministic,
// synchronous reducer / state machine that turns a stream of transcript inputs (mapped from #496 wire
// messages in full-realtime, or from the #495 dictation lifecycle in STT-only) into the provider-neutral
// segment model defined by the leaf contract `voice-transcript.ts`: partial, stable, committed,
// corrected, discarded, redacted, and provider-error segments. It is the missing piece between the #498
// timing engine (which orders the control stream and owns the commit ANCHOR `lastCommittedSeq`) and the
// #499 turn manager (which owns the content-free commit BOUNDARY `turnIndex`/`pendingCommit`): neither of
// those holds transcript TEXT, and this store is the one component that legitimately does.
//
// It is the symmetric sibling of voice-timebase.ts and voice-turn-manager.ts: a pure factory returning a
// synchronous engine, time enters ONLY through the injectable `VoiceClock` seam (reused from
// voice-timebase.ts), and the engine reads no transport and no audio. Capability gating is delegated
// wholesale to the contract's `voiceTranscriptCaptureAllowed` (AC1): `none` and `speech-output` are
// dormant and silent — `apply` short-circuits before any clock read, segment mutation, or observer call.
//
// Two privacy rules are load-bearing. (1) The CONTENT-FREE OBSERVER (AC6): transcript text never reaches
// the observer — only client-opaque ids, segment-state enums, sequence integers, revision counts, a
// committed character COUNT, and millisecond deltas leave. The reviewable text lives only in the snapshot
// the UI renders. (2) The COMMITTED-ONLY BOUNDARY (AC3/AC5): partial and stable text is structurally
// excluded from `committed()` / the committed projection, so an in-flight or unreviewed transcript can
// never become workflow input, a memory candidate, or an evidence summary.

import type { VoiceProfile } from "@/lib/types";
import {
  type CommittedVoiceTranscriptProjection,
  type VoiceTranscriptEvidenceSummary,
  type VoiceTranscriptProviderErrorKind,
  type VoiceTranscriptSegment,
  type VoiceTranscriptSegmentState,
  type VoiceTranscriptSource,
  isCommittedVoiceTranscriptState,
  selectCommittedVoiceTranscript,
  summarizeVoiceTranscript,
  voiceTranscriptCaptureAllowed,
  voiceTranscriptSegmentRedactionClass,
  voiceTranscriptSegmentReplayClass,
} from "@oscharko-dev/keiko-contracts";
import {
  type VoiceClock,
  createBrowserVoiceClock,
  resolutionToVoiceProfile,
} from "./voice-timebase";

// Re-export the clock seam and the capability adapter so a consumer constructs the transcript store from
// the same primitives as the timing engine and the turn manager without importing three sibling modules.
export { createBrowserVoiceClock, resolutionToVoiceProfile };
export type { VoiceClock };

// ─── Input vocabulary (semantic, not the wire encoding) ──────────────────────────
// A semantic input union the caller maps from #496 wire messages (full-realtime) or the #495 dictation
// lifecycle (STT-only). `partial` updates in-flight text; `stabilize` marks a partial provider-final;
// `commit` is the user / turn-manager commit; `correct` is a deterministic provider correction (AC4);
// `discard` / `redact` / `providerError` are the terminal / content-free transitions. Every input names
// the segment `id` it targets. INVARIANT: `id` MUST be a content-free, client-opaque identifier the
// caller derives from a counter (the turn index in full-realtime, the dictation clip index in STT) —
// never from transcript or provider text. The store forwards `id` verbatim to the content-free observer,
// so deriving it from text would defeat the no-side-channel guarantee, exactly as the protocol's opaque
// `sessionId` / `idempotencyKey` are content-free by contract (voice-protocol.ts).
export type VoiceTranscriptInputKind =
  | "partial"
  | "stabilize"
  | "commit"
  | "correct"
  | "discard"
  | "redact"
  | "providerError";

export type VoiceTranscriptInput =
  | { readonly kind: "partial"; readonly id: string; readonly seq: number; readonly text: string }
  | {
      readonly kind: "stabilize";
      readonly id: string;
      readonly seq?: number | undefined;
      readonly text?: string | undefined;
    }
  | { readonly kind: "commit"; readonly id: string; readonly seq?: number | undefined }
  | {
      readonly kind: "correct";
      readonly id: string;
      readonly seq: number;
      readonly text: string;
      readonly supersedesId?: string | undefined;
    }
  | { readonly kind: "discard"; readonly id: string }
  | { readonly kind: "redact"; readonly id: string }
  | {
      readonly kind: "providerError";
      readonly id: string;
      readonly seq?: number | undefined;
      readonly providerErrorKind: VoiceTranscriptProviderErrorKind;
    };

// ─── Apply outcome ───────────────────────────────────────────────────────────────
// `applied` — the input created or transitioned a segment; `no-op` — admitted for the profile but with no
// effect (stale seq, illegal transition, unknown id); `not-allowed-for-profile` — rejected by the
// capability gate (and the only outcome a dormant `none` / `speech-output` store ever produces).
export type VoiceTranscriptApplyOutcome = "applied" | "no-op" | "not-allowed-for-profile";

// ─── Content-free observer (AC6) — every field enum / integer / opaque id ────────
export interface VoiceTranscriptSegmentObservation {
  readonly id: string;
  readonly inputKind: VoiceTranscriptInputKind;
  readonly from: VoiceTranscriptSegmentState | undefined;
  readonly to: VoiceTranscriptSegmentState;
  readonly seq: number;
  readonly revision: number;
  readonly latencyMs: number;
}

// Fired only when the committed projection changes. `committedChars` is a character COUNT, never text.
export interface VoiceTranscriptCommitObservation {
  readonly committedCount: number;
  readonly committedChars: number;
}

export interface VoiceTranscriptStoreObserver {
  onSegment?(event: VoiceTranscriptSegmentObservation): void;
  onCommit?(event: VoiceTranscriptCommitObservation): void;
}

// ─── Read-only snapshot the UI renders ───────────────────────────────────────────
// Unlike the #498/#499 snapshots, this one DOES carry reviewable text (`segments`, `committed.text`):
// it is the transcript model the UI renders ("what Keiko heard / what is final"). The privacy rule
// applies to the observer, logs, and evidence — not to the in-memory render model.
export interface VoiceTranscriptSnapshot {
  readonly profile: VoiceProfile;
  readonly source: VoiceTranscriptSource;
  readonly active: boolean;
  readonly segments: readonly VoiceTranscriptSegment[];
  readonly committed: CommittedVoiceTranscriptProjection;
  readonly summary: VoiceTranscriptEvidenceSummary;
  readonly highestSeq: number;
}

export interface VoiceTranscriptApplyResult {
  readonly outcome: VoiceTranscriptApplyOutcome;
  readonly snapshot: VoiceTranscriptSnapshot;
}

// ─── Construction ────────────────────────────────────────────────────────────────
export interface VoiceTranscriptStoreOptions {
  readonly profile: VoiceProfile;
  readonly source?: VoiceTranscriptSource | undefined;
  readonly clock?: VoiceClock | undefined;
  readonly observer?: VoiceTranscriptStoreObserver | undefined;
}

export interface VoiceTranscriptSegmentStore {
  apply(input: VoiceTranscriptInput): VoiceTranscriptApplyResult;
  snapshot(): VoiceTranscriptSnapshot;
  committed(): CommittedVoiceTranscriptProjection;
  summary(): VoiceTranscriptEvidenceSummary;
  reset(): void;
}

// The mutation outcome a handler returns so the dispatcher can fire the observer and classify the apply.
// `undefined` means the input was a no-op (no segment changed).
interface SegmentMutation {
  readonly id: string;
  readonly from: VoiceTranscriptSegmentState | undefined;
  readonly to: VoiceTranscriptSegmentState;
  readonly seq: number;
  readonly revision: number;
}

interface MakeSegmentParams {
  readonly id: string;
  readonly seq: number;
  readonly state: VoiceTranscriptSegmentState;
  readonly text: string;
  readonly revision: number;
  readonly supersedesId?: string | undefined;
  readonly providerErrorKind?: VoiceTranscriptProviderErrorKind | undefined;
}

export function createVoiceTranscriptSegmentStore(
  options: VoiceTranscriptStoreOptions,
): VoiceTranscriptSegmentStore {
  const { profile } = options;
  const source: VoiceTranscriptSource = options.source ?? "realtime";
  const clock = options.clock ?? createBrowserVoiceClock();
  const observer = options.observer;
  const active = voiceTranscriptCaptureAllowed(profile);

  let segments: VoiceTranscriptSegment[] = [];
  let highestSeq = 0;
  let lastTransitionAtMs: number | undefined;

  function makeSegment(params: MakeSegmentParams): VoiceTranscriptSegment {
    return {
      id: params.id,
      seq: params.seq,
      state: params.state,
      text: params.text,
      source,
      revision: params.revision,
      replayClass: voiceTranscriptSegmentReplayClass(params.state),
      redactionClass: voiceTranscriptSegmentRedactionClass(params.state),
      supersedesId: params.supersedesId,
      providerErrorKind: params.providerErrorKind,
    };
  }

  function find(id: string): VoiceTranscriptSegment | undefined {
    return segments.find((segment) => segment.id === id);
  }

  function put(segment: VoiceTranscriptSegment): void {
    const index = segments.findIndex((existing) => existing.id === segment.id);
    if (index === -1) {
      segments = [...segments, segment];
    } else {
      segments = segments.map((existing) => (existing.id === segment.id ? segment : existing));
    }
    if (segment.seq > highestSeq) {
      highestSeq = segment.seq;
    }
  }

  function committedProjection(): CommittedVoiceTranscriptProjection {
    return selectCommittedVoiceTranscript(segments);
  }

  function snapshot(): VoiceTranscriptSnapshot {
    const committed = committedProjection();
    return {
      profile,
      source,
      active,
      segments: [...segments],
      committed,
      summary: summarizeVoiceTranscript(segments),
      highestSeq,
    };
  }

  // ─── Per-input handlers — each returns the mutation it performed, or undefined for a no-op ───

  function handlePartial(id: string, seq: number, text: string): SegmentMutation | undefined {
    const existing = find(id);
    if (existing === undefined) {
      put(makeSegment({ id, seq, state: "partial", text, revision: 0 }));
      return { id, from: undefined, to: "partial", seq, revision: 0 };
    }
    // Only an in-flight partial accepts further partial churn; a finalised segment is never re-opened.
    // A partial with a non-forward seq is a stale / out-of-order arrival and is a deterministic no-op.
    if (existing.state !== "partial" || seq < existing.seq) {
      return undefined;
    }
    put(makeSegment({ id, seq, state: "partial", text, revision: existing.revision }));
    return { id, from: "partial", to: "partial", seq, revision: existing.revision };
  }

  function handleStabilize(
    id: string,
    seq: number | undefined,
    text: string | undefined,
  ): SegmentMutation | undefined {
    const existing = find(id);
    if (existing === undefined || existing.state !== "partial") {
      return undefined;
    }
    const nextSeq = seq ?? existing.seq;
    const nextText = text ?? existing.text;
    put(
      makeSegment({
        id,
        seq: nextSeq,
        state: "stable",
        text: nextText,
        revision: existing.revision,
      }),
    );
    return { id, from: "partial", to: "stable", seq: nextSeq, revision: existing.revision };
  }

  function handleCommit(id: string, seq: number | undefined): SegmentMutation | undefined {
    const existing = find(id);
    if (existing === undefined || (existing.state !== "partial" && existing.state !== "stable")) {
      return undefined;
    }
    const nextSeq = seq ?? existing.seq;
    put(
      makeSegment({
        id,
        seq: nextSeq,
        state: "committed",
        text: existing.text,
        revision: existing.revision,
      }),
    );
    return { id, from: existing.state, to: "committed", seq: nextSeq, revision: existing.revision };
  }

  function handleCorrect(
    id: string,
    seq: number,
    text: string,
    supersedesId: string | undefined,
  ): SegmentMutation | undefined {
    const existing = find(id);
    if (existing === undefined) {
      // A correction can arrive as its own segment that supersedes an earlier one by id (AC4 replace).
      put(makeSegment({ id, seq, state: "corrected", text, revision: 1, supersedesId }));
      return { id, from: undefined, to: "corrected", seq, revision: 1 };
    }
    // Corrections apply to finalised text (stable / committed / corrected) and must move strictly
    // forward in seq, so a duplicate or late correction is a deterministic no-op.
    if (
      existing.state !== "stable" &&
      existing.state !== "committed" &&
      existing.state !== "corrected"
    ) {
      return undefined;
    }
    if (seq <= existing.seq) {
      return undefined;
    }
    const revision = existing.revision + 1;
    put(
      makeSegment({
        id,
        seq,
        state: "corrected",
        text,
        revision,
        supersedesId: supersedesId ?? existing.supersedesId,
      }),
    );
    return { id, from: existing.state, to: "corrected", seq, revision };
  }

  function handleDiscard(id: string): SegmentMutation | undefined {
    const existing = find(id);
    if (existing === undefined || existing.state === "discarded" || existing.state === "redacted") {
      return undefined;
    }
    put(
      makeSegment({
        id,
        seq: existing.seq,
        state: "discarded",
        text: "",
        revision: existing.revision,
        // Preserve supersession: discarding a correction must NOT resurface the text it replaced.
        supersedesId: existing.supersedesId,
      }),
    );
    return {
      id,
      from: existing.state,
      to: "discarded",
      seq: existing.seq,
      revision: existing.revision,
    };
  }

  function handleRedact(id: string): SegmentMutation | undefined {
    const existing = find(id);
    if (existing === undefined || existing.state === "redacted" || existing.state === "discarded") {
      return undefined;
    }
    put(
      makeSegment({
        id,
        seq: existing.seq,
        state: "redacted",
        text: "",
        revision: existing.revision,
        // Preserve supersession: redacting a correction must NOT resurface the text it replaced.
        supersedesId: existing.supersedesId,
      }),
    );
    return {
      id,
      from: existing.state,
      to: "redacted",
      seq: existing.seq,
      revision: existing.revision,
    };
  }

  function handleProviderError(
    id: string,
    seq: number | undefined,
    providerErrorKind: VoiceTranscriptProviderErrorKind,
  ): SegmentMutation | undefined {
    const existing = find(id);
    if (existing === undefined) {
      const nextSeq = seq ?? highestSeq;
      put(
        makeSegment({
          id,
          seq: nextSeq,
          state: "provider-error",
          text: "",
          revision: 0,
          providerErrorKind,
        }),
      );
      return { id, from: undefined, to: "provider-error", seq: nextSeq, revision: 0 };
    }
    // A provider failure can only affect text that has not yet been committed (partial / stable).
    if (existing.state !== "partial" && existing.state !== "stable") {
      return undefined;
    }
    const nextSeq = seq ?? existing.seq;
    put(
      makeSegment({
        id,
        seq: nextSeq,
        state: "provider-error",
        text: "",
        revision: existing.revision,
        providerErrorKind,
      }),
    );
    return {
      id,
      from: existing.state,
      to: "provider-error",
      seq: nextSeq,
      revision: existing.revision,
    };
  }

  // Each handler implements the state-changing edges declared by VOICE_TRANSCRIPT_SEGMENT_TRANSITIONS in
  // the contract (plus same-state text updates — partial churn, re-correction — which are not transitions).
  // The handler guards and the contract transition table must stay consistent; the contract's totality
  // test pins the table, and the reducer fixtures pin the handler behavior.
  function dispatch(input: VoiceTranscriptInput): SegmentMutation | undefined {
    switch (input.kind) {
      case "partial":
        return handlePartial(input.id, input.seq, input.text);
      case "stabilize":
        return handleStabilize(input.id, input.seq, input.text);
      case "commit":
        return handleCommit(input.id, input.seq);
      case "correct":
        return handleCorrect(input.id, input.seq, input.text, input.supersedesId);
      case "discard":
        return handleDiscard(input.id);
      case "redact":
        return handleRedact(input.id);
      case "providerError":
        return handleProviderError(input.id, input.seq, input.providerErrorKind);
    }
  }

  function apply(input: VoiceTranscriptInput): VoiceTranscriptApplyResult {
    // Dormant (`none` / `speech-output`) stores short-circuit before any clock read, mutation, or
    // observer call (AC1): a dormant store is content-free and silent.
    if (!active) {
      return { outcome: "not-allowed-for-profile", snapshot: snapshot() };
    }
    const nowMs = clock.now();
    const mutation = dispatch(input);
    if (mutation === undefined) {
      return { outcome: "no-op", snapshot: snapshot() };
    }
    const latencyMs = lastTransitionAtMs === undefined ? 0 : nowMs - lastTransitionAtMs;
    lastTransitionAtMs = nowMs;
    observer?.onSegment?.({
      id: mutation.id,
      inputKind: input.kind,
      from: mutation.from,
      to: mutation.to,
      seq: mutation.seq,
      revision: mutation.revision,
      latencyMs,
    });
    // Fire onCommit whenever the mutation moved a segment INTO or OUT OF the committed projection — a
    // commit, a correction (which may be a same-length edit the committed character count cannot detect),
    // or a discard / redact of an already-committed segment.
    const touchesCommitted =
      isCommittedVoiceTranscriptState(mutation.to) ||
      (mutation.from !== undefined && isCommittedVoiceTranscriptState(mutation.from));
    if (touchesCommitted) {
      const committed = committedProjection();
      observer?.onCommit?.({
        committedCount: committed.segmentCount,
        committedChars: committed.text.length,
      });
    }
    return { outcome: "applied", snapshot: snapshot() };
  }

  function reset(): void {
    segments = [];
    highestSeq = 0;
    lastTransitionAtMs = undefined;
  }

  return {
    apply,
    snapshot,
    committed: committedProjection,
    summary: (): VoiceTranscriptEvidenceSummary => summarizeVoiceTranscript(segments),
    reset,
  };
}
