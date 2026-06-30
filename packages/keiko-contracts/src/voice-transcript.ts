// Public type contract for the optional Voice Digital Twin transcript segment lifecycle (Epic #491,
// Issue #500, ADR-0063). This module DEFINES the provider-neutral semantics that let Keiko distinguish
// uncertain partial text, provider-stabilised text, user/turn-committed text, provider corrections, and
// discarded / redacted / failed text. It is pure data + pure functions only — nothing performs IO,
// crypto, clock reads, randomness, or audio processing, and no provider base URL, credential, or raw
// audio buffer is ever a field on these types.
//
// It is layered ABOVE the #496 wire protocol (voice-protocol.ts): the wire carries only three transcript
// message kinds (`transcript.partial`, `transcript.committed`, `transcript.discarded`), whereas the
// lifecycle here has seven segment STATES. Only the three states that have a wire kind round-trip on the
// wire (`mapWireKindToVoiceTranscriptSegmentState`); `stable`, `corrected`, `redacted`, and
// `provider-error` are derived/internal states with no wire kind, exactly as the #499 turn manager maps
// a richer semantic signal set onto the same wire catalog (ADR-0062). The stateful reducer that drives
// these states lives in keiko-ui (`voice-transcript-segments.ts`) as a synchronous deterministic engine;
// this leaf contract holds the state catalog, the classification tables, the legal-transition table, the
// validators, and the AC5 committed-only integration boundary so server-side consumers (#503 governed
// spoken actions and memory review) can enforce committed-only consumption without forking the reducer.
//
// `VOICE_TRANSCRIPT_SCHEMA_VERSION` follows the same evolution rule as `VOICE_PROTOCOL_VERSION`: a
// breaking change introduces a NEW literal rather than mutating "1". It is INDEPENDENT of the wire
// `VOICE_PROTOCOL_VERSION` and of `CONVERSATION_CAPABILITY_CONTRACT_VERSION`. Leaf-package rule
// (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports may appear here; sibling types are reached
// by relative path.

import type { VoiceProfile } from "./gateway.js";
import type {
  VoiceControlMessageKind,
  VoiceRedactionClass,
  VoiceReplayClass,
} from "./voice-protocol.js";
import { voiceMessageAllowedForProfile } from "./voice-protocol.js";

// ─── Schema version ───────────────────────────────────────────────────────────
export const VOICE_TRANSCRIPT_SCHEMA_VERSION = "1" as const;

export function isVoiceTranscriptSchemaVersionSupported(version: unknown): boolean {
  return version === VOICE_TRANSCRIPT_SCHEMA_VERSION;
}

// ─── Segment states (Deliverable: transcript lifecycle contract) ─────────────────
// `partial`        — uncertain in-flight text; the provider is still refining it. Ephemeral; never a
//                    workflow input, memory candidate, or evidence summary (AC3/AC5).
// `stable`         — the provider marked this text final, but the user / turn manager has NOT yet
//                    committed it. Still reviewable-only and never consumed downstream.
// `committed`      — the user (STT dictation) or the turn manager (full-realtime end-of-turn) committed
//                    the text. The ONLY state, with `corrected`, that downstream may consume (AC2/AC5).
// `corrected`      — a later provider correction superseded an earlier committed/stable segment's text
//                    deterministically (AC4). Consumable, carrying the corrected text.
// `discarded`      — the user / turn manager discarded the segment. Content-free; excluded downstream.
// `redacted`       — the reviewable text was redacted out (privacy). Content-free; excluded downstream.
// `provider-error` — the provider failed to transcribe this segment. Content-free; excluded downstream.
export type VoiceTranscriptSegmentState =
  "partial" | "stable" | "committed" | "corrected" | "discarded" | "redacted" | "provider-error";

export const VOICE_TRANSCRIPT_SEGMENT_STATES: readonly VoiceTranscriptSegmentState[] = [
  "partial",
  "stable",
  "committed",
  "corrected",
  "discarded",
  "redacted",
  "provider-error",
] as const;

// The two states whose text downstream integrations (memory, workflow, evaluation) may consume.
// This is the load-bearing AC5 invariant expressed as data: a segment's text crosses the integration
// boundary if and only if its state is in this set.
export const VOICE_TRANSCRIPT_CONSUMABLE_STATES: readonly VoiceTranscriptSegmentState[] = [
  "committed",
  "corrected",
] as const;

// ─── Provider error taxonomy (AC6: provider-error case) ─────────────────────────
// Provider-neutral failure kinds. Defined independently here (leaf rule forbids importing the Model
// Gateway / BFF taxonomy) but aligned by value with the BFF speech-to-text error codes so a server
// adapter can map `VOICE_RATE_LIMITED`/`VOICE_TIMEOUT`/`VOICE_PROVIDER_ERROR`/`VOICE_UNAVAILABLE` onto
// these without a lossy round-trip.
export type VoiceTranscriptProviderErrorKind =
  "rate-limited" | "timeout" | "provider-error" | "unavailable" | "internal";

export const VOICE_TRANSCRIPT_PROVIDER_ERROR_KINDS: readonly VoiceTranscriptProviderErrorKind[] = [
  "rate-limited",
  "timeout",
  "provider-error",
  "unavailable",
  "internal",
] as const;

// ─── Segment provenance ─────────────────────────────────────────────────────────
// Which capability produced the segment. `dictation` is STT-only composer dictation (gateway-batch);
// `realtime` is full-duplex voice. The lifecycle is identical for both — the "same model" the issue
// requires — and provenance is recorded only for content-free observability.
export type VoiceTranscriptSource = "dictation" | "realtime";

export const VOICE_TRANSCRIPT_SOURCES: readonly VoiceTranscriptSource[] = [
  "dictation",
  "realtime",
] as const;

// ─── Segment ─────────────────────────────────────────────────────────────────────
// A single transcript segment. `id` is a client-chosen opaque identifier (content-free, like the
// protocol's `sessionId`/`idempotencyKey`); `seq` is the monotonic ordering anchor carried from the
// wire envelope (full-realtime) or the dictation clip index (STT) — corrections and partial churn are
// resolved deterministically by `seq`. `text` holds reviewable text for the reviewable-text states and
// is the empty string for the content-free states. `revision` counts the text-changing corrections
// applied to this segment, which is the local correction-history depth recorded WITHOUT retaining raw
// audio or provider-internal payloads.
export interface VoiceTranscriptSegment {
  readonly id: string;
  readonly seq: number;
  readonly state: VoiceTranscriptSegmentState;
  readonly text: string;
  readonly source: VoiceTranscriptSource;
  readonly revision: number;
  readonly replayClass: VoiceReplayClass;
  readonly redactionClass: VoiceRedactionClass;
  readonly supersedesId?: string | undefined;
  readonly providerErrorKind?: VoiceTranscriptProviderErrorKind | undefined;
}

// ─── Per-state classification tables (aligned to voice-protocol.ts) ──────────────
// Keyed by `VoiceTranscriptSegmentState` so adding a state without classifying it is a compile error
// (totality). The classes are the same `VoiceReplayClass` / `VoiceRedactionClass` the wire protocol
// uses, so a segment and the wire message it derives from agree on replay and redaction treatment.
//
// Replay (AC5 reconnect semantics): the durable, committed lifecycle facts (`committed`, `corrected`,
// `discarded`, `redacted`, `provider-error`) are `replayable`; the in-flight `partial` / `stable`
// previews are `ephemeral` and a reconnect never re-delivers them, mirroring `transcript.partial`.
export const VOICE_TRANSCRIPT_SEGMENT_REPLAY: Record<
  VoiceTranscriptSegmentState,
  VoiceReplayClass
> = {
  partial: "ephemeral",
  stable: "ephemeral",
  committed: "replayable",
  corrected: "replayable",
  discarded: "replayable",
  redacted: "replayable",
  "provider-error": "replayable",
} as const;

// Redaction: the text-bearing states (`partial`, `stable`, `committed`, `corrected`) are
// `reviewable-text` — they must pass through the existing `stripUnsafeFormatChars` + redact-at-persist
// seam before any log or evidence manifest. The
// content-free states carry no reviewable text, so they are `content-free`.
export const VOICE_TRANSCRIPT_SEGMENT_REDACTION: Record<
  VoiceTranscriptSegmentState,
  VoiceRedactionClass
> = {
  partial: "reviewable-text",
  stable: "reviewable-text",
  committed: "reviewable-text",
  corrected: "reviewable-text",
  discarded: "content-free",
  redacted: "content-free",
  "provider-error": "content-free",
} as const;

// ─── Legal transition table (Deliverable: reducer/state machine rules) ───────────
// The set of states reachable from a given state by a state-CHANGING transition. Repeated operations
// that keep the same state (partial-text churn, re-correction) are text updates handled by the reducer,
// not transitions, so they are intentionally absent here. `discarded` and `redacted` are terminal.
// Keyed by state for totality.
// A correction targets already-finalised text, so `partial` has no direct edge to `corrected`
// (an in-flight partial is refined by further partials, then stabilised/committed, then corrected).
// `committed`/`corrected` never regress to `provider-error`: a provider failure can only affect text
// that has not yet been committed.
export const VOICE_TRANSCRIPT_SEGMENT_TRANSITIONS: Record<
  VoiceTranscriptSegmentState,
  readonly VoiceTranscriptSegmentState[]
> = {
  partial: ["stable", "committed", "discarded", "redacted", "provider-error"],
  stable: ["committed", "corrected", "discarded", "redacted", "provider-error"],
  committed: ["corrected", "discarded", "redacted"],
  corrected: ["discarded", "redacted"],
  discarded: [],
  redacted: [],
  "provider-error": ["discarded", "redacted"],
} as const;

// ─── Type guards & lookups ───────────────────────────────────────────────────────
export function isVoiceTranscriptSegmentState(
  value: unknown,
): value is VoiceTranscriptSegmentState {
  return (
    typeof value === "string" &&
    (VOICE_TRANSCRIPT_SEGMENT_STATES as readonly string[]).includes(value)
  );
}

export function isVoiceTranscriptProviderErrorKind(
  value: unknown,
): value is VoiceTranscriptProviderErrorKind {
  return (
    typeof value === "string" &&
    (VOICE_TRANSCRIPT_PROVIDER_ERROR_KINDS as readonly string[]).includes(value)
  );
}

export function isVoiceTranscriptSource(value: unknown): value is VoiceTranscriptSource {
  return (
    typeof value === "string" && (VOICE_TRANSCRIPT_SOURCES as readonly string[]).includes(value)
  );
}

export function voiceTranscriptSegmentReplayClass(
  state: VoiceTranscriptSegmentState,
): VoiceReplayClass {
  return VOICE_TRANSCRIPT_SEGMENT_REPLAY[state];
}

export function voiceTranscriptSegmentRedactionClass(
  state: VoiceTranscriptSegmentState,
): VoiceRedactionClass {
  return VOICE_TRANSCRIPT_SEGMENT_REDACTION[state];
}

// Whether `to` is reachable from `from` by a legal state-changing transition.
export function canTransitionVoiceTranscriptSegment(
  from: VoiceTranscriptSegmentState,
  to: VoiceTranscriptSegmentState,
): boolean {
  return VOICE_TRANSCRIPT_SEGMENT_TRANSITIONS[from].includes(to);
}

// AC5: a segment's text is consumable downstream iff it is committed or corrected.
export function isCommittedVoiceTranscriptState(state: VoiceTranscriptSegmentState): boolean {
  return (VOICE_TRANSCRIPT_CONSUMABLE_STATES as readonly string[]).includes(state);
}

// Exhaustiveness guard: a `default`/fall-through that reaches this fails to type-check if a new
// `VoiceTranscriptSegmentState` is added without handling, mirroring `assertNeverVoiceControlMessageKind`.
export function assertNeverVoiceTranscriptSegmentState(state: never): never {
  throw new Error(`unhandled voice transcript segment state: ${JSON.stringify(state)}`);
}

// ─── Wire-kind ↔ state mapping ───────────────────────────────────────────────────
// The initial segment state a wire transcript kind establishes. Only the three transcript wire kinds
// map; every other control kind (and the derived states `stable`/`corrected`/`redacted`/
// `provider-error`, which have no wire kind) returns `undefined`. A strict 1:1 wire↔state map is
// impossible by design, the same lesson the #499 turn manager records (ADR-0062).
export function mapWireKindToVoiceTranscriptSegmentState(
  kind: VoiceControlMessageKind,
): VoiceTranscriptSegmentState | undefined {
  switch (kind) {
    case "transcript.partial":
      return "partial";
    case "transcript.committed":
      return "committed";
    case "transcript.discarded":
      return "discarded";
    default:
      return undefined;
  }
}

// ─── Capability-gating predicates (AC1/AC2/AC3) — derived from the contract ──────
// The single source of truth for capability gating is `voiceMessageAllowedForProfile`; these predicates
// derive the transcript-relevant capabilities from it rather than re-encoding the profile table.
// `none` permits neither (transcript handling is dormant); `speech-output` permits neither (it is
// playback-only); `speech-to-text` and `full-realtime` permit both.
export function voiceTranscriptCaptureAllowed(profile: VoiceProfile): boolean {
  return voiceMessageAllowedForProfile("transcript.committed", profile);
}

export function voiceTranscriptPreviewAllowed(profile: VoiceProfile): boolean {
  return voiceMessageAllowedForProfile("transcript.partial", profile);
}

// ─── AC5 committed-only integration boundary (Deliverable: integration contract) ──
// `selectCommittedVoiceTranscript` is THE integration boundary: the single typed projection that
// composer dictation (#495), full voice mode (#497), memory review, and evaluation may consume. It
// returns only `committed` + `corrected` segments, ordered deterministically by `seq` (ties broken by
// `id`), and a concatenation of their text. Partial, stable, discarded, redacted, and provider-error
// segments can never appear in the projection, so a consumer that reads only this projection structurally
// cannot act on uncommitted, discarded, redacted, or failed text. A segment that a later `corrected`
// segment supersedes (by `supersedesId`) is also excluded, so a provider correction REPLACES rather than
// duplicates the prior text deterministically (AC4).
export interface CommittedVoiceTranscriptProjection {
  readonly schemaVersion: typeof VOICE_TRANSCRIPT_SCHEMA_VERSION;
  readonly segments: readonly VoiceTranscriptSegment[];
  readonly text: string;
  readonly segmentCount: number;
}

// Segments carry unique ids, so the sort never compares an id to itself; a `seq` tie is broken by id.
function bySeqThenId(a: VoiceTranscriptSegment, b: VoiceTranscriptSegment): number {
  if (a.seq !== b.seq) {
    return a.seq - b.seq;
  }
  return a.id < b.id ? -1 : 1;
}

// Supersession is a PERMANENT fact: once a correction replaces a prior segment's text, that prior text
// must never re-enter the consumable projection — even after the superseding correction is itself
// discarded or redacted. We therefore collect `supersedesId` from ANY segment that carries it,
// regardless of the carrier's current state (the reducer preserves `supersedesId` across transitions).
function supersededSegmentIds(segments: readonly VoiceTranscriptSegment[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const segment of segments) {
    if (segment.supersedesId !== undefined) {
      ids.add(segment.supersedesId);
    }
  }
  return ids;
}

export function selectCommittedVoiceTranscript(
  segments: readonly VoiceTranscriptSegment[],
): CommittedVoiceTranscriptProjection {
  const superseded = supersededSegmentIds(segments);
  const committed = segments
    .filter(
      (segment) => isCommittedVoiceTranscriptState(segment.state) && !superseded.has(segment.id),
    )
    .slice()
    .sort(bySeqThenId);
  const text = committed
    .map((segment) => segment.text.trim())
    .filter((value) => value.length > 0)
    .join(" ");
  return {
    schemaVersion: VOICE_TRANSCRIPT_SCHEMA_VERSION,
    segments: committed,
    text,
    segmentCount: committed.length,
  };
}

// ─── Evidence-safe summary (AC5: store only evidence-safe summaries / metadata) ───
// A content-free roll-up for evaluation: counts and the committed character length only — never
// any segment text. This is the only transcript representation that may enter an evidence manifest
// without first passing reviewable text through the redact-at-persist seam.
export interface VoiceTranscriptEvidenceSummary {
  readonly schemaVersion: typeof VOICE_TRANSCRIPT_SCHEMA_VERSION;
  readonly segmentCount: number;
  // `committedCount` / `correctedCount` are RAW per-state counts (how many segments ever reached each
  // state), so they include a `committed` segment that a later `corrected` segment has superseded. The
  // count of segments actually consumable downstream is `selectCommittedVoiceTranscript(segments).segmentCount`,
  // which excludes superseded ids; the two intentionally differ after a supersede-by-id correction.
  readonly committedCount: number;
  readonly correctedCount: number;
  readonly discardedCount: number;
  readonly redactedCount: number;
  readonly providerErrorCount: number;
  readonly committedChars: number;
  readonly highestSeq: number;
}

function countState(
  segments: readonly VoiceTranscriptSegment[],
  state: VoiceTranscriptSegmentState,
): number {
  return segments.filter((segment) => segment.state === state).length;
}

export function summarizeVoiceTranscript(
  segments: readonly VoiceTranscriptSegment[],
): VoiceTranscriptEvidenceSummary {
  const projection = selectCommittedVoiceTranscript(segments);
  // The committed character count is the length of the consumable projection text, so the evidence
  // summary, the projection, and the reducer's onCommit observation all report the same number.
  const committedChars = projection.text.length;
  const highestSeq = segments.reduce((max, segment) => (segment.seq > max ? segment.seq : max), 0);
  return {
    schemaVersion: VOICE_TRANSCRIPT_SCHEMA_VERSION,
    segmentCount: segments.length,
    committedCount: countState(segments, "committed"),
    correctedCount: countState(segments, "corrected"),
    discardedCount: countState(segments, "discarded"),
    redactedCount: countState(segments, "redacted"),
    providerErrorCount: countState(segments, "provider-error"),
    committedChars,
    highestSeq,
  };
}
