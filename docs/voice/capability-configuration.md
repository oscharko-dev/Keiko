# Voice capability: configuration and disabling

Operator and developer reference for configuring, registering, and disabling Keiko's optional voice
capability. This is the implementation contract delivered by Issue
[#493](https://github.com/oscharko-dev/Keiko/issues/493) (Epic #491), realizing decisions **D1, D2, D5,
and D7** of [ADR-0100](../adr/ADR-0100-voice-digital-twin-capability-architecture.md).

Voice is **optional and capability-gated**. Keiko starts and remains fully usable when no voice model is
configured, is unreachable, or is disabled by policy. Capability detection is **metadata-only**: it never
calls an external endpoint during ordinary startup, and the resolved capability is **content-free** (only
enum literals and booleans) — no provider base URL, credential, model id, audio, or transcript ever reaches
the browser or any log.

## 1. The voice capability model

Voice capability is advertised through the existing Model Gateway `ModelCapability` metadata
(`packages/keiko-contracts/src/gateway.ts`). Issue #493 adopts the **new `ModelKind` literal** mechanism of
ADR-0100 D5: a voice endpoint declares `kind: "voice"`, which keeps it structurally distinct from `chat`,
`embedding`, and `ocr-vision`. A voice-kind model is therefore never conversation-eligible (it cannot appear
in the chat model selector), never workflow-eligible, and never elected for chat completion.

The voice modality is refined by additive optional flags:

| Field                                 | Meaning                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `supportsSpeechInput`                 | Speech-to-text / transcription (audio in → text); composer dictation.         |
| `supportsSpeechOutput`                | Speech output / synthesis (text → audio playback).                            |
| `supportsSpeechSynthesisInstructions` | Synthesis accepts tone, pacing, and intonation instructions.                  |
| `supportsRealtimeVoice`               | Realtime, full-duplex speech (interruptible, colleague-like).                 |
| `supportsSemanticTurnDetection`       | Realtime endpoint accepts semantic VAD with automatic eagerness.              |
| `realtimeTranscriptionModel`          | Input transcription model for the realtime dialogue session.                  |
| `voiceProviderLocality`               | Where the provider runs: `azure-foundry`, `customer-hosted`, or `local-only`. |

Two invariants are enforced by the config parser (`packages/keiko-model-gateway/src/config.ts`), identically
for the strict top-level `capabilities` array and the inline per-provider `capability`:

1. **Voice fields require `kind: "voice"`.** A `chat`/`embedding`/`ocr-vision` capability that declares any
   voice flag or `voiceProviderLocality` is rejected.
2. **A voice capability must advertise at least one sub-capability and a locality.** A `kind: "voice"` record
   with no `supportsSpeechInput`/`supportsSpeechOutput`/`supportsRealtimeVoice` set to `true`, or without
   `voiceProviderLocality`, is rejected — fail-closed, and the provider is represented explicitly rather than
   inferred from an endpoint URL or environment name.
3. **Provider tuning is dependency-checked.** `supportsSpeechSynthesisInstructions` requires speech
   output. Semantic turn detection and a realtime transcription-model override require realtime voice.
   Declaring unsupported tuning fails configuration instead of sending speculative fields to a provider.

Adding the `voice` kind is a structural change, so `CONVERSATION_CAPABILITY_CONTRACT_VERSION` is bumped to
`3`. The additive sub-capability flags do not themselves bump the version.

## 2. Registering the existing `keiko-stt` deployment (STT-only)

### First-run setup for operators

The credential dialog groups audio configuration by user-visible outcome and uses one shared audio
connection:

- **Dictate** needs the exact speech-to-text deployment name.
- **Digital Voice** needs the exact Realtime deployment name. An STT deployment alone cannot enable
  live conversation.
- **Read aloud** optionally needs a text-to-speech deployment name.

Enter the audio endpoint URL and credential once, then fill only the deployment roles the installation
supports. Keiko stores each role as explicit capability metadata and shows the corresponding controls only
when that capability is configured. Output-capable roles receive the neutral `alloy` persona by default so a
valid Realtime installation exposes Digital Voice immediately; an operator can replace the provider voice id
in the same dialog. Advanced auth-header, locality, and timeout fields normally keep their defaults.

The dialog validates configuration structure before saving, but it does not upload synthetic customer audio.
Provider availability is therefore verified on first use, and failures remain content-free and credential-free.

The Azure Foundry `keiko-stt` deployment is registered as an **STT-only** voice provider through
configuration — no global Azure dependency is hardcoded, and Azure is one valid provider locality among
three. Declare it as a Model Gateway provider with an inline voice capability:

```jsonc
{
  "providers": [
    {
      "modelId": "keiko-stt",
      "baseUrl": "https://<your-foundry-host>/...",
      "apiKeySecretRef": "voice/keiko-stt", // sealed vault reference (preferred)
      "capability": {
        "kind": "voice",
        "supportsSpeechInput": true,
        "voiceProviderLocality": "azure-foundry",
        "costClass": "low",
        "latencyClass": "fast",
        "throughputHint": "Azure Foundry STT deployment",
        "preferredUseCases": ["Dictation"],
        "knownLimitations": ["Transcription only; no conversation"],
      },
    },
  ],
}
```

A customer-hosted controlled-network deployment uses the identical shape with
`"voiceProviderLocality": "customer-hosted"` and the customer endpoint (which may be a private/RFC-1918
host). A full-realtime provider additionally sets `"supportsRealtimeVoice": true` (and/or both
`supportsSpeechInput` and `supportsSpeechOutput`).

For a current provider that supports semantic endpointing and the low-latency transcription model, the
realtime capability adds:

```jsonc
{
  "kind": "voice",
  "supportsRealtimeVoice": true,
  "supportsSemanticTurnDetection": true,
  "realtimeTranscriptionModel": "gpt-realtime-whisper",
  "voiceProviderLocality": "customer-hosted",
}
```

Omit either tuning field when the configured endpoint does not support it. The server then uses its
provider-compatible server-VAD and transcription defaults; the browser does not overwrite them.

### Credentials

Provider credentials follow the existing Model Gateway resolution and **never reach the browser**. In
precedence order:

1. Per-model environment variable: `KEIKO_MODEL_KEIKO_STT_API_KEY` (and `KEIKO_MODEL_KEIKO_STT_BASE_URL`).
2. A sealed vault reference via `apiKeySecretRef` (ADR-0046 local credential vault), resolved server-side.
3. File plaintext `apiKey` (legacy) / `KEIKO_DEFAULT_API_KEY`.

The long-lived key stays on the Keiko host. The voice capability resolution carries no credential, so no
secret can leak into evidence or UI logs.

## 2a. Product voice personas (male / female / neutral) — Issue #1557

A **product voice persona** is the voice identity a user hears — `male`, `female`, or `neutral` — mapped to a
provider-specific voice id by configuration (Issue [#1557](https://github.com/oscharko-dev/Keiko/issues/1557),
[ADR-0094](../adr/ADR-0094-voice-provider-capability-registry-extension.md) D1/D2). A persona is a
**product-level** concept, deliberately distinct from the `VoiceProfile` capability degradation ladder
(`none` / `speech-to-text` / `speech-output` / `full-realtime`): the ladder describes _how much voice the
deployment can do_; a persona describes _what the assistant sounds like_. Personas are **output** voices, so
they are declared only on a voice provider that advertises speech output or realtime.

The persona → provider-voice-id mapping is **provider-sensitive** and lives on the credential tier, beside
`apiKey`: a provider's optional `voiceProfiles` array. It is **never serialized to the browser** — the safe
config projection (`toSafeObject`) drops it by allowlist, and the contracts leaf cannot reference it. Only the
**content-free** persona enums (`supportedVoicePersonas`, derived at parse time) cross to the UI, so a user
can choose _which persona_ without the browser ever learning _which provider voice id_ backs it.

```jsonc
{
  "providers": [
    {
      "modelId": "keiko-tts",
      "baseUrl": "https://<your-foundry-host>/...",
      "apiKeySecretRef": "voice/keiko-tts",
      "capability": {
        "kind": "voice",
        "supportsSpeechOutput": true,
        "voiceProviderLocality": "azure-foundry",
        "costClass": "low",
        "latencyClass": "fast",
        "throughputHint": "Azure Foundry TTS deployment",
        "preferredUseCases": ["Speech output"],
        "knownLimitations": [],
      },
      // Credential-tier persona → provider voice-id mapping (never reaches the browser):
      "voiceProfiles": [
        { "persona": "male", "voiceId": "<provider-male-voice-id>" },
        { "persona": "female", "voiceId": "<provider-female-voice-id>" },
        { "persona": "neutral", "voiceId": "<provider-neutral-voice-id>" },
      ],
    },
  ],
}
```

A `keiko-realtime` provider (`"supportsRealtimeVoice": true`) declares `voiceProfiles` identically. The config
parser enforces three invariants:

1. `voiceProfiles` is valid **only** on a `kind: "voice"` capability that advertises `supportsSpeechOutput` or
   `supportsRealtimeVoice`; an STT-only or non-voice provider that declares it is rejected.
2. Each entry's `persona` is one of `male` / `female` / `neutral`, `voiceId` is a non-empty string, and a
   persona may not be declared twice.
3. `supportedVoicePersonas` (the content-free derived view) is **not** an accepted input key — it is derived
   from `voiceProfiles` (against the effective merged capability) and re-derived on every reload, so it is
   never persisted and cannot be smuggled past the strict parser.

Server-side, `selectVoicePersonaVoice(config, persona)` resolves the cheapest configured output/realtime
provider that maps the requested persona to its `voiceId`; the resolver result carries the `voiceId` and
therefore stays server-side. It is the seam the assistant speech-output feature (Issue #1558) consumes.

> **Realtime voice ids are a narrower set than text-to-speech voice ids.** The realtime models accept
> `alloy`, `ash`, `ballad`, `cedar`, `coral`, `echo`, `marin`, `sage`, `shimmer`, and `verse`; some text-to-speech-only voices
> (for example `nova` and `onyx`) are **rejected** by the realtime model and would break realtime session
> creation. For this reason a `keiko-realtime` provider's `voiceProfiles` must map each persona to a
> realtime-valid voice id. The realtime negotiation applies `resolveRealtimeVoice` as a defense-in-depth
> guard: a configured voice id outside the realtime set falls back to `alloy` rather than failing the
> session. A `keiko-tts` provider keeps the broader text-to-speech voice set.

## 3. Reading the capability: the BFF endpoint

The UI reads the resolved voice capability before rendering any voice affordance:

```
GET /api/voice/capability  →  { "voice": VoiceCapabilityResolution }
```

`VoiceCapabilityResolution` (content-free, defined in `packages/keiko-contracts/src/gateway.ts`):

```jsonc
{
  "available": true,
  "profile": "speech-to-text", // "none" | "speech-to-text" | "speech-output" | "full-realtime"
  "capabilities": { "speechToText": true, "speechOutput": false, "realtimeVoice": false },
  "transport": { "websocketControl": true, "webrtcMedia": false },
  "availableVoicePersonas": [], // Issue #1557: content-free product personas; [] for no-voice / STT-only
  "providerLocality": "azure-foundry", // omitted when none or mixed
  "reason": "no-voice-provider", // present only when available is false
}
```

The UI client helper is `fetchVoiceCapability()` in `packages/keiko-ui/src/lib/api.ts`. When `available` is
`false` (profile `none`), the UI renders **no voice affordance at all** — not a disabled or error-raising
control.

## 4. Effective profiles and the degradation ladder

The resolver (`resolveVoiceCapability` in `packages/keiko-model-gateway/src/model-selection.ts`) maps the
configured, reachable voice providers to an effective profile:

| Configured voice capability                        | Effective profile | `available` | `reason`               |
| -------------------------------------------------- | ----------------- | ----------- | ---------------------- |
| None (or non-voice providers only)                 | `none`            | `false`     | `no-voice-provider`    |
| Speech input only                                  | `speech-to-text`  | `true`      | —                      |
| Speech output only                                 | `speech-output`   | `true`      | —                      |
| Realtime, **or** both speech input + speech output | `full-realtime`   | `true`      | —                      |
| Voice disabled by policy                           | `none`            | `false`     | `policy-disabled`      |
| Voice provider(s) configured but unreachable       | `none`            | `false`     | `provider-unreachable` |

Full realtime conversation requires the provider to advertise realtime speech **or** both speech input and
speech output (ADR-0100 D2 / Issue #493 AC3). STT-only is never reported as full conversation. Only
**configured** providers are eligible: a voice capability that names no configured provider can never be
elected (the same fail-closed rule as model selection).

## 5. Disabling voice

There are two ways to ensure no voice capability is reported:

- **Do not configure a voice provider.** This is the default and the regulated baseline; the endpoint reports
  `available: false`, `reason: "no-voice-provider"`.
- **Set the kill-switch** `KEIKO_VOICE_DISABLED=1` (or `true`). Even when a voice provider is configured, the
  resolver reports `available: false`, `reason: "policy-disabled"`, and the UI renders no voice affordance.
  This lets a regulated deployment disable voice without removing provider configuration.

In every case Keiko starts normally and all non-voice features remain fully usable.

## 6. Scope boundary

Issue #493 adds capability **metadata, resolution, and the read endpoint only**. It does **not** add
microphone capture, WebRTC transport, UI controls, or any relaxation of the
`Permissions-Policy: ... microphone=() ...` header or the CSP (`default-src 'none'` / `connect-src 'self'`).
Those are owned by later child issues (#496/#497 transport, #503+ interaction) and remain gated behind a
security review (ADR-0100 D6). Capability detection performs no network probe; runtime reachability signals
(e.g. an open circuit breaker) are supplied by the caller through `unreachableProviderIds` and are wired by
the transport child issue.

## References

- [ADR-0100](../adr/ADR-0100-voice-digital-twin-capability-architecture.md) — decisions D1, D2, D5, D7.
- [ADR-0094](../adr/ADR-0094-voice-provider-capability-registry-extension.md) — product voice personas,
  server-side voice-id mapping, and kind-aware readiness (Issue #1557).
- [architecture.md](architecture.md) §2–§5 — capability gating, profiles, degradation.
- [deployment-profile-matrix.md](deployment-profile-matrix.md) — provider × environment matrix.
- [privacy-contract.md](privacy-contract.md) — credential and redaction posture.
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491); Issue
  [#493](https://github.com/oscharko-dev/Keiko/issues/493).
