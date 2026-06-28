# ADR-0069: Voice Digital Twin production-readiness gate — conservative, documentation-only closure

## Status

Accepted (Issue #506, Epic #491, 2026-06-25)

## Context

ADR-0058 through ADR-0068 delivered the full optional Voice Digital Twin for Epic #491: the capability-gated
architecture and governance baseline (#492), capability metadata (#493), the BFF STT dictation endpoint
(#494) and composer dictation UX (#495), the wire protocol (#496), realtime WebSocket/WebRTC transport (#497),
the timing engine (#498), the floor-control turn manager (#499), transcript segment semantics (#500),
assistant speech-output playback (#501), discussion intelligence (#502), spoken-action governance (#503),
session recap (#504), and the capstone evaluation harness (#505). Child issues #492–#505 are all closed
`COMPLETED`.

Issue #506 is the **formal production-readiness gate** for regulated customers. Its purpose is not to add
features — the epic's `Out of Scope` explicitly forbids "implementing new features beyond closure gaps" and
"making voice generally available without capability and privacy evidence." Its purpose is to **prove and
consolidate**, conservatively, that the six epic invariants hold across the no-voice, STT-only,
speech-output, full-realtime, Azure Foundry, and customer-hosted profiles, and to record closure evidence on
the epic.

An audit of all six acceptance criteria against the shipped code, tests, evaluation suite, CI configuration,
and dependency state — with adversarial verification of every citation — established that **every acceptance
criterion is already satisfied by shipped artifacts**, and that the only closure actions required are
documentation: a consolidated gate record, one stale-policy correction, and the epic closure comment. No
production code or test change is needed to close #506.

## Decision

### D1 — The gate is documentation-only, mirroring ADR-0058 (#492)

Issue #506 ships documentation only: a consolidated production-readiness record
([`docs/voice/production-readiness.md`](../voice/production-readiness.md)), this ADR, a correction to the
supply-chain policy, index updates, and the epic closure comment. It adds no runtime code and no dependency.
The technical substance of all six acceptance criteria already shipped under #492–#505 and is green in CI;
pulling deferred hardening into #506 would contradict the issue's own scope and convert a closure gate into
new development.

### D2 — Acceptance criteria are proven by reproducible, layered evidence

Each criterion cites a reproducible artifact (code symbol, test, evaluation dimension, CI job, dependency
scan, or GitHub state). Capability gating (AC2) is proven by the **union** of independent layers — contract
data, server enforcement, the live `Permissions-Policy` header, the WebSocket upgrade gate, and UI gating —
not by the evaluation harness alone, which (per the ADR-0068 import boundary) proves only the contract-data
layer. No-voice functionality (AC1) is proven decisively by the full suite running green with no voice
provider configured (`CAPABILITY_DATA` empty; no voice environment variable in CI). The detailed
criterion-by-criterion evidence is in [`docs/voice/production-readiness.md`](../voice/production-readiness.md).

### D3 — Limitations are named, not glossed

The gate records, as accepted limitations, that: there is no positive destination host/IP allowlist
(`validateBaseUrl` deliberately permits private endpoints); the full-realtime WebRTC media plane egresses
browser↔provider directly and its locality rests on configuration + CSP, not an end-to-end test; the e2e
no-voice path is stubbed so the no-voice regression guarantee rests on unit/handler tests; the denied-media
scan is name-based and manifest-only; and `dependency-review` enforces at the `feat/keiko-voice-digital-twin
→ dev` integration boundary rather than per child PR. None blocks general availability once documented and
the epic closure comment plus a green integration PR are in place. Deferred hardening (opt-in egress
allowlist, transitive lockfile scan, server-side WebRTC/TURN) is recommended as future child issues.

### D4 — The supply-chain policy is corrected to match the shipped decision

[`docs/voice/supply-chain-policy.md`](../voice/supply-chain-policy.md) §1/§2 are updated to record that `ws`
is now declared in three manifests (root CLI, `keiko-tools`, and `keiko-server`), and that the `keiko-server`
declaration is the explicit, ADR-gated decision already taken in ADR-0060 (#497) when the loopback WebSocket
control plane was re-opened. The dependency **count** is unchanged and `ws` remains the single allowed
runtime media-adjacent package. This removes the contradiction in which the binding policy read as if a
shipped, already-approved declaration were an un-taken future decision or a fresh violation.

### D5 — The epic is closed only after evidence exists

The epic closure comment is posted to #491 only after AC1–AC5 evidence is consolidated and cited, consistent
with the epic's `Out of Scope` ("closing the epic while child issues lack evidence"). The comment rolls up
the production-readiness checklist, capability matrix, security/privacy review record, dependency/supply-chain
confirmation, and deployment-profile documentation, and links each child issue to its closed state, closure
comment, merged PR, and verified merge commit.

## Consequences

### Positive

- A single, conservative, reproducible production-readiness record exists for regulated-deployment reviewers,
  with every claim cited and every limitation visible.
- The binding supply-chain policy now agrees with the shipped dependency state, removing an apparent
  violation that would otherwise block a conservative sign-off.
- No code or dependency risk is introduced by the gate itself.

### Negative

- The gate is a point-in-time consolidation; if later child issues change capability gating, privacy
  boundaries, or the dependency budget, the production-readiness record must be revisited.

### Neutral

- Several real hardening opportunities (positive egress allowlist, transitive lockfile scan, server-side
  WebRTC) are documented as deferred follow-ups rather than implemented, by design.

## Alternatives Considered

### Alternative 1: Add an executable production-readiness aggregation check

Rejected. The voice-twin evaluation harness (#505) already provides the executable, CI-safe GO/NO-GO gate for
capability gating, transport isolation, privacy bounding, and the dependency denylist. A second aggregation
layer would duplicate it and add code to an audit issue whose scope forbids new features.

### Alternative 2: Implement the opt-in egress allowlist now to close the AC3 limitation

Rejected for this issue. A positive host/IP allowlist must not break private/self-hosted customer endpoints;
designing it safely is its own child issue. AC3 is satisfied today by endpoint/model bounding, with the
limitation recorded.

### Alternative 3: Close the epic without a consolidated gate record

Rejected. The epic's purpose for regulated customers is precisely the consolidated, conservative evidence;
posting only a terse comment would fail the "capability and privacy evidence" bar.

## Related

- [ADR-0058](ADR-0058-voice-digital-twin-capability-architecture.md) — capability-gated architecture baseline.
- [ADR-0060](ADR-0060-realtime-voice-transport.md) — the `ws`-in-`keiko-server` decision corrected into the
  supply-chain policy.
- [ADR-0068](ADR-0068-voice-evaluation-harness.md) — the executable evaluation gate this record consolidates.
- [`docs/voice/production-readiness.md`](../voice/production-readiness.md) — the detailed gate record.
- Epic [#491](https://github.com/oscharko-dev/Keiko/issues/491); Issue
  [#506](https://github.com/oscharko-dev/Keiko/issues/506).

## Date

2026-06-25
