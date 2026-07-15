# Managed Runtime Isolation Threat Model

Status: contract and qualification baseline for Issue #2443. Governing decision:
[ADR-0137](../adr/ADR-0137-managed-runtime-isolated-worker.md).

## Security objective

A compromised coding runtime must not reach ambient networks, host endpoints, credentials, or the
host workspace; widen its resources or lifetime; survive lease loss; impersonate another run or VM;
or cause a host effect outside Keiko policy. The boundary is one immutable Linux micro-VM per run,
owned by a signed native controller and reached only through an authenticated VM-private broker.

This document defines required negative evidence. It does not claim that the TypeScript contract,
an observation, or a platform probe enforces the boundary. Productive authority exists only while
the native controller/service holds the live authenticated channel and its controller-owned opaque
lease. The lease never crosses a serialization boundary.

## Trust boundaries

| Boundary                                | Trusted responsibility                                                                                                                                                     | Untrusted inputs                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Keiko BFF and policy layers             | Task/workspace binding, model/tool policy, revision revalidation, host effect application, content-free evidence                                                           | Browser requests, model/runtime output, repository content       |
| Signed native controller or SCM service | Live platform state, bundle verification, VM creation, private transport, nonce/sequence/revocation admission, monotonic deadline, opaque lease custody, whole-VM teardown | Every serialized request/descriptor/observation                  |
| Root-owned guest shim                   | Own VM socket, authenticate broker, expose only closed loopback model/tool operations                                                                                      | Unprivileged runtime traffic                                     |
| Unprivileged coding runtime             | Produce bounded requests/results against the shim                                                                                                                          | Runtime binary, generated code, repository snapshot              |
| Worker bundle and snapshot              | Exact signed/digested guest closure and filtered immutable input                                                                                                           | Staged archives, replacement images, repository-controlled files |

The browser, OpenCode, guest application user, TypeScript types, structural validators, durable
records, and evidence are outside the enforcement authority boundary.

## Fixed security profile

- New native-architecture Linux VM for every run; no warm pool, resume, or cross-run state.
- No vNIC. Exactly one virtio socket (macOS) or Hyper-V socket (Windows) reaches the closed broker.
- No directory share, host mount, clipboard, USB, GPU, balloon device, inherited environment, host
  home/configuration, provider credential, or arbitrary proxy/CONNECT.
- Exactly 2 GiB VM memory. Guest cgroup v2 fixes `memory.max=2147483648`,
  `memory.swap.max=0`, `memory.oom.group=1`, and `pids.max=32`; guest swap is disabled.
- Host-monotonic deadline is exactly 900,000 ms. Expiry triggers controller-owned whole-VM teardown.
- Input is a filtered source/tree-SHA-bound snapshot on disposable encrypted storage. Host effects
  return as normalized proposals for live Keiko revision and policy revalidation.
- Exactly `KEIKO_RUNTIME_ENDPOINT`, `KEIKO_MODEL_ALIAS`, and `KEIKO_RUN_CAPABILITY` enter the runtime
  environment. Values are transient and never observations or evidence.
- No remote, hardware-backed, or measured-attestation claim is made.

## Negative proof matrix

Every row is release-blocking for the owning implementation. A structural validator test is useful
input hardening but cannot replace the named live/native proof.

| Threat or attempted bypass                | Required control                                                                                                        | Required negative proof                                                                                                                        | Owner                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Add or hot-plug a network path            | Empty vNIC configuration and device inventory revalidation before start                                                 | Guest TCP/UDP/DNS egress and host-LAN reachability fail; inventory contains no network device                                                  | platform controllers / #2396         |
| Reach arbitrary host services through IPC | One VM-bound socket, closed authenticated broker protocol, no proxy/CONNECT                                             | Unknown method, arbitrary bytes, arbitrary destination, wildcard VM identity, and wrong audience fail                                          | broker/shim                          |
| Replay or detach a launch                 | Controller-owned nonce/sequence ledger plus run, audience, platform, bundle, VM/boot, epoch, policy, and expiry binding | Duplicate nonce/sequence, cross-run, cross-VM, cross-boot, old timestamp, wrong audience, and revoked epoch fail before productive broker work | platform controllers                 |
| Forge structural qualification            | Structural objects are untrusted data; controller returns only an opaque live lease                                     | Reconstructed JSON, TypeScript cast/brand, copied observation, and caller Boolean never admit control or broker work                           | native host / #2442                  |
| Replace/downgrade controller or guest     | Existing protected signing authority plus exact final bundle digests and profile digest                                 | Old, unsigned, wrong-platform, rebuilt, post-verification-modified, or unknown bundle fails                                                    | release/platform children            |
| Expose host workspace                     | No mount/share; filtered immutable snapshot only                                                                        | Guest mount table/device inventory has no host share; host workspace is unchanged by direct guest writes                                       | worker bundle / #2396                |
| Escape snapshot revision                  | Host re-resolves workspace and compares source/tree SHA before applying normalized effects                              | Host revision change converts result to conflict/recovery; stale result cannot apply                                                           | #2442                                |
| Inherit credentials or configuration      | Minimal exact environment; synthetic guest identity/configuration                                                       | Provider tokens, host home, Git config, npm config, proxy variables, and credential stores are absent                                          | worker bundle                        |
| Exceed memory                             | Exact VM memory, no balloon, no guest swap, cgroup hard limit and group OOM                                             | Balloon absent; swap remains zero; over-limit workload is contained/terminated without host fallback                                           | worker bundle / platform controllers |
| Exceed tasks                              | `pids.max=32`, which counts Linux tasks/threads                                                                         | 33rd task/thread fails; runtime cannot move itself to another cgroup                                                                           | worker bundle                        |
| Exceed lifetime                           | Host monotonic 900,000 ms watchdog independent of guest time                                                            | Guest clock changes, shim silence, busy loop, and paused protocol traffic cannot extend the deadline                                           | platform controllers                 |
| Leave descendants after stop              | Whole-VM termination is the kill boundary                                                                               | Fork, `setsid`, daemonization, shim/runtime crash, and hostile shutdown leave no VM or worker task                                             | platform controllers                 |
| Continue after BFF/lease loss             | Broker denies first; service/controller expires opaque lease and tears down VM                                          | BFF disconnect, lease expiry, BFF crash, and controller-channel replacement stop productive work                                               | native host / #2442                  |
| Survive Windows restart/crash             | SCM automatic start, durable content-free lease ledger, HCS enumeration, stale termination before ready                 | Service crash, controller crash, and machine restart enumerate and remove stale/unrecognized VMs                                               | Windows controller                   |
| Reuse state across runs                   | No warm pool; fresh boot, storage, nonce, capability, and lease                                                         | Second run cannot read first-run memory, disk, capability, broker state, or snapshot                                                           | platform controllers / worker bundle |
| Leak content through evidence             | Closed validators and allowlisted projection                                                                            | Paths, endpoints, VM/socket ids, env values, capabilities, lease, output, prompts, diffs, source, tool bodies, and logs are rejected           | contracts / evidence consumer        |
| Weaken unsupported platform               | Closed capability state and typed remediation; no fallback                                                              | Windows Home/arm64, disabled Hyper-V, unsupported macOS/API/hardware, missing entitlement/signature all remain unavailable                     | platform controllers / #2396         |

## Platform qualification matrix

| Host combination                                                                    | Expected result                                                                 | Required real-package evidence                                                                                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS 13.5+ arm64 on supported hardware                                             | Available only with native arm64 guest and signed/notarized entitled controller | `VZVirtualMachine.isSupported`, configuration validation, exact device inventory, bundle/signing digest, IPC authentication, resource and teardown negatives |
| macOS 13.5+ x64 on supported hardware                                               | Available only with native x64 guest and the same controller controls           | Same evidence on a real Intel host; arm64/emulation evidence is not transferable                                                                             |
| macOS below 13.5, wrong architecture, unsupported hardware/API, missing entitlement | Unavailable with closed reason/remediation                                      | No VM creation and no weaker fallback                                                                                                                        |
| Windows 11 Pro x64 with Hyper-V enabled                                             | Available only with qualified signed SCM service and HCS/Hyper-V socket         | Edition/feature/API/service identity, VM inventory, socket binding, lease/restart/resource/teardown negatives                                                |
| Windows 11 Enterprise x64 with Hyper-V enabled                                      | Same as Pro                                                                     | Independent edition evidence or a reviewed proof that the identical platform path applies                                                                    |
| Windows 11 Education x64 with Hyper-V enabled                                       | Same as Pro                                                                     | Independent edition evidence or a reviewed proof that the identical platform path applies                                                                    |
| Windows Home, non-x64, disabled/unavailable virtualization, missing/invalid service | Unavailable with typed remediation                                              | No elevation, feature enablement, service installation, container/process fallback, or productive launch                                                     |

The product minimum of macOS 13.5 follows the portable product's pinned Node 24 supported-platform
floor for both Darwin architectures. Apple Virtualization.framework itself has an older API baseline;
that does not lower the supported Keiko product matrix. Windows support is intentionally narrower
than all HCS-capable releases.

## Live native admission and lifecycle

For each request, the native controller/service must perform these operations against current state:

1. Verify the signed controller identity, exact controller and guest digests, platform/architecture,
   canonical profile digest, policy version, and revocation epoch.
2. Compare issue/expiry fields with the current host monotonic clock. A structurally valid old request
   is rejected live.
3. Atomically reserve the nonce and monotonically advancing sequence in a controller-owned bounded
   replay ledger. Replay or ambiguity denies before VM creation.
4. Create a fresh VM, obtain controller-observed VM and boot identities, validate the exact device
   inventory, and bind them to a new opaque lease.
5. Authenticate the broker session to that VM/boot/run/audience binding before productive operations.
6. Recheck lease liveness, deadline, revocation epoch, and broker/channel identity before every control
   or productive broker operation.
7. Deny new work first on expiry, revocation, disconnect, shutdown, or recovery; terminate the whole
   VM; durably record the content-free terminal state; and retire replay/lease state only when safe.

The TypeScript contract intentionally contains no qualification, enforcement receipt, public handle,
or serializable lease. Native implementation children own the opaque lease type and state machine
inside their process/service boundary. #2442 may hold that opaque value through an injected native
port but may not inspect, persist, reconstruct, or expose it.

## Rollback, revocation, and recovery

- A lower controller, guest, profile, policy, or revocation epoch is not a rollback path; it is a
  failed admission.
- Bundle/signing identity change requires reviewed release authority and renewed qualification.
- Policy or signing revocation prevents new launches and tears down affected live leases.
- Windows startup recovery finishes stale enumeration and termination before capability becomes
  `available`. Recovery observations contain aggregate counts and identity digests only.
- Cleanup failure stays unavailable and operator-remediated. It never authorizes continued work.

## Evidence allowlist

Allowed durable fields are schema version; closed platform, controller, lifecycle, capability, reason,
and remediation values; content-free run/task/workspace ids; source/tree and bundle/profile/VM/boot/
nonce digests; policy version; sequence and revocation epoch; timestamps; and aggregate counts.

Forbidden durable fields include the run capability value, opaque lease, broker endpoint, VM/socket
identifier, environment value, absolute or relative path, source, prompt, diff, tool body, output,
credential, provider response, raw exception, command line, private log, and customer data.

## Stable primary references

- [Apple Virtualization framework](https://developer.apple.com/documentation/virtualization)
- [Apple virtualization entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.virtualization)
- [Microsoft Hyper-V APIs and HCS](https://learn.microsoft.com/en-us/virtualization/api/)
- [Microsoft Hyper-V platform editions](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/overview)
- [Microsoft Hyper-V sockets](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/make-integration-service)
- [Linux cgroup v2 controllers](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
- [Portable Production Signing Contract](portable-production-signing-contract.md)
- [Portable Runtime Artifact Contract](portable-runtime-artifact-contract.md)
