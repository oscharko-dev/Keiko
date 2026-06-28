# Voice dialogue session (Issue #1560, Epic #1556)

> **Superseded architecture note:** Voice Dialogue is now Realtime WebRTC-first. The product dialogue
> switch starts `useRealtimeVoice` directly when `full-realtime + persona + browser WebRTC` are
> available, and committed Realtime transcripts append to the existing chat history through
> `/api/desktop/chat/voice-turn`. The STT+TTS turn loop documented below remains historical Epic #1556
> context and is not the default dialogue mode; STT and TTS remain separate dictation/read-aloud helper
> surfaces unless an operator explicitly enables a degraded compatibility path.

The **voice dialogue session** is the orchestration layer that turns the shipped voice surface into an
actual colleague-like conversation: it coordinates microphone capture, transcript commit, chat send, the
assistant response, speech output, interruption (barge-in), and the next listening turn. It is an
optional, **capability-gated** `keiko-ui` controller — it adds no server route, no Model Gateway adapter,
and no contract change. The authoritative decision record is
[ADR-0096](../adr/ADR-0096-voice-dialogue-session-orchestration.md).

This issue is the deferred hook wiring that [ADR-0062](../adr/ADR-0062-voice-turn-manager.md) (D11) called
out: it drives the existing deterministic turn manager **live** rather than building a second state
machine.

## Module boundary

The controller is split to mirror the established `voice-turn-manager.ts` (pure) + hook (React) shape:

| Module                             | Role                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks/voice-dialogue-session.ts`  | **Pure, React-free, I/O-free** core: the fallback-matrix predicate, the event→`VoiceTurnSignal` mapping, and the effect→sink routing. Exhaustively unit-tested with no React environment.                                                                                                                               |
| `hooks/useVoiceDialogueSession.ts` | **Thin** React hook: composes its own `useDictation`, `useAssistantSpeech`, the chat session, one live `createVoiceTurnManager`, and the pure core; owns the master cleanup. Exposes `{ dialogueAvailable, state, listening, speaking, canInterrupt, muted, onListen, onInterrupt, onStop, toggleMute, turnSnapshot }`. |

The per-turn UI lives in `VoiceDialogMode.tsx` as `VoiceDialogTurnControls` (a mic "Speak" toggle plus a
barge-in "Interrupt"), rendered next to the #1559 `VoiceDialogControls` cluster while dialogue is active.

## The STT+TTS production turn loop

No realtime provider is deployed and the realtime data channel surfaces no live transcript, so the
deterministic turn loop is driven by the **dictation (STT-batch)** capture path, which is
transport-agnostic. The loop is half-duplex (listen, then speak) with responsive barge-in:

1. **Enter** (user gesture: the dialogue switch): arm dictation-driven listening. The realtime media
   connection is **not** started — it had no transcript consumer and would double-capture the mic.
2. **Listen**: the mic toggle starts capture and applies `user-speech-start` → `listening`.
3. **End of turn**: stopping capture settles a transcript (`preview`); the controller applies
   `user-end-of-turn` → `thinking`.
4. **Send**: only the reviewed, trimmed, non-empty transcript reaches chat, through the **existing**
   lifecycle — `session.setDraft(text)` then `await session.sendMessage()`. The spoken turn appears as a
   normal chat message; no spoken action auto-executes.
5. **Think**: the chat `sendStatus` keeps the floor on `thinking` until speech starts.
6. **Speak**: the settled assistant message is synthesized by `useAssistantSpeech` (given the live turn
   manager) → `assistant-speech-start` → `speaking`; on end → `assistant-speech-end{completed}` →
   `yielding` → `idle`; listening re-arms for the next turn.
7. **Provider failure**: an STT/TTS/chat error is classified recoverable → `recovering`, else `disabled`;
   the text chat stays fully usable throughout.

### Profile nuance (load-bearing)

In the STT+TTS fallback the deployment profile is still `full-realtime`, so the live turn manager has
`floorControl = true`. The dictation `preview` therefore maps to `user-end-of-turn` (the floor-control
path, `listening → thinking`), **not** `dictation-commit` — the full-realtime admission gate rejects
`dictation-commit` (`usesManualCommit` is false) and the turn would strand in `listening`. The
`dictation-commit` path belongs only to a genuine `speech-to-text` deployment, which the matrix never
offers dialogue for. See [ADR-0096](../adr/ADR-0096-voice-dialogue-session-orchestration.md) D4.

## Barge-in (interruption)

While the assistant holds the floor, activating the mic — or pressing **Interrupt** — applies
`user-interrupt{atMs}`. The turn manager emits content-free effects that the hook routes to typed sinks:
`stop-playback` → `playback.interrupt(atMs)` (the #1558 teardown), and `cancel-speech-generation` →
`session.cancelSend()` when a chat request is in flight. A mic activation then continues into
`user-speech-start` → `listening`, so the user takes the floor immediately. Effects are executed in a
React-safe callback, never synchronously inside a turn-manager observer (avoids re-entrant `apply`).

## Fallback matrix (capability gating)

`voiceDialogueModeForResolution(resolution, browserCaptureSupported)` is total over the capability ladder
and fail-closed everywhere:

| Profile / resolution          | Mic capture | Spoken answer | Barge-in | Dialogue offered          |
| ----------------------------- | ----------- | ------------- | -------- | ------------------------- |
| `none` / unresolved / failed  | —           | —             | —        | **No** (dormant)          |
| `speech-to-text` (STT-only)   | dictation   | No (text)     | —        | **No** (no spoken answer) |
| `speech-output` (output-only) | —           | Yes           | —        | **No** (no user capture)  |
| `full-realtime`               | dictation   | Yes (TTS)     | Yes      | **Yes**                   |

Dialogue is offered **iff** `supportsDictation && supportsSpeechOutput && browserCaptureSupported &&
personas.length > 0` — the conjunction that is true only for `full-realtime`. This is identical whether or
not the browser has WebRTC media: a `full-realtime` deployment in a browser **without** WebRTC media now
correctly offers dialogue and runs it over the STT+TTS loop, instead of being wrongly hidden. This is the
**production fallback fix** (ADR-0096 D3): regulated deployments expose speech I/O without full-duplex
realtime media, and that case must offer dialogue. `supportsRealtimeVoice` remains the stricter gate that
decides only whether the realtime media adjunct may be negotiated — never whether dialogue is offered.

## Master cleanup

Leaving, an explicit stop, an unmount, or the deployment flipping `!available` mid-session all run **one**
idempotent teardown: `dictation.cancel()`, `playback.stop()`, `turnManager.apply({kind:"session-closed"})`
then `turnManager.reset()`, clear controller state, and `voiceDialog.leave()`. Every reference is cleared
and re-checked so repeated calls are safe.

## Realtime-transcript deferral (ADR-0096 D8)

Surfacing **live realtime transcripts** to the turn loop is explicitly **out of scope** for #1560: no
transcript producer exists on the realtime data channel, no realtime provider is deployed (so a realtime
path would have no CI counterpart), and routing through the already-governed `POST /api/voice/transcribe`
seam keeps every transcript on one audited ingress. The deferral is non-lossy: a future realtime
transcript event maps onto the **same** `user-speech-start` / `user-end-of-turn` controller seam.

## Privacy invariants

Both invariants carry forward unchanged. **Content-free turn manager:** transcript text and audio never
enter a turn-manager signal or observer — only enum kinds, integers, and millisecond deltas.
**Committed-only chat send:** only the reviewed, committed, non-empty transcript reaches chat; a partial
or empty transcript is never sent. No raw audio, transcript, or secret is persisted. See
[privacy-contract.md](privacy-contract.md).

## Optional and capability-gated

Like every other voice surface, the dialogue session is optional. A no-voice, STT-only, or
speech-output-only deployment shows no dialogue switch and no turn controls, and the composer stays fully
text-capable. The dialogue runs half-duplex in the deployed path; literal full-duplex overlap awaits a
realtime transcript provider behind the same controller seam.

## Related

- [ADR-0096](../adr/ADR-0096-voice-dialogue-session-orchestration.md) — the orchestration decision record.
- [ADR-0062](../adr/ADR-0062-voice-turn-manager.md) — the deterministic turn manager this controller drives live.
- [ADR-0095](../adr/ADR-0095-voice-assistant-speech-synthesis.md) / [assistant-speech-synthesis.md](assistant-speech-synthesis.md) — the speech engine and its `turnManager` / `interrupt` seam.
- [dictation-ui.md](dictation-ui.md) — the STT capture path the loop drives.
- [privacy-contract.md](privacy-contract.md) — content-free and committed-only invariants.
