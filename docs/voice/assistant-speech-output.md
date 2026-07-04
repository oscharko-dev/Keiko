# Voice assistant speech output — optional playback lifecycle, controller, and interruption boundary

Provider-neutral specification for Epic #491, the deliverable of Issue
[#501](https://github.com/oscharko-dev/Keiko/issues/501) and the authoritative companion to
[ADR-0106](../adr/ADR-0106-voice-assistant-speech-output-playback.md). It **defines** the assistant
speech-output playback lifecycle and its integration boundary; the controller that drives state changes
lives in
[`packages/keiko-ui/src/app/components/desktop/hooks/voice-playback-state.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/voice-playback-state.ts),
the accessible UI in
[`packages/keiko-ui/src/app/components/desktop/VoicePlayback.tsx`](../../packages/keiko-ui/src/app/components/desktop/VoicePlayback.tsx),
and the contract in
[`packages/keiko-contracts/src/voice-playback.ts`](../../packages/keiko-contracts/src/voice-playback.ts).

## 0. Speech output is OPTIONAL and ENVIRONMENT-DEPENDENT

> **Text is the universal response path.** Keiko answers in text by default and remains fully usable with
> no spoken output. Assistant speech output — whether batch **text-to-speech (TTS)** or **realtime speech
> output** — is an **optional** capability that appears **only when the active, explicitly configured
> provider advertises it** (`speechOutput`, or the `full-realtime` profile) and deployment policy permits
> it. It is therefore **environment-dependent**: a deployment may have it, and a deployment may not.
>
> **This issue deploys no new TTS model and adds no dependency.** The currently deployed voice capability
> is STT-only, so this layer is designed to be future-ready and optional rather than to assume speech
> output exists. In a deployment without speech-output capability, no playback control is rendered and no
> broken playback UI appears. Raw assistant audio is **never persisted by default**.

## 1. Scope and versioning

- **In scope:** the eight-phase playback lifecycle; the mapping from the eight phases onto the five wire
  `VoicePlaybackState`s; the legal phase-transition table; per-phase replay and redaction classification;
  the capability-gating predicates; the effect vocabulary and the turn-manager interruption boundary; the
  AC1 dormancy guarantee; the content-free observer and turn-summary rules; the accessible UI contract.
- **Out of scope:** deploying or requiring a new TTS model; making speech output mandatory; adding a
  third-party audio playback package; using browser `SpeechSynthesis` as a silent default; persisting
  generated audio. Driving the lifecycle from a live provider (real `prepare`/`play-started`/`complete`
  events) lands with the issue that deploys a speech-output provider; the integration seams are shipped
  and tested here.
- **Versioning:** `VOICE_PLAYBACK_SCHEMA_VERSION = "1"`. A breaking change introduces a new literal rather
  than mutating `"1"`. It is independent of the wire `VOICE_PROTOCOL_VERSION` and of
  `CONVERSATION_CAPABILITY_CONTRACT_VERSION`.

## 2. The eight playback phases

| Phase         | Meaning                                                                                 | Wire state    | Replay       | Redaction      |
| ------------- | --------------------------------------------------------------------------------------- | ------------- | ------------ | -------------- |
| `unavailable` | No spoken output is active or pending for the turn (no capability, or disarmed/idle).   | _(none)_      | `ephemeral`  | `content-free` |
| `preparing`   | The configured provider is synthesising / buffering this turn's audio; nothing audible. | `idle`        | `ephemeral`  | `content-free` |
| `speaking`    | Assistant audio is playing.                                                             | `playing`     | `ephemeral`  | `content-free` |
| `paused`      | The user paused playback; audio is retained for the live turn only, never persisted.    | `paused`      | `ephemeral`  | `content-free` |
| `interrupted` | A user barge-in stopped playback mid-utterance; the turn manager receives it (AC2).     | `interrupted` | `replayable` | `content-free` |
| `canceled`    | The user stopped playback before it finished naturally.                                 | `stopped`     | `replayable` | `content-free` |
| `failed`      | The provider failed to produce or continue audio; Keiko stays usable in text.           | `stopped`     | `replayable` | `content-free` |
| `complete`    | Playback finished naturally.                                                            | `idle`        | `replayable` | `content-free` |

`unavailable` is overloaded by design: it is both the permanent resting phase of a non-capable deployment
**and** the disarmed between-turns phase of a capable one. The **capability gate**, not the phase,
distinguishes "never available" from "available but idle" (`snapshot.available`).

**Every phase is `content-free`.** A playback phase is a control-state enum; it never carries text,
secret-bearing signaling, or raw audio. Raw assistant audio is media-plane only — `VOICE_PLAYBACK_AUDIO_PLANE`
re-pins the protocol's `VOICE_MEDIA_PLANE` (`never-persisted`, `raw-media`). This is the typed expression
of "raw assistant audio is not stored by default".

## 3. Transitions

```
unavailable → preparing
preparing   → speaking | complete | canceled | failed
speaking    → paused | interrupted | canceled | failed | complete
paused      → speaking | interrupted | canceled | complete
interrupted → preparing            (replay, if permitted)
canceled    → preparing            (replay, if permitted)
failed      → preparing            (replay / retry, if permitted)
complete    → preparing            (replay, if permitted)
```

Muting is **orthogonal** to the phase: it silences output without a transition (a boolean in the
snapshot). Arming a turn (`unavailable → preparing`) is rejected by the capability gate for a profile
without speech output, so a no-capability deployment is pinned in `unavailable` permanently.

## 4. Capability gating

`voicePlaybackAllowedForProfile` and `voicePlaybackInterruptAllowedForProfile` derive from
`voiceMessageAllowedForProfile("playback.state" | "control.interrupt", profile)` — the single source of
truth. By the [protocol](protocol.md) profile table:

| Profile          | Playback / interrupt allowed | Controller resting phase |
| ---------------- | ---------------------------- | ------------------------ |
| `none`           | No                           | `unavailable` (dormant)  |
| `speech-to-text` | No (dictation only — AC1)    | `unavailable` (dormant)  |
| `speech-output`  | Yes                          | `unavailable` → armable  |
| `full-realtime`  | Yes (also speaks)            | `unavailable` → armable  |

The UI applies the same rule before mounting any control via `supportsSpeechOutput`, so an STT-only or
no-voice deployment renders no playback affordance and the assistant answers in text (AC1).

## 5. Interruption and the turn manager (AC2)

A barge-in calls `interrupt`, which stops output and emits the content-free `notify-turn-interrupt`
effect. `voicePlaybackEffectToTurnSignal` maps the `notify-turn-*` effects onto the
[turn manager](../adr/ADR-0104-voice-turn-manager.md) signal union, and `forwardVoicePlaybackToTurnManager`
applies them — so **the turn manager receives the state change**: it transitions to `interrupted` and
counts the barge-in. The `notify-turn-speech-start` / `-completed` / `-stopped` effects similarly inform
the turn manager that the assistant began, finished, or was stopped. Media effects (`start-output`,
`stop-output`, `mute-output`, …) belong to the media layer and do not map to a turn signal. No effect
grants workflow authority, triggers a model call, or writes to any store.

## 6. Local seams only — no new destination, no stored audio (AC3 / AC4)

The optional spoken audio, when a provider supports it, rides the existing seams: the Model Gateway
egress (`gateway-batch`) for batch TTS, and the WebRTC media plane (`audio-out`) for realtime speech
output. The playback controller only ever _names_ these through content-free effects; it holds no audio,
credential, SDP, or URL. Provider credentials and audio payloads therefore flow exclusively through the
approved local seams already governed by the [privacy contract](privacy-contract.md). No new server route
and no new external destination are introduced.

## 7. Accessible UI contract (assistant speaking state)

`VoicePlayback.tsx`, driven by the `useVoicePlayback` binding, renders two surfaces — both gated by
`supportsSpeechOutput`:

- **Mute toggle** (persistent, composer bar): "Mute assistant voice" / "Unmute assistant voice", with
  `aria-pressed` reflecting the state and a discoverable local-only disclosure. Rendered only when speech
  output is advertised; absent otherwise (AC1).
- **Status / alert strip** (transient): announces the speaking state via `role="status"`
  (`aria-live="polite"`) or, on failure, `role="alert"`, and offers **pause**, **resume**, **stop**, and
  **replay-if-permitted**. On failure, focus moves to the replay recovery control (WCAG 2.4.3). A
  screen-reader **text-fallback** note states the full response is available as text in the conversation.

The assistant's full reply is always present as text; these controls govern the optional spoken layer
only and never gate the text. The surface reuses the existing `cmp-voice*` CSS, so `globals.css` is
unchanged.

## 8. Content-free observability and turn summary

The controller's observer emits only enum literals, integers, and millisecond deltas — never text, audio,
credential, SDP, or URL material. `summarizeVoicePlaybackTurn` produces a content-free roll-up (terminal
phase, `spoke`, `completed`/`interrupted`/`failed`, interruption and replay counts, and — only when
`failed` — the failure kind) that later consumers (#502 discussion intelligence, #504 recap / memory
review) may read from `@oscharko-dev/keiko-contracts` without forking the controller, and which may enter
an evidence manifest without passing through the redact-at-persist seam because it is content-free by
construction.

## 9. Tested cases

The deterministic acceptance evidence runs in the `ci`-gated `keiko-contracts` and `keiko-ui` suites:

- **unavailable / text-only:** `none` and `speech-to-text` controllers reject every command and stay
  `unavailable`; the composer renders no playback control and stays fully text-capable (AC1/AC5).
- **speech-output:** the lifecycle arms, speaks, pauses/resumes, and completes; the mute toggle renders
  and toggles.
- **interruption:** a barge-in transitions to `interrupted`, counts it, and the turn manager receives the
  state change (AC2).
- **provider failure:** a `fail` records the failure kind and settles in `failed` without crashing.

The Studio browser quality gate additionally exercises the no-voice, STT-only, and speech-output flows
against the real composer (`tests/e2e/voice-speech-output.smoke.spec.ts`).
