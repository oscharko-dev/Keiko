# ADR-0063: Voice transcript segment semantics — provider-neutral segment lifecycle, reducer, and committed-only integration boundary

## Status

Accepted (Issue #500, Epic #491, 2026-06-24)

## Version

0.2.0

## Context

[ADR-0058](ADR-0058-voice-digital-twin-capability-architecture.md) makes voice optional and
capability-gated; [ADR-0059](ADR-0059-voice-control-media-capability-replay-protocol.md) defines the
wire protocol with `transcript.partial`, `transcript.committed`, and `transcript.discarded` wire kinds;
[ADR-0060](ADR-0060-realtime-voice-transport.md) realizes the server-side WebSocket control plane and
bounded replay buffer; [ADR-0061](ADR-0061-voice-timing-engine.md) ships the client-side timing engine
(`voice-timebase.ts`) — the monotonic clock and buffer management; and
[ADR-0062](ADR-0062-voice-turn-manager.md) ships the floor-control layer (`voice-turn-manager.ts`).

What is **missing** is the provider-neutral transcript segment **lifecycle**: a data contract and
reducer that bridge the wire protocol's three transcript message kinds onto a richer semantic model
needed by consumers. The wire carries only three kinds (`transcript.partial`, `transcript.committed`,
`transcript.discarded`), but the lifecycle requires seven segment states to express the full journey
from uncertain in-flight text through provider stabilization, user commitment, provider corrections,
and terminal discards/redactions/errors — exactly as the turn manager (ADR-0062) maps a richer
semantic signal union onto the same wire catalog.

Issue #500 delivers this layer: a new leaf-package contract in `keiko-contracts` (no `@oscharko-dev/*`
imports, no package-surface impact) that holds the state catalog, transition table, classification
tables, integration boundary predicates, and validators; and a synchronous deterministic reducer in
`keiko-ui` (`voice-transcript-segments.ts`, tarball-excluded, no package-surface impact) that drives
state changes, manages the committed-only projection, and fires a content-free observer.

## Decision

### D1 — Provider-neutral segment lifecycle as a new leaf contract (AC1 / AC3 / AC5)

The transcript segment lifecycle is defined by a new, pure-data leaf contract at
[`packages/keiko-contracts/src/voice-transcript.ts`](../../packages/keiko-contracts/src/voice-transcript.ts).
It contains no IO, no async, no provider-specific URLs or credentials, and no raw audio buffers. It is
exclusively types, constants, classification tables, and pure functions (`mapWireKindToVoiceTranscriptSegmentState`,
`selectCommittedVoiceTranscript`, `summarizeVoiceTranscript`, etc.). It is a **sibling, not an edit** to
the #496 wire protocol contract (`voice-protocol.ts`). It respects the leaf-package rule (ADR-0019):
the contract imports only from `./gateway.js` and `./voice-protocol.js` via relative path. The root
`index.ts` does not re-export keiko-contracts — the contract has **zero package-surface impact**.

The contract is SERVER-IMPORTABLE (keiko-server #503 and #504 need the committed-only selector and
content-free types without pulling keiko-ui), whereas the stateful reducer is keiko-ui-only (the
store carries transcript text, which the server has no consumer for). This split enables #503 and
#504 to enforce committed-only consumption at the type level while leaving the reducer in keiko-ui
where it co-locates with the other deterministic voice engines (`voice-timebase.ts`, `voice-turn-manager.ts`).

### D2 — Seven segment states with VOICE_TRANSCRIPT_SCHEMA_VERSION="1" independent of wire version (AC2 / AC3)

```
VoiceTranscriptSegmentState:
  "partial"        — uncertain in-flight text; provider is refining. Ephemeral; never downstream.
  "stable"         — provider marked final; user has not committed. Reviewable; never downstream.
  "committed"      — user or turn manager committed the text. The ONLY consumable state (with corrected).
  "corrected"      — provider correction superseded a prior committed/stable segment. Consumable.
  "discarded"      — user / turn manager discarded. Content-free; excluded downstream.
  "redacted"       — reviewable text was redacted (privacy). Content-free; excluded downstream.
  "provider-error" — provider failed to transcribe. Content-free; excluded downstream.
```

The wire protocol knows exactly three transcript message kinds: `transcript.partial`, `transcript.committed`,
and `transcript.discarded`. These establish an initial state via `mapWireKindToVoiceTranscriptSegmentState`:
- `transcript.partial` → `partial`
- `transcript.committed` → `committed`
- `transcript.discarded` → `discarded`

Four states have no wire kind: `stable`, `corrected`, `redacted`, `provider-error`. These are derived
or internal states the reducer produces in response to semantic inputs (e.g. `stabilize`, `correct`,
`redact`, `providerError`), the same design principle ADR-0062 uses. This asymmetry is load-bearing:
a strict 1:1 wire-to-state map would make AC4 (provider corrections) and AC6 (error handling) impossible
without doubling the wire catalog.

`VOICE_TRANSCRIPT_SCHEMA_VERSION = "1"` evolves by the same immutable rule as other contract schemas:
a breaking change introduces a new literal member, never a mutation of `"1"`. It is **independent of**
`VOICE_PROTOCOL_VERSION` (the wire version) and `CONVERSATION_CAPABILITY_CONTRACT_VERSION` (the
capability-registry contract). A build understands only the versions it declares as supported.

### D3 — Frozen transition table and per-state classification (AC3 / AC5 / AC6)

`VOICE_TRANSCRIPT_SEGMENT_TRANSITIONS` is a complete, total table: every state maps to a list of
reachable states via a state-changing transition. Repeated operations that hold the state (partial-text
churn, duplicate corrections) are text updates, not transitions, so they are intentionally absent.
`discarded` and `redacted` are terminal — no transitions leave them. This design ensures adding a
state without updating the table is a compile error (via `assertNeverVoiceTranscriptSegmentState`).

Two totality-keyed classification tables align states to the wire-protocol classes:

- **`VOICE_TRANSCRIPT_SEGMENT_REPLAY`**: durable, committed states (`committed`, `corrected`, `discarded`,
  `redacted`, `provider-error`) are `replayable` (preserved across reconnect); in-flight previews
  (`partial`, `stable`) are `ephemeral` (never replayed). This mirrors `transcript.partial` and
  `transcript.committed` replay semantics.
- **`VOICE_TRANSCRIPT_SEGMENT_REDACTION`**: text-bearing states (`partial`, `stable`, `committed`,
  `corrected`) are `reviewable-text` (must pass through `stripUnsafeFormatChars` + redact-at-persist);
  content-free states (`discarded`, `redacted`, `provider-error`) are `content-free` (no redaction overhead).

### D4 — Reducer in keiko-ui; split contract/reducer for server-importability (AC1 / AC3 / AC5)

The stateful reducer `createVoiceTranscriptSegmentStore` lives at
[`packages/keiko-ui/src/app/components/desktop/hooks/voice-transcript-segments.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/voice-transcript-segments.ts)
(+ tests), co-located with `voice-timebase.ts` and `voice-turn-manager.ts`, mirroring ADR-0061 and
ADR-0062 pattern. It is a pure factory (`createVoiceTranscriptSegmentStore(options)`) with injectable
seams: a `VoiceProfile` for capability gating, a `VoiceClock` (reused from `voice-timebase.ts`), and
an optional `VoiceTranscriptStoreObserver` (content-free, see D8). It is a synchronous, deterministic
reducer (no timers, no async, no hidden microtask queues) with a single `apply(input)` entry point.

**Why split?** The reducer is keiko-ui-only because it holds transcript text in its internal segments
array — reviewable content that only the UI renders. The contract (`keiko-contracts`) is server-importable
because #503 (governed spoken actions) and #504 (recap / memory) need `selectCommittedVoiceTranscript()`
and `summarizeVoiceTranscript()` to enforce committed-only access without importing the UI. The contract's
type `CommittedVoiceTranscriptProjection` and predicate `isCommittedVoiceTranscriptState` become the
server-side check against unauthorized use of uncommitted or redacted text. `keiko-ui` is tarball-excluded
([`scripts/package-surface-rules.mjs`](../../scripts/package-surface-rules.mjs)), so the reducer adds
**zero package-surface impact** and needs no barrel export.

### D5 — Deterministic correction semantics (AC4)

Provider corrections arrive as a new segment (or as a new state for an existing segment by `id`) with
a `seq` that must be strictly greater than the segment it updates. A correction carries an optional
`supersedesId` naming the prior segment whose text it replaces.

Duplicate or out-of-order corrections are deterministic no-ops: a correction with `seq <= existing.seq`
is ignored, and a stale seq is rejected by the reducer. When a correction supersedes a prior committed
segment by id, the committed projection (D6) structurally excludes the superseded id from the result set.
This makes a provider correction **replace** the prior text (never duplicate) deterministically.

A `revision` counter tracks text-changing corrections per segment without storing raw audio or provider
payloads. The counter increments with each `correct` transition (initial `revision: 0`; first correction
`revision: 1`). This is the local correction-history depth available for observability without
violating the content-free observer rule (D8).

### D6 — AC5 committed-only integration boundary via typed selector (AC2 / AC3 / AC5)

`selectCommittedVoiceTranscript(segments)` is the **single integration boundary** through which
composer dictation (#495), full-realtime voice (#497), recap (#504), and evaluation may consume
transcript text. It returns a `CommittedVoiceTranscriptProjection`:

```
{
  schemaVersion: "1",
  segments: readonly VoiceTranscriptSegment[],  // committed + corrected only
  text: string,                                  // concatenation of non-empty segment text
  segmentCount: number
}
```

The projection contains only `committed` and `corrected` segments (keyed by `isCommittedVoiceTranscriptState`),
sorted deterministically by `seq` (ties broken by `id` lexicographically), and excludes segments that a
`corrected` segment supersedes (by `supersedesId`). Partial, stable, discarded, redacted, and provider-error
segments can **never** appear in the projection. A consumer that reads only this projection is structurally
protected against consuming uncommitted, discarded, redacted, or failed text (AC3 / AC5).

`summarizeVoiceTranscript(segments)` produces a content-free roll-up for evidence and recap:

```
{
  schemaVersion: "1",
  segmentCount: number,
  committedCount: number,
  correctedCount: number,
  discardedCount: number,
  redactedCount: number,
  providerErrorCount: number,
  committedChars: number,        // character count only, never text
  highestSeq: number
}
```

This is the only transcript representation permitted to enter an evidence manifest without first
passing reviewable text through the redact-at-persist seam.

No consumer exists yet (#503 / #504 are downstream, out of scope). AC5 is satisfied structurally today
by the absence of a consumer — the integration boundary is defined and typed; its wiring is deferred.

### D7 — AC1 dormancy and AC3 committed-only by construction (AC1 / AC2 / AC3)

When `profile === "none"` or `profile === "speech-output"`, `voiceTranscriptCaptureAllowed(profile)`
returns `false`. The reducer is constructed with this profile and initializes `active = false`. Every
call to `apply(input)` short-circuits before reading the clock, mutating any segment, or calling the
observer: it returns `{ outcome: "not-allowed-for-profile", snapshot }` and remains silent (AC1).

When `profile === "speech-to-text"`, `voiceTranscriptCaptureAllowed(profile)` returns `true` and the
reducer is active. However, the wire protocol's capability gating (ADR-0059 D4) already forbids
`transcript.partial` and `transcript.committed` messages from arriving in `speech-output` profile (they
are not in `VOICE_PROFILE_ALLOWED_MESSAGE_KINDS["speech-output"]`). Similarly, `media.track.state` and
`signal.sdp.*` messages never arrive in `speech-to-text` profile. The reducer therefore **receives only
messages its profile permits** — capability gating in keiko-contracts is the authoritative gate (AC1 / AC2 / AC3).

For AC3 enforcement: partial and stable segments are structurally excluded from the committed projection,
and discarded/redacted/provider-error are content-free. A consumer reading only the projection is type-protected
against using any non-committed text.

### D8 — Content-free observer; no transcript text, no raw audio (AC6)

The reducer accepts an optional `VoiceTranscriptStoreObserver` called via optional chaining. It fires
two event types, both content-free:

```
onSegment?(event: {
  id: string;                              // opaque id, never content
  inputKind: VoiceTranscriptInputKind;     // enum: "partial" | "stabilize" | "commit" | ...
  from: VoiceTranscriptSegmentState | undefined;
  to: VoiceTranscriptSegmentState;
  seq: number;
  revision: number;
  latencyMs: number;                       // clock.now() - previous apply
}): void

onCommit?(event: {
  committedCount: number;
  committedChars: number;                  // character COUNT only, never text
}): void
```

Transcript text never reaches the observer. Only state enums, sequence integers, segment counts,
character counts, and millisecond deltas leave the reducer. Reviewable text persists only in the
in-memory snapshot the UI renders and only leaves the reducer via the explicit `selectCommittedVoiceTranscript()`
call (which the server consumes without logging or observing). This prevents a side channel where
observability logs leak reviewable content (privacy-contract §2 / §3).

### D9 — Discard is always recorded; empty committed string is valid (AC5 / AC6)

A `discard` input is **always** recorded as a content-free `discarded` segment in the store, distinct
from the no-op case where an input has no effect (e.g. a commit of a non-existent id). This ensures
that a consumer reading `summarizeVoiceTranscript` can see that a segment existed and was discarded,
without seeing the discarded text.

An empty committed string is structurally valid and distinct from a `discarded` segment: if all committed
segments have empty text (e.g. whitespace-only speech that `stripUnsafeFormatChars` or redaction made empty),
the projection's `text` is empty but the `segmentCount` is non-zero. This is rare but correct. A `discard`
input makes a segment `discarded`, which contributes 0 to the committed projection.

## Consequences

### Positive

- AC1 (dormancy), AC2 (STT-only gating), AC3 (committed-only projection), AC5 (no side channels), and
  AC6 (content-free observer) fall out of the contract's totality tables and the reducer's structural guards.
- The committed-only selector is a type-level guarantee: a server-side consumer cannot compile-check
  a call to `selectCommittedVoiceTranscript()` without understanding its scope.
- The transition table is total and explicit; adding a state is a compile error. Corrections and provider
  errors have explicit legal states without requiring a ninth state or a re-encoding of the wire catalog.
- Provider corrections are deterministic: a later `corrected` segment with a higher `seq` replaces a
  prior segment's text by `supersedesId` without duplication or ambiguity.
- The same lifecycle serves both STT dictation (#495) and full-realtime voice (#497) without special
  casing — a single "same model" as the issue requires.

### Negative

- The reducer ships before its server-side consumers (#503 / #504), so it is foundation code with
  documented-but-unused integration seams until those issues land.
- The split between contract and reducer means server-side code must import `keiko-contracts` and
  ui-side code must import the reducer from `keiko-ui` — they cannot be symmetric. This is unavoidable
  because the server cannot import text-bearing state from the UI.

### Neutral

- `summarizeVoiceTranscript` must be called explicitly to produce the evidence roll-up; it is not
  cached on the snapshot. This is intentional — the observer fires on every segment transition, but the
  summary is computed only when needed, avoiding redundant counting.
- The content-free observer fires for every transition, including text updates to in-flight partials.
  This is accurate (a partial's latency matters) but produces a dense event stream; a consuming hook
  may want to sample or debounce.

## Alternatives Considered

### Alternative 1: Embed transcript state inside the turn manager (ADR-0062)

- **Pros**: one module to construct; shared clock instance; unified signal union.
- **Cons**: the turn manager's responsibility is floor control (state transitions, effects, speaker);
  transcript state is orthogonal (input handling, text updates, corrections). Merging them violates
  separation of concerns and approaches the 1000+ LOC review threshold (ADR-0019). The turn manager
  already owns `pendingCommit` and `turnIndex` (orthogonal to floor state); adding a parallel segment
  store invites state/transcript divergence.
- **Why rejected**: the turn manager can be unit-tested without transcripts; the transcript reducer can
  be unit-tested without turn state. The boundary is clean.

### Alternative 2: A single 1:1 wire-to-state map (three states only)

- **Pros**: simpler; fewer states to test; smaller transition table.
- **Cons**: makes AC4 (provider corrections) impossible without either re-sending the corrected text
  under the same wire kind (lossy) or adding new wire kinds. AC6 (error handling) would require
  encoding errors as a fourth transcript kind or inventing a parallel error message. The history of
  changes (revision count) cannot be preserved.
- **Why rejected**: the issue explicitly requires AC4 deterministic corrections and AC6 provider-error
  handling. A 1:1 map was considered and rejected during design for being insufficient.

### Alternative 3: Treat corrections as a separate record type

- **Pros**: corrections are explicitly their own thing; no supersedesId field pollutes the base segment type.
- **Cons**: the committed projection must then join two tables (segments + corrections) at query time,
  which is more complex and error-prone. The correction key (seq and id) is identical to the segment's;
  merging them is natural.
- **Why rejected**: a single segment record with optional supersedesId is simpler and type-safe; the
  alternative introduces join-at-query-time complexity.

### Alternative 4: Defer the server-side commitment check to a hook wrapper

- **Pros**: the contract could be simpler; server-side validation is a wrapper, not a type.
- **Cons**: runtime errors instead of compile-time errors; a future server-side consumer could
  accidentally import and call the reducer directly, bypassing the wrapper. The type boundary is the
  best safety mechanism.
- **Why rejected**: type-level enforcement is stronger than runtime guards. The typed selector is the
  authoritative boundary.

## Related

- [ADR-0058](ADR-0058-voice-digital-twin-capability-architecture.md): capability gating; D1 (no new
  authority); D6 (security review contract)
- [ADR-0059](ADR-0059-voice-control-media-capability-replay-protocol.md): the protocol kinds
  (`transcript.partial`, `transcript.committed`, `transcript.discarded`) and `VOICE_PROFILE_ALLOWED_MESSAGE_KINDS`
- [ADR-0060](ADR-0060-realtime-voice-transport.md): server-side control plane, bounded replay buffer,
  seq/idempotency
- [ADR-0061](ADR-0061-voice-timing-engine.md): the timing engine; the `VoiceClock` seam this reducer reuses
- [ADR-0062](ADR-0062-voice-turn-manager.md): the floor-control layer; the semantic signal pattern and
  capability-gating approach this ADR mirrors
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491); Issue
  [#500](https://github.com/oscharko-dev/Keiko/issues/500)
- [`docs/voice/transcript-semantics.md`](../voice/transcript-semantics.md): detailed spec and state lifecycle
- [`docs/voice/privacy-contract.md`](../voice/privacy-contract.md): content-free observer invariant (§2 / §3)
- [`packages/keiko-contracts/src/voice-transcript.ts`](../../packages/keiko-contracts/src/voice-transcript.ts):
  the contract (types, constants, validators, classification tables, selectors)
- [`packages/keiko-ui/src/app/components/desktop/hooks/voice-transcript-segments.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/voice-transcript-segments.ts):
  the reducer (factory, state machine, observer, snapshot)

## Date

2026-06-24
