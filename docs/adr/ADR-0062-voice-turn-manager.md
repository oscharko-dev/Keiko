# ADR-0062: Voice Turn Manager — floor control, barge-in, and end-of-turn semantics

## Status

Accepted (Issue #499, Epic #491, 2026-06-24)

## Version

0.2.0

## Context

[ADR-0058](ADR-0058-voice-digital-twin-capability-architecture.md) makes voice optional and
capability-gated; [ADR-0059](ADR-0059-voice-control-media-capability-replay-protocol.md) defines the
wire protocol including `control.interrupt`, `playback.state`, `media.track.state`,
`transcript.committed`, and `transcript.discarded`; [ADR-0060](ADR-0060-realtime-voice-transport.md)
realizes the server-side WebSocket control plane and the bounded replay buffer; and
[ADR-0061](ADR-0061-voice-timing-engine.md) ships the client-side timing engine
([`voice-timebase.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/voice-timebase.ts)) —
the symmetric client mirror of the server reconciliation — with its injectable `VoiceClock` seam,
synchronous-reducer core, and content-free metrics observer.

What the timing engine deliberately does **not** do is decide *who holds the conversational floor*,
when a turn has ended, how a barge-in should alter both the playback and the next-turn state, or what
the semantic difference is between "end-of-turn detected by silence" and "user confirms dictation
commit" in STT mode. Issue #499 builds that layer. Its scope is explicit: eight turn states;
capability-gated full floor control only when the provider supports realtime or speech-output; barge-in
that stops/suppresses playback and preserves local transcript context; backchannel events that
acknowledge hearing without creating commitments; the distinction between end-of-turn detection and
send/commit in STT dictation; safe local events for UI state and evaluation; and isolation from
provider failures and permission denial so text chat is never broken. The turn manager is the semantic
layer that sits above the timing engine's ordered stream and below the UI hook that drives rendering.

Three prior-art patterns were consulted during design:

- The W3C WebRTC Working Group's floor control note (no standard exists; floor control is
  application-layer).
- OpenAI Realtime API event taxonomy (`input_audio_buffer.speech_started`, `response.done`,
  `conversation.item.input_audio_transcription.completed`) — the existing contract already captures the
  equivalent kinds; the manager consumes them, never invents parallel ones.
- The [#498 timing engine pattern](ADR-0061-voice-timing-engine.md): factory + injectable clock +
  synchronous reducer + `Record<Kind,...>` totality tables + content-free observer.

## Decision

### D1 — Placement: a pure injectable module in `keiko-ui`, co-located with `voice-timebase.ts` (AC1)

The turn manager lives at
[`packages/keiko-ui/src/app/components/desktop/hooks/voice-turn-manager.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/voice-turn-manager.ts)
(+ `voice-turn-manager.test.ts`), co-located with `voice-timebase.ts`, `dictation-recorder.ts`,
`voice-rtc-transport.ts`, and `voice-realtime-client.ts`. It is a **pure, non-React factory module**
(`createVoiceTurnManager(...)`) with injectable seams, reusing `VoiceClock` and
`createBrowserVoiceClock` from `voice-timebase.ts` via relative path — the convention ADR-0061
established. `keiko-ui` is excluded from the published tarball
([`scripts/package-surface-rules.mjs`](../../scripts/package-surface-rules.mjs)), so this module has
**no package-surface impact**, needs no barrel export, and needs no surface-contract update. The
leaf-package rule (ADR-0019) is preserved: the turn manager imports only from `keiko-contracts` (the
voice protocol types and helpers) and from the sibling `voice-timebase.ts` clock seam; it adds no new
cross-package edge.

The turn manager is a semantic layer **above** the timing engine, not a replacement for it. A future
hook may compose both: feed every control message to the timing engine for ordering and replay, and
feed the semantic-signal union to the turn manager for floor and state decisions. The two engines are
independent; neither depends on the other.

### D2 — Factory `createVoiceTurnManager({ profile, clock?, observer? })` mirrors ADR-0061 exactly (AC1 / AC6)

The factory signature is:

```
createVoiceTurnManager(options: VoiceTurnManagerOptions): VoiceTurnManagerEngine

interface VoiceTurnManagerOptions {
  readonly profile: VoiceProfile;
  readonly clock?: VoiceClock;
  readonly observer?: VoiceTurnManagerObserver;
}

interface VoiceTurnManagerEngine {
  apply(signal: VoiceTurnSignal): VoiceTurnApplyResult;
  snapshot(): VoiceTurnSnapshot;
  reset(): void;
}
```

`apply(signal)` is the single synchronous reducer step: classify signal → gate by profile →
state-transition table → effect emission → snapshot. It never schedules timers, never `await`s, and
never owns a microtask queue. Time enters only through the injected `VoiceClock` (production:
`createBrowserVoiceClock()` → `performance.now()`; tests: a scripted deterministic clock). The
consumer drives `apply` as signals arrive from the UI or from decoded control messages, and reads
`snapshot()` to render. `reset()` returns to the initial fresh state for the resolved profile.

### D3 — Eight turn states with explicit `disabled` vs `recovering` distinction (AC1 / AC4 / AC6)

```
VoiceTurnState:
  "idle"         — no turn in progress; manager ready; floor is unoccupied
  "listening"    — user is speaking; floor held by user
  "thinking"     — user turn ended (detected); assistant is processing; floor held by assistant
  "speaking"     — assistant is generating/playing speech; floor held by assistant
  "interrupted"  — user issued barge-in; playback must stop; floor unoccupied pending handoff
  "yielding"     — assistant speech ended normally (cooperative); brief handoff window
  "recovering"   — recoverable provider failure; reconnect in progress; floor unoccupied
  "disabled"     — terminal: profile=none, permission denied, or non-recoverable failure
```

The floor holder is **derived from state** via a total table (never stored as a separate field) and
exposed on the snapshot for UI rendering:

| State       | FloorHolder |
| ----------- | ----------- |
| idle        | none        |
| listening   | user        |
| thinking    | assistant   |
| speaking    | assistant   |
| interrupted | none        |
| yielding    | none        |
| recovering  | none        |
| disabled    | none        |

When `profile === "none"`, `createVoiceTurnManager` initializes to `disabled` immediately. No signal
is ever processed; `apply` returns `{ outcome: "not-allowed-for-profile", effects: [], snapshot }`
for every call without reading the clock or calling the observer — identical to the timing engine's
dormant pattern (AC1).

### D4 — Input signal union: semantic caller-mapped signals, not raw wire kinds (AC2 / AC3 / AC5)

The manager consumes a **semantic signal union** that callers map from wire control messages and local
UI events. This decouples the manager from the wire encoding and makes the test fixtures self-
describing:

```
VoiceTurnSignal (discriminated by kind):
  { kind: "user-speech-start" }
  { kind: "user-end-of-turn" }                            // detection (VAD / silence), NOT commit
  { kind: "dictation-commit" }                            // STT explicit send/confirm
  { kind: "dictation-discard" }                           // STT discard pending turn
  { kind: "assistant-speech-start" }
  { kind: "assistant-speech-end"; how: "completed" | "stopped" }
  { kind: "user-interrupt"; atMs?: number }               // barge-in; atMs = client-perceived media offset
  { kind: "backchannel" }                                 // acknowledgement; no commitment; no floor change
  { kind: "provider-failure"; recoverable: boolean }
  { kind: "permission-denied" }
  { kind: "recovered" }                                   // reconnect / permission re-granted
  { kind: "session-closed" }
```

Wire mapping (the consuming hook's responsibility, not the manager's):

- `media.track.state { state: "live" }` → `user-speech-start`
- `media.track.state { state: "ended" | "muted" }` in `listening` → `user-end-of-turn`
- `transcript.committed` in `speech-to-text` profile → `dictation-commit`
- `transcript.discarded` → `dictation-discard`
- `playback.state { state: "playing" }` → `assistant-speech-start`
- `playback.state { state: "stopped" | "interrupted" }` → `assistant-speech-end { how: "stopped" }`
- `playback.state { state: "idle" }` after playing → `assistant-speech-end { how: "completed" }`
- `control.interrupt` (host→client) → `user-interrupt`
- `error` with recoverable code → `provider-failure { recoverable: true }`
- `error` with non-recoverable code → `provider-failure { recoverable: false }`
- `session.closed` → `session-closed`

### D5 — Capability gating derived from `voiceMessageAllowedForProfile`, not re-encoded (AC1 / AC2 / AC3)

A turn signal is **admitted** if and only if the capability it requires is derivable from the profile
via `voiceMessageAllowedForProfile(kind, profile)` from `keiko-contracts`. This is the single source of
truth; the manager maintains no parallel gating table (ADR-0059 is the authority). Admission keys on the
**semantic** capability a wire kind implies, not a strict 1:1 wire map. The load-bearing reason is that
a user spoken turn can be captured **either** via the WebRTC `media.track.state` track (`full-realtime`)
**or** via gateway-batch `transcript.*` (`speech-to-text`), because STT dictation never uses the realtime
media track. A strict 1:1 map (`user-speech-start`/`user-end-of-turn` ↔ `media.track.state` only) would
gate user capture out of STT entirely and make the mandatory STT requirement — *distinguish end-of-turn
detection from send/commit* (Scope / AC2) — impossible. The manager therefore derives these predicates
(still from the contract, no parallel table) and admits signals against them:

```
mediaAllowed      = voiceMessageAllowedForProfile("media.track.state", profile);    // full-realtime
playbackAllowed   = voiceMessageAllowedForProfile("playback.state", profile);       // speech-output, full-realtime
interruptAllowed  = voiceMessageAllowedForProfile("control.interrupt", profile);    // speech-output, full-realtime
transcriptAllowed = voiceMessageAllowedForProfile("transcript.committed", profile); // speech-to-text, full-realtime
floorControl        = mediaAllowed;                       // live full-duplex floor → full-realtime only
usesManualCommit    = transcriptAllowed && !mediaAllowed; // explicit review/commit gate → speech-to-text only
canCaptureUserVoice = mediaAllowed || transcriptAllowed;
```

| Signal | Admitted iff (derived predicate) | `none` | `speech-to-text` | `speech-output` | `full-realtime` |
|---|---|---|---|---|---|
| user-speech-start | `canCaptureUserVoice` | no | yes | no | yes |
| user-end-of-turn | `canCaptureUserVoice` | no | yes | no | yes |
| dictation-commit | `usesManualCommit` | no | yes | no | no |
| dictation-discard | `usesManualCommit` | no | yes | no | no |
| assistant-speech-start / -end | `playbackAllowed` | no | no | yes | yes |
| user-interrupt | `interruptAllowed` | no | no | yes | yes |
| backchannel | `floorControl AND playbackAllowed` | no | no | no | yes |
| provider-failure / permission-denied | `profile !== "none"` (local lifecycle) | no | yes | yes | yes |
| recovered / session-closed | `profile !== "none"` (local lifecycle) | no | yes | yes | yes |

**`speech-to-text` profile (AC2):** `media.track.state`, `playback.state`, and `control.interrupt` are
absent from `VOICE_PROFILE_ALLOWED_MESSAGE_KINDS["speech-to-text"]`, but `transcript.committed` is
present. The manager therefore **does** capture a user dictation turn (`user-speech-start`,
`user-end-of-turn` admitted via `canCaptureUserVoice`) and supports the explicit
`dictation-commit` / `dictation-discard` gate (admitted via `usesManualCommit`), while
`assistant-speech-start/end`, `user-interrupt`, and `backchannel` are rejected by the profile gate. It
reaches only `idle` / `listening` (+ the `pendingCommit` flag) / `recovering` / `disabled` — never
`thinking` / `speaking` / `interrupted` / `yielding` — so it does not pretend to hold a conversational
floor (AC2), yet it *does* distinguish end-of-turn detection (sets `pendingCommit`) from send/commit
(advances `turnIndex`). The `pendingCommit` flag signals that a dictation recording has ended and
awaits explicit user send/discard.

**`speech-output` profile:** `playback.state` and `control.interrupt` are allowed but `media.track.state`
and `transcript.committed` are not. The manager can observe assistant speech and accept user interrupts
but cannot capture a user turn (no `user-speech-start` / `user-end-of-turn`) and cannot dictate. This is
an asymmetric floor: the user can interrupt but cannot initiate a user-held turn. `backchannel` is
**rejected** because acknowledging that the user is being heard requires live user capture
(`floorControl`), which `speech-output` lacks — you can only backchannel when you both hear the user
live *and* can emit assistant audio.

**`full-realtime` profile (AC3):** all signal kinds are admitted; the manager has full floor control.
`dictation-commit` / `dictation-discard` are the exception — they are rejected here because the
VAD-driven `user-end-of-turn` floor handoff replaces the manual review/send gate (`usesManualCommit` is
false when a live media track is present).

**`none` profile (AC1):** manager is `disabled` at construction; `apply` short-circuits before the clock
or observer are called.

### D6 — Complete state-transition table (AC3 / AC4 / AC5 / AC6)

The table below is the normative transition specification. Effects are content-free directives the
manager **emits** but never executes; the consuming hook executes them. "no-op" means the signal is
valid for the profile but has no meaningful effect in the current state and produces no transition.

| Signal | From State | To State | Effects | Notes |
|---|---|---|---|---|
| user-speech-start | idle | listening | — | |
| user-speech-start | yielding | listening | — | user takes floor during handoff window |
| user-speech-start | interrupted | listening | — | user formally takes floor after barge-in |
| user-speech-start | recovering | listening | — | reconnect succeeded; user starts speaking |
| user-speech-start | listening | listening | — | no-op; duplicate |
| user-speech-start | thinking | listening | preserve-user-turn | overlap: assistant processing; preserve context |
| user-speech-start | speaking | *(synthesize)* | — | See Note A: synthesized as interrupt then listening |
| user-end-of-turn | listening (full-realtime) | thinking | — | VAD detection; `turnIndex++`; `pendingCommit=false` (see D6 refinement) |
| user-end-of-turn | listening (speech-to-text) | idle | — | end-of-turn DETECTED, not sent; `pendingCommit=true`; `turnIndex` unchanged (see D6 refinement) |
| user-end-of-turn | *(other)* | *(same)* | — | no-op; out-of-sequence detection |
| dictation-commit | idle + pendingCommit (STT) | idle | — | STT-only: explicit send; `pendingCommit=false`; `turnIndex++` (see D6 refinement) |
| dictation-commit | idle (nothing pending) | idle | — | no-op; nothing pending |
| dictation-discard | idle + pendingCommit (STT) | idle | — | STT-only: discard; `pendingCommit=false`; `turnIndex` unchanged (see D6 refinement) |
| dictation-discard | idle (nothing pending) | idle | — | no-op |
| assistant-speech-start | thinking | speaking | — | |
| assistant-speech-start | speaking | speaking | — | no-op; duplicate |
| assistant-speech-start | idle | speaking | — | provider-initiated speech without explicit thinking phase |
| assistant-speech-start | interrupted | speaking | — | provider resumed (e.g. after retry) |
| assistant-speech-end(completed) | speaking | yielding | — | cooperative end; brief handoff window |
| assistant-speech-end(completed) | thinking | idle | — | response cancelled before speech began |
| assistant-speech-end(stopped) | speaking | interrupted | — | playback stopped (mid-barge-in) |
| assistant-speech-end(stopped) | thinking | idle | — | cancelled before speech began |
| assistant-speech-end(stopped) | interrupted | interrupted | — | no-op; already interrupted |
| user-interrupt | speaking | interrupted | stop-playback, cancel-speech-generation, preserve-user-turn | `interruptions++` (preserve-user-turn per the AC3 reinforcement; see Note A) |
| user-interrupt | thinking | interrupted | cancel-speech-generation | interrupt in-flight; `interruptions++` |
| user-interrupt | yielding | idle | — | interrupt during handoff; collapse to idle |
| user-interrupt | idle | idle | — | no-op; spurious |
| user-interrupt | interrupted | interrupted | stop-playback | re-interrupt; provider not yet stopped; `interruptions++` |
| user-interrupt | listening | listening | — | no-op; user already has the floor |
| user-interrupt | recovering | recovering | — | no-op; floor unoccupied during reconnect, nothing to interrupt |
| backchannel | *(any active state)* | *(same)* | emit-backchannel | floor unchanged; `backchannels++` |
| provider-failure(recoverable=true) | *(any active)* | recovering | begin-recovery | |
| provider-failure(recoverable=false) | *(any active)* | disabled | — | terminal |
| permission-denied | *(any active)* | disabled | — | terminal |
| recovered | recovering | idle | — | reset in-progress counters; `turnIndex` preserved |
| session-closed | *(any active)* | disabled | — | terminal for this session |

**Note A — Overlap synthesis (barge-in while `speaking`):** When `user-speech-start` arrives in the
`speaking` state, the manager synthesizes it as two sequential reducer steps within the same `apply`
call: first `user-interrupt { atMs: clock.now() }`, then `user-speech-start`. This produces the full
interrupt transition (`stop-playback` + `cancel-speech-generation` + `preserve-user-turn` effects per
the AC3 reinforcement, `interruptions++`) followed immediately by the user taking the floor in
`listening`. The observer fires twice. This is preferred over a distinct "overlap" state because there
is no meaningful semantic difference between an explicit barge-in and a simultaneous one — the outcome
is always interrupt then listen.

**AC3 reinforcement (`preserve-user-turn` on barge-in):** so AC3's "preserve the next user turn" is
*literally* satisfied in the emitted effect trace, the `user-interrupt | speaking → interrupted`
transition and the overlap-synthesis interrupt step both emit `preserve-user-turn` among their effects
(in addition to `stop-playback` and `cancel-speech-generation`). All other transition rows emit effects
exactly as written above.

**Implementation refinement (D6 — profile-aware end-of-turn / commit):** because the D5 refinement
admits `user-speech-start` / `user-end-of-turn` for `speech-to-text` (via transcript capture) while
keeping the floor-bearing signals out, the `user-end-of-turn` and dictation rows are profile-aware:

- `user-end-of-turn` from `listening`, full-realtime (`floorControl`): → `thinking`, `turnIndex++`,
  `pendingCommit=false` (the user turn is complete and the floor hands to the assistant).
- `user-end-of-turn` from `listening`, speech-to-text (`usesManualCommit`): → `idle`,
  `pendingCommit=true`, `turnIndex` **unchanged**, no effect (end-of-turn is DETECTED, the turn is not
  yet sent).
- `dictation-commit` from `idle` while `pendingCommit` (STT): → `idle`, `pendingCommit=false`,
  `turnIndex++` (the turn is SENT).
- `dictation-discard` from `idle` while `pendingCommit` (STT): → `idle`, `pendingCommit=false`,
  `turnIndex` **unchanged** (the turn is discarded).

`pendingCommit` is `true` only in `speech-to-text`, only between `user-end-of-turn` and the subsequent
`dictation-commit` / `dictation-discard`; it is always `false` in `full-realtime` and `speech-output`.

**`pendingCommit` flag (AC2):** `pendingCommit` is a boolean on the snapshot, independent of turn
state. In `speech-to-text` profile, the flow (per the D6 refinement above) is: the user speaks
(`user-speech-start` → `listening`) → end-of-turn is detected (`user-end-of-turn` → `idle`,
`pendingCommit=true`) → the UI shows the send/discard decision → the user confirms
(`dictation-commit` → `turnIndex++`, `pendingCommit=false`) or discards (`dictation-discard` →
`pendingCommit=false`, `turnIndex` unchanged). The STT path never transitions to `thinking` /
`speaking` / `interrupted` / `yielding` — those signals are rejected by the profile gate (D5). In
`full-realtime` profile, `pendingCommit` is always `false` (VAD-driven `user-end-of-turn` goes
directly to `thinking` and the commit happens atomically when the turn ends).

**`turnIndex` (AC4 / AC5 delayed-transcript dedup):** `turnIndex` is a monotonically increasing integer
incremented on `user-end-of-turn` (full-realtime) or `dictation-commit` (STT-only). It is exposed on
the snapshot and on every observer `onTransition` event. The consuming hook uses `turnIndex` together
with seq to deduplicate delayed or out-of-order `transcript.committed` messages — a transcript whose
`turnIndex` at delivery is older than the current `turnIndex` is stale and is discarded.

### D7 — Effects: content-free directives the manager emits but never executes (AC3 / AC5)

```
VoiceTurnEffect:
  "stop-playback"             — tell the playback layer to stop TTS immediately
  "cancel-speech-generation"  — tell the BFF/provider to cancel the in-flight response (best-effort)
  "preserve-user-turn"        — cache the current user-turn context for coherent next-turn commit
  "emit-backchannel"          — send a backchannel acknowledgement event over the control plane
  "begin-recovery"            — initiate reconnect / re-negotiation
```

`apply` returns `{ outcome: VoiceTurnApplyOutcome; effects: readonly VoiceTurnEffect[]; snapshot: VoiceTurnSnapshot }`.
The caller executes the effects. The manager itself never calls a WebSocket, WebRTC API, or any
async function. This satisfies AC5 by construction: the effect vocabulary is **media-floor only**. No
effect grants workflow authority, triggers a model call, commits a workspace patch, or writes to any
store. Spoken intent continues to flow through the existing `WorkflowHandoffRequest` chain
(architecture.md §6, ADR-0058 D1), which the turn manager has no path to reach or bypass.

`cancel-speech-generation` is best-effort: the consuming hook should issue it over the control plane
but must handle the case where the provider does not honour it before sending more audio. When
`provider-failure(recoverable=true)` arrives before `assistant-speech-end`, the state transitions
through `interrupted` → `recovering`; `interruptions` is preserved across recovery.

### D8 — Content-free observer; no raw audio, no transcript text (AC4 / AC6)

The manager accepts an optional, non-blocking `VoiceTurnManagerObserver` called via optional chaining.
Every field is an enum, integer, or millisecond delta:

```
onTransition(event: {
  from: VoiceTurnState;
  to: VoiceTurnState;
  trigger: VoiceTurnSignalKind;        // the signal's `kind` field only
  floorHolder: FloorHolder;
  turnIndex: number;
  latencyMs: number;                   // clock.now() minus previous apply; 0 for first call
}): void

onInterrupt(event: {
  state: VoiceTurnState;
  atMs: number | undefined;
  interruptions: number;
}): void

onBackchannel(event: {
  state: VoiceTurnState;
  backchannels: number;
}): void

onEffect(event: {
  effect: VoiceTurnEffect;
  state: VoiceTurnState;
  turnIndex: number;
}): void
```

The observer methods receive no parameter that could carry transcript text, audio, SDP/ICE, or any
`reviewable-text` / `secret-bearing` / `raw-media` payload (privacy-contract §2 / §3). The signal's
`kind` discriminant (a string literal from `VoiceTurnSignalKind`) is content-free by definition.

### D9 — Read-only snapshot (AC2 / AC3 / AC4 / AC6)

```
VoiceTurnSnapshot {
  profile: VoiceProfile;
  active: boolean;                       // false iff state === "disabled"
  state: VoiceTurnState;
  floorHolder: FloorHolder;              // derived; never stored separately
  turnIndex: number;                     // monotonically increasing; 0 at construction
  interruptions: number;                 // monotonically increasing
  backchannels: number;                  // monotonically increasing
  pendingCommit: boolean;                // STT-only: recording ended; awaiting explicit send/discard
  recovering: boolean;                   // convenience alias for state === "recovering"
  lastEndOfTurnAtMs: number | undefined; // clock time of last user-end-of-turn or dictation-commit
  lastInterruptAtMs: number | undefined; // clock time of last user-interrupt
}
```

The snapshot contains no transcript text, audio, SDP/ICE, or `reviewable-text` content. `active` is
`false` only in `disabled` — a `none`-profile manager is immediately `disabled` at construction and
`active=false` (AC1). `floorHolder` is derived from `state` at snapshot time, never stored as a
separate mutable field, which eliminates state/floor divergence.

### D10 — Tests as evaluation fixtures covering all AC6 scenarios (AC5 / AC6)

Tests are scripted signal sequences against a fake deterministic clock, producing expected
state / effect / observer traces — exactly the pattern ADR-0061 established. Named fixture scenarios
required by the issue:

1. **overlap** — `assistant-speech-start` → `user-speech-start` (barge-in synthesis: `onTransition`
   fires twice within one `apply`; `stop-playback` + `cancel-speech-generation` then `listening`)
2. **silence** — `user-speech-start` → `user-end-of-turn` → `assistant-speech-start` →
   `assistant-speech-end(completed)` → `yielding` → `user-speech-start` → second round-trip
3. **fast-interrupt** — `assistant-speech-start` → `user-interrupt` within the same clock tick →
   both effects emitted; `interrupted`; then `user-speech-start` → `listening`
4. **delayed-transcript** — `dictation-commit` arrives after `turnIndex` has advanced; the hook
   detects stale delivery via `turnIndex` mismatch (the manager records the transition; the test
   asserts `turnIndex` on the snapshot and on the `onTransition` event)
5. **provider-cancellation-failure** — `user-interrupt` emits `cancel-speech-generation`;
   `provider-failure(recoverable=true)` arrives before `assistant-speech-end`; state goes
   `interrupted` → `recovering` → `idle` on `recovered`; `interruptions` preserved
6. **stt-commit-vs-detect** — `speech-to-text` profile: `user-speech-start` rejected by profile
   gate; `dictation-commit` accepted; `pendingCommit` lifecycle; `user-interrupt` rejected;
   full-realtime signals produce `not-allowed-for-profile`
7. **none-profile-dormant** — every signal returns `not-allowed-for-profile`; `active=false`; no
   observer calls; clock never read
8. **backchannel-no-floor-change** — `backchannel` during `speaking`; floor stays `assistant`; state
   stays `speaking`; `backchannels++`; `emit-backchannel` emitted

### D11 — No new dependency; module + tests + observer only; hook wiring deferred

The turn manager ships the deterministic module and its tests. It adds no third-party dependency; the
state machine is a table lookup and a switch; time is `performance.now()` via the existing `VoiceClock`
seam. Wiring the manager into `useRealtimeVoice` and `useDictation` render paths is **out of scope**
and is deferred to the rendering issue in the #499+ sequence. The integration seams are documented:
hooks construct the manager with the resolved profile and a browser clock, call `apply(signal)` on
each semantic signal derived from decoded control messages or local UI events, read `snapshot()` to
render, and execute the `effects` list returned by `apply`.

## Consequences

### Positive

- AC1 dormancy, AC2 STT commit-only semantics, AC3 full floor control, and the `speech-output`
  intermediate case all fall out of the contract's single gating table — no second source of truth for
  capability gating.
- The effect vocabulary is media-floor only by construction; spoken workflow actions cannot gain
  authority through this module without a structural type change (AC5).
- The state-transition table is total and explicit; every (state, signal) pair has a documented
  outcome; the overlap synthesis rule eliminates the need for a ninth state.
- `pendingCommit` makes the STT end-of-turn vs commit distinction visible on the snapshot without
  adding a ninth turn state.
- Isolation from text chat is structural: `disabled` / `not-allowed-for-profile` outcomes from `apply`
  cannot propagate to the chat path; the module has no BFF or data-store dependency.

### Negative

- The module ships before its hook consumers, so it is foundation code with documented-but-unused
  integration seams until the rendering issue lands.
- The `speech-output` intermediate profile (interrupt-capable but no user-speech floor) is a third
  admission tier that consuming hooks must handle, not just a binary full/none gate.
- The overlap synthesis (two `onTransition` calls from one `apply` call) is unusual and must be
  clearly documented so hook consumers are not surprised by the doubled observer fire.

### Neutral

- `floorHolder` is derived from state at snapshot time rather than stored; this eliminates
  state/floor divergence at the cost of a minor table lookup per snapshot call.
- `turnIndex` semantics differ between STT-only (on `dictation-commit`) and full-realtime (on
  VAD `user-end-of-turn`); hooks must know which profile is active to interpret turn boundaries.
- Like ADR-0061, this module deliberately mirrors the shape of the server's floor/idempotency logic
  without sharing code; the contract is the coupling point.

## Alternatives Considered

### Alternative 1: Embed floor control inside the timing engine (ADR-0061)

- **Pros**: one module to construct; shared clock instance; one test suite.
- **Cons**: the timing engine's responsibility is ordering and replay of the wire message stream;
  floor control is a semantic interpretation above that. Merging them produces a module with two
  unrelated reasons to change (buffer management vs. turn semantics), approaching the 1000+ LOC
  threshold that ADR-0019 flags for review.
- **Why rejected**: separation of concerns. The timing engine can be unit-tested without floor
  control logic; the turn manager can be unit-tested with stub signals without a replay buffer.
  ADR-0061 D10 explicitly defers "semantic rendering wiring" to later issues, making the boundary
  clear.

### Alternative 2: Model turn states as a React reducer inside `useRealtimeVoice`

- **Pros**: co-located with the rendering consumer; no factory pattern needed; direct access to
  React dispatch.
- **Cons**: impossible to unit-test without a React test environment; cannot be shared with a future
  non-React consumer; the "synchronous reducer, no hidden async queues" mandate (ADR-0061 D3) is
  harder to enforce inside a hook closure.
- **Why rejected**: the established pattern in this codebase (`voice-timebase.ts`,
  `dictation-recorder.ts`, `voice-rtc-transport.ts`) is a pure injectable factory module consumed by
  a hook. Deterministic unit testing without React is a firm AC6 requirement.

### Alternative 3: A `"backchannel"` turn state instead of a counter and effect

- **Pros**: backchannel is visible as a distinct UI state (e.g. a head-nod animation).
- **Cons**: backchannel is an event that arrives *while* the assistant or user holds the floor; a
  "backchannel" state requires a hidden "previous state" to restore, which is implicit mutable
  context. The issue spec says backchannel "acknowledges hearing without fake commitments" — no
  commitment means no state change.
- **Why rejected**: backchannel is structurally an event, not a state. The `backchannels` counter on
  the snapshot is observable by the UI for animation; `emit-backchannel` lets the hook send the wire
  event; no state change is needed or correct.

### Alternative 4: Separate `pendingCommit` as its own ninth turn state (`"awaiting-commit"`)

- **Pros**: avoids a boolean flag; the state machine is purely state-based.
- **Cons**: `pendingCommit` is STT-only and only arises between end-of-recording and explicit send.
  It is an attribute of the `listening` phase, not an orthogonal concern. A ninth state makes the
  full-realtime path carry a state it can never enter (VAD `user-end-of-turn` goes directly to
  `thinking`).
- **Why rejected**: a boolean flag on the snapshot is simpler and accurate. The issue's explicit
  requirement to "distinguish end-of-turn detection from send/commit in STT dictation" is satisfied
  by `pendingCommit` + the `dictation-commit` / `dictation-discard` signal distinction without a
  ninth state.

### Alternative 5: Re-encode the capability gating table inside the turn manager

- **Pros**: the manager is self-contained; no runtime lookup of `voiceMessageAllowedForProfile`.
- **Cons**: `VOICE_PROFILE_ALLOWED_MESSAGE_KINDS` in `keiko-contracts` is the authoritative table
  (ADR-0059); duplicating it introduces drift risk. ADR-0061 D8 explicitly rejects this for the
  timing engine for the same reason.
- **Why rejected**: single source of truth. Gating is delegated to `voiceMessageAllowedForProfile`
  from the contract, exactly as ADR-0061 does.

## Related

- [ADR-0058](ADR-0058-voice-digital-twin-capability-architecture.md): capability gating; D1 (no new
  authority); D6 (security review contract)
- [ADR-0059](ADR-0059-voice-control-media-capability-replay-protocol.md): the protocol kinds and
  `VOICE_PROFILE_ALLOWED_MESSAGE_KINDS` gating table this ADR delegates to
- [ADR-0060](ADR-0060-realtime-voice-transport.md): server-side control plane, bounded replay buffer,
  seq/idempotency
- [ADR-0061](ADR-0061-voice-timing-engine.md): the timing engine this module sits above; the
  `VoiceClock` seam and `createBrowserVoiceClock` that this module reuses
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491); Issue
  [#499](https://github.com/oscharko-dev/Keiko/issues/499)
- [`docs/voice/privacy-contract.md`](../voice/privacy-contract.md): content-free observer invariant
  (§2 / §3); authority preservation (§1)
- [`docs/voice/architecture.md`](../voice/architecture.md): authority and governance (§6)
- [`packages/keiko-contracts/src/voice-protocol.ts`](../../packages/keiko-contracts/src/voice-protocol.ts):
  `VOICE_PROFILE_ALLOWED_MESSAGE_KINDS`, `voiceMessageAllowedForProfile`, `VoiceProfile`,
  `VoiceControlMessageKind`
- [`packages/keiko-ui/src/app/components/desktop/hooks/voice-timebase.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/voice-timebase.ts):
  `VoiceClock`, `createBrowserVoiceClock`, `resolutionToVoiceProfile` (reused by the turn manager)

## Date

2026-06-24
