# ADR-0043: Enforced execution isolation (`@oscharko-dev/keiko-sandbox`)

## Status

Proposed (2026-06-20). Authored for Issue
[#1202](https://github.com/oscharko-dev/Keiko/issues/1202) (Parent Epic
[#1189](https://github.com/oscharko-dev/Keiko/issues/1189)) under an explicit owner decision to build
the enforced egress-isolation primitive that unblocks editor-driven test generation. This ADR is the
citable decision record referenced by the new `keiko-sandbox` package, the `network: "none"`
enforcement at the keiko-tools spawn boundary, and the honest network-enforcement flag in
keiko-verification. It supersedes the dangling "ADR-0006 / ADR-0007" isolation references that earlier
code comments anticipated (no such files existed); those comments are updated to cite ADR-0043.

## Date

2026-06-20

## Version

1.0

## Context

The Keiko Editor epic's wave-2 surface (Issue #1202) generates unit tests and, before surfacing a
candidate as apply-ready, runs an **assured pre-filter** that **executes untrusted, model-generated
code** (build → pass → stability N≥5 → coverage increase → mutation/oracle strength). Executing
model-generated code is the highest-risk operation in the editor flow (OWASP LLM05: improper output
handling — data exfiltration, supply-chain callbacks, reverse shells). The Review Addenda and the
owner therefore required that this execution happen in an **isolated context with an enforced,
deny-by-default network-egress boundary, proven by an automated test in which an outbound connection
from the runner fails**.

Before this ADR, the platform could not provide that boundary: `keiko-contracts/src/tools.ts` shipped
`DEFAULT_SANDBOX_POLICY.network = "inherit"`, `keiko-verification/src/limits.ts` reported the network
dimension `enforced: false`, and no code path honoured `NetworkPolicy "none"`. The capability was
described as "deferred to the container wave" with no implementation. Issue #1202 was correctly held
open as blocked on this missing capability.

The product must run on macOS, Linux, and Windows. Enforced network isolation is an OS/kernel concern
with no single cross-platform API: Linux has unprivileged network namespaces (bubblewrap / `unshare
--net`); macOS has the Seatbelt sandbox (`sandbox-exec`); Windows has no native unprivileged
equivalent and relies on a container runtime. A container runtime (`docker`/`podman run
--network=none`) is the one primitive that enforces egress identically on all three.

## Decision

### D1 — A dedicated, reusable isolation package

Introduce `@oscharko-dev/keiko-sandbox`, a near-leaf package (depends only on `keiko-contracts` for
the `SandboxPolicy`/`NetworkPolicy`/attestation types). It owns the **isolation strategy only**:
backend availability probing, deterministic per-platform backend selection, pure construction of the
wrapper argv/profile that denies egress, a content-free `SandboxAttestation` (`{ backend,
networkEnforced, platform }`), and the fail-closed verdict. It performs **no process spawning** — the
wrapper builders and selection are pure functions, the probe is a thin filesystem read. The package is
the platform's reusable isolation brain, consumable anywhere an enforced run is needed.

### D2 — One spawn boundary applies the wrapper

The single subprocess boundary remains `keiko-tools/src/exec.ts` `runCommand`. When a caller passes
`policy.network === "none"`, `runCommand` asks keiko-sandbox for an enforcing wrapper and spawns the
wrapped command, recording the attestation on `CommandResult`. No second spawning path is introduced
(preserving the ADR-0019 invariant that verification and tools share one command boundary). Callers
that do not request `network: "none"` are unaffected — egress enforcement is opt-in per call, so the
read-only command tools keep `network: "inherit"` and their existing behaviour.

### D3 — Hybrid backends, fail-closed

keiko-sandbox selects, per platform: bubblewrap (`bwrap --unshare-net`) then `unshare --map-root-user
--net` on Linux; `sandbox-exec` with a `deny network-outbound` Seatbelt profile (loopback/unix
sockets allowed) on macOS; and a container runtime (`docker`/`podman run --network=none`) as the
universal fallback, primarily for Windows. If no enforcing backend is available, the decision is
**fail-closed**: `runCommand` rejects before spawning and the assured pre-filter reports the candidate
as **untrusted evidence only** (`unverified`), never `assured`. Untrusted code is never executed
without an enforced boundary.

### D4 — Honest enforcement reporting

`keiko-verification`'s `buildAppliedLimits` derives the network dimension's `enforced` flag from the
run's attestation rather than a hardcoded `false`, and the keiko-tools command audit metadata records
`networkEnforced`/`backend`. The platform's self-reported isolation posture now matches reality.

### D5 — CI-proven egress denial

A live egress proof (`packages/keiko-sandbox/src/egress.test.ts`) spawns the host's selected backend
and asserts that an outbound TCP connection from inside `network: "none"` **fails** while the same
connection succeeds without isolation (a negative control proves the test is meaningful). It is wired
into the required `ci` job (which installs bubblewrap and relaxes the Ubuntu 24.04 unprivileged-userns
restriction) as a non-skippable step, so the boundary is proven on every run. Locally it runs under
Seatbelt on macOS.

### D6 — Shared isolated-execution path for #1204/#1206

The enforced `network: "none"` boundary is the single isolated-execution path the editor verification
issues (#1204 post-apply verification, #1206 model/secret boundary) reuse. #1202 is its first
consumer via the assured pre-filter's disposable execution root; the project-specific toolchain
harness composed on top (copy → baseline → apply → gates → dispose) is expressed over injectable
ports so #1204 can generalise it without a parallel spawn path.

### D7 — Merge governance (this delivery)

By explicit owner decision for this delivery, the implementing PR may be merged autonomously once the
required `ci` check is green and review has settled — a documented departure from ADR-0042 D8's
owner-gated merge for the editor integration line, scoped to this change.

## Consequences

- `NetworkPolicy "none"` is now a real, enforced control; `DEFAULT_SANDBOX_POLICY.network` stays
  `"inherit"` so the blast radius is limited to callers that explicitly opt in.
- The security posture is strictly stronger: untrusted-code execution is gated behind an enforced,
  CI-proven egress boundary, or it does not run at all.
- Windows enforced egress depends on a container runtime being installed at run time; without one (or
  any other backend) the pre-filter fails closed. The CI proof runs on the Linux `ci` host.
- No new npm runtime dependency is added — backends are system binaries spawned through the existing
  boundary, so the supply-chain and SBOM surface is unchanged.
- Architecture boundaries are extended, not relaxed: keiko-tools and keiko-server may depend on
  keiko-sandbox (dependency-cruiser rules + package-graph allowlist updated); keiko-sandbox may depend
  only on keiko-contracts.

## Amendment — Issue #1204 realises D6 (2026-06-20)

Authored for Issue [#1204](https://github.com/oscharko-dev/Keiko/issues/1204) under an explicit owner
decision to build the editor patch-apply + post-apply verification surface on the enforced boundary this
ADR introduced. It records the consuming decisions; it relaxes nothing in D1–D7.

### D8 — Backend-aware enforced verification (the realisation of D6)

D2 left `keiko-verification`'s `policyForStep` hardcoded to `network:"inherit"` with a comment that
"enforced verification isolation is owned by #1204". #1204 makes the orchestrator **backend-aware**:
`VerificationDeps` gains a `networkEnforcement` mode (`"inherit"` | `"enforce-or-degrade"` |
`"enforce-or-fail-closed"`, default `"enforce-or-fail-closed"`) and an injected
`enforcedNetworkAvailable` flag, and `policyForStep` honours the resolved per-step network. A
`network:"none"` verification step now fails closed by default unless the caller attests an enforcing
backend; callers that intentionally need inherited network must pass `"inherit"` explicitly. The
honest `enforced` flag in `appliedLimits` is now derived from the run's `SandboxAttestation` (D4)
rather than left `false`.

keiko-verification stays free of a keiko-sandbox dependency: the caller (keiko-server, which already
depends on keiko-sandbox) probes once via `probeNetworkIsolation` and injects the boolean. The editor
post-apply path runs `"enforce-or-fail-closed"` — it executes the applied test under an enforced
`network:"none"` boundary or not at all.

### D9 — Network-only isolation for in-place post-apply verification

The assured pre-filter (#1202) runs in a disposable execution-root copy (`filesystem:"execution-root"`).
Post-apply verification (#1204) is a different operation: it re-confirms an already-assured candidate
**in place**, against the real workspace the user explicitly applied the patch to, so it enforces
**network egress only** (`filesystem` inherited). A `network:"none"` run is enforceable on more backends
(macOS Seatbelt, Linux bubblewrap/`unshare`) than the execution-root boundary, widening coverage while
keeping the data-exfiltration threat (OWASP LLM05) blocked.

### D10 — Merge governance for this delivery

By explicit owner decision for this delivery (mirroring D7), the #1204 PR may be merged autonomously into
the epic integration branch `feat/keiko-editor` once the required `ci` check is green and review has
settled. This is the same scoped departure from ADR-0042 D8's owner-gated merge for the editor
integration line; it does not authorise autonomous merge into the protected release line.

## Amendment — Issue #2951 adds long-lived gateway-only egress confinement (2026-09-05)

Authored for Issue [#2951](https://github.com/oscharko-dev/Keiko/issues/2951) (Audit KEIKO-0061,
Parent Epic #2886) under the accepted decision to sandbox every long-lived coding sidecar with an
attested OS-level egress policy. D1–D10 confine a **disposable, short-lived** command run
(`network: "none"`, egress denied outright). The coding-runtime sidecar (managed OpenCode) is a
different shape: it is a **long-lived process** that must reach exactly one loopback destination —
Keiko's own authenticated gateway/BFF endpoint — for the run's whole lifetime, never the public
network and never any other local port. Denying all egress (D3's `network:"none"`) is too strong for
this shape; the existing per-platform backends in `backends.ts` had no "deny everything except this
one loopback port" tier. This amendment records the mechanism built to close that gap and its actual,
current platform coverage.

### D11 — `RuntimeGatewayConfinement`: an attested, gateway-allowlist policy

`packages/keiko-sandbox/src/runtime-gateway.ts` adds a policy shape distinct from
`IsolatedRunPlan`/`SandboxBackend` (D1): `createRuntimeGatewayConfinement` binds the exact loopback
gateway address/port together with the run's identity (`runId`, `treeBindingId`) and attestation
digests (`envelopeDigest`, `runtimeArtifactDigest`, `modelProfileDigest`) into one frozen,
tamper-evident `RuntimeGatewayConfinement` record, closed over a `policyDigest` that a hostile
accessor cannot influence (`copyRuntimeGatewayConfinement` reads own data descriptors only, never a
caller-supplied getter). The gateway URL must be `http://127.0.0.1` or `http://[::1]` with no
credentials, query, or fragment — any other shape is rejected before a policy is even constructed
(fail-closed, D3's principle applied to this narrower boundary). `buildRuntimeGatewaySeatbeltCommand`
compiles that policy into a macOS Seatbelt profile: `(deny network*)` by default, with exactly one
`(allow network-outbound (remote tcp4|tcp6 "localhost:<port>"))` carved out for the attested gateway
port, plus `(deny mach-lookup)`, `(deny appleevent-send)`, and `(deny lsopen)` to close the
service-escape surface a long-lived interactive sidecar would otherwise have. `process-fork` is
allowed because a live run against the pinned OpenCode sidecar (#3390) showed it forks `git` for
its own session/history endpoints (`POST /sync/history`, `GET /session`), and a fork denial made
both fail with HTTP 500. Fork does not grant an arbitrary child executable: `process-exec` is
deny-by-default and allows only the already verified runtime executable plus exactly one Git
executable, attested per-launch rather than trusted by conventional path (see D16 below — an
earlier revision of this record allowlisted the conventional Apple/CommandLineTools/Xcode paths
unconditionally, which a local user can replace). A shell, curl, compiler, second Node binary, or
any other executable is refused by Seatbelt. Descendants inherit that executable policy and the
same `(deny network*)` with its one gateway-port carve-out. The real Darwin suite proves both the
attested Git spawn and an unapproved executable denial, and separately proves network denial
remains inherited by an allowed same-runtime descendant.
`packages/keiko-server/src/coding-runtime/devLaneRuntimeProcessBackend.ts` is the sole caller: it
refuses to spawn the sidecar at all when no
confinement policy is attached, or when the policy's `runId`/`treeBindingId` drift from the launch
request, before any process exists.

### D12 — Current scope is macOS-only; Linux and Windows are an explicit, tracked gap

`buildRuntimeGatewaySeatbeltCommand` hardcodes `/usr/bin/sandbox-exec` and is invoked only from the
macOS dev-lane backend (ADR-0140). **No equivalent OS-level network policy exists today for Linux
or Windows.** `packages/keiko-server/src/coding-runtime/nativeRuntimeProcessBackend.ts` — the
backend used for the Windows dev lane and every release-qualified platform — carries no network
policy of any kind; a sidecar launched through it is not confined to the gateway port by the OS. This
is a real gap in the acceptance criterion ("every long-lived coding sidecar runs behind an attested
OS/process-level sandbox … on macOS, Linux, and Windows"), not a documentation omission: closing it
requires extending `backends.ts`'s existing per-platform `IsolatedRunPlan`/`SandboxBackend`
abstraction with a gateway-allowlist variant (bubblewrap/`unshare` network-namespace plumbing for
Linux, a Windows-native equivalent), which is materially harder than the disposable-run case because
`--unshare-net` isolates the child into a fresh network namespace that cannot reach the host's
loopback gateway port without additional bridging. That generalisation is out of scope for this
delivery and is tracked as remaining work; this record deliberately does not claim cross-platform
coverage the code does not have. Until it lands, non-macOS long-lived sidecars rely on the process
supervisor's identity/path checks (§ D11) but not on kernel-enforced network denial.

### D13 — Does not relax D1–D10

This confinement mechanism is additive: it does not change `network: "none"`, the disposable-run
backends, or the CI-proven egress denial in D5. It is a second, narrower policy shape for a shape of
execution (long-lived, one-endpoint-allowed) that D1–D10 did not address, scoped today to the one
platform (macOS) that has a production long-lived sidecar activation path (ADR-0140).

## Addendum — a contract-level `NetworkGatewayPolicy` and an honest cross-platform posture (2026-09-05)

### D14 — The gateway-allowlist shape moves into `keiko-contracts`, and macOS reuses one Seatbelt formula

`packages/keiko-contracts/src/tools.ts` now carries `NetworkGatewayPolicy` (`{ mode: "gateway",
host: "127.0.0.1" | "::1", port }`), guarded by `isValidNetworkGatewayPolicy` — deliberately not a
general allowlist: one loopback host, one in-range port, nothing else. It is just as deliberately
**not** folded into `NetworkPolicy` (`"inherit" | "none"`, the general keiko-tools spawn-boundary
type every disposable command run's `runCommand` reads): a first attempt at that fold-in was
reverted during review, because widening `NetworkPolicy` to include the gateway object would make
the boundary's existing `!== "none"` check true for a gateway policy too and route it onto the
INHERITED, unconfined path — exactly the fail-open hole `runCommand` must never contain (see that
file's `resolveSpawnTarget`, now an exhaustive `switch` with a fail-closed default for this reason).
The gateway shape instead composes into its own, separate union — `IsolatedRunNetworkPolicy =
NetworkPolicy | NetworkGatewayPolicy` in `keiko-sandbox`'s planning layer only — so
`IsolatedRunPlan.network` accepts it there without widening the general-purpose type every other
`runCommand` caller reads. `planIsolatedRun`/`selectGatewayBackend` (new in `keiko-sandbox`) plan a
gateway-confined run through the SAME `buildWrappedCommand` dispatch every other backend goes
through. The macOS Seatbelt profile string itself now lives in exactly one place, `backends.ts`'s
`buildGatewaySeatbeltCommand`; D11's `buildRuntimeGatewaySeatbeltCommand` is now a thin
thirteen-line wrapper over that same function (its exported name and observable behaviour are
unchanged, so existing callers and D11's own description above still hold). There is no longer a
second, independently-maintained copy of the "(deny network*) plus one port-specific allow" formula.

Linux and Windows remain fail-closed for this policy, and D12's stated gap is now a *reasoned*
refusal rather than silent non-enforcement: `selectGatewayBackend` never selects bubblewrap, unshare,
or a container runtime for a gateway policy, because each of those isolates the child into its own
network namespace with no route back to the *parent's* loopback socket — reachability a general
`network:"none"` deny-all run never needed and a `network:"inherit"` run never isolated either.
`nativeRuntimeProcessBackend.ts` (the backend used for the Windows dev lane and every
release-qualified platform) now accepts an optional `gatewayConfinement` and, when one is attached,
refuses the launch outright with the identical `GATEWAY_UNSUPPORTED_ON_HOST_REASON` string
`planIsolatedRun` would produce, rather than a silent unconfined spawn — its native launch-packet
protocol has no field for a network policy and cannot enforce one; the refusal is also recorded as a
body-free `runtime.confinement.failed` activity-log line, matching the macOS dev-lane path, so a
Windows refusal leaves the same evidence a support bundle can reconstruct. Production composition
(`productionOpenCodeBackend.ts`) always supplies the exact gateway policy, including Windows dev
and release-qualified native lanes. Process-tree qualification alone cannot authorize an unconfined
network launch. Until a native backend can enforce the policy, starting that run refuses before
spawning a helper and records `runtime.confinement.failed`; omitting the policy to keep a launch
working is a fail-open defect. The macOS app-sandbox and dev lanes enforce the same policy through
Seatbelt. #2951 remains open for the Linux network-namespace bridge and Windows-native enforcement,
and these unavailable targets cannot be represented as qualified end-to-end journeys.


## Addendum — the governed tool facade rides the ONE attested loopback destination, never a second (2026-09-05)

### D15 — A second ephemeral loopback listener was a defect, not a second attested destination

A live real-model run under the macOS `keiko-gateway` Seatbelt profile (#3390) showed EVERY
`keiko_*` tool call failing with Bun's `ConnectionRefused` ("Was there a typo in the url or
port?") while OpenCode-native tools (`todowrite`, `question`) kept working. Root cause: D11's
profile allows network-outbound to exactly ONE loopback destination — the attested gateway/BFF
port, per the `NetworkGatewayPolicy` contract this ADR and `packages/keiko-contracts/src/tools.ts`
both describe as "one loopback host, one in-range port, nothing else" — but the OpenCode tool
facade bridge (`packages/keiko-server/src/coding-runtime/opencodeRuntimeComposition.ts`) opened
its OWN ephemeral `createServer().listen(0, "127.0.0.1")` listener and handed the sidecar a
SECOND `KEIKO_TOOL_FACADE_URL` on a different port. That second port was never part of any
attested policy, so the Seatbelt profile correctly denied it — the profile was not the defect; the
second listener was. Because the functional and scripted harnesses never ran under
`sandbox-exec`, this was invisible until the live run.

The fix removes the second listener rather than widening the policy to admit it (D13: this
confinement is additive and stays narrow). The tool facade now rides the SAME single attested
loopback BFF port `/api/coding-sidecar/gateway/*` already uses, at a sibling route,
`POST /api/coding-sidecar/tool` (`packages/keiko-server/src/coding-sidecar-tool-facade.ts`),
dispatching directly to the active run's bridge (`OpenCodeRuntimeComposition.toolBridge.handle`)
— the SAME bearer-capability authentication and admission gate
(`maxInFlight`/`requestDeadlineMs`/abort-on-close) the retired listener enforced, reached through
the BFF's existing request/response instead of a raw socket. Production composition derives both
`gatewayUrl` and `toolFacadeUrl` from the ONE loopback origin
(`productionOpenCodeActivation.ts`), never from a second, independently-bound port; nothing in the
composition module calls `.listen()` for this bridge any more (the public bridge port exposes
exactly `{ url, requestDeadlineMs, handle }` — a fixed origin, the admission gate's own deadline
number, and the dispatch function; structurally excluding a listener/socket surface). The scripted
functional harness's fake sidecar, which needs a real HTTP endpoint to exercise, owns its own
tiny listener wrapping this SAME `handle` (`opencodeFunctionalHarness/_support.ts`,
`opencodeRuntime.real.test.ts`'s `createToolFacadeHarness`) — never a second production path.

This does not change D11's policy shape or D14's `NetworkGatewayPolicy` contract: the invariant
"exactly one attested loopback destination" is unchanged. What changed is that the tool facade now
actually honours it, instead of silently assuming a second port would be reachable.

**Body-ingestion deadline (2026-09-05 follow-up).** The retired listener read the request body
itself under the admission gate's `requestDeadlineMs` timer, so a slow or stalled POST was bounded
by that SAME deadline from the moment the connection was admitted. Routing through the BFF's
`readJsonObject` initially lost that bound: the gate's timer only starts once `bridge.handle` is
called, i.e. after the whole body has already arrived, leaving body-ingestion time bounded only by
Node's generic `http.Server` defaults. The route now bounds ingestion itself
(`readToolFacadeBody` in `coding-sidecar-tool-facade.ts`), racing `readJsonObject` against the
SAME `bridge.requestDeadlineMs` the admission gate exposes for exactly this purpose, and responds
`408 CODING_TOOL_FACADE_DEADLINE_EXCEEDED` (logged as `coding-sidecar.tool-facade.rejected`,
reason `deadline`) if the body has not finished arriving in time — without destroying `ctx.req`,
since request and response share one connection and destroying it would prevent that very 408 from
being sent.


## Addendum — the Git executable admitted into the process-exec allowlist is attested, not path-trusted (2026-09-05)

### D16 — Do not allowlist conventional Xcode/CommandLineTools paths unconditionally

Review on PR #3394 (T47) identified that D11's original `process-exec` allowlist admitted every
conventional Apple Git path unconditionally — `/usr/bin/git`,
`/Library/Developer/CommandLineTools/usr/bin/git`, and
`/Applications/Xcode.app/Contents/Developer/usr/bin/git` — by a fixed, hardcoded list
(`APPLE_GIT_EXECUTABLES` in `backends.ts`). None of those paths is an immutable system binary: a
local user (the same actor D11's whole boundary exists to contain once inside the sandbox) can
replace the file at any of them, and the sidecar would then execute that substitute with its
inherited process context and the D11 gateway egress carve-out still attached. Hardcoding the
paths meant the allowlist trusted *location* instead of *identity*.

The fix, `packages/keiko-sandbox/src/darwin-git.ts`, resolves and attests the ONE Git executable
the profile admits, at every launch, instead of trusting any fixed path:

- `resolveDarwinGitExecutable` shells out to `/usr/bin/xcrun --find git` — Apple's own protected
  resolution launcher, itself attested before it is invoked — rather than guessing among
  conventional install locations. This lets Xcode/CommandLineTools selection (`xcode-select`)
  determine which Git the host actually uses, without the caller choosing a path from an
  attacker-influenced `PATH`.
- `attestDarwinGitExecutable` then independently qualifies the resolved path before it is allowed
  anywhere near a Seatbelt profile: the candidate must be an absolute, `\0`-free path whose
  `realpathSync` resolution is itself (no symlink indirection), a regular file with exactly one
  hard link, owned by `uid 0`, not group- or other-writable: and every directory from its parent up
  to the filesystem root must be a non-symlink directory, owned by `uid 0`, and not group- or
  other-writable either. Any failure — including any thrown `fs` error, e.g. the path not existing
  — is caught and converted into the single closed outcome, `throw new Error(
  "runtime-gateway-git-untrusted")`; there is no partial-trust fallback. A qualifying executable's
  SHA-256 digest is computed and returned alongside its path (`AttestedDarwinGitExecutable`).
- `buildGatewaySeatbeltCommand` (`backends.ts`) and `buildRuntimeGatewaySeatbeltCommand`
  (`runtime-gateway.ts`) no longer carry any hardcoded Git path at all: both now take the attested
  `childExecutable` as a required parameter and admit exactly `{command, childExecutable}` into the
  `process-exec` allowlist — nothing else, ever. `devLaneRuntimeProcessBackend.ts` calls
  `resolveDarwinGitExecutable()` once per launch (test seam:
  `DevLaneRuntimeProcessBackendOptions.resolveGitExecutable`), passes its `path` into
  `planIsolatedRun`'s new `gatewayChildExecutable` field, pins the resolved executable's directory
  as the child's `PATH` (so the sidecar cannot shadow-resolve a different `git` off an inherited
  `PATH`), and records the attested digest — never the literal path or file content — in the
  existing `runtime.confinement.spawned` activity line's `extra.childExecutableDigest`
  (`childExecutablePolicy: "runtime-and-attested-git-only"`). Attestation failure surfaces through
  the same existing `spawnOwnedTree` try/catch as every other confined-launch failure: a body-free
  `runtime.confinement.failed` line (`errorKind`, Keiko stack frames, cause chain, the run's
  correlation id) records the refusal, and the launch fails closed with no process ever spawned.

This narrows D11's process-exec allowlist without widening it: the allowed set is still exactly
`{runtime executable, one Git executable}`, but the Git member is now qualified by ownership and
content identity rather than assumed from its location. D13 still holds — this is not a relaxation
of any D1–D10 denial, only a tightening of what D11 already restricted. The regression pin in
`backends.test.ts` (`buildGatewaySeatbeltCommand child process policy`) now asserts the profile
never contains the literal Apple paths or `Xcode.app`/`CommandLineTools` substrings, alongside
`darwin-git.test.ts`'s coverage of the user-writable-directory rejection and (on a real Darwin
host) `resolveDarwinGitExecutable`'s successful resolution through `xcrun`.
