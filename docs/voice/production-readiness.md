# Voice Digital Twin — production-readiness gate (Epic #491)

**Audience:** verification leads, security reviewers, and release/governance owners deciding whether the
optional Voice Digital Twin is safe to enable for regulated deployments.

This document is the deliverable of Issue [#506](https://github.com/oscharko-dev/Keiko/issues/506) — the
**formal production-readiness gate** for Epic #491. It is the authoritative companion to
[ADR-0069](../adr/ADR-0069-voice-production-readiness-gate.md). It consolidates the closure evidence that the
six epic invariants hold across the no-voice, STT-only, full-realtime, Azure Foundry, and customer-hosted
deployment profiles, and it records — without softening — the limitations a conservative gate must keep
visible.

The gate is **conservative by construction**: every claim below cites a reproducible artifact (code symbol,
test, evaluation dimension, CI job, dependency scan, or GitHub state). Where a proof is structural or
documentary rather than end-to-end, that is stated explicitly in [§8 Known limitations](#8-known-limitations).
This issue ships **documentation only** — it adds no runtime code and no dependency; it consolidates and
verifies evidence that already shipped across child issues #492–#505 (see
[ADR-0069](../adr/ADR-0069-voice-production-readiness-gate.md) for the decision rationale).

## 1. Production-readiness checklist (Deliverable)

Each acceptance criterion of Issue #506 maps to cited, reproducible evidence. "Layer" means the evidence is
proven by the **union** of independent layers (contract data, server enforcement, UI gating, evaluation,
CI), not a single artifact.

| #   | Acceptance criterion                                                                     | Status     | Primary evidence (see linked sections)                                    |
| --- | ---------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| AC1 | No-voice deployments remain fully functional                                             | ✅ Proven  | [§2](#2-ac1--no-voice-deployments-remain-fully-functional)                |
| AC2 | Voice features appear only when required capabilities exist                              | ✅ Proven  | [§3](#3-ac2--voice-features-appear-only-when-required-capabilities-exist) |
| AC3 | Audio and voice session state remain local except explicit calls to configured endpoints | ✅ Proven† | [§4](#4-ac3--audio-and-session-state-remain-local)                        |
| AC4 | Azure Foundry and customer-hosted profiles documented without making either mandatory    | ✅ Proven  | [§5](#5-ac4--deployment-profiles-documented-neither-mandatory)            |
| AC5 | No unapproved runtime media packages were introduced                                     | ✅ Proven  | [§6](#6-ac5--no-unapproved-runtime-media-packages)                        |
| AC6 | The epic contains final closure evidence and all child issues are closed                 | ✅ Proven  | [§7](#7-ac6--epic-closure-and-child-issue-verification)                   |

† AC3 is proven structurally and by the egress-bounding seams; the full-realtime WebRTC media plane is a
direct browser↔provider channel whose locality rests on documentation + CSP, not an end-to-end network test
(see [§8](#8-known-limitations)).

All evidence is reproducible from the repository root with no voice credentials, no model endpoint, and no
network access. See [§9 Reproduction](#9-reproduction-appendix) for the exact commands.

## 2. AC1 — No-voice deployments remain fully functional

No-voice is the **default and the regulated baseline**: the built-in capability registry ships empty, so a
default Keiko deployment configures zero voice (or any) model capabilities.

- **Empty default registry.** `CAPABILITY_DATA` is an empty array
  ([`packages/keiko-model-gateway/src/capabilities.data.ts`](../../packages/keiko-model-gateway/src/capabilities.data.ts)).
  Keiko ships no customer or deployment-specific model ids.
- **Fail-closed resolution, never an error.** With no voice capability, voice resolution returns
  `available: false`, `profile: "none"`, reason `no-voice-provider`
  (`resolveVoiceCapabilityFromCapabilities` / `unavailableVoice` in
  [`packages/keiko-model-gateway/src/capabilities.ts`](../../packages/keiko-model-gateway/src/capabilities.ts)).
  The server capability endpoint falls back to `{ providers: [] }` for an unconfigured server
  ([`packages/keiko-server/src/read-handlers.ts`](../../packages/keiko-server/src/read-handlers.ts)) and is
  documented as keeping "Keiko fully usable in no-voice environments".
- **`none` renders no UI.** `VoiceProfile` lists `none` first and the contract states it means "no voice
  affordance is rendered at all"
  ([`packages/keiko-contracts/src/gateway.ts`](../../packages/keiko-contracts/src/gateway.ts), `VoiceProfile`
  / `VoiceCapabilityResolution`). All four voice surfaces (dictation mic, realtime button, speech-output
  mute, recap) render only behind `voice*Visible` conditionals in
  [`ChatWindow.tsx`](../../packages/keiko-ui/src/app/components/desktop/ChatWindow.tsx); every `supports*`
  predicate is false for a `none`/unavailable resolution **and** for an in-flight/failed probe
  ([`useVoiceCapability.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/useVoiceCapability.ts)),
  so the composer stays text-capable regardless.

**The decisive regression evidence:** the entire package suite, UI suite, and e2e smoke run green in CI under
the default configuration with **no voice provider configured** (`CAPABILITY_DATA` empty; no `KEIKO_VOICE` /
`VOICE_PROVIDER` environment variable exists anywhere in `.github/workflows/`). Chat, workflows, memory,
repository context, and evidence features are exercised by their existing suites with voice absent.

- Unit/integration: `voice-capability.test.ts` ("no-voice profile (AC1)"), `read-handlers.test.ts`, and the
  keiko-ui `ChatWindow.voice.test.tsx` no-voice cases assert the composer is present and editable while no
  mic / realtime / playback control renders.
- Evaluation: the voice-twin suite has a **no-voice GO gate** — `coversNoVoice` is required by the GO/NO-GO
  verdict and the `no-voice-dormancy` dimension asserts effective profile `none`, zero allowed message kinds,
  media transport `none`, and egress `none`
  ([`scorer.ts`](../../packages/keiko-evaluations/src/voice-twin/scorer.ts) /
  [`runner.ts`](../../packages/keiko-evaluations/src/voice-twin/runner.ts) /
  [`fixtures/no-voice.ts`](../../packages/keiko-evaluations/src/voice-twin/fixtures/no-voice.ts)). A mutation
  test asserts the verdict flips to NO-GO when `coversNoVoice` is false, so the gate is falsifiable.

**Limitation (recorded, not glossed):** the e2e no-voice path stubs `/api/voice/capability` with a `none`
payload rather than driving a fully unconfigured server, so the regulation-grade no-voice regression
guarantee rests on the unit/handler tests above, not on the e2e smoke. See [§8](#8-known-limitations).

## 3. AC2 — Voice features appear only when required capabilities exist

Capability gating is enforced by the **union of five independent layers**; the evaluation harness proves only
the contract-data layer (it does not import the server or UI predicates, per the ADR-0068 boundary), so AC2's
production proof is the layered enforcement, not the eval alone.

1. **Contract data.** `VOICE_PROFILE_ALLOWED_MESSAGE_KINDS`
   ([`packages/keiko-contracts/src/voice-protocol.ts`](../../packages/keiko-contracts/src/voice-protocol.ts))
   bounds each profile's allowed message kinds; STT-only **excludes** SDP offer/answer, ICE candidate, media
   track state, playback state, and control-interrupt kinds. Proven in `voice-protocol.test.ts`.
2. **Server enforcement.** `isVoiceDictationCapable` / `isVoiceRealtimeCapable` and the resolution predicates
   in [`read-handlers.ts`](../../packages/keiko-server/src/read-handlers.ts) gate what the BFF advertises
   (tested in `read-handlers.test.ts`).
3. **Live header.** The BFF emits `Permissions-Policy ... microphone=(self)` only when the resolved
   capability advertises speech-to-text or full-realtime, and `microphone=()` otherwise, never wider than
   `(self)` ([`packages/keiko-server/src/headers.ts`](../../packages/keiko-server/src/headers.ts); asserted in
   `server.test.ts`).
4. **WebSocket upgrade gate.** The re-opened `/api/voice/control` upgrade is accepted only for full-realtime
   capability + policy; every other upgrade keeps the `404` + `socket.destroy()` default
   ([`packages/keiko-server/src/voice-realtime.ts`](../../packages/keiko-server/src/voice-realtime.ts);
   `voice-control-ws.test.ts`).
5. **UI gating.** The `supports*` predicates and `voice*Visible` flags
   ([`useVoiceCapability.ts`](../../packages/keiko-ui/src/app/components/desktop/hooks/useVoiceCapability.ts),
   `ChatWindow.tsx`) render each surface only when its capability is present, exercised end-to-end in the
   voice smoke specs under `tests/e2e/`.

The evaluation layer corroborates the contract data: `deriveCapabilityCell`
([`capability.ts`](../../packages/keiko-evaluations/src/voice-twin/capability.ts)) and the
`stt-affordance-bounding` dimension assert STT-only never exposes realtime/media/playback affordances.

## 4. AC3 — Audio and session state remain local

The local-first data boundary is specified in [privacy-contract.md](privacy-contract.md) §1 and enforced by
reusing existing seams — voice introduces no bespoke HTTP or signaling client for provider calls.

- **Single model-traffic egress.** All voice model traffic routes through `gatewayFetch`
  ([`packages/keiko-model-gateway/src/http.ts`](../../packages/keiko-model-gateway/src/http.ts)) via the
  provider-neutral adapters
  ([`realtime-voice-adapter.ts`](../../packages/keiko-model-gateway/src/realtime-voice-adapter.ts),
  [`speech-to-text-adapter.ts`](../../packages/keiko-model-gateway/src/speech-to-text-adapter.ts)), inheriting
  proxy, CA, timeout, and byte-cap behavior (ADR-0038).
- **Provider-bounded reachability, fail-closed.** Only configured **and** capable models are electable
  (`assertConfiguredModel` / `selectConfiguredModel` / `selectCompletionModel` in
  [`packages/keiko-model-gateway/src/model-selection.ts`](../../packages/keiko-model-gateway/src/model-selection.ts));
  a capability that names no configured provider can never be elected.
- **Enforced egress for untrusted execution.** Model-generated code executed for a voice flow runs under
  `keiko-sandbox` with `network: "none"`, the OS-enforced, CI-proven egress boundary (ADR-0043).
- **Egress bounding has teeth (evaluation).** `auditVoiceEgress`
  ([`privacy.ts`](../../packages/keiko-evaluations/src/voice-twin/privacy.ts)) approves a voice cell's egress
  ledger **iff** every destination is `none` or `configured-model-endpoint`; adversarial `privacy-negative`
  fixtures with an `unapproved-external` destination pass **by being caught** (the auditor must report
  `approved: false`).
- **Never persist raw audio; redact at rest.** Raw audio is processed in memory only and never reaches a
  writer; transcripts, recap, session state, memory candidates, and audit metadata reuse the existing
  AES-256-GCM sealing, key ladder, redaction, and identifier-hashing stack
  ([privacy-contract.md](privacy-contract.md) §2–§3; ADR-0046/0047/0048). Voice audit records are
  content-free (counts and enums only), as recorded in the child ADRs (ADR-0066/0067).

**Two egress channels — stated explicitly.** Voice has two outbound paths: (a) the **proxied-SDP / STT model
channel** through `gatewayFetch`, and (b) the **full-realtime WebRTC media plane**, which is a direct
browser↔provider DTLS-SRTP channel that does **not** traverse `gatewayFetch`
([realtime-transport.md](realtime-transport.md), [privacy-contract.md](privacy-contract.md) §4). Channel (b)
is bounded by configuration (only configured STUN/TURN/media hosts), the same-origin control plane, and CSP
`connect-src 'self'`, not by an executable network test. This is acceptable for "egress only to configured
endpoints" but must not be described as if `gatewayFetch` bounds 100% of voice egress (see
[§8](#8-known-limitations)).

## 5. AC4 — Deployment profiles documented, neither mandatory

[deployment-profile-matrix.md](deployment-profile-matrix.md) documents both regulated provider environments
and the no-voice baseline, and is the AC4 evidence:

- **Azure Foundry development / academic** and **customer-hosted controlled-network (professional)** are both
  documented as first-class environment profiles (§2), each egressing only to its own configured endpoint
  (§3). Private / RFC-1918 customer endpoints are first-class.
- **Neither is mandatory.** Azure Foundry is "one valid provider, never a required destination"
  ([deployment-profile-matrix.md](deployment-profile-matrix.md) intro; [architecture.md](architecture.md) §3),
  and **No-voice** is the default and regulated baseline where Keiko is fully usable (§2, §3 no-voice row).
- **Same build serves all cells.** Only configuration and runtime capability metadata differ (§3 reading
  rule). The voice-twin evaluation encodes all three environment profiles (`VOICE_ENVIRONMENT_PROFILES` in
  [`profiles.ts`](../../packages/keiko-evaluations/src/voice-twin/profiles.ts)) and proves the expected
  effective profile and egress class per cell.

AC4 is fully satisfied by existing documentation with no outstanding action.

## 6. AC5 — No unapproved runtime media packages

The dependency budget for the entire epic is **the existing `ws` package + browser-native WebRTC APIs**, and
nothing else ([supply-chain-policy.md](supply-chain-policy.md)).

- **The epic's entire dependency delta is one manifest line.** Diffed against the integration merge-base
  (`8cdf2d69`), the only dependency added across all `package.json` files is `"ws": "^8.21.0"` declared in
  [`packages/keiko-server/package.json`](../../packages/keiko-server/package.json). `ws` is now declared in
  three manifests (root CLI, `keiko-tools`, and — added by #497 — `keiko-server`); the resolved version is
  unchanged and **no new package was added to `package-lock.json`**. This keiko-server declaration is the
  explicit, ADR-gated decision recorded in
  [ADR-0060](../adr/ADR-0060-realtime-voice-transport.md) (re-opening the loopback WebSocket control plane);
  the dependency **count** is unchanged. `ws` is a WebSocket library (MIT), not a media/WebRTC package.
- **No denied media package is present.** A scan of every `packages/**/package.json` and the root manifest
  for the denied runtime-media vendors (socket.io, simple-peer, peerjs, mediasoup, livekit, wrtc, janus,
  kurento, jitsi, agora, twilio, @daily-co, opentok, sip.js, jssip, …) returns **zero hits**. This is
  enforced in the evaluation by `DENIED_MEDIA_PACKAGES` + `scanManifestsForDeniedMediaPackages`
  ([`privacy.ts`](../../packages/keiko-evaluations/src/voice-twin/privacy.ts)), with `ALLOWED_MEDIA_RUNTIME`
  deep-equal to `["ws"]`; an adversarial fixture injecting `simple-peer` flips the scan to not-clean, so the
  "clean today" assertion is a real gate.
- **Existing supply-chain gates.** `npm audit --audit-level=high` and the per-workspace CycloneDX SBOM /
  license gate (`npm run check:workspace-supply-chain`) run in the CI `Build, scan, SBOM, smoke` job;
  `.github/workflows/dependency-review.yml` denies high-severity and copyleft (GPL/AGPL/LGPL) licenses on PRs.

**Limitations (recorded):** the evaluation scan is **name-based and manifest-only** (it reads declared
dependencies, not the resolved lockfile tree), so a renamed vendor or a transitively-pulled denied package
could evade that specific check — mitigated for this epic because the lockfile diff independently proved zero
new packages. The `dependency-review.yml` diff gate currently triggers on PRs to `dev` / `feat/keiko-editor` /
`release/**`, not the epic branch, so it enforces at the eventual `feat/keiko-voice-digital-twin → dev`
integration PR, which must be green before general availability is declared. See [§8](#8-known-limitations).

## 7. AC6 — Epic closure and child-issue verification

- **All child issues closed with verification.** Issues #492–#505 are all `CLOSED` with state reason
  `COMPLETED`; each carries a closure-evidence comment, and all fourteen implementation PRs (#1457–#1494) are
  merged into `feat/keiko-voice-digital-twin` with GitHub-verified merge commits.
- **Epic closure evidence.** The final epic closure comment rolling up this checklist, the capability matrix,
  the security/privacy review record, the dependency confirmation, and the deployment-profile docs is posted
  to Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491) as the closing act of Issue #506.

## 8. Known limitations

A conservative gate keeps these visible; none blocks general availability **once documented** and the epic
closure comment plus the green `feat/keiko-voice-digital-twin → dev` integration PR are in place.

1. **No positive destination allowlist.** `validateBaseUrl`
   ([`packages/keiko-model-gateway/src/config.ts`](../../packages/keiko-model-gateway/src/config.ts))
   deliberately does not restrict host/IP, because private/self-hosted endpoints are first-class for
   customer-hosted deployments. AC3 is satisfied by bounding which endpoints are reachable and which models
   are electable, not by a deny-everything-else allowlist. A thin opt-in egress-policy layer is deferred to a
   future child issue.
2. **WebRTC media-plane locality is documentary.** The full-realtime media plane egresses browser↔provider
   directly (not via `gatewayFetch`); its locality rests on configuration + CSP `connect-src 'self'`, with no
   end-to-end network test.
3. **No-voice e2e is stubbed.** The e2e no-voice path stubs the capability endpoint; the regulation-grade
   no-voice regression guarantee rests on the unit/handler suites.
4. **Denied-media scan is name-based / manifest-only.** It does not walk transitive `package-lock.json`
   entries; operators must keep `DENIED_MEDIA_PACKAGES` current as new vendors appear.
5. **`dependency-review` enforces at the integration boundary.** The license/severity diff gate fires at the
   `feat/keiko-voice-digital-twin → dev` PR, not per child PR (mitigated: the only delta is a pre-existing MIT
   package, and `npm audit` + SBOM ran per child).
6. **Reconstructive evidence at rest.** Voice reconstructive artifacts inherit the ADR-0048 D3 deferral
   (customer-reconstructive evidence is not encrypted at rest in 0.2.x) until that deferral is lifted.

## 9. Follow-up issues (recommended, non-blocking)

These are deferred hardening items, explicitly out of scope for the closure gate, recommended for a future
deployment that requires them:

- Opt-in positive egress allowlist derived from configured providers, enforced at the `gatewayFetch`
  boundary, without breaking private endpoints (limitation 1).
- Transitive lockfile scan for denied media packages, complementing the manifest scan (limitation 4).
- Add `feat/keiko-voice-digital-twin` to `dependency-review.yml` for per-PR symmetry (limitation 5).
- TURN / relay-only ICE and any server-side WebRTC peer support for controlled networks that require it
  (server-side WebRTC is a new dependency + architecture decision, out of scope for this epic).

## 10. Reproduction appendix

All commands run from the repository root with no voice credentials and no network access:

```bash
# AC1/AC2/AC5 — full voice-twin evaluation suite (GO/NO-GO gate; no clock/network/model)
npx vitest run packages/keiko-evaluations/src/voice-twin            # 8 files, 168 tests

# AC5 — the epic's entire dependency delta (expect a single "+ ws" line)
git diff "$(git merge-base HEAD origin/dev)"...HEAD -- '**/package.json' 'package.json' | grep -E '^\+\s+"'

# AC5 — denied-media-package scan across all manifests (expect zero hits)
grep -rERn '"(socket\.io|simple-peer|peerjs|mediasoup|livekit|wrtc|node-webrtc|janus|kurento|jitsi|agora|twilio|@daily-co|opentok|sip\.js|jssip)' \
  --include=package.json . --exclude-dir=node_modules

# AC5 — ws appears only in the three documented manifests
grep -rEn '"ws":' --include=package.json . --exclude-dir=node_modules

# AC1 — empty default capability registry
sed -n '1,9p' packages/keiko-model-gateway/src/capabilities.data.ts

# AC6 — all child issues closed COMPLETED
for n in $(seq 492 505); do gh issue view "$n" --json number,state,stateReason; done
```

The same evidence runs in CI: the `ci` job's `test:coverage:quality` step executes the package + evaluation
suites, and the `ui` job's `test:coverage:ui` and `test:e2e:smoke` steps execute the UI and smoke suites —
all with no voice provider configured.

## 11. References

- [ADR-0069](../adr/ADR-0069-voice-production-readiness-gate.md) — production-readiness gate decision.
- [ADR-0058](../adr/ADR-0058-voice-digital-twin-capability-architecture.md) — capability-gated architecture.
- [architecture.md](architecture.md), [privacy-contract.md](privacy-contract.md),
  [deployment-profile-matrix.md](deployment-profile-matrix.md),
  [supply-chain-policy.md](supply-chain-policy.md), [evaluation-harness.md](evaluation-harness.md).
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491); Issue
  [#506](https://github.com/oscharko-dev/Keiko/issues/506).
