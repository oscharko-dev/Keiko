# ADR-0140: macOS dev-lane activation of the managed coding runtime

## Status

Accepted (Issue #2475, Epic #2473 Wave 1, 2026-07-17; launcher lifecycle amendment
2026-07-29).

## Amends

- [ADR-0137](ADR-0137-server-owned-coding-runtime-contracts.md) D5 — the release-qualified
  availability matrix and its prohibitions remain authoritative for every packaged install. This
  record adds exactly one additional availability source: an explicitly opted-in, structurally
  dev-checkout-confined development lane with a declared, weaker evidence class.

## Context

Every managed-OpenCode capability on `dev` was proven only through injected test seams; on every
real installation, production activation had never executed — readiness reported
`runtimeAvailable: false` and start failed `runtime-unqualified`. ADR-0137 D5 correctly forbids
best-effort launches on unqualified platforms, but the packaged qualification chain (runtime
supervisor build + qualification receipts, signing evidence, platform inspection for the
secure-read helper) is a Wave-5 deliverable. Epic #2473's anti-false-green rule requires every
capability claim to be proven at least once through production composition **and** production
discovery before its wave closes. Without a governed development activation path, that proof is
structurally impossible until Wave 5, and development against the real runtime continues to run
through seams that production never exercises.

## Decision

### D1 — A development lane is a distinct, declared availability source

The coding runtime gains exactly one additional activation source next to the packaged
windows-x64 discovery: dev-lane discovery on macOS (arm64/x64). It is inactive unless
`KEIKO_CODING_RUNTIME_DEV_LANE` carries an explicit enable token. A runtime activated through it
carries `evidenceClass: "functional-not-platform-qualified"` and an availability record in which
only checks the lane actually performs are marked verified (`signatureVerified: false`,
`qualificationVerified: false`). Nothing on this lane may present itself as platform-qualified.

`npm run dev:start` is the trusted development launcher and is itself the operator's explicit
selection of this repository-confined lane. On a supported macOS checkout it supplies the enable
token to the BFF, evaluates production discovery after the package build, stages the
review-approved payload and secure-read helper only when discovery reports a repairable staged
artifact failure, and then evaluates production discovery again. The launcher fails instead of
reporting a usable development server when runtime readiness remains unavailable. Direct BFF
startup outside this launcher still requires the explicit environment token.

### D2 — Structural confinement to repository checkouts

Dev-lane discovery refuses, before evaluating any payload trust, whenever the resolved package
root carries a packaged-install manifest (`.portable/update-portable-manifest.json` or
`.portable/setup-manifest.json`) or lacks repository-checkout markers (`.git` or
`tsconfig.packages.json`). Packaged installs — Windows and macOS alike — therefore cannot adopt
the dev lane as a de-facto activation path; their behavior is unchanged and remains fail-closed
until the Wave-5 packaged qualification supplies the evidence ADR-0137 D5 demands.

### D3 — Verified payload, declared forgone guarantees

The lane's trust anchor is the review-approved redistribution catalog
(`portable-runtime-approvals.json`): the staged executable's tree digest and the license digest
are recomputed from disk and compared against the catalog on every discovery. The secure-read
helper is built locally, digest-pinned in a dev-lane manifest at staging time, re-verified at
discovery (including source-tree freshness) and at every admitted read. Two guarantees are
deliberately forgone and must stay documented wherever the lane is described: the
release-qualified supervisor's containment and orphan-reaping proof (the dev-lane backend
terminates a POSIX process group best-effort and proves exit only for the direct child), and
platform signature chains (digest pinning replaces Developer ID/notarization evidence).

### D4 — Honest, content-free unavailability reasons

The readiness projection names the first failed activation prerequisite through a closed,
content-free reason vocabulary (`runtimeUnavailableReason`), bound to `runtimeAvailable: false`
in both directions by the shared contract validator. Discovery failures no longer collapse into
an unexplained `false`. The kill switch (`KEIKO_CODING_SIDECAR_DISABLED`) dominates every other
prerequisite and reports `runtime-disabled` before discovery runs.

### D5 — Explicit deployment ceiling, never lane-implied

The coding-runtime deployment ceiling is explicit configuration
(`KEIKO_CODING_DEPLOYMENT_CEILING`, or the composition option), defaulting to `governed-assist`;
unrecognized values are ignored fail-closed. Enabling the dev lane never widens the ceiling. The
readiness projection reports the same ceiling the mint clamp enforces; the previously reported
autonomous-delivery ceiling was a separate authority knob and could diverge from enforcement.

### D6 — Development stop owns bounded runtime teardown

`npm run dev:stop` signals the trusted development runner first. The runner gives the BFF longer
than the BFF's complete bounded runtime-disposal window before escalating, so the coding
orchestrator can revoke authority, terminate the owned OpenCode process group, and close runtime
state before UI and watcher processes disappear. The stop command waits for the runner and every
tracked child; it does not report success while a tracked process remains alive. `--force` remains
an explicit last-resort hard stop.

## Consequences

- The Wave-1 anti-false-green proof becomes executable: an env-gated production-discovery variant
  of the real-binary functional case activates the staged dev-lane payload with no injected
  runtime seam.
- The dev runner exports `KEIKO_UI_PORT` to the BFF, mirroring the packaged CLI, so activation
  can compose loopback gateway and editor-agent URLs.
- The supported development launcher makes the verified runtime part of ordinary `dev:start`
  readiness instead of allowing a partially functional UI to count as a successful start.
- The development stop window now contains the BFF's bounded runtime-disposal window.
- Wave 5 (packaged platform qualification) is unaffected: it supplies the receipts, signing
  evidence, and platform inspection that let packaged installs satisfy ADR-0137 D5 unmodified.
- Operational guidance, the stage → start walkthrough, and the reason table live in
  [`docs/coding-runtime/dev-lane.md`](../coding-runtime/dev-lane.md).

## Alternatives considered

### Keep activation seam-only until Wave 5

Rejected. It preserves the false-green era this epic exists to end: every green journey would
keep proving a composition production never runs, and first-contact integration defects (loopback
URL composition, secure-read wiring, supervisor identity) would surface only after the packaged
qualification lands.

### Silently qualify macOS through the existing receipt path

Rejected. Fabricating supervisor qualification receipts without the qualification suite would
forge packaged-grade evidence and violate ADR-0137 D5's core prohibition. The dev lane instead
declares a weaker evidence class and records unverified checks as unverified.

### A build-flag-compiled lane absent from production binaries

Rejected as unnecessary indirection: the repository ships one composition, and the structural
dev-checkout confinement (D2) plus the explicit opt-in achieve the same containment without a
second build variant whose divergence itself would need evidence.
