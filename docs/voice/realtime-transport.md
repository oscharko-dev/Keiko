# Voice Digital Twin — realtime transport (WebSocket control + browser WebRTC media)

Implementation notes for Epic #491, the deliverable of Issue
[#497](https://github.com/oscharko-dev/Keiko/issues/497) and the transport that realizes the #496
protocol ([protocol.md](protocol.md), [ADR-0059](../adr/ADR-0059-voice-control-media-capability-replay-protocol.md)).
The load-bearing decisions are in [ADR-0060](../adr/ADR-0060-realtime-voice-transport.md); this document
describes the realized transport. It is **optional and capability-gated**: a no-voice or STT-only
deployment runs none of it.

## 1. Two planes

| Plane                   | Realization (#497)                                                                         | npm cost    |
| ----------------------- | ------------------------------------------------------------------------------------------ | ----------- |
| **Control / signaling** | A bidirectional WebSocket on the loopback path `/api/voice/control` (`loopback-websocket`) | none (`ws`) |
| **Media**               | Native browser WebRTC (`RTCPeerConnection` / `getUserMedia` / `RTCDataChannel`, DTLS-SRTP) | none        |

The control plane carries every #496 control message kind; raw audio is **never** a control message
(a binary frame is rejected and the socket closed). Media flows browser↔provider directly over WebRTC.

## 2. The re-opened WebSocket upgrade (server)

The BFF previously hard-rejected **every** WebSocket upgrade. Issue #497 re-opens it for the **single**
path `/api/voice/control`, and only when the deployment is full-realtime capable:

1. `server.on("upgrade")` calls the voice control plane's `handleUpgrade`. It accepts only when the
   path is `/api/voice/control`, `isAllowedHost(req, port)` passes (loopback `Host`/`Origin`; opaque
   `Origin: null` and non-loopback are rejected), and `isVoiceRealtimeCapable(deps)` is true.
2. Any other path / host / capability falls through to the **unchanged** `HTTP/1.1 404` +
   `socket.destroy()` default.

A WebSocket handshake cannot carry the JSON + `X-Keiko-Csrf` guard, so the loopback `Host`/`Origin`
check plus the capability gate are the load-bearing cross-origin defenses (ADR-0060 D3).

## 3. Session lifecycle and proxied-SDP handshake

```
client                                   BFF (/api/voice/control)            provider (via gatewayFetch)
  │  ── session.create (proxied-sdp) ──▶  │
  │  ◀── session.created (loopback-       │   controlTransport=loopback-websocket
  │       websocket, webrtc) ───────────  │   mediaTransport=webrtc
  │  ◀── capability.offer ─────────────── │
  │  ── signal.sdp.offer (SDP) ────────▶  │
  │                                        │  ── POST /realtime/calls (application/sdp) ──▶
  │                                        │  ◀── SDP answer ────────────────────────────
  │  ◀── media.track.state (negotiating)  │
  │  ◀── signal.sdp.answer (SDP) ───────  │
  │  ◀── media.track.state (live ×2) ───  │
  │  ═══════ WebRTC media (DTLS-SRTP), browser ↔ provider ═══════
```

- A `session.create` whose `negotiationMode` is inconsistent with the effective profile's canonical
  mode (`VOICE_PROFILE_NEGOTIATION_MODE`) is rejected with `error` code `not-allowed-for-profile`.
- The host performs the SDP exchange (`requestRealtimeNegotiation`); the browser never holds the
  provider credential (AC2). A negotiation failure returns `error` code `negotiation-failed`.
- Per-direction monotonic `seq` + idempotency on `(sessionId, seq)`; a re-sent `session.create` with
  the same `idempotencyKey` resumes the session and replays the bounded `replayable` buffer rather than
  creating a duplicate (protocol §7).

## 4. The browser client

- `hooks/voice-rtc-transport.ts` — the injectable native-WebRTC seam: `getUserMedia` →
  `RTCPeerConnection` → add mic track + optional data channel → create offer → wait for ICE gathering
  to **complete** (non-trickle) → expose the complete offer SDP; `applyAnswer` sets the remote
  description; `close()` stops the mic track (clears the OS recording indicator) and closes the peer.
- `hooks/voice-realtime-client.ts` — the injectable WebSocket control client. Opens the WS
  **same-origin** (`ws(s)://${location.host}/api/voice/control`), runs the handshake, resolves with the
  answer SDP.
- `hooks/useRealtimeVoice.ts` — the `idle → requesting → negotiating → connected` state machine, with
  the `mountedRef` unmount-safety and deterministic teardown pattern shared with `useDictation`.
- The composer renders the realtime affordance only when `supportsRealtimeVoice(capability)` **and**
  `realtimeVoiceTransportSupported()` (the browser exposes `getUserMedia` + `RTCPeerConnection`); a
  no-voice / STT-only deployment renders nothing new.

## 5. Security and privacy (ADR-0060 D3/D4, privacy-contract §2/§4)

- **No long-lived credential reaches the browser** (proxied-SDP).
- **SDP / ICE are opaque `secret-bearing` strings** — forwarded verbatim, never logged or persisted.
  Every host→client frame passes the BFF redactor; transcript text is `stripUnsafeFormatChars`-cleaned
  before the bounded replay buffer.
- **No raw audio is persisted**, and raw audio never rides the control plane.
- **`Permissions-Policy` microphone** is scoped to STT-or-realtime deployments, never widened past
  `(self)`. **CSP is unchanged** — the same-origin WebSocket is covered by `connect-src 'self'`.
- **No new runtime media package** — the control plane reuses `ws`; the media plane is browser-native.

## 6. State boundary

The transport persists **no** new on-disk state (the replay buffer is in-memory, bounded, ephemeral).
Persisting transcripts / recap / memory candidates is deferred to #504, which adds the corresponding
`docs/local-runtime-state-contract.md` rows.

## 7. References

- [ADR-0060](../adr/ADR-0060-realtime-voice-transport.md) — the transport decision record.
- [protocol.md](protocol.md), [ADR-0059](../adr/ADR-0059-voice-control-media-capability-replay-protocol.md)
  — the protocol contract; [privacy-contract.md](privacy-contract.md) — privacy/security;
  [deployment-profile-matrix.md](deployment-profile-matrix.md) — provider/environment profiles.
- Transport code: `packages/keiko-server/src/voice-realtime.ts`,
  `packages/keiko-model-gateway/src/realtime-voice-adapter.ts`, and the keiko-ui
  `hooks/voice-rtc-transport.ts` / `hooks/voice-realtime-client.ts` / `hooks/useRealtimeVoice.ts` /
  `VoiceRealtime.tsx` client.
