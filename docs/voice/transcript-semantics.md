# Voice transcript segment semantics — lifecycle, reducer, and committed-only integration boundary

Provider-neutral specification for Epic #491, the deliverable of Issue
[#500](https://github.com/oscharko-dev/Keiko/issues/500) and the authoritative companion to
[ADR-0063](../adr/ADR-0063-voice-transcript-segment-semantics.md). It **defines** the segment
lifecycle and integration boundary; the reducer that drives state changes lives in
[`packages/keiko-ui/src/app/components/desktop/hooks/voice-transcript-segments.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/voice-transcript-segments.ts).
The contract lives in
[`packages/keiko-contracts/src/voice-transcript.ts`](../../packages/keiko-contracts/src/voice-transcript.ts).

## 1. Scope and versioning

- **In scope:** the seven-state segment lifecycle; the mapping from three wire message kinds onto seven
  states; the legal state-transition table; per-state replay and redaction classification; the
  committed-only integration boundary; the AC1/AC3 dormancy and filtering guarantees; the content-free
  observer rule.
- **Out of scope (Issue #504 and later):** persisting transcripts in recap/memory; wiring the
  committed-only projection into server-side consumers (#503 governed actions, #504 recap/memory).

The segment lifecycle is versioned by `VOICE_TRANSCRIPT_SCHEMA_VERSION = "1"` (a string literal).
It evolves by the same rule as other contract schemas: a breaking change introduces a **new literal
member**, never a mutation of `"1"`. The version is **independent of** `VOICE_PROTOCOL_VERSION` (the
wire version) and `CONVERSATION_CAPABILITY_CONTRACT_VERSION` (the capability-registry version).
A build understands a segment state only when its declared schema version is one the build supports
(`isVoiceTranscriptSchemaVersionSupported`); a v1 build understands exactly `"1"`.

## 2. Seven segment states and their classification

Each segment is one of seven states. The table below shows each state's meaning, replay class, redaction
class, and whether downstream consumers may read its text (via `selectCommittedVoiceTranscript()`):

| State            | Meaning                                        | Replay Class | Redaction Class   | Consumable |
| ---------------- | ---------------------------------------------- | ------------ | ----------------- | ---------- |
| `partial`        | Uncertain in-flight text; provider is refining | `ephemeral`  | `reviewable-text` | no         |
| `stable`         | Provider marked final; user has not committed  | `ephemeral`  | `reviewable-text` | no         |
| `committed`      | User or turn manager committed the text        | `replayable` | `reviewable-text` | **yes**    |
| `corrected`      | Provider correction superseded a prior segment | `replayable` | `reviewable-text` | **yes**    |
| `discarded`      | User / turn manager discarded the segment      | `replayable` | `content-free`    | no         |
| `redacted`       | Reviewable text was redacted (privacy)         | `replayable` | `content-free`    | no         |
| `provider-error` | Provider failed to transcribe this segment     | `replayable` | `content-free`    | no         |

### Replay semantics

- **`ephemeral`** (`partial`, `stable`): in-flight previews never replayed across reconnect. A client
  reconnect does not re-deliver ephemeral state to the reducer. Mirrors `transcript.partial` replay
  semantics.
- **`replayable`** (all others): durable, committed lifecycle facts preserved across reconnect. A client
  reconnect re-delivers these messages to the reducer with `seq > sinceSeq` to reconstruct local state.

### Redaction semantics

- **`reviewable-text`** (`partial`, `stable`, `committed`, `corrected`): carry user-reviewable text that
  must pass through `stripUnsafeFormatChars` (to neutralise Trojan-source rendering) and the
  redact-at-persist seam before any log or evidence manifest, exactly as recap / session-state records
  already are.
- **`content-free`** (`discarded`, `redacted`, `provider-error`): text is empty or absent. No reviewable
  text, no redaction overhead. Safe to log directly.

### Consumable boundary

Only `committed` and `corrected` segments are consumable by downstream integrations (composer dictation
#495, full-realtime voice #497, recap #504, evaluation). Partial, stable, discarded, redacted, and
provider-error segments are **structurally excluded** from the committed projection returned by
`selectCommittedVoiceTranscript(segments)`. A consumer that reads only this projection is type-protected
against using uncommitted, discarded, redacted, or failed text (AC3 / AC5).

## 3. Wire-message kinds and state mapping

The wire protocol (#496, [ADR-0059](../adr/ADR-0059-voice-control-media-capability-replay-protocol.md))
defines three transcript message kinds. Each maps to an initial segment state:

| Wire Kind              | Maps to State | Meaning                                                    |
| ---------------------- | ------------- | ---------------------------------------------------------- |
| `transcript.partial`   | `partial`     | In-flight text; provider refining; ephemeral               |
| `transcript.committed` | `committed`   | Provider marked final; user/turn-manager approved; durable |
| `transcript.discarded` | `discarded`   | User/turn-manager discarded; content-free; durable         |

Four states have **no wire kind** and are derived by the reducer in response to semantic inputs:

| State            | Produced by           | Meaning                                                  |
| ---------------- | --------------------- | -------------------------------------------------------- |
| `stable`         | `stabilize` input     | Provider marked final; user has not yet committed        |
| `corrected`      | `correct` input       | Provider issued a correction (forward transition on seq) |
| `redacted`       | `redact` input        | Reviewable text was redacted (privacy action)            |
| `provider-error` | `providerError` input | Provider failed to transcribe this segment               |

This asymmetry is load-bearing: a strict 1:1 wire-to-state map would make deterministic provider
corrections (AC4) and error handling (AC6) impossible without either doubling the wire catalog or
storing raw provider metadata in the UI. The semantic input union decouples the state machine from the
wire encoding, exactly as [ADR-0062](../adr/ADR-0062-voice-turn-manager.md) (turn manager) decouples
its eight floor states from the wire's control-message kinds.

## 4. Complete state-transition table

The table below is the normative specification of legal state-changing transitions. Repeated operations
that hold the state (partial-text churn, duplicate corrections) are text updates, not transitions, and
are handled by the reducer without appearing here. `discarded` and `redacted` are terminal — no
transitions leave them.

| From State       | Reachable States                                                    | Notes                                                                           |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `partial`        | `stable`, `committed`, `discarded`, `redacted`, `provider-error`    | In-flight text can be refined, finalized, discarded, redacted, or fail          |
| `stable`         | `committed`, `corrected`, `discarded`, `redacted`, `provider-error` | Provider-final text awaits commitment or can regress to error                   |
| `committed`      | `corrected`, `discarded`, `redacted`                                | Committed text can be corrected, discarded, or redacted; no regression to error |
| `corrected`      | `discarded`, `redacted`                                             | Corrected text is terminal (no error regression)                                |
| `discarded`      | _(none)_                                                            | Terminal                                                                        |
| `redacted`       | _(none)_                                                            | Terminal                                                                        |
| `provider-error` | `discarded`, `redacted`                                             | Error segments can only be discarded or redacted                                |

Attempting a transition outside this table (e.g., `committed` → `provider-error`) is a deterministic
no-op in the reducer; no segment is modified.

## 5. Provider correction semantics (AC4)

A `correct` input carries a `seq` strictly greater than the segment it updates and optional `supersedesId`
naming a prior committed segment to replace.

### Deterministic forward transitions

A correction on an existing segment (by `id`) must have `seq > existing.seq`. A correction with
`seq <= existing.seq` is a no-op. This ensures corrections are applied in order and duplicates are
rejected deterministically.

### Superseding without duplication

When a `corrected` segment carries `supersedesId`, the committed projection (`selectCommittedVoiceTranscript()`)
excludes the superseded segment's id from its result set. The corrected segment's text replaces the
prior segment's text **without duplication**. The superseded segment remains in the store (for observability
and replay) but is filtered out of the consumable projection.

### Revision tracking

Each segment tracks a `revision` counter (initial 0, increments with each `correct` transition).
This is the local correction-history depth available for metrics and observability without storing raw
audio or provider payloads. The observer fires on every revision.

## 6. AC1 dormancy by construction

When the voice profile is `"none"` or `"speech-output"`, the predicate `voiceTranscriptCaptureAllowed(profile)`
returns `false`. The reducer initializes with `active = false`. Every call to `apply(input)` short-circuits
before reading the clock, mutating any segment, or calling the observer: it returns
`{ outcome: "not-allowed-for-profile", snapshot }` silently. The store is **dormant**: no state changes,
no observer fires, no resource is consumed. This is identical to the [ADR-0061](../adr/ADR-0061-voice-timing-engine.md)
dormancy pattern (AC1).

## 7. Committed-only integration boundary (AC3 / AC5)

The reducer exports a single typed selector:

```typescript
selectCommittedVoiceTranscript(segments: readonly VoiceTranscriptSegment[]): CommittedVoiceTranscriptProjection

interface CommittedVoiceTranscriptProjection {
  schemaVersion: "1";
  segments: readonly VoiceTranscriptSegment[];  // committed + corrected only
  text: string;                                  // concatenation of non-empty segment text
  segmentCount: number;
}
```

The projection filters to only `committed` and `corrected` segments, sorted deterministically by `seq`
(ties broken by `id` lexicographically), and excludes segments superseded by a `corrected` segment.
Partial, stable, discarded, redacted, and provider-error segments can **never** appear in this projection.

A server-side consumer (e.g., #503 governed actions, #504 recap) that reads only this projection is
structurally type-protected against consuming uncommitted, discarded, redacted, or failed text.
The contract is SERVER-IMPORTABLE: keiko-server can import `selectCommittedVoiceTranscript` from
`keiko-contracts` without importing the keiko-ui reducer, and can enforce committed-only consumption
at the type level.

### Evidence-safe summary

The reducer also exports a content-free roll-up:

```typescript
summarizeVoiceTranscript(segments: readonly VoiceTranscriptSegment[]): VoiceTranscriptEvidenceSummary

interface VoiceTranscriptEvidenceSummary {
  schemaVersion: "1";
  segmentCount: number;
  committedCount: number;
  correctedCount: number;
  discardedCount: number;
  redactedCount: number;
  providerErrorCount: number;
  committedChars: number;        // character COUNT only, never text
  highestSeq: number;
}
```

This is the only transcript representation permitted to enter an evidence manifest without first
passing reviewable text through the redact-at-persist seam. It contains no segment text, no provider
payloads, no session identifiers — only counts, a character count, and the maximum sequence number.

## 8. Content-free observer (AC5)

The reducer accepts an optional `VoiceTranscriptStoreObserver` with two event callbacks, both content-free:

```typescript
interface VoiceTranscriptStoreObserver {
  onSegment?(event: {
    id: string; // opaque id, never content
    inputKind: VoiceTranscriptInputKind; // enum discriminant
    from: VoiceTranscriptSegmentState | undefined;
    to: VoiceTranscriptSegmentState;
    seq: number;
    revision: number;
    latencyMs: number; // clock.now() - previous apply
  }): void;

  onCommit?(event: {
    committedCount: number;
    committedChars: number; // character COUNT, never text
  }): void;
}
```

**Every field is an enum, integer, or opaque id. No transcript text, raw audio, SDP/ICE, or reviewable
content leaves the reducer through the observer.** The observer fires on every segment state change
(including partial-text churn within the same state), but the caller cannot infer text content from
the event — only latency, state type, and sequence ordering.

This prevents a side-channel where metrics or observability logs leak reviewable content into audit
systems. Reviewable text persists only in the in-memory snapshot that the UI renders and only leaves
the reducer via the explicit `selectCommittedVoiceTranscript()` call.

## 9. Capability gating alignment

The reducer uses `voiceMessageAllowedForProfile` from [ADR-0059](../adr/ADR-0059-voice-control-media-capability-replay-protocol.md)
to derive two predicates:

```typescript
voiceTranscriptCaptureAllowed(profile: VoiceProfile): boolean
  // true if profile permits "transcript.committed"

voiceTranscriptPreviewAllowed(profile: VoiceProfile): boolean
  // true if profile permits "transcript.partial"
```

These are the **single source of truth** for gating the transcript reducer. The wire protocol's
`VOICE_PROFILE_ALLOWED_MESSAGE_KINDS` table is authoritative:

| Profile          | Capture Allowed | Preview Allowed |
| ---------------- | --------------- | --------------- |
| `none`           | no              | no              |
| `speech-to-text` | yes             | yes             |
| `speech-output`  | no              | no              |
| `full-realtime`  | yes             | yes             |

When capture is not allowed, `apply(input)` short-circuits and returns `not-allowed-for-profile`.
When preview is not allowed, a `transcript.partial` wire message never reaches the reducer (the wire
protocol's capability gate rejects it). This ensures AC1 (dormancy) and AC3 (committed-only filtering)
are enforced at multiple layers.

## 10. Discard semantics

A `discard` input is **always** recorded as a `discarded` segment in the store, distinct from the no-op
case where an input has no effect (e.g., a commit of a non-existent id). This ensures observability:
a consumer reading `summarizeVoiceTranscript` can see that a segment existed and was discarded without
seeing the discarded text.

Repeated `discard` inputs on the same segment id are no-ops (the segment is already `discarded`).

## 11. Related systems

### Integration with turn manager (#499)

The turn manager ([ADR-0062](../adr/ADR-0062-voice-turn-manager.md)) owns floor control and emits a
`turnIndex` for deduplication of delayed transcripts. When the turn manager transitions to `idle` after
a user turn or when the user confirms `dictation-commit` in STT mode, `turnIndex` increments. The
consuming hook uses `turnIndex` together with segment `seq` to discard stale `transcript.committed`
messages that arrive after `turnIndex` has advanced.

### Integration with timing engine (#498)

The timing engine ([ADR-0061](../adr/ADR-0061-voice-timing-engine.md)) orders and buffers the wire
control stream, including transcript message kinds. It exposes `lastCommittedSeq`, the maximum sequence
number of a committed transcript received. The consuming hook can use this to determine a safe `sinceSeq`
for replay-eligible-only catch-up.

### Composer dictation (#495)

STT-only dictation captures user speech through the #494 gateway route, produces a `transcript.committed`
wire message (or `transcript.discarded` if the user cancels), and the reducer transitions the segment
through `partial` → `stable` (or straight to `committed` if the gateway returns final text) → `committed`.
The UI renders the committed projection via `snapshot().committed.text`.

### Full-realtime voice (#497)

Full-realtime captures user speech through WebRTC and produces `transcript.partial` messages (if the
provider streams partial transcripts) followed by `transcript.committed` (when the user ends their turn
or the provider finalizes). The turn manager detects end-of-turn and signals `dictation-commit` (STT-only)
or `user-end-of-turn` (full-realtime). In full-realtime, the `user-end-of-turn` is detected by VAD
(voice activity detection) via `media.track.state`, not by transcript finality.

### Recap and memory (#504)

The recap layer imports `selectCommittedVoiceTranscript` from `keiko-contracts` and the committed
projection to decide which segments to persist. The projection's structural guarantee — only committed
and corrected segments present — ensures recap never accidentally stores uncommitted, discarded, redacted,
or failed text.

### Evaluation

The evaluation layer imports `summarizeVoiceTranscript` to produce content-free evidence summaries for
model behavior analysis without retaining reviewable transcript text.

## 12. Acceptance criteria summary

| AC                                   | Satisfied by                                                                                            | Evidence                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| AC1 No-voice no side effects         | `voiceTranscriptCaptureAllowed` gate + `active` flag + short-circuit in `apply` (before clock/observer) | `profile === "none"` or `"speech-output"` → no clock read, no mutation, no observer fired         |
| AC2 STT preview + commit/discard     | `partial`/`stable` preview, `commit` → `committed`, `discard` → recorded `discarded` segment            | reducer fixtures for STT preview, commit, and discard-records-a-segment                           |
| AC3 Partial without changing context | `partial`/`stable` structurally excluded from the committed projection                                  | rapid partial churn never enters `selectCommittedVoiceTranscript`; projection guard               |
| AC4 Deterministic corrections        | Seq-based forward transitions + optional `supersedesId` replacement (no duplication)                    | correction with `seq <= existing.seq` is a no-op; superseded id excluded from the projection      |
| AC5 Consume only committed content   | Committed-only typed selector + content-free `summarizeVoiceTranscript`; content-free observer          | projection holds only `committed`+`corrected`; observer/summary carry no transcript text          |
| AC6 Tests cover the lifecycle        | Named fixtures: partial instability, late correction, discard, commit, provider-error                   | `voice-transcript-segments.test.ts` + `voice-transcript.test.ts` (100% statements/branches/lines) |

## Related

- [ADR-0063](../adr/ADR-0063-voice-transcript-segment-semantics.md): the authoritative decision record
- [ADR-0059](../adr/ADR-0059-voice-control-media-capability-replay-protocol.md): the wire protocol kinds
  and `VOICE_PROFILE_ALLOWED_MESSAGE_KINDS`
- [ADR-0061](../adr/ADR-0061-voice-timing-engine.md): the timing engine; the `VoiceClock` and replay
  semantics this spec aligns to
- [ADR-0062](../adr/ADR-0062-voice-turn-manager.md): the turn manager; the semantic signal pattern and
  `turnIndex` deduplication
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491); Issue
  [#500](https://github.com/oscharko-dev/Keiko/issues/500)
- [`packages/keiko-contracts/src/voice-transcript.ts`](../../packages/keiko-contracts/src/voice-transcript.ts):
  the contract types and functions
- [`packages/keiko-ui/src/app/components/desktop/hooks/voice-transcript-segments.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/voice-transcript-segments.ts):
  the reducer implementation
- [`docs/voice/privacy-contract.md`](privacy-contract.md): content-free observer rule; redaction seam
- [`docs/voice/architecture.md`](architecture.md): authority preservation; integration boundaries
