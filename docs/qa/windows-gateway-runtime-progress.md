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

A profile-free identity experiment did **not** launch on this Windows 11 host (`CreateProcessW`
reported error 2). The same identity fixture passed with the documented temporary profile lifecycle.
Production design must therefore account for per-user profile creation and crash recovery; merely
deriving a SID is not qualified as a replacement. No AppContainer loopback exemption or WFP filter
was installed during these local tests.

The local package build/typecheck passed. Full service, installer, exact endpoint, crash/reboot,
non-elevated production launch and actual Workbench acceptance remain outstanding.

Platform contracts used by these components:
[registry flush durability](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regflushkey),
[named-pipe client impersonation](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-impersonatenamedpipeclient),
[per-user AppContainer profiles](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile).

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

Implementation is tracked in [draft PR #3668](https://github.com/oscharko-dev/Keiko/pull/3668),
stacked on the checkout fix in [PR #3667](https://github.com/oscharko-dev/Keiko/pull/3667).
The local Sonar gate was attempted but could not start because the Docker daemon is unavailable.
The full repository CI matrix and the actual DesignPatterns workbench commit remain unverified.

## Platform references

- [WFP engine sessions and dynamic object lifetime](https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmengineopen0)
- [WFP filter arbitration](https://learn.microsoft.com/en-us/windows/win32/fwp/filter-arbitration)
- [WFP filtering condition identifiers](https://learn.microsoft.com/en-us/windows/win32/fwp/filtering-condition-identifiers-)
