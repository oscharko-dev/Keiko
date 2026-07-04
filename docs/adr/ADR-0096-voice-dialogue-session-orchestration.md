# ADR-0096: Voice dialogue session orchestration — deterministic turn controller, STT+TTS fallback, barge-in, and master cleanup

## Status

Proposed (Issue #1560, Epic #1556, 2026-06-26)

## Version

0.1.0

## Context

Epic #1556 builds a **colleague-like voice dialogue mode** on top of the completed Epic #491 voice
foundation. Issue #1560 is the **orchestration layer** that makes the dialogue actually converse: it
coordinates microphone capture, transcript commit, chat send, the assistant response, speech output,
interruption, and the next listening turn, and it must degrade to a production **STT+TTS** path because
regulated deployments may expose speech input/output without full-duplex realtime media (Engineering
Notes). Three siblings already shipped the surface this issue consumes, and the Stop Conditions forbid
building a parallel subsystem when reuse, extension, or generalization satisfies the outcome:

- **Issue #499 (ADR-0104)** shipped `createVoiceTurnManager` — the pure, deterministic eight-state
  floor reducer (`idle`/`listening`/`thinking`/`speaking`/`interrupted`/`yielding`/`recovering`/
  `disabled`) with capability gating derived from `voiceMessageAllowedForProfile`, an emitted-but-never-
  executed effect vocabulary (`stop-playback`, `cancel-speech-generation`, `preserve-user-turn`,
  `emit-backchannel`, `begin-recovery`), and a content-free observer. ADR-0104 D11 explicitly deferred
  the hook wiring: "hooks construct the manager with the resolved profile … call `apply(signal)` … and
  execute the `effects` list." This issue is that deferred wiring.
- **Issue #494/#495 (ADR-0100 D4)** shipped `useDictation` — the controlled STT capture state machine
  (`request → record → transcribe → preview`) over the BFF `POST /api/voice/transcribe` route, with a
  reviewed transcript inserted into the composer draft. This is the **surfaced, deployed, testable**
  user-capture path.
- **Issue #1558 (ADR-0095)** shipped `useAssistantSpeech` — the audio playback engine that synthesizes
  the latest **complete** assistant message through `POST /api/voice/speak` and drives the #501
  `useVoicePlayback` lifecycle. It already accepts an optional `turnManager` and exposes
  `interrupt(atMs)` and a full teardown.
- **Issue #1559** shipped `useVoiceDialogMode` (availability + persona selection) and the pure
  `deriveVoiceDialogState` label collapser. Its `enterVoiceDialog` currently calls `realtime.start()`,
  and `playbackPhaseToTurnState` synthesizes a turn-state label from the playback phase because no live
  turn manager existed yet.

Four facts about the **current branch** are load-bearing and were verified against the code, because
they set the scope boundary this ADR ratifies:

1. **The server surface is complete.** `GET /api/voice/capability`, `POST /api/voice/transcribe`, and
   `POST /api/voice/speak` are registered in `packages/keiko-server/src/routes.ts`; the `/api/voice/control`
   realtime WebSocket upgrade is registered in `packages/keiko-server/src/server.ts` via
   `createVoiceControlPlane`, gated to the full-realtime profile. **No server change is required by
   #1560** — it is a pure `keiko-ui` orchestration layer (D1).
2. **The capability ladder has no distinct "STT+TTS" profile.** `VoiceProfile = none | speech-to-text |
   speech-output | full-realtime`. `supportsDictation(res) && supportsSpeechOutput(res)` is true **only**
   for `full-realtime`; `supportsRealtimeVoice(res)` additionally requires the browser-side
   `transport.webrtcMedia`. Therefore the production **"STT+TTS fallback when realtime is unavailable"**
   is precisely a `full-realtime` deployment running in a browser without WebRTC media — and today
   `useVoiceDialogMode.available` keys on `supportsRealtimeVoice` alone, so it **wrongly hides** dialogue
   in exactly that case. This is a real defect this issue fixes (D3).
3. **The realtime WebSocket data plane does not surface live transcripts to any turn loop.**
   `RealtimeVoicePhase = idle | requesting | negotiating | connected | error` carries no transcript, and
   `voice-realtime-client.ts` exposes no transcript callback. No realtime provider is deployed. So the
   deterministic turn loop must be driven by the **dictation (STT-batch) capture path**, which is
   transport-agnostic; a future realtime transcript event would feed the **same** controller seam (D8).
4. **`enterVoiceDialog` starts a WebRTC connection nothing consumes.** Driving capture through dictation
   while also calling `realtime.start()` would **double-capture the microphone**. The controller must own
   one capture path (D7).

This ADR records the orchestration decisions. It writes no feature code; it defines the module boundary,
the fallback predicate, the signal/effect routing onto the existing turn manager, the chat-send seam, the
barge-in routing, the master cleanup, the privacy invariants, and — explicitly — the realtime-transcript
deferral with its security and scope rationale.

## Decision

### D1 — A pure deterministic core plus a thin React hook; no server change

The orchestration is split into two `keiko-ui` modules, mirroring the established
`voice-turn-manager.ts` (pure) + hook (React) split:

- `hooks/voice-dialogue-session.ts` — a **pure, React-free, I/O-free** core. It owns the fallback-matrix
  predicate (D2), the mapping from real component events to the `VoiceTurnSignal` union (D5), and the
  routing from emitted `VoiceTurnEffect` directives to a typed-sink contract the hook executes (D6). This
  is the "deterministic transitions" deliverable, unit-tested exhaustively against a scripted clock with
  no React environment.
- `hooks/useVoiceDialogueSession.ts` — a **thin** React hook that composes `useDictation`,
  `useAssistantSpeech`, the chat session API, a single live `createVoiceTurnManager` instance, and the
  pure core; owns the master cleanup (D9); and exposes `{ dialogueAvailable, state, listening, speaking,
  canInterrupt, onListen, onInterrupt, onStop, turnSnapshot }`.

No server route, Model Gateway adapter, or contract is added or changed. `keiko-ui` is tarball-excluded
(ADR-0019), so neither module has package-surface impact. The leaf-package trust direction is preserved:
the modules reach the provider only through the existing BFF routes, never directly.

### D2 — The fallback matrix is one pure predicate over the resolution and browser capture support

`voice-dialogue-session.ts` exports `voiceDialogueModeForResolution(res, browserCaptureSupported)`. The
predicate is total over the capability ladder and fail-closed everywhere:

| Profile / resolution | Mic capture | Spoken answer | Barge-in | Dialogue offered |
| --- | --- | --- | --- | --- |
| `none` / unresolved / failed | — | — | — | **No** (dormant, fail-closed) |
| `speech-to-text` (STT-only) | dictation | No (text) | — | **No** (no spoken answer; the existing dictation button stays) |
| `speech-output` (output-only) | — (no mic) | Yes | — | **No** (no user capture; the existing mute stays) |
| `full-realtime` | dictation | Yes (TTS) | Yes | **Yes** |

Dialogue is offered **iff** `supportsDictation(res) && supportsSpeechOutput(res) &&
browserCaptureSupported && personas.length > 0` — the conjunction that is true only for `full-realtime`.
This is identical whether or not the browser has WebRTC media: the **STT+TTS fallback** and the
realtime-capable case are the **same** offered surface (D3), differing only in whether the realtime media
adjunct is available. `undefined` and failed resolutions short-circuit to "not offered" so a slow or
failed probe never strands a control.

### D3 — Generalize `useVoiceDialogMode.available` to STT+TTS OR realtime, fixing the fallback defect

`useVoiceDialogMode.available` is changed from `supportsRealtimeVoice(capability) && personas` to the D2
predicate (`supportsDictation && supportsSpeechOutput && browserCaptureSupported && personas`). This is
the **production STT+TTS path**: a `full-realtime` deployment in a browser without WebRTC now correctly
offers dialogue and runs it over the STT+TTS turn loop, instead of being wrongly hidden. The persona
selection and persistence logic in #1559 is unchanged. `supportsRealtimeVoice` remains the **stricter**
gate that decides only whether the realtime media adjunct may be negotiated — it never decides whether
dialogue is offered.

### D4 — Drive the existing turn manager **live**; build no second state machine

The hook constructs exactly one `createVoiceTurnManager({ profile, clock, observer })` with the resolved
`VoiceProfile` (via `resolutionToVoiceProfile`) and drives it as the single source of conversational
truth. The Stop Condition "existing Keiko functionality can satisfy the outcome through reuse" is honored
literally: there is **no parallel dialogue reducer**. The `deriveVoiceDialogState` label is fed the
**live** `turnManager.snapshot().state` (replacing the #1559 `playbackPhaseToTurnState` synthesis for the
dialogue surface), and the live `turnManager` is passed to `useAssistantSpeech` so assistant-speech and
interrupt signals reach the same instance.

**Profile nuance (load-bearing).** In the STT+TTS fallback the deployment profile is still
`full-realtime`, so the live manager has `floorControl = true`. Per ADR-0104 D6 the user end-of-turn
therefore takes the **floor-control** path (`listening → thinking`, `turnIndex++`), **not** the
`speech-to-text`-profile `pendingCommit` / `dictation-commit` path. The controller maps the dictation
`preview` (transcript ready) to `user-end-of-turn`; it must **not** synthesize `dictation-commit`, which
the `full-realtime` gate rejects (`usesManualCommit` is false). The `dictation-commit` path applies only
to a genuine `speech-to-text` deployment, which the matrix never offers dialogue. This is the one place
where the coordinator spec's step ordering is refined: the commit-vs-detect split is internal to the STT
*profile*, while the STT+TTS *transport fallback* runs the full-realtime floor semantics.

### D5 — Map real component events onto the `VoiceTurnSignal` union; events carry no content

The pure core maps observed events to signals (the consuming-hook responsibility ADR-0104 D4 assigned):

- Dialogue mic activated (user gesture) → `dictation.start()` + `user-speech-start` → `listening`.
- Dictation reaches `preview` (recording stopped, transcript settled) → `user-end-of-turn` → `thinking`
  (full-realtime floor path, D4).
- Chat `sendStatus ∈ {queued, contacting, streaming}` keeps the floor on `thinking` until speech starts.
- Assistant message settles and `useAssistantSpeech` begins playback → `assistant-speech-start` →
  `speaking`; playback end → `assistant-speech-end{how:"completed"}` → `yielding` → `idle`; re-arm
  listening for the next turn.
- Provider error (STT / TTS / chat) classified recoverable → `provider-failure{recoverable}` →
  `recovering` (`begin-recovery`) or `disabled`; text chat stays usable throughout (AC4).

Only signal **kind** enums, integers, and millisecond deltas ever reach the turn manager and its
observer. No transcript text, audio, or SDP/ICE string is passed into a turn-manager signal or observer
(ADR-0104 D8; D10 below).

### D6 — Route emitted effects to typed sinks; execute them React-safely, never inside the reducer

`apply(signal)` returns content-free `VoiceTurnEffect` directives; the manager never executes them
(ADR-0104 D7). The pure core defines a typed **sink contract** (one function per effect), and the hook
binds the sinks to the live components:

- `stop-playback` → `playback.interrupt(atMs)` (the #1558 teardown).
- `cancel-speech-generation` → `session.cancelSend()` when a chat request is in flight.
- `preserve-user-turn` → retain the in-progress dictation capture for the next-turn commit.
- `begin-recovery` → arm the recoverable-failure UI; text chat remains usable.
- `emit-backchannel` → no-op in the STT+TTS path (no live control plane to emit on); reserved for the
  realtime seam (D8).

Effects collected from each `apply` result are executed in a `useEffect` / callback, **not** synchronously
inside a turn-manager observer, to avoid re-entrant `apply` calls — the React-safety requirement the
synchronous reducer core (ADR-0104 D2) depends on.

### D7 — One capture path; do not start the realtime media connection in the STT+TTS loop

The controller drives microphone capture **only** through `useDictation`. `enterVoiceDialog` is changed
to start the dialogue **session** (arm dictation-driven listening) and **stop** calling
`realtime.start()`. This removes #1559's idle WebRTC connection that "nothing consumes" and prevents
double mic capture (one stream for dictation, one for the WebRTC track). It is **not** a regression of
#1559: that `realtime.start()` established a media connection with no transcript output and no consumer,
so removing it loses no working capability and closes a resource leak. The realtime controller's
`start`/`stop` remain available as an adjunct and are invoked only if a realtime transcript provider is
later configured (D8); the master cleanup still calls `realtime.stop()` defensively (D9).

### D8 — Realtime transcript-plane surfacing is explicitly deferred, with scope and security rationale

The deterministic turn loop is driven by the **dictation (STT-batch)** capture path. Surfacing **live
realtime transcripts** to the turn loop is **out of scope** for #1560 and deferred, on three grounds:

1. **No producer exists.** `RealtimeVoicePhase` carries no transcript and `voice-realtime-client.ts`
   exposes no transcript callback (verified). Building a turn loop on a transcript event the transport
   does not emit would be speculative and untestable.
2. **No realtime provider is deployed.** A realtime path would have no live counterpart in CI; its
   "deterministic transitions" deliverable could not be proven by the required `ci` check.
3. **Security posture.** The Engineering Notes state regulated deployments expose speech I/O **without**
   full-duplex realtime media; the production path **must** be STT+TTS. Driving the loop through the
   already-governed STT-batch route keeps every transcript on the audited `POST /api/voice/transcribe`
   seam and avoids opening a second, less-scrutinized live-transcript ingress in this issue.

The deferral is **non-lossy**: realtime transcript events, when a provider is later configured, map onto
the **same** `user-speech-start` / `user-end-of-turn` controller seam (D5). The boundary is a clean
extension point, not a rewrite.

### D9 — A single idempotent master cleanup on leave, stop, unmount, and capability loss

Leaving dialogue, an explicit stop, an unmount, or the deployment flipping `!available` mid-session all
run **one** idempotent teardown (AC3): `dictation.cancel()` (release mic, clear the auto-stop timer),
`playback.stop()` (release the audio element, revoke the object URL, abort pending synthesis),
`turnManager.apply({kind:"session-closed"})` then `turnManager.reset()`, clear any controller timers,
`realtime.stop()` if it was ever started, and `voiceDialog.leave()`. Every reference is cleared and
re-checked so repeated calls are safe. This composes the teardowns the sub-hooks already own (#494, #1558)
rather than re-implementing resource release.

### D10 — Content-free and committed-only privacy invariants are preserved end to end

Two invariants carry forward unchanged. **Content-free turn manager:** transcript text and audio never
enter a turn-manager signal or observer — only enums, integers, and ms deltas (ADR-0104 D8). **Committed-
only chat send:** only the reviewed, committed dictation transcript reaches chat, via the existing
lifecycle — `session.setDraft(text)` then `await session.sendMessage()` — and only when the trimmed text
is non-empty; a partial or empty transcript is never sent. The committed transcript is sent as a normal
chat **message** (a question); no spoken action auto-executes. Any proposed action still flows through the
#503 spoken-action governance and the existing `WorkflowHandoff` chain, which this controller has no path
to reach (ADR-0104 D7 / AC5). No raw audio, transcript, or secret is persisted.

### D11 — Deterministic-first, Model-Gateway-only, and Orchestrator-authority invariants are unchanged

The chat send is the **existing** `useChatSession` lifecycle; voice does not introduce a second prompt
path, model, or send route (Out of Scope). All model calls (STT, TTS, chat) ride the existing
Model-Gateway-backed BFF routes. The Orchestrator and its governance are untouched: a voice turn produces
a normal chat message and a normal spoken playback of the normal assistant answer. The deterministic core
(D1) and the live turn manager (D4) are the only new state, both exhaustively unit-testable.

## Consequences

### Positive

- The "STT+TTS fallback when realtime is unavailable" requirement (Scope, Engineering Notes) is satisfied
  by the **same** offered surface as the realtime case, with one predicate change (D2/D3), fixing a real
  defect where #1559 hid dialogue in exactly the regulated-deployment case.
- No second state machine: the live ADR-0104 turn manager is the single conversational truth (D4),
  honoring the Stop Condition against a parallel subsystem.
- No server change, no new dependency, no new egress path, no contract version bump (D1).
- AC3 is structural: one idempotent teardown composes the sub-hook teardowns (D9).
- The content-free and committed-only invariants are preserved without new enforcement code (D10),
  because the controller routes through hooks that already enforce them.
- The realtime-transcript deferral is a clean extension point, not technical debt: the future producer
  feeds the same seam (D8).

### Negative

- The dialogue runs **half-duplex** (listen, then speak) in the deployed path: while the assistant speaks
  the user must barge in to take the floor; there is no simultaneous full-duplex overlap until a realtime
  transcript provider is configured. The turn manager's barge-in semantics make this feel responsive, but
  it is not literal full-duplex audio (see AC1 ratification in the issue verdict).
- The profile nuance (D4) — a `full-realtime` deployment running the floor-control path over an STT-batch
  transport — is subtle and must be clearly documented so a future maintainer does not wrongly route the
  dictation preview to `dictation-commit`.
- Removing `realtime.start()` from `enterVoiceDialog` (D7) is a visible change to #1559's wiring; the PR
  must explain it closes a leak rather than dropping a feature.

### Neutral

- The realtime media plane stays built but dormant in the deployed path; it is invoked only when a
  realtime transcript provider lands (D8), at which point the same controller consumes it.
- `emit-backchannel` is a no-op in the STT+TTS loop (D6); it becomes meaningful only on the realtime
  control plane.

## Alternatives Considered

### Alternative 1: Build a dedicated dialogue state machine instead of driving the turn manager

- **Pros**: a single module tailored to the dialogue UX; no need to reason about ADR-0104's profile gate.
- **Cons**: duplicates the eight-state floor reducer, the barge-in synthesis, and the effect vocabulary;
  creates two sources of conversational truth that can diverge; directly violates the Stop Condition
  against a parallel subsystem when reuse satisfies the outcome.
- **Why rejected**: ADR-0104 D11 explicitly deferred exactly this wiring to "the rendering issue"; the
  turn manager is the intended consumer seam. Driving it live is the reuse the issue mandates.

### Alternative 2: Drive the turn loop from the realtime WebSocket transcript plane (full-duplex)

- **Pros**: literal full-duplex; the closest match to "colleague conversation"; would surface live
  partial transcripts.
- **Cons**: no transcript producer exists on the data channel (verified); no realtime provider is
  deployed, so the loop has no CI counterpart and its deterministic transitions cannot be proven by the
  required `ci` check; the Engineering Notes require the **production** path to be STT+TTS for regulated
  deployments without realtime media. It would also open a second, less-audited live-transcript ingress.
- **Why rejected**: it builds on a capability the transport does not expose and would fail the very
  verification the issue requires. Deferred to a future issue behind the same controller seam (D8).

### Alternative 3: Run dictation capture **and** `realtime.start()` together in the dialogue loop

- **Pros**: keeps #1559's wiring untouched; leaves the WebRTC connection available "just in case".
- **Cons**: double mic capture (two live media streams), a connection nothing consumes, and an extra
  resource to leak on teardown; no functional benefit because the realtime transcript is never read.
- **Why rejected**: one capture path is correct (D7). The idle `realtime.start()` is a leak, not a
  feature; removing it is the right cleanup.

### Alternative 4: Add an explicit `STT+TTS` voice profile to the capability ladder

- **Pros**: the fallback would be a named profile rather than "full-realtime without browser WebRTC".
- **Cons**: a contract change rippling through `keiko-contracts`, the server resolver, the gating tables,
  and every existing predicate; the capability model already expresses the case precisely as
  `full-realtime` + no `transport.webrtcMedia`, which is a **browser** fact, not a **deployment** fact.
- **Why rejected**: the distinction is transport availability in the browser, not a deployment capability
  tier. Encoding it as a profile would conflate the two and force a version bump for no behavioral gain.
  The D2 predicate captures it with no contract change.

## Related

- [ADR-0104](ADR-0104-voice-turn-manager.md): the deterministic turn manager this ADR drives live —
  states, signal union, effect vocabulary, capability gating, content-free observer, and the D11
  deferred-hook-wiring seam.
- [ADR-0095](ADR-0095-voice-assistant-speech-synthesis.md): the `useAssistantSpeech` playback engine and
  its `turnManager` / `interrupt` seam consumed by the barge-in routing (D6).
- [ADR-0106](ADR-0106-voice-assistant-speech-output-playback.md): the `useVoicePlayback` lifecycle the
  speech engine drives.
- [ADR-0100](ADR-0100-voice-digital-twin-capability-architecture.md): capability gating, the single
  egress seam, the no-raw-audio-persistence invariant, and the no-new-authority rule carried forward.
- [ADR-0019](ADR-0019-modular-package-architecture.md): package trust direction (the UI reaches the
  provider only through the BFF; `keiko-ui` is tarball-excluded, so these modules have no surface impact).
- `docs/voice/privacy-contract.md`: content-free observer and committed-only invariants (D10).
- Epic [#1556](https://github.com/oscharko-dev/Keiko/issues/1556); Issue
  [#1560](https://github.com/oscharko-dev/Keiko/issues/1560); Issue
  [#1559](https://github.com/oscharko-dev/Keiko/issues/1559) (the dialogue-mode UI this generalizes).

## Date

2026-06-26
