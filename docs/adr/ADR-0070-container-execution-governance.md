# ADR-0070: Container Engine Detection and Governed Execution Pilot

## Status

Accepted (2026-06-26). Pending human review. Authored for Issue [#1388](https://github.com/oscharko-dev/Keiko/issues/1388) (Parent Epic [#1491](https://github.com/oscharko-dev/Keiko/issues/1491)).

## Date

2026-06-26

## Version

1.0

## Context

Several editor/runtime epics want a stronger isolation primitive than the per-platform OS sandboxes ADR-0043 selects: an enforced, identical-everywhere execution boundary for untrusted code, and (per ADR-0069) a future home for containerized LSP providers on hosts where one ships. ADR-0043 D3 already names `docker`/`podman run --network=none` as the universal egress backend, but it detects a container runtime only as a **fail-closed availability probe** (a read of whether a backend binary exists); it never runs a container as a product capability and never contacts a daemon.

Issue #1388 introduces the first product use of a container engine. This is a materially different trust posture. The Docker daemon socket is a **root-equivalent control surface**: a process that can talk to it can mount the host filesystem, run privileged containers, and escape to the host. NIST SP 800-190 (Application Container Security) enumerates exactly these risks — privileged containers, host bind mounts, unbounded network exposure, and unverified image provenance. The engineering note on the issue is explicit: "Docker socket access is high trust. Treat this feature as enterprise-sensitive."

Two hard constraints frame every decision below:

1. **Optional progressive enhancement, graceful degradation.** A host with no engine (CI, locked-down enterprise laptops) must remain **fully usable**; an available engine unlocks only explicitly-allowed enhanced capabilities; any engine error must surface as a structured unavailable/degraded state, never an exception that breaks a surface.
2. **The #1385 metadata-only detector must not be weakened.** `packages/keiko-server/src/runtime/capabilityDetector.ts` is deliberately passive — it never spawns executables, never reads Git config, never talks to daemons — so it can run on every capability poll within a 250 ms deadline. Actively probing a daemon there would couple a hot, frequently-polled path to a high-trust I/O operation. The new active probe is a **separate, opt-in** surface.

This ADR is the citable decision record for the new `keiko-contracts/src/container-runtime.ts` leaf, the `containerEngineDetector`/`containerRunner` server modules, and the `/api/containers/*` routes. It is an **extension** of ADR-0043, not a relaxation: every container run is composed over the single `runCommand` spawn boundary.

## Decision

### D1 — Detection is an opt-in active probe through `runCommand`, never on the hot path, never throwing

We will add a `containerEngineDetector` that **actively** runs `docker version` / `docker info` (and the `podman` equivalents) **through the governed `runCommand` boundary** (deny-by-default allowlist, `shell: false`, name-allowlisted env + ephemeral HOME, byte-capped + redacted output, timeout with SIGTERM->SIGKILL). It distinguishes a closed set of structured states:

- `available` — engine present and daemon answered.
- `missing` — no engine binary on PATH (maps to `RuntimeCapabilityState "missing"` / reason `executable-not-found`).
- `not-running` — binary present, daemon unreachable (reason `daemon-not-running`).
- `permission-denied` — socket exists but the user lacks access (reason `executable-not-runnable`).
- `unsupported` — engine version below the supported floor (reason `unsupported-version`).
- `policy-blocked` — engine present but disabled by policy/kill-switch (reason `policy-blocked`).

The detector **never throws**: every outcome — including a probe timeout (`probe-timed-out`) or an unparseable response (`probe-failed`) — is a structured `ContainerEngineStatus`. It is invoked **only on explicit request** via `GET /api/containers/capability`, never from `detectRuntimeCapabilities`. The #1385 detector is unchanged; its existing metadata-only `container-engine` entries (docker/podman PATH presence) remain the cheap, hot-path signal, and this probe is the authoritative on-demand answer that distinguishes installed-but-down from available.

### D2 — The execution pilot is a closed catalog + server-frozen argv composed over the single `runCommand` boundary

We will run an allowlisted container task as a **server-frozen `docker run` argv** built from a **closed `ContainerTask` catalog**. The client/agent names a `taskId`; it **never** supplies an image, an argv, a mount, or a flag. The server resolves the id to a vetted task and constructs the exact argv. Execution reuses `runCommand` as the single spawn boundary (ADR-0043 D2) exactly as the #1387 command runner does — no second execution path, no Docker SDK, no daemon-socket client library. An unknown `taskId` is rejected with `TASK_NOT_FOUND` before any spawn. This is the same "no free-form argv, named-id-resolves-to-frozen-argv" model that makes the command runner not-RCE, applied to containers.

### D3 — Mandatory hardening flag set on every pilot `docker run`

Every pilot run is constructed with this exact, always-on flag set, none of it client-controllable:

```
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit <N> --memory <M> --cpus <C> \
  --pull never -v <workspaceRoot>:/workspace:ro <frozen-image> <frozen-args...>
```

- `--rm` — no container persistence (NIST 800-190 4.4 container runtime, no residue).
- `--network none` — the **container** has no network (NIST 800-190 4.1.3 network exposure). Note D4: the host `docker` CLI process still uses `network: "inherit"` to reach the daemon socket; the isolation is on the container, not the CLI.
- `--read-only` + `-v <ws>:/workspace:ro` — read-only root filesystem and a **read-only** workspace bind mount at a fixed in-container path; **no read-write host mounts, no broad host mounts** (NIST 800-190 3.1.2 / 4.5.2 host mount risk).
- `--cap-drop ALL` + `--security-opt no-new-privileges` — drop all Linux capabilities and forbid privilege escalation (NIST 800-190 4.5.3 privileged/over-privileged containers).
- `--pids-limit` / `--memory` / `--cpus` — bounded resources where the engine supports them (NIST 800-190 4.4.2 resource limits / DoS).
- `--pull never` — the image must already be present locally; **no automatic image pulls** (NIST 800-190 3.1.1 / 4.2 image provenance and supply-chain). A missing image is a structured `image-missing` failure, never a silent network fetch.

Explicitly forbidden, by construction (the argv is server-frozen so these can never be reached): `--privileged`, `--cap-add`, `--device`, any `--network` override, any read-write or non-`/workspace` host mount, and **mounting the Docker socket into the container**.

### D4 — Deny-by-default allowlist (`CONTAINER_TASK_RULES`) as defense-in-depth

We will pass a dedicated `CONTAINER_TASK_RULES` `CommandRule[]` to `runCommand`, separate from `DEFAULT_COMMAND_RULES`, `TERMINAL_COMMAND_RULES`, and `COMMAND_TASK_RULES`, so the container surface cannot widen any of them. It allows only `docker` and `podman` with subcommands `version`, `info`, `run`, and denies the escalation flags the server's frozen argv NEVER emits: `--privileged`, `--volume`, `--mount`, `--device`, `--cap-add`, `--net`, `--pid`, `--ipc`, `--user`, `-c`. Because `runCommand`'s `hasDeniedFlag` denies the whole invocation if any deny-flag appears anywhere in the argv, and the runner passes its own hardened argv through that same boundary, the deny list MUST exclude the flags the hardened argv uses (`--network`, `--security-opt`, `--cap-drop`, `-v`, `--read-only`, `--pull`, `--pids-limit`, `--memory`, `--cpus`, `--rm`) — otherwise the runner would self-deny. The host `docker` CLI process is spawned with `policy.network: "inherit"` (the CLI must reach the local daemon socket) while the **container** is isolated by `--network none`. The decisive safety control is therefore the server-frozen argv + closed catalog (D2/D3), proven by a frozen-argv equality test; the deny list is belt-and-suspenders against a future regression that let a client-influenced token reach the argv, since today no code path takes client input into the argv at all.

### D5 — Fail-closed / degraded posture; Keiko stays fully usable

When no engine is available, or any engine error occurs, the system surfaces a structured `unavailable`/`degraded` state and **all non-container functionality is unaffected** (AC1/AC3). The capability route returns a content-free `ContainerCapabilityResponse`; the catalog and run routes answer `503 CONTAINER_ENGINE_UNAVAILABLE` rather than throwing. An available engine unlocks **only** the explicitly-allowlisted catalog tasks (AC2). No code path makes a container mandatory.

### D6 — Content-free evidence (`"container-run"`)

We will add a `"container-run"` member to `EvidenceTaskType` and write a standard `EvidenceManifest` per finished run, carrying **counts and enums only**: run id, task id, a closed-catalog image **id** (never a free-text image string supplied by a caller), arg count (never the argv), exit code, duration, `timedOut`, `truncated`, and `failureReason`. It never carries the constructed argv, the workspace path, or any container output. `deepRedactStrings` is applied to every string leaf before persistence (ADR-0048). Evidence writes are fail-closed for this governed execution surface; a write failure returns `EVIDENCE_WRITE_FAILED` instead of reporting a successful unaudited container run.

### D7 — Extension seam for future containerized LSP providers

ADR-0069 deferred container supervision for LSP providers. This ADR defines the reusable pieces a future containerized provider will compose, without shipping one: (1) the `containerEngineDetector` answers "is an engine available" with the same structured-state contract a provider needs to set its `LanguageProviderDescriptor.availability`; (2) the `ContainerExecutionPolicy` (image allowlist, resource limits, mount mode, network mode) is the policy object a long-lived provider container would be configured against; (3) the `runCommand` boundary + `CONTAINER_TASK_RULES` allowlist are the spawn governance it would reuse. A containerized LSP provider remains **out of scope** here — like ADR-0069's real language servers, it lands behind its own per-provider implementation issue and security review. The pilot's one-shot `docker run` is sufficient to validate the detection + policy + spawn composition end-to-end.

## Normative References (controls -> NIST SP 800-190 concern)

| Hardening control (D3/D4) | NIST SP 800-190 concern |
| --- | --- |
| `--cap-drop ALL`, `--security-opt no-new-privileges`, no `--privileged`/`--cap-add`/`--device`, allowlist denies them | 4.5.3 Privileged / over-privileged containers |
| `--read-only`, `-v <ws>:/workspace:ro` only, no socket mount, allowlist denies `-v`/`--mount`/`--device` | 3.1.2 / 4.5.2 Host filesystem & socket mount risk |
| `--network none` on the container, allowlist denies `--network`/`--net` | 4.1.3 Unbounded network exposure |
| `--pull never`, closed image allowlist (catalog-only image ids) | 3.1.1 / 4.2 Image provenance & supply-chain |
| `--pids-limit`, `--memory`, `--cpus` | 4.4.2 Resource limits / DoS |

Rootless-mode guidance (Docker/Podman rootless) is the recommended host posture for the engine itself; the pilot's controls are independent of (and additive to) running the daemon rootless, and Podman's default rootless operation is why both engines are first-class in `ContainerEngineId`.

## Consequences

### Positive

- A genuinely optional progressive enhancement: hosts without an engine are unaffected; the high-trust container surface is reachable only on explicit request and only for allowlisted tasks.
- Every NIST 800-190 container-security concern in scope maps to an always-on, server-frozen control; the allowlist is independent defense-in-depth.
- No new spawn boundary, no Docker SDK, no daemon-socket client library — the supply-chain/SBOM surface is unchanged; container governance is composed entirely over the proven `runCommand` boundary.
- The #1385 metadata-only detector keeps its hot-path, daemon-free guarantee; the active probe is a separate opt-in surface.
- The detection + policy + spawn composition is validated by a one-shot pilot and is the documented reuse seam for a future containerized LSP provider (ADR-0069).

### Negative

- The pilot **requires an engine to exercise the run path**; CI has none, so the run-path proof is **hermetic** (injected fake spawn / injected detector outcome). A real container is never run in CI. The browser smoke proves only the unavailable path (AC1). True end-to-end container execution is validated locally/operator-side, not in CI.
- The host `docker` CLI process runs with `network: "inherit"` (it must reach the daemon socket). The container is `--network none`, but the CLI process itself is not network-isolated — this is an accepted, documented asymmetry. The decisive container isolation is on the container, and the argv is frozen.
- Resource flags (`--pids-limit`/`--memory`/`--cpus`) have uneven cross-engine/cross-platform support; where unsupported they degrade rather than fail. The policy records the requested limits even when the engine silently ignores one.
- The closed catalog means adding a new container task is a code change + review, not a configuration change. This is intentional for an enterprise-sensitive surface.

### Neutral

- Detection works on Linux/macOS/Windows (it is a governed CLI probe); the pilot run requires an installed engine on the host. The capability contract is identical across platforms; only the resolved state differs.
- The `ContainerExecutionPolicy` is plumbing the pilot exercises minimally; its image-allowlist and limit fields are forward-defined for the LSP-provider seam (D7) without a live long-lived consumer yet.

### Explicitly NOT provided

- Mandatory containers; Kubernetes or any orchestrator; arbitrary/client-supplied image execution; automatic image pulls; privileged containers; `--cap-add`/`--device`; read-write or broad host mounts; mounting the Docker socket into a container; a long-lived containerized LSP provider (deferred per D7); persistence of detection/run lifecycle to anything beyond the content-free evidence manifest.

## Alternatives Considered

### Alternative 1 (detection): extend the #1385 metadata-only detector to ping the daemon

- **Pros**: one detector; capability poll would already report available-vs-down.
- **Cons**: the #1385 detector is deliberately passive and runs on every poll within a 250 ms deadline; adding a daemon round-trip couples a hot, frequently-polled path to a high-trust, potentially slow I/O operation, and risks blowing the deadline on a hung socket.
- **Why rejected**: it weakens the explicitly metadata-only contract the issue forbids weakening. A separate opt-in probe keeps the hot path passive.

### Alternative 2 (detection): bundle a container SDK / dockerode-style client

- **Pros**: typed daemon API; richer state.
- **Cons**: a new high-trust runtime dependency that speaks directly to the root-equivalent socket, triggering the dependency/license-review gate; it is a second control surface outside `runCommand`.
- **Why rejected**: a governed CLI probe through the existing boundary gives the structured states we need with zero new dependency and one spawn boundary. Reversible: a future need could revisit, behind a gate.

### Alternative 3 (execution): accept a client-supplied image + argv with validation

- **Pros**: flexible; supports arbitrary tasks without catalog edits.
- **Cons**: arbitrary image execution and client-influenced argv are precisely the out-of-scope, enterprise-sensitive risks (image provenance, escalation flags); validation of an open argv against an evolving daemon is a losing game.
- **Why rejected**: explicit non-goal. The closed catalog + server-frozen argv is the only model that makes the surface not-RCE, mirroring the #1387 command runner.

### Alternative 4 (execution): a dedicated container-spawn path / daemon-socket execution module

- **Pros**: could stream container logs natively; bypasses CLI quirks.
- **Cons**: introduces a **second spawn boundary**, violating ADR-0043 D2 and the ADR-0019 single-command-boundary invariant; re-implements env-allowlisting, redaction, timeout, and kill-group that `runCommand` already proves.
- **Why rejected**: composing `docker run` over `runCommand` reuses every existing control. A bespoke path would have to re-earn all of them.

## Related

- [ADR-0043](ADR-0043-enforced-execution-isolation.md) — the single `runCommand` spawn boundary (D2) and the read-only container-runtime **availability** probe (D3) this ADR extends into a product capability. This ADR adds no new spawn boundary; the container CLI is spawned through `runCommand`.
- [ADR-0069](ADR-0069-governed-lsp-process-manager.md) — deferred container supervision for LSP providers; D7 here defines the detection/policy/spawn seam such a provider will reuse.
- [ADR-0048](ADR-0048-evidence-artifact-confidentiality.md) — content-free / redacted evidence invariant followed by the `"container-run"` manifest.
- Issue [#1388](https://github.com/oscharko-dev/Keiko/issues/1388) (Epic [#1491](https://github.com/oscharko-dev/Keiko/issues/1491)) — implementing issue.
- `packages/keiko-server/src/command-runner.ts` — the #1387 closed-catalog / server-frozen-argv template this design mirrors.
- `packages/keiko-server/src/runtime/capabilityDetector.ts` — the #1385 metadata-only detector kept unchanged.
- NIST SP 800-190, *Application Container Security Guide* — privileged containers (4.5.3), host mounts (4.5.2), network exposure (4.1.3), image provenance (4.2), resource limits (4.4.2).
- Docker / Podman rootless mode documentation — recommended host posture; rationale for both engines being first-class.
