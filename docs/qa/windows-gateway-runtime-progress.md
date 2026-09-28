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

Compiles both C files using `/W4 /WX /analyze /MT` and runs input validation. Tests reject null,
broad and capability identities, invalid address families, port zero, missing output storage, and
attempts to overwrite an active session. The default test makes no WFP calls and changes no network
filters. It is also invoked by the existing Windows native quality gate.

## Outstanding work and qualification

- Authenticated, narrowly scoped installed service and capability negotiation.
- Real unique per-tree AppContainer identity, workspace access and descendant restrictions.
- Suspended child creation, filter readback and verification before resume, Job Object supervision.
- Exact gateway socket success, hostile loopback/public/UDP denial, and cross-tree isolation.
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

## Platform references

- [WFP engine sessions and dynamic object lifetime](https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmengineopen0)
- [WFP filter arbitration](https://learn.microsoft.com/en-us/windows/win32/fwp/filter-arbitration)
- [WFP filtering condition identifiers](https://learn.microsoft.com/en-us/windows/win32/fwp/filtering-condition-identifiers-)
