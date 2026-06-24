# Voice Digital Twin — control, media, capability-gating, and replay protocol

Normative protocol specification for Epic #491, the deliverable of Issue
[#496](https://github.com/oscharko-dev/Keiko/issues/496) and the authoritative companion to
[ADR-0059](../adr/ADR-0059-voice-control-media-capability-replay-protocol.md). It **defines** the
wire contract; the transport that implements it is Issue #497. This document is **design and contract
only**: it adds no transport code, re-opens no WebSocket upgrade, and adds no runtime dependency.

The typed, machine-checkable form of everything below lives in
[`packages/keiko-contracts/src/voice-protocol.ts`](../../packages/keiko-contracts/src/voice-protocol.ts)
and is pinned by [`voice-protocol.test.ts`](../../packages/keiko-contracts/src/voice-protocol.test.ts).
The protocol reuses the capability types (`VoiceProfile`, `VoiceTransportPosture`,
`VoiceProviderLocality`, `VoiceUnavailableReason`, `VoiceCapabilityResolution`) defined by Issue #493
in [`gateway.ts`](../../packages/keiko-contracts/src/gateway.ts); it does not redefine them.

## 1. Scope and versioning

- **In scope:** the WebSocket control / signaling message catalog and envelope; the WebRTC media and
  optional data-channel contract; the capability-gating and fallback state table; replay, reconnect,
  idempotency, and redaction semantics; browser↔provider negotiation options; versioning,
  compatibility, and timeout rules.
- **Out of scope (Issue #497 and later):** transport implementation, a custom media server, sending
  real-time raw audio over WebSocket as the primary design, server-side WebRTC runtime packages, and
  persisting provider SDP / ICE / raw media without explicit redaction policy.

The protocol is versioned by `VOICE_PROTOCOL_VERSION = "1"` (a string literal). It evolves by the same
rule as the other contract schemas: a breaking change introduces a **new literal member**, never a
mutation of `"1"`. The version is **independent of** `CONVERSATION_CAPABILITY_CONTRACT_VERSION` (the
capability-registry contract) and never bumps it. A peer accepts a message only when its declared
`protocolVersion` is one the build understands (`isVoiceProtocolVersionSupported`); a v1 build
understands exactly `"1"` and answers an `error` with code `unsupported-version` otherwise.

## 2. Two-plane model (AC1)

| Plane                   | Carries                                                                                                                                                              | Transport (v1)                                                    | npm cost |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------- |
| **Control / signaling** | Session lifecycle, capability negotiation, provider selection, SDP/ICE signaling, cancellation, interruption, transcript lifecycle, playback state, policy decisions | Loopback HTTP + Server-Sent Events (`VOICE_CONTROL_TRANSPORT_V1`) | none     |
| **Media**               | Real-time audio only; optional low-latency `RTCDataChannel` mirroring a control subset                                                                               | Native browser WebRTC (DTLS-SRTP)                                 | none     |

**WebSocket is the authoritative control role**, realized today on the existing loopback HTTP + SSE
seam because the BFF binds `127.0.0.1` and hard-rejects WebSocket upgrades
([`server.ts`](../../packages/keiko-server/src/server.ts) lines 210–213). `VoiceControlTransport` is
`loopback-http-sse | loopback-websocket`; re-opening a bidirectional WebSocket upgrade is an explicit,
ADR-gated transport decision owned by Issue #497 (ADR-0058 D3, ADR-0059 D3), never an additive change.

**Raw audio is never a control message.** It is modelled by the single `VOICE_MEDIA_PLANE` descriptor
(`plane: "media"`, `transport: "webrtc"`, `replay: "never-persisted"`, `redaction: "raw-media"`). The
`raw-media` redaction class is exclusive to the media plane — the typed expression of the
control/media separation.

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
`isVoiceControlMessage` is the structural guard. Per-kind payload fields (below) are owned and
validated by the transport implementation (#497); the contract pins the envelope, the kind catalog,
and the version-compatibility rule.

## 4. Control / signaling message catalog (Deliverable: WS control & signaling event schemas)

Each kind is classified by **plane** (always control here), **replay class** (§7), and **redaction
class** (§8). `→` marks the typical direction; several kinds occur in both directions.

| Kind                   | Payload (beyond envelope)                                                               | Replay class | Redaction class   |
| ---------------------- | --------------------------------------------------------------------------------------- | ------------ | ----------------- |
| `session.create`       | `idempotencyKey`, `requestedProfile`, `negotiationMode`                                 | `replayable` | `content-free`    |
| `session.created`      | `profile`, `controlTransport`, `mediaTransport`, `negotiationMode`, `providerLocality?` | `replayable` | `content-free`    |
| `session.close`        | `reason`                                                                                | `replayable` | `content-free`    |
| `session.closed`       | `reason`                                                                                | `replayable` | `content-free`    |
| `capability.offer`     | `profile`, `capabilities{speechToText, speechOutput, realtimeVoice}`                    | `replayable` | `content-free`    |
| `capability.select`    | `profile`                                                                               | `replayable` | `content-free`    |
| `signal.sdp.offer`     | `sdp` (opaque string)                                                                   | `ephemeral`  | `secret-bearing`  |
| `signal.sdp.answer`    | `sdp` (opaque string)                                                                   | `ephemeral`  | `secret-bearing`  |
| `signal.ice.candidate` | `candidate` (opaque), `sdpMid?`, `sdpMLineIndex?`                                       | `ephemeral`  | `secret-bearing`  |
| `media.track.state`    | `track` (`audio-in \| audio-out`), `state`                                              | `replayable` | `content-free`    |
| `control.cancel`       | —                                                                                       | `replayable` | `content-free`    |
| `control.interrupt`    | `atMs?` (barge-in offset)                                                               | `replayable` | `content-free`    |
| `transcript.partial`   | `text`                                                                                  | `ephemeral`  | `reviewable-text` |
| `transcript.committed` | `text`                                                                                  | `replayable` | `reviewable-text` |
| `transcript.discarded` | —                                                                                       | `replayable` | `content-free`    |
| `playback.state`       | `state` (`idle \| playing \| paused \| stopped \| interrupted`)                         | `replayable` | `content-free`    |
| `policy.decision`      | `decision` (`allow \| deny \| degrade`), `reason?`                                      | `replayable` | `content-free`    |
| `error`                | `code` (`VoiceProtocolErrorCode`)                                                       | `replayable` | `content-free`    |

SDP and ICE payloads are **opaque strings**: the protocol never parses, stores, or logs them. Error
codes are `unsupported-version`, `invalid-message`, `capability-unavailable`,
`not-allowed-for-profile`, `negotiation-failed`, `rate-limited`, `internal`.

## 5. WebRTC media and optional data-channel contract

When the effective profile is `full-realtime`, real-time audio uses native browser WebRTC
(`RTCPeerConnection`, `MediaDevices.getUserMedia`, `RTCDataChannel`, `RTCIceCandidate`,
`RTCSessionDescription`) — zero npm dependencies. Tracks are `audio-in` and `audio-out`
(`VoiceMediaTrackKind`); their lifecycle (`negotiating → live → muted → ended`) is reported on the
control plane via `media.track.state`, never inferred. A representative negotiation (proxied-SDP):

1. Browser acquires the microphone (`getUserMedia`, secure context required) and creates an
   `RTCPeerConnection`, adding the `audio-in` track and optionally a data channel.
2. Browser creates an SDP offer (`signal.sdp.offer`) over the control plane.
3. The Keiko host negotiates the SDP with the configured provider via `gatewayFetch` and returns
   `signal.sdp.answer`; ICE candidates are relayed as `signal.ice.candidate`.
4. Media flows over the encrypted DTLS-SRTP path; `audio-out` arrives via the track callback.

An optional `RTCDataChannel` may mirror the low-latency control subset `VOICE_DATA_CHANNEL_EVENT_KINDS`
= { `control.interrupt`, `transcript.partial`, `playback.state` } for lower latency than the control
plane. The data channel carries **no new authority** and **never** carries raw audio; every event on
it is also a control kind, so the control plane remains the system of record.

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
  voice UI at all" (ADR-0058 D1). `voiceMessageAllowedForProfile(kind, "none")` is `false` for every
  kind.
- **`speech-to-text`** is controlled dictation only: audio rides the existing JSON request envelope
  and is forwarded once through `gatewayFetch` (`gateway-batch`, as the #494 dictation route already
  does). STT-only dictation **never requires the full-realtime media path** (AC3); `full-realtime` is
  the only profile permitting `signal.sdp.offer`.
- Degradation follows the [architecture §5](architecture.md) ladder: an unavailable capability resolves
  down to a lower profile and ultimately to `none`. The protocol **never** silently streams raw audio
  over the control plane.

## 7. Replay, reconnect, and idempotency semantics (AC5)

- **Sequence & reconnect.** Each direction numbers messages with a monotonically increasing `seq`.
  After a transport drop, a peer reconnects and the host re-delivers **replayable** messages with
  `seq` greater than the last the client acknowledged. `ephemeral` and `never-persisted` messages are
  not re-delivered.
- **Idempotency.** `session.create` carries an `idempotencyKey`; a re-sent create after a reconnect
  resolves to the **same** session, never a second one. Control handlers are otherwise idempotent on
  `(sessionId, seq)`.
- **Replay classes** (`VOICE_CONTROL_MESSAGE_REPLAY`):
  - `replayable` — durable control and **committed** transcript events; the local system of record.
  - `ephemeral` — SDP, ICE, and **partial** transcripts; valid only for the live negotiation.
  - `never-persisted` — raw media frames (media plane only).
- **AC5:** replay therefore **includes control and committed-transcript events but excludes raw audio
  by default**. No control kind is ever `never-persisted`; that class is exclusive to raw media.
- **Timeouts** (`DEFAULT_VOICE_PROTOCOL_TIMEOUTS`): conservative, controlled-network-friendly bounds
  for session creation, signaling, heartbeat, reconnect backoff (initial/max), and max reconnect
  attempts. The transport (#497) polices them against its own clock; the contracts package reads no
  clock.

## 8. Redaction semantics (Deliverable: redaction)

Before a message may enter any log or evidence manifest it passes the **existing** redaction and
identifier-hashing seams ([privacy-contract §2/§3](privacy-contract.md)) according to its
`VOICE_CONTROL_MESSAGE_REDACTION` class:

- `content-free` — enums / booleans / integers / opaque ids only; safe verbatim.
- `reviewable-text` — user-reviewable transcript text; redacted-by-construction then deep-redacted and
  identifier-hashed at persist, exactly as recap / session-state records already are.
- `secret-bearing` — SDP / ICE / ephemeral-credential material; never logged or persisted raw.
- `raw-media` — raw audio frames; never persisted (media plane only).

The protocol invents no new crypto, storage, or redaction mechanism; it reuses
`packages/keiko-security/src/redaction.ts` and the evidence hashing seam.

## 9. Browser↔provider negotiation options (Deliverable)

`VoiceNegotiationMode`:

| Mode               | Browser holds                         | When                                                                             |
| ------------------ | ------------------------------------- | -------------------------------------------------------------------------------- |
| `proxied-sdp`      | **nothing** (host negotiates SDP)     | **Preferred** (`PREFERRED_VOICE_NEGOTIATION_MODE`); default for `full-realtime`. |
| `direct-ephemeral` | a short-lived ephemeral session token | Opt-in, when a deployment accepts browser-direct negotiation.                    |
| `disabled`         | n/a                                   | `none`, `speech-to-text`, `speech-output` (no browser-direct media).             |

The long-lived provider key never reaches the browser in any mode; it stays sealed on the Keiko host
(`apiKeySecretRef`, [ADR-0046](../adr/ADR-0046-local-credential-vault.md), privacy-contract §2).

## 10. Security notes (Deliverable; AC6)

Because the protocol is content-free, a security review can reason about **every external endpoint**
and **every browser-exposed credential** directly from the contract:

- **External endpoints.** The only external destinations are (a) the configured provider STT / TTS /
  realtime endpoints, reached **only** through `gatewayFetch` (ADR-0038: proxy/CA/timeout/byte-cap),
  and (b) configurable, validated STUN/TURN hosts for NAT traversal
  ([deployment-profile-matrix §4](deployment-profile-matrix.md)). No bespoke signaling/media client is
  introduced. SDP signaling stays under Keiko's loopback origin so auth, rate limiting, audit logging,
  and host allowlisting are controlled locally.
- **Browser-exposed credentials.** Under the preferred `proxied-sdp` mode the browser holds **no**
  credential; under `direct-ephemeral` it holds only a **short-lived, scoped** ephemeral session token
  minted server-side, with refresh/re-mint handling. The long-lived provider key never leaves the
  host.
- **ICE candidate privacy.** Candidates are opaque, `secret-bearing`, and `ephemeral`; the protocol
  never logs or persists them. Local-IP exposure relies on browser mDNS `.local` host-candidate
  obfuscation (privacy-contract §4); behavior varies per OS/managed network and is verified per
  deployment.
- **Provider allowlisting & local-only state.** Reachability is bounded by configured providers +
  capability selection (privacy-contract §1); session state, policy decisions, and audit metadata stay
  local. The honest limitation that no positive destination host allowlist exists yet (ADR-0058 D4) is
  unchanged by this protocol.
- **Controls a transport (#497) must re-justify, not silently relax.** Re-opening the BFF WebSocket
  upgrade, and any CSP / `Permissions-Policy` relaxation for browser-direct media or STUN/TURN, are
  explicit future decisions under the security gate (ADR-0058 D6, privacy-contract §4) — out of scope
  for this protocol definition.

## 11. No new runtime media packages (AC4)

The protocol requires **only** the existing `ws` package and browser-native WebRTC APIs. It defines no
message that needs `socket.io`, `simple-peer`, `peerjs`, `mediasoup`, `livekit`, a server-side WebRTC
stack, or any other runtime media package. Media transport is modelled with native mechanisms only
(`gateway-batch` over `gatewayFetch`, or `webrtc` over the browser platform). The
[supply-chain policy](supply-chain-policy.md) and a live regression test (a denylist asserted against
every workspace manifest in [`voice-protocol.test.ts`](../../packages/keiko-contracts/src/voice-protocol.test.ts))
keep this enforced.

## 12. References

- [ADR-0059](../adr/ADR-0059-voice-control-media-capability-replay-protocol.md) — the authoritative
  decision record for this protocol.
- [ADR-0058](../adr/ADR-0058-voice-digital-twin-capability-architecture.md) — voice architecture
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
