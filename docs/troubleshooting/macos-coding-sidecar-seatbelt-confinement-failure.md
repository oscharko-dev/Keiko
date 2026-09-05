# macOS Coding Sidecar Fails Behind The Gateway Seatbelt Confinement

Operator guidance for a managed OpenCode sidecar (macOS dev lane or app-sandbox evaluation lane,
ADR-0140 D6 / ADR-0043 D11–D13) that never starts, or exits immediately, once the gateway-only
network confinement wraps its launch. The entry follows the
[troubleshooting entry template](./_template.md).

---

## The coding sidecar never becomes ready on macOS, or exits immediately after launch

| Field             | Value                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| Severity          | High                                                                                                      |
| Surface           | Local UI / Workspace                                                                                      |
| Stable identifier | `runtime.confinement.failed`, `runtime-gateway-confinement-required`, `runtime-gateway-confinement-drift` |

**Symptom**

The Coding Workbench reports the sidecar as unavailable, or a run that had reached `runtime
ready` exits within a second of every relaunch attempt with no further sidecar output. The
activity log carries an `op: "runtime.confinement.failed"` line at the same `correlationId` as the
run, with an `errorKind` and (when the failure happened before spawn) no process was ever created —
`spawns` observed by test/diagnostic tooling stays `0`.

**Root Cause**

Every macOS-activated long-lived sidecar (`devLaneRuntimeProcessBackend.ts`) is spawned only inside
a Seatbelt wrapper that denies all network egress except the exact configured Keiko gateway
loopback port, and denies process-fork, mach-lookup, Apple Event, and `LSOpen` (ADR-0043 D11). The
backend refuses to spawn at all — never falling back to an unconfined launch — in three cases:

1. **No confinement policy was attached to this backend at all**
   (`runtime-gateway-confinement-required`). In production composition a policy is always
   constructed from the current run's authority and payload digests; seeing this means the
   composition that built the backend is not the production path (a test seam, a partial
   composition, or a build defect) and the run was correctly refused rather than launched
   unconfined.
2. **The attached policy's `runId` or `treeBindingId` does not match the launch request**
   (`runtime-gateway-confinement-drift`). This is a fail-closed defense against a stale backend
   object being reused to spawn a different run's identity; it should not occur through ordinary
   restart or relaunch, since each activation constructs a fresh backend bound to the run it is
   launching.
3. **The Seatbelt wrapper itself could not run** — `/usr/bin/sandbox-exec` is missing, blocked by
   endpoint-security or MDM software that intercepts sandbox invocations, or the kernel rejects the
   compiled profile. The child process backend surfaces this the same way it surfaces any other
   spawn failure: through the child's `error` event, recorded as `runtime.confinement.failed` and
   re-thrown to the caller — the sidecar never starts unconfined as a fallback.

**Diagnostic Steps**

1. Activity log: search for `op: "runtime.confinement.failed"` at the run's `correlationId`. The
   `errorKind` and redacted `extra.frames`/`extra.causeChain` name the failure class without
   exposing the runtime root, the workspace path, or any endpoint.
2. Confirm the Seatbelt binary is present and executable:

   ```bash
   which sandbox-exec
   /usr/bin/sandbox-exec -p '(version 1)(allow default)' /bin/echo ok
   ```

   `command not found`, a non-zero exit, or output other than `ok` confirms case 3 above — the
   sandbox backend itself cannot run on this machine, independent of Keiko's policy.

3. If the log instead shows `runtime-gateway-confinement-required` or
   `runtime-gateway-confinement-drift` with **zero** spawn attempts, the failure occurred before
   any process existed; this points at the composition that constructed the backend, not at the
   host's Seatbelt support.

**Resolution**

For case 3 (Seatbelt unavailable or blocked): restore or unblock `/usr/bin/sandbox-exec` — this is
a stock macOS binary, so its absence or interception is almost always endpoint-security policy,
MDM configuration profile, or a modified system image; work with the machine's administrator to
allow it, or use a machine without that restriction. Do not disable or bypass the confinement to
work around this: the gateway-only egress boundary is the sidecar's only enforced protection
against a hostile or misbehaving long-lived process reaching the public network, and this scope is
macOS-only today (ADR-0043 D12) — there is no equivalent fallback on this platform.

For cases 1 and 2: these indicate the sidecar was launched through something other than the
production activation path (ADR-0140), or a defect in that composition. Capture the activity-log
line and open a finding; do not work around it by constructing a backend without a confinement
policy — that would launch the sidecar with no enforced network boundary at all.
