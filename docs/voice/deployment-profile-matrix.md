# Voice Digital Twin — deployment profile matrix

Deployment profile matrix for Epic #491, expanding
[ADR-0100](../adr/ADR-0100-voice-digital-twin-capability-architecture.md) decision D7. The provider profile is
**not** assumed constant across environments; each environment selects whichever provider profile its
configured capabilities support. Azure Foundry is **one** valid provider, never a required destination.

## 1. Provider profiles (capability axis)

See [architecture.md](architecture.md) §3 for full definitions.

| Provider profile      | Voice affordance                  | Required advertised capability       |
| --------------------- | --------------------------------- | ------------------------------------ |
| `none`                | No voice UI                       | None                                 |
| `speech-to-text only` | Composer dictation (audio → text) | Speech input / transcription         |
| `speech output only`  | Assistant speech playback         | Speech output                        |
| `full realtime voice` | Interruptible canonical Twin      | Realtime input + chat + explicit TTS |

## 2. Environment profiles (deployment axis)

| Environment profile                                   | Typical provider                                             | Network posture                                      | Notes                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Azure Foundry development / academic**              | Azure AI Foundry / Azure OpenAI (e.g. `keiko-stt`, realtime) | Egress to the configured Azure endpoint via proxy/CA | Development and higher-education contexts; one valid provider profile.            |
| **Customer-hosted controlled-network (professional)** | Customer-operated model endpoint (may be private/RFC-1918)   | Egress only to the configured customer endpoint      | Regulated bank/insurance professional deployments; private hosts are first-class. |
| **No-voice**                                          | No voice provider configured                                 | No voice egress at all                               | Default and regulated baseline; Keiko fully usable.                               |

## 3. Profile × environment matrix

Each cell states the **expected effective voice profile** and the **data-egress destination** for that
combination. "Configured endpoint" always means an endpoint declared as a Model Gateway provider with a
`ModelCapability` record and selected through runtime capability metadata (ADR-0100 D4/D5).

| Environment \ Capability       | `none`                 | `speech-to-text only`                                 | `speech output only`                            | `full realtime voice`                                    |
| ------------------------------ | ---------------------- | ----------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------- |
| **Azure Foundry dev/academic** | No voice UI; no egress | Dictation; audio/transcript → configured Azure STT    | Speech playback; text → configured Azure TTS    | Mic → Realtime transcription; final → chat; answer → TTS |
| **Customer-hosted controlled** | No voice UI; no egress | Dictation; audio/transcript → configured customer STT | Speech playback; text → configured customer TTS | Mic → Realtime transcription; final → chat; answer → TTS |
| **No-voice**                   | No voice UI; no egress | n/a (no STT configured → degrades to `none`)          | n/a (degrades to `none`)                        | n/a (degrades to `none`)                                 |

**Reading the matrix:**

- Every non-`none` cell egresses **only** to the configured model endpoint for the active capability — no
  other destination (ADR-0100 D4).
- When a capability is not advertised in an environment, the effective profile **degrades** down the ladder in
  [architecture.md](architecture.md) §5; it never produces a broken affordance.
- The same Keiko build serves all cells; only configuration and runtime capability metadata differ.

## 4. Transport and network requirements per profile

| Profile               | Control plane       | Media plane                          | Firewall / NAT notes                                                                       |
| --------------------- | ------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `none`                | n/a                 | n/a                                  | No voice egress.                                                                           |
| `speech-to-text only` | Loopback HTTP + SSE | Audio to configured STT via gateway  | Outbound to the configured STT endpoint via `gatewayFetch` (proxy/CA-aware).               |
| `speech output only`  | Loopback HTTP + SSE | Audio from configured TTS            | Outbound to the configured TTS endpoint via `gatewayFetch`.                                |
| `full realtime voice` | Loopback WebSocket  | Send-only browser WebRTC (DTLS-SRTP) | No caller-supplied STUN/TURN configuration; unsupported network paths fail closed to text. |

The control plane is loopback-only in all profiles. The BFF binds `127.0.0.1`, accepts the single
capability-gated `/api/voice/control` upgrade, and rejects every other WebSocket upgrade (see
[architecture.md](architecture.md) §4.1). Media transport is the only browser plane that may traverse the
network, and the shipped path has no caller-supplied STUN/TURN or custom relay configuration.

## 5. Credential posture per environment

| Environment                | Long-lived secret location     | Browser credential                               |
| -------------------------- | ------------------------------ | ------------------------------------------------ |
| Azure Foundry dev/academic | Sealed vault on the Keiko host | None; the host performs proxied-SDP negotiation. |
| Customer-hosted controlled | Sealed vault on the Keiko host | None; the host performs proxied-SDP negotiation. |
| No-voice                   | n/a                            | n/a                                              |

In every environment the long-lived provider key stays on the Keiko host as sealed vault material
(`apiKeySecretRef`, [ADR-0046](../adr/ADR-0046-local-credential-vault.md)); see
[privacy-contract.md](privacy-contract.md) §2.

`direct-ephemeral` remains a typed protocol value for a separately approved future browser-direct
realization. It is not wired by the shipped client and must not be described as the current credential
posture.

## 6. Product voice personas (Issue #1557)

Product voice personas (`male` / `female` / `neutral`) are an axis **orthogonal** to the capability and
environment profiles above ([ADR-0094](../adr/ADR-0094-voice-provider-capability-registry-extension.md)). They
apply only to the **output-capable** profiles (`speech output only` and `full realtime voice`); a
`speech-to-text only` deployment offers no personas because personas are output voices.

| Environment                | Persona → voice-id mapping (`voiceProfiles`) | Browser sees                                     |
| -------------------------- | -------------------------------------------- | ------------------------------------------------ |
| Azure Foundry dev/academic | Sealed on the Keiko host (credential tier)   | Only the available persona enums (no voice ids). |
| Customer-hosted controlled | Sealed on the Keiko host (credential tier)   | Only the available persona enums (no voice ids). |
| No-voice                   | n/a                                          | n/a (`availableVoicePersonas: []`).              |

The persona → provider voice-id mapping lives on the credential-tier provider record
(`ModelProviderConfig.voiceProfiles`) and never reaches the browser; the content-free
`availableVoicePersonas` (and the derived `supportedVoicePersonas` on the model list) carry only the persona
literals, so the operator picks personas per deployment without exposing provider voice identifiers. The five
existing Azure Foundry deployment classes (`keiko-stt`, `keiko-tts`, `keiko-audio-output`, `keiko-realtime`,
`keiko-realtime-stt`) are represented by `modelId` plus capability flags; `voiceProfiles` is used only for
speech-output providers. No deployment name is hard-coded into product behavior.
