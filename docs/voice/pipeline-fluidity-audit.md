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

## Invariants preserved

Model Gateway boundary intact; no new runtime media dependencies; no raw audio persisted; the browser
never receives the provider key; spoken Keiko derives from the same persona as written Keiko; voice
remains capability-gated and fully optional.
