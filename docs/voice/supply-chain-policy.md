# Voice Digital Twin — supply-chain policy

Supply-chain policy for Epic #491, expanding
[ADR-0100](../adr/ADR-0100-voice-digital-twin-capability-architecture.md) decision D8. This policy binds every
voice child issue (#493–#506).

## 1. Policy: no new runtime media packages by default

The runtime dependency budget for the entire Voice Digital Twin is:

- the **existing `ws` package** (resolved version **8.21.0**, MIT), declared in the root CLI
  [`package.json`](../../package.json),
  [`packages/keiko-tools/package.json`](../../packages/keiko-tools/package.json), and — added by Issue #497
  under [ADR-0102](../adr/ADR-0102-realtime-voice-transport.md) — also
  [`packages/keiko-server/package.json`](../../packages/keiko-server/package.json); and
- **browser-native WebRTC APIs** (`RTCPeerConnection`, `MediaDevices.getUserMedia`, `RTCDataChannel`,
  `RTCIceCandidate`, `RTCSessionDescription`, ICE/STUN/TURN), which are platform capabilities, not packages.

**No new runtime media package may be added by default.** This explicitly excludes `socket.io`,
`socket.io-client`, `simple-peer`, `peerjs`, `mediasoup`, `livekit` (and `livekit-server-sdk`), `wrtc` /
`node-webrtc`, `janus`, `kurento`, `jitsi`, `agora`, `twilio`, `@daily-co`, `opentok`, `sip.js` / `jssip`, and
any other runtime WebRTC wrapper, peer, SFU, or media-server library. A grep across every
`packages/**/package.json` confirms **none of these are present today**.

`adapter.js` (the WebRTC cross-browser compatibility shim) is **not** adopted by default; if a child issue
finds a concrete cross-browser gap, adopting it must be justified in that issue as a documented capability gap,
reviewed for license and size, and is a compatibility shim only — not a WebRTC SDK.

## 2. Rationale

- WebRTC is a **browser platform capability**, not an npm dependency; adding a client SDK would bloat the
  bundle and couple Keiko to a provider's event schema. Keeping to native APIs keeps the surface
  provider-agnostic and audit-friendly.
- The `ws` package is already vetted. In `keiko-tools` it is scoped to the CDP-to-Chrome client
  ([`cdp-client.ts`](../../packages/keiko-tools/src/browser/cdp-client.ts)) with a hard-coded method permit
  list. Re-using `ws` in a package that did not previously declare it is an explicit, ADR-gated decision, not
  a free additive reuse. That decision was **taken for `keiko-server`** by Issue #497 under
  [ADR-0102](../adr/ADR-0102-realtime-voice-transport.md), which re-opened the single loopback
  `/api/voice/control` WebSocket upgrade and declared `ws` in
  [`packages/keiko-server/package.json`](../../packages/keiko-server/package.json) for manifest correctness.
  This did **not** change the dependency count (`ws` was already resolved in the monorepo lockfile) and added
  no new package. `ws` therefore remains the single allowed runtime media-adjacent package across all three
  manifests; any further new WebSocket/media import remains ADR-gated (see
  [architecture.md](architecture.md) §4.1).
- Server-side WebRTC (the Node.js backend becoming a peer) would require a new native dependency and is
  **explicitly out of scope** for this epic; if ever needed it is raised as a separate dependency and
  architecture decision, not smuggled in.

## 3. Enforcement (existing gates, reused)

This policy is enforced by Keiko's existing supply-chain controls — no new tooling is required:

| Gate                             | Mechanism                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Dependency review**            | `.github/workflows/dependency-review.yml` fails PRs introducing high-severity or denied-license deps.                         |
| **`npm audit` (high and above)** | The `Build, scan, SBOM, smoke` CI job runs `npm audit --audit-level=high`.                                                    |
| **Per-workspace CycloneDX SBOM** | `npm run check:workspace-supply-chain` (`scripts/check-workspace-supply-chain.mjs`) — the SBOM + license gate.                |
| **Isolation has no npm deps**    | The enforced-egress backends are system binaries, not packages ([ADR-0043](../adr/ADR-0043-enforced-execution-isolation.md)). |

A voice child issue that proposes any runtime media package must (a) document the exact capability gap that
browser-native WebRTC plus `ws` cannot cover, (b) obtain an explicit architecture decision (ADR) approving the
addition, and (c) pass the dependency-review, `npm audit`, and SBOM/license gates. Absent all three, the
addition is rejected by this policy.

## 4. License posture

`ws` is MIT (compatible). The repository's dependency-review denies copyleft licenses (GPL-2.0, GPL-3.0,
AGPL-3.0, LGPL-2.1, LGPL-3.0); any proposed voice dependency must clear that gate. Browser-native WebRTC adds
no license obligation because it ships with the browser, not with Keiko.

## 5. References

- [ADR-0100](../adr/ADR-0100-voice-digital-twin-capability-architecture.md) D8;
  [ADR-0043](../adr/ADR-0043-enforced-execution-isolation.md) (isolation backends are system binaries).
- [architecture.md](architecture.md) §4 (transport), §7 (greenfield vs. reused).
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491) non-goals (no `socket.io`/`simple-peer`/
  `peerjs`/`mediasoup`/`livekit`/server-side WebRTC by default).
