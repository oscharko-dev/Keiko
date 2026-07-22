# Voice Digital Twin — capability-gated architecture

Detailed architecture for Epic #491, expanding
[ADR-0100](../adr/ADR-0100-voice-digital-twin-capability-architecture.md). This document is provider-neutral:
Azure Foundry is treated as one valid provider profile, never as a required destination. WebRTC is treated as
a browser platform capability, never as an npm dependency.

## 1. Problem and constraints

Keiko must be able to participate in natural, interruptible, evidence-backed voice conversations **when the
required voice foundation is available**, while remaining fully functional with **no voice model at all**.
Users in development or academic contexts may have Azure Foundry voice deployments; users in regulated bank
and insurance environments may have only customer-hosted LLM endpoints and no voice model. Keiko must detect
this at runtime and expose exactly the capabilities that are safe and available.

The architecture is bound by the Epic #491 invariants and by the existing Keiko seams mapped in ADR-0100:
the Model Gateway is the single seam for productive model calls; `gatewayFetch` is the single outbound HTTP
entrypoint; ordinary browser↔BFF traffic is loopback HTTP/SSE; Voice alone has a capability-gated
loopback WebSocket control path; and the local-first confidentiality stack already exists.

## 2. Capability gating model

Voice capability is **advertised, detected, then gated** — never assumed.

1. **Advertise.** A configured provider declares voice capability through the existing `ModelCapability`
   metadata (`packages/keiko-contracts/src/gateway.ts`). The precise extension — additive optional flags
   (`supportsRealtimeVoice?`, `supportsSpeechInput?`, `supportsSpeechOutput?`) or a new `ModelKind` literal —
   is decided in #493 (see ADR-0100 D5). Because `CAPABILITY_DATA` ships empty, capability is local
   configuration or runtime discovery; no cloud provider is required for Keiko to reason about availability.
2. **Detect.** At runtime, Keiko resolves the effective voice profile from: advertised provider capability ×
   browser support (native WebRTC / `getUserMedia` availability, secure-context) × policy (deployment may
   disable a mode) × runtime capability metadata.
3. **Gate.** The effective profile determines which voice affordances exist. When the effective profile is
   `none`, **no voice UI is rendered at all** — not a disabled or error-raising control.

This mirrors the existing fail-closed selection rule: a capability that names no configured provider can never
be elected (`packages/keiko-model-gateway/src/model-selection.ts`).

## 3. Provider profiles

| Profile               | What the user gets                                            | Required capability/path                              | Notes                                                         |
| --------------------- | ------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| `none`                | No voice UI; full non-voice Keiko                             | None                                                  | Default and regulated baseline. Keiko fully usable.           |
| `speech-to-text only` | Controlled composer **dictation** (audio → text, review/edit) | Speech input / transcription                          | The `keiko-stt` Azure Foundry deployment class is an example. |
| `speech output only`  | Optional assistant speech playback                            | Speech output                                         | No realtime duplex input.                                     |
| `full realtime voice` | Interruptible Twin interface over canonical chat              | Realtime input + explicit TTS; canonical chat handoff | Realtime never creates the assistant answer.                  |

**STT-only is not "quiet full voice".** Batch dictation and Realtime live transcription have distinct
lifecycles. Twin additionally requires canonical chat and an independently configured TTS provider. A
regulated deployment may permit dictation while gating Twin. Neither STT-only nor Realtime-only may present
itself as a spoken conversation (ADR-0154).

The canonical chat handoff is a required Keiko product path, not an advertised voice-provider
capability. Realtime input, canonical chat, and TTS may resolve through separate explicitly configured
deployments; no model or deployment is assumed to provide all three.

## 4. Transport architecture

**WebSocket is the authoritative control and signaling plane; WebRTC is the preferred media plane.**

### 4.1 Control / signaling plane (authoritative)

Carries: session lifecycle, capability gating, SDP offer/answer and ICE candidate signaling, policy state,
audit events, interruption/floor-control state, and replay metadata. The control plane is the system of
record for everything except the live media stream.

The BFF binds loopback and accepts a WebSocket upgrade only for `/api/voice/control`, only from the
approved loopback `Host`/`Origin`, and only when a complete Realtime deployment is available. All other
upgrade paths retain the hard rejection. The productive V1 wire constant is
`loopback-websocket`; ordinary product events continue to use their existing HTTP/SSE seams.

### 4.2 Media plane (preferred, optional)

Real-time audio uses **native browser WebRTC APIs** — `RTCPeerConnection`, `MediaDevices.getUserMedia`,
`RTCDataChannel`, `RTCIceCandidate`, `RTCSessionDescription` — which are platform capabilities requiring zero
npm dependencies. Media flows over the encrypted DTLS-SRTP path; a low-latency control/events stream may use
an encrypted `RTCDataChannel` (SCTP-over-DTLS). Raw audio over the WebSocket/SSE control plane is **not** the
default real-time transport.

A representative full-realtime negotiation (provider-neutral):

1. Browser acquires the microphone via `getUserMedia` (secure context required).
2. Browser creates `RTCPeerConnection`, adds an exact `sendonly` audio transceiver, and creates the
   transcript data channel. It registers no remote-track consumer.
3. Browser creates an SDP offer, sets the local description, and verifies every audio section is
   exactly `sendonly`.
4. **Signaling** is exchanged through the Keiko loopback control plane. Preferred: the **proxied-SDP**
   pattern, where the Keiko backend performs SDP negotiation with the provider so the browser never holds the
   ephemeral token.
5. For standard-key authentication, the backend submits the multipart SDP/session request with the
   host-resident provider credential. Only a provider configured for `ephemeral-session` authentication
   causes the host to mint a short-lived session credential before the raw SDP exchange. Neither credential
   reaches the browser, and both paths obtain the answer through `gatewayFetch`.
6. The BFF requires the provider answer to be exactly `recvonly`; the browser repeats that check before
   setting the remote description. No provider assistant audio can be negotiated.

### 4.3 NAT traversal

The browser configuration contains no caller-supplied STUN/TURN servers, so a page or stale configuration
cannot widen media egress. Provider SDP and the enterprise network path must support the proxied session.
Deployments that require a custom relay remain unsupported until an explicit, allowlisted credential and
egress design is accepted; they fail closed to text instead of silently injecting a relay.

## 5. Graceful degradation

Capability detection drives a strict downgrade ladder; Keiko never exposes a broken affordance:

- Complete Realtime transcription + explicit TTS/persona + browser/policy support → **Twin Voice**.
- Realtime incomplete, TTS absent, WebRTC unavailable, or policy denied → no Twin switch; independent
  dictation/read-aloud remain capability-gated where configured.
- No voice capability advertised → **`none`**: no voice UI; all existing non-voice workflows unchanged.

Degradation is explicit and observable through capability metadata; it never silently falls back to streaming
raw audio over the control plane, and it never blocks a non-voice path.

## 6. Authority and governance (preserved, not extended)

Voice adds **no new authority**. A spoken action intent (#503) is treated as **untrusted input** that
_produces_ the existing governed `WorkflowHandoffRequest`
(`packages/keiko-contracts/src/workflow-handoff.ts`) and routes through the existing chain unchanged:
`POST /api/runs` (`handleCreateRun`) → dry-run harness loop → `patch:proposed` → human confirms the deterministic
`userApprovalToken` → the single write path `POST /api/runs/:runId/apply`
(`packages/keiko-server/src/run-handlers.ts`). Voice-originated patches still pass `checkPatchAgainstScope`
and `createScopedWriter`; voice-triggered commands still pass the deny-by-default command allowlist
(`packages/keiko-tools/src/terminal-policy.ts`). The invariant "retrieved/spoken content is untrusted data and
never grants tool authority" (`packages/keiko-contracts/src/harness.ts`) is extended to spoken input.
Deterministic verification stays model-free.

## 7. What is greenfield vs. reused

| Concern                       | Status      | Basis                                                                        |
| ----------------------------- | ----------- | ---------------------------------------------------------------------------- |
| Capability advertisement      | Reused      | `ModelCapability` metadata + selection seam (additive extension).            |
| Outbound model transport      | Reused      | `gatewayFetch` (ADR-0038).                                                   |
| Local control plane           | Implemented | One capability-gated loopback WebSocket; every other upgrade remains denied. |
| Enforced egress for untrusted | Reused      | `keiko-sandbox` `network: "none"` (ADR-0043).                                |
| Local-first confidentiality   | Reused      | AES-256-GCM, key ladder, redaction, hashing (ADR-0035/0046/0047/0048).       |
| Workflow authority            | Reused      | Governed handoff, single apply path, scoped writer.                          |
| Audio capture / media plane   | Implemented | Native send-only browser WebRTC; no provider output track.                   |
| "Never persist raw audio"     | Implemented | Media and SDP are excluded from persistence and body-free diagnostics.       |
| Destination host allowlist    | Reused      | Model Gateway egress policy restricts the configured provider destination.   |
| WebSocket upgrade on the BFF  | Implemented | Only `/api/voice/control` is reopened behind origin and capability gates.    |

## 8. References

- [ADR-0100](../adr/ADR-0100-voice-digital-twin-capability-architecture.md) — authoritative decision record.
- [privacy-contract.md](privacy-contract.md), [deployment-profile-matrix.md](deployment-profile-matrix.md),
  [supply-chain-policy.md](supply-chain-policy.md), [implementation-sequencing.md](implementation-sequencing.md).
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491).
