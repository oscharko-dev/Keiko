# macOS Coding Sidecar Fails Behind The Gateway Seatbelt Confinement

Operator guidance for a managed OpenCode sidecar (macOS dev lane or app-sandbox evaluation lane,
ADR-0140 D6 / ADR-0043 D11–D13) that never starts, or exits immediately, once the gateway-only
network confinement wraps its launch — and for a sidecar that starts fine but whose governed
`keiko_*` tool calls are denied by the same confinement (ADR-0043 D15). The entries below follow
the [troubleshooting entry template](./_template.md).

---

## The coding sidecar never becomes ready on macOS, or exits immediately after launch

| Field             | Value                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity          | High                                                                                                                                                 |
| Surface           | Local UI / Workspace                                                                                                                                 |
| Stable identifier | `runtime.confinement.failed`, `runtime-gateway-confinement-required`, `runtime-gateway-confinement-drift`, `runtime-gateway-confinement-unavailable` |

**Symptom**

The Coding Workbench reports the sidecar as unavailable, or a run that had reached `runtime
ready` exits within a second of every relaunch attempt with no further sidecar output. The
activity log carries an `op: "runtime.confinement.failed"` line at the same `correlationId` as the
run, with an `errorKind` and (when the failure happened before spawn) no process was ever created —
`spawns` observed by test/diagnostic tooling stays `0`.

**Root Cause**

Every macOS-activated long-lived sidecar (`devLaneRuntimeProcessBackend.ts`) is spawned only inside
a Seatbelt wrapper that denies all network egress except the exact configured Keiko gateway
loopback port, and denies mach-lookup, Apple Event, and `LSOpen` (ADR-0043 D11). `process-fork`
remains available for the pinned OpenCode sidecar's Git handshake, while `process-exec` admits only
the verified sidecar and Apple's fixed Git launcher/implementation paths. Arbitrary shells, curl,
compilers, and other child executables are denied; admitted descendants inherit the same network
restriction. A complete fork denial produces a distinct symptom: the sidecar starts and answers
`/health`, but `POST /sync/history` and `GET /session` return HTTP 500 (surfaced upstream as an
OpenCode handshake/protocol error, not as `runtime.confinement.failed`) (#3390). The backend refuses
to spawn at all — never falling back to an unconfined launch — in three cases:

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
3. **The Seatbelt wrapper itself could not run**, in either of two distinct places:
   - **Pre-spawn: the availability probe already knows it cannot** (`runtime-gateway-confinement-unavailable`,
     `devLaneRuntimeProcessBackend.ts`'s `spawnConfinedTree`). The shared `planIsolatedRun` planner
     (`@oscharko-dev/keiko-sandbox`) selects a gateway-confinement backend before any process is
     created; on macOS that selection requires `sandbox-exec` to be present and usable
     (`BackendAvailability.seatbelt`). When it is not, the planner returns a `fail-closed` decision
     and the backend throws synchronously — **zero** spawn attempts, no child process ever exists.
   - **At spawn: an already-selected `sandbox-exec` fails unexpectedly anyway** — missing,
     blocked by endpoint-security or MDM software that intercepts sandbox invocations, or the
     kernel rejects the compiled profile at invocation time. The child process backend surfaces
     this the same way it surfaces any other spawn failure: through the child's `error` event,
     recorded as `runtime.confinement.failed` and re-thrown to the caller.

   Either way the sidecar never starts unconfined as a fallback.

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
   host's Seatbelt support. `runtime-gateway-confinement-unavailable` also shows zero spawn
   attempts, but points the other way: it is the pre-spawn form of case 3 — the availability probe
   already found `sandbox-exec` unusable before a child was ever created; step 2 above confirms it.

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

---

## Every `keiko_*` tool call fails while OpenCode-native tools keep working

| Field             | Value                                                                             |
| ----------------- | --------------------------------------------------------------------------------- |
| Severity          | Blocker                                                                           |
| Surface           | Run engine / Workspace                                                            |
| Stable identifier | `keiko-tool-denied`, `ConnectionRefused` ("Was there a typo in the url or port?") |

**Symptom**

The coding run reaches `runtime ready` and the model can call `todowrite`, `question`, and other
OpenCode-native tools normally, but **every** governed Keiko tool call — `keiko_workspace_discover`,
`keiko_git_status`, `keiko_changeset_edit`, and every other `keiko_*` tool — fails within a couple
of milliseconds of being invoked. The model can never discover the workspace, read a file, propose
an edit, run verification, or commit; the run is effectively stuck making no forward progress even
though the sidecar itself looks healthy.

**Root Cause**

This is ADR-0043 D15 (#3390): the macOS `keiko-gateway` Seatbelt confinement (D11) allows
network-outbound to exactly ONE attested loopback destination. Before the D15 fix, the OpenCode
tool facade bridge opened a SECOND, self-issued ephemeral loopback listener and handed the sidecar
a `KEIKO_TOOL_FACADE_URL` pointing at it — a destination the profile correctly had never attested
and therefore correctly denied. Every `keiko_*` tool call reached the OS network layer, was refused
before a single byte reached Keiko, and surfaced to the model as a generic connection failure. A
build that still exhibits this symptom predates the D15 fix, which moved the tool facade onto the
SAME attested loopback BFF port `/api/coding-sidecar/gateway/*` already uses (at the sibling route
`POST /api/coding-sidecar/tool`) instead of a second listener.

**Diagnostic Steps**

1. Export and reconstruct the run's timeline:

   ```bash
   keiko support export --out bundle.jsonl
   keiko support analyze bundle.jsonl --correlation-id <runCorrelationId> --json
   ```

2. Look for `op: "gateway.tool-catalog.call-bound"` lines showing the model successfully binding
   the governed tool catalog, immediately followed by **no** corresponding request line for
   `/api/coding-sidecar/tool` and **no** `op: "coding-sidecar.tool-facade.rejected"` line either.
   That combination — the model bound the tools, but the server recorded no attempt to serve one,
   rejected or otherwise — confirms the call never reached Keiko at all; it was denied at the OS
   network layer before the request could be logged.
3. Confirm the sidecar's own OpenCode-native tools (`todowrite`, `question`) succeed in the same
   timeline. Native tools succeeding alongside every `keiko_*` call failing, with no server-side
   evidence of the failed calls, rules out a facade authentication or admission-gate rejection
   (both of which DO log a body-free `coding-sidecar.tool-facade.rejected` line) and points at the
   network layer instead.

**Resolution**

Update to a Keiko build that includes the ADR-0043 D15 fix; there is no local workaround, because
the correct action for the older behavior is exactly what the Seatbelt profile already does —
deny the second, unattested destination. Do not widen the Seatbelt profile to allow a second
loopback port to "fix" this locally: that would recreate the exact defect D15 closes, weakening the
gateway-only egress boundary the profile exists to enforce.
