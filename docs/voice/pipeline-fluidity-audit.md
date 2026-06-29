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

## Fixed in this change

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

## Prioritized follow-ups (identified, deliberately deferred)

These were confirmed real but are deferred to keep this change contained, well-tested, and within the
shipped subsystem's invariants. They are ordered by perceived-fluidity value.

1. **Turn-based VAD end-of-turn + voice-activated barge-in.** The shipped dialogue mode (STT+TTS)
   ends a user turn only when the user manually taps the mic again, and barge-in is button-driven.
   A WebAudio `AnalyserNode` on the dictation `MediaStream` (trailing-silence end-of-turn + energy-
   onset barge-in) would make turns feel natural. Deferred because it requires exposing the shared
   dictation recorder's stream and WebAudio test infrastructure (regression surface on composer
   dictation, #495). _Files: `useVoiceDialogueSession.ts`, `voice-dialogue-session.ts`,
   `dictation-recorder.ts`._ Note: realtime mode already gets natural turn-taking via `server_vad`.
2. **Streaming assistant-speech playout (MSE/Web Audio).** Start playback on the first audio chunk
   instead of buffering the whole clip. With opus the whole-clip wait is already ~1.1s versus a
   ~0.9s time-to-first-audio floor, so the remaining benefit is ~0.2s; it is a larger architectural
   change to the audible path and warrants its own change with perceptual sign-off. _Files:
   `useAssistantSpeech.ts`, `voice-handlers.ts` (reuse the existing SSE seam), `lib/api.ts`._
3. **Control-plane WS heartbeat + client negotiate() timeout.** Ping/pong liveness and a browser-side
   handshake timeout so a half-open connection cannot stall on "negotiating". _Files:
   `voice-realtime.ts`, `voice-realtime-client.ts`._
4. **Per-user persona selection for realtime.** Plumb the selected `male`/`female`/`neutral` persona
   through the control protocol so realtime honors it (today it uses the configured neutral default).
5. **Live interrupt offset.** Source the barge-in offset from the live media position rather than the
   previous interrupt's stored offset. _File: `useVoiceDialogueSession.ts`._
6. **STT interim/verbose_json.** Request `verbose_json` for real duration (the current `json` path
   parses `confidence`/`duration` that are never returned) and surface interim transcripts. _File:
   `speech-to-text-adapter.ts`._

## Invariants preserved

Model Gateway boundary intact; no new runtime media dependencies; no raw audio persisted; the browser
never receives the provider key; spoken Keiko derives from the same persona as written Keiko; voice
remains capability-gated and fully optional.
