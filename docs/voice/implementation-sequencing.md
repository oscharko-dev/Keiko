# Voice Digital Twin — implementation sequencing

Sequencing notes for Epic #491 child issues, expanding
[ADR-0058](../adr/ADR-0058-voice-digital-twin-capability-architecture.md) decision D9. This gives later issues
a stable dependency order and write-ownership boundaries so no two parallel issues own overlapping file scope.

## 1. Required order (from Epic #491)

1. **#492** — define the architecture, privacy contract, deployment matrix, and supply-chain policy. _(this
   deliverable)_
2. **#493** — add voice capability metadata and register the existing `keiko-stt` deployment safely.
3. **#494, #495** — deliver optional STT-only composer dictation (BFF endpoint, then UX).
4. **#496, #497** — define and implement WebSocket control plus WebRTC media transport.
5. **#498, #499, #500, #501** — runtime mechanics: timebase/buffer/backpressure, turn manager, transcript
   semantics, optional assistant speech output.
6. **#502, #503, #504** — colleague-like discussion behavior, governed spoken actions, recap, memory review.
7. **#505, #506** — evaluation harness and regulated production-readiness closure.

## 2. Dependency graph and layer

| Issue | Title (abridged)                                                  | Depends on | Primary layer                            |
| ----- | ----------------------------------------------------------------- | ---------- | ---------------------------------------- |
| #493  | Voice capability metadata; register `keiko-stt`                   | #492       | `keiko-contracts`, `keiko-model-gateway` |
| #494  | Optional BFF Speech-to-Text endpoint (dictation)                  | #493       | `keiko-server` (BFF routes)              |
| #495  | Capability-gated native composer dictation UX                     | #493, #494 | `keiko-ui` (composer)                    |
| #496  | Voice control, WebRTC media, gating, replay protocol              | #492, #493 | `keiko-contracts` (protocol), docs       |
| #497  | Optional WebRTC media transport (WS control, native browser APIs) | #496       | `keiko-server` + `keiko-ui` (transport)  |
| #498  | Voice timebase, buffer, backpressure, catch-up engine             | #497       | runtime media mechanics                  |
| #499  | Voice Turn Manager (end-of-turn, barge-in, floor control)         | #498       | runtime media mechanics                  |
| #500  | Partial/stable/committed/corrected/discarded transcript semantics | #497, #499 | transcript state                         |
| #501  | Optional interruptible assistant voice output                     | #497       | playback state                           |
| #502  | Discussion intelligence (Challenge/Review/Decide)                 | #500, #501 | discussion behavior                      |
| #503  | Route spoken action intent through governed workflow + gates      | #500, #502 | `keiko-server` governed handoff (reuse)  |
| #504  | Voice session recap + governed memory candidate review            | #500, #503 | `keiko-evidence`, `keiko-memory-capture` |
| #505  | Voice evaluation harness (gating, latency, interruption, privacy) | #503, #504 | `keiko-evaluations`                      |
| #506  | Harden voice production readiness; record closure evidence        | all above  | cross-cutting, docs, evidence            |

## 3. Write-ownership boundaries

To honor the Stop Condition "two parallel agents must not edit the same file scope", each issue owns a
**disjoint** primary scope:

- **Contracts (#493, #496)** own `packages/keiko-contracts/src/*` voice additions (capability flags/kind;
  control/replay protocol types). They are additive and must not bump
  `CONVERSATION_CAPABILITY_CONTRACT_VERSION` unless a new `ModelKind` is chosen (ADR-0058 D5).
- **Model Gateway (#493)** owns capability advertisement/selection wiring in
  `packages/keiko-model-gateway/src/*`.
- **BFF / server (#494, #497, #503)** own `packages/keiko-server/src/routes.ts` handlers and transport
  wiring; #503 **reuses** the governed-handoff path (`run-handlers.ts`, `governed-workflow.ts`) and must not
  fork it.
- **UI (#495, #501)** own `packages/keiko-ui/src/*` composer and playback surfaces.
- **Runtime mechanics (#498–#500, #502)** own their dedicated runtime modules; they must not edit transport or
  contracts owned by earlier issues.
- **Evidence / memory (#504)** own `packages/keiko-evidence/src/*` and `packages/keiko-memory-capture/src/*`
  voice helpers, reusing the redaction/hashing/sealing seams (ADR-0058 D6, privacy contract §3).
- **Evaluation (#505)** owns `packages/keiko-evaluations/*` harness fixtures.

## 4. Cross-cutting invariants every child issue must preserve

- Keiko remains fully usable with no voice model (ADR-0058 D1).
- Voice adds **no new authority**: spoken intent is untrusted input producing the existing governed
  `WorkflowHandoffRequest`; the single write path and scoped writer are reused, never bypassed
  ([architecture.md](architecture.md) §6).
- No external destinations except explicitly configured model endpoints
  ([privacy-contract.md](privacy-contract.md) §1).
- No new runtime media packages by default ([supply-chain-policy.md](supply-chain-policy.md)).
- Required GitHub check `ci` is green on every implementation PR; security review when the realtime media
  path, signaling, or provider credentials change ([privacy-contract.md](privacy-contract.md) §4).

## 5. Decisions explicitly deferred to later issues

- Whether voice capability is advertised via additive optional flags or a new `ModelKind` literal — **#493**
  (ADR-0058 D5).
- Whether to re-open a bidirectional WebSocket upgrade on the BFF (currently hard-rejected) — **#496/#497**
  (ADR-0058 D3).
- Whether to add an opt-in outbound destination host allowlist at the `gatewayFetch` boundary — a later
  hardening issue (ADR-0058 D4; [privacy-contract.md](privacy-contract.md) §1).
- Lifting the ADR-0048 D3 deferral of encryption-at-rest for customer-reconstructive artifacts, as it applies
  to voice reconstructive artifacts — **#504/#506**.

## 6. References

- [ADR-0058](../adr/ADR-0058-voice-digital-twin-capability-architecture.md);
  [architecture.md](architecture.md); [privacy-contract.md](privacy-contract.md);
  [deployment-profile-matrix.md](deployment-profile-matrix.md);
  [supply-chain-policy.md](supply-chain-policy.md).
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491) (child issue list and required order).
