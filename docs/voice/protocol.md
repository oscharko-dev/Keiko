# Voice Digital Twin — control, input-media, capability-gating, and replay protocol

Normative protocol specification for Epic #491, the deliverable of Issue
[#496](https://github.com/oscharko-dev/Keiko/issues/496) and the authoritative companion to
[ADR-0101](../adr/ADR-0101-voice-control-media-capability-replay-protocol.md). It **defines** the
wire contract; the transport implementation landed with Issue #497 and is narrowed by
[ADR-0154](../adr/ADR-0154-canonical-twin-voice-pipeline.md). Realtime carries microphone media, VAD,
and user transcription only; canonical chat and independent TTS own every assistant response.

The typed, machine-checkable form of everything below lives in
[`packages/keiko-contracts/src/voice-protocol.ts`](../../packages/keiko-contracts/src/voice-protocol.ts)
and is pinned by [`voice-protocol.test.ts`](../../packages/keiko-contracts/src/voice-protocol.test.ts).
The protocol imports and reuses the capability types `VoiceProfile`, `VoiceProviderLocality`, and
`VoiceUnavailableReason` defined by Issue #493 in
[`gateway.ts`](../../packages/keiko-contracts/src/gateway.ts), and is consistent with the
`VoiceTransportPosture` / `VoiceCapabilityResolution` shapes there; it does not redefine any of them.

## 1. Scope and versioning

- **In scope:** the WebSocket control / signaling message catalog and envelope; the WebRTC media and
  optional data-channel contract; the capability-gating and fallback state table; replay, reconnect,
  idempotency, and redaction semantics; browser↔provider negotiation options; versioning,
  compatibility, and timeout rules.
- **Original Issue #496 out of scope:** transport implementation, a custom media server, sending real-time
  raw audio over WebSocket as the primary design, server-side WebRTC runtime packages, and persisting
  provider SDP / ICE / raw media without explicit redaction policy. Issue #497 subsequently implemented the
  narrow loopback-WebSocket and browser-WebRTC transport without changing those exclusions.

The protocol is versioned by `VOICE_PROTOCOL_VERSION = "1"` (a string literal). It evolves by the same
rule as the other contract schemas: a breaking change introduces a **new literal member**, never a
mutation of `"1"`. The version is **independent of** `CONVERSATION_CAPABILITY_CONTRACT_VERSION` (the
capability-registry contract) and never bumps it. A peer accepts a message only when its declared
`protocolVersion` is one the build understands (`isVoiceProtocolVersionSupported`); a v1 build
understands exactly `"1"`. The protocol defines the rejection response as an `error` message with
code `unsupported-version`; emitting it is the transport's responsibility (#497).

## 2. Two-plane model (AC1)

| Plane                   | Carries                                                                                                                                | Transport (v1)                                                           | npm cost |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------- |
| **Control / signaling** | Session lifecycle, capability negotiation, provider selection, SDP/ICE signaling, cancellation, transcript lifecycle, policy decisions | Capability-gated loopback WebSocket (`VOICE_REALTIME_CONTROL_TRANSPORT`) | none     |
| **Media**               | Real-time audio only; optional low-latency `RTCDataChannel` mirroring a control subset                                                 | Native browser WebRTC (DTLS-SRTP)                                        | none     |

**WebSocket is the authoritative control role.** The BFF accepts upgrades only on
`/api/voice/control`, only from the approved loopback origin, and only when a complete Realtime
deployment is available. Every other upgrade remains hard-rejected. `loopback-http-sse` stays in the
transport union for historical records. `VOICE_CONTROL_TRANSPORT_V1` preserves that immutable
HTTP/SSE baseline; productive sessions use `VOICE_REALTIME_CONTROL_TRANSPORT = "loopback-websocket"`.

**Raw audio is never a control message.** The immutable v1 `VOICE_MEDIA_PLANE` descriptor remains
decodable, while productive Realtime authority is narrowed by `VOICE_REALTIME_INPUT_MEDIA_PLANE` to
microphone `audio-in` only (`transport: "webrtc"`, `replay: "never-persisted"`,
`redaction: "raw-media"`). The `raw-media` redaction class is exclusive to media-plane descriptors —
the typed expression of the control/media separation.

## 3. Control message envelope

Every control message shares one envelope:

| Field             | Type                               | Purpose                                                               |
| ----------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `protocolVersion` | `"1"`                              | Compatibility discriminant (§1).                                      |
| `sessionId`       | `string` (non-empty)               | The voice session the message belongs to.                             |
| `seq`             | `number` (non-negative integer)    | Per-direction monotonic sequence; the reconnect & idempotency anchor. |
| `direction`       | `client-to-host \| host-to-client` | Which peer sent it.                                                   |
| `kind`            | `VoiceControlMessageKind`          | Discriminates the payload.                                            |

`validateVoiceControlMessage` validates this envelope and returns every reason it is malformed;
`isVoiceControlMessage` is the structural guard. The authority-bearing `session.create` payload is
also exact-key validated by the shared contract: its sequence is `0`, direction is `client-to-host`,
profile and negotiation mode agree, and `chatContext` may contain only `chatId`. Removed persona,
memory, grounding, or arbitrary fields fail closed before session allocation. Other per-kind payloads
remain owned by their transport implementation (#497).

## 4. Control / signaling message catalog (Deliverable: WS control & signaling event schemas)

Each kind is classified by **plane** (always control here), **replay class** (§7), and **redaction
class** (§8). `→` marks the typical direction; several kinds occur in both directions.

| Kind                   | Payload (beyond envelope)                                                                                 | Replay class | Redaction class   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ------------ | ----------------- |
| `session.create`       | `idempotencyKey`, `requestedProfile`, `negotiationMode`, `chatContext{chatId}?`, `transcriptionLanguage?` | `replayable` | `content-free`    |
| `session.created`      | `profile`, `controlTransport`, `mediaTransport`, `negotiationMode`, `providerLocality?`                   | `replayable` | `content-free`    |
| `session.close`        | `reason`                                                                                                  | `replayable` | `content-free`    |
| `session.closed`       | `reason`                                                                                                  | `replayable` | `content-free`    |
| `capability.offer`     | `profile`, `capabilities{speechToText, speechOutput, realtimeVoice}`                                      | `replayable` | `content-free`    |
| `capability.select`    | `profile`                                                                                                 | `replayable` | `content-free`    |
| `signal.sdp.offer`     | `sdp` (opaque string)                                                                                     | `ephemeral`  | `secret-bearing`  |
| `signal.sdp.answer`    | `sdp` (opaque string)                                                                                     | `ephemeral`  | `secret-bearing`  |
| `signal.ice.candidate` | `candidate` (opaque), `sdpMid?`, `sdpMLineIndex?`                                                         | `ephemeral`  | `secret-bearing`  |
| `media.track.state`    | `track` (`audio-in`), `state`                                                                             | `replayable` | `content-free`    |
| `control.cancel`       | none; cancels the current voice session and its media negotiation only — never a harness run              | `replayable` | `content-free`    |
| `control.interrupt`    | `atMs?` (barge-in offset)                                                                                 | `replayable` | `content-free`    |
| `transcript.partial`   | `text`                                                                                                    | `ephemeral`  | `reviewable-text` |
| `transcript.committed` | `text`                                                                                                    | `replayable` | `reviewable-text` |
| `transcript.discarded` | —                                                                                                         | `replayable` | `content-free`    |
| `playback.state`       | `state` (`idle \| playing \| paused \| stopped \| interrupted`)                                           | `replayable` | `content-free`    |
| `policy.decision`      | `decision` (`allow \| deny \| degrade`), `reason?`                                                        | `replayable` | `content-free`    |
| `error`                | `code` (`VoiceProtocolErrorCode`)                                                                         | `replayable` | `content-free`    |

SDP and ICE payloads are **secret-bearing** and are never stored or logged. The BFF parses only the
bounded media-section direction attributes needed to enforce exact `sendonly` offers and `recvonly`
answers; no payload text is reflected in errors. Error codes are `unsupported-version`,
`invalid-message`, `capability-unavailable`,
`not-allowed-for-profile`, `negotiation-failed`, `rate-limited`, `internal`.

## 5. WebRTC media and optional data-channel contract

When the effective profile is `full-realtime`, real-time audio uses native browser WebRTC
(`RTCPeerConnection`, `MediaDevices.getUserMedia`, `RTCDataChannel`, `RTCIceCandidate`,
`RTCSessionDescription`) — zero npm dependencies. The only media track is `audio-in`; its lifecycle
(`negotiating → live → muted → ended`) is reported on the control plane via `media.track.state`, never
inferred. A representative negotiation (proxied-SDP):

1. Browser acquires the microphone (`getUserMedia`, secure context required) and creates an
   `RTCPeerConnection`, adding an exact `sendonly` `audio-in` transceiver and a data channel.
2. Browser creates an SDP offer (`signal.sdp.offer`) over the control plane.
3. The browser waits for ICE gathering to complete, so the non-trickle ICE candidates are embedded in the
   SDP offer and answer. The Keiko host negotiates that opaque SDP with the configured provider through
   `gatewayFetch` and returns `signal.sdp.answer`. The legacy `signal.ice.candidate` contract kind remains
   permitted but is an observable no-op in the shipped transport; there is no provider trickle channel.
4. Microphone media flows to the provider over encrypted DTLS-SRTP. The answer must be exact
   `recvonly`; Keiko registers no remote-track callback and accepts no provider assistant audio.

`VOICE_DATA_CHANNEL_EVENT_KINDS` describes the generic control-event subset that may be mirrored over a
data channel and remains limited to `transcript.partial` and `transcript.committed`. The shipped provider
RTCDataChannel uses the provider's separately parsed input-event schema: it admits session lifecycle, user
speech start/stop, partial/final user transcription, transcription failure, and redacted error events.
Outbound it permits only response-disabled VAD `session.update` and `input_audio_buffer.commit`. Provider
assistant response, playback, tool, and output-audio events grant no authority and are ignored or rejected;
raw audio remains on the media track.

The catalog and replay table remain generic protocol vocabulary. The productive Twin loopback BFF
adds a stricter direction/surface allowlist: it rejects browser-originated `transcript.partial` and
`transcript.committed` control frames. Provider finals instead move from the RTCDataChannel through the
short continuation buffer directly into canonical Chat. Consequently the shipped server replay buffer
contains content-free control only and cannot become a second transcript owner.

## 6. Capability-gating and fallback state table (Deliverable; AC2, AC3)

The protocol is gated by the already-resolved `VoiceProfile`. `VOICE_PROFILE_ALLOWED_MESSAGE_KINDS`,
`VOICE_PROFILE_MEDIA_TRANSPORT`, and `VOICE_PROFILE_NEGOTIATION_MODE` are the normative tables:

| Profile          | Permitted control kinds                                                                                                                                                      | Media transport | Negotiation   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------- |
| `none`           | **none at all** (no session can be created) — deterministic disabled behavior (AC2)                                                                                          | `none`          | `disabled`    |
| `speech-to-text` | session lifecycle, capability negotiation, `control.cancel`, transcript lifecycle, `policy.decision`, `error` — **no** SDP/ICE, media-track, interruption, or playback (AC3) | `gateway-batch` | `disabled`    |
| `speech-output`  | the above minus transcript, plus `control.interrupt` and `playback.state`                                                                                                    | `gateway-batch` | `disabled`    |
| `full-realtime`  | **every** kind, including SDP/ICE signaling and media-track state                                                                                                            | `webrtc`        | `proxied-sdp` |

- **`none`** permits no message; with no voice capability the protocol exposes nothing, mirroring "no
  voice UI at all" (ADR-0100 D1). `voiceMessageAllowedForProfile(kind, "none")` is `false` for every
  kind.
- **`speech-to-text`** is controlled dictation only: audio rides the existing JSON request envelope
  and is forwarded once through `gatewayFetch` (`gateway-batch`, as the #494 dictation route already
  does). STT-only dictation **never requires the full-realtime media path** (AC3); `full-realtime` is
  the only profile permitting `signal.sdp.offer`.
- Degradation follows the [architecture §5](architecture.md) ladder: an unavailable capability resolves
  down to a lower profile and ultimately to `none`. The protocol **never** silently streams raw audio
  over the control plane.
- **Profile/negotiation consistency.** A `session.create` carries a client-chosen `requestedProfile`
  and `negotiationMode`. The shared validator and transport fail closed when the mode is inconsistent
  with the canonical `VOICE_PROFILE_NEGOTIATION_MODE` table (for example, `direct-ephemeral` requested
  for a `speech-to-text` session, which must resolve to `disabled` and hold no browser credential).
  `negotiationMode` is never advisory.
- **Surface-specific identity.** Twin Voice requires exactly `chatContext: {chatId}` and rejects the
  live-dictation-only `transcriptionLanguage`. Composer live dictation permits the language hint and
  rejects `chatContext`. Neither surface accepts persona, memory, grounding, history, or assistant
  configuration.

## 7. Replay, reconnect, and idempotency semantics (AC5)

- **Sequence & reconnect.** Each direction numbers messages with a monotonically increasing `seq`.
  After a recoverable transport drop, the host re-delivers its complete bounded buffer of
  **replayable** messages. V1 has no client-ack field; the browser ignores already-seen sequences.
  `ephemeral` and `never-persisted` messages are not re-delivered.
- **Idempotency.** `session.create` carries an `idempotencyKey`; a re-sent create after a reconnect
  resolves to the **same detached** session, never a second one. The key is permanently bound for its
  replay lifetime to the original `(sessionId, profile, chatId)`; a mismatched binding or concurrent
  second socket is rejected. Only abnormal transport detaches retain replay state; explicit close and
  protocol violations terminate it. Control handlers are otherwise idempotent on `(sessionId, seq)`.
- **Replay classes** (`VOICE_CONTROL_MESSAGE_REPLAY`):
  - `replayable` — generic durable-control and committed-transcript vocabulary. Productive Twin
    narrows this class to content-free host control and never treats the BFF replay as a transcript
    system of record.
  - `ephemeral` — SDP, ICE, and **partial** transcripts; valid only for the live negotiation.
  - `never-persisted` — raw media frames (media plane only).
- **AC5:** the generic classification therefore includes control and committed-transcript events but
  excludes raw audio by default. Productive Twin narrows this: its BFF replay contains content-free
  host control only, and its Chat-owned browser queue is the sole final-transcript continuity owner.
  No control kind is ever `never-persisted`; that class is exclusive to raw media.
- **Timeouts** (`DEFAULT_VOICE_PROTOCOL_TIMEOUTS`): conservative, controlled-network-friendly bounds
  for session creation, signaling, heartbeat, reconnect backoff (initial/max), and max reconnect
  attempts. The transport (#497) polices them against its own clock; the contracts package reads no
  clock.

## 8. Redaction semantics (Deliverable: redaction)

Before a message may enter any log or evidence manifest it passes the **existing** redaction and
identifier-hashing seams ([privacy-contract §2/§3](privacy-contract.md)) according to its
`VOICE_CONTROL_MESSAGE_REDACTION` class:

- `content-free` — enums / booleans / integers, plus client-chosen opaque identifiers (`sessionId`,
  `idempotencyKey`); the transport bounds id length/charset before logging so a hostile id cannot
  inject into a log or audit line.
- `reviewable-text` — user-reviewable transcript text in generic protocol realizations; such a
  transport first applies
  `stripUnsafeFormatChars` (`text-safety.ts` — strips bidi / zero-width / C0–C1 / DEL, preserves
  TAB/LF/CR) to neutralise Trojan-source rendering, then redacts-by-construction, deep-redacts, and
  identifier-hashes at persist, exactly as recap / session-state records already are. Productive Twin
  does not persist this class in its BFF control replay at all.
- `secret-bearing` — SDP / ICE / ephemeral-credential material; never logged or persisted raw.
- `raw-media` — raw audio frames; never persisted (media plane only).

The protocol invents no new crypto, storage, or redaction mechanism; it reuses
`packages/keiko-security/src/redaction.ts` and the evidence hashing seam.

## 9. Browser↔provider negotiation options (Deliverable)

`VoiceNegotiationMode`:

| Mode               | Browser holds                         | When                                                                             |
| ------------------ | ------------------------------------- | -------------------------------------------------------------------------------- |
| `proxied-sdp`      | **nothing** (host negotiates SDP)     | **Preferred** (`PREFERRED_VOICE_NEGOTIATION_MODE`); default for `full-realtime`. |
| `direct-ephemeral` | a short-lived ephemeral session token | Reserved contract value; no shipped browser-direct realization.                  |
| `disabled`         | n/a                                   | `none`, `speech-to-text`, `speech-output` (no browser-direct media).             |

The long-lived provider key never reaches the browser in any mode; it stays sealed on the Keiko host
(`apiKeySecretRef`, [ADR-0046](../adr/ADR-0046-local-credential-vault.md), privacy-contract §2).
The productive client uses `proxied-sdp`; `direct-ephemeral` requires a separate architecture and security
decision before it can be wired.

## 10. Security notes (Deliverable; AC6)

Because every message kind has an explicit redaction class, a security review can reason about external
endpoints, browser-exposed credentials, reviewable transcript text, and secret-bearing SDP directly from
the contract:

- **External endpoints.** Configured provider STT, TTS, and Realtime HTTP signaling endpoints are reached
  only through `gatewayFetch` (ADR-0038: proxy/CA/timeout/byte-cap). The browser WebRTC media plane follows
  the provider-negotiated SDP, while the shipped `RTCPeerConnection` configuration supplies no caller
  STUN/TURN or custom relay host. SDP signaling stays under Keiko's loopback origin so authentication, rate
  limiting, audit logging, and host checks remain local. A future relay design requires a new explicit
  allowlist, credential, and egress decision.
- **Browser-exposed credentials.** Under the productive `proxied-sdp` mode the browser holds **no**
  provider credential. `direct-ephemeral` describes the maximum posture of an unimplemented contract
  option, not current behavior. The long-lived provider key never leaves the host.
- **ICE candidate privacy.** Non-trickle candidates are embedded in opaque, `secret-bearing` SDP that the
  protocol never logs or persists. Local-IP exposure relies on browser mDNS `.local` host-candidate
  obfuscation (privacy-contract §4); behavior varies per OS/managed network and is verified per
  deployment. The shipped browser transport constructs `RTCPeerConnection` with
  `APPROVED_VOICE_RTC_CONFIGURATION` (`voice-rtc-transport.ts`), whose `iceServers` list is empty; a
  future STUN/TURN, relay, or browser-direct media configuration must update this protocol and its
  tests in the same change.
- **Provider allowlisting & local-only state.** Reachability is bounded by configured providers +
  capability selection (privacy-contract §1); session state, policy decisions, and audit metadata stay
  local. The honest limitation that no positive destination host allowlist exists yet (ADR-0100 D4) is
  unchanged by this protocol.
- **Controls remain narrow.** Issue #497 re-opened only the capability-gated loopback
  `/api/voice/control` upgrade and scoped microphone permission to self. Any browser-direct credential,
  custom STUN/TURN relay, or wider origin/permission posture remains a future explicit decision under the
  security gate (ADR-0100 D6, privacy-contract §4).

## 11. No new runtime media packages (AC4)

The protocol requires **only** the existing `ws` package and browser-native WebRTC APIs. It defines no
message that needs `socket.io`, `simple-peer`, `peerjs`, `mediasoup`, `livekit`, a server-side WebRTC
stack, or any other runtime media package. Media transport is modelled with native mechanisms only
(`gateway-batch` over `gatewayFetch`, or `webrtc` over the browser platform). The
[supply-chain policy](supply-chain-policy.md) and a repository regression test (a denylist asserted against
every workspace manifest in [`voice-protocol.test.ts`](../../packages/keiko-contracts/src/voice-protocol.test.ts))
keep this enforced.

## 12. References

- [ADR-0101](../adr/ADR-0101-voice-control-media-capability-replay-protocol.md) — the authoritative
  decision record for this protocol.
- [ADR-0100](../adr/ADR-0100-voice-digital-twin-capability-architecture.md) — voice architecture
  baseline (D3 transport, D6 security).
- [`packages/keiko-contracts/src/voice-protocol.ts`](../../packages/keiko-contracts/src/voice-protocol.ts)
  — the typed contract; [`gateway.ts`](../../packages/keiko-contracts/src/gateway.ts) — the reused
  capability types (#493).
- [architecture.md](architecture.md), [privacy-contract.md](privacy-contract.md),
  [deployment-profile-matrix.md](deployment-profile-matrix.md),
  [supply-chain-policy.md](supply-chain-policy.md),
  [implementation-sequencing.md](implementation-sequencing.md).
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491); Issue
  [#496](https://github.com/oscharko-dev/Keiko/issues/496).
