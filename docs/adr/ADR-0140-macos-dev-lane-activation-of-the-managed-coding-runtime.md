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
startup outside this launcher still requires the explicit environment token. After packaged-runtime
resolution, an explicitly enabled development lane takes precedence over an optional npm runtime
package in the checkout's dependency tree. Its refusal is authoritative as well: the launcher must
not claim to test current native sources while silently executing an older installed helper.

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

### D2a — The npm runtime package is a third, separately anchored availability source (2026-09-21, #3577)

An npm installation of Keiko carries neither OpenCode nor the native helpers, and a customer who
cannot install a desktop package (no administrator rights, no infrastructure approval) had no way
to start a coding run at all. On macOS an npm installation therefore activates the runtime from
`@oscharko-dev/keiko-coding-runtime-darwin-arm64` or `-darwin-x64`. Both are `optionalDependencies`
of the main package with `os`/`cpu` fields, so `npm install -g @oscharko-dev/keiko` installs the one
for the host by itself and skips them everywhere else; Keiko finds the package by ordinary module
resolution from its own package root. They carry a valid SPDX license expression
(`Apache-2.0 AND MIT`) because the supply-chain gates evaluate everything the main package can
install.

This does not loosen D2. The dev lane stays confined to repository checkouts and stays opt-in. The
npm lane is not reachable from it and applies the same D3 verification with a different trust
anchor: the approved executable-tree, license and SBOM digests and the digest of the helper binary
Keiko built are compiled into the server, pinned by test to `portable-runtime-approvals.json` and
to `native/secure-workspace-read`, so a runtime package can never vouch for itself and a planted
package of the same name verifies or is refused. No environment token is asked: the runtime is
part of what the operator installs, and `--omit=optional` remains their way to decline it. Without an explicit checkout-lane selection, an installed package that fails verification decides
the outcome with its own D4 reason and never falls through to another lane. The lane reports the same honest
posture as the dev lane (`functional-not-platform-qualified`) and the same forgone guarantees, and
both dev-lane log operations carry `lane: "npm-runtime-package"`. Windows and Linux stay on their
packaged lanes: Windows needs the native supervisor and Linux the sandbox isolation, neither of
which this lane ships.

**Amended 2026-10-24 — the runtime package carries the pinned ripgrep (#3897, #4064).** OpenCode's
`glob` and `grep` tools run ripgrep and would otherwise download it on first use, which a
firewalled customer on a clean `npm install -g` cannot do; only a developer override
(`KEIKO_RIPGREP_BINARY_PATH`) made search work there. The runtime package therefore also ships the
unmodified upstream ripgrep release pinned in `ripgrepRuntime.ts` (ADR-0163 D1 amendment of
2026-10-23) at the portable payload's own paths: `runtime/native/rg`, its MIT text at
`runtime/licenses/ripgrep/LICENSE-MIT` and a CycloneDX component record at
`runtime/licenses/ripgrep/sbom.cdx.json`. `scripts/build-coding-runtime-npm-package.mjs` stages them
through the same provisioning and `stageRipgrepTool` the portable build uses, for the TARGET's
release, and the candidate inspection pins all three files (and the executable bit) and binds the
release in the sealed receipt. The trust anchor is unchanged: the digest is the one compiled into
the server (not `npmLaneRuntimeApprovals.ts`, which keeps describing only the OpenCode tree, SBOM,
license and helper), and the server verifies `<package>/runtime/native/rg` against it at every run
launch with the same owner, mode and symlink checks as every other layout, so the package vouches
for nothing. The lane's native-directory check admits that one file name beside the secure-read
helper and nothing else; the bytes are judged by the ripgrep verifier, so a missing, tampered or
linked `rg` degrades search with a closed reason on `coding-runtime.ripgrep.resolved`
(`layout: "npm-package"`) and never refuses the engine. Runtime packages published before this
amendment carry no `rg`; they stay active and report `missing`.

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

The original service starts each shell child in its own process group, so the group signal ends
only the service; on a graceful stop the service ends its own children, but a crashed service
cannot (#3899 AC2). A command can also detach a process itself (`cmd &`, `nohup`, `setsid`);
launchd adopts it at once, so it is never below the service, and neither the service nor the group
signal ends it (#3901 AC3). Which processes belong to a run is therefore answered by the kernel,
never inferred from a parent link, a working directory or a start time (PR #4064 review): every
process a run starts inherits the run's Seatbelt instance through fork and exec, however it later
detaches or changes its session, directory or environment, and the native profile lets a process
signal only members of its own instance (`(target same-sandbox)`; another instance of the identical
profile is refused). The native launch starts a sandbox member beside the service
(`darwinSandboxMembership.ts`): a shell of builtins only, on descriptor 3, in a process group of its
own, which the service never holds. Once the service has exited, the member sends every signal:
the kernel refuses its signal to any process of anyone else, even one that reused a PID a moment
before, and without the member nothing is signalled at all. A listing is a snapshot, and a member
can fork and exit between a listing and the member's answer, so an empty answer about an older
listing proves nothing (PR #4064 review). The sweep therefore freezes the run first: each round
lists this user's processes, asks the member which of the live ones are the run's, and lists again.
It proves the end only when every member the answer names was already stopped at the first listing,
and no process that was running then and could have been a member has gone by the second. Only a
running process forks, so no member can have appeared since. A gone process could not have been a
member when it started before the run, or when its parent is alive at the second listing and no
member: macOS reparents an orphan only to launchd, so that parent started it, and the child of a
process outside the sandbox is outside it too. Otherwise the member stops (SIGSTOP) every member it
named and the next round asks again; once proven, it kills the frozen members and a final answer
must name none. Zombies have already ended and are not asked about. Only `clean` and `reaped`
settle the tree. A member that outlives every kill (`survivors`), a listing the sweep cannot take
(`listing-failed`), a member that no longer answers (`membership-unavailable`), a run whose profile
has no shell for a member (`unproven`, the gateway profile) and a run that is not proven frozen
within twenty rounds (`unproven`: one that keeps re-forking faster than a round, or a host whose
launchd children keep ending in every round) leave the tree unended, so the manager reports
`runtime-reap-unproven` instead of a stopped runtime. `coding-runtime.descendants.swept` records the
outcome and the member, signalled, surviving and round counts. A process cannot leave its Seatbelt
instance, so no Endpoint Security monitor (ADR-0163 D4) is needed for this proof; a member killed
by the run's own commands turns the run's next sweep into `membership-unavailable`, never into a
false stop.

### D4 — Honest, content-free unavailability reasons

The readiness projection names the first failed activation prerequisite through a closed,
content-free reason vocabulary (`runtimeUnavailableReason`), bound to `runtimeAvailable: false`
in both directions by the shared contract validator. Discovery failures no longer collapse into
an unexplained `false`. The kill switch (`KEIKO_CODING_SIDECAR_DISABLED`) dominates every other
prerequisite and reports `runtime-disabled` before discovery runs.

### D5 — All modes available by default, never lane-implied

The Coding Workbench makes all three product modes available without startup configuration. Its
deployment ceiling defaults to `autonomous-delivery`; the local human's selection in the composer
determines each new run's authority inside its validated Authority Envelope. The selected mode
defaults to **Ask for approval** and is never silently widened by runtime activation, repository
binding, or a restart. An installation may impose a narrower ceiling through
`KEIKO_CODING_DEPLOYMENT_CEILING` or the composition option. An unrecognized explicit value fails
closed to `governed-assist`. Enabling the dev lane never changes the ceiling. Readiness reports the
same ceiling the mint clamp enforces; the previously reported autonomous-delivery ceiling was a
separate authority knob and could diverge from enforcement.

### D6 — Long-lived gateway-only network confinement on macOS (Issue #2951)

The macOS dev-lane backend (`devLaneRuntimeProcessBackend.ts`) never spawns the sidecar directly.
Every launch is wrapped in a `RuntimeGatewayConfinement` (ADR-0043 D11–D13,
`packages/keiko-sandbox/src/runtime-gateway.ts`): a Seatbelt profile that denies all network egress
by default and carves out exactly one outbound allowance — the loopback gateway/BFF port the caller
attests — plus denies mach-lookup, Apple Event, and `LSOpen` escapes. `process-fork` remains
available for the pinned OpenCode sidecar's Git handshake (#3390), while `process-exec` is
deny-by-default and admits only the verified runtime executable and the exact Git executable
attested for that launch. Arbitrary shells, curl, compilers, and other child executables are
refused. Every admitted descendant inherits the same Seatbelt profile, including the network
denial above. The backend refuses to spawn at all when no confinement is attached, or when the
policy's `runId`/`treeBindingId`
does not match the launch request, before any process exists (fail-closed, consistent with D5's
kill-switch precedence).

The profile is asymmetric by design: outbound is a single pinned allowance (the caller-attested
gateway host/port), but inbound is not port-pinned at all — the compiled rule is
`(allow network-inbound (local <family> "localhost:*"))`
(`packages/keiko-sandbox/src/backends.ts`'s `buildGatewaySeatbeltCommand`), so the confined process
may itself accept a connection on any local port, as long as the peer is loopback-sourced (`deny
network*` still blocks every route to a non-loopback peer in either direction). This is what lets
the sidecar's own HTTP server bind and answer `/health` and other local callers without a second,
narrower carve-out; it does not weaken the egress boundary this ADR closes, since an inbound-only
allowance grants no ability to reach out to a network destination the outbound rule denies.

This closes the network side of the dev lane's confinement for macOS only. Windows production
composition does attach the same `RuntimeGatewayConfinement` to `nativeRuntimeProcessBackend.ts`,
but the native launch protocol/helper cannot enforce it yet. The Windows launch therefore refuses
before spawn with `GATEWAY_UNSUPPORTED_ON_HOST_REASON`; omitting the policy or launching unconfined
is not an allowed fallback. Exact-port WFP enforcement remains tracked by #3423/#2951 and is not
claimed here as done.

### D7 — Development stop owns bounded runtime teardown

`npm run dev:stop` signals the trusted development runner first. The runner gives the BFF longer
than the BFF's complete bounded runtime-disposal window before escalating, so the coding
orchestrator can revoke authority, terminate the owned OpenCode process group, and close runtime
state before UI and watcher processes disappear. The stop command waits for the runner and every
tracked child; it does not report success while a tracked process remains alive. `--force` remains
an explicit last-resort hard stop.

### D8 — Cross-platform gateway policy moves to a shared contract type (Issue #2951 follow-up, 2026-09-05)

D6's Seatbelt confinement now flows through a contract-level `NetworkGatewayPolicy`
(`keiko-contracts/src/tools.ts`) and keiko-sandbox's generic `planIsolatedRun`/`selectGatewayBackend`
planning path (ADR-0043 D14) instead of a macOS-only helper called directly: the dev-lane backend
builds an `IsolatedRunPlan` with that policy and lets the shared planner pick (and, on an
unsupported host, refuse) the backend, rather than assuming Seatbelt is always present. The observed
behaviour on a working macOS host is unchanged — same profile, same `/usr/bin/sandbox-exec` path —
but a macOS host missing `sandbox-exec` itself now fails the launch closed with a reasoned decision
instead of an OS-level spawn error surfacing after the fact.

D6's Windows/native gap also gets an explicit, shared refusal: `nativeRuntimeProcessBackend.ts` can
now be given the same gateway policy and, because its launch-packet protocol has no way to enforce
one, always fails the launch with the identical reason keiko-sandbox's planner would produce for an
unsupported host. Production composition (`productionOpenCodeBackend.ts`) now always attaches that
policy to a native/Windows launch too, via the unconditional `runtimeGatewayConfinement` helper at
both native-backend construction sites (the release/evaluation-lane path and `devLaneSupervisor`'s
Windows branch) — so a Windows-activated sidecar today fails closed pre-spawn with
`GATEWAY_UNSUPPORTED_ON_HOST_REASON` (`nativeRuntimeProcessBackend.ts`'s refusal path) rather than
running unconfined. This matches ADR-0043 D14's own description of the same wiring; the two ADRs
converge instead of describing the fact differently.

Issue #3422 additionally teaches the shared planner to compile the same contract into a Linux
bubblewrap/unshare namespace plus an anonymous descriptor-transfer gateway bridge (ADR-0043
D12/D14). ADR-0140 does not activate that path: the development lane still supports only its
declared macOS and Windows targets. Issue #3451 supplies `linux-x64` exclusively through the
packaged production-discovery path, where exact-component, offline Sigstore, fresh-runner, and real
namespace qualification are mandatory; it does not widen this weaker development lane.

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

## Amendment — Issue #2951 removes ambient network from the dev lane (2026-09-12)

Issue [#2951](https://github.com/oscharko-dev/Keiko/issues/2951) narrows D3's declared development
guarantees. Forgoing release process-tree qualification never permits ambient sidecar networking.
The macOS dev-lane backend now receives the same prepared Seatbelt wrapper as the native supervisor,
and the repository-confined OpenCode sidecar starts only under the loopback-only profile.

The runtime supervisor performs egress planning after process-tree qualification and before invoking
the dev backend. If `/usr/bin/sandbox-exec` is unavailable, the reviewed receipt or source binding is
invalid, or wrapper construction fails, the lane reports `runtime-egress-unenforceable` and spawns
nothing. Signals and stop/recovery operations continue to target the wrapper's owned process group,
so descendants cannot outlive the supervised sandbox lifecycle. No environment flag can downgrade
this requirement or restore direct spawn.
