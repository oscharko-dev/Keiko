# ADR-0140: macOS and Windows dev-lane activation of the managed coding runtime

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
windows-x64 discovery: dev-lane discovery on macOS (arm64/x64) and Windows (x64). It is inactive unless
`KEIKO_CODING_RUNTIME_DEV_LANE` carries an explicit enable token. A runtime activated through it
carries `evidenceClass: "functional-not-platform-qualified"` and an availability record in which
only checks the lane actually performs are marked verified (`signatureVerified: false`,
`qualificationVerified: false`). Nothing on this lane may present itself as platform-qualified.

`functional-not-platform-qualified` is no longer server-internal. It is now a value of the
`runtimeEvidenceClass` field on the coding-workbench readiness contract, REQUIRED whenever
`runtimeAvailable` is true, and the packaged evaluation lane (ADR-0163 D9) is its second producer.
One vocabulary answers "how strong is this available runtime's evidence?" for both lanes, and the
anti-false-green rule above now binds the UI as well as the server: a runtime in this class is
never narrated, labelled or coloured as a plain ready runtime. This also repairs a pre-existing
hole — the dev lane's evidence class previously reached no UI surface, so a dev-lane runtime
announced "Runtime ready."

`npm run dev:start` is the trusted development launcher and is itself the operator's explicit
selection of this repository-confined lane. On a supported macOS or Windows checkout it supplies the enable
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
the dev lane as a de-facto activation path; that confinement is unchanged and still absolute.

A packaged artifact now has a second, differently confined availability source: the ADR-0163 D9
evaluation lane. It is not this lane and does not weaken this confinement. The distinction is the
confinement rule itself. The dev lane is selected by an environment token on a repository checkout
and refuses the moment a packaged install marker exists. The evaluation lane is selected by a
declaration the packaged artifact carries in its own manifest, written only when a release
explicitly requests it, and it carries the complete integrity evidence set of a production
artifact. Neither can be reached from the other, and neither can be entered by a fallback after
some other prerequisite fails.

### D3 — Verified payload, declared forgone guarantees

The lane's trust anchor is the review-approved redistribution catalog
(`portable-runtime-approvals.json`): the staged executable's tree digest, license digest, and the
freshly generated SBOM digest are compared against the catalog during staging and on every
discovery. The secure-read helper is built locally, digest-pinned in a dev-lane manifest at
staging time, re-verified at discovery (including source-tree freshness) and at every admitted
read. On macOS the dev-lane backend terminates a POSIX process group best-effort and proves exit
only for the direct child; Windows uses its native Job Object supervisor. Neither platform carries
a platform signature chain (digest pinning replaces Developer ID/notarization or Authenticode
evidence).

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

### D6 — Long-lived gateway-only network confinement on macOS (Issue #2951)

The macOS dev-lane backend (`devLaneRuntimeProcessBackend.ts`) never spawns the sidecar directly.
Every launch is wrapped in a `RuntimeGatewayConfinement` (ADR-0043 D11–D13,
`packages/keiko-sandbox/src/runtime-gateway.ts`): a Seatbelt profile that denies all network egress
by default and carves out exactly one outbound allowance — the loopback gateway/BFF port the caller
attests — plus denies process-fork, mach-lookup, Apple Event, and `LSOpen` escapes. The backend
refuses to spawn at all when no confinement is attached, or when the policy's `runId`/`treeBindingId`
does not match the launch request, before any process exists (fail-closed, consistent with D5's
kill-switch precedence).

This closes the network side of the dev lane's confinement for macOS only. It does **not** extend to
the Windows dev lane or to `nativeRuntimeProcessBackend.ts` (the backend this ADR also names in its
title and D3 for Windows process-group supervision): neither carries an OS-level network policy
today. A Windows-activated sidecar is confined by D2's structural checkout confinement and D3's
digest-pinned payload trust, but not by a kernel-enforced egress boundary. Closing that gap requires
a Windows-native equivalent of the Seatbelt allowlist and is tracked as remaining work (Issue #2951),
not claimed here as done.

### D7 — Development stop owns bounded runtime teardown

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

### Silently qualify a dev checkout through the existing receipt path

Rejected. Fabricating supervisor qualification receipts without the qualification suite would
forge packaged-grade evidence and violate ADR-0137 D5's core prohibition. The dev lane instead
declares a weaker evidence class and records unverified checks as unverified.

### A build-flag-compiled lane absent from production binaries

Rejected as unnecessary indirection: the repository ships one composition, and the structural
dev-checkout confinement (D2) plus the explicit opt-in achieve the same containment without a
second build variant whose divergence itself would need evidence.
