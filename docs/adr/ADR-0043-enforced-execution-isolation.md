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

1.3 — Issue #3422 moves the internal Linux gateway launcher into the `keiko-sandbox` enforcement
boundary while `keiko-tools` remains the disposable-command spawn boundary, replaces its
same-uid-discoverable filesystem relay with an anonymous descriptor-transfer channel, and records
the kernel-proven private diagnostics-descriptor lifecycle. Issue #3451 binds that primitive to the
release-qualified `linux-x64` runtime and its exact production evidence (2026-09-10).

1.4 — PR #3452 adds D17: the verification orchestrator installs a workspace's declared dependencies
before its script steps, the one verification command that keeps host network. A managed task
worktree is a clean checkout, so without it no project created from nothing could be verified
(Coding Workbench run 15, 2026-09-10). D17 also records the sources such an install may use and its
refusals (2026-09-11).

1.5 — PR #3452 review: D17's install no longer has open egress. npm reaches the network only
through a loopback proxy that tunnels to the approved registry, with Git dependencies refused, and
the install's tunnels and refusals are counted on its summary and activity line (2026-09-11).

1.6 — PR #3452 review: the pre-install check also reads the manifest of every workspace member npm
would install, and npm itself refuses what the proxy cannot see: `allow-remote=none`,
`allow-file=none` and `allow-directory=root` join `allow-git=none` (2026-09-11).

1.7 — #3873 (F14): D17's completion line makes the wall time of a verification run attributable from
one persisted line — the report's total and per-step durations and statuses, the isolation probe's
duration, the isolation backend and egress policy that applied, and the bootstrap's outcome —
without recording a command, argument, path or output (2026-10-06).

1.8 — #4068 adds D19: an administrator installs the Windows broker once and ordinary launches never
elevate (2026-11-02); and D20: governed repository verification on Windows stays container-backed
(2026-11-03).

1.9 — #4068 amends D18 with the confined Windows tree's filesystem grants and the host's inbound
control connection into it, and D19 with the broker lookups a standard user can make (2026-11-06).
D18 also gains the sweep of stale tree entries a crashed supervisor left (2026-11-07) and the
per-user lock that serializes concurrent runs' grant edits (2026-11-09). D19 also pins the
Windows npm runtime package's own supervisor (proposed 2026-11-09, pending repository-owner approval).

1.10 — One-step Windows setup amends D19 (2026-11-17): a healthy `keiko start` installs or repairs
the broker itself, at most one UAC prompt per helper pin, so installing and updating Keiko brings
the service along; the Workbench offers Repair instead of a terminal command, and a full
`keiko uninstall` removes the service in the same command. An installation managed outside the app
(ADR-0121 D9) sets up no service and offers no Repair.

1.11 — #4068 adds D21 (2026-11-19): the runtime supervisor confines every Windows run itself, as
the signed-in standard user, in an AppContainer without network capabilities whose only way out is
a named-pipe relay to the attested loopback ports. No launch uses the D18/D19 broker any more;
`keiko start` no longer sets it up, and the Workbench offers no Repair. The work location of D18 is
widened to the operator's own folders, with the protections D21 names.

1.12 — #4522 amends D17 (2026-11-23): where no step can run on this host but the native runtime's
own shell runs the checks there, the bootstrap installs for that shell (`host-shell`) with
`--no-save`, leaves a tree it did not install alone, and refuses with three closed reasons of its
own what such an install cannot give.

1.13 — #4496 records the owner's Gate G1 approval of 2026-11-25 in D20 and D21: a Windows host
without a container runtime runs governed verification steps in the pinned supervisor's per-run
AppContainer (`windows-appcontainer`, step mode), in a private copy of the workspace without
credential-named entries; a host with a container runtime keeps its container path. The VM
measurement of the same day replaced the planned isolatedWin32 capabilities, which `CreateProcessW`
refuses an AppContainer, and the profile list entries with per-step `subst` drive letters, through
which Node.js and Java steps run.

1.14 — #4495 amends D21 (2026-11-25): a run's profile names the supervisor that created it, and a
later launch removes the profiles of runs whose supervisor is gone; a launch without an interactive
desktop and a supervisor path that is too long are refused with closed reasons; the reap proof's
root exit code reaches the Activity Log, and the relay root's own failures take exit codes of their
own.

1.15 — #4492 amends D20 (2026-11-25): the step supervisor starts with an empty environment and the
step's environment travels in its launch frame only; a refusal reaches the Activity Log with its
closed code; a search-path entry that reaches a granted folder through a junction is named by that
folder's drive letter.

1.16 — #4492 amends D20 (2026-11-25): a Maven project (a root `pom.xml` and no root
`package.json`) runs its tests on the step backend as `mvn -B -o test`, offline, into a repository
of its own inside the execution root, with the person's `%USERPROFILE%\.m2\repository` chained
read-only behind it; every other backend keeps the project's closed "no script" skip.

1.17 — #4492 amends D21 (2026-11-26): the Standalone/portable Windows payload carries the same
patched step Node.js as the npm runtime package, at `runtime/step-node/node.exe`, staged from the
digest-pinned `win32-x64` runtime package and verified against the same server pin; no signing lane
signs it.

1.18 — #4496 amends D21 (2026-11-26): a toolchain root inside or containing the profile's `.m2` is
never granted, nor a toolchain folder (the step executable's own and the `JAVA_HOME`, `MAVEN_HOME`
and `M2_HOME` folders) that directly holds a credential-named entry or cannot be listed;
`MAVEN_HOME\conf` stays readable. Every containment test compares real drive paths (long names,
links and junctions resolved), and `.m2` is compared both where the profile names it and where it
really lies, so a relocated `.m2` cannot hide an overlap either; a folder whose real path cannot be
resolved is no folder, and without a known profile folder every step is refused. As on macOS, no
toolchain root may be a drive root or hold or sit inside one of the profile's credential stores:
the macOS home denials (`.ssh`, `.aws`, `.cargo\credentials.toml`, `.config\gh`, …) plus the
Windows credential and DPAPI folders under `AppData`, compared named and resolved; and the step's
execution root is refused when its real path cannot be resolved, never granted by its spelling.

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

_Amended 2026-11-12 ([ADR-0183](ADR-0183-linux-desktop-community-tier.md)): the existing Linux
backends stay and keep their CI proof, but new isolation capabilities are qualified on macOS and
Windows only; on Linux they reuse an existing backend or report themselves unavailable._

## Decision

### D1 — A dedicated, reusable isolation package

Introduce `@oscharko-dev/keiko-sandbox`, a near-leaf package (depends only on `keiko-contracts` for
the `SandboxPolicy`/`NetworkPolicy`/attestation types). It owns the **isolation strategy only**:
backend availability probing, deterministic per-platform backend selection, pure construction of the
wrapper argv/profile that denies egress, a content-free `SandboxAttestation` (`{ backend,
networkEnforced, platform }`), and the fail-closed verdict. The disposable `network: "none"` builders
and selection remain pure functions and the probe remains a thin filesystem read. The gateway-only
Linux extension in D12 additionally owns the internal namespace and relay subprocesses because their
lifecycle is the enforcement boundary itself; consumers still receive one wrapped command. The
package is the platform's reusable isolation owner, consumable anywhere an enforced run is needed.

### D2 — One spawn boundary applies the wrapper

The single disposable-command subprocess boundary remains `keiko-tools/src/exec.ts` `runCommand`.
When a caller passes
`policy.network === "none"` or `policy.filesystem === "execution-root"`, `runCommand` asks keiko-sandbox for an enforcing wrapper and spawns the
wrapped command, recording the attestation on `CommandResult`. No second spawning path is introduced
(preserving the ADR-0019 invariant that verification and tools share one command boundary). Callers
that request neither boundary are unaffected — egress enforcement is opt-in per call, so the
read-only command tools keep `network: "inherit"` and their existing behaviour.

The retained Darwin execution-root environment mapping uses the server-owned
`npm_config_script_shell=/bin/sh` for `npm`/`npx`. It is not currently selected by assured macOS
admission, which requires the container lifetime owner (D9); direct native containment fixtures
qualify the shell/path seam independently. npm extends `PATH` with caller and ancestor bin
directories; an inaccessible foreign bin directory can make its bare `sh` lookup fail even
though the system shell is already admitted. Binding that existing executable preserves the
original `PATH`, workspace bin resolution, the outer `shell: false` spawn and all filesystem and
network rules. Ambient shell overrides are not accepted. Other commands and backends retain
their existing environment policy.

D12's gateway-only Linux wrapper does not create another product command boundary: the planned child
is still one command to the consumer, while the package-private launcher owns only the inseparable
namespace peer, anonymous descriptor relay, and target-child lifecycle needed to enforce that plan.

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

### D9 — Filesystem confinement for repository verification

Both assured pre-filter execution and in-place repository verification request
`filesystem:"execution-root"`. In-place runs still operate against the selected real workspace,
including ordinary package scripts and targeted tests, but repository code may write only inside
that root and sandbox temporary storage. The governed command runner uses the same existing policy.
Strict bubblewrap on Linux or Docker/Podman must enforce the requested execution-root boundary.
Linux execution-root bubblewrap always uses `--unshare-pid`, including explicit inherited-network
runs. Its private `/proc` excludes host processes, confined code cannot signal them, and the PID
namespace reaps detached descendants when the main command exits. The compatibility network-only
wrapper retains its existing contract. Actual compiled `runCommand` controls qualify both an owned
foreign-process signal/visibility refusal and zero acting descendants after successful settlement,
with a held-main detached-write positive control.
The child's `/tmp`, `HOME` and `TMPDIR` are the caller's per-run ephemeral home: a direct child of
the mounted root, created before spawn and removed in every settle path, because whatever the child
writes there (npm logs, Node's compile cache) would otherwise stay in the real workspace and make a
later verified commit's clean-candidate fact false (PR #4095). Without one, the shared
`.keiko-sandbox-tmp` directory of the root is used; a per-run directory anywhere else fails closed
before spawn.
On macOS, assured execution-root runs select Docker/Podman with its existing private PID namespace
and container lifetime; without one, admission fails closed before spawn. Filesystem-scoped Seatbelt
cannot own a detached `setsid` descendant after the command exits, so it no longer qualifies for
this selection. Network-only native Seatbelt and gateway routes retain their existing qualified
contracts. The direct macOS containment profile denies reads and writes outside the canonical
accepted root, except
readonly OS/runtime paths, narrowly selected toolchain libraries, and ancestor directory metadata.
It grants neither the entire `/opt` or `/usr` trees nor Homebrew `var` and `etc`. Homebrew-linked Node
uses library-file reads and toolchain metadata; it does not receive a general Homebrew data grant.
Only the dyld boot directories themselves and the selected OS runtime subtree are readable; unrelated
Preboot children stay denied. Writes and the ephemeral HOME/TMPDIR stay within the accepted root,
including writes from descendants. Symlink escapes and service-mediated filesystem escapes stay denied.
The direct native profile restricts its scoped signal and process-info APIs to the sandbox and
process itself. Those controls do not provide a PID namespace or exclude every process metadata
API: sysctl process-table and argument queries are outside that qualified proof. They prove
individual file, network, signal and process-info restrictions only, not full process isolation
or command lifetime. The actual isolated regression returned
`exitCode:0` while a detached owned child could still write after settlement. Signaling the original
process group cannot contain a child that has left it. Native macOS assured execution may qualify
again only with the existing attested descendant owner wired through the command lifecycle, with
actual zero-live settlement proof; that integration remains follow-up work in #3899/#3901.

`network:"none"` denies host and external network access. The direct Seatbelt profile also denies
its own loopback, whereas the container has a private loopback namespace. An explicitly selected
`network:"inherit"` preserves the selected execution-root boundary and truthfully reports
`networkEnforced:false`; it never upgrades a `none` or gateway policy. Coding Workbench command and
verification producers still select `none` behind the accepted Authority Envelope. A test requiring
its own isolated loopback namespace needs a qualifying container/backend; Seatbelt does not silently
grant host loopback or detect that requirement from the test body. On macOS, containers are selected
at admission for execution-root work, never as a retry after a native test fails. Container
`network:none` separates host loopback from container-local loopback; actual platform evidence must
qualify that distinction, and no host network/PID namespace is granted. The command
attestation reports filesystem and network enforcement separately. No compatible backend means
execution is refused before spawn.

Pure planners require the caller's already canonical workspace-contained cwd, and the spawner must
actually enter that directory. `runCommand` owns both operations; the platform proof supplies both
instead of passing a `/var` alias and inheriting the test runner's cwd. The retained direct Darwin
profile fixture binds `OPENSSL_CONF=/dev/null` so Node does not
import ambient Homebrew OpenSSL configuration outside its root. Explicit policy-admitted OpenSSL
environment configuration, Node crypto flags, and admitted `NODE_OPTIONS` remain intact. Workspace
configurations work in that profile proof; configurations outside the admitted root remain refused
by its filesystem boundary. These fixture facts do not certify Seatbelt command lifetime, a native
assured execution route, FIPS certification or support for external provider modules.

The Docker fallback resolves only the selected local engine endpoint before spawning: a canonical
Unix socket outside the execution root, or a Windows named pipe under the local `npipe:////./pipe/` namespace (including Docker Desktop's Linux engine). Remote or
unavailable contexts fail closed with a body-free reason. Like a missing socket, a well-formed
local pipe that no engine serves (Docker Desktop installed but stopped) is unavailable; it is never
reported as an enforcing backend whose `docker run` then fails as the verified step (#4068,
2026-11-09). A Unix socket file a crashed or stopped engine left behind still stats as a socket,
so a verification run also asks it for `/_ping` once (two seconds) before it counts the engine:
only an engine that answers `200` is available. A refused connection, no answer or another status
is unavailable, the server never runs the Docker client for it, and the verification's completion
line records the closed answer as `isolationEngine` (`answered`, `refused`, `unanswered`,
`rejected`; #4519, 2026-11-22). The CLI receives the local endpoint
explicitly while HOME stays empty; Docker configuration and credentials are never forwarded.
Container commands use the allowlisted executable name from the image's PATH, not a host symlink
target such as `npm-cli.js`. Native wrappers continue to use the validated absolute host executable.

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
`packages/keiko-server/src/coding-runtime/devLaneRuntimeProcessBackend.ts` is the sole Seatbelt
caller: it refuses to spawn the sidecar at all when no
confinement policy is attached, or when the policy's `runId`/`treeBindingId` drift from the launch
request, before any process exists.

The runtime supervisor also records a launch-bound, content-free prepared-wrapper attestation for
the exact runtime/model-source pair. That attestation binds the enforcing backend and platform, the
closed runtime and model sources, the Authority Envelope digest, the reviewed-egress receipt, and
the canonical policy digest. Proxy and CA identities, when present, are represented only as digests;
endpoints, paths, headers, tokens, and credentials are excluded. Any binding drift invalidates the
attestation and fails the launch before a runtime tree is owned.

### D12 — macOS and Linux are product-wired; Windows remains fail-closed

`buildRuntimeGatewaySeatbeltCommand` remains the enforcing macOS product path (ADR-0140). Issue
#3422 adds the corresponding Linux primitive to the generic isolated-run planner: when bubblewrap
or unshare is available, `selectGatewayBackend` chooses that native namespace backend and
`buildWrappedCommand` starts the packaged internal launcher in `runtime.ts`. The host and namespace
launchers communicate over one anonymous Node IPC socketpair inherited on descriptor 10. The
namespace peer exposes the validated port on its isolated loopback interface and requests a stream
with a bounded, monotonically increasing connection id. The host alone connects to the validated
gateway address and port and passes that already-connected TCP descriptor over the anonymous
socketpair. There is no filesystem socket name, temporary relay directory, or reconnectable bridge
capability for a same-uid sidecar to enumerate across concurrent runs. The sidecar starts only after
the namespace listener is ready and its readiness message has crossed the IPC channel; descendants
inherit the network namespace. No host network namespace, veth, NAT rule, root, or ambient
`CAP_NET_ADMIN` is granted. Parent-death, signals, relay failure, and cleanup stay inside the
wrapper's fail-closed lifecycle.

The original V2 service launch additionally opts in to a bounded reverse route using
`KEIKO_LINUX_GATEWAY_SERVICE=1`. Ordinary gateway commands do not opt in. The same anonymous IPC
owner accepts one closed loopback service announcement, binds a fresh host-loopback listener, and
publishes that listener's endpoint to the existing authenticated protocol client. Accepted TCP
sockets cross the private IPC channel to the namespace launcher, which connects only to that
first, immutable namespace-local service port. It rejects the gateway port itself, additional
announcements, changed destinations, replayed connection ids and malformed handles. Each direction
is bounded to 64 connections; pending producer output across both streams is bounded to 64 KiB. The runtime's random
per-run Basic credential remains required by its original HTTP server. The target receives neither
the opt-in marker nor an IPC descriptor, and reap, disconnect or failed transfer closes the
listener and its sockets. This supplies the service's control route without giving it another
host destination or weakening its network namespace. The existing `runtime.confinement.spawned`,
`runtime.confinement.failed` and runtime handshake evidence describe the launch and its outcome;
the forwarding code does not log an endpoint, header, credential or request body.
The opted-in service also receives a PID namespace (`bwrap --unshare-pid` or
`unshare --pid --fork`) under the same launcher owner, without requiring a `/proc` remount.
The matched Linux process backend retains the declared `stdin-eof` lifetime and ends that pipe
for a graceful stop. A forced signal, pipe failure or unclean wrapper exit cannot prove complete
reaping: both the wait and reconciliation paths retain recovery-required state and issue no reap
receipt. Session persistence consequently cannot copy a database while its producer may still run.


Launcher failures cross a dedicated descriptor-3 diagnostics channel that the server provisions
only for the Linux wrapper. The host launcher relocates that pipe to descriptor 9 when entering the
network namespace and reserves descriptors 3 through 8, keeping Bubblewrap's low-numbered lifecycle
eventfds away from it. The pipe is not claimed through `--sync-fd`, whose eventfd semantics make it
unwritable for text diagnostics. The namespace launcher removes both descriptor 9 and its marker
environment variable before spawning the sidecar. It also closes descriptor 10 and removes Node's
IPC marker variables, so the sidecar can neither forge launcher evidence nor request or receive a
gateway handle.
The server accepts only the closed launcher error vocabulary and records the first failure as
`runtime.confinement.failed`, with the run correlation id and body-free backend/source fields. A
missing diagnostics pipe refuses the launch and terminates the just-spawned unowned process tree.

The Linux reference-runner test proves the mechanism rather than an argv string: the unconfined
child completes a PING/PONG exchange with a hostile ephemeral loopback listener, the same child
under the planned gateway
wrapper cannot reach that listener or a concurrent run's port, and two isolated runs can each
complete the same data round trip only through their own real gateway listener. The hostile second
sidecar also enumerates the shared temporary directory and tries every legacy `relay.sock` it finds:
the regression proof fails against the former filesystem bridge because both concurrent gateway
destinations are reachable, and passes only when no reconnectable bridge exists. Missing namespace
tools on Linux fail that reference proof. Containers remain ineligible because no equivalent bridge
is compiled for them.

Issue #3451 establishes Linux product coverage by adding `linux-x64` to the closed long-lived and
portable target vocabularies, staging the exact launcher, Node.js, OpenCode, USearch, supervisor,
and secure-read payload, and routing production composition through this namespace gateway. The
exact staged runtime must pass the non-vacuous reference proof above; its content-bound
qualification receipt is signed through the protected release environment with GitHub OIDC and is
verified offline against the embedded Sigstore trust root and exact repository/workflow identity on
a fresh read-only runner and again at point of use. Missing namespace support, receipt drift,
component drift, a stale source commit, or a backend other than `linux-namespace-gateway` keeps the
runtime unavailable before spawn. Windows production composition already attaches the exact gateway
policy to its native backend, but the native protocol/helper cannot enforce it, so it refuses before
spawn with `GATEWAY_UNSUPPORTED_ON_HOST_REASON`. Issue #3423 owns the exact-port WFP implementation;
the cross-platform acceptance criterion remains open only on that Windows-native proof.

### D13 — Does not relax D1–D10

This confinement mechanism is additive: it does not change `network: "none"`, the disposable-run
backends, their `keiko-tools` spawn boundary, or the CI-proven egress denial in D5. D12's
package-private launcher is the enforcement implementation for the new gateway-only plan, not a
second general-purpose command execution API. It is a second, narrower policy shape for a shape of
execution (long-lived, one-endpoint-allowed) that D1–D10 did not address. macOS enforces it through
Seatbelt; release-qualified Linux enforces it through D12's anonymous descriptor bridge and private
network namespace. Neither changes any disposable-run argv.

## Addendum — a contract-level `NetworkGatewayPolicy` and an honest cross-platform posture (2026-09-05)

### D14 — The gateway-allowlist shape moves into `keiko-contracts`, and macOS reuses one Seatbelt formula

`packages/keiko-contracts/src/tools.ts` now carries `NetworkGatewayPolicy` (`{ mode: "gateway",
host: "127.0.0.1" | "::1", port }`), guarded through `copyNetworkGatewayPolicy` — deliberately not
a general allowlist: one loopback host, one in-range port, nothing else. The copier accepts only a
plain/null-prototype object with exactly three own data descriptors, never invokes accessors,
rejects hidden/symbol/extra fields, and returns a frozen data-only record. It is just as deliberately
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

Linux now selects bubblewrap, then unshare, only because D12's packaged anonymous descriptor bridge
supplies the missing fixed route back to the host gateway without exposing the host network
namespace or a reusable filesystem capability.
Absence of both primitives fails closed; a container runtime is never substituted because no
container bridge implements the same contract. Invalid/accessor-backed gateway values fail as
`invalid-network-policy` before a child is compiled, rather than being mistaken for the narrower
`network:"none"` shape.

Windows remains a reasoned refusal rather than silent non-enforcement:
`nativeRuntimeProcessBackend.ts` accepts an optional `gatewayConfinement` and, on Windows when one
is attached, refuses the launch outright with the identical `GATEWAY_UNSUPPORTED_ON_HOST_REASON` string
`planIsolatedRun` would produce, rather than a silent unconfined spawn — its native launch-packet
protocol has no field for a network policy and cannot enforce one; the refusal is also recorded as a
body-free `runtime.confinement.failed` activity-log line, matching the macOS dev-lane path, so a
Windows refusal leaves the same evidence a support report can reconstruct. Production composition
(`productionOpenCodeBackend.ts`) always supplies the exact gateway policy, including Windows dev
and release-qualified native lanes. Process-tree qualification alone cannot authorize an unconfined
network launch. Until a native backend can enforce the policy, starting that run refuses before
spawning a Windows helper and records `runtime.confinement.failed`; omitting the policy to keep a
launch working is a fail-open defect. Under D19 a release-qualified package, an independently
approved Windows evaluation artifact, a Windows dev checkout or the Windows npm runtime package
yields a pin for the broker that enforces it. Other Windows evaluation artifacts yield none, so they
refuse every start, and readiness reports `gateway-service-unqualified` instead of offering one.
The macOS app-sandbox, npm-runtime and explicit dev lanes
enforce the same policy through Seatbelt. A generic supervisor-prepared loopback wrapper never bypasses the exact gateway policy:
both prepared and direct backend launches derive the final wrapper from the same server-owned
policy. The sealed helper receives that exact wrapper in its existing launch packet.

For the staged native-service filesystem foundation, this same Seatbelt owner denies filesystem
access by default and admits a root union: read-only accepted workspace, read/write private per-run
native state, immutable runtime and narrowly required OS/Git support. Canonical roots are revalidated
immediately before launch, private state must belong to the current user with no group/other access,
and its writable root must never contain the accepted workspace or overlap the immutable runtime.
The normal `<workspace>/.keiko` per-run private metadata subtree remains writable; workspace code
files outside that exact subtree remain read-only. The closed logged workspace access fact is
`read-only-outside-private-state`, rather than an unconditional read-only claim. Root identity is transient and
bound into the existing policy digest; existing `runtime.confinement.spawned` evidence adds only
closed filesystem/access facts, never paths. Actual OS probes prove workspace writes and foreign
file/symlink reads are denied while private-state writes remain possible. The kernel cannot
separate runtime-internal reads from model reads of the same admitted inode: canonical native
permission enforcement for sensitive workspace paths and private-state access remains mandatory
before production native tools are admitted. Workspace reads in this foundation do not widen any
mode's mutation authority; production native workspace effect tools remain denied.

#2951 remains open for #3423's Windows-native WFP enforcement. The Linux target is
represented only after #3451's exact staged payload, offline-attested qualification, fresh-runner
verification, and reference-runner proof all pass; no source-only or declared Boolean can qualify
it.

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
paths meant the allowlist trusted _location_ instead of _identity_.

The fix, `packages/keiko-sandbox/src/darwin-git.ts`, resolves and attests the ONE Git executable
the profile admits, at every launch, instead of trusting any fixed path:

- `resolveDarwinGitExecutable` shells out to `/usr/bin/xcrun --find git` — Apple's own protected
  resolution launcher, itself attested before it is invoked — rather than guessing among
  conventional install locations. It first attests the Git selected by `xcode-select`. If that
  candidate is unavailable or untrusted, it asks the same protected launcher for Git under the
  fixed `/Library/Developer/CommandLineTools` developer directory and subjects that candidate to
  the identical attestation. Neither attempt inherits a caller-selected `PATH` or `DEVELOPER_DIR`.
- `attestDarwinGitExecutable` then independently qualifies the resolved path before it is allowed
  anywhere near a Seatbelt profile: the candidate must be an absolute, `\0`-free path whose
  `realpathSync` resolution is itself (no symlink indirection), a regular file with exactly one
  hard link, owned by `uid 0`, not group- or other-writable: and every directory from its parent up
  to the filesystem root must be a non-symlink directory, owned by `uid 0`, and not group- or
  other-writable either. Any failure — including any thrown `fs` error, e.g. the path not existing
  — is caught and converted into the single closed outcome, `throw new Error(
"runtime-gateway-git-untrusted")`. If the selected candidate fails, the fixed Command Line Tools
  candidate must pass every same check; otherwise launch still fails closed. A qualifying executable's
  SHA-256 digest is computed and returned alongside its path (`AttestedDarwinGitExecutable`).
- `buildGatewaySeatbeltCommand` (`backends.ts`) and `buildRuntimeGatewaySeatbeltCommand`
  (`runtime-gateway.ts`) no longer carry any hardcoded Git path at all: both now take the attested
  `childExecutable` as a required parameter and admit exactly `{command, childExecutable}` into the
  `process-exec` allowlist — nothing else, ever. `devLaneRuntimeProcessBackend.ts` calls
  `resolveDarwinGitExecutable()` once per launch (test seam:
  `DevLaneRuntimeProcessBackendOptions.resolveGitExecutable`), passes its `path` into
  `planIsolatedRun`'s new `gatewayChildExecutable` field, pins the resolved executable's directory
  as the child's `PATH` (so the sidecar cannot shadow-resolve a different `git` off an inherited
  `PATH`), and records the attested digest and closed selection source — never the literal path or
  file content — in the existing `runtime.confinement.spawned` activity line's
  `extra.childExecutableDigest` and `extra.childExecutableSource`
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

**Scope (amended 2026-11-01, customer 1.3.4).** Attestation qualifies the Git member of a
`process-exec` allowlist, so it applies where such an allowlist exists: the `keiko-gateway` profile.
The `keiko-native` profile (#3897) has no `process-exec` allowlist; its shell already runs the
host's toolchains from the launcher's allowlisted `PATH`
(`childExecutablePolicy: "toolchain-inherited"`). Attesting a Git there protected nothing the native
profile did not already permit, and it refused every native run on a managed Mac whose only Git is
Xcode's under the admin-writable `/Applications` (root:admin 0775) and that has no Command Line
Tools. One rule, `runtimeProfileAttestsGit` in `runtimeGatewayProcessSandbox.ts`, decides this for
every confined launch: `devLaneRuntimeProcessBackend.ts` and the macOS native-helper fallthrough of
`nativeRuntimeProcessBackend.ts` resolve and attest Git only for the gateway profile; a native run
keeps the launcher's `PATH` unchanged and records no child-executable digest.
The gateway profile still fails closed without an attested Git. The macOS native helper cannot carry
the `keiko-native` profile today: its rendered launch packet exceeds the helper's 4 KiB argument
bound, and the helper requires the Apple-signed monitor. The shared rule keeps that fallthrough
consistent so a future helper launch inherits the same Git decision instead of a second copy.

## Addendum — dependency installation is host-executed network I/O with lifecycle scripts disabled (2026-09-10)

### D17 — The verification orchestrator installs a workspace's declared dependencies before its script steps

D1–D10 confine every verification step to `network: "none"`, and D13 keeps that. A managed task
worktree, however, is a clean checkout: it has the manifest a governed run wrote and none of the
dependencies the manifest declares. Every `build` or `typecheck` step therefore failed within
200 ms on a missing binary, and the run had no governed way to install anything — the tool catalog
offers no command tool, and the one egress tool (`keiko.research.fetch`) is unavailable to a
coding run (Coding Workbench run 15, 2026-09-10, PR #3452). Verification of a project created from
nothing was impossible by construction.

The dependency bootstrap (`packages/keiko-verification/src/dependencies.ts`) closes that gap at the
layer that owns the plan. It prepares only a plan with a step that would run on this host: where
no enforcing backend is available every `network: "none"` step is refused, so nothing is installed
for it and the steps are reported as isolation unavailable, never as missing dependencies (#4519,
2026-11-22). Before the first script step of a plan that has one, the orchestrator
reads the workspace's `package.json`; when it declares dependencies and npm's own hidden lockfile
(`node_modules/.package-lock.json`) is absent or older than the manifest or a lockfile, or Keiko
has not recorded a completed install for that tree, it runs
the fixed base command `npm install --ignore-scripts --no-audit --no-fund --no-progress --loglevel=error`
with the server-owned target flags described below, through the same keiko-tools command boundary
as every step (`DEPENDENCY_INSTALL_COMMAND_RULES`: `npm install` and nothing else, no leading flags, `-c`/`--call` denied), under
`DEPENDENCY_INSTALL_LIMITS` (20 minutes wall time since the 2026-11-24 owner decision, 1 MiB output) and with **host network**. This is the
one verification command that keeps egress, and the reason it may is the same reason D1–D10 deny
it elsewhere: those steps EXECUTE untrusted, model-written code. `--ignore-scripts` disables npm's
lifecycle hooks only. The install runs no project lifecycle script and no dependency's
`postinstall`, but it is itself a host-network process, and the code it unpacks is executed later
by the plan's own steps (`npm run …`, `npx`, `node --test`). Those steps run with
`network: "none"`. The orchestrator's default `networkEnforcement: "enforce-or-fail-closed"`,
which every server verification path uses, requires an enforcing backend and refuses a step it
cannot confine; only a caller that explicitly selects the `inherit` compatibility mode lets steps
inherit host network. The child receives the ephemeral empty HOME every
governed command receives (C5), so only npm's default registry configuration applies, and a
project-level `.npmrc` permits only the closed guard settings `strict-allow-scripts=true`,
`ignore-scripts=true` and `engine-strict=true`, plus blank and comment lines. Every other setting,
unreadable or oversized config, interpolation or unsafe descriptor refuses the bootstrap
(`refused`, `project npm config present`). Config admission is checked again immediately before
the npm spawn and config identity participates in the process-owned installation receipt. The
fixed `--ignore-scripts` invocation and registry-only egress remain in force; a manifest cannot
redirect the install to a registry nobody configured. An unreadable manifest
refuses too; a manifest without declarations, or a workspace without one, is `none` and nothing
runs.

Dependency installation and script execution can run on different platforms. For a canonical
bootstrap decision of `current` or `install`, the server resolves the selected verification target
before reusing or recording an installation receipt. The fixed constant Node metadata probe runs
through the existing `runCommand` boundary with `network: "none"` and
`filesystem: "execution-root"`, under the same selected isolation policy as verification. Decisions
that require no bootstrap do not probe. The closed result contains the effective OS, CPU, libc,
Node version, module ABI and N-API version. Its runtime identity also binds the selected attested
backend and, for a container, the existing default image identifier. That identifier is not an
immutable OCI content digest. Invalid or unavailable target metadata fails closed through the
existing bootstrap failure/refusal path and prevents script execution.

npm still runs on the host through the existing registry proxy, with lifecycle scripts disabled.
The fixed invocation adds only server-produced `--os`, `--cpu` and, where applicable, `--libc`
values for the measured execution target. This selects optional prebuilt native dependencies for
that target rather than assuming the host's platform. It does not cross-compile required native
addons or enable their lifecycle builds; required-package platform and engine checks can still
apply to the host. A package that needs a disabled install script remains unsupported. The real
npm 11.16.0 control qualifies one Linux native binding and one exact-file Vitest test, not generic
native-build or complete OpenCode parity.

The installed tree is shared with whatever else runs in the workspace. The native coding runtime's
shell runs on the host, while this verifier's execution-root backend on macOS is a Linux container,
so an install for the measured Linux target replaced the host's native bindings and broke every
later native npm or Vitest command (PR #4064 review). A native run's verification therefore names
the host platform (`sharedHostPlatform`), and the bootstrap refuses an install whose measured
target has another operating system or CPU (`install-target-foreign`) before npm writes the tree.
The refusal tells the model to run the project's own checks in the native shell, which the native
policy reads as verification evidence (#3901). A run without a host-native consumer installs for
its measured target as before. Every refused bootstrap carries its closed `refusalReason` on the
dependency summary and on `editor.verification.dependencies`. The coding facade names a step behind
an `install-target-foreign` refusal `native-shell-required` instead of `dependencies-unavailable`,
with guidance to run the repository's own command for that check in the shell: in the Keiko 1.3.0
test on macOS the generic reason left the model without a check it could run, and the run settled
`verification-not-evidenced` (#3897). The refused bootstrap still fails the report (D17), so the
port presents such a report, in which every step was skipped, to the model as not run: the reason
and its guidance reach the model instead of a generic verification failure. Every other refused
bootstrap remains a failed verification. Isolation, the refusal and its evidence rules are
unchanged. The shell check the guidance asks for proves the staged commit candidate through the
same verified-commit ticket (ADR-0137, #3907 AC3), so a native run on macOS can commit verified
work.

**The run's own shell as the consumer (#4522, 2026-11-23).** On a Mac without a container runtime
no step can run, so the plan above installs nothing, and below Full access the native runtime's
shell reaches no public registry: a fresh managed worktree, or a fresh clone, could not load its
dependencies at all. Where a native run's verification names macOS as the host platform
(`sharedHostPlatform`), no step of its plan can run on this host, and one of them is a check the host
would run but cannot isolate, or one skipped for the native shell's missing Yarn or pnpm tree, the
orchestrator installs for that shell instead (`consumer: "host-shell"` on the summary and on
`editor.verification.dependencies`). A plan whose every step is skipped for another reason gets no
install. Windows enables this consumer with its own proof (#4496); until then a Windows native run
keeps the plan above. The steps are still refused for isolation and the report keeps
that refusal; the shell then runs the project's own check, which the native policy reads as the
run's evidence (ADR-0137). This install:

- installs for the host as it is: no target probe, no target flags and no foreign-target check, since
  the tree is for the host itself, and its receipt is bound to the host identity;
- adds `--no-save`, so npm writes neither `package.json` nor a lockfile; the hidden lockfile is still
  written and still held to the approved-registry rule after npm exits;
- keeps every other rule of this decision: the source checks, the project `.npmrc` admission, the
  empty HOME, the egress proxy to the approved registry, the limits and the receipt;
- leaves a tree npm finished alone. npm writes its hidden lockfile
  (`node_modules/.package-lock.json`) last in a completed install, so a hidden lockfile newer than
  `package.json` and the lockfiles marks a tree npm finished for them: the person's own install, one
  the shell made through the repository credential relay (ADR-0184), which names a registry this
  install would refuse as a source and a firewalled network would refuse to reach, or one this
  process installed. The shell writes caches into `node_modules` itself, so the shell's tree is
  judged by that hidden lockfile rather than by the full-tree receipt of the steps above: a tree
  this process installed stays `current` while the hidden lockfile is the one its install left
  (bound to the host identity), and one npm rewrote since is left alone like any other. A left-alone
  tree is `none` on its line, with `completionReceipt: "missing"` (or `"changed"` when this process
  still holds a receipt npm has since rewritten) and `completionRecorded`. A folder without the
  hidden lockfile, a tree older than its manifest or lockfiles, a tree this process installed for
  another target, and a folder where an install of this process has not completed (npm may write the
  hidden lockfile before it fails) are installed into;
- refuses before npm runs, with its own closed reason, what such an install cannot give the shell:
  `install-scripts-required` (the root or a workspace member names `preinstall`, `install` or
  `postinstall`, or holds a `binding.gyp` without `gypfile: false`, for which npm runs `node-gyp
  rebuild`, and no tree exists, so a fresh tree would lack that script's output),
  `lockfile-mismatch` (the root lockfile's own entry, or a member entry it records, no longer
  records the manifest's `dependencies`, `devDependencies`, `optionalDependencies` or
  `peerDependencies`; `npm ci` refuses the same state), and `package-manager-unsupported` (a Yarn
  or pnpm project without its installed tree).

The install scripts of the project's dependencies are not refused: many packages declare one they
work without (esbuild checks its binary there), and refusing them would refuse most projects. A
dependency that needs its script, such as a native addon built from source, is left incomplete; the
project's check then fails in the shell and nothing is reported as verified.

Further limits of this install. Its record of what it installed, and of an install it started that
did not complete, lives in the server process: after a restart such a tree counts as finished by npm
when its hidden lockfile is newer than its inputs, and is left alone until its manifest or a lockfile
changes. A finished tree that no longer matches its inputs without a newer manifest or lockfile
(packages removed by hand) is left alone too; the shell's check then fails and nothing is reported
as verified. Only the approved public registry is reachable, within the install's wall-time limit
(`DEPENDENCY_INSTALL_LIMITS.wallTimeMs`). A tree whose manifest or lockfile changed after npm wrote
it is installed into from that registry, so a dependency only an internal repository serves makes
that install fail; the run installs such dependencies in its shell through the credential relay
(ADR-0184).

When this install succeeds, the refusal the model reads (`VERIFICATION_NOT_RUN`) adds one fixed
sentence: the dependencies are now installed for its shell without install scripts, the project's
check is to run there again, and no dependency is to be replaced, removed or reimplemented. The
port forwards only the closed word `installed`; a current tree, a failed install and an install for
the verifier's own steps add nothing. A real-model run that was not told this replaced a dependency
with its own code instead of running the check again (#4530).

A refused, failed or timed-out host-shell install does not replace the step results. The coding
facade presents it as a verification failure that names the dependency failure, with one fixed
sentence for the model per refusal reason and one for every other failure of this install, and the
Workbench card shows `dependencies-unavailable` ("Dependencies missing"), never a failing check;
nothing is reported as verified. For `unapproved-source` that sentence tells the model to install
in its shell with the project's own command and to run the check there, because a registry the
person configured for npm reaches the shell through the credential relay (ADR-0184); only when that
install fails too does it report the blocker (#4491: the general sentence made it stop at once). An
install for the verifier's own steps keeps its card and its answer. On Linux the native runtime needs bubblewrap, which also isolates the steps,
so a Linux run keeps the plan above, and every container-backed path, including
`install-target-foreign` for a container whose target differs from the host, is unchanged. A Mac
whose container runtime is running keeps that plan too: its container steps can run, so the
foreign target is refused as before and the shell gets no install from this path.

Security review (#4522 AC9). The install is a Keiko process over the project's declarations, not
model code, and has the same host-network shape as the rest of this decision: npm itself has no
kernel egress confinement on the host, and the loopback proxy, the pinned registry and npm's
`allow-*` gates confine it. Lifecycle scripts stay off, and the npm canary proves on real npm that
neither a root nor a member script runs and that no lockfile is written. The code the install
unpacks runs later only in the model's shell, inside the Seatbelt boundary and under the mode's
network rule, exactly as a tree the person installed would. The shell's own network rule is
unchanged: below Full access it reaches loopback and the credential relay only, and nothing in this
amendment opens a route for it.

Host network makes every source npm would contact part of that boundary (PR #3452 review: CWE-918,
CWE-494). Before npm runs, the bootstrap checks every source it would be handed. Each specifier in
`dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies`, in the root
manifest and in the manifest of every workspace member, and each root `overrides` value (npm reads
no member's), must resolve through the registry: a version, a range, a dist-tag, or an `npm:`
alias of one. A URL, a Git remote or hosted shorthand, a path or a tarball refuses the bootstrap
(`refused`, `unapproved-source`), and so does a `workspaces` pattern that leaves the workspace.
The members are the folders the `workspaces` patterns name, found as npm finds them
(`node_modules` is never searched and a wildcard never matches a dot-folder) and over-approximated
where that is safe: a negated pattern is ignored, since it only removes members. Members that
cannot be enumerated cannot be checked, so a pattern that uses glob syntax other than `*` and `**`,
that reaches a folder a symbolic link places outside the workspace, or whose search passes its
bounds refuses the bootstrap (`refused`, `workspaces-unresolved`).
Each entry of `package-lock.json`, `npm-shrinkwrap.json` and npm's hidden lockfile of the installed
tree must be the workspace itself, a folder or link inside it, a package bundled in its parent's
tarball, or a package fetched over HTTPS from the approved registry (`DEPENDENCY_APPROVED_REGISTRY`,
npm's default `https://registry.npmjs.org/`, without credentials or another port) against a
Subresource Integrity hash; anything else refuses the bootstrap, and a lockfile that is unreadable
or older than version 2 refuses it as `lockfile-unreadable`. Holding the host to that one public
registry excludes private, loopback and link-local destinations by construction.

A registry package may itself declare a URL, Git, tarball-file or folder dependency, which no
pre-install check can see, so the install is confined as well (`registryEgress.ts`; PR #3452
review, CWE-918). npm runs with `proxy` and `https-proxy` set to a loopback proxy the bootstrap
starts for that one install, an empty `noproxy`, the registry pinned, `allow-git=none`,
`allow-remote=none`, `allow-file=none` and `allow-directory=root`. The proxy tunnels a
`CONNECT` to the approved registry's own host and port and answers every other destination with
`403`: another host or port, an IP literal, a plain-HTTP request. It never sees plaintext: what
flows through a tunnel is npm's TLS session, verified against the registry's certificate. A Git
dependency therefore fails before git runs, a URL before it is fetched, and a tarball file or a
folder, which needs no network and so never reaches the proxy, before npm reads it (`EALLOWGIT`,
`EALLOWREMOTE`, `EALLOWFILE`, `EALLOWDIRECTORY`). `allow-directory` is `root`, not `none`: npm
holds the links it makes for the workspace's own members to the same gate, so `none` refuses
every workspace install, and the folders the root and member manifests may name are refused
before npm runs. npm 11.14.0 added the file, folder and URL gates and 11.15.0 stopped
`allow-remote=none` blocking registry tarballs (npm/cli#9347); Keiko requires npm 11.16.0 or
later, and an npm that fetched a URL anyway would still fail at the proxy. Any refused
destination settles the bootstrap `refused`, including one npm tolerates because it names an
optional dependency and installs around it: a package in the tree still reached for an unapproved
source. A proxy that cannot start never runs npm, and a proxy that faults during the install fails
the bootstrap, because its egress was cut rather than confined. The install reaches the registry directly, as it did before, so a network that requires
an upstream proxy is not supported. After npm exits, the tree it installed is still held to the
same rule through its hidden lockfile: an install that left none, or one naming another source, is
`refused` and its steps are skipped.

The hidden lockfile alone is not completion evidence: npm can write it before returning a failure
and leave a partly unpacked package behind. A successful bootstrap records a process-owned receipt
only after npm exits successfully, the installed tree passes the source check, and registry egress
has no refusal or fault. The receipt is bound to the manifest, lockfiles and installed entries by
filesystem identity, size and change time, together with the measured dependency target and runtime
identity; restored modification times or a receipt from another execution target cannot preserve
it. Keiko writes no completion file in the workspace. Repository-written marker files confer no
authority.
The cache holds at most 32 workspaces, enumerates at most 100,000 installed entries, follows no
directory symlinks and fails closed to reinstall when identity metadata is unavailable. Changed
entries, eviction and process restart require another successful bootstrap. This receipt records
installation provenance, not trust in dependency code; source checks and execution isolation remain
mandatory. The shared verification execution entry point holds the existing workspace mutex across
dependency planning, installation and all verification steps, preventing another managed verification
from modifying dependencies during execution. Admission, acquisition and release emit a correlated
`editor.verification.workspace` event with a workspace digest.

Where the wall time of a run went is attributable from one persisted line (F14, #3873). A Workbench
run's targeted-test verification took 28.5 s while the same path measured 236 ms called directly,
and the log held nothing between `editor.verification.workspace` `acquired` and `released`. The
completion line — `editor.verification.execute` with `state: "completed"`, written for every run that
produced a report whose audit evidence was written, whatever its status, while a run whose execution
threw or whose evidence could not be written leaves its `refused` line with frames and cause chain
instead — now carries the report's own `durationMs` and `outsideStepsMs` (what the dependency
bootstrap's decision and installation and the orchestration took outside any step); each planned
step kind's `<kind>Status` and `<kind>DurationMs` for `test`, `targetedTest`, `typecheck`, `lint` and
`build`, with the slowest step's `maxStepDurationMs`; the isolation probe's `probeDurationMs`, which
runs before the report's own clock starts; the isolation that applied (`isolationBackend`, a closed
sandbox backend or `unknown`, and `isolationAvailable`); the egress policy the orchestrator ran under
(`networkEnforcement`, `enforce-or-fail-closed` for every run of this primitive); and
`dependencyBootstrap`, the bootstrap's outcome, present only when a bootstrap decision ran. Every
value is a closed vocabulary, a boolean or a whole number of milliseconds; no command, argument,
script name, path or output reaches the line. The time a run waited for the workspace is the gap
between its `waiting` and `acquired` workspace lines, and the install's own duration stays on
`editor.verification.dependencies`.

The outcome is part of the report (`VerificationReport.dependencies`: state, lockfile
`present`/`created`/`absent`, npm's exit code, duration, a short redacted detail, the tunnels
and refusals of its egress) and of the activity log (`editor.verification.dependencies`, the same
fields, the counts as `egressAllowed` and `egressRefused`), never the install's output.
`completionReceipt` distinguishes a missing, changed or current receipt; `completionRecorded`
reports whether the completed operation left a reusable receipt.
When the bootstrap does not leave the workspace fit for its steps (`refused`, `failed`,
`timed-out`), the steps are recorded as skipped with that reason and the report is `failed` —
`matchesOverallStatus` applies the same rule on the wire — so a report whose steps all read
"skipped" can be read back to the install that left them without their dependencies. The
bootstrap's redacted output tail reaches the coding model through the orchestrator's
`onStepOutput` seam exactly like a failed step's does (ADR-0126 D3); it is never persisted.

Two bounds follow from this decision rather than being chosen next to it. The governed
verification tool is settled by the tool catalog at
`VERIFICATION_TOOL_MAX_DURATION_MS` (keiko-contracts), derived as the contract's one human-decision
wait for a package-script trust grant plus the install ceiling plus the one step a governed call
runs (it names exactly one verifier) at its own wall-time ceiling plus one settlement grace — the
sandbox default of 30 s never fit a real install-then-build sequence — and the governed-invocation
registry, the sidecar tool bridge and the generated plugin client each outlive that settlement by
the contract's grace, so the facade's answer (the report, or the catalog's own timeout) always
reaches the sidecar. The registry used to hold every invocation for a fixed 30 s whatever its
budget, which cancelled a longer verification before it could report (PR #3452); it now holds a
catalog invocation for its descriptor's budget plus that grace, and keeps 30 s only for staged edits
and cursors, which declare no budget.

D13 still holds: no D1–D10 denial is relaxed for any step that executes code. The bootstrap is a new,
narrower kind of command — network I/O by a trusted host tool over declarations, with execution of
the fetched code deferred to the confined steps — and it is admitted only under that shape.

## Addendum — Windows gateway confinement lifts AppContainer loopback isolation per run (2026-11-01)

### D18 — The SCM broker exempts the confined tree from loopback isolation, inside Keiko's filters

Issue #4068 qualifies the Windows enforcement of D11/D12. The confined root runs in a per-tree
AppContainer; the LocalSystem SCM broker (`native/runtime-supervisor/windows/gateway_service.c`)
installs Keiko's WFP filters for that SID at `ALE_AUTH_CONNECT`: block every destination, permit
only the attested gateway port on loopback, with a durable deny guard that outlives the broker.
The installed transport proof showed that this alone cannot reach the gateway: Windows'
application-isolation sublayer drops loopback traffic from an AppContainer at the listener
(`ALE_AUTH_RECV_ACCEPT`) unless the AppContainer is loopback-exempt, and filters at the connect
layer cannot lift that. Only a test fixture that installed a temporary exemption passed.

Proposed decision (2026-11-01, pending repository-owner approval): the broker adds the per-tree SID to the machine's loopback exemption
list through the documented `NetworkIsolationSetAppContainerConfig` API
(`gateway_loopback.c`), with these constraints:

- **Order.** The exemption is added only after the guarded filters are installed and read back,
  while the child is still suspended (the broker's acknowledgement is what lets it resume), and it
  is revoked before the filters are closed. Exemption failure refuses the run.
- **Scope.** The exemption lifts only the OS isolation. Keiko's connect-layer filters remain the
  confinement, so every destination other than the attested gateway port stays denied for the
  tree; the hostile-port denial of the transport proof is unchanged.
- **Shared list.** The list is machine-wide and replaced as a whole. The broker reads, modifies and
  writes it under one process-wide lock, adds its SID at most once, removes only its SID, and
  carries every other entry over unchanged. Another tool editing the list concurrently can still
  race with that write; the broker never removes entries it did not add.
- **Crash.** A broker crash can leave an entry for a per-tree SID. That SID is derived from a
  per-run nonce no later process can obtain, and the durable deny guard keeps blocking it, so a
  stale entry grants nothing. At broker start, before serving,
  the broker revokes the exemption of every SID that still carries a persistent durable deny
  guard; the guards themselves stay, and their recovery remains open work.

Filesystem grants (amended 2026-11-06, #4068; proposed 2026-11-07 by the #4068 assignee under the
scope transfer of 2026-10-24, pending repository-owner approval). A fresh per-tree SID can open nothing it was not granted. On
2026-11-06 the first confined run on a standard user's machine could not load its own runtime. The
host now sends the tree's grants to the supervisor as one closed `KGG1` frame, after the launch
packet and before the broker open (`native/runtime-supervisor/windows/gateway_grants.c`):

- **What.** The per-tree SID gets read on the runtime root and modify on the run's private state
  directory. It also gets read on the verified ripgrep directory when that directory lies outside
  the runtime root, as a checkout's `.ripgrep` does: that directory is the only entry on the
  runtime's `PATH`. A managed task worktree gets read through the capability
  `keiko.workspace.<32 hex>`, derived from the worktree's canonical path. The mapped tool profile
  changes files through Keiko's facade, so the confined runtime never writes the worktree itself.
  No other path is granted. The state directory is owner-private with inheritable entries, and a
  resumed run's database copy is handed back to that inherited DACL (ADR-0182), so the tree's grant
  reaches every file there.
- **When.** The supervisor applies the grants once the broker has named the SID and the user
  environment key is closed, before it creates the runtime. If any grant fails, it revokes those
  already applied and refuses the run.
- **Lifetime.** Tree grants are revoked when the tree is reaped. A crash can leave such an entry, but
  its SID comes from a per-run nonce, so it grants nothing to a later process.
- **Stale entries (2026-11-07).** A supervisor becomes a recorded holder of the environment guard
  below before it grants its tree anything, and it revokes those grants before the guard forgets
  it. A launch that finds no live holder under the guard's lock therefore knows that no confined
  tree of this user holds a tree grant. It then sweeps the directories its own frame grants to the
  tree, before it grants them: explicit allow entries for an AppContainer package SID with exactly
  a tree grant's mask and inheritance are removed. The well-known package groups, capability SIDs,
  inherited entries and any other mask stay. A sweep that fails is counted and never refuses the
  launch. The launch response carries the two counts, and the host records
  `runtime.confinement.stale-grants-swept` when either is not zero. A launch that finds a live
  holder sweeps nothing. The guard's lock is per session, so concurrent runs of the same user in
  two sessions are not serialized against each other.
- **Concurrent edits (2026-11-09).** Concurrent runs share granted directories such as the runtime
  root, and a DACL edit is a read, a merge and a write. Every grant, revoke and sweep edit therefore
  runs under one per-user lock (an exclusive byte-range lock on `%LOCALAPPDATA%\Keiko\RuntimeSupervisor\Keiko.RuntimeGrants.lock`, 30 s, shared by every logon session of the user, #4242); without it, one run's write
  can drop another run's fresh entry. A grant that cannot take the lock refuses the launch as a
  grants ACL failure. A revoke that cannot take it leaves the tree's own entry for a later sweep
  rather than racing another run's write.
- **Worktree capability.** The worktree
  capability is set once, inheritable, and kept, so no per-run change touches the worktree's ACL. It
  admits only AppContainer tokens that carry the capability, and the ordinary access check still
  applies, so it grants nothing the user does not already hold.
- **Refusals.** The frame is limited to eight grants, all on absolute paths. Write access through a
  capability, an unknown capability name, a missing directory and a reparse point are refused. The
  supervisor's refusal names the closed step that failed (`supervisor-grants-frame`,
  `supervisor-grants-directory`, `supervisor-grants-acl`, `supervisor-grants-capability`,
  `supervisor-gateway-connect`, `supervisor-gateway-admit`, `supervisor-environment-guard`), and
  the runtime's exit diagnostic
  records it. The refusal also reaches the run (2026-11-19): a launch the supervisor refused
  settles with a closed failure code in place of the internal `runtime-failed`
  (`runtime-supervisor-grants-acl`, `-grants-directory`, `-grants-capability`, `-gateway-connect`,
  `-gateway-admit`, and `runtime-supervisor-refused` for every other step), shown on the
  `coding-runtime.run.settled` line and worded in the Workbench with the one way out. A refusal
  that precedes the job object (`job-create`, the grants frame, directory, ACL and capability
  steps, `gateway-connect`, `environment-guard`) and arrives before any launch response proves
  that no tree existed, so the start reports the refusal and not `runtime-reap-unproven`; every
  refusal after the job exists, including `gateway-admit`, keeps its tree under the normal reap
  proof.
- **Evidence.** `runtime.confinement.spawned` records `backend: windows-wfp`,
  `childExecutablePolicy: appcontainer-inherited`, the number of tree grants and whether a worktree
  capability applied. It never records a path or a capability name.
- **Volumes.** On 2026-11-06 a granted worktree on a non-system volume (`D:`) could be opened from
  the tree, but `GetFinalPathNameByHandleW` with `VOLUME_NAME_DOS` was denied, so OpenCode's
  `realpath` of its workspace failed. The same probe on the system volume succeeded. A release keeps
  its task worktrees and runtime state under the user profile, on the system volume. A checkout on
  another volume sets `KEIKO_STATE_DIR` to a directory on the system volume. A user's own checkout
  on the system volume is granted as D21 describes.
- **Work location.** Amended by D21 (2026-11-19): the operator's own checkout or folder is granted
  through the same worktree capability, except a drive root, the user profile itself and Keiko's
  own state, which are refused as `workspace-location-unsupported` (reason `protected-folder`). A
  workspace on another volume stays refused as `workspace-volume-unsupported` (reason
  `non-system-volume`). Both are HTTP 409 with a sentence that names what to change, and both are
  decided before anything spawns. Readiness no longer restricts `executionLocations` on Windows.

Inbound control (amended 2026-11-06, #4068; proposed 2026-11-07 by the #4068 assignee under the
scope transfer of 2026-10-24, pending repository-owner approval). The host drives OpenCode through the server the runtime opens
on `127.0.0.1` inside the tree. Windows drops that inbound loopback connection twice, silently: its
application isolation blocks loopback into any AppContainer, and Windows Firewall blocks inbound to
a package without a rule. The D18 exemption lifts only the outbound direction. The broker now admits
exactly this connection after the exemption and before its acknowledgement:

- **Capability.** The tree's profile and token carry `privateNetworkClientServer`, which Windows
  requires before an AppContainer may accept a connection. Keiko's per-tree connect filters still
  deny every destination but the attested gateway, so the capability widens no egress.
- **Isolation.** A soft permit at the explicit maximum weight inside the application-isolation
  sublayer, at `ALE_AUTH_RECV_ACCEPT_V4`, matches only this package, TCP, the loopback flag and the
  local address `127.0.0.1` (`gateway_inbound.c`). It stays soft, so a block in any other sublayer
  still wins. It lives in the broker's dynamic session and goes when that session closes.
- **Firewall.** A Windows Firewall rule admits inbound TCP from `127.0.0.1` to `127.0.0.1` for this
  package, its owner and the tree root's own program (`gateway_firewall.c`). NetSecurity is the
  documented interface that accepts a package principal, so the broker runs the system PowerShell
  with a fixed script, values passed only through the environment, output discarded and a 60 s
  bound. The rule is removed at teardown, and the broker removes every leftover Keiko tree rule at
  start.
- **Order and refusal.** The acknowledgement waits for both, up to 90 s. A failure refuses the run
  as `supervisor-gateway-admit`.

These are the same three admissions that passed the disposable-runner composition on 2026-10-29.
The port is not pinned: OpenCode chooses it inside the tree, and the per-run server password stays
its authentication.

User environment key (amended 2026-11-07, #4068; proposed 2026-11-07 by the #4068 assignee under the
scope transfer of 2026-10-24, pending repository-owner approval). An AppContainer root reads `HKCU\Environment` through the
key's own read entries for `ALL APPLICATION PACKAGES` and the `registryRead` capability, so a value
stored with `setx` was readable beside the launch environment allowlist. On Windows 11 a deny entry
for the tree's SID, a Less Privileged AppContainer and a medium no-read-up label each failed to
stop it. The supervisor therefore removes those read entries, and any for
`ALL RESTRICTED APPLICATION PACKAGES`, before the suspended root exists, and the last confined run
of the user to end puts them back (`native/runtime-supervisor/windows/gateway_environment.c`):

- **Holders.** A record under `HKCU\Software\Keiko\RuntimeSupervisor\EnvironmentGuard` names each
  live supervisor by process id and creation time, and the removed entries by access mask and
  flags. It never holds a value of the key. A per-user lock file under `%LOCALAPPDATA%\Keiko\RuntimeSupervisor`, held by byte-range lock and so shared by every logon session of the user and released when its holder dies, serializes every change (a `Local\` mutex would not span an RDP and a console session; a `Global\` mutex needs a privilege a standard user lacks). A holder
  whose process is gone is pruned by the next close or reopen, so a crashed run's closure ends with
  the next run.
- **Fail closed.** The record is durable before the key changes. A close that cannot record, edit
  or verify the key refuses the launch as `supervisor-environment-guard`. Only explicit read entries
  are edited: an inherited entry, a wider mask or an unreadable record refuses the close and leaves
  the key as it is. A restore puts back only read entries of those three principals; a record that
  names anything wider is refused, and the key stays closed.
- **Scope.** While any confined run lives, every AppContainer app of this user is denied the key,
  not only Keiko's tree. A process environment is built by its creator, not read from this key, so
  this affects only an app that reads the key directly. A restore that fails keeps the key closed;
  the supervisor writes a body-free line to its standard error, and the next run's close or reopen
  retries it. The reap protocol carries no refusal after the tree's proof, so that failure is not on
  the Activity Log.

D13 still holds: no D1–D10 denial is relaxed, and no endpoint beyond D11's attested gateway becomes
reachable. The installed Windows transport proof (`test-windows-gateway-scm.ps1 -VerifyTransport`)
is the qualification evidence for this decision. It passed on 2026-11-01 (head `9b851924a`, Windows Server 2025): the confined root connected to
the permitted gateway port and the hostile port stayed refused (10013), where the same probe had
timed out (10060) before the exemption.

### D19 — An administrator installs the Windows broker once; ordinary launches never elevate

Amended by D21 (2026-11-19): no launch uses this broker any more. `keiko start` no longer installs
or repairs it, readiness no longer reads its state, and the Workbench offers no Repair; the bullets
on automatic setup, visibility and Repair below describe the retired path. The explicit
`keiko gateway-service` command and its removal by a full `keiko uninstall` remain, so a machine
that carries the service from an earlier release can be cleaned up.

Issue #4068 needs the D18 broker on a customer machine. `keiko gateway-service
<status|install|repair|uninstall>` owns that lifecycle (proposed 2026-11-02, pending repository-owner approval):

- **Elevation.** Windows asks through UAC. Only the native supervisor runs elevated
  (`native/runtime-supervisor/windows/gateway_install.c`); Node and package scripts do not. The
  helper refuses unless its own bytes match the pin, so install accepts exactly what a launch would
  accept. Until releases carry a verified Authenticode signature, UAC names an unknown publisher.
- **Pins.** A release-qualified Windows package yields its attested helper's digest. A Windows dev
  checkout yields the digest of the runtime supervisor it built, as its dev-lane manifest records
  and discovery re-verifies against the source tree (amended 2026-11-06, #4068; proposed 2026-11-07
  by the #4068 assignee under the scope transfer of 2026-10-24, pending repository-owner approval). The checkout path needs the
  explicit `--dev-lane` flag, so an administrator installs a locally built broker only by choosing
  it. Its runs take the same broker, filters and loopback exemption as a release's. Their evidence
  stays `functional-not-platform-qualified`, so no checkout run counts as platform qualification. A
  release launch reads a broker with a checkout pin as stale, and `repair` replaces it. The Windows
  npm runtime package (`@oscharko-dev/keiko-coding-runtime-win32-x64`) carries its own supervisor
  and yields that supervisor's digest, which the server compiles in beside the package's other
  approved digests, so a package cannot vouch for itself (proposed 2026-11-09, pending repository-owner approval). Without
  `--dev-lane`, the command uses a release-qualified helper and, only where none exists, that
  package's supervisor; the outcome line names the `npm-runtime-package` lane. Its evidence stays
  `functional-not-platform-qualified`.
  The owner-authorized Windows repair of 2026-11-16 (#4404) additionally admits the independently
  pinned public Windows artifact set through this same broker. Discovery must match both
  native-helper digests and sizes, the current OpenCode executable tree, adapter, protocol schema,
  license and SBOM against `WINDOWS_PORTABLE_RUNTIME_APPROVAL` in the existing approvals owner.
  The published manifest was authenticated with Keiko's compiled portable-release key; its helper
  bytes were independently measured in the installed public package. A coherent manifest alone
  cannot confer this approval. Since 2026-11-17 the npm package carries the same Windows helper and
  supervisor bytes as the desktop package. A runner image update changed the release build's
  secure-read bytes for 1.5.4 without a source change, and that release refused every Windows
  Coding run; the release build (`scripts/stage-portable-runtime.mjs`) now stops when a built
  Windows helper differs from this approval, so the pin and the shipped bytes cannot drift apart
  unnoticed (#4068, 2026-11-20). The CLI outcome records
  `portable-evaluation`; `platformAssurance` remains `evaluation-unqualified` and readiness remains
  `functional-not-platform-qualified`. Unapproved artifacts, signed-install downgrade attempts,
  changed bytes and unsupported install volumes retain their refusals. No platform qualification,
  unattended elevation, unsigned service update or second broker path is introduced.
- **Placement.** The image goes to `%ProgramFiles%\KeikoRuntimeGateway`, which is owned by
  Administrators and closed to inherited or user write access. The copy is verified again there,
  before the running service is stopped, so a failed copy leaves the old broker serving.
- **Start.** The service is `SERVICE_AUTO_START` with delayed start, depends on BFE and runs as
  LocalSystem with its default service permissions. It restarts after every failed stop (three
  restart actions, the last repeating, reset after an hour), because a standard user cannot start it,
  a launch must not prompt, and a squatted pipe or a repeated crash must never leave it permanently
  stopped (#4242). The client opens the broker pipe at identification level only and waits a bounded
  time while the single instance serves another tree; the SCM check of the server PID follows, so a
  squatted pipe learns the caller's identity and can never act as the caller.
- **Updates.** A helper that changes between releases leaves the installed digest stale, and the
  launch refuses until the service is repaired, at one UAC prompt per change. The repair is part of
  installing and updating Keiko (one-step Windows setup, 2026-11-17): every healthy `keiko start`
  on Windows — the first launch of a desktop install, the relaunch that completes an in-app update,
  a manual-ZIP upgrade, and `keiko start`/`keiko restart` of an npm install — reads the broker state
  and, when it is not ready, runs the same idempotent `--gateway-service-install <pin>` with the
  release or npm helper (`gateway-service-setup.ts`). It runs only after the UI answered healthy,
  so a pending approval never delays the start or an update's restart proof, and it never changes
  the start's exit code. Keiko asks at most once per helper pin: the pin of the last automatic
  attempt is recorded in `<stateDir>/gateway-service-setup.json`, so a declined approval is not
  repeated at every launch, and a new Keiko version asks once again. The dev lane keeps its
  explicit `--dev-lane` command; an operator who installs the service through MDM sets
  `KEIKO_GATEWAY_SERVICE_SETUP=manual`. An installation managed outside the app (a launcher that
  declares `KEIKO_PORTABLE_MANAGEMENT` other than `user-local`, which the standalone folder package
  of ADR-0121 D9 does) never sets up the service: the step records `managed-outside` and asks
  nothing, and its `keiko uninstall` leaves an installed broker in place, because that broker
  belongs to the administrator who installed it. An administrator's explicit
  `keiko gateway-service install` still installs it there. This is not unattended elevation: Windows asks the human
  through UAC, and only the digest-checked native helper runs elevated. There is still no silent
  self-update of the service: that would need a verified signature chain the Windows releases do
  not have yet.
- **Removal.** Uninstall refuses while a durable deny guard remains, because such a guard may still
  protect a live tree and removing it could widen that tree's access. Clearing a guard whose tree
  is known to be gone remains the open recovery work D18 names, so uninstall stays refused until
  that exists.

- **Visibility.** A Windows runtime with a pin reports the broker state on each readiness read,
  because the broker starts delayed after boot and can be installed while Keiko runs. A broker that
  is not ready makes the runtime unavailable with a closed `gateway-service-*` reason, and the
  Workbench offers one Repair action for an absent, stopped, stale or unreadable broker instead of a
  terminal command. Repair (`POST /api/coding-workbench/runtime/gateway-service/repair`, behind
  the paired app session) runs the same native install through a verified private copy of the
  helper, answers a closed outcome (`ready`, `declined`, `failed`, `unavailable`, `busy`; one prompt
  at a time) and re-reads the state. An installation managed outside the app offers no Repair and
  answers `gateway-service-managed-outside` for any broker state that is not ready, because Keiko
  installs no system service there; a broker an administrator installed is still used. The launch
  stays fail-closed regardless of the last reading.
  A full `keiko uninstall` removes the service too, through the same `keiko gateway-service
  uninstall` (one UAC prompt), before the installation's own helper is deleted. A declined approval
  or a guard that still protects a live tree keeps the service, names the command that removes it
  later, and lets the rest of the uninstall continue; `--scripts`/`--launchers` alone and
  `--dry-run` never touch it.
- **Standard users.** Status and launch read the running broker's image path from the service
  configuration. The default service DACL lets an interactive user read it, while the LocalSystem
  process itself denies that user `PROCESS_QUERY_LIMITED_INFORMATION`. On 2026-11-06 (#4068) a
  standard user's status read of a running, correctly pinned broker reported `state-unknown` with
  `ERROR_ACCESS_DENIED`, and the launch path used the same lookup. The hosted runner had run every
  proof elevated, so it could not see this. Only the
  exact command line install writes is accepted. A configuration that names another image than the
  one running still fails closed at the pipe's image-identity authentication. The launch's own pipe
  authentication had the same defect: it opened the broker process, which a standard user cannot do,
  so every confined launch was refused as a protocol error. The supervisor now accepts the pipe only
  when its server process id is the one the service manager reports for the running service, and
  checks that again before it confirms the tree.

Every action records body-free lifecycle evidence as `cli.gateway-service.*`, with its closed `lane`
(`release-qualified`, `portable-evaluation`, `dev-checkout` or `npm-runtime-package`), and a change
of broker state records `coding-runtime.windows-gateway-service`, including the helper digest,
runtime origin and honest evidence class when composed by the runtime owner. The automatic setup
after a start records `cli.gateway-service.setup` with its closed `outcome` (`ready`, `installed`,
`declined`, `failed`, `deferred`, `no-helper`, `disabled`, `record-unavailable`), the prior state and
the lane; the Workbench's Repair records `coding-runtime.windows-gateway-service.repair` under the
request correlation with its outcome, exit class and helper digest. The lifecycle is
qualified on the disposable runner by `test-windows-gateway-scm.ps1`, which installs through the
product path instead of `New-Service`.

## Addendum — Windows governed verification without a container runtime (2026-11-03, amended 2026-11-25)

### D20 — A Windows execution-root boundary for repository verification

Proposed on 2026-11-03 by the #4068 assignee as "no Windows-native boundary". The repository owner
approved the native boundary instead at Gate G1 of #4493 on 2026-11-25 ("Go, Kind 5 starten"), and
this section records that decision. Repository verification always requests the execution-root
boundary (D9). On Windows the verifier selects it in this order:

1. a container runtime, Docker before Podman, exactly as before: a host that has one keeps its
   container path unchanged;
2. without one, the pinned runtime supervisor's step backend (`windows-appcontainer`, D21);
3. without that supervisor, or when its bytes miss the pin, nothing: the step is refused as
   isolation unavailable and nothing runs unconfined on the host.

- **Evidence stays separate.** A container run qualifies the container-backed path, and a step-mode
  run qualifies the native one. Neither certifies the other. The native proof in
  `windows-verification-loop.real.test.ts` qualifies the Windows shell path below the boundary and
  does not certify governed verification.
- **Refusal stays truthful.** A Windows host with neither backend cannot run governed
  verification. Such a run is denied and reports no pass, and the model, the tool card and the
  Workbench name both missing backends. The orchestrator's aggregate `failed` remains a failed
  gate, while the model and tool card use the existing not-run/denied outcome when no check reached
  an executed failure. Real step failures, timeouts, resource ceilings and failed dependency
  bootstrap remain distinct failures. The Workbench summary may carry an optional `deniedCount`
  subset of its canonical non-passing `failedCount`, so blocked checks do not appear as checks that
  ran unsuccessfully. Historical summaries without that subset retain their original facts. The
  existing `coding-runtime.verification` not-run Activity Log evidence records the closed denial
  reason; neither presentation nor counts grant verification authority.
- **The step's environment (#4492).** The server starts the step supervisor with an empty
  environment, as every native helper starts. The step's own environment, with its ephemeral home,
  travels in the launch frame only: Windows expands the per-user LocalAppData folder, where the
  supervisor's environment-guard lock lives, through the process's `USERPROFILE`, and the step's
  home there refused every step. A refusal is recorded as `editor.verification.windows-step-refused`
  (`phase`, `refusalCode`) on the step's correlation. A drive-absolute `PATH` entry that no granted
  folder names lexically, such as Scoop's `current` junction, is named through its real folder's
  drive letter; the grants do not change, and relative entries and shares are never resolved.
- **Scope.** This decides repository verification only. It does not decide the Windows tool profile
  or the runtime confinement of D11 and D18, and D13 still holds.
- **Open.** The container-backed loop from a Windows checkout, with dependencies installed for the
  container's target, is not yet qualified (#4068 W8).

## Addendum — Windows runs are confined without a service or elevation (2026-11-19)

### D21 — The runtime supervisor relays the confined tree's loopback traffic through named pipes

Owner order of 2026-11-19 (#4068): the Coding Workbench runs on Windows as it does on macOS, for a
standard user without administrator rights, in the npm, npm-folder and standalone forms, and the
confinement stays. The D18/D19 broker could not meet that order: its installation, its repair after
every helper change and its loopback exemption each need an administrator.

Decision (`native/runtime-supervisor/windows/gateway_relay.c`, `--relay-supervised`):

- **No network capability.** The pinned supervisor creates a per-run AppContainer profile
  (`Keiko.Relay.<owner>-<16 hex>`, below) that holds no network capability at all, so Windows itself refuses every
  connection out of the tree, loopback included. A standard user can create such a profile; no
  service, filter, firewall rule or loopback exemption is installed, and nothing elevates.
- **The only way out.** For every attested loopback port of the launch (the gateway, the governed
  tool facade, the MCP relay), the unconfined supervisor creates one named pipe per route. Its DACL
  names only the tree's SID beside the owner and SYSTEM, and a connected instance is accepted only
  from a process of this run's container. Each accepted instance is bridged to `127.0.0.1:<port>`
  on the host. Inside the container the supervisor's own image runs as the tree root
  (`--container-relay`), listens on container-local loopback ports, rewrites the runtime
  environment's `127.0.0.1:<port>` values to them and bridges each connection to its pipe. No other
  destination is reachable, which is what D11 requires of the gateway confinement.
- **Inbound control.** The host's connection to the runtime's own server takes one inbound route:
  the supervisor listens on a host loopback port, rewrites the runtime's listening line to it and
  opens an instance to the runtime's port inside the container.
- **Host admission.** A relayed request reaches the server with the container-side port in its
  `Host` header. The server's DNS-rebinding guard admits that only for the runtime routes (the
  gateway completions, tool and MCP relay routes), with a loopback host name, no `Origin` and a
  Bearer credential; every other route and every browser request keeps the exact-port rule.
- **Filesystem grants.** D18's KGG1 grants, sweep and per-user lock are unchanged. The worktree
  capability now also admits the operator's own checkout or folder on the system volume, except a
  drive root, the user profile itself, Keiko's state directory and any folder inside that state,
  or a folder that contains it (`workspace-location-unsupported`, reason `protected-folder`). A
  read grant on a directory that `ALL APPLICATION PACKAGES` can already read, with an entry for the
  directory, an inheritable one for its content and no deny entry for that group, writes nothing:
  a runtime an administrator installed under `Program Files` cannot take a user's entry and does
  not need one. Write grants always take the tree's own entry.
- **Evidence.** The supervisor pin, its size and its source-tree digest are built by the
  `relay-confinement` job of `windows-gateway-confinement.yml` (MSVC, `/Brepro`) and shared by the
  npm runtime package and the portable payload. That job also runs the relay rules
  (`gateway_relay.test.c`), the grant rules (`gateway_grants.test.c`) and an end-to-end proof
  (`scripts/testing/test-windows-relay-confinement.mjs`): the tree reaches the attested port
  through its pipe and is refused the host gateway port directly and the internet.
- **Step mode (#4496, Gate G1 of #4493, owner approval of 2026-11-25).** The same supervisor runs
  one governed verification step with `--step-supervised`. keiko-tools frames it a KRP1 launch and
  KGG1 grants on descriptor 3 and reads KRS1 answers on descriptor 4. The supervisor creates a
  per-run profile (`Keiko.Step.<owner>-<16 hex>`) without a network capability, so the step reaches neither
  the internet nor the host's loopback nor another process's pipe, and runs it as the root of a
  kill-on-close Job Object; a cancelled step is ended by KRC1, never by a separate tree kill.
  - **The step ends with its root.** Once the root process has exited, the supervisor terminates
    whatever is left in the job (a detached child, a watcher) and reports the root's own exit code
    once the job holds no process, as macOS stops the whole scope when its root is reaped. Before
    #4496 the supervisor waited for the job to empty, so a test command that left a daemon behind
    held the step until its timeout (measured 2026-11-26, Windows 11 ARM64 guest, standard user:
    the canary in `scripts/testing/test-windows-step-confinement.mjs` received no REAPED answer).
    That canary is a guest proof, run as the standard user on the interactive desktop: a hosted
    Windows Server 2025 x64 runner refuses every process a step starts with `EPERM`, so it is no
    lane for it (#4561).
    The supervisor ships inside the coding-runtime package, so the rule reaches an installation
    with runtime 1.1.9; the published 1.1.8 still waits for the job to empty.
  - **Grants.** The execution root is the run's private copy of the workspace (below), granted for
    modification. The toolchain folder of the step's executable (a `bin` folder's parent) and the
    existing `JAVA_HOME`, `MAVEN_HOME` and `M2_HOME` folders are granted for reading, at most eight
    grants, and no grant may hold the whole user profile. A toolchain root that is, holds or sits inside the
    profile's `.m2` (bar its `repository` folder, which a Maven launcher is given explicitly) is
    never granted, and neither is a toolchain folder that directly holds a credential-named entry
    or cannot be listed. A drive root (`D:\`) is never granted, and no toolchain root may hold or sit
    inside one of the profile's credential stores: the locations the macOS profile denies under the
    home (`NATIVE_HOME_DENIED_LOCATIONS`) plus `AppData\Roaming\Microsoft\Credentials`,
    `AppData\Local\Microsoft\Credentials`, `AppData\Roaming\Microsoft\Protect`,
    `AppData\Roaming\Microsoft\Crypto` and `AppData\Roaming\GitHub CLI`; a `bin` folder beside a
    store (`.cargo\bin`) stays grantable, as on macOS. Windows keeps a folder one level below a
    drive (`C:\apache-maven-3.9.9`) grantable, unlike macOS's two-level rule, because that is where
    Windows installs extract a JDK or Maven and no shared prefix sits there. The server admits every toolchain folder by its real drive path (long
    names for 8.3 ones, links and junctions resolved), against the profile's real path, so a short
    name, a junction or a relocated `.m2` (compared where it is named and where it really lies)
    cannot hide an overlap; a folder whose real path cannot be resolved is no folder. The named
    homes are judged once per resolution and once per real folder (refusals are counted on the
    supervisor line by reason, `readRootRefusedDriveRootCount`, `readRootRefusedM2Count`,
    `readRootRefusedCredentialCount`, `readRootRefusedUnlistableCount`), and the executable's own
    folder again for each step, unless it lies in the execution root. A folder that is no drive path
    (UNC, `\\?\`) is left out when a named home names it and refused when it is a step's own
    toolchain folder, and every step is refused on a host whose profile folder is unknown
    (`profileKnown`). A folder inside the execution root or inside another grant adds no grant.
    Maven's own global settings in `MAVEN_HOME\conf` stay readable because Maven needs them. The
    step's `TEMP`, `TMP` and npm cache stay inside the execution root. An execution root whose real
    path cannot be resolved refuses the step.
  - **Drive letters (step mode only; a Coding run's tree is unchanged).** No capability Windows
    grants an ordinary AppContainer lists `C:\` or `C:\Users` (measured 2026-11-25, ARM64 VM,
    standard user: `CreateProcessW` refuses a token that carries `isolatedWin32-volumeRootMinimal`
    or `isolatedWin32-profilesRootMinimal` with `ERROR_INVALID_PARAMETER`, also with the
    all-application-packages opt-out), and Node.js's `realpath` and Java's `toRealPath` (Maven's
    start, `javac --release`) walk every parent of a path. Before the supervisor starts, the server
    therefore gives each granted directory a `subst` drive letter in the user's logon session
    (`subst.exe` from System32, letters from `Z:` down, a refused letter skipped), and
    keiko-tools names the image, the working directory, the arguments and every variable through
    those letters; the grants keep the real paths, where the access entries live. A `.cmd`
    launcher's command line reaches cmd.exe caret-escaped, so a granted directory that ends an
    argument is followed by `^"` rather than `"`; it is named through its letter all the same
    (#4492: Maven's `-Dmaven.repo.local.tail` kept the real profile path, and the resolver's
    `toRealPath` walk ended in a `NullPointerException`). The walk then starts at the granted
    directory itself. The letters are removed when the step ends; a step
    without free letters is refused as isolation unavailable, and
    `editor.verification.windows-step-drives` records the counts. Measured the same day: Node.js
    `require` and `realpath`, `npm -v`, `java -version`, `javac --release 21` and an offline
    `mvn verify` run in the tree; the same build through the real paths fails. A letter of a
    server that ended without its cleanup stays until the user signs out and names only a folder
    the user may read anyway.
  - **Credential-named files.** An access entry cannot keep a credential-named file away from a
    tree that may modify the workspace (#4493 finding 5). The steps of one run therefore share a
    private copy of the workspace, made after the dependency bootstrap, that leaves out every entry
    whose name the shared credential list (`CREDENTIAL_PATH_DENY_PATTERNS`) matches and every link;
    the run removes it when it ends. The copy is shared with the assured pre-filter
    (`linkFreeCopy.ts`), and `editor.verification.windows-step-copy` records its counts.
  - **Closed refusals.** A grant the user may not write (a toolchain an administrator installed
    outside `Program Files`), a protected environment and a step without free drive letters refuse
    the step with a closed reason. Windows PowerShell 5.1 and
    PowerShell 7 fail inside the tree on registry access, and a stock Node.js child that opens pipes
    hangs until a Node.js release ships libuv 1.53 (#4493); the first is a recorded limitation, not
    a silent failure, and the second is answered by the confined step Node.js below.
  - **Supervisor.** The server verifies the runtime's supervisor against the same pin that admits a
    Windows Coding run and hands each step a private copy written from those bytes;
    `editor.verification.windows-step-supervisor` records whether it is available and whether a
    Maven step may read the person's repository (never its path).
  - **Confined step Node.js (#4492).** Inside the AppContainer every official Node.js 26.13.1 hangs
    as soon as it spawns a child with piped stdio, forks or runs `node --test`: libuv 1.52.1 names
    its child pipes uniquely in the global pipe namespace, `CreateNamedPipeW` answers access denied
    there, and libuv reads that as a name collision and retries forever (libuv#5181, fixed in libuv
    1.53; no official Node.js carries it yet, nodejs/node#66282). Until one does, the Windows
    runtime package and the Standalone/portable Windows payload carry `runtime/step-node/node.exe`
    (the payload takes it from that package; its manifest names it as the second `nativeTools` entry
    and no signing lane signs it, because a signature would change the pinned bytes), the official
    26.13.1 source plus exactly that fix, built by `.github/workflows/windows-step-node.yml` from
    `patches/node-26.13.1-libuv-5181.patch` and `patches/node-26.13.1-win-crates-synchronization.patch`
    (the provenance of the pin), pinned by digest, size, source digest and patch digests in
    `NpmLaneRuntimeApprovals` (`stepNode`) and verified by the release build, by the package
    inspection (the folder may hold exactly that one file) and by the server on every resolution
    of a verification run's step backend, not per step: the folder's owner can restore every
    timestamp after a rewrite, so no metadata match proves the bytes, and the steps execute the
    file in place, so an owner-controlled swap after that check stays possible, as for every file
    the owner can write. The server offers it only when the folder is a real folder that holds exactly the
    pinned file (`editor.verification.windows-step-supervisor` field `stepNode`: `patched`, `absent`
    or `mismatch`, with the missed check in `stepNodeMismatch`); the step then reads and executes that folder, finds it first on its `PATH`
    through its drive letter (so every `node` resolved through the search path, including the bare
    `node` a `node_modules\.bin\*.cmd` shim falls back to, runs it), runs a
    command named `node` as it, and starts an install's `npm` and `npx` as
    `<step node.exe> <install>\node_modules\npm\bin\npm-cli.js|npx-cli.js`, because the install's
    `.cmd` prefers the stock `node.exe` beside it; a CLI script that is missing or resolves outside
    the install's folder keeps the `.cmd` and is recorded. cmd.exe still prefers a `node` in the
    step's current directory for a shim's bare `node`; such a file runs in the same AppContainer
    with the same grants, so it widens nothing, and the step does not set
    `NoDefaultCurrentDirectoryInExePath`, which would break a project's `mvnw` or `gradlew` called
    from its folder. Each decision is one
    `editor.verification.windows-step-node` line with closed values (`image`, `npmLaunch`,
    `npmFallback`, `pathPrefixed`, `placement`). Without a verified step Node.js, absent or
    mismatching, the step runs exactly as before, so a Maven-only project is unaffected and the log
    names the absence. The verification reads the installed folder, which the person's account
    owns, so a swap between the check and the step is outside the pin's reach; the folder is never
    the execution root's. The pin is replaced, not extended, when a later build supersedes it, and
    the package drops the build when an official Node.js carries libuv 1.53.
  - **Maven projects (#4492).** Without a container runtime a Maven project had no verification
    step, so its tests never ran. On the step backend the verifier now plans one step for the
    `test` kind: `mvn -B -o -Dmaven.repo.local=.keiko-maven-repository
    -Dmaven.repo.local.tail=<repository> -Dmaven.repo.local.tail.ignoreAvailability=true test`.
    The run resolves into a repository of its own in the execution root and reads the person's
    `%USERPROFILE%\.m2\repository` read-only behind it, as a Coding run below Full access does
    (ADR-0184); Maven before 3.9 ignores the tail, and its offline build then fails on the missing
    artifacts. The supervisor grants that folder only to a step whose executable is an installed
    Maven launcher outside the execution root, and only when it is a real folder reached through
    no link: a profile behind a junction, a mapped drive or a `subst` letter gets no grant, and the
    step runs without the tail. `.m2` itself is never granted, so the person's `settings.xml` and
    its credentials stay out of the tree, and the step's home lies inside the execution root, so
    Maven reads no user settings. The step's environment adds `JAVA_HOME`, `MAVEN_HOME` and
    `M2_HOME`. The orchestrator admits a Maven step only in exactly the planned shape (the planned
    arguments, or a planned skip without arguments); the command rule, which admits `mvn` with
    `-B -o` first and the `test` phase only and refuses `-s`, `-gs`, `-t`, `-f` and `--define`, is
    defense in depth behind it. The step runs the project's own build, including its `.mvn`
    configuration and extensions, so it asks for the same script trust as an npm script and is
    contained by the same grants. The other kinds are skipped with a closed reason: Maven has no
    `typecheck`, `lint` or `build` the verifier could tell apart from the test phase. A person
    whose settings move the local repository elsewhere gets an offline build that misses those
    artifacts. Measured 2026-11-25 on the ARM64 VM as a standard user: the tail run ends
    `BUILD SUCCESS` with Surefire's test run; without the tail the same build fails on the missing
    resources plugin.
- **Session, profiles and exit (#4495).**
  - **Interactive desktop.** An AppContainer process needs the interactive window station: started
    from an SSH or service session, its root ends with `STATUS_DLL_INIT_FAILED` before it runs a
    line. A confined launch outside `WinSta0` is therefore refused before anything is created
    (refusal 18, `runtime-supervisor-no-desktop`). A root that still ends with that status is not
    read as this cause: the status also follows other DLL initialization failures. Refusal 19 (`runtime-supervisor-image-path`) names a supervisor whose own
    path is longer than a relayed root may be started from.
  - **Profile owner.** A profile's name states the supervisor that created it:
    `<prefix><pid as 8 hex>-<creation time as 16 hex>-<16 random hex>`. Every confined launch
    removes the Keiko profiles whose supervisor no longer runs, judged as the environment guard
    judges a holder (an unopenable process counts as alive); the supervisor's kill-on-close Job
    Object took that run's tree with it. A live run's profile, also another Keiko installation's,
    and every name outside the grammar (an older Keiko's random name, any other program's profile)
    are never touched. The launch response carries the counts beside the grant sweep's, and
    `runtime.confinement.stale-grants-swept` records them.
  - **Root exit.** The reap proof's first word is the tree root's exit code; the host records it as
    `runtime.confinement.tree-reaped` for every reaped tree, a number only. The relay root's own
    failures use the NTSTATUS customer range, which no runtime returns: `0xE04B0001` when its plan,
    sockets, routes or pipes could not be set up and `0xE04B0002` when the runtime could not be
    created. The number on `runtime.confinement.tree-reaped` is the closed value that names them;
    the run settles with the supervisor's generic refusal.
  - **Proofs.** The whole path of a start without a desktop is pinned through the real native tree:
    refusal 18 settles the run with `runtime-supervisor-no-desktop` and names
    `supervisor-no-desktop` on the `coding-runtime.exit` line (`codingRuntimeManager.test.ts`),
    and the Workbench words that code as a signed-in desktop session
    (`codingWorkbenchLabels.test.ts`). `nativeRuntimeProcessTree.refusal-codes.test.ts` reads every
    `error_code` of `keiko_runtime_supervisor.c` and fails when one lacks its own word, shares a
    word, or does not reach a run failure code the Workbench can word. The profile sweep's counts are
    pinned from the launch response (`nativeRuntimeProcessBackend.windows-grants.test.ts`) and the
    sweep itself by `gateway_profiles.test.c` on the Windows job.
- **Scope.** D13 still holds.
