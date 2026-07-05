# ADR-0110: Voice Digital Twin evaluation harness — capstone suite at the keiko-contracts boundary

> Renumbered from ADR-0068 on 2026-07-04 to resolve the 0058-0069 editor/voice numbering collision (Epic #491 voice series moved to 0100-0111).

## Status

Accepted (Issue #505, Epic #491, 2026-06-25)

## Context

ADR-0100 through ADR-0109 delivered the full Voice Digital Twin: capability metadata (#493), the BFF
STT dictation endpoint (#494), the composer dictation UX (#495), the wire protocol contract (#496),
realtime WebSocket/WebRTC transport (#497), the client timing engine (#498), the floor-control turn
manager (#499), transcript segment semantics (#500), assistant speech-output playback (#501),
discussion intelligence (#502), spoken-action intent governance (#503), and session recap (#504). Each
of those issues shipped its own narrow, self-contained evaluation suite (voice-action, discussion,
voice-recap).

Issue #505 is the **capstone**: it must provide a unified proof that the full surface is
high-quality when voice is available and genuinely harmless when it is not. Unlike the per-feature
suites, the capstone does not prove a single feature; it proves the **invariants that every feature
depends on** — capability gating, transport isolation, privacy bounding, and metric taxonomy — at the
contract level that all voice features import from.

The specific problem this harness must solve is:

1. **Six deployment profiles exist** ([`docs/voice/deployment-profile-matrix.md`](../voice/deployment-profile-matrix.md) §3),
   but no single suite exercises all six cells as a matrix.
2. **AC5 privacy** (no external destination except configured model endpoints) is enforced by reusing
   `gatewayFetch` and the capability-selection seam — not by a positive destination allowlist
   ([privacy-contract.md §1 "Honest limitation"](../voice/privacy-contract.md)). An evaluation must
   document what this bounding actually enforces and what it does not, and must provide a supply-chain
   denylist scan against [`docs/voice/supply-chain-policy.md`](../voice/supply-chain-policy.md) §1.
3. **AC6 metrics** (interruption, end-of-turn, transcript correction, provider-failure recovery, buffer
   boundedness) are derived from contract state machines, not from live model runs. These derivations need
   their own proof layer independent of the per-feature suites.
4. **CI-safety** is a firm requirement. The evaluation suite must be executable by every developer without a
   voice provider configured and must not introduce clock reads, randomness, network calls, or live model
   calls.
5. **Import boundary** (ADR-0019 rule 3l): `keiko-evaluations` may import `keiko-contracts`,
   `keiko-security`, `keiko-model-gateway`, `keiko-workspace`, `keiko-tools`, `keiko-harness`,
   `keiko-workflows`, `keiko-verification`, and `keiko-evidence`. It must **never** import `keiko-ui` or
   `keiko-server`. This means the voice runtime reducers (`voice-timebase.ts`, `voice-turn-manager.ts`,
   `voice-transcript-segments.ts`, `voice-playback-state.ts`) are off-limits in the harness. Those
   reducers are proven in their own keiko-ui suites (ADR-0103, ADR-0104, ADR-0105, ADR-0106).

The harness therefore operates at the **contract surface that all voice features import from**, proving
that the contracts themselves encode the right invariants.

P10 adds a companion deterministic acoustic-quality gate at
`packages/keiko-evaluations/src/voice-acoustic/` (namespace `VoiceAcousticEval`). This does not change
the contract-boundary purpose of `VoiceTwinEval`; it closes the prior "no numeric acoustic/wall-clock
gate" limitation for provider-free CI by scoring harness-authored transcript hypotheses and ordered
enum/timestamp traces. It still does not run a live WebRTC transport or capture audio.

## Decision

We will ship a self-contained, deterministic evaluation suite at
`packages/keiko-evaluations/src/voice-twin/` (namespace `VoiceTwinEval`) that proves the capability
and privacy contracts of the full Voice Digital Twin surface.

### D1 — Suite location at the keiko-contracts import boundary (not importing keiko-ui or keiko-server)

The suite lives in `packages/keiko-evaluations/src/voice-twin/` and imports exclusively from
`@oscharko-dev/keiko-contracts` (by package name, never by deep `src/` path). It does **not** import
`keiko-ui`, `keiko-server`, or any package not permitted by ADR-0019 rule 3l.

The rationale is structural, not stylistic. The runtime reducers (timing engine, turn manager,
transcript reducer, playback controller) live in `keiko-ui` because they hold reviewable content
(transcript text, audio metrics) and are tarball-excluded. The ADR-0019 boundary ensures the
evaluation layer remains a proof of the **contracts those reducers are built on**, not a reimplementation
of the reducers themselves. This is the correct division:

- keiko-ui suites prove that the runtime reducer behavior matches the contract transition tables.
- This harness proves that the contract transition tables encode the correct invariants end-to-end,
  across all deployment cells, with the correct privacy posture.

If a future change makes a reducer inconsistent with the contract it imports (e.g. a transition the
table permits but the reducer does not implement), the keiko-ui suite catches it. If the contract table
itself is wrong (e.g. allows a disallowed kind in a profile), this harness catches it. Both layers are
necessary; neither replaces the other.

**Honest limitation:** the harness does not detect runtime bugs in the timing engine, turn manager,
transcript reducer, or playback controller. Those bugs are the responsibility of their respective
keiko-ui suites (ADR-0103 §32 tests, ADR-0104 §44 tests, ADR-0105 §33 tests, ADR-0106 §28 tests).

### D2 — Profile × environment matrix as the organizing structure

The harness models the six deployment profiles from
[`docs/voice/deployment-profile-matrix.md`](../voice/deployment-profile-matrix.md) §3 as a product
of two orthogonal axes:

| Axis | Values |
| ---- | ------ |
| Capability axis (`VoiceProfile`) | `none`, `speech-to-text`, `speech-output`, `full-realtime` |
| Environment axis (`VoiceEnvironmentProfile`) | `azure-foundry`, `customer-hosted`, `no-voice-env` |

The harness encodes two rules derived from the matrix:

1. **Degradation rule**: when `env === "no-voice-env"`, `effectiveVoiceProfile(env, advertised)` returns
   `"none"` regardless of the advertised capability. When `env === "azure-foundry"` or
   `"customer-hosted"`, the effective profile equals the advertised capability.
2. **Egress rule**: `egressDestinationClassFor(effectiveProfile)` returns `"none"` when effective
   profile is `"none"`, and `"configured-model-endpoint"` for any active profile. The third class,
   `"unapproved-external"`, is a sentinel for adversarial fixtures only — it must never appear in a
   legitimate cell.

`profiles.ts` implements these two pure functions. `suite.test.ts` asserts that every environment ×
capability cell resolves to the expected effective profile and egress class as specified in the matrix.
A local `ALL_VOICE_PROFILES: readonly VoiceProfile[]` array is declared in `profiles.ts` and a test
asserts it equals the keys of `VOICE_PROFILE_MEDIA_TRANSPORT` so it never drifts from the contract.

**Drift risk**: if `docs/voice/deployment-profile-matrix.md` §3 is updated but
`effectiveVoiceProfile` is not, the suite test for every affected cell will fail. This is intentional:
the harness is the machine-checkable form of the matrix document.

### D3 — Eleven evaluation dimensions, each mapping to one or more Acceptance Criteria

The harness scores eleven named dimensions per fixture. Each dimension is a pure function over
contract-derived facts; `not-applicable` is the verdict for dimensions the fixture does not declare.

| Dimension | AC(s) | What it proves |
| --------- | ----- | -------------- |
| `capability-matrix-consistency` | AC1, AC2, AC3, AC4 | Cell facts equal the contract tables for the effective profile. |
| `no-voice-dormancy` | AC1, AC2 | Effective `none` ⟹ empty `allowedKinds`, `mediaTransport "none"`, `negotiation "disabled"`, `egressClass "none"`, playback not allowed, capture not allowed. |
| `stt-affordance-bounding` | AC3 | `speech-to-text` allows transcript kinds and excludes SDP/ICE/media/playback/interrupt kinds; `mediaTransport "gateway-batch"`; `negotiation "disabled"`. |
| `transport-plane-separation` | AC4 | `full-realtime`: `mediaTransport "webrtc"`, `negotiation "proxied-sdp"`, `VOICE_MEDIA_PLANE.plane "media"`, allowed kinds include SDP/media, control plane is loopback. |
| `external-destination-privacy` | AC5 | Positive fixtures: egress auditor returns `approved=true`. Adversarial fixtures (`privacy-negative`): auditor returns `approved=false` and oracle `expectedApproved=false`, so the dimension passes **because the auditor caught the violation**. |
| `interruption-metric` | AC6 | `deriveInterruptionMetric(profile)` matches oracle per profile. |
| `end-of-turn-metric` | AC6 | `deriveEndOfTurnMetric(profile)` matches oracle; committed projection excludes partial/stable. |
| `transcript-correction-metric` | AC6 | `deriveTranscriptCorrectionMetric()` confirms stable→corrected, committed→corrected transitions; corrected ∈ consumable states; superseded text not resurfaced. |
| `provider-failure-recovery-metric` | AC6 | `deriveProviderFailureRecoveryMetric(profile)` confirms provider-error is reviewable but not consumable; `"failed"` ∈ settled phases; recovery transition exists. |
| `buffer-boundedness-metric` | AC6 | `deriveBufferBoundednessMetric(kinds, VOICE_TWIN_REPLAY_CAPACITY)` — the scored dimension exercises eviction at the documented capacity 200 and asserts the ring fills **exactly** to capacity under overflow (a `≤ capacity` check alone would be self-referential), plus ephemeral-never-buffer. The constant is local, not imported, because the UI ring / server `MAX_REPLAY_EVENTS` packages are off-limits. |
| `latency-class-metric` | AC6 | `deriveLatencyClassMetric(profile)` maps the profile's media transport to a deterministic latency posture class (`none`→`none`, `gateway-batch`→`batch`, `webrtc`→`interactive-realtime`). Numeric wall-clock latency is out of the pure-harness boundary (see Consequences); this proves the posture the transport choice fixes. |

The dimension list is a `VoiceTwinDimension` union in `types.ts` with a companion `VOICE_TWIN_DIMENSIONS`
array. Adding a dimension without updating the array is a compile error. Two scorer-teeth corrections were
applied after adversarial review: `controlPlaneIsLoopback` is **derived** from `VOICE_CONTROL_TRANSPORTS`
(every control transport is a loopback transport) rather than a hardcoded literal, so a future non-loopback
control transport flips the `transport-plane-separation` dimension; and the buffer dimension runs at the
documented capacity with an exact-fill assertion.

**Rationale for eleven, not fewer.** Collapsing all AC6 metrics into a single dimension would produce a
single pass/fail that hides which metric failed. The six AC6 sub-dimensions are orthogonal (each
exercises a different state machine or bounded-data property); keeping them separate makes failures actionable.

### D4 — AC→dimension mapping is explicit and machine-checkable

```
AC1 (dormancy)              → no-voice-dormancy + capability-matrix-consistency
AC2 (STT-only gating)       → no-voice-dormancy + stt-affordance-bounding + capability-matrix-consistency
AC3 (STT affordances)       → stt-affordance-bounding + end-of-turn-metric + transcript-correction-metric
AC4 (transport separation)  → transport-plane-separation + capability-matrix-consistency
AC5 (privacy/egress)        → external-destination-privacy
AC6 (metrics)               → interruption-metric + end-of-turn-metric + transcript-correction-metric
                               + provider-failure-recovery-metric + buffer-boundedness-metric
```

`suite.test.ts` contains named tests for each AC (`AC1/AC2 no-voice`, `AC3 stt`, `AC4 full-realtime`,
`AC5 privacy`, `AC6 metrics`) so CI output maps failures to acceptance criteria without reading the
source.

### D5 — AC5 privacy strategy: bounding via contract transport tables + supply-chain denylist scan

Privacy enforcement has two distinct components:

**Component 1 — egress bounding via contract transport tables.**

`VOICE_PROFILE_MEDIA_TRANSPORT` and `VOICE_PROFILE_NEGOTIATION_MODE` (both from
`@oscharko-dev/keiko-contracts`) are the machine-readable encoding of the deployment-profile-matrix
§3 egress column. The harness asserts:

- For every `none`-effective cell: `mediaTransport === "none"`, `negotiation === "disabled"`,
  `egressClass === "none"`.
- For every active cell: `egressClass === "configured-model-endpoint"` (never `"unapproved-external"`).
- The `auditVoiceEgress(destinations)` function in `privacy.ts` returns `{ approved: false }` for any
  destination list containing `"unapproved-external"`, and `{ approved: true }` for `"none"` and
  `"configured-model-endpoint"` lists. This gives the `external-destination-privacy` dimension teeth:
  adversarial fixtures with `"unapproved-external"` entries must score as caught violations, not as
  unexpected passes.

**Component 2 — supply-chain denylist scan.**

`DENIED_MEDIA_PACKAGES` in `privacy.ts` is the exact list from
[`docs/voice/supply-chain-policy.md`](../voice/supply-chain-policy.md) §1: `socket.io`,
`socket.io-client`, `simple-peer`, `peerjs`, `mediasoup`, `livekit`, `livekit-server-sdk`, `wrtc`,
`node-webrtc`, `janus`, `kurento`, `jitsi`, `agora`, `twilio`, `@daily-co`, `opentok`, `sip.js`,
`jssip`. `ALLOWED_MEDIA_RUNTIME = ["ws"]` (the only admitted runtime package).

`scanManifestsForDeniedMediaPackages(manifests)` is a **pure** function over provided manifest data.
The real-repo scan (reading `packages/*/package.json` via `fs`) lives in `privacy.test.ts` and
`suite.test.ts` — test files may do IO. The pure function is separately tested with adversarial
synthetic manifests to confirm a denied package flips `clean=false`.

**Honest limitation (recorded from `privacy-contract.md` §1).**

The bounding is one-directional: it proves no denied package is present and that no profile directs
traffic to an `"unapproved-external"` destination. It does **not** provide a positive destination
allowlist. `gatewayFetch` will fetch any configured base URL; `validateBaseUrl` intentionally does not
restrict host/IP because private RFC-1918 endpoints are first-class in customer-hosted deployments. A
future opt-in egress policy layer at the `gatewayFetch` boundary (named in ADR-0100 D4) could provide
a positive allowlist, but that is a separate decision not made here. The harness documents this gap in
its `render.ts` output so operators are not misled.

### D6 — AC6 metric strategy: contract state machines + pure bounded-FIFO model

All six AC6 metrics are derived from the same typed contract state machines that the runtime reducers
use. The harness does not execute the reducers (off-limits); it proves the contract tables are correct.

| Metric | Contract surface used |
| ------ | --------------------- |
| Interruption | `voicePlaybackInterruptAllowedForProfile`, `canTransitionVoicePlayback("speaking","interrupted")` |
| End-of-turn | `voiceMessageAllowedForProfile`, `voiceTranscriptCaptureAllowed`, `selectCommittedVoiceTranscript` |
| Transcript correction | `VOICE_TRANSCRIPT_SEGMENT_TRANSITIONS` (stable→corrected, committed→corrected), `VOICE_TRANSCRIPT_CONSUMABLE_STATES`, `selectCommittedVoiceTranscript` |
| Provider-failure recovery | `VOICE_TRANSCRIPT_CONSUMABLE_STATES` (provider-error absent), `VOICE_PLAYBACK_SETTLED_PHASES`, `VOICE_PLAYBACK_TRANSITIONS` |
| Buffer boundedness | Pure ring model, `isVoiceReplayEligible`, `VOICE_TWIN_REPLAY_CAPACITY = 200` |

`VOICE_TWIN_REPLAY_CAPACITY = 200` is a local constant in `metrics.ts`. Its value mirrors the
`MAX_REPLAY_EVENTS` ring in `keiko-server/src/voice-realtime.ts` and the 200-slot ring in
`keiko-ui/src/app/components/desktop/hooks/voice-timebase.ts`. It is **not imported** from those
packages (import boundary, D1). The doc comment records the mirror relationship so a future change to
the UI/server ring that does not update this constant will be immediately visible in review.

`deriveBufferBoundednessMetric(kinds, capacity)` pushes a caller-supplied list of control-message kinds
through a fixed-capacity ring: only kinds for which `isVoiceReplayEligible(kind)` returns `true` are
admitted; ephemeral kinds are dropped without buffering; when the ring is full, the oldest entry is
evicted. The function returns `{ maxObservedLength, capacityRespected, ephemeralNeverBuffered,
overflowEvictsOldest }`. All four booleans are asserted `true` by the fixture oracle.

### D7 — CI-safety: pure, deterministic, no live model, no clock, no network

Every production source file in `voice-twin/` is a pure function over its inputs. No production file
calls `Date.now()`, `performance.now()`, `Math.random()`, `fetch`, `fs.*`, or any async IO. Production
files may not import Node built-ins except `node:path` for type-only usage.

The **only** permitted IO is reading `packages/*/package.json` manifests for the real-repo
supply-chain scan, and that IO is confined to `.test.ts` files. Test files are exempt from this
constraint by the `packages/keiko-evaluations` test configuration.

`runVoiceTwinEvaluation(fixtures)` returns the same `VoiceTwinScorecard` given the same fixtures on
every invocation. `suite.test.ts` asserts this with a two-run deep-equal check. No fixture may contain
a clock seed, a random seed, or any IO dependency.

`VOICE_TWIN_EVAL_SCHEMA_VERSION = "1"` evolves by the immutable rule established across prior voice
contracts: a breaking change introduces a new literal member, never a mutation of `"1"`.

### D8 — Content-free invariant throughout

Every type, constant, fixture, oracle, and scorecard field is content-free: closed-vocabulary enum
labels, booleans, integers, or counts. The suite never echoes raw transcript text, SDP strings, ICE
candidates, audio buffers, provider URLs, model IDs, or fixture opaque IDs in rationale strings.

This invariant is testable by module scanning: `suite.test.ts` asserts no rationale field in the
scorecard contains characters that suggest raw content (the same pattern voice-action and voice-recap
suites use). The `not.toContain("/")` path-check pattern from ADR-0057 is extended to cover rationale
strings here.

### D9 — Fixture coverage requirement enforced by suite.test.ts

`runVoiceTwinEvaluation()` computes six coverage flags on the scorecard:
`coversNoVoice`, `coversSttOnly`, `coversFullRealtime`, `coversAzureFoundry`,
`coversCustomerHosted`, `coversPrivacyNegative`. `suite.test.ts` asserts all six are `true` and that
every environment × capability cell is covered at least once. Coverage of a cell requires at least one
fixture with that `(env, advertisedProfile)` pair and a passing result. The `privacy-negative`
fixtures must exist and must produce `external-destination-privacy` results where `caught = true`.

### D10 — Barrel registration follows established namespace convention

`packages/keiko-evaluations/src/index.ts` exposes voice evaluation suites as additive namespaces:

```typescript
export * as VoiceTwinEval from "./voice-twin/index.js";
export * as VoiceAcousticEval from "./voice-acoustic/index.js";
```

This follows the `PromptEnhancerEval`, `DiscussionEval`, and `VoiceTwinEval` namespace pattern. No
existing barrel export is modified.

### D11 — Offline acoustic companion gate for numeric budgets

`VoiceAcousticEval` is a pure, deterministic fixture suite with schema version `"1"`. Its fixture
registry covers exactly these scenarios: `first-word`, `trailing-word`, `noisy-room`, `laptop-echo`,
`headset`, `fast-interrupt`, `long-pause`, `unfinished-utterance`, `exact-identifiers`, and
`grounded-vs-casual`.

Fixtures store only harness-authored reference transcripts, hypothesis transcripts, ordered trace
events, acoustic-profile labels, required terms, and numeric budgets. They do not store real user audio,
provider credentials, provider URLs, raw provider event bodies, or production transcripts. The scorecard
reports only fixture/scenario labels, pass/fail states, counts, and numeric metrics.

The gate scores WER, CER, first-token retention, last-token retention, exact required-identifier match,
first-partial latency, final-transcript latency, time-to-first-assistant-audio, local barge-in duck
latency, interrupt ack latency, premature finalization, and grounded-tool-before-answer ordering.
Default thresholds are `maxWer=0.08`, `maxCer=0.04`, `maxFirstPartialMs=1200`,
`maxFinalTranscriptMs=4000`, `maxTtfaMs=4000`, `maxLocalDuckMs=80`, and
`maxInterruptAckMs=500`; `noisy-room` and `laptop-echo` relax to `maxWer=0.15`, `maxCer=0.08`, and
`maxFirstPartialMs=1800`.

`runVoiceAcousticEvaluation()` returns `GO` only when every positive fixture passes, every requested
scenario is covered by the positive set, and every adversarial negative fixture is caught. The targeted
local gate is:

```bash
npm run eval:voice-acoustic
```

## Consequences

### Positive

- The six deployment profiles from `docs/voice/deployment-profile-matrix.md` §3 are now
  machine-checkable: any change to the matrix document that is not reflected in `profiles.ts` will
  fail suite tests for the affected cells.
- All six AC6 metrics are provable without a live voice session or a running model, enabling every
  developer to verify metric correctness in under 30 seconds (`npx vitest run packages/keiko-evaluations/src/voice-twin`).
- The supply-chain denylist scan in `privacy.test.ts` will catch a newly introduced denied media
  package before it reaches CI.
- The adversarial `privacy-negative` fixtures provide teeth to `external-destination-privacy`:
  the suite confirms the auditor correctly rejects violations, not merely that it passes on clean data.
- Determinism is structurally guaranteed: every production source file is a pure function over inputs;
  no hidden IO path can make the suite non-deterministic.
- The 11-dimension structure maps 1:1 to acceptance criteria; CI failures are immediately actionable
  without reading source.
- The offline `VoiceAcousticEval` companion gate adds numeric acoustic-budget coverage without a live
  provider: first/last token retention, exact identifiers, WER/CER, partial/final latency, TTFA,
  barge-in, endpointing, and grounded-ordering regressions now produce a CI-blocking NO-GO verdict.

### Negative

- The harness does not prove runtime reducer behavior. A bug in `voice-timebase.ts`,
  `voice-turn-manager.ts`, `voice-transcript-segments.ts`, or `voice-playback-state.ts` that does not
  violate a contract invariant will pass all eleven dimensions. Runtime reducer correctness remains the
  sole responsibility of their keiko-ui suites.
- `VOICE_TWIN_REPLAY_CAPACITY = 200` is a local constant that must be kept in sync with
  `MAX_REPLAY_EVENTS` in `keiko-server` and the 200-slot ring in `keiko-ui`. The import boundary (D1)
  prevents a compile-time link; a doc comment and a code review note are the only enforcement.
- The supply-chain denylist scan covers only packages listed in `docs/voice/supply-chain-policy.md` §1.
  A new class of runtime media package not on that list would not be flagged until the policy document
  is updated.
- The absence of a positive egress allowlist (D5 honest limitation) means AC5 bounding is incomplete
  for deployments that require positive destination denial. This is a pre-existing gap in the
  architecture, not introduced by this ADR; the harness makes it visible rather than obscuring it.
- `VoiceAcousticEval` is not a live acoustic lab or live WebRTC wall-clock measurement. It scores
  deterministic fixture traces, not real microphones, real speakers, provider jitter, packet loss,
  browser echo-canceller behavior, or production audio. Live/provider evaluation remains a separate
  production-readiness activity.

### Neutral

- The `VoiceEnvironmentProfile` type and `VOICE_ENVIRONMENT_PROFILES` array are local to the harness;
  they do not enter `keiko-contracts`. This is intentional: the environment axis is a deployment
  concern, not a runtime protocol concern. The capability axis (`VoiceProfile`) is already in
  `keiko-contracts`.
- Adding a new `VoiceProfile` literal to the contract will cause the `ALL_VOICE_PROFILES` test to fail
  immediately (the test asserts equality with `Object.keys(VOICE_PROFILE_MEDIA_TRANSPORT)`), prompting
  harness updates before the change can land.
- The `privacy-negative` fixture pattern (adversarial expected-violation fixtures that prove the
  auditor has teeth) mirrors the `voice-action/` suite pattern; it is not a new idiom.

## Alternatives Considered

### Alternative 1: Place the capstone suite in keiko-ui alongside the runtime reducers

Co-locate `voice-twin/` in `keiko-ui` so it has direct access to `voice-timebase.ts`,
`voice-turn-manager.ts`, and other runtime reducers.

- **Pros**: the suite could import and exercise reducer behavior directly; no import workaround needed
  for `VOICE_TWIN_REPLAY_CAPACITY`.
- **Cons**: violates ADR-0019 rule 3l (keiko-evaluations must not import keiko-ui, and keiko-ui
  evaluations living inside keiko-ui would not be in keiko-evaluations). A suite that imports runtime
  reducers would also re-test what the keiko-ui suites already cover, producing redundancy without
  additional coverage at the contract layer. The capstone's purpose is to prove that the **contracts**
  the reducers consume are correct, not to re-exercise the reducers.
- **Why rejected**: ADR-0019 rule 3l is a hard rule enforced by `arch:check`. The capstone proves a
  different layer than the reducer suites; placing it alongside reducers would blur that distinction.

### Alternative 2: A single umbrella dimension ("voice-digital-twin") instead of eleven dimensions

Collapse all acceptance criteria into a single pass/fail dimension.

- **Pros**: simpler scorecard; fewer types to define.
- **Cons**: a single failure in AC6 buffer boundedness produces the same verdict as a failure in AC1
  dormancy; the failing AC is invisible without reading the source. The whole value of a scorecard is
  actionable failure attribution.
- **Why rejected**: the dimension-per-AC structure is the established pattern in `discussion/`,
  `voice-action/`, and `voice-recap/`. Diverging from it for the capstone would make the capstone
  harder to read in context.

### Alternative 3: Live integration test with a mock voice provider

Spin up a mock `RTCPeerConnection` and mock STT server in `suite.test.ts` and exercise the full
request/response cycle.

- **Pros**: proves end-to-end behavior including transport; catches bugs the contract-only harness
  cannot.
- **Cons**: introduces a test server, async timing, and a network-like environment — all of which
  violate the CI-safety requirement (D7). A mock provider that differs from a real provider gives false
  confidence. The per-feature suites (keiko-ui, keiko-server) already test the HTTP/WebSocket exchange
  with request mocks.
- **Why rejected**: CI-safety is a firm constraint. A mock-server integration test is appropriate for
  transport tests (already in keiko-server's voice-realtime suite), not for the capstone that must be
  purely deterministic.

### Alternative 4: Generate the fixture matrix programmatically from the deployment-profile-matrix document

Parse `docs/voice/deployment-profile-matrix.md` at test time and auto-generate fixture cells.

- **Pros**: matrix changes automatically propagate to fixtures.
- **Cons**: fixture generation from a Markdown table is fragile (parser errors silence fixtures
  silently). Explicit fixture files are auditable; generated fixtures are not. A fixture file with an
  intentional adversarial cell (privacy-negative) cannot be derived from the matrix document.
- **Why rejected**: explicit fixture files are the established pattern across all evaluation suites.
  The `ALL_VOICE_PROFILES` test (D2) already provides mechanical drift detection for the key cell rule.

## Related

- [ADR-0100](ADR-0100-voice-digital-twin-capability-architecture.md) — architecture baseline;
  capability-gating principle; privacy contract; supply-chain policy.
- [ADR-0101](ADR-0101-voice-control-media-capability-replay-protocol.md) — wire protocol contract;
  `VOICE_PROFILE_ALLOWED_MESSAGE_KINDS`; `VoiceReplayClass`; `VOICE_CONTROL_MESSAGE_REPLAY`.
- [ADR-0102](ADR-0102-realtime-voice-transport.md) — server control plane; `MAX_REPLAY_EVENTS = 200`
  ring (mirrored by `VOICE_TWIN_REPLAY_CAPACITY`).
- [ADR-0103](ADR-0103-voice-timing-engine.md) — client timing engine; 200-slot ring (also mirrored);
  keiko-ui runtime suite (32 tests).
- [ADR-0104](ADR-0104-voice-turn-manager.md) — floor-control turn manager; capability-predicate pattern;
  keiko-ui runtime suite (44 tests).
- [ADR-0105](ADR-0105-voice-transcript-segment-semantics.md) — transcript segment lifecycle;
  `selectCommittedVoiceTranscript`; `VOICE_TRANSCRIPT_SEGMENT_TRANSITIONS`; keiko-ui runtime suite (33 tests).
- [ADR-0106](ADR-0106-voice-assistant-speech-output-playback.md) — playback phases;
  `VOICE_PLAYBACK_TRANSITIONS`; `canTransitionVoicePlayback`; keiko-ui runtime suite (28 tests).
- [ADR-0108](ADR-0108-voice-spoken-action-governance.md) — adversarial fixture pattern (expected-violation
  fixtures prove auditor teeth); mirror of privacy-negative fixture design.
- [ADR-0109](ADR-0109-voice-session-recap.md) — session recap evaluation suite pattern; content-free
  module scanning.
- [ADR-0019](ADR-0019-modular-package-architecture.md) — rule 3l: keiko-evaluations import boundary.
- [`docs/voice/deployment-profile-matrix.md`](../voice/deployment-profile-matrix.md) — the normative
  deployment matrix §3 encoded as executable assertions.
- [`docs/voice/supply-chain-policy.md`](../voice/supply-chain-policy.md) — §1 denylist encoded in
  `DENIED_MEDIA_PACKAGES`.
- [`docs/voice/privacy-contract.md`](../voice/privacy-contract.md) — §1 honest limitation (no positive
  allowlist) documented in D5.
- [`packages/keiko-evaluations/src/voice-twin/`](../../packages/keiko-evaluations/src/voice-twin/) —
  the suite (types, profiles, capability, privacy, metrics, runner, scorer, render, fixtures, index).
- [`packages/keiko-evaluations/src/index.ts`](../../packages/keiko-evaluations/src/index.ts) — barrel
  registration: `export * as VoiceTwinEval from "./voice-twin/index.js"`.
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491), Issue
  [#505](https://github.com/oscharko-dev/Keiko/issues/505).

## Date

2026-06-25
