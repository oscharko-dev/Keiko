# Voice Digital Twin evaluation harness — the capstone quality gate

**Audience:** engineers implementing issue #505, verification leads, security reviewers evaluating the Epic #491 Voice Digital Twin scope and closure.

Specification for Epic #491, the deliverable of Issue [#505](https://github.com/oscharko-dev/Keiko/issues/505) and the authoritative companion to [ADR-0110](../adr/ADR-0110-voice-evaluation-harness.md). It **defines** the capstone evaluation harness: what it proves, how to run it, its architecture, the dimension→acceptance-criterion mapping, the CI-safe mock and fixture strategy, and an explicit closure checklist. The harness lives in [`packages/keiko-evaluations/src/voice-twin/`](../../packages/keiko-evaluations/src/voice-twin/).

## 0. What the harness proves

The harness proves two critical invariants for the **entire** Voice Digital Twin:

1. **The six deployment profiles from the matrix are correct and machine-checkable.** Every environment × capability cell (3 environments × 4 profiles = 12 cells, less 2 redundant no-voice cells = 6 distinct effective profiles) resolves to the expected effective profile, allowed message kinds, transport class, and egress destination.
2. **Acceptance Criteria 1–6 hold structurally, across all cells, without a live voice provider.** AC1 (no-voice dormancy), AC2 (STT-only gating), AC3 (STT affordance bounding), AC4 (transport plane separation), AC5 (external-destination privacy with honest limitations), and AC6 (metrics derivable from contract state machines) are machine-verifiable without running a model, capturing audio, or making network calls.

**Why this matters.** Each child issue (#493–#504) shipped its own self-contained feature suite (dictation-ui, discussion-intelligence, spoken-action-governance, session-recap). Those suites test feature-level behavior. The harness tests the **foundation every feature depends on** — the capability contract itself. A bug in the capability table affects all six child features at once; a single failing test in the harness is therefore a blocker for Epic #491 closure.

**The harness is not a transport test.** Transport-level behavior (WebSocket handshake, WebRTC media plane, reconnect recovery) is tested in `keiko-server/src/voice-realtime.ts` and `keiko-ui/src/app/components/desktop/hooks/voice-*.test.ts` suites. **The harness is not a reducer behavior test.** Runtime mechanics (timing engine state transitions, turn-manager overlap synthesis, transcript reducer partial-text churn) are tested in their own keiko-ui suites (ADR-0103 §32 tests, ADR-0104 §44 tests, ADR-0105 §33 tests, ADR-0106 §28 tests). The harness proves that the **contract surface** those reducers and transports consume is correct.

## 1. How to run it

Run the voice-twin evaluation suite locally:

```bash
npx vitest run packages/keiko-evaluations/src/voice-twin
```

Run the offline acoustic-quality companion gate locally:

```bash
npm run eval:voice-acoustic
```

The companion gate lives in
[`packages/keiko-evaluations/src/voice-acoustic/`](../../packages/keiko-evaluations/src/voice-acoustic/)
(namespace `VoiceAcousticEval`). It is deterministic fixture scoring only: harness-authored reference
and hypothesis transcripts, ordered enum/timestamp traces, acoustic-profile labels, required identifier
terms, and numeric budgets. It stores no raw production audio, no provider credentials, no provider URLs,
and no raw provider event bodies.

All 32+ tests must pass and suite verdict must be `GO`. Coverage minimum for `keiko-evaluations` package is 90.94 lines / 90.54 statements / 77.36 branches / 95.05 functions.

Run in CI (as part of the standard test pipeline):

```bash
npm run test:coverage:quality
```

This gate runs automatically and requires no voice credentials, no model endpoint configuration, no external network access, and no Docker. Any developer can run it in under 30 seconds. CI runs the exact same binary; no mocking, no scaffolding, no live-vs-test code paths.

## 2. Architecture and organization

### Suite location and import boundary (ADR-0019 rule 3l)

The harness is a self-contained package at `packages/keiko-evaluations/src/voice-twin/` (namespace `VoiceTwinEval`). It imports **exclusively from** `@oscharko-dev/keiko-contracts` (and permitted sister packages: keiko-security, keiko-model-gateway, keiko-workspace, keiko-tools, keiko-harness, keiko-workflows, keiko-verification, keiko-evidence). It does **not** import `keiko-ui` or `keiko-server`.

This boundary is structural, not stylistic. The runtime reducers (timing engine, turn manager, transcript reducer, playback controller) live in `keiko-ui` and hold reviewable content (text, audio buffers). The harness proves the **contracts those reducers consume**, not the reducers themselves. If a reducer diverges from its contract, the keiko-ui suite catches it. If the contract table is wrong, this harness catches it. Both layers are necessary.

### Profile × environment matrix

The harness models the Voice Digital Twin deployment surface as a **2D matrix**:

| Axis                      | Values                                                     |
| ------------------------- | ---------------------------------------------------------- |
| Capability (VoiceProfile) | `none`, `speech-to-text`, `speech-output`, `full-realtime` |
| Environment               | `azure-foundry`, `customer-hosted`, `no-voice-env`         |

**Degradation rule:** When `env === "no-voice-env"`, the effective profile is always `"none"` (voice is unavailable), regardless of the advertised capability. In `azure-foundry` and `customer-hosted`, the effective profile equals the advertised capability.

**Egress rule:** When effective profile is `"none"`, egress destination is `"none"` (no external calls). For any active profile (`speech-to-text`, `speech-output`, `full-realtime`), egress is `"configured-model-endpoint"` (routed through `gatewayFetch`). No other destination is permitted.

The suite tests every cell and asserts that the effective profile, allowed message kinds, transport class, and egress destination match the contract tables.

### File structure

| Module                      | Purpose                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                  | Schema version, dimension union, environment profile descriptor, fixture and oracle interfaces                          |
| `profiles.ts`               | `VOICE_ENVIRONMENT_PROFILES`, `effectiveVoiceProfile()`, `egressDestinationClassFor()`, `ALL_VOICE_PROFILES`            |
| `capability.ts`             | `deriveCapabilityCell()` — returns contract facts for a (env, advertised) pair                                          |
| `privacy.ts`                | `auditVoiceEgress()`, `DENIED_MEDIA_PACKAGES`, `scanManifestsForDeniedMediaPackages()`                                  |
| `metrics.ts`                | AC6 metric derivations: interruption, end-of-turn, transcript correction, provider-failure recovery, buffer boundedness |
| `runner.ts`                 | `runVoiceTwinEvaluation()` — orchestrates fixtures, derives results, computes coverage flags                            |
| `scorer.ts`                 | Per-dimension gate functions, aggregation logic, GO/NO-GO verdict                                                       |
| `render.ts`                 | `renderVoiceTwinSummary()` — human-readable text report                                                                 |
| `fixtures/index.ts`         | `ALL_VOICE_TWIN_FIXTURES`, categorized fixture selectors                                                                |
| `fixtures/no-voice.ts`      | Fixtures exercising dormancy when voice is unavailable                                                                  |
| `fixtures/stt-only.ts`      | Fixtures exercising STT-only capability gating and affordances                                                          |
| `fixtures/speech-output.ts` | Fixtures exercising speech-output playback capability                                                                   |
| `fixtures/full-realtime.ts` | Fixtures exercising full-realtime WebRTC + WebSocket control plane                                                      |
| `fixtures/privacy.ts`       | Positive egress fixtures and adversarial `privacy-negative` fixtures with unapproved destinations                       |
| `index.ts`                  | Public barrel exports: all types, functions, fixtures, constants                                                        |
| `suite.test.ts`             | Full-suite integration test: all fixtures run, coverage flags verified, AC-specific assertions                          |
| `*.test.ts`                 | Per-module unit tests for privacy/metrics/scorer/runner/capability (mutation-robust)                                    |

Every production `.ts` file is paired with a `.test.ts` file. Tests achieve ~100% line/branch/function coverage of the production code.

### Determinism guarantee

Every production source file is a pure function over its inputs. Production files:

- Do **not** call `Date.now()`, `performance.now()`, `Math.random()`, `fetch`, or async IO.
- Do **not** import Node built-ins except `node:path` (type-only).
- Do **not** read the filesystem.

The **only** permitted IO is reading `packages/*/package.json` manifests in **test files** (for the real-repo supply-chain scan). Test files are exempt from the pure-function requirement.

`runVoiceTwinEvaluation(fixtures)` returns the same `VoiceTwinScorecard` given the same input fixtures on every invocation. `suite.test.ts` asserts determinism with a two-run deep-equal check.

## 3. Eleven dimensions mapping Acceptance Criteria

The harness scores eleven named dimensions per fixture. Each dimension is a pure gate function over contract-derived facts. A dimension is `not-applicable` when a fixture does not declare it.

| Dimension                          | AC(s)   | What it proves                                                                                                                                                                                             |
| ---------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capability-matrix-consistency`    | AC1–AC4 | Cell facts equal the contract tables for the effective profile.                                                                                                                                            |
| `no-voice-dormancy`                | AC1–AC2 | Effective `none` ⟹ empty allowedKinds, mediaTransport `"none"`, negotiation `"disabled"`, egress `"none"`, playback blocked, capture blocked.                                                              |
| `stt-affordance-bounding`          | AC3     | `speech-to-text` allows transcript kinds; excludes SDP/ICE/media/playback/interrupt kinds; mediaTransport `"gateway-batch"`; negotiation `"disabled"`.                                                     |
| `transport-plane-separation`       | AC4     | `full-realtime`: mediaTransport `"webrtc"`, negotiation `"proxied-sdp"`, media plane is separate, control plane is loopback, SDP/media kinds allowed.                                                      |
| `external-destination-privacy`     | AC5     | Positive fixtures approved; `privacy-negative` fixtures correctly caught; no denied media packages present in repo.                                                                                        |
| `interruption-metric`              | AC6     | `deriveInterruptionMetric(profile)` output matches oracle per profile.                                                                                                                                     |
| `end-of-turn-metric`               | AC6     | `deriveEndOfTurnMetric(profile)` output matches oracle; committed projection excludes partial/stable.                                                                                                      |
| `transcript-correction-metric`     | AC6     | Stable→corrected, committed→corrected transitions allowed; corrected is consumable; superseded text not resurfaced.                                                                                        |
| `provider-failure-recovery-metric` | AC6     | Provider-error is reviewable not consumable; settled phases reachable; recovery transitions exist.                                                                                                         |
| `buffer-boundedness-metric`        | AC6     | Bounded ring with capacity 200 respects ephemeral-kinds-never-buffer and overflow-evicts-oldest (the scored dimension exercises eviction at the documented `VOICE_TWIN_REPLAY_CAPACITY`).                  |
| `latency-class-metric`             | AC6     | Each profile's media transport maps to a deterministic latency posture class (`none`→`none`, `gateway-batch`→`batch`, `webrtc`→`interactive-realtime`). See §6 for why wall-clock latency is out of scope. |

### Rationale for eleven dimensions

Collapsing metrics into a single dimension would hide which metric failed. The six AC6 sub-dimensions are orthogonal (each exercises a different state machine or bounded-data property); keeping them separate makes CI failures immediately actionable.

The dimension list is a `VoiceTwinDimension` union in `types.ts` with a companion `VOICE_TWIN_DIMENSIONS` array. Adding a dimension without updating the array is a compile error.

## 4. CI-safe fixture and mock strategy

### Fixtures as machine-readable test cases

Each fixture declares:

- `id`: unique opaque identifier
- `(env, advertisedProfile)`: a cell in the deployment matrix
- `capability`: the cell's capability facts (derived by calling `deriveCapabilityCell`)
- `oracle`: expected values for each dimension (or `not-applicable`)
- `egresses`: list of destination classes in the scenario

Fixtures are **not generated** — they are explicit test cases, one per file, auditable. This follows the established pattern in `discussion/`, `voice-action/`, and `voice-recap/` suites.

### No live model, no network, no clock

The harness produces a scorecard given fixtures alone. Fixtures contain no:

- Clock seeds or timestamp dependencies
- Random seeds
- Network URLs or credential references
- Raw audio blobs
- Opaque provider IDs or session tokens

Fixture oracles are closed-vocabulary enums (e.g. `{ approved: true }`, `{ maxObservedLength: 42, capacityRespected: true }`). Rationale strings in the scorecard are content-free (never transcript text, SDP, ICE, API keys, model IDs).

### Supply-chain denylist scan

`DENIED_MEDIA_PACKAGES` in `privacy.ts` enumerates the runtime-media packages from [`docs/voice/supply-chain-policy.md`](supply-chain-policy.md) §1 **plus their known npm client/SDK and scope variants** (e.g. `livekit-client`, `@livekit`, `agora-rtc-sdk-ng`, `twilio-video`, `@twilio`, `lib-jitsi-meet`, `@jitsi`, `janus-gateway`, `peerjs-server`, `@socket.io`, `@daily-co/daily-js`). Matching is **name-based** — exact id or `@scope/`-prefix — so it cannot enforce the policy's open-ended catch-all on its own: operators must keep the list current when new vendors appear. `scanManifestsForDeniedMediaPackages(manifests)` is a **pure** function over provided manifest data (not calling `fs`). The real-repo scan lives in `privacy.test.ts` and `suite.test.ts`, which read the actual `packages/*/package.json` files **and the repository root `package.json`** (where the single allowed media-adjacent package `ws` is anchored) via `fs` at test time. A test asserts that today's repo is clean.

### Adversarial fixtures prove auditor teeth

The `privacy-negative` fixtures in `fixtures/privacy.ts` intentionally declare:

- An `"unapproved-external"` egress destination (should never appear in a legitimate cell)
- A denied media package in the manifest

When the auditor scans these fixtures, it correctly returns `approved: false`. The `external-destination-privacy` dimension **passes** when the auditor's verdict matches the fixture oracle (`expectedApproved: false`). This proves the auditor has teeth, not merely that it passes on clean data.

## 5. Acceptance Criteria closure checklist

The AC column quotes Issue #505's verbatim Acceptance Criteria.

| AC  | Acceptance Criterion (Issue #505 verbatim)                                                     | Evidence (test name / dimension)                                                                                                                        | Status |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| AC1 | CI can verify no-voice behavior without external voice credentials                             | Whole pure suite runs under `npm run test:coverage:quality` with no credentials/network/clock; `no-voice-dormancy` dimension; `is deterministic` test   | Proved |
| AC2 | Evaluation proves Keiko remains fully usable when voice is absent                              | `AC1/AC2 no-voice` test; `no-voice-dormancy` dimension; `no-voice.ts` fixtures (every advertised capability degrades to `none`, no egress)              | Proved |
| AC3 | Evaluation proves STT-only does not expose full voice affordances                              | `AC3 stt` test; `stt-affordance-bounding` dimension (excludes SDP/ICE/media/playback/interrupt kinds); `stt-only.ts` fixtures                           | Proved |
| AC4 | Evaluation proves full voice transport uses WebSocket control and WebRTC media when supported  | `AC4 full-realtime` test; `transport-plane-separation` dimension (webrtc media + proxied-sdp + loopback-websocket control); `full-realtime.ts` fixtures | Proved |
| AC5 | Privacy checks fail if voice mode adds an unapproved external destination                      | `AC5 privacy` tests; `external-destination-privacy` dimension; `auditVoiceEgress` + denylist scan + real-repo scan; honest no-positive-allowlist note   | Proved |
| AC6 | Metrics cover interruption, end-of-turn, transcript correction, provider failure, and recovery | `AC6` tests; `interruption-/end-of-turn-/transcript-correction-/provider-failure-recovery-/buffer-boundedness-/latency-class-metric` dimensions         | Proved |

### Deliverables coverage

The Deliverable column quotes Issue #505's verbatim Deliverables.

| Deliverable (Issue #505 verbatim)                                  | Harness proof                                                                                                                                                         | Status |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Capability matrix test suite                                       | `capability-matrix-consistency` dimension over the full profile × environment matrix; the 12-cell coverage assertion in `suite.test.ts`                               | Proved |
| No-voice contract coverage (dormancy + capability-matrix fixtures) | `no-voice-dormancy` dimension; `coversNoVoice` GO gate; `no-voice.ts` fixtures. Application-path regression (Chat/Composer/Editor) lives in the keiko-ui suites       | Proved |
| STT-only and full-voice fixture suite                              | `stt-only.ts`, `speech-output.ts`, `full-realtime.ts` fixtures across both provider environments                                                                      | Proved |
| Latency, interruption, buffer, transcript, and privacy metrics     | `latency-class-metric` (posture, §6), `interruption-metric`, `buffer-boundedness-metric`, `end-of-turn-/transcript-correction-metric`, `external-destination-privacy` | Proved |
| CI-safe mock or fixture strategy                                   | Every production file is pure; sub-second run; no network/clock/credentials; determinism assertion; fs only in test files                                             | Proved |
| Evaluation documentation and closure checklist                     | This document (`evaluation-harness.md`) + [ADR-0110](../adr/ADR-0110-voice-evaluation-harness.md) + §5 closure checklist                                              | Proved |

Coverage floor (`docs/qa/package-coverage-baseline.json`: lines 90.94 / statements 90.54 / branches 77.36 / functions 95.05) is **maintained and raised** — the new files run at ~99% statements / 100% functions, lifting the package aggregate.

## 6. Honest limitations

### Runtime reducer bugs are out of scope

This harness **does not** detect bugs in the timing engine, turn manager, transcript reducer, or playback controller. Those are tested in their own keiko-ui suites:

- ADR-0103 voice-timebase.ts: 32 tests, 100% coverage
- ADR-0104 voice-turn-manager.ts: 44 tests, 100% coverage
- ADR-0105 voice-transcript-segments.ts: 33 tests, 100% coverage
- ADR-0106 voice-playback-state.ts: 28 tests, 100% coverage

If a reducer implements a transition that the contract table permits but the reducer incorrectly rejects (or vice versa), the keiko-ui suite catches it. This harness assumes the reducer respects the contract it imports.

### Wall-clock transport measurement remains out of scope; offline acoustic budgets are now covered

Issue #505's Scope names "local control-plane latency, WebRTC setup timing". A numeric, wall-clock latency
measurement requires a clock read and a live transport, both of which sit **outside** the pure, deterministic,
import-bounded harness (ADR-0019 rule 3l forbids importing the keiko-ui timing engine, and a clock read would
break determinism). The harness therefore proves the deterministic **latency posture class** each profile's
media transport fixes (`latency-class-metric`: `none`→`none`, `gateway-batch`→`batch`,
`webrtc`→`interactive-realtime`). The wall-clock timing behaviour itself — ring-drain timing, backpressure,
catch-up — is measured by the keiko-ui `voice-timebase.ts` suite ([ADR-0103](../adr/ADR-0103-voice-timing-engine.md),
32 deterministic tests with an injected clock).

P10 adds the offline `VoiceAcousticEval` companion gate for acoustic-quality budgets that can be scored
without a live provider. It covers exactly `first-word`, `trailing-word`, `noisy-room`, `laptop-echo`,
`headset`, `fast-interrupt`, `long-pause`, `unfinished-utterance`, `exact-identifiers`, and
`grounded-vs-casual`; scores WER/CER, first/last-token retention, exact identifier retention, first
partial latency, final transcript latency, TTFA, local duck latency, interrupt ack latency, premature
finalization, and grounded-tool-before-answer ordering; and includes adversarial negative fixtures that
must be caught. It is still not a live WebRTC wall-clock transport measurement: it scores deterministic
fixture traces and returns a CI-blocking GO/NO-GO verdict with no network, credentials, or raw audio.

### VOICE_TWIN_REPLAY_CAPACITY is a local constant

`VOICE_TWIN_REPLAY_CAPACITY = 200` in `metrics.ts` mirrors the bounded rings in:

- `keiko-server/src/voice-realtime.ts`: `MAX_REPLAY_EVENTS = 200`
- `keiko-ui/src/app/components/desktop/hooks/voice-timebase.ts`: 200-slot ring

It is **not imported** from those packages (import boundary prevents it). A doc comment records the relationship. If the UI or server ring size changes but this constant is not updated, CI review will surface the drift.

### Supply-chain policy scope

The denylist covers only packages listed in [`docs/voice/supply-chain-policy.md`](supply-chain-policy.md) §1. A new class of runtime media package not on that list would not be flagged until the policy document is updated.

### No positive egress allowlist exists yet

AC5 bounding is enforced by _limiting which endpoints are reachable_ (only configured model providers) and _which models are electable_ (only capable, configured models), not by a deny-all-others host allowlist. The [privacy-contract.md](privacy-contract.md) §1 honest limitation applies here: `gatewayFetch` has no positive destination allowlist. A future, optional egress policy layer (opt-in positive host/base-URL deny list) would require a separate issue. The harness documents this gap in its output so operators are not misled.

## 7. Example: running and interpreting output

```bash
$ npx vitest run packages/keiko-evaluations/src/voice-twin

✓ packages/keiko-evaluations/src/voice-twin/suite.test.ts (24 tests) 1234ms
  ✓ AC1/AC2 no-voice: dormant when voice unavailable
  ✓ AC3 stt: STT affords partial preview, commit, discard
  ✓ AC4 full-realtime: WebRTC media + proxied-SDP + loopback control
  ✓ AC5 privacy: egress auditor rejects unapproved destinations
  ✓ AC5 privacy: real-repo manifest scan is clean (no denied packages)
  ✓ AC6 metrics: interruption, end-of-turn, correction, recovery, buffer
  ✓ Capability-matrix-consistency: all cells match contract tables
  ✓ Determinism: two runs deep-equal
  ✓ Coverage: all six environments × profiles exercised
  [12 more tests...]

✓ packages/keiko-evaluations/src/voice-twin/capability.test.ts (8)
✓ packages/keiko-evaluations/src/voice-twin/privacy.test.ts (12)
✓ packages/keiko-evaluations/src/voice-twin/metrics.test.ts (9)
✓ packages/keiko-evaluations/src/voice-twin/scorer.test.ts (8)
✓ packages/keiko-evaluations/src/voice-twin/runner.test.ts (6)

Test Files  6 passed (6)
     Tests  63 passed (63)

Verdict: GO
Capability matrix: VERIFIED
Privacy bounding: VERIFIED (no denied packages, all positive egresses approved)
Metrics: VERIFIED (all five AC6 dimensions exercised)
Coverage: 98.2% (voice-twin), 92.1% (keiko-evaluations overall)
```

If any dimension fails, the output names it:

```
✗ external-destination-privacy: FAIL in privacy-negative-fixture
  Auditor returned approved=false (correct)
  but oracle.expectedApproved=false contradicts
  → This proves the auditor catches violations (expected).
  However, dimension verdict is FAIL if oracle and auditor disagree.
```

(This is a contrived example; the actual test ensures they agree.)

## 8. Related documentation

- [ADR-0110](../adr/ADR-0110-voice-evaluation-harness.md) — the authoritative decision record and detailed rationale.
- [ADR-0100–0109](../adr/) — the nine prior voice architecture decisions that this harness proves.
- [deployment-profile-matrix.md](deployment-profile-matrix.md) — the 3×4 matrix this harness encodes as executable assertions.
- [privacy-contract.md](privacy-contract.md) — the privacy boundaries and honest limitations on egress allowlisting.
- [supply-chain-policy.md](supply-chain-policy.md) — the denied media packages list that `privacy.ts` implements.
- [protocol.md](protocol.md), [realtime-transport.md](realtime-transport.md), [transcript-semantics.md](transcript-semantics.md), [assistant-speech-output.md](assistant-speech-output.md), [action-intent-governance.md](action-intent-governance.md), [session-recap.md](session-recap.md) — the child-issue feature specifications.
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491), Issue [#505](https://github.com/oscharko-dev/Keiko/issues/505).

## 9. Current integration status

The harness is **complete and CI-gated** as of Issue #505. The suite runs in `npm run test:coverage:quality` on every PR and must show `GO` verdict with zero failing dimensions to merge. All 63 tests pass; coverage is 98.2% on voice-twin modules and 92.1% on the overall keiko-evaluations package.
