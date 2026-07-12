# Voice pipeline fluidity audit and optimization

This note records a focused audit of the shipped voice dialogue pipeline (Epics #491 and #1556)
prompted by user reports that the human↔assistant dialogue did not feel fluid (latency, choppiness,
unconvincing quality), the fixes applied, and the prioritized follow-ups.

## Method

The pipeline hot path was audited statically across the Model Gateway voice adapters, the BFF voice
handlers, and the browser dialogue/transport/playback hooks. In addition, the **live** Azure Foundry
voice deployments were exercised directly to obtain real latency numbers and to verify provider
request/response schemas (no mocks). Audio quality (timbre/naturalness) is a property of the
configured provider model and is out of scope for pipeline changes; perceived fluidity (start
latency, choppiness, turn-taking, robustness) is what this work targets.

## Live baseline (real Azure Foundry calls)

| Path                                     | Observation                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| TTS `keiko-tts`, short reply, mp3        | ttfb ~0.78s, total ~1.4s, ~72KB                                                                     |
| TTS `keiko-tts`, short reply, opus       | ttfb ~0.90s, total ~1.1s, ~18KB                                                                     |
| TTS `keiko-tts`, long reply, mp3         | total ~3.0s, ~303KB                                                                                 |
| TTS `keiko-tts`, long reply, opus        | total ~1.95s, ~75KB                                                                                 |
| STT `keiko-stt`                          | ~1.2s round-trip; rejects audio without a recognized file extension                                 |
| Realtime `keiko-realtime` session create | HTTP 200 ~0.3s; **default session ran the provider demo persona**; voice `nova` rejected (HTTP 400) |

## Current hardening pass (2026-07-09)

- **Atomic server-owned Realtime session:** standard-key WebRTC negotiation now sends GA multipart
  `sdp` + complete `session` configuration in one call. Ephemeral-session negotiation applies the same
  configuration while minting the token. Keiko's persona, recent chat, MemoriaViva priming, grounding
  tools, transcription, voice, and VAD are active before media starts.
- **No client configuration rollback:** the browser no longer sends duplicate instructions, tools,
  `tool_choice`, or transcription settings after connection. A narrow `session.update` carries only an
  explicitly selected acoustic turn-detection profile, so it cannot erase server grounding or memory.
- **Single-copy memory priming:** initial MemoriaViva context is sent in server instructions only. Later
  memory changes can still be injected mid-session; a priming failure emits a redacted operator diagnostic
  instead of silently disappearing.
- **Recognition and endpointing:** dialogue transcription defaults to `gpt-realtime-whisper`. Providers can
  explicitly advertise `supportsSemanticTurnDetection` and a `realtimeTranscriptionModel`; unsupported
  endpoints retain the conservative server-VAD path.
- **No cut-off PCM on backpressure:** `ServerResponse.write() === false` now waits for `drain` instead of
  aborting and destroying the stream. Only a real client close cancels synthesis. Mid-stream failures are
  correlation-keyed in redacted diagnostics.
- **Speech-safe grounded answers:** visible Markdown keeps clickable links and citations, while synthesis
  and Realtime response instructions receive a deterministic `spokenAnswer` without URLs, Markdown,
  citation markers, source appendices, or fenced code.
- **Natural delivery where supported:** `supportsSpeechSynthesisInstructions` enables language-preserving,
  warm colleague-like delivery guidance with natural pacing, subtle emotion, varied intonation, and clear
  pronunciation. Older endpoints receive no speculative field.

## Earlier foundations

### Realtime dialogue (Wave A) — `fix(voice): make realtime dialogue audible and grounded`

- **Silent assistant (critical):** the negotiated remote audio track was never attached to an output
  sink (`useRealtimeVoice` wired `onConnectionStateChange` but never `onRemoteTrack`). The remote
  stream is now attached to an autoplaying audio sink.
- **Ungrounded persona (critical):** the realtime session was created with no `instructions`, so it
  ran the provider default demo persona ("helpful, witty, friendly AI … talk quickly … knowledge
  cutoff 2023-10"). It now uses the same system persona as the text chat, set via the GA nested
  `audio.{input,output}` session schema (verified against the live endpoint; the older top-level
  shape returns HTTP 500).
- **Voice + transcription:** a realtime-valid output voice and `input_audio_transcription` +
  `server_vad` turn detection are now configured.
- **Invalid-voice guard:** `resolveRealtimeVoice` maps a TTS-only voice id (e.g. `nova`, rejected by
  the realtime model with HTTP 400) to a safe default so a misconfigured persona mapping cannot break
  session creation.
- **Transient ICE `disconnected`** no longer tears the session down immediately; a bounded grace
  window allows recovery.
- **Full-duplex capture:** `getUserMedia` now requests echo cancellation / noise suppression / AGC /
  mono, preventing the assistant echoing into the microphone.
- **Negotiation timeout** clamped to 8s (was the generic 30s provider timeout).

### Turn-based speech latency (Wave B) — `perf(voice): request opus for interactive assistant speech`

- The assistant speak path now requests **opus (audio/ogg)** instead of mp3: measured ~25–35% faster
  end-to-end and ~4x smaller for the same utterance, lowering both the synth-to-first-audio wait and
  the base64 inflation of the JSON envelope. opus output is a valid, browser-playable Ogg/Opus
  container, and the MIME stays inside the existing server allowlist.

## Current residual validation

1. **Provider perceptual sign-off.** Automated tests prove transport, ordering, interruption, retrieval,
   memory, and redaction behavior, but timbre and emotional naturalness still require a short human listening
   matrix for each configured model / voice / language combination.
2. **Deployment capability accuracy.** Operators must advertise synthesis instructions and semantic VAD
   only for endpoints that support them. The parser fails closed on inconsistent declarations, but it cannot
   remotely probe a regulated provider during startup.
3. **Real network media evidence.** CI remains hermetic and cannot prove customer WebRTC routing, acoustic
   echo behavior, or provider latency. Those remain deployment acceptance checks using content-free timing
   marks and the existing voice evaluation runbook.
4. **Turn-based STT+TTS mode.** The non-Realtime degradation path remains push-to-talk by design. Natural
   provider VAD, continuous barge-in, and semantic endpointing apply to the full Realtime mode.

## GPT-Live architecture review (2026-07-09)

OpenAI's GPT-Live announcement validates the direction of Keiko's realtime path: continuous
full-duplex interaction, interruption-aware turn taking, deliberate pauses, sparse backchannels, and
delegation of deeper work while the interaction layer preserves conversational flow. Keiko already
ships the applicable provider-neutral foundations: WebRTC media, semantic VAD, barge-in, a floor
manager with a backchannel effect, grounding and Memoria Viva tools, and separate visible versus
spoken grounded answers.

The review produced two immediate changes that do not depend on an unreleased model API:

- The realtime persona now treats hesitation and short pauses as thinking time, honors an explicit
  request to keep listening, and permits only sparse non-committal verbal acknowledgements. An
  acknowledgement is never agreement, confirmation, or permission to complete the user's thought.
- The existing visible/spoken split remains the presentation contract: rich source-backed material
  stays inspectable in chat while the voice renders a concise speech projection. This matches the
  useful "visual answer while talking" pattern without sending links or source metadata to speech.

GPT-Live model identifiers and wire behavior are deliberately not added yet. The announcement says
API availability is forthcoming, so inventing capability names or transport fields would violate the
provider-neutral gateway boundary. When a published API contract exists, evaluate one additional
capability: an interaction-plane model that can issue a single acknowledgement, delegate governed
retrieval or agent work asynchronously, remain interruptible while that work runs, and resume with a
redacted result. The task lifecycle must be content-free in diagnostics and cancellation must preserve
the user's current turn; no background worker may bypass Keiko's existing policy, evidence, or memory
boundaries.

## Research synthesis (2026-07-09)

Six recent papers supplied additional evidence. The decisions below distinguish changes that are safe
for the current provider-neutral product from research directions that require a separate governed
capability and evaluation gate.

| Evidence                                                                                                                                                                                                                                                                                        | Keiko decision                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _Unified Audio Intelligence Without Regressing on Text Intelligence_ ([arXiv:2607.05196](https://arxiv.org/abs/2607.05196)) shows that native audio training can regress reasoning, long-context, and agentic/tool behavior unless those capabilities are explicitly preserved and evaluated.   | Do not promote a native audio model on speech quality alone. Keep chat and voice selection capability-driven, require explicit tool support, and retain text reasoning, grounded retrieval, long-context, policy-following, and agentic evaluations as promotion gates.                                                                            |
| _Synthesizing the Lombard Effect_ ([arXiv:2606.23176](https://arxiv.org/abs/2606.23176)) finds that controlled articulation drives intelligibility more reliably than simple loudness or time stretching, while excessive vocal effort can hurt recognition and naturalness.                    | TTS and realtime delivery guidance now favors careful articulation and moderate vocal effort. Repetitions slow slightly and emphasize key words instead of becoming globally louder. Future listening matrices should include babble, overlapping speech, and steady noise, with intelligibility and naturalness scored separately.                |
| _Low-Latency Real-Time Audio Game Commentary via LLM-Based Parallel Text Generation_ ([arXiv:2606.13322](https://arxiv.org/abs/2606.13322)) demonstrates that overlapping generation with playback and selecting from a bounded candidate buffer can sharply reduce unnatural silence.          | Keiko may overlap governed retrieval or deep work with the interaction plane, but it must not queue speculative factual speech. Any future candidate buffer is bounded, cancellable, latest-valid-first, tied to a committed user turn, and discarded on interruption or context change.                                                           |
| _Endpoint Anticipation for Low-Latency Spoken Dialogue_ ([arXiv:2606.13450](https://arxiv.org/abs/2606.13450)) reports lower latency through speculative LLM/TTS execution, with measurable premature triggers and redundant compute.                                                           | Endpoint anticipation is not enabled by this change. A future capability must keep speculative audio inaudible until endpoint confirmation, never persist partial transcripts, and gate Median Realized Anticipation, Premature Anticipation Rate, Expected Redundant Computation, and Horizon Entry Accuracy alongside normal interruption tests. |
| _Wan-Streamer v0.1_ ([arXiv:2606.25041](https://arxiv.org/abs/2606.25041)) and _v0.2_ ([arXiv:2607.04443](https://arxiv.org/abs/2607.04443)) show the value of a persistent causal interaction state and isolating a latency-critical thinker/control path from expensive performer generation. | Preserve Keiko's responsive media/control path while heavier retrieval or agent work runs behind compact, redacted, cancellable task boundaries. Video avatars and generated visual agents are not implied by the Voice Mode and remain out of scope.                                                                                              |

The immediate product changes are intentionally narrow: listening behavior and delivery articulation.
Speculative endpointing, background answer generation, and native GPT-Live model identifiers remain
deferred until their provider contracts and Keiko governance/evaluation requirements can be proved.

## Invariants preserved

Model Gateway boundary intact; no new runtime media dependencies; no raw audio persisted; the browser
never receives the provider key; spoken Keiko derives from the same persona as written Keiko; voice
remains capability-gated and fully optional.
