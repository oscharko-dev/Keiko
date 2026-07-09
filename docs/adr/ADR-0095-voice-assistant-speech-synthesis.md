# ADR-0095: Voice assistant speech synthesis — Model Gateway text-to-speech adapter, BFF synthesis route, and audio playback engine

## Status

Proposed (Issue #1558, Epic #1556, 2026-06-26)

## Version

0.2.0

## Context

Epic #1556 builds a **colleague-like voice dialogue mode** on top of the completed Epic #491 voice
foundation. Two siblings established the surface this issue consumes:

- **Issue #501 (ADR-0106)** added the optional, capability-gated assistant speech-output **playback
  state machine** — the `voice-playback.ts` contract, the deterministic `voice-playback-state.ts`
  controller, the `useVoicePlayback` binding, and the `VoicePlayback` UI (persistent mute toggle +
  transient status/alert strip). It deliberately deployed **no TTS model**: the controller exposes
  provider-driven lifecycle drivers (`prepare` / `play-started` / `complete` / `fail`) for "the audio
  integration when it lands", and in an STT-only deployment the controller stays dormant in
  `unavailable` and Keiko answers in text.
- **Issue #1557 (ADR-0094)** extended the provider **capability registry**: the `voice` `ModelKind`,
  the `supportsSpeechOutput` sub-capability flag, the product `VoicePersona` (`male`/`female`/
  `neutral`), the credential-tier `ModelProviderConfig.voiceProfiles` persona → voice-id mapping, and
  the selection family `selectSpeechOutputModel` + server-side `selectVoicePersonaVoice` — explicitly
  named "the seam Issue #1558 consumes".

Issue #1558 is the production speech-output **path**: it turns the assistant text answer into audible
output through the configured provider, binding the spoken layer to the existing chat response
lifecycle and keeping the spoken and written answers synchronized. It is the audio integration #501
deferred, built on the registry #1557 added. It adds no dialogue-mode toggle UI, no raw-audio
persistence, and no independent answer generation.

The existing dictation flow (Issue #494, ADR-0100 D4) is the mirror image and the reuse template:
dictation sends audio (multipart) and receives text; synthesis sends text (JSON) and receives audio.
Both ride the single `gatewayFetch` egress seam, so synthesis inherits the same corporate-proxy,
custom-CA, timeout, byte-cap, and content-free error-mapping behavior as every other productive model
call. No new dependency and no new egress path are introduced.

## Decision

### D1 — Provider-neutral text-to-speech adapter on the existing egress seam

`packages/keiko-model-gateway/src/text-to-speech-adapter.ts` adds `requestTextToSpeech`, mirroring
`speech-to-text-adapter.ts`. It POSTs a JSON body (`model`, `input`, `voice`, `response_format`, and
optional `speed` / `instructions`) once to `${endpoint}/audio/speech` — the OpenAI-compatible contract the gateway
already speaks for chat, embeddings, and transcription — and reads the **binary** audio response. There
is no SDK dependency and no retry (a spoken response is interactive; the caller decides). Every failure
is a coded, content-free `TextToSpeechErrorKind` (`wrong-header`, `rate-limited`, `unsupported-model`,
`payload-too-large`, `timeout`, `cancelled`, `transport`, the four `proxy-*` codes, `tls-ca-failure`,
`invalid-response`, and `empty-audio` for a 2xx with no bytes), so the BFF can map it to a
deterministic, secret-free HTTP response. The audio bytes and content-type are the only values that
escape the module; the answer text leaves only as the request, and the raw provider body beyond the
audio, the provider URL, and the credential never do.

### D2 — Bounded binary response reader

`http.ts` gains `readBytesCapped`, the binary sibling of `readJsonCapped`: it streams the response body
into a single `ArrayBuffer`-backed `Uint8Array` and aborts when the cumulative size exceeds the cap
(default `MAX_SPEECH_AUDIO_BYTES = 6_000_000`, several minutes of compressed speech). A provider that
streams more is rejected as `invalid-response` rather than exhausting memory — the same bounded-egress
guarantee every other gateway call inherits. This is the "stream or chunk where supported with bounded
memory" decision: the response is consumed as a capped stream, but a single bounded clip per turn — not
per-sentence chunking — is the deterministic baseline, because it preserves the exact spoken-equals-
visible guarantee (D7) without a gapless multi-clip queue.

### D3 — BFF synthesis route with content-free envelopes

`packages/keiko-server/src/voice-handlers.ts` adds `handleVoiceSpeak` (`POST /api/voice/speak`),
mirroring `handleVoiceTranscribe`. It is capability-gated: it synthesizes only when
`resolveVoiceCapability(...).capabilities.speechOutput` is advertised and voice is not policy-disabled,
and otherwise returns a deterministic, secret-free `VOICE_UNAVAILABLE` so the conversation degrades to
text. The gate runs **before** the body is read, so a disabled deployment does zero work. The answer
text rides inside the existing JSON + CSRF request envelope, preserving the server's state-changing-
request invariant unchanged. Coded adapter failures map to fixed, redacted envelopes
(`VOICE_RATE_LIMITED` → 429, `VOICE_TIMEOUT` → 504, `payload-too-large` → 413,
`unsupported-model` → 503 unavailable, everything else → 502 `VOICE_PROVIDER_ERROR`) carrying no
provider body, URL, path, IP, or credential.

### D4 — Server-side persona → voice-id resolution; the voice id never leaves the server

The route accepts the answer `text` and an optional `persona` from the closed `VOICE_PERSONAS` set. It
resolves the model + provider voice id with the #1557 seam: a requested persona is honored when mapped
(`selectVoicePersonaVoice`); otherwise the first persona-mapped provider in canonical order is used;
otherwise the cheapest `selectSpeechOutputModel` with the adapter's provider-neutral default voice. The
resolved `voiceId` is sensitive (it lives on the credential-tier `voiceProfiles`) and is forwarded to
the provider but **never** appears in any response. This keeps `keiko-tts` deployments that map personas
and bare speech-output deployments without persona mappings both functional.

### D5 — Bounded, speech-safe rendering; over-long answers degrade rather than truncate

The route bounds the answer at `MAX_SPEECH_INPUT_CHARS = 4096` (the OpenAI-compatible `/audio/speech`
input ceiling). An over-long answer is **rejected** (`413 PAYLOAD_TOO_LARGE`) and the spoken layer
degrades to text — it is never truncated, because a truncated clip would make the spoken output diverge
from the visible text and break AC2. The visible answer is always present in the transcript regardless.

After validating that raw bound, the BFF derives a speech-only rendering with `toSpeakableText`. Link
labels and prose remain, while URL destinations, Markdown syntax, numeric citation markers, source /
reference appendices, images, HTML, and fenced code are omitted. Inline code keeps its short textual
content. The visible message remains unchanged and reviewable with clickable sources; only presentation
syntax that is unusable or unsafe when spoken is removed. If no speakable content remains, synthesis is
rejected rather than producing silence.

Realtime grounded-tool HTTP results retain both the full answer and its speech projection for the local
chat. The browser sends only the speech projection, delivery instruction, status, and no-evidence flag in
the provider function-call output; URLs, citations, source labels, and persistence ids do not cross into
the provider's spoken-response context.

### D6 — Success body is base64 audio, not redacted, with a canonicalized MIME type

The success body is `{ audio: <base64>, mimeType }`. The audio is content-free synthesized speech of
the already-visible answer and carries no credential or URL, so it is **not** passed through the secret
redactor: redacting a multi-megabyte base64 blob would risk corrupting the audio with no security
benefit. The `mimeType` is canonicalized against a closed server allowlist (`audio/mpeg` default), so no
provider-controlled string crosses the boundary. The audio buffer goes out of scope after the response
and is never written to the evidence store, a side file, a log, or any on-disk location.

### D7 — Audio playback engine bound to the visible assistant message (semantic answer stays aligned)

`packages/keiko-ui/.../hooks/useAssistantSpeech.ts` is the audio integration #501 deferred. It wraps the
`useVoicePlayback` reducer and, when speech output is advertised and a **complete** assistant message is
visible, synthesizes that message's exact rendered `content` through `/api/voice/speak`, plays the
returned audio through one `HTMLAudioElement`, and drives the reducer `prepare → play-started → complete
/ fail`. The synthesis input is keyed by the assistant message id, so a turn is spoken at most once and
always speaks the text the reader sees (AC2). A streaming or pending turn is excluded until it settles.
The hook holds no credential and never persists the audio: the object URL lives only for one spoken
turn.

The browser always submits the complete visible message; the server owns the deterministic speech-safe
projection in D5. This keeps answer meaning aligned while allowing links and citations to remain clickable
in chat instead of being read as punctuation and URL tokens.

### D8 — Deterministic resource release on stop, mute, switch, and unmount

Stopping, muting, switching the visible assistant message (session switch), or unmounting runs a single
idempotent teardown: it aborts the pending synthesis fetch, pauses and releases the audio element, and
revokes the object URL (AC3). Mute records the user's preference — a message that arrives muted is
marked seen but never spoken, and muting mid-playback stops and releases. A late provider answer for an
aborted turn is dropped (guarded by both the React-cleanup flag and the abort signal), so it can never
start playback on a turn that is already gone.

### D9 — Failure degrades to the visible text

A synthesis or playback failure transitions the reducer to `failed` (coded failure kinds map the BFF
envelopes: `VOICE_RATE_LIMITED` → `rate-limited`, `VOICE_TIMEOUT` → `timeout`, `VOICE_UNAVAILABLE` →
`unavailable`, otherwise `provider-error`; a blocked autoplay or decode error → `internal`). The
`VoicePlayback` status strip renders the "shown as text" fallback and the written answer is never
touched (AC4). The hook never reads or mutates the transcript text beyond passing the visible content to
synthesis.

### D10 — Capability-gated delivery instructions and streaming backpressure

`supportsSpeechSynthesisInstructions` is an optional voice capability that requires
`supportsSpeechOutput`. When advertised, the BFF sends provider delivery guidance for the user's language,
warm colleague-like tone, natural pacing, subtle emotion, varied intonation, and clear pronunciation. It
is omitted for older compatible endpoints that reject the field. The PCM streaming route treats
`ServerResponse.write() === false` as ordinary backpressure and waits for `drain`; only a real client close
aborts synthesis. A committed stream failure emits a redacted, correlation-keyed operator diagnostic and
still ends the partial response deterministically.

## Consequences

- **No new dependency, no new egress path, no contract version bump.** Synthesis reuses the
  `gatewayFetch` seam, the JSON + CSRF envelope, the redaction helpers, the `useVoicePlayback`
  controller, and the #1557 capability/selection registry. The new `keiko-model-gateway` exports
  (`requestTextToSpeech`, `MAX_SPEECH_AUDIO_BYTES`, and the `TextToSpeech*` types) are added to the root
  package-surface contract.
- **Capability-gated and fail-closed.** A no-voice / STT-only / policy-disabled / unreachable deployment
  renders no playback engine activity and answers in text. Only a configured speech-output provider
  arms the path.
- **No raw generated audio persistence.** The audio exists only in memory for the BFF response and for
  one browser playback turn; no evidence record, file, or log holds it.
- **Bounded long-answer behavior.** Answers within 4096 characters are spoken as one bounded clip;
  longer answers degrade to text rather than risk a divergent or unbounded playback. Per-sentence
  chunking is a deliberate non-goal for this issue to preserve the spoken-equals-visible guarantee.
- **No live provider in CI.** The synthesis/playback lifecycle, cleanup, persona resolution, and
  failure mapping are proven by deterministic unit/hook suites that run in the required `ci` check; the
  browser smoke proves the capability-gated control renders and stays text-capable.

## Alternatives Considered

- **Stream the audio response straight to the browser as `audio/*`.** Rejected: the BFF response
  pipeline is JSON-envelope-shaped (redactor, `errorBody`), and a base64 clip inside the existing
  envelope preserves every BFF invariant with bounded, deterministic cleanup. Chosen consistent with
  the dictation flow's base64-in-JSON inbound shape.
- **Per-sentence chunked synthesis for arbitrarily long answers.** Rejected for this issue: it adds a
  gapless multi-clip queue, partial-failure handling, and an AC2 reconstruction risk for marginal
  benefit. Bounded single-clip synthesis with a documented input limit is the simpler, safer altitude.
- **Truncating an over-long answer to fit the provider input bound.** Rejected: it would break AC2
  (spoken must not diverge from visible). Over-long answers degrade to text instead.
- **A separate audio-player subsystem.** Rejected: the issue requires extending the existing
  playback-state design; `useAssistantSpeech` wraps `useVoicePlayback` rather than replacing it.

## Related

- ADR-0094: Voice provider capability registry extension — the `selectSpeechOutputModel` /
  `selectVoicePersonaVoice` selection family, the `supportsSpeechOutput` flag, and the credential-tier
  `voiceProfiles` persona → voice-id mapping this ADR consumes (D4).
- ADR-0106: Voice assistant speech-output playback (Issue #501) — the `voice-playback.ts` contract, the
  `voice-playback-state.ts` controller, and the `useVoicePlayback` binding this ADR drives (D7).
- ADR-0100: Capability-gated Voice Digital Twin architecture (Issue #492) — D4 single egress seam, the
  voice capability ladder, and the no-raw-audio-persistence invariant carried forward here.
- ADR-0038: the `gatewayFetch` egress seam this adapter reuses for proxy / custom-CA / timeout / byte-cap
  behavior.
- ADR-0019: package trust direction (contracts is a leaf; the BFF consumes `model-gateway` exports; the UI
  reaches the provider only through the BFF).
- `docs/voice/assistant-speech-synthesis.md` — the `keiko-tts` / `keiko-audio-output` provider contract and
  selection record.
- Issue [#1558](https://github.com/oscharko-dev/Keiko/issues/1558); Epic
  [#1556](https://github.com/oscharko-dev/Keiko/issues/1556).

## Date

2026-06-26
