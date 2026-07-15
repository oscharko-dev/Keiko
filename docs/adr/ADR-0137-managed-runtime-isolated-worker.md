# ADR-0137: Managed runtime isolated worker

## Status

Accepted (2026-07-15). Architecture and contract foundation for Issue
[#2443](https://github.com/oscharko-dev/Keiko/issues/2443), the first implementation prerequisite
under Epic [#2384](https://github.com/oscharko-dev/Keiko/issues/2384).

## Context

Managed Code tasks execute an upstream coding runtime against repository-derived input. Native
process sandboxes, process groups, generic containers, and caller-authored runtime facts cannot
jointly prove the required network, workspace, resource, descendant, provenance, and crash-recovery
properties on supported macOS and Windows hosts. ADR-0043 and ADR-0070 remain useful for narrower
execution and optional container workloads, but their availability claims and host bind mounts do not
establish this boundary.

ADR-0136 supplies protocol-independent precedents for closed plans, private endpoints, bounded
lifecycle state, content-free evidence, and revalidation immediately before launch. Its DAP capsule
is not the Code-task topology: argv-derived claims, process-group containment, bind mounts, and
same-user endpoint ownership are not proof of a VM, guest boot, or VM-bound peer.

This decision freezes the production topology and public structural contracts before native
controllers, the Linux worker bundle, broker/shim transport, or the TypeScript host are built.

## Decision

### D1 — One immutable Linux micro-VM exists for one run

Every managed Code-task run receives a newly booted Linux micro-VM owned by the signed platform
controller. The VM is never reused, resumed as a warm worker, or returned to a pool. It exposes:

- no virtual network interface;
- one platform-private socket device for authenticated broker traffic;
- disposable encrypted storage containing a filtered, immutable, source/tree-SHA-bound snapshot;
  and
- no host directory share, workspace mount, clipboard, USB, GPU, provider credential, host
  configuration, or inherited host environment.

OpenCode runs as an unprivileged guest user. A root-owned guest shim alone owns the VM socket and
serves a closed Keiko model/tool protocol on guest loopback. The shim is not an HTTP, SOCKS, CONNECT,
or arbitrary byte proxy. All model, tool, workspace mutation, Git, credential, policy, and evidence
authority remains in Keiko on the host.

### D2 — The isolation profile is exact, not tunable per launch

Contract schema `1` fixes profile `isolated-worker-v1` and its canonical SHA-256 digest. A launch
cannot override any profile field:

| Control | Fixed value |
| --- | --- |
| VM memory | exactly 2,147,483,648 bytes (2 GiB) |
| Balloon device | absent |
| Guest swap | disabled |
| Guest cgroup v2 | `memory.max=2147483648`, `memory.swap.max=0`, `memory.oom.group=1`, `pids.max=32` |
| Deadline | 900,000 ms measured by a host monotonic clock |
| Network | no vNIC; authenticated VM-bound broker only |
| Workspace | no mount; filtered immutable SHA-bound snapshot |
| Pooling | none |
| Attestation claim | local controller verification only; no remote or measured attestation |

The canonical serialization is the UTF-8 encoding of the exported
`MANAGED_RUNTIME_ISOLATION_PROFILE_CANONICAL_JSON`: compact JSON, exact documented property order,
no insignificant whitespace, and the exact three-name environment array order. Tests independently
require `JSON.stringify(MANAGED_RUNTIME_ISOLATION_PROFILE)` to equal those bytes and recompute their
SHA-256 digest. Native implementations consume the same reviewed bytes; they do not reserialize an
unordered map or trust the digest constant alone.

`pids.max` counts Linux tasks, including threads, rather than only process leaders. Thirty-two is a
release qualification target, not a default that an implementation may silently increase. Real
OpenCode qualification at 2 GiB and 32 tasks belongs to the downstream platform qualification issue;
failure there blocks support instead of changing this profile.

Polling, exit notifications, memory-pressure events, and guest self-reporting are observations, not
enforcement. After live admission succeeds, the controller starts a private exact 900,000 ms watchdog
using `mach_continuous_time()` on macOS or `GetTickCount64()` on Windows. That watchdog is independent
of serialized UTC fields and guest time. The controller configures the VM boundary, the guest image
configures cgroup v2 before the runtime starts, and the controller owns whole-VM termination when the
watchdog expires. A machine reboot invalidates private watchdog/challenge state and startup recovery
removes any surviving VM before availability can return.

### D3 — Bundles and launches are bound to reviewed identities

The existing portable artifact and production-signing authority remains the source of worker payload
provenance. A managed-runtime bundle descriptor binds the platform target, signed controller bundle
digest, Linux guest bundle digest, isolation-profile digest, and exact runtime environment tuple.
Replaced, stale, downgraded, mismatched, replayed, expired, or unknown values fail before launch.

A versioned launch request binds run, task, and workspace ids; source commit and tree SHA; platform
and architecture; controller bundle, live controller-instance, guest bundle, and profile digests;
fixed IPC audience; nonce; monotonic sequence; `issuedAtUnixMs` and `expiresAtUnixMs`; revocation
epoch; and policy version. The UTC Unix-epoch-millisecond validity window is positive and at most
900,000 ms. Structural parsing checks only shape and the window; it deliberately does not call
`Date.now()` or admit authority. The live native controller compares both fields with its current UTC
wall clock immediately before admission.

The nonce is a controller-minted, one-use challenge. It is outstanding only in controller-private
monotonic state and is bound to the exact `controllerInstanceDigest`. Admission requires the current
instance, exact challenge, and sequence to match and consumes the challenge atomically. Controller
restart destroys outstanding challenges, so a structurally valid request from another or restarted
instance cannot cross a reboot boundary. No public challenge, launch-authority, or serialized
monotonic-timestamp type exists.

### D4 — Only the controller channel and opaque lease carry authority

The native controller or Windows service revalidates the launch request and live machine state, then
creates the VM. Successful launch returns an opaque, controller-owned lease through the live native
controller/service channel. The lease is not serializable, persistable, reconstructible from fields,
or accepted from a browser, caller, TypeScript brand, evidence record, or observation. Every control
operation requires both the live authenticated channel and the current opaque lease.

The controller binds that lease to the request plus the created VM identity, boot identity, broker
session, and current revocation epoch. It rejects nonce/sequence replay, controller-instance mismatch,
audience detachment, downgrade, wall-clock expiry, replaced bundles, and policy revocation. The exact
900,000 ms private monotonic VM watchdog begins separately after admission. Serialized lifecycle
observations contain only hashes and closed status data. They are evidence and diagnostics, never an
enforcement receipt.

### D5 — Broker authentication is VM- and run-bound

The guest receives exactly these environment names:

1. `KEIKO_RUNTIME_ENDPOINT` — the fixed guest-loopback shim endpoint, never a host URL, socket path,
   or arbitrary destination;
2. `KEIKO_MODEL_ALIAS` — a closed model alias resolved by Keiko; and
3. `KEIKO_RUN_CAPABILITY` — a transient capability bound to the run, IPC audience, VM/boot identity,
   nonce, sequence, expiry, revocation epoch, and policy version.

Unknown, duplicate, reordered, or case-variant names are rejected. Values are never durable evidence.
The shim and host broker mutually authenticate over the VM-private socket before productive work.
The browser never receives the endpoint, capability, lease, VM socket identity, or broker authority.

### D6 — Host effects return through Keiko

The guest cannot mutate the host workspace directly. It returns normalized proposed patches, tool
requests, and bounded results through the shim. The host re-resolves task/workspace authority,
revalidates source/tree revision and policy, and applies effects through existing Keiko tool, Git,
model-gateway, and evidence boundaries. A stale snapshot produces conflict/recovery, not direct write.

### D7 — Platform support is closed and fails without fallback

| Host | Required production boundary | Fail-closed cases |
| --- | --- | --- |
| macOS arm64 | macOS 13.5 or later; Apple Virtualization.framework; native arm64 Linux guest; `com.apple.security.virtualization`; signed/notarized hardened-runtime controller; virtio socket; no network, sharing, balloon, or optional device configuration | unsupported OS/API/hardware, missing entitlement, wrong architecture, invalid signature/notarization, or configuration validation failure |
| macOS x64 | macOS 13.5 or later; the same controls with a native x64 Linux guest | the same cases; emulation is not a substitute for native x64 qualification |
| Windows x64 | Windows 11 Pro, Enterprise, or Education x64; Hyper-V enabled by enterprise/OS administration; stable Host Compute System APIs; Authenticode-signed SCM service; Hyper-V socket; no virtual NIC | Home/other edition, arm64, missing/disabled virtualization, absent/invalid service, HCS/socket failure, or incomplete stale-VM recovery |

Apple's Virtualization framework manages VMs of the host architecture and requires the virtualization
entitlement; its configuration API exposes network, socket, directory-sharing, balloon, USB, and
graphics devices explicitly, so the controller can validate the exact allowlist before construction.
The product floor is macOS 13.5 because the portable product's pinned Node 24 runtime supports both
Darwin architectures from 13.5, which is stricter than the framework's macOS 11 API baseline.

Microsoft documents HCS as the platform-level VM/container management API and Hyper-V sockets as
non-IP host/guest communication addressed by VM plus service identity. Hyper-V is included in the
selected Windows 11 editions but not Home. Keiko never enables the feature, elevates, installs the
service, or edits machine-wide registration from the runtime path.

### D8 — Windows service recovery is durable and deny-first

The signed SCM service owns a bounded, content-free machine lease ledger. It enumerates controller-
owned VMs on service startup and machine restart, compares them with live unexpired BFF leases, and
force-terminates every stale or unrecognized VM before reporting availability. BFF disconnect,
lease expiry, controller crash, service restart, and machine restart all deny new productive broker
work first and converge on whole-VM termination. A guest never continues productively after its BFF
lease expires. Cleanup failure reports typed unavailable/recovery state; it never falls back to a
process sandbox, container, host runtime, or caller assertion.

Machine recovery is not a per-run lifecycle event. `ManagedRuntimeRecoveryObservation` is a separate
closed `pending | completed | failed` projection with `startup | restart` trigger, concrete platform
and controller kind, controller-bundle/profile/policy-version digests, `observedAtUnixMs`, canonical
inventory digest, and enumerated/stale/unrecognized/terminated/failure counts. Every enumerated VM is
classified as stale or unrecognized. Pending evidence may be empty or partially settled; completed
evidence requires every enumerated VM terminated and zero failures (including a valid all-zero scan);
failed evidence requires at least one failure and complete terminal accounting.

`inventoryDigest` is SHA-256 over the UTF-8 bytes of
`keiko-managed-runtime-recovery-inventory-v1\0` followed by compact JSON for a list sorted by VM
identity digest. Each private list entry has exact property order `vmIdentityDigest`,
`classification`, `outcome`; classifications are `stale | unrecognized`, and outcomes are
`pending | terminated | failed`. The empty list is exactly `[]` and has the exported
`MANAGED_RUNTIME_EMPTY_INVENTORY_DIGEST`. The list itself is never durable evidence.

### D9 — Evidence is content-free and non-authoritative

Capability, lifecycle, and recovery observations use closed versions, platforms, states, reasons,
remediation codes, explicit Unix-epoch-millisecond timestamps, counts, sequence/epoch values, and
lowercase SHA-256 digests. Lifecycle evidence contains `runIdDigest`, `taskIdDigest`,
`workspaceIdDigest`, and `policyVersionDigest`, never the raw values or IPC audience. The digest is
SHA-256 over the UTF-8 domain prefix plus raw value, using the exported exact prefixes
`keiko-managed-runtime-v1:run-id\0`, `keiko-managed-runtime-v1:task-id\0`,
`keiko-managed-runtime-v1:workspace-id\0`, and
`keiko-managed-runtime-v1:policy-version\0`.
Controller-instance digests use `keiko-managed-runtime-v1:controller-instance\0`. Domain separation
prevents cross-field substitution, but deterministic digests of guessable identifiers remain
dictionary-confirmable; evidence access control and retention therefore remain mandatory, and these
digests must not be described as anonymous.

The observations exclude capabilities, leases, receipts, endpoints, VM/socket identifiers, paths,
environment values, output, prompts, diffs, source, tool bodies, credentials, private logs, and
customer data. VM, boot, and nonce identities appear only as digests. A capability observation may
be structurally valid without proving recovery readiness: the native controller may report
`available` only when its current in-process recovery state for the exact
platform/controller-bundle/profile/policy tuple is `completed` with zero failures. The capability
schema intentionally has no replayable `recoveryObservationDigest`. Observations may prove that a
controller reported an event; they cannot authorize work or substitute for the live channel and
opaque lease.

### D10 — Downstream ownership is disjoint

| Scope | Owner |
| --- | --- |
| Linux guest bundle, root shim bootstrap, cgroup and device-negative image tests | worker-bundle child |
| Virtualization.framework controller, entitlement/signing and arm64/x64 qualification | macOS controller child |
| SCM service, HCS lifecycle, durable leases, startup enumeration and stale termination | Windows controller child |
| Authenticated broker and closed guest-loopback shim protocol | broker/shim child |
| Live native-channel composition, opaque lease custody, task/workspace/model/tool integration | #2442 TypeScript host child |
| Signed packaged-product platform, resource, crash, and negative evidence | #2396 qualification |

No child may reopen the authority model by serializing the lease, adding a public enforcement receipt,
mounting the host workspace, adding a vNIC, widening the resource profile, or permitting a fallback.

## Consequences

- Code tasks have a stronger but separately installed platform prerequisite and narrower supported
  host matrix than the base portable product.
- Startup cost is paid per run because warm pooling is forbidden.
- Offline guest operation is intentional: all productive external effects cross the authenticated
  broker and Keiko authority boundaries.
- Local verification is precise but is not hardware-backed or measured attestation.

## Alternatives considered

1. **Native process sandbox plus process groups.** Rejected: it cannot prove the complete
   cross-platform network, memory, descendant, filesystem, boot, and crash-recovery profile.
2. **Generic Docker/Podman container.** Rejected: daemon/socket authority, host bind mounts, variable
   engine policy, and Windows availability do not satisfy the selected boundary.
3. **Host workspace bind mount into a VM.** Rejected: it lets guest compromise bypass Keiko revision
   and mutation policy.
4. **Caller-provided attestation or TypeScript brand.** Rejected: structural data is forgeable and
   replayable outside the live controller.
5. **Warm VM pool.** Rejected: it creates cross-run state and identity lifetime.

## Verification

- Focused contract tests validate every closed enum, fixed value, required binding, expiry/replay
  field, exact environment tuple, unknown-field rejection, immutable output, and content-free schema.
- [Managed runtime isolation threat model](../release/managed-runtime-isolation-threat-model.md)
  defines the negative and platform qualification matrix.
- Native children must produce real signed-package evidence; simulation and serialized observations
  cannot qualify a platform.

## References

- [Apple Virtualization framework](https://developer.apple.com/documentation/virtualization)
- [Apple `VZVirtualMachine`](https://developer.apple.com/documentation/virtualization/vzvirtualmachine)
- [Apple virtualization entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.virtualization)
- [Apple virtio socket configuration](https://developer.apple.com/documentation/virtualization/vzvirtiosocketdeviceconfiguration)
- [Microsoft Hyper-V APIs and HCS](https://learn.microsoft.com/en-us/virtualization/api/)
- [Microsoft Hyper-V platform support](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/overview)
- [Microsoft Hyper-V sockets](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/make-integration-service)
- [Microsoft Service Control Manager](https://learn.microsoft.com/en-us/windows/win32/services/service-control-manager)
- [Linux cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
- [Node.js supported platforms](https://github.com/nodejs/node/blob/v24.x/BUILDING.md)
- [ADR-0121](ADR-0121-portable-managed-install-and-release-asset-update-authority.md)
- [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md)
- [ADR-0136](ADR-0136-governed-debug-adapter-session-management.md)
