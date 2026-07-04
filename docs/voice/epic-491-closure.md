# Epic #491 — Voice Digital Twin: coordination closure record

**Audience:** epic coordinators, planning leads, and governance stakeholders reviewing the end-to-end delivery and independent closure verification of Epic #491 ("Build the Capability-Gated Keiko Voice Digital Twin").

Epic #491 is a planning and coordination container that delivered the optional, capability-gated Voice Digital Twin through 15 child issues (#492–#506) integrated on the branch `feat/keiko-voice-digital-twin`. This record consolidates the epic-level Definition of Done, the child delivery rollup, and the independent verification performed at closure. It is distinct from the regulated-deployment readiness gate recorded in [production-readiness.md](production-readiness.md) and [ADR-0111](../adr/ADR-0111-voice-production-readiness-gate.md), which addresses security reviewers and compliance officers.

The authoritative closure evidence is posted to Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491#issuecomment-4799317935).

## Closure Verdict

**All six epic Target Outcomes and all Definition-of-Done items are satisfied** by the union of the merged child deliverables, independently re-verified at closure. Voice is optional, capability-gated, and local-first; Keiko remains fully usable with no voice model configured. Zero code gaps exist; one named, pre-documented, non-blocking limitation remains (no positive egress allowlist). The epic is closure-ready; general availability remains gated on the separate `feat/keiko-voice-digital-twin → dev` integration pull request.

## Epic Acceptance Ledger

| Target Outcome / DoD Item                                                                            | Status      | Independent Evidence                                                                                                                                                                                                                                                                                                                                          | Delivered By                       |
| ---------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **TO1 — No-voice fully usable**                                                                      | ✅ Verified | `packages/keiko-model-gateway/src/capabilities.data.ts:8` (`CAPABILITY_DATA = []`); `capabilities.ts:340-358` fail-closed `unavailableVoice('no-voice-provider')`; `ChatWindow.tsx:458-499,709-722` every voice control gated; `voice-twin/runner.test.ts:247-258` falsifiable `coversNoVoice` GO gate                                                        | #492, #493, #495, #505             |
| **TO2 — STT-only dictation**                                                                         | ✅ Verified | `keiko-server/src/voice-handlers.ts:316-324` capability-gated `POST /api/voice/transcribe` (503 `VOICE_UNAVAILABLE` otherwise); `config.test.ts:1197-1217` `keiko-stt` registered via config (Azure Foundry locality, STT-only); `speech-to-text-adapter.ts` provider-neutral, audio never persisted                                                          | #493, #494, #495                   |
| **TO3 — Full realtime only when advertised**                                                         | ✅ Verified | `keiko-server/src/voice-realtime.ts:412-476` WS upgrade gated on `isVoiceRealtimeCapable`; `read-handlers.ts:114-131` requires `voice.available && voice.transport.webrtcMedia`; no-voice/STT-only/policy-disabled → hard-reject                                                                                                                              | #496, #497                         |
| **TO4 — Local-first, no hidden destinations**                                                        | ✅ Verified | All voice model traffic via `gatewayFetch` (`speech-to-text-adapter.ts:253`, `realtime-voice-adapter.ts:190`); raw audio in-memory only (never persisted); provider credentials never reach the browser (proxied SDP); spoken-execution sandbox `network:"none"`. Adversarial egress sweep found zero direct-egress/telemetry/beacon paths. See limitation 1. | #492, #497, #503, #504             |
| **TO5 — WS control + WebRTC media**                                                                  | ✅ Verified | `keiko-contracts/src/voice-protocol.ts:41-50` `VOICE_CONTROL_TRANSPORTS`; `:135-149` `VOICE_MEDIA_PLANE` (WebRTC, never-persisted); `server.ts:218-225` only the gated loopback `/api/voice/control` upgrade accepted, all others hard-rejected; graceful degradation ladder `none` → `gateway-batch` → `webrtc`                                              | #496, #497, #498, #499, #500, #501 |
| **TO6 — Evaluable across 5 profiles**                                                                | ✅ Verified | `packages/keiko-evaluations/src/voice-twin/` capability axis (none/stt/speech-output/full-realtime) × environment axis (azure-foundry/customer-hosted/no-voice-env); 8 files / 168 tests GO                                                                                                                                                                   | #505                               |
| **DoD — All child issues closed**                                                                    | ✅ Verified | #492–#506 all `CLOSED` with state reason `COMPLETED` and per-issue closure comments                                                                                                                                                                                                                                                                           | All                                |
| **DoD — Required `ci` green on implementation PRs**                                                  | ✅ Verified | 15 child PRs merged green; post-merge `ci` on feat HEAD `7cd20568` (run 28170574545) green                                                                                                                                                                                                                                                                    | All                                |
| **DoD — Final closure evidence recorded**                                                            | ✅ Verified | Epic #491 closure comment + this document + [production-readiness.md](production-readiness.md)                                                                                                                                                                                                                                                                | #506                               |
| **DoD — Known limitations documented**                                                               | ✅ Verified | [production-readiness.md](production-readiness.md) §8/§9; [ADR-0111](../adr/ADR-0111-voice-production-readiness-gate.md) D3                                                                                                                                                                                                                                   | #506                               |
| **Invariants — No new media deps; gateway not bypassed; orchestrator authority; gates not weakened** | ✅ Verified | Epic dependency delta vs `dev` = single line `ws@^8.21.0` in `keiko-server/package.json`; zero denied media packages in any manifest or `package-lock.json`; spoken intent only proposes (routes through existing permission/workflow gates); coverage baselines and arch:check unchanged                                                                     | #497, #503                         |

## Child Delivery Rollup

| Issue | Title                                        | PR    | Merge SHA |
| ----- | -------------------------------------------- | ----- | --------- |
| #492  | Architecture / privacy / supply-chain        | #1457 | b2d835e1  |
| #493  | Voice capability metadata                    | #1461 | adf26cbd  |
| #494  | BFF STT dictation endpoint                   | #1463 | df66416b  |
| #495  | Composer dictation UX                        | #1464 | f06a7dc6  |
| #496  | Voice control/media/replay protocol          | #1465 | e3bcfba7  |
| #497  | Realtime WebRTC + WS transport               | #1467 | 8cfee433  |
| #498  | Voice timing engine                          | #1469 | 2ca092af  |
| #499  | Voice turn manager                           | #1473 | d6a549ee  |
| #500  | Transcript segment semantics                 | #1475 | dfe6684e  |
| #501  | Assistant speech-output playback             | #1480 | 09261f78  |
| #502  | Discussion intelligence                      | #1486 | d81fa476  |
| #503  | Spoken-action governance                     | #1490 | bee2f32e  |
| #504  | Voice session recap                          | #1492 | 9fc2736c  |
| #505  | Voice evaluation harness (capstone)          | #1494 | 23cb036b  |
| #506  | Production-readiness gate + closure evidence | #1496 | 7cd20568  |

All 15 PRs are merged into `feat/keiko-voice-digital-twin`; merge-commit signatures are GitHub-verified.

## Independent Verification Performed at Closure

The following re-verification was performed by the coordinator at closure on feat HEAD `7cd20568`:

- **Six-lens adversarial verification workflow** (AC1, AC2/AC3, AC4, AC5/AC6, architecture invariants, governance) plus three skeptic lenses attempting to refute the highest-risk claims:
  - No-voice fail-closed: skeptic confirmed every voice surface is gated and the resolved profile defaults to `none` in code, tests, and evaluation.
  - Hidden egress: adversarial egress sweep found zero direct-egress/telemetry/beacon paths outside `gatewayFetch` and CSP, and no raw-audio disk writes.
  - Dependency budget: lockfile diff independently proved zero new packages; the `ws` declaration is the pre-documented, ADR-0102-gated decision.
  - All adversarial attempts failed to refute any epic Target Outcome or acceptance criterion.

- **Executable evidence:**
  - Voice-twin evaluation suite: 8 files / 168 tests passed (the falsifiable GO gate, including `coversNoVoice`).
  - Contract voice suites (`voice-protocol`, `voice-transcript`, `voice-playback`, `voice-action-intent`, `voice-session-recap`): 5 files / 175 tests passed.

- **Supply-chain audit:**
  - `git diff origin/dev...HEAD` over all manifests + lockfile: exactly one changed line (`keiko-server/package.json` `ws` declaration).
  - `package-lock.json` unchanged; no new packages added.

- **CI verification:**
  - Post-merge `ci` run 28170574545 on feat HEAD — every required check green, including the `ci` job.

## Known Limitation and Follow-Ups

**Named limitation (documented, non-blocking):**

The evaluation egress auditor (`auditVoiceEgress`) is a deterministic design/CI-conformance gate, not a live runtime egress monitor. There is no positive destination host/IP allowlist; `validateBaseUrl` intentionally permits private/customer-hosted endpoints. Egress is bounded by `gatewayFetch` routing to configured provider endpoints plus CSP `connect-src 'self'`. This is the pre-documented limitation 1 in [production-readiness.md](production-readiness.md) §8 and [ADR-0111](../adr/ADR-0111-voice-production-readiness-gate.md) D3, deferred to a future child issue as non-blocking for the conservative gate.

**Recommended, non-blocking follow-ups:**

- Opt-in positive egress allowlist derived from configured providers, enforced at the `gatewayFetch` boundary, without breaking private endpoints.
- Transitive lockfile scan for denied media packages, complementing the manifest scan.
- Add `feat/keiko-voice-digital-twin` to `dependency-review.yml` for per-PR symmetry.
- TURN / relay-only ICE and server-side WebRTC for controlled networks that require it (a new dependency + architecture decision, out of scope for this epic).

## Sign-Off

Signed-off-by: Claude coordinator implementation team.
