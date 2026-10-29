# Windows gateway runtime implementation status

Tracks [#3666](https://github.com/oscharko-dev/Keiko/issues/3666) and
[#3423](https://github.com/oscharko-dev/Keiko/issues/3423).

## Current implementation

`native/runtime-supervisor/windows/gateway_wfp.c` is an initial native filtering primitive. It
accepts an AppContainer package SID, an IPv4/IPv6 loopback family and one nonzero TCP port. It
creates one dynamic WFP session and private sublayer, with package-scoped outbound denies for both
address families and an exact gateway exception. Installation is transactional; failure closes the
session. No application-wide or machine-wide allow is installed.

This primitive is **not wired into runtime availability or launch**. It does not make Windows coding
execution available. In particular, filter construction and input tests are not a security
qualification or a substitute for an actual socket test.

## Verification performed

### CI quality inventory repair, 2026-10-28

PR #4090 was synchronized with `dev` at `246efd4638066b26cfb50ee329e6d3c099599f66`.
The two Sonar scope tests failing in CI run `40387447971` shared one cause: the new
`gateway_journal`, `gateway_peer` and `gateway_request` C sources and headers were missing from
`scripts/native-quality-scope.json`. All six now name the existing compiler, static-analysis and
gateway behavior gates that already compile and exercise them. No exclusion or gate was weakened.

The scope CLI also uses the existing trusted host executable resolver on Windows, so a protected
Git installation outside `C:\Program Files` is supported. A missing trusted executable still fails
closed. The real CLI and repository-backed tests reproduced the inventory refusal before the fix;
the resolver regression also failed before the implementation change.

On Windows with Node 24.18.0, the scope, host executable and Windows native quality wiring suites
passed together (65 passed, 9 platform-specific skips). The default native gateway runner passed
with MSVC warnings as errors and static analysis, including journal, peer, profile and request
tests. This run installed no WFP filters or firewall rules. It does not qualify successful
AppContainer socket admission or the unimplemented production service.

### Native component checks

On Windows with Node 24.18.0 and the installed MSVC toolchain:

```text
node scripts/testing/test-windows-gateway-filters.mjs
```

Compiles the native policy, recovery and IPC fixtures using `/W4 /WX /analyze /MT`. Tests reject null,
broad and capability identities, invalid address families, port zero, missing output storage, and
attempts to overwrite an active session. The default test makes no WFP calls and changes no network
filters. The extended default run also uses a fresh HKCU fixture key, local named pipes and a
temporary AppContainer profile; all are removed after the tests. It is also invoked by the existing
Windows native quality gate.

### Control-plane foundations, 2026-10-26

These are tested building blocks, not an installed service or production launch approval:

- The WFP owner can prepare its sublayer and deny-filter keys before any filtering-engine call.
  A broker can flush an authenticated recovery record before installation, closing the previous
  crash window where recovery keys became available only after persistent policy was installed.
  The existing guarded lifecycle proof now recovers using those pre-install keys, rejects a second
  installation with the same keys, and independently reads back the sublayer as well as filters.
- `gateway_journal.c` encodes bounded, versioned recovery records and flushes them through the
  Windows registry. Duplicate/partial keys cannot be overwritten; malformed SID lengths, unknown
  versions, reserved bytes, mismatched tree names and nested deletion targets fail closed. The
  future service must own and verify the protected registry root and serialize its operations.
- `gateway_peer.c` derives the local caller from the named pipe, holds its process/token handles,
  and matches the protected supervisor pathname and file identity, session, user and authentication
  LUID. Anonymous, AppContainer and below-medium-integrity callers are refused. The service must
  supply its locked, digest-verified installed image; a client-supplied image is never authority.
  Request nonce/state validation and server authentication remain separate work.
- Native local execution passed policy validation, registry encode/decode/create/replay/corruption
  tests, real named-pipe positive/negative peer tests and exact AppContainer SID inheritance by a
  root and its descendant. The fixture reaps its tree, restores its executable ACL and deletes its
  temporary profile. This proves no network isolation.
- `gateway_request.c` admits one bounded, versioned request per cryptographic challenge. Every
  attempt consumes the challenge, including malformed input; replay and cross-connection reuse
  fail. Challenges expire after 30 seconds of monotonic uptime; admission rejects both expired
  and impossible future issue times, consumes the challenge and clears its nonce without changing
  the output request. The timestamp belongs to the authenticated connection's server-side state,
  not the wire frame, and must never be restored across a reboot. A timeout requires a newly
  authenticated connection. Native tests cover expiry, future timestamps, unchanged output,
  nonce clearing and retry refusal alongside the existing fresh-challenge controls.
  It recomputes the existing mapped `RuntimeGatewayConfinement` digest using the shared
  native SHA-256 implementation. Shared IPv4/IPv6 vectors are checked against the actual
  TypeScript producer and the native consumer, including truncated/oversized frames, altered
  bindings, invalid run IDs and reserved bytes. Admission still requires authenticated IPC and
  independent Job Object/installation checks; this component grants no OS authority by itself.

A profile-free identity experiment did **not** launch on this Windows 11 host (`CreateProcessW`
reported error 2). The same identity fixture passed with the documented temporary profile lifecycle.
Production design must therefore account for per-user profile creation and crash recovery; merely
deriving a SID is not qualified as a replacement. No AppContainer loopback exemption or WFP filter
was installed during these local tests.

The local package build/typecheck passed. Full service, installer, exact endpoint, crash/reboot,
non-elevated production launch and actual Workbench acceptance remain outstanding.

The first disposable-runner attempt stopped at IPC authentication before installing any filter:
its process image retained a Windows 8.3 pathname. A native short-path launch reproduced the denial
locally. Expanding that spelling while retaining the protected pathname and file-ID comparison
passes both long/short-path positive controls and the existing negative controls. The socket fixture
now also requires host-to-AppContainer server connectivity under the same gateway filter; this
separate inbound control route is necessary for the unchanged OpenCode HTTP service. Its outcome
must be measured on the disposable runner, not inferred from outbound gateway access.

The next runner reached filter installation and rejected the new exact sublayer-weight readback.
Windows assigns the closest available weight, so the requested sublayer weight cannot be used as
an identity assertion. Readback retains exact sublayer GUID/provider/persistence checks and exact
filter weights, actions and conditions inside that sublayer. The gateway permit remains soft;
another provider's deny must still win. This follows Microsoft's
[provider installation contract](https://learn.microsoft.com/en-us/windows/win32/fwp/installing-a-provider)
and [filter arbitration](https://learn.microsoft.com/en-us/windows/win32/fwp/filter-arbitration).
The privileged socket proof still must pass; this readback repair alone proves no connectivity.

[Run 40368260526](https://github.com/oscharko-dev/Keiko/actions/runs/40368260526), at
`d3b758ada`, passed dynamic cleanup and durable-deny recovery for both address families. Its IPv4
socket controls passed: both trees reached both loopback ports before filtering, then each root
and descendant reached only its own gateway, and neither UDP receiver observed a datagram. The
host-to-AppContainer control route failed with `ERROR_CONNECTION_REFUSED` (1225). IPv6 sockets were
not reached in that run. The fixture now collects unfiltered and filtered control-route evidence
for both families while retaining failure for any unavailable route.

This is a production integration blocker: OpenCode's original HTTP server needs that inbound
route. The pinned binary's `serve --stdio` mode still serves HTTP; stdin is its lifetime lease,
not an alternate request transport. The upstream
[pinned server process](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/cli/src/server-process.ts)
and Microsoft's separate [inbound/outbound loopback configuration](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/troubleshooting-uwp-firewall)
explain why outbound gateway proof alone is insufficient. No broad allow, hard-permit firewall
override or unconfined fallback was added to make the control-route assertion pass.

[Run 40371027521](https://github.com/oscharko-dev/Keiko/actions/runs/40371027521) reproduced the
control-route refusal both before and after installing Keiko filters, for IPv4 and IPv6. Both
families' concurrent-tree outbound/UDP/descendant checks passed. The inbound gap is therefore not
caused by the Keiko outbound deny. The full development proof correctly remains failed.

The separate `--inbound-control-proof` experiment investigates the documented
`CheckNetIsolation LoopbackExempt -is` lifetime on disposable runners only. It starts the trusted
System32 utility for one temporary package SID under an owned Job Object, discards its potentially
identifying output, and requires working inbound sockets while exact egress remains enforced. An
independent inbound deny must still block, removing it must restore the connection, and reaping the
utility must revoke inbound access. The existing socket proof is not replaced or marked passed by
this experiment. Microsoft's [IPC documentation](https://learn.microsoft.com/en-us/windows/uwp/communication/interprocess-communication)
limits this utility mechanism to local sideload/debug scenarios; a positive experiment does not
establish an installed production control plane or release approval.

[Run 40372342820](https://github.com/oscharko-dev/Keiko/actions/runs/40372342820) kept the
utility alive but still could not establish either family's inbound connection. That fixture had
no network capability in its AppContainer tokens. The explicit inbound experiment now supplies
`privateNetworkClientServer` at profile creation and process launch, as required by Microsoft's
IPC documentation. Both concurrent trees and their outbound/UDP/descendant controls use that same
capability, so the experiment cannot hide a wider egress allowance behind a different test token.
The ordinary socket proof retains the original token and still requires a working control route.
This is a pending experiment, not an assertion that capability provisioning fixes the blocker.

[Run 40374429393](https://github.com/oscharko-dev/Keiko/actions/runs/40374429393) also failed the
inbound positive control with that capability in both families; outbound and cleanup controls
still passed. The next diagnostic reads at most 256 recent WFP events filtered to the synthetic
test executable. It reports only closed drop categories, layer/status numbers and identity-match
booleans, never raw events, filters or OS-supplied strings. It temporarily enables event collection
only in the disposable-runner experiment and restores the prior engine option on cleanup. This
diagnostic cannot turn a failed socket assertion into a pass.

[Run 40376126192](https://github.com/oscharko-dev/Keiko/actions/runs/40376126192) returned no
matching recent WFP events while both inbound connections remained unavailable. Absence of an
event is not proof that no OS policy blocked the connection. The fixture now also retains the real
Winsock error beside its closed control-route failure and reads back the system utility's bounded
filter summary. A non-privileged host-socket control checks successful TCP and a reserved,
non-listening port in both families; refusal or the bounded timeout must prevent a connection
independently of AppContainer. On the local host the reserved negative port times out (10060).
No raw filter, provider name or event contents are printed by these diagnostics.

[Run 40377579714](https://github.com/oscharko-dev/Keiko/actions/runs/40377579714) confirms a
package-matching loopback permit from the system utility, while the actual host connections time
out (`WSAETIMEDOUT`, 10060). The earlier 1225 value is the fixture's closed unavailable-route
result, not a captured Winsock refusal. The next control also provisions inbound access before
Keiko's outbound filters, so a failure of the utility itself can be separated from a conflict with
the exact egress policy. Listener exit state and closed filter-layer classifications are retained.

[Run 40379317902](https://github.com/oscharko-dev/Keiko/actions/runs/40379317902) also times out
with inbound provisioning and no Keiko egress filters; the listener remains alive. The utility's
single observed permit is at IPv4 receive/accept in the App-Isolation sublayer. No IPv6 counterpart
was observed. The next disposable experiment adds a separate Windows Firewall rule through the
documented [desktop AppContainer rule API](https://learn.microsoft.com/en-us/windows/win32/api/netfw/nf-netfw-inetfwrule3-put_localapppackageid):
one temporary package SID, the fixture executable, TCP, exact loopback addresses and the listener's
one port. It removes its fresh rule and verifies absence even after an uncertain add outcome.
The independent deny, exact outbound restrictions and owner-reaping controls remain required.
This was not an installed production rule or a relaxation of the ordinary socket proof.

[Run 40381384956](https://github.com/oscharko-dev/Keiko/actions/runs/40381384956) rejected that
experiment with `E_INVALIDARG` in both address families; its rule cleanup checks passed. Microsoft's
[`INetFwRules::Add` contract](https://learn.microsoft.com/en-us/windows/win32/api/netfw/nf-netfw-inetfwrules-add)
explicitly excludes adding a rule with `LocalAppPackageId`, despite that property existing on the
rule interface. The unsupported experiment and its COM dependencies have been removed. This does
not establish a working inbound route.

The bounded WFP diagnostic now expands the runner's short image pathname before constructing its
event query, and exercises an independently verified blocked outbound flow inside the collection
interval before probing inbound access. This positive control distinguishes an empty diagnostic
from evidence about the failing inbound route.

[Run 40384624097](https://github.com/oscharko-dev/Keiko/actions/runs/40384624097) validates that
diagnostic: both families record the expected outbound blocks and the actual inbound drops. IPv4
is blocked by Windows Firewall at receive/accept; IPv6 is blocked by AppContainer isolation at
receive/accept. Each bounded query returns six events. This separates the two failures without
logging private filter data or overriding either policy.

The next disposable experiment uses supported firewall rule fields: expanded fixture image,
current user owner, the AppContainer SID in the local-principal authorization list, exact loopback
addresses, TCP and the exclusively bound listener port. Microsoft's
[local-user rule contract](https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule#-localuser)
includes AppContainer principals. Real socket controls must still prove that admission; the
separate AppContainer isolation and exact WFP egress controls remain required. Every temporary
rule is removed and its absence verified.
Independent denies and utility-owner reaping must still take effect. No rule is installed locally
or integrated into production. The experiment also requires a foreign AppContainer with the same
executable and its own exclusive listener to be refused by the first tree's principal rule.

The experimental control route uses IPv4 with both outbound gateway families, matching
`opencodeLaunchProfile.ts` (`--hostname 127.0.0.1`) and `opencodeV2HttpClient.ts` (IPv4-only endpoint
admission). IPv6 outbound gateway, hostile-loopback, UDP and descendant tests remain required.
This does not claim IPv6 inbound support or change the ordinary socket proof; it corrects the
experimental composition to match the actual product. IPv6 AppContainer inbound admission remains
an unresolved capability outside that current control contract.

[Run 40387436811](https://github.com/oscharko-dev/Keiko/actions/runs/40387436811) creates and removes
the local-principal COM rule successfully, but both IPv4 control probes still time out. The
diagnostic identifies Windows Firewall's inbound block in both gateway-family cases. The next
runner-only probe uses the documented NetSecurity `New-NetFirewallRule -Package` parameter to
admit the exact AppContainer SID, retaining the executable, user, loopback and single-port limits.
A fixed script verifies its application, transport, address and security filters; the native owner removes
the unique rule and verifies absence even after uncertain creation. The script runs in a bounded,
owned process with discarded output, never through the default native test or production code.
The synthetic listener allows time for cold NetSecurity startup; the actual connection deadline
remains two seconds. Foreign-principal, independent-deny, outbound and reaping controls remain
mandatory. This is an unqualified experiment until the actual runner results are recorded.

Local preparation on 2026-10-28 compiled the complete fixture with MSVC `/W4 /WX /analyze` and
passed the default component tests without installing filters. The PowerShell parser passed.
Separate guard probes, with the mutating cmdlet replaced by a rejecting stub, verified refusal on
developer and self-hosted environments before rule creation. Only `github-hosted` Windows Actions
jobs can invoke this experiment. These local checks do not replace the disposable-runner socket
proof. The package rule uses Microsoft's documented
[`New-NetFirewallRule -Package` contract](https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule#-package).

[Run 40771565282](https://github.com/oscharko-dev/Keiko/actions/runs/40771565282) on `c8b77ae8b`
successfully creates, verifies and removes the package rule. The actual IPv4 host-to-AppContainer
connection passes both before and after Keiko's outbound filters, for both outbound gateway
families. The experiment then fails with `ERROR_NOT_READY` when starting a second inbound utility
while the first remains alive. No foreign-principal, independent-deny or reaping success is claimed
from that interrupted sequence, and the ordinary socket proof remains failed.

The follow-up probe first establishes a positive peer listener baseline and then tests that peer
against the wrong package rule with an independently owned utility. It retains the separate
concurrent-owner requirement and its failure verdict, while collecting the subsequent independent
deny, egress and owner-reaping results. Early utility exits report only a numeric exit code and
bounded filter readback, not localized output or private identities. This distinguishes package
scope from utility concurrency without turning a failed concurrent lifetime into a pass.

[Run 40774169836](https://github.com/oscharko-dev/Keiko/actions/runs/40774169836) on `5b607a251`
confirms the peer's own rule admits its listener and the wrong package rule refuses it, in both
gateway-family cases. The second simultaneous inbound utility exits with `0x80320009`
(`FWP_E_ALREADY_EXISTS`); its readback contains only the first package's filter. A later outbound
probe also failed, before independent-deny/reaping checks could execute.

That outbound failure exposed a separate fixture defect: the target listened with an eight-entry
backlog but never accepted completed connections. The default, unprivileged regression reproduced
exhaustion after the initial connection plus seven repetitions in both families. The fixture now
accepts and closes each completed probe's connections, verifies exact server-side counts and runs
16 successful reuse cycles per family. This preserves actual network-denial assertions instead of
mistaking a full listener backlog for enforcement. The concurrent-utility refusal remains a
separate failed qualification requirement.

Local protocol validation also ran the complete existing `runtime-gateway.test.ts`: 29 passed,
eight failed on existing POSIX filesystem fixtures rejected by Windows path canonicalization, and
25 macOS tests skipped. The new cross-language vector case passes individually. These baseline
failures remain visible; no suite-wide Windows skip or policy-validation relaxation was introduced.

Platform contracts used by these components:
[registry flush durability](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regflushkey),
[named-pipe client impersonation](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-impersonatenamedpipeclient),
[per-user AppContainer profiles](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile).

### Concurrent inbound ownership investigation, 2026-10-29

The existing two-owner experiment started the second utility and immediately stopped it. Even a
successful second start therefore did not prove that both identities could receive while both
owners were alive, or that removing one owner preserved the other identity's access. The same
experiment now checks both routes with both owners alive, reaps the second owner on every path,
then requires the first route to remain available and the second route to be refused. An early
second-owner failure still fails qualification while the later independent-deny and egress
controls run. No failure is converted into a concurrency pass.

The default native suite exercises this orchestration with an in-memory ownership model, including
failure at each startup, connection, cleanup and revocation step. The regression failed against
the original start/stop-only sequence and passes with the additional controls. These model checks
prove the experiment's verdict/cleanup logic only, not Windows socket enforcement or simultaneous
listener lifetimes. The real route checks remain disposable-runner-only.

Read-only static inspection of the local Microsoft `CheckNetIsolation.exe` version
`10.0.26100.9949` (SHA-256
`17dd503c2354634bff727afdcb934ea18bf3bec78d9fdd02c1ca067e80f2b992`)
found that its inbound path copies a fixed nonzero provider GUID into `FWPM_PROVIDER0`, calls
`FwpmProviderAdd0`, and exits that path on a nonzero result before calling `FwpmFilterAdd0`.
The same GUID is subsequently used as the filter's provider key. This supports a shared-provider
collision explanation for the recorded second-utility `FWP_E_ALREADY_EXISTS`, rather than a
collision in Keiko's per-tree outbound filters. It is a version-specific static inference, not a
trace of the hosted runner's failing API call. Microsoft documents the provider key as the unique
provider identity in [FWPM_PROVIDER0](https://learn.microsoft.com/en-us/windows/win32/api/fwpmtypes/ns-fwpmtypes-fwpm_provider0)
and the registration operation in [FwpmProviderAdd0](https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmprovideradd0).

Do not patch the system utility, delete its provider, ignore a failed second start, serialize the
trees to claim concurrency, or share one package identity between trees. The installed control
plane still needs independently owned inbound policy and real two-tree socket/lifetime evidence.
No WFP filter, exemption or firewall rule was changed on the developer host during this work.
[Run 40921240459](https://github.com/oscharko-dev/Keiko/actions/runs/40921240459) at
`14d436b06adf9919cdf4d41c060ccc167e1ff205` confirms the second utility still exits with
`FWP_E_ALREADY_EXISTS` in both gateway-family cases. Compilation, dynamic-filter cleanup and
guarded cleanup pass; the original socket proof and concurrent inbound experiment fail.

The next test-only experiment replaces the utility owner with a separate dynamic WFP session for
each package. It registers no shared provider and uses a fresh filter key. Its IPv4 receive filter
matches the exact package, loopback flag, TCP and `127.0.0.1`; the existing NetSecurity fixture
continues to bind the executable, user, package and ephemeral port. The filter uses the application
isolation sublayer and a soft permit, with no clear-action-right flag. Exact readback rejects wider
or unexpected policy; an independent session checks filter removal after owner closure. Pure
readback tests reject foreign identities, hard permits, missing/duplicate conditions, UDP,
non-loopback addresses and wrong layer/key/provider without opening WFP locally.

This remains an experiment, not an installed broker policy. It does not establish compatibility
with arbitrary rules in the same system sublayer, crash recovery, simultaneous listeners or IPv6
inbound access. Both gateway-family cases deliberately use IPv4 inbound control. The existing
foreign-principal, concurrent-owner, independent-deny, egress and revoked-owner socket assertions
remain mandatory.

At `e21added0960be3ea536caa124f998c777969f48`,
[run 40924632511](https://github.com/oscharko-dev/Keiko/actions/runs/40924632511) stopped during
socket baseline preparation before entering the replacement. A fresh-runner repeat,
[run 40925223213](https://github.com/oscharko-dev/Keiko/actions/runs/40925223213), reached it:
owned filter installation/readback/removal passed, but the first inbound connection was refused,
so concurrent ownership was not reached. The ordinary socket proof also remained red.

Further read-only inspection of the same local system utility shows an explicit `FWP_UINT64`
weight of `UINT64_MAX` before `FwpmFilterAdd0`. The fixture's initial `FWP_UINT8` value 15 instead
requested an automatically assigned weight in the highest range, which does not guarantee priority
over the application-isolation block. The fixture now requires the explicit maximum weight while
retaining its soft permit, four scope conditions, and independent-deny requirement. Its local
regression rejects the old automatic weight and passes with the explicit value; lower and null
weight readbacks are rejected. This is still a version-specific experiment, not permission to
bypass administrator policy or use this system sublayer in production. No successful socket receipt
is yet claimed for this correction.

### Compose inbound setup into the original socket proof, 2026-10-29

[Run 40926657608](https://github.com/oscharko-dev/Keiko/actions/runs/40926657608) at
`669117bb2e09ed6c570aca7acadf474064229fbf` passed the complete owned-session inbound experiment:
both identities were reachable with both sessions active, removing one revoked only its route,
and foreign-principal refusal, independent-deny precedence, readmission, retained egress confinement
and final revocation passed. That evidence used IPv4 inbound control with both gateway families.
The original `--socket-proof` still failed because it demanded inbound access without installing
inbound policy or granting the required capability.

The original proof now composes the same existing inbound owner, scoped firewall fixture and
lifetime controls for its actual address family. IPv4 uses `127.0.0.1`; IPv6 uses an exact `::1`
receive filter and the existing IPv6 firewall path. Both proof modes give the same private-network
capability to their baseline, outbound and descendant probes, so the original TCP/UDP confinement
assertions must also hold with that capability. Bare inbound access must be refused before the
positive owned-policy route is tested. Success still requires real admission before and after
outbound confinement, both active owners, foreign-principal refusal, independent-deny precedence,
remaining-owner access and revoked-owner refusal. A refused configured route never counts as a pass.

The dedicated `--inbound-control-proof` retains its IPv4 control / IPv4-or-IPv6 gateway composition,
matching the current OpenCode control client. The original proof adds same-family IPv6 inbound
coverage; neither command skips either outbound family or changes production availability.
The pure native regression fails with the old IPv4-only filter builder and passes with explicit
family selection. Readback additionally rejects cross-family layers, wrong/null IPv6 addresses and
unsupported address families without opening WFP locally. Hosted evidence for this composition is
pending; the maximum-weight system-sublayer policy remains disposable-test-only, with production
administrator-policy coexistence, simultaneous listeners and crash recovery still unqualified.

## Outstanding production work and qualification

- Authenticated, narrowly scoped installed service and capability negotiation.
- Production per-tree identity and filesystem access for the actual runtime payload.
- Native supervisor integration of suspended launch, verified filters and Job Object supervision.
- Public/LAN denial and adversarial token, executable and Job Object escape tests.
- Fail-closed behavior if the service, filtering engine or supervisor fails while a tree is active.
- Reap-before-filter-removal ordering and cleanup/reconciliation on every exit path.
- Installer, repair/uninstall, runtime packaging and npm composition.
- Body-free Activity Log integration and support diagnostics.
- Real DesignPatterns branch/file/compile/commit/publish workbench acceptance test.

The optional `--filter-lifecycle` test changes Windows filter state and requires explicit operator
approval and appropriate Windows privileges. It exercises only a synthetic identity and cannot
qualify AppContainer sockets. Do not invoke it in routine local validation or enable the runtime
because it passes.

The local operator declined network-filter changes on this PC on 2026-09-28 and subsequently
approved testing on disposable GitHub-hosted Windows runners. The dedicated
`windows-gateway-confinement.yml` development workflow runs the explicitly privileged lifecycle
test there, including IPv4/IPv6 installation and independent readback of filter and sublayer removal.
No filter-installation test runs on the developer PC. Do not remove the runtime's fail-closed refusal
or label the end-to-end issue fixed without actual socket and workbench evidence.

### Disposable runner result, 2026-09-28

[GitHub Actions run 36449500023](https://github.com/oscharko-dev/Keiko/actions/runs/36449500023)
passed on Windows Server 2025 at commit `f2a95a09590f9a12a3fa443b459db848f7c5cc03`.
MSVC compilation and static analysis completed successfully. Input validation passed, and both
IPv4 and IPv6 lifecycle tests returned `code=0`, including independent verification that the
filters and their private sublayer were removed. All steps of this dedicated workflow succeeded.

This result proves native filter installation and cleanup only. It does not prove socket isolation,
runtime integration, npm installation, the DesignPatterns workbench task, or the complete repository
CI matrix. Those acceptance criteria remain outstanding.

### Real socket and descendant proof, 2026-09-28

[GitHub Actions run 36452143283](https://github.com/oscharko-dev/Keiko/actions/runs/36452143283)
passed at commit `227a9918b23a23fd76d81bc13933aa506967b3a9`. Its `--socket-proof` test creates
two unique AppContainer profiles, two live TCP listeners and UDP receivers, and child processes
that themselves launch descendants. Before installing filters, both identities reach both TCP
ports and deliver UDP datagrams. With both trees running concurrently under separate policies,
each reaches only its own TCP port; neither UDP receiver receives a datagram. Both IPv4 and IPv6
pass. Children verify that their tokens are AppContainer tokens. The parent creates roots suspended,
assigns kill-on-close Job Objects before resume and reaps them before filter removal.

Full installed-filter readback verifies the layer, sublayer, action, weight, identity, destination,
port, protocol and condition cardinality. Windows adds `FWPM_FILTER_FLAG_INDEXED` metadata to
returned filters; that lookup optimization is accepted, while other flags remain rejected. UDP
proof uses actual reception, because Windows may complete `sendto` successfully for a datagram
subsequently blocked by filtering. The unfiltered reception baseline prevents a vacuous denial pass.

The fixture temporarily adds loopback exemptions for its unique identities and restores the
previous exemption list and executable ACL before deleting the profiles. This is explicitly
test-only: a crash between those operations is not reconciled by an installed service. A passing
socket fixture does not justify using that lifecycle in production or enabling availability.

The current implementation is tracked in [draft PR #4090](https://github.com/oscharko-dev/Keiko/pull/4090),
continuing the earlier [draft PR #3668](https://github.com/oscharko-dev/Keiko/pull/3668) foundation.
On 2026-10-26 the prescribed local Sonar gate passed against the changed files using the existing
Ubuntu/WSL Docker engine, the repository's pinned analyzer images, Node 24.18.0 and verified
Compose 5.6.1. The Windows Docker Desktop daemon remained unavailable. Strict native compilation,
default native tests, error-observability and the assembled package surface (6,937 files) also pass.
The full repository CI matrix and the actual DesignPatterns workbench commit remain unverified.

## Platform references

- [WFP engine sessions and dynamic object lifetime](https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmengineopen0)
- [WFP filter arbitration](https://learn.microsoft.com/en-us/windows/win32/fwp/filter-arbitration)
- [WFP filtering condition identifiers](https://learn.microsoft.com/en-us/windows/win32/fwp/filtering-condition-identifiers-)
