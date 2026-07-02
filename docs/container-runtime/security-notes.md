# Container runtime — security notes (Issue #1388)

The container runtime lets Keiko run a **closed catalog** of vetted, server-frozen container tasks as
an **optional progressive enhancement**: a host with no container engine remains fully usable, and an
available engine unlocks only explicitly allowlisted tasks. It is governed by
[ADR-0070](../adr/ADR-0070-container-execution-governance.md) and is an **extension** of the ADR-0043
spawn boundary, not a relaxation: every container run is composed over the single `runCommand` spawn
boundary, exactly as the [#1387 command runner](../command-runner/security-notes.md) is. It is
deliberately **not** an arbitrary container runner. The Docker daemon socket is a root-equivalent
control surface, so this feature is treated as **enterprise-sensitive** and every control below is
server-frozen and not client-controllable.

The pilot ships exactly one diagnostic task against one pinned image, `docker.io/library/alpine:3.20`,
run with `--pull never` (the image must already be present locally; a missing image is a structured
failure, never a silent network fetch).

## Trust model

The runtime is a thin task-oriented layer on top of `runCommand`
(`packages/keiko-tools/src/exec.ts`), the single governed spawn boundary in the codebase. Every
guarantee `runCommand` already proves — no shell, name-allowlisted environment, ephemeral `HOME`,
byte-capped and redacted output, timeout with `SIGTERM`→`SIGKILL` of the process group — applies
unchanged. The container surface adds an engine probe, a closed task catalog, a closed image
allowlist, and a server-frozen `docker run`/`podman run` argv.

The host `docker`/`podman` CLI process is spawned with `network: "inherit"` because the CLI must reach
the local daemon socket; the **container** it launches is isolated by `--network none`. This asymmetry
is intentional and documented in ADR-0070 D4: the isolation control is on the container, not on the
host CLI process.

| Control                             | Where it is enforced                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deny-by-default command allowlist   | `CONTAINER_TASK_RULES` (`keiko-contracts/src/container-runtime.ts`) is passed to `runCommand` as `commandRules`. It permits only `docker`/`podman` with the `version`, `info`, and `run` subcommands, and denies the escalation flags the server's frozen argv never emits (`--privileged`, `--volume`, `--mount`, `--device`, `--cap-add`, `--net`, `--pid`, `--ipc`, `--user`, `-c`). It is a dedicated rule set, separate from `DEFAULT_COMMAND_RULES`, `TERMINAL_COMMAND_RULES`, and `COMMAND_TASK_RULES`, so the container surface cannot widen any of them. |
| No free-form argv / image / flags   | A run names a `taskId` from the server-frozen catalog. The browser/agent never supplies an executable, an image, an argument, a mount, or a flag. `buildContainerRunArgv` (`containerRunner.ts`) constructs the exact, server-frozen argv from the resolved `ContainerTask` and the `ContainerExecutionPolicy`. No code path takes client input into the argv.                                                                                                                                                                                                    |
| No shell                            | `runCommand` always spawns with `{ shell: false }` and an explicit argv array — no string interpolation, no transitive shell. The pilot task argv is a bare `echo` (not `sh -c …`); `-c` is itself a denied escalation flag.                                                                                                                                                                                                                                                                                                                                      |
| Read-only workspace mount only      | The single bind mount is `-v <workspaceRoot>:/workspace:ro` at a fixed in-container path. There is **no** read-write host mount, **no** broad host mount, and **never** a Docker socket mount.                                                                                                                                                                                                                                                                                                                                                                    |
| Network-isolated container          | The container is launched with `--network none`; it has no network access.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Dropped capabilities, no escalation | Every run uses `--cap-drop ALL` and `--security-opt no-new-privileges`. No `--privileged`, `--cap-add`, or `--device` is reachable.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| No automatic image pulls            | Every run uses `--pull never`. The image must already be present locally; a pull attempt or a missing image surfaces as a structured `pull-denied` / `image-missing` failure, never a silent network fetch.                                                                                                                                                                                                                                                                                                                                                       |
| Read-only root filesystem           | Every run uses `--read-only`, so the container cannot write to its own root filesystem.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Resource limits                     | Every run sets `--pids-limit 256` (blocks fork-bombs), `--memory 536870912` (512 MiB), and `--cpus 1` (`DEFAULT_CONTAINER_RESOURCE_LIMITS`). Where an engine or platform silently ignores a limit, the policy still records the requested value (ADR-0070, Consequences).                                                                                                                                                                                                                                                                                         |
| Output bound                        | Combined stdout/stderr is byte-capped at `SandboxPolicy.maxOutputBytes`; on overflow the child is killed, the result is flagged `truncated`, and the `failureReason` becomes `output-capped`. A flooding task cannot freeze the surface.                                                                                                                                                                                                                                                                                                                          |
| Timeout                             | A per-run wall-clock timeout is clamped to `MIN_TIMEOUT_MS` (1 s) and the policy ceiling, then sends `SIGTERM`→`SIGKILL` to the process group, so a hung daemon round-trip or container is reaped.                                                                                                                                                                                                                                                                                                                                                                |
| Cancellation                        | Each in-flight run holds an `AbortController`; `DELETE /api/containers/runs/:runId` aborts it. The browser learns the server-assigned `runId` from the SSE `run-started` event keyed to its own `requestId`, so a foreign run on the shared event channel cannot be cancelled by the wrong tab.                                                                                                                                                                                                                                                                   |
| Concurrency                         | At most `MAX_CONCURRENT_CONTAINER_RUNS` (2) concurrent runs per BFF — a deliberately tight cap for a high-trust surface; a further request is rejected with `RUN_LIMIT_EXCEEDED` (HTTP 429).                                                                                                                                                                                                                                                                                                                                                                      |
| No Docker socket mount              | The Docker socket is **never** mounted into a container. There is no `-v …docker.sock…` in any built argv, and no daemon-socket client library is bundled; the only daemon contact is the governed `docker`/`podman` CLI probe.                                                                                                                                                                                                                                                                                                                                   |

The decisive safety control is the **server-frozen argv plus the closed catalog and image allowlist**
(ADR-0070 D2/D3), proven by a frozen-argv equality assertion in `containerRunner.test.ts`. The deny
list is independent **defense-in-depth**: because `runCommand`'s `hasDeniedFlag` denies the whole
invocation if any denied flag appears anywhere in the argv, the deny list deliberately excludes the
flags the hardened argv itself emits (`--network`, `--security-opt`, `--cap-drop`, `-v`, `--read-only`,
`--pull`, `--pids-limit`, `--memory`, `--cpus`, `--rm`) so the runner cannot self-deny its own
hardened run. A load-bearing test asserts both that the frozen hardened argv **passes**
`isCommandAllowed(CONTAINER_TASK_RULES, …)` and that an argv with an injected escalation flag is
**denied**.

## Why this is not arbitrary container execution

The runtime exposes a **closed `ContainerTask` catalog**, a **closed image allowlist**, and a
**server-frozen argv** — the same "no free-form argv, named id resolves to a frozen argv" model that
makes the command runner not-RCE, applied to containers.

- A run request names a `taskId`. The server resolves it against the catalog; an unknown id is
  rejected with `TASK_NOT_FOUND` before any spawn.
- A resolved task's image must be a member of the `ContainerExecutionPolicy.imageAllowlist`; an image
  outside the allowlist is rejected with `IMAGE_NOT_ALLOWED`. `buildContainerRunArgv` re-asserts the
  allowlist membership, so even a misuse cannot emit a non-allowlisted image.
- Adding a new container task or image is a **code change and review**, not a configuration change.
  This is intentional for an enterprise-sensitive surface.

Because no code path takes client input into the image, the argv, the mount, or any flag, an attacker
who controls the run request cannot reach an arbitrary image or an arbitrary container invocation.

## Detection trust

Engine availability is answered by a **separate, opt-in active probe**
(`containerEngineDetector.ts`), invoked only on explicit request via `GET /api/containers/capability`.
It is distinct from the [#1385 metadata-only runtime detector](../local-runtime-capabilities.md),
which stays passive on its frequently-polled hot path and only reports `docker`/`podman` PATH
presence. The active probe:

- Runs `docker version` / `docker info` (and the `podman` equivalents) **through the same governed
  `runCommand` boundary** — deny-by-default `CONTAINER_TASK_RULES`, no shell, name-allowlisted
  environment, ephemeral `HOME`, byte-capped and redacted output, timeout with `SIGTERM`→`SIGKILL`.
- **Never throws.** Every outcome — including a probe timeout (`probe-timed-out`) or an unparseable
  response (`probe-failed`) — is a structured `ContainerEngineStatus`, mapped to the reused
  `RuntimeCapabilityState` / `RuntimeCapabilityUnavailableReason` vocabulary. The remediation hint is a
  static catalog string per state, never raw engine or OS error text.
- Is **never invoked from the #1385 hot path** (`detectRuntimeCapabilities`); coupling that hot,
  frequently-polled path to a high-trust daemon round-trip is explicitly rejected in ADR-0070
  (Alternative 1).
- Honors the `KEIKO_CONTAINERS_DISABLED` kill-switch: when the environment variable is set, every
  engine is short-circuited to `policy-blocked` **without spawning** (asserted by a test that the fake
  `runCommand` is never called).

When no engine is available, the capability route returns a content-free
`ContainerCapabilityResponse`, and the catalog and run routes answer `503
CONTAINER_ENGINE_UNAVAILABLE` rather than throwing. All non-container functionality is unaffected.

## Secret redaction

Redaction is dual-layer and applied **after** output is captured, never to inputs:

- **Layer 1 (env values):** `runCommand` scrubs the values of every non-allowlisted environment
  variable from stdout/stderr before they leave the spawn boundary.
- **Layer 2 (structural):** the BFF applies the shared live redactor (`deepRedactStrings` composed with
  the audit redactor — Bearer tokens, `sk-*` keys, PEM markers) to the run result before it reaches the
  browser and to every SSE event frame before it is written.

A focused test asserts that a secret-shaped string emitted to a run's output is replaced before the
response is returned (`containerRoutes.test.ts`).

## Audit evidence (content-free)

Each finished run writes a standard `EvidenceManifest` (`taskType: "container-run"`) through the
existing `EvidenceStore.put` port, carrying **counts and enums only**: run id, project id, task id,
task kind, engine name, a closed-catalog image **id** (never the raw image reference free-text supplied
by a caller), argument **count** (never the argv), exit code, duration, `timedOut`, `truncated`, and
`failureReason`. The constructed argv, the workspace path, and the captured container output are
deliberately excluded, and `deepRedactStrings` is applied to every string leaf before persistence
(ADR-0048 content-free invariant). Evidence writes are fail-closed for this governed execution
surface: after a container run settles, the manager persists the content-free manifest before emitting
the terminal run event or returning a successful run result. If evidence persistence is unavailable or
fails, the route returns `EVIDENCE_WRITE_FAILED` (HTTP 500) instead of reporting a successful
unaudited container run.

## NIST SP 800-190 mapping

The mandatory hardening flag set and the deny-by-default allowlist (ADR-0070 D3/D4) map to the
Application Container Security concerns of NIST SP 800-190 as follows:

| Hardening control (D3/D4)                                                                                             | NIST SP 800-190 concern                           |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `--cap-drop ALL`, `--security-opt no-new-privileges`, no `--privileged`/`--cap-add`/`--device`, allowlist denies them | 4.5.3 Privileged / over-privileged containers     |
| `--read-only`, `-v <ws>:/workspace:ro` only, no socket mount, allowlist denies `-v`/`--mount`/`--device`              | 3.1.2 / 4.5.2 Host filesystem & socket mount risk |
| `--network none` on the container, allowlist denies `--network`/`--net`                                               | 4.1.3 Unbounded network exposure                  |
| `--pull never`, closed image allowlist (catalog-only image ids)                                                       | 3.1.1 / 4.2 Image provenance & supply-chain       |
| `--pids-limit`, `--memory`, `--cpus`                                                                                  | 4.4.2 Resource limits / DoS                       |

Running the engine itself in rootless mode (Docker/Podman rootless) is the recommended host posture;
the controls above are independent of, and additive to, a rootless daemon. Podman's default rootless
operation is one reason both engines are first-class in `ContainerEngineId`.

## Out of scope

The following are explicitly **not** provided by this surface and are deferred behind their own issues
and security review:

- Mandatory containers — no code path makes a container required.
- Kubernetes or any orchestrator.
- Arbitrary or client-supplied image execution.
- Automatic image pulls (`--pull never` only; no network fetch on a missing image).
- Privileged containers, `--cap-add`, or `--device`.
- Read-write or broad host mounts (read-only `/workspace` only).
- Mounting the Docker socket into a container.
- A long-lived containerized LSP provider (the detection, policy, and spawn pieces here are the
  documented reuse seam for such a provider per ADR-0070 D7 and ADR-0069, but no provider ships here).
