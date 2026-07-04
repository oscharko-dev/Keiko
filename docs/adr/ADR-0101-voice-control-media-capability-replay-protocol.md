# ADR-0101: Voice control, WebRTC media, capability-gating, and replay protocol

> Renumbered from ADR-0059 on 2026-07-04 to resolve the 0058-0069 editor/voice numbering collision (Epic #491 voice series moved to 0100-0111).

## Status

Accepted (Issue #496, Epic #491, 2026-06-24)

## Version

0.2.0

## Context

[ADR-0100](ADR-0100-voice-digital-twin-capability-architecture.md) established the capability-gated,
local-first, provider-neutral Voice Digital Twin architecture and deferred two transport questions to
the protocol/transport child issues: whether to re-open a bidirectional WebSocket upgrade on the BFF
(currently hard-rejected), and the precise wire contract for control, signaling, media, and replay
(ADR-0100 D3, Consequences). Issue #496 answers the **protocol** half of that pair: it **defines** the
versioned control/media protocol contract that Issue #497 then **implements** as transport. Per the
[implementation sequencing](../voice/implementation-sequencing.md), #496 owns
`packages/keiko-contracts/src/*` voice protocol types plus docs, and must remain additive — it does
**not** add transport code, re-open the WebSocket upgrade, add runtime dependencies, or change any
trust boundary.

The protocol is defined against the seams ADR-0100 already mapped, all confirmed by a fresh read-only
survey of the merged voice surface (#492–#495):

- **Capability is already resolved, content-free, and serialisable.** `VoiceProfile`
  (`none | speech-to-text | speech-output | full-realtime`), `VoiceTransportPosture`
  (`websocketControl`, `webrtcMedia`), `VoiceProviderLocality`, `VoiceUnavailableReason`, and
  `VoiceCapabilityResolution` exist in
  [`gateway.ts`](../../packages/keiko-contracts/src/gateway.ts) (Issue #493). The protocol contract
  **imports and reuses** `VoiceProfile`, `VoiceProviderLocality`, and `VoiceUnavailableReason`, and is
  consistent with the `VoiceTransportPosture` / `VoiceCapabilityResolution` shapes; it redefines none
  of them.
- **The control plane is realized on loopback HTTP + Server-Sent Events today.** The BFF binds
  `127.0.0.1` and **hard-rejects every WebSocket upgrade** with `HTTP/1.1 404` then `socket.destroy()`
  ([`server.ts`](../../packages/keiko-server/src/server.ts) lines 210–213). The STT-only dictation
  route `POST /api/voice/transcribe` ([`voice-handlers.ts`](../../packages/keiko-server/src/voice-handlers.ts),
  Issue #494) is the first realized control-plane exchange: a capability-gated request/response that
  rides the existing JSON + CSRF envelope, forwards audio once through `gatewayFetch`, persists no raw
  audio, and returns a deterministic `VOICE_UNAVAILABLE` when voice is absent.
- **The media plane is greenfield browser-native WebRTC.** No `RTCPeerConnection` / `getUserMedia` /
  `MediaRecorder`-based realtime path exists yet; the dictation UX (#495) captures a clip with
  `MediaRecorder` and posts it. WebRTC is a browser platform capability requiring zero npm
  dependencies ([supply-chain-policy](../voice/supply-chain-policy.md)).

The full normative specification lives in [`docs/voice/protocol.md`](../voice/protocol.md); the typed,
machine-checkable contract lives in
[`packages/keiko-contracts/src/voice-protocol.ts`](../../packages/keiko-contracts/src/voice-protocol.ts).
This ADR records the load-bearing decisions.

## Decision

We adopt a **two-plane, capability-gated, versioned** voice protocol. It is content-free by
construction (only enum literals, booleans, opaque identifiers, and opaque SDP/ICE/transcript
strings) and adds no authority.

### D1 — A dedicated, independently versioned protocol contract

The protocol carries its own `VOICE_PROTOCOL_VERSION = "1"` string-literal constant, following the
same evolution rule as `WORKFLOW_HANDOFF_SCHEMA_VERSION` / `CONNECTED_CONTEXT_SCHEMA_VERSION`: a
breaking change introduces a **new literal member**, never a mutation of `"1"`. It is **independent of
`CONVERSATION_CAPABILITY_CONTRACT_VERSION`** (the capability-registry contract, currently `3`) and
**must not** bump it — the protocol and the capability registry evolve on separate axes. A peer
accepts a message only when its declared version is one this build understands
(`isVoiceProtocolVersionSupported`); v1 understands exactly `"1"`.

### D2 — Two planes: WebSocket control is separated from WebRTC media (AC1)

The protocol explicitly separates a **control / signaling plane** from a **media plane**:

- The **control / signaling plane** carries every protocol message kind: session lifecycle,
  capability negotiation, provider selection, SDP/ICE signaling, cancellation, interruption
  (barge-in), transcript lifecycle, playback state, and policy decisions.
- The **media plane** carries **only** real-time audio over native browser WebRTC (DTLS-SRTP),
  optionally with a low-latency `RTCDataChannel` that mirrors a subset of control events.

**No control message kind carries raw audio.** Raw audio is modelled by a single
`VOICE_MEDIA_PLANE` descriptor (`plane: "media"`, `transport: "webrtc"`, `redaction: "raw-media"`,
`replay: "never-persisted"`) and never as a message in the control catalog. This separation is the
typed, test-pinned expression of AC1: the `raw-media` redaction class is exclusive to the media
plane, so a control message can never be raw audio.

### D3 — Control-plane realization: loopback HTTP + SSE now; WebSocket upgrade is deferred to #497

"WebSocket is the authoritative control plane" describes a **role**, not a mandatory transport. The
protocol's control transport is captured by `VoiceControlTransport`
(`loopback-http-sse | loopback-websocket`), and the realization in effect for v1 is
`VOICE_CONTROL_TRANSPORT_V1 = "loopback-http-sse"` — request/response over `POST /api/voice/*` plus
server→client push over the existing `EventSource` channel. Re-opening a bidirectional WebSocket
upgrade on the BFF (today hard-rejected) remains an **explicit, ADR-gated transport decision owned by
Issue #497**, never an additive change smuggled in here. The protocol is defined so that a future
switch to `loopback-websocket` is a transport realization detail, not a contract break.

### D4 — Capability-gating and a deterministic fallback state table (AC2, AC3)

The protocol is gated by the already-resolved `VoiceProfile`. `VOICE_PROFILE_ALLOWED_MESSAGE_KINDS`
is the normative state table:

- **`none` permits no control message at all** — the deterministic disabled behavior of AC2. With no
  voice capability, the protocol exposes nothing (no session can be created), mirroring the
  "no voice UI at all" posture of ADR-0100 D1.
- **`speech-to-text` permits the controlled-dictation control subset only** — session lifecycle,
  capability negotiation, cancellation, the transcript lifecycle, policy, and error — and **excludes
  every WebRTC signaling, media-track, interruption, and playback kind**. STT-only dictation therefore
  never requires the full-realtime media path (AC3); its media transport is `gateway-batch` (audio via
  the existing `gatewayFetch` seam) with browser negotiation `disabled`.
- **`speech-output`** adds playback and interruption; **`full-realtime`** permits every kind, uses the
  `webrtc` media transport, and is the **only** profile permitting SDP signaling.

Degradation follows the ADR-0100 §5 ladder: an unavailable capability resolves down to a lower
profile and ultimately to `none`; the protocol never silently streams raw audio over the control
plane.

### D5 — Replay, reconnect, and idempotency semantics (AC5)

Every control message shares an envelope `{ protocolVersion, sessionId, seq, direction, kind }`. The
per-direction monotonically increasing `seq` is the reconnect and idempotency anchor; a
`session.create` additionally carries an `idempotencyKey` so a re-sent create after a reconnect
resolves to the same session, never a second one. Each kind is classified by
`VOICE_CONTROL_MESSAGE_REPLAY`:

- **`replayable`** — durable control and **committed** transcript events; a reconnect re-delivers them
  up to the last acknowledged `seq`. This is the local system of record.
- **`ephemeral`** — SDP, ICE candidates, and **partial** transcripts: valid only for the live
  negotiation, never replayed or persisted.
- **`never-persisted`** — raw media frames (media plane only): excluded from replay and persistence by
  default.

Thus **replay includes control and committed-transcript events but excludes raw audio by default**
(AC5). No control kind is ever `never-persisted`; that class is exclusive to raw media.

### D6 — Redaction semantics reuse the existing local-first stack

`VOICE_CONTROL_MESSAGE_REDACTION` classifies each kind as `content-free`, `reviewable-text`,
`secret-bearing`, or `raw-media`. Control kinds are only the first three; raw audio is the only
`raw-media`. Before any message may enter a log or evidence manifest it passes the existing redaction
and identifier-hashing seams exactly as recap / session-state records already do
([privacy-contract §2/§3](../voice/privacy-contract.md)): `content-free` is safe verbatim,
`reviewable-text` is redacted-by-construction then deep-redacted and identifier-hashed at persist, and
`secret-bearing` (SDP/ICE/ephemeral credentials) and `raw-media` are never logged or persisted raw.
The protocol invents no new crypto, storage, or redaction mechanism.

### D7 — Browser↔provider negotiation options and the security surface (AC6)

Real-time media negotiation is one of three modes (`VoiceNegotiationMode`): **`proxied-sdp`**
(preferred — the Keiko host performs SDP negotiation, so the browser holds no token),
**`direct-ephemeral`** (opt-in — the browser uses a short-lived ephemeral credential), or
**`disabled`** (no browser-direct media). The protocol is content-free, so a security review can
reason about **every external endpoint** (provider STT/TTS/realtime endpoints reached only through
`gatewayFetch`; configurable, validated STUN/TURN hosts) and **every browser-exposed credential** (a
short-lived ephemeral token under `direct-ephemeral`, or none under the preferred `proxied-sdp`)
directly from the typed contract and [`protocol.md` §10](../voice/protocol.md) — satisfying AC6. SDP
and ICE payloads are opaque `secret-bearing` strings the contract never parses, stores, or logs; ICE
candidate privacy relies on browser mDNS `.local` obfuscation (privacy-contract §4). The signaling
plane stays under Keiko's loopback origin so auth, rate limiting, audit logging, and host allowlisting
are controlled locally.

### D8 — No new runtime media packages (AC4)

The protocol requires **only** the existing `ws` package and browser-native WebRTC APIs. It defines no
message that needs `socket.io`, `simple-peer`, `peerjs`, `mediasoup`, `livekit`, a server-side WebRTC
stack, or any other runtime media package. Media transport is modelled with native mechanisms only
(`gateway-batch` over `gatewayFetch`, or `webrtc` over the browser platform). The
[supply-chain policy](../voice/supply-chain-policy.md) and a live regression test (a denylist asserted
against every workspace manifest) keep this enforced.

## Consequences

- Issue #497 has a stable, typed, versioned contract to implement transport against, with the
  capability-gating, replay, reconnect, idempotency, and redaction semantics fixed in advance.
- The contract is additive and content-free: it adds no authority, no dependency, no transport, and no
  trust-boundary change, and it does not bump `CONVERSATION_CAPABILITY_CONTRACT_VERSION`. It does not
  reach the published root `@oscharko-dev/keiko` surface (it is consumed directly from
  `@oscharko-dev/keiko-contracts` by the transport packages), so `check:package-surface` is unchanged.
- Re-opening the BFF WebSocket upgrade and any CSP / `Permissions-Policy` relaxation for browser-direct
  media remain **future, explicitly-gated** decisions for #497 (ADR-0100 D3/D6), not part of this
  issue.
- This ADR is **Proposed**; it is design-and-contract only and ships no transport code. It is promoted
  as the transport child issue (#497) lands.

## References

- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491); Issue
  [#496](https://github.com/oscharko-dev/Keiko/issues/496).
- [ADR-0100](ADR-0100-voice-digital-twin-capability-architecture.md) — voice architecture baseline
  (D3 transport, D6 security).
- [`docs/voice/protocol.md`](../voice/protocol.md) — the normative protocol specification.
- [`packages/keiko-contracts/src/voice-protocol.ts`](../../packages/keiko-contracts/src/voice-protocol.ts)
  — the typed contract.
- [`docs/voice/privacy-contract.md`](../voice/privacy-contract.md),
  [`docs/voice/deployment-profile-matrix.md`](../voice/deployment-profile-matrix.md),
  [`docs/voice/supply-chain-policy.md`](../voice/supply-chain-policy.md),
  [`docs/voice/implementation-sequencing.md`](../voice/implementation-sequencing.md),
  [`docs/voice/architecture.md`](../voice/architecture.md).
- [ADR-0038](ADR-0038-outbound-egress.md) (`gatewayFetch` egress), [ADR-0046](ADR-0046-local-credential-vault.md)
  (sealed credentials).
