# Assistant speech synthesis (Issue #1558)

This document records the production assistant speech-output path: how the assistant text answer becomes
audible output through a configured provider, and the provider contract the Model Gateway adapter speaks.
It complements [`assistant-speech-output.md`](./assistant-speech-output.md), which describes the optional
playback **state machine** (Issue #501); this document describes the **synthesis** that drives it
(Issue #1558, ADR-0095).

## Path overview

```
visible assistant message text
  → useAssistantSpeech (browser)                 # binds speech to the rendered message
  → POST /api/voice/speak/stream (preferred)     # JSON + CSRF; raw PCM response
  ↳ POST /api/voice/speak (buffered fallback)    # JSON + CSRF; base64 Opus response
  → toSpeakableText (BFF)                        # removes URL/citation syntax
  → requestTextToSpeech (Model Gateway)          # gatewayFetch egress seam
  → {endpoint}/audio/speech (provider)           # OpenAI-compatible TTS contract
  ← PCM → AudioWorklet, or Ogg/Opus → HTMLAudioElement
```

The audio is held only in memory: streamed PCM is consumed by the AudioWorklet, while the buffered
fallback creates one object URL that is revoked on stop, mute, session switch, or unmount. No raw generated
audio is written to the evidence store, a side file, a log, or any on-disk location.

## Provider contract

### Selected contract: OpenAI-compatible `audio/speech`

The adapter speaks the OpenAI-compatible **`POST {endpoint}/audio/speech`** contract — the same surface
the gateway already speaks for chat, embeddings, and transcription, and the surface supported by the
configured Azure Foundry voice endpoint. `keiko-tts` is one configured development deployment alias, not a
hard-coded universal model name. This provider-neutral contract is selected because:

- It reuses the single `gatewayFetch` egress seam (ADR-0038), so synthesis inherits the corporate-proxy,
  custom-CA, timeout, byte-cap, and content-free error behavior of every other productive model call —
  no new egress path, no SDK dependency, no new supply-chain surface.
- It is the exact mirror of the already-shipped dictation adapter (`keiko-stt`, Issue #494): dictation
  sends audio and receives text; synthesis sends text and receives audio. The two share request
  construction, error classification, and the proxy/CA fallback path.
- It is provider-neutral. Azure Foundry's voice deployment is one valid `voiceProviderLocality` among
  three; any provider exposing the OpenAI-compatible `audio/speech` contract is configurable without code
  change.

**Request** (JSON):

| Field             | Source                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `model`           | The configured speech-output provider model id (`selectSpeechOutputModel`).                            |
| `input`           | Speech-safe prose derived from the bounded visible answer (≤ 4096 raw characters).                     |
| `voice`           | Required server-resolved provider voice id from the explicit persona mapping.                          |
| `response_format` | `pcm` for streaming; `opus` for the buffered product fallback; other adapter formats remain supported. |
| `speed`           | Optional playback-speed multiplier when the caller pins one.                                           |
| `instructions`    | Capability-gated delivery guidance for language, emotion, pacing, and intonation.                      |

**Response**: binary audio bytes with an `audio/*` content type. The adapter reads them with the bounded
`readBytesCapped` reader (default cap 6 MB) and labels the result from the response content type, falling
back to the MIME derived from the requested `response_format`. A 2xx response with no bytes is treated as
`empty-audio` and never played as silence.

### Considered: a generic `keiko-audio-output` deployment class

A generic `keiko-audio-output` class (a non-OpenAI audio-output provider with a bespoke request/response
shape) was considered. It is **not** selected as the implementation target: introducing a second
provider contract now would add a divergent egress path and request shape for no current deployment
benefit, and Epic #1556's configured endpoint already speaks the OpenAI-compatible contract. The design
keeps the door open without paying for it: any provider difference is isolated **behind the Model Gateway
adapter** (the adapter is the only module that knows the wire shape), exactly as the Engineering Notes
require. Should a `keiko-audio-output` provider be onboarded later, it is a new adapter branch plus
selection wiring — no change to the BFF route, the playback engine, or the capability registry. The
adapter's coded, content-free outcome contract is the stable seam that absorbs such differences, and the
adapter unit tests document the expected request/response shape.

## Persona → voice-id resolution (server-side)

The product exposes three content-free voice personas (`male` / `female` / `neutral`, Issue #1557). The
sensitive persona → provider-voice-id mapping lives on the credential-tier `ModelProviderConfig.voiceProfiles`
and is resolved **server-side** by `selectVoicePersonaVoice`. The BFF synthesis route:

1. honors a requested persona only when a speech-output provider maps it exactly;
2. without a requested persona, uses the first explicitly mapped speech-output voice in canonical
   persona order; and
3. fails closed before provider egress when no explicit mapping exists.

The resolved voice id is forwarded to the provider but **never** returned to the browser — only the
synthesized audio and a canonicalized MIME type cross the BFF boundary. There is deliberately no
universal `alloy` or other provider-default voice at the adapter boundary.

## Speech-safe rendering

The written answer remains the review surface and keeps its Markdown links and citations. Before
synthesis, the BFF retains prose, headings, list text, link labels, and short inline identifiers, while
removing URL destinations, citation markers, source/reference appendices, images, HTML, and fenced code.
Only the exact persisted assistant message selected by the canonical chat send outcome can arm this
projection. The Realtime provider receives neither that answer nor a `spokenAnswer`; it owns no
assistant response path. A result containing no speakable content is not sent to the TTS provider.

## Failure behavior (degrade to text)

Provider and playback failures degrade the spoken layer to the visible text without breaking the
conversation. Coded adapter failures map to fixed, secret-free BFF envelopes:

| Adapter failure                     | BFF status / code          | Playback failure kind |
| ----------------------------------- | -------------------------- | --------------------- |
| `rate-limited`                      | 429 `VOICE_RATE_LIMITED`   | `rate-limited`        |
| `timeout`                           | 504 `VOICE_TIMEOUT`        | `timeout`             |
| `payload-too-large`                 | 413 `PAYLOAD_TOO_LARGE`    | `provider-error`      |
| `unsupported-model`                 | 503 `VOICE_UNAVAILABLE`    | `unavailable`         |
| `missing-voice`                     | 503 `VOICE_UNAVAILABLE`    | `unavailable`         |
| `transport` / `empty-audio` / other | 502 `VOICE_PROVIDER_ERROR` | `provider-error`      |

A blocked browser autoplay or a decode error surfaces as an `internal` playback failure. In every case
the written answer stays visible in the transcript.

## Limits and non-goals

- **Input bound**: 4096 characters. Longer answers are rejected (`413`) and degrade to text rather than
  being truncated, so the spoken output can never diverge from the visible text.
- **One bounded stream per turn**: the preferred path streams 24 kHz PCM into an AudioWorklet with a
  small jitter prime. Node backpressure waits for `drain`; stop, mute, or barge-in aborts the provider
  stream and flushes the worklet. The buffered clip remains the compatibility fallback.
- **No raw generated audio persistence.** Dialogue-mode availability is governed separately by the
  Realtime-plus-TTS capability predicate; this synthesis path does not create another mode or answer path.

## Configuration

A deployment enables assistant speech output by configuring a `kind: "voice"` provider that advertises
`supportsSpeechOutput: true` and maps at least one `voiceProfiles` persona to an explicit provider voice id.
The parser may represent speech-output capability without a mapping, but synthesis then fails closed before
provider egress and the deployment is not usable for spoken output.
Set `supportsSpeechSynthesisInstructions: true` only when the selected synthesis model accepts delivery
instructions; otherwise Keiko omits that field for compatibility.
See [`capability-configuration.md`](./capability-configuration.md) for the full provider configuration
surface. With no speech-output provider configured, the synthesis route answers `VOICE_UNAVAILABLE`, the
playback control is absent, and Keiko answers in text.
