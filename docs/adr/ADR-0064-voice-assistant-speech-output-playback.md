# ADR-0064: Voice assistant speech-output playback — optional capability-gated playback lifecycle, controller, and interruption boundary

## Status

Accepted (Issue #501, Epic #491, 2026-06-25)

## Version

0.2.0

## Context

[ADR-0058](ADR-0058-voice-digital-twin-capability-architecture.md) makes voice optional and
capability-gated; [ADR-0059](ADR-0059-voice-control-media-capability-replay-protocol.md) defines the
wire protocol, including the `playback.state` control message and five coarse wire playback states
(`idle`, `playing`, `paused`, `stopped`, `interrupted`) and the `speech-output` profile that permits
`playback.state` and `control.interrupt`; [ADR-0060](ADR-0060-realtime-voice-transport.md) realizes the
server-side control plane; [ADR-0061](ADR-0061-voice-timing-engine.md) and
[ADR-0062](ADR-0062-voice-turn-manager.md) ship the client timing engine and floor-control turn manager;
[ADR-0063](ADR-0063-voice-transcript-segment-semantics.md) ships the transcript segment lifecycle.

What is **missing** is the optional **assistant speech-output playback** layer: a contract and controller
that let Keiko render and control a *spoken* assistant response — preparing, speaking, pausing, resuming,
interrupting (barge-in), stopping, failing, and completing — **without deploying any new text-to-speech
model** and **without making speech a precondition for using Keiko**. The currently deployed voice
capability is STT-only, so this layer must be future-ready and optional rather than assume speech output
exists. The wire carries five coarse states on one message; the lifecycle needs eight phases that
additionally distinguish "not available for this turn" (`unavailable`), provider preparation
(`preparing`), provider failure (`failed`), and a natural end (`complete`) — exactly as ADR-0062 and
ADR-0063 map a richer semantic set onto the same coarse wire catalog.

Issue #501 delivers this layer: a new leaf-package contract in `keiko-contracts` (no `@oscharko-dev/*`
imports, no package-surface impact) holding the phase catalog, transition table, classification tables,
capability-gating predicates, effect vocabulary, and a content-free turn summary; a synchronous
deterministic controller in `keiko-ui` (`voice-playback-state.ts`, tarball-excluded) that drives the
phases and emits content-free effects; and a capability-gated, accessible UI surface
(`VoicePlayback.tsx`) wired into the composer behind the same probe pattern as #495/#497.

## Decision

### D1 — Optional playback lifecycle as a new leaf contract + keiko-ui controller (AC1 / AC3 / AC4)

The playback lifecycle is defined by a new, pure-data leaf contract at
[`packages/keiko-contracts/src/voice-playback.ts`](../../packages/keiko-contracts/src/voice-playback.ts):
the eight-phase catalog, the legal-transition table, the per-phase replay/redaction classification, the
phase↔wire mapping, the capability-gating predicates, the effect vocabulary, and a content-free turn
summary (`summarizeVoicePlaybackTurn`) so later consumers (#502 discussion intelligence, #504 recap /
memory review) can read playback outcomes from `@oscharko-dev/keiko-contracts` without forking the
controller. The stateful controller lives in `keiko-ui`
([`hooks/voice-playback-state.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/voice-playback-state.ts)),
co-located with the timing engine and turn manager, tarball-excluded so there is no package-surface
impact. This mirrors the ADR-0063 contract/reducer split.

### D2 — Eight phases with VOICE_PLAYBACK_SCHEMA_VERSION="1" independent of wire version (AC1)

The phases are `unavailable`, `preparing`, `speaking`, `paused`, `interrupted`, `canceled`, `failed`,
`complete`. `VOICE_PLAYBACK_SCHEMA_VERSION="1"` follows the same evolution rule as the protocol and
transcript versions (a breaking change introduces a new literal) and is independent of the wire
`VOICE_PROTOCOL_VERSION` and of `CONVERSATION_CAPABILITY_CONTRACT_VERSION`. `mapVoicePlaybackPhaseToWireState`
projects the eight phases onto the five wire states; `unavailable` has no wire state (dormant) and
returns `undefined`. `unavailable` is overloaded by design: it is both the permanent resting phase of a
non-capable deployment and the disarmed between-turns phase of a capable one — the capability gate, not
the phase, distinguishes "never available" from "available but idle".

### D3 — Transition table and per-phase classification totality (AC3 / AC4 / AC5)

The legal-transition table and the replay/redaction classification tables are keyed by phase, so adding
a phase without classifying it is a compile error (`assertNeverVoicePlaybackPhase`). **Every phase is
classified `content-free`** for redaction: a playback phase is a control-state enum that never carries
text, secret-bearing signaling, or raw audio. This is the AC3/AC4 invariant expressed as data — a
playback record can never become a channel for audio or credentials. The settled lifecycle facts
(`interrupted`, `canceled`, `failed`, `complete`) are `replayable`; the in-flight phases and
`unavailable` are `ephemeral`, so a reconnect re-delivers how the turn ended but never re-plays audio.
`VOICE_PLAYBACK_AUDIO_PLANE` re-pins the ADR-0059 `VOICE_MEDIA_PLANE` (`never-persisted`, `raw-media`,
media-plane only): raw assistant audio is media-plane and is never a field on any playback type.

The table deliberately omits a `paused → failed` edge: a paused utterance is locally buffered and under
the user's control, so a provider failure while paused is resolved by the user (stop / resume /
interrupt) rather than by the controller fabricating a transition the table forbids. The controller's
`fail` handler mirrors this — it is a no-op from `paused`, asserted by a regression test.

### D4 — Capability gating derived from the contract; dormant for none / STT (AC1)

`voicePlaybackAllowedForProfile` and `voicePlaybackInterruptAllowedForProfile` derive from
`voiceMessageAllowedForProfile("playback.state" | "control.interrupt", profile)` — the single source of
truth — rather than re-encoding the profile table. By the ADR-0059 table, `none` and `speech-to-text`
permit neither, so the controller is dormant in `unavailable` and rejects every command
(`not-allowed-for-profile`), with no clock read or observer call. This is why the deployed STT-only
capability renders no playback affordance and Keiko answers in text, with no special case
(`supportsSpeechOutput` in the UI applies the same rule before mounting any control). Only
`speech-output` and `full-realtime` arm the lifecycle.

### D5 — Interruption forwards to the turn manager (AC2)

An `interrupt` command stops output and emits the content-free `notify-turn-interrupt` effect; a
`play-started`/`complete`/`stop`/`fail` emits the corresponding `notify-turn-speech-start` /
`notify-turn-speech-completed` / `notify-turn-speech-stopped` effect. The pure
`voicePlaybackEffectToTurnSignal` maps these onto the ADR-0062 turn-manager signal union, and
`forwardVoicePlaybackToTurnManager` applies them, so **the turn manager receives the state change**
(AC2): a barge-in transitions the turn manager to `interrupted` and counts it. Media effects
(`start-output`, `stop-output`, mute, …) map to `undefined` — they belong to the media layer, not the
turn manager. No effect grants workflow authority, triggers a model call, or writes to any store.

### D6 — No new TTS deployment, dependency, or destination (Scope / Out of Scope; AC3)

This issue ships no TTS model, no new runtime dependency, and no new server route or external
destination. The optional spoken audio, when a provider supports it, rides the existing Model Gateway
egress (`gateway-batch`) and the ADR-0059/0060/0061 WebRTC media plane (`audio-out`); the playback
controller only ever *names* those seams through content-free effects. Provider credentials and audio
payloads therefore flow through the same approved local seams already governed by the privacy contract;
the playback layer adds no path to them (AC3).

### D7 — Capability-gated, accessible UI; text is always the universal path (AC1; Deliverable: UI/a11y)

[`VoicePlayback.tsx`](../../packages/keiko-ui/src/app/components/desktop/VoicePlayback.tsx) renders two
surfaces driven by the `useVoicePlayback` binding: a persistent **mute toggle** in the composer bar
(rendered only when `supportsSpeechOutput`, so a no-voice / STT-only deployment shows nothing — AC1) and
a transient **status / alert strip** announcing the speaking state and offering pause, resume, stop, and
replay-if-permitted. The assistant's full reply is always present as text in the conversation; these
controls govern the optional spoken layer only and never gate the text. Accessibility: `role="status"`
with `aria-live="polite"` for live states, `role="alert"` for failure, a focus handoff to the replay
control on failure (WCAG 2.4.3), an always-present screen-reader text-fallback note, and a discoverable
local-only disclosure on the mute toggle. The surface reuses the existing `cmp-voice*` CSS classes, so
`globals.css` is unchanged (its SHA-pinned design-system proofs are unaffected) and the deployed default
config — which advertises no speech output — renders an unchanged DOM.

### D8 — Replay is policy-gated, off by default ("replay if permitted")

Replay re-arms a settled turn to `preparing`. It is gated by an explicit `replayAllowed` controller
option, off by default, so "replay if permitted" is enforced: a `replay` command is rejected even for a
playback-capable profile unless policy enables it, and the Replay control is rendered only when
`replayAllowed && settled`.

## Consequences

### Positive

- Keiko remains fully usable with no voice model: the controller is dormant and the UI renders text only,
  proven by reducer, component, integration, and (Studio-gate) browser tests (AC1/AC5).
- Speech output is interruptible and the turn manager is kept consistent by construction (AC2).
- Raw assistant audio is never stored or made a field of any playback type; the content-free redaction
  totality table makes a regression a compile/test failure (AC3/AC4).
- No new TTS model, dependency, server route, or external destination; the change is additive and
  surface-neutral.
- Later issues (#502/#504) consume a content-free playback outcome from the contract without forking the
  controller.

### Negative

- The eight-phase lifecycle is richer than the five wire states, so contributors must consult the
  phase↔wire mapping rather than assume a 1:1 correspondence (mitigated by the documented mapping and the
  same lesson recorded in ADR-0062/0063).
- The live audio integration (driving `prepare`/`play-started`/`complete` from a real provider) is
  deferred to the issue that deploys a speech-output provider; until then the controller is exercised by
  tests and remains dormant in production.

### Neutral

- `unavailable` is overloaded (no-capability vs. between-turns); the capability gate disambiguates it,
  and the snapshot exposes `available` so consumers never need to infer capability from the phase.

## Alternatives Considered

### Alternative 1: Use the browser `SpeechSynthesis` API as a default

Rejected by the issue's Out of Scope ("Using browser speech synthesis as a silent enterprise default
without policy review") and the supply-chain / privacy posture: speech output must come from an
explicitly configured, capability-advertising provider through the approved seams, never an implicit
browser default.

### Alternative 2: Embed playback state in the turn manager (ADR-0062)

Rejected. The turn manager owns conversational floor control, not the per-utterance audio lifecycle. The
playback controller is a distinct concern with its own eight phases; it *notifies* the turn manager via
content-free effects, preserving the single-responsibility boundary and keeping the turn manager unchanged.

### Alternative 3: Persist generated audio for replay

Rejected by Out of Scope and AC4. Replay re-requests synthesis from the provider (`request-synthesis`);
no raw audio is retained. Replay is additionally policy-gated and off by default.

### Alternative 4: Wire a full live render path now

Deferred, consistent with ADR-0061/0062/0063: with no speech-output provider deployed there is no real
audio to drive, so the render-path wiring of provider-driven `prepare`/`play-started`/`complete` and of
a live turn manager is left to the issue that deploys speech output. The integration seams
(`useVoicePlayback`, `forwardVoicePlaybackToTurnManager`) are shipped and tested.

## Related

- [ADR-0058](ADR-0058-voice-digital-twin-capability-architecture.md),
  [ADR-0059](ADR-0059-voice-control-media-capability-replay-protocol.md),
  [ADR-0060](ADR-0060-realtime-voice-transport.md), [ADR-0061](ADR-0061-voice-timing-engine.md),
  [ADR-0062](ADR-0062-voice-turn-manager.md), [ADR-0063](ADR-0063-voice-transcript-segment-semantics.md).
- [`docs/voice/assistant-speech-output.md`](../voice/assistant-speech-output.md) — the specification.
- [`docs/voice/implementation-sequencing.md`](../voice/implementation-sequencing.md) — Issue #501 owns the
  `keiko-ui` playback surface.
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491), Issue
  [#501](https://github.com/oscharko-dev/Keiko/issues/501).

## Date

2026-06-25
