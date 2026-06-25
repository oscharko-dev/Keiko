# Voice Digital Twin architecture (Epic #491)

This directory holds the architecture baseline, privacy contract, deployment matrix, supply-chain policy, and
implementation sequencing for Keiko's optional, capability-gated **Voice Digital Twin** (Epic #491). It is the
deliverable of Issue [#492](https://github.com/oscharko-dev/Keiko/issues/492) and is **design and governance
only** — it adds no runtime code, deploys no models, and adds no dependencies.

The authoritative decision record is
[ADR-0058](../adr/ADR-0058-voice-digital-twin-capability-architecture.md). The documents in this directory
expand each decision into detailed contracts that the child issues (#493–#506) reference.

## Documents

| Document                                                     | Purpose                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)                           | Detailed capability-gated architecture: provider profiles, capability gating, transport planes, degradation rules.                                                                                                                                                                                                                |
| [privacy-contract.md](privacy-contract.md)                   | Local-first data boundary, the external-call rule, and the security review requirements for the voice surface.                                                                                                                                                                                                                    |
| [deployment-profile-matrix.md](deployment-profile-matrix.md) | Provider profile × environment profile matrix (Azure Foundry, customer-hosted controlled-network, no-voice).                                                                                                                                                                                                                      |
| [supply-chain-policy.md](supply-chain-policy.md)             | The "no new runtime media packages by default" policy and its enforcement hooks.                                                                                                                                                                                                                                                  |
| [implementation-sequencing.md](implementation-sequencing.md) | Dependency order and write-ownership boundaries for child issues #493–#506.                                                                                                                                                                                                                                                       |
| [capability-configuration.md](capability-configuration.md)   | Implemented (#493): configuring, registering (`keiko-stt`), reading, and disabling voice capability metadata.                                                                                                                                                                                                                     |
| [dictation-endpoint.md](dictation-endpoint.md)               | Implemented (#494): the optional, capability-gated BFF speech-to-text dictation route and provider-neutral seam.                                                                                                                                                                                                                  |
| [dictation-ui.md](dictation-ui.md)                           | Implemented (#495): the capability-gated composer dictation UX — capture, transcript preview/edit, insert, a11y.                                                                                                                                                                                                                  |
| [protocol.md](protocol.md)                                   | Defined (#496): the versioned voice control / WebRTC media / capability-gating / replay protocol contract ([ADR-0059](../adr/ADR-0059-voice-control-media-capability-replay-protocol.md)).                                                                                                                                        |
| [realtime-transport.md](realtime-transport.md)               | Implemented (#497): the realtime transport — re-opened loopback WebSocket control plane + browser WebRTC media, proxied-SDP negotiation ([ADR-0060](../adr/ADR-0060-realtime-voice-transport.md)).                                                                                                                                |
| [transcript-semantics.md](transcript-semantics.md)           | Defined (#500): the provider-neutral transcript segment lifecycle (partial/stable/committed/corrected/discarded/redacted/provider-error), reducer, and committed-only integration boundary ([ADR-0063](../adr/ADR-0063-voice-transcript-segment-semantics.md)).                                                                   |
| [assistant-speech-output.md](assistant-speech-output.md)     | Implemented (#501): the optional, capability-gated assistant speech-output playback lifecycle (unavailable/preparing/speaking/paused/interrupted/canceled/failed/complete), controller, interruption boundary, and accessible UI — no new TTS deployment ([ADR-0064](../adr/ADR-0064-voice-assistant-speech-output-playback.md)). |

## Core invariants (summary)

1. Voice is **optional and capability-gated**. Keiko starts and remains fully usable when no voice model is
   configured, unreachable, disabled by policy, or unsupported by the provider.
2. **STT-only dictation** is distinct from **full realtime voice conversation**; full conversation requires
   the provider to advertise the realtime speech / speech-in-speech-out capability.
3. **WebSocket** is the authoritative control and signaling plane; **WebRTC** is the preferred media plane,
   using native browser APIs. Raw audio over the control plane is not the default real-time transport.
4. Voice introduces **no external destinations** except explicitly configured model endpoints selected through
   runtime capability metadata. Audio, transcripts, session state, recap, memory candidates, policy
   decisions, and audit metadata remain local by default.
5. **No new runtime media packages by default** beyond the existing `ws` dependency and browser-native WebRTC
   APIs.

These invariants are derived from Epic #491 and grounded in the existing Keiko seams cited in
[ADR-0058](../adr/ADR-0058-voice-digital-twin-capability-architecture.md).
