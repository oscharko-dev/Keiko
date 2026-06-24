# ADR-0061: Voice timing engine — local monotonic timebase, bounded buffers, backpressure, and catch-up

## Status

Accepted (Issue #498, Epic #491, 2026-06-24)

## Version

0.2.0

## Context

[ADR-0058](ADR-0058-voice-digital-twin-capability-architecture.md) makes voice optional and
capability-gated; [ADR-0059](ADR-0059-voice-control-media-capability-replay-protocol.md) defines the
versioned control/media protocol contract
([`voice-protocol.ts`](../../packages/keiko-contracts/src/voice-protocol.ts)); and
[ADR-0060](ADR-0060-realtime-voice-transport.md) realizes the **host-side** transport — the
authoritative WebSocket control plane and the WebRTC media plane — with a bounded, replay-eligible-only
server replay buffer and seq/idempotency reconciliation
([`voice-realtime.ts`](../../packages/keiko-server/src/voice-realtime.ts)).

What does not yet exist is the **client-side** counterpart: a local engine that makes a voice
interaction stay coherent when the network jitters, the provider corrects a transcript, the user
barges in, playback drifts, the socket reconnects, or the tab is backgrounded. Issue #498 builds that
engine. Its design note is explicit: "the goal is conversational coherence, not clever buffering for
its own sake — prefer explicit state transitions over hidden async queues." It must be **local-only**,
**inactive when voice capability is absent** (AC1), usable for **STT-only dictation timing without any
realtime media transport** (AC2), able to **reconcile capture / transcript / assistant / playback
timing in full-realtime mode** (AC3), **bounded with explicit overflow behavior** (AC4), **covered by
deterministic fixtures for out-of-order / delayed / duplicate / interrupted / corrected events**
(AC5), and to **emit metrics that exclude raw audio and transcript payloads** (AC6).

The engine consumes the existing protocol; it introduces no new wire types, no new dependency, and no
transport. It is the symmetric, client-side mirror of the server reconciliation that ADR-0060 already
ships.

## Decision

### D1 — Placement: a pure injectable module in `keiko-ui`, not in `keiko-contracts` or the server

The engine lives at
[`packages/keiko-ui/src/app/components/desktop/hooks/voice-timebase.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/voice-timebase.ts)
(+ `voice-timebase.test.ts`), co-located with the existing pure factory seams `dictation-recorder.ts`,
`voice-rtc-transport.ts`, and `voice-realtime-client.ts`. It is a **pure, non-React factory module**
(`createVoiceTimebaseEngine(...)`) with injectable seams, imported by the existing hooks
(`useDictation`, `useRealtimeVoice`) via relative path — exactly the established convention.

Rationale: the engine is a UI-consumer concern, not a wire contract. The leaf-package rule (ADR-0019)
forbids `keiko-contracts` from depending on anything, and the engine depends on the browser clock and
on capability-resolution types, so it cannot live there; it only *imports* the contract's frozen types
and classification helpers. It is not server code — the server's reconciliation already exists
(ADR-0060) and the two planes are deliberately symmetric, not shared. `keiko-ui` is excluded from the
published tarball ([`scripts/package-surface-rules.mjs`](../../scripts/package-surface-rules.mjs)), so
this module has **no package-surface impact** and needs no barrel export and no surface-contract update.

### D2 — A local monotonic `VoiceClock` seam over `performance.now()`

The engine reads time through an injected `VoiceClock { now(): number }` whose production
implementation, `createBrowserVoiceClock()`, returns `performance.now()`. Tests inject a fake clock
that advances deterministically.

Rationale: a timing engine that reconciles capture, transcript, playback, and catch-up needs a
**monotonic** source. `performance.now()` is monotonic and browser-native and is the correct source
for a "monotonic timebase." We deliberately do **not** reuse the canonical `Clock` in
`keiko-model-gateway`: it is `Date.now()` (wall-clock — non-monotonic, jumps on NTP / DST / clock
adjustment) and importing it would create a cross-package edge from a UI leaf module into a server
package. We deliberately do **not** call `performance.now()` directly either: a hard dependency on a
global would make the engine non-deterministic and untestable, violating the local-seam convention the
sibling modules already follow. The clock is the single injected source of "now"; the engine performs
no other IO, randomness, or persistence.

### D3 — An explicit synchronous reducer core, no hidden async queues

The engine is a synchronous state machine. `ingest(message)` is a single reducer step:
classify → gate by profile → seq dedup / ordering check → apply state transition → bound-buffer →
metrics. It returns a result describing what happened; it never schedules timers, never `await`s,
never owns a microtask queue. Time enters only through the injected clock, read once per ingest. The
consumer (a hook) drives ingest as messages arrive and reads the engine's plain, synchronous,
read-only state snapshot to render.

Rationale: the design note mandates explicit state transitions over hidden async queues. A synchronous
reducer is deterministically testable (drive it with a scripted clock + event sequence and assert the
resulting snapshot), keeps every code path explicit, and makes "backpressure" an *observable signal*
rather than an unbounded internal queue.

### D4 — Bounded buffers with drop-oldest overflow and an observable overflow count (AC4)

The engine retains a single bounded ring of **replay-eligible** timed records for catch-up, capacity
`VOICE_TIMEBASE_REPLAY_CAPACITY = 200` (matching the server's `MAX_REPLAY_EVENTS`, ADR-0060). Only
kinds for which `isVoiceReplayEligible(kind)` is true are retained; ephemeral kinds
(`transcript.partial`, SDP / ICE) and raw media are never buffered. On overflow the oldest record is
dropped (`shift`), a monotonically increasing `overflowCount` is incremented, and that count is
exposed on the read-only snapshot and on the metrics observer. A separate small bounded log of recent
**partial-transcript** records (capacity `VOICE_TIMEBASE_PARTIAL_CAPACITY = 32`) supports live preview
without growing unbounded; partials are ephemeral and are never part of catch-up.

### D5 — Backpressure is an explicit readable signal, never an internal queue

When the replay buffer depth crosses a high-water mark
(`VOICE_TIMEBASE_BACKPRESSURE_HIGH = 160` = 80% of capacity), the snapshot's `backpressure` field
flips from `"none"` to `"elevated"`; once overflow has actually evicted records it reports
`"saturated"`. This is a plain enum the UI consumer reads to decide whether to slow or coalesce
rendering (e.g. throttle partial-transcript repaint). The engine itself never blocks, never buffers
extra, and never drops *semantic* events to relieve pressure beyond the documented drop-oldest
overflow — backpressure is advisory and observable, consistent with the "no hidden async queues"
mandate. The same signal abstracts the three congestion sources named in the issue (slow UI rendering,
delayed provider responses, data-channel / WebSocket congestion): all three manifest as buffer-depth
growth, which is the single thing the engine measures.

### D6 — Catch-up / reconnect semantics: replay-eligible only, never raw audio, never ephemeral

After a reconnect or a tab-visibility resume, the consumer calls `catchUp({ sinceSeq })`, where
`sinceSeq` is the last host sequence number the client durably applied. The engine returns the
buffered replay-eligible timed records with `seq > sinceSeq`, in seq order. Raw audio is never returned
(it is media-plane and has no control kind — it never entered the engine); ephemeral kinds (partial
transcripts, SDP / ICE) are never returned (they were never buffered); re-delivered events the engine
has already applied are idempotently ignored by the same seq rule that governs live ingest (D7). This
is the client mirror of the server's bounded replay (ADR-0060 D3). Catch-up replays *control state*,
not media; raw audio is never replayed by default, satisfying the epic's raw-audio invariant.

### D7 — Seq-based dedup and out-of-order rejection, consistent with the wire protocol

The envelope's per-direction `seq` is monotonic (ADR-0059). The engine tracks the highest applied
host→client `seq`. A message whose `seq` is less than or equal to the highest applied seq is a
duplicate or stale reorder and is **ignored** (a no-op recorded as `"duplicate"` or `"out-of-order"` in
the ingest result and as a content-free metric), mirroring the server's `seq <= lastClientSeq`
idempotency guard. A `transcript.discarded` or a replacing `transcript.committed` is a provider
*correction* and is applied as a normal forward-seq transition (it does not rewrite history; it
advances it), so a correction is reconciled rather than dropped.

### D8 — Capability gating: dormant, transcript-scoped, or fully reconciling (AC1 / AC2 / AC3)

The engine is constructed with the resolved profile (a `VoiceProfile`, derivable from the existing
`VoiceCapabilityResolution`). Gating reuses the contract's
`VOICE_PROFILE_ALLOWED_MESSAGE_KINDS` / `voiceMessageAllowedForProfile(kind, profile)` — it is not
re-encoded here:

- `none` (or an unavailable / undefined resolution): the engine is **dormant**. It initializes to an
  inert idle state, ingests nothing (every message is rejected as `"not-allowed-for-profile"`), buffers
  nothing, and emits no metrics beyond construction. This is AC1: the engine does not initialize an
  active timebase in no-voice mode.
- `speech-to-text`: the engine is **transcript-scoped**. Only the dictation transcript subset is
  admitted; `media.track.state`, `playback.state`, `control.interrupt`, and all signaling are rejected
  by the profile gate, so STT-only dictation gets transcript timing **without** requiring any realtime
  media transport (AC2).
- `speech-output`: playback + interrupt timing, no transcript-input or signaling (per the contract
  table).
- `full-realtime`: every kind is admitted; the engine reconciles capture (`media.track.state`),
  transcript lifecycle, assistant response (`playback.state`), interruption, and catch-up (AC3).

### D9 — Metrics: content-free observer only; no raw audio, no transcript text (AC6)

The engine accepts an optional, non-blocking `VoiceTimebaseMetricsObserver` whose every method is
called as `observer?.onX?.(...)`. Metrics may carry **only** content-free data: the message `kind`,
`seq`, the `VoiceRedactionClass` of the kind, latency in ms (clock deltas), buffer depth, overflow
count, backpressure level, and the ingest outcome enum. The observer is **forbidden** to receive
transcript text, raw audio (which the engine never sees), SDP / ICE / credential strings, or any
`reviewable-text` / `secret-bearing` / `raw-media` payload. The redaction class is taken from the
contract's `voiceControlMessageRedactionClass(kind)`, so the privacy boundary is data-driven and
cannot silently drift (privacy-contract §2 / §3, ADR-0058 D6).

### D10 — No new dependency; engine + tests + metrics hooks only; rendering wiring deferred

This issue ships the deterministic **engine**, its tests, and its metrics hooks as the runtime
foundation. It adds **no** third-party timing / stream / queue package — the buffers are plain arrays,
the state machine is a switch, time is `performance.now()`. Wiring the engine into the
`useDictation` / `useRealtimeVoice` render path is **out of scope** ("Full UI rendering"), and is
deferred. To keep the module consumable rather than dead, the integration seams are documented exactly
(see the implementation spec): hooks construct the engine with the resolved profile + a browser clock,
call `ingest(message)` on each control message they already receive, optionally pass a metrics
observer, read `snapshot()` to render, and call `catchUp({ sinceSeq })` on reconnect / visibility
resume.

## Consequences

### Positive

- The client gains a deterministic, fully testable coherence layer symmetric to the server's
  reconciliation, with no hidden async behavior and no new dependency.
- AC1 dormancy, AC2 STT-only scoping, and AC3 full reconciliation fall out of reusing the contract's
  one gating table — there is a single source of truth for what each profile admits.
- Bounded buffers + an explicit overflow count + an advisory backpressure enum make memory growth and
  congestion observable and provably bounded (AC4), without the engine ever blocking or hiding a queue.
- The privacy boundary (AC6) is data-driven by the frozen redaction-class table, so it cannot drift.

### Negative

- The engine ships before its render consumers, so it is foundation code with documented-but-unused
  integration seams until the rendering issue lands; a reviewer must confirm the seams are real, not
  speculative.
- Backpressure as an advisory enum pushes the actual throttling decision onto the future UI consumer;
  the engine cannot itself guarantee the UI keeps up.

### Neutral

- The engine deliberately duplicates the *shape* of the server's seq / idempotency / replay logic
  rather than sharing code, because the two planes are independent and the contract (not shared code) is
  the coupling point.
- `performance.now()` resolution may be coarsened by the browser for privacy; the engine treats time
  only as monotonically non-decreasing ms and never assumes sub-ms precision.

## Alternatives Considered

### Alternative 1: Put the engine (and its types) in `keiko-contracts`

- **Pros**: one home for everything voice; reusable by a hypothetical second consumer.
- **Cons**: violates the leaf-package rule — the engine needs a clock and is stateful, neither of which
  a pure contract leaf may contain; would force the contract to grow runtime behavior.
- **Why rejected**: the contract is frozen pure data + validators (ADR-0059); the engine is a stateful
  UI consumer of it. Mixing them breaks ADR-0019 dependency direction.

### Alternative 2: Reuse the gateway `Clock` abstraction

- **Pros**: one clock seam repo-wide; already injected in other packages.
- **Cons**: it is `Date.now()` (wall-clock, non-monotonic) and lives in a server package, creating a
  UI→server import edge and giving a *timing* engine a clock that can jump backward.
- **Why rejected**: a monotonic timebase requires `performance.now()`; D2 records why wall-clock and
  the cross-package edge are both wrong here.

### Alternative 3: An async queue / stream abstraction (RxJS-style observables or an internal async buffer)

- **Pros**: ergonomic backpressure operators; familiar streaming model.
- **Cons**: adds a third-party dependency (forbidden by the epic), hides control flow in async queues
  (directly against the design note), and is far harder to test deterministically.
- **Why rejected**: the issue mandates explicit state transitions and no new stream / queue package; a
  synchronous reducer with an advisory backpressure enum meets the goal with zero dependencies.

### Alternative 4: Replay raw audio on catch-up to reconstruct exact playback

- **Pros**: bit-exact reconstruction of what the user heard.
- **Cons**: raw audio is media-plane, never persisted or replayed (epic invariant, ADR-0059 D5),
  privacy-hostile, and unbounded.
- **Why rejected**: catch-up replays *control state* up to the last applied seq; "without replaying
  raw audio by default" is an explicit issue requirement and an epic invariant.

## References

- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491); Issue
  [#498](https://github.com/oscharko-dev/Keiko/issues/498).
- [ADR-0058](ADR-0058-voice-digital-twin-capability-architecture.md) (capability gating, D6 security),
  [ADR-0059](ADR-0059-voice-control-media-capability-replay-protocol.md) (protocol, replay / redaction
  classes, gating table), [ADR-0060](ADR-0060-realtime-voice-transport.md) (server reconciliation,
  bounded replay, seq / idempotency).
- [`docs/voice/privacy-contract.md`](../voice/privacy-contract.md) — the privacy / redaction boundary;
  [`docs/voice/protocol.md`](../voice/protocol.md) — the normative protocol.
- Contract consumed: [`packages/keiko-contracts/src/voice-protocol.ts`](../../packages/keiko-contracts/src/voice-protocol.ts),
  capability types in [`packages/keiko-contracts/src/gateway.ts`](../../packages/keiko-contracts/src/gateway.ts).
- Co-located precedents:
  [`packages/keiko-ui/src/app/components/desktop/hooks/dictation-recorder.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/dictation-recorder.ts),
  [`voice-rtc-transport.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/voice-rtc-transport.ts),
  [`voice-realtime-client.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/voice-realtime-client.ts).

## Date

2026-06-24
