# ADR-0007: Verification Orchestrator and Resource Limits

## Status

Accepted

## Context

Issue #7 delivers the layer that turns "the agent changed code" into "the change is verified by
the project's own gates, with evidence." In a regulated banking and insurance environment, an
edit is not trustworthy until the repository's own tests, type checks, and lint pass — and the
result must be explainable, evidence-backed, redacted, and audit-ready, not a bare boolean.

Four interlocking requirements shape the design.

**Verification reuses the #6 boundary; it does not weaken it.** Every command this layer runs goes
through `runCommand` from `src/tools/exec.ts` unchanged. The verification layer adds NO new spawn
path, NO new allowlist, and NO new write surface. It is a consumer of the trust boundary, not a
second boundary. This is a hard constraint: any change to `src/tools/**`, `src/harness/**`,
`src/workspace/**`, or `src/gateway/**` would mean verification had reached past its layer.

**Resource limits must be honest.** Wall-time and output-size are genuinely enforced by #6
(`SandboxPolicy.defaultTimeoutMs` and `maxOutputBytes`). Memory is best-effort and Linux-only.
Network is documented-not-OS-enforced in Wave 1, exactly as ADR-0006 D2 Dimension 4 states. The
layer records all four dimensions on every result with an honest `enforced` flag rather than
claiming guarantees it does not have. Overclaiming enforcement in a regulated context is a
correctness defect, not a cosmetic one.

**Zero new runtime dependencies (ADR-0001, load-bearing).** No test-runner wrapper, no process
sampler library, no glob library. The `/proc` memory sampler and the script-name heuristics are
implemented with Node 22 built-ins only.

**The plan and report are the stable contract for the #10 audit ledger.** `VerificationPlan` and
`VerificationReport` are plain JSON-serializable objects. The ledger persists a report verbatim;
`summarizeForAudit` produces the structured, output-text-free projection the ledger stores so raw
command output never lands in the audit trail.

**Module location.** All new code lives under `src/verification/**`, mirroring the existing
`src/gateway/**`, `src/harness/**`, `src/workspace/**`, and `src/tools/**` conventions (typed
errors with redacted messages, a `types.ts` of interfaces plus frozen tables, a barrel
`index.ts`). The only edits outside the layer are additive: the `keiko verify` CLI subcommand and
the public export barrels.

## Decision

### D1 — A pure `classifyOutcome` with a fixed precedence maps every run path to a status

`VerificationStatus = "passed" | "failed" | "skipped" | "denied" | "timed-out" | "cancelled" |
"resource-exceeded"`. A PURE function `classifyOutcome` in `src/verification/classify.ts` is the
single authority that maps a settled `runCommand` outcome (a resolved `CommandResult`, or a
rejection, plus the orchestrator's `abortReason`) to a status. The precedence is fixed and the
first match wins:

1. step pre-marked skip (no detected script) → `skipped`
2. `error instanceof CommandDeniedError` → `denied`
3. `abortReason === "memory"` → `resource-exceeded`
4. `abortReason === "harness"` → `cancelled`
5. `error instanceof CommandTimeoutError` → `timed-out`
6. `error instanceof CommandCancelledError` → (`abortReason === "memory" ? "resource-exceeded" : "cancelled"`)
7. any other `error` → `failed`
8. resolved `result.timedOut` → `timed-out`
9. resolved `result.truncated` → `resource-exceeded` (output-size limit breached)
10. resolved `result.exitCode === 0` → `passed`
11. otherwise → `failed`

`abortReason` is checked before the abort-derived error types because an abort fires BOTH the
abort source and (a beat later) the `CommandCancelledError`; the reason carries the intent (a
memory breach vs. a harness cancellation) that the bare error type cannot. Each branch is covered
by an independent, mutation-robust unit test.

### D2 — Four resource dimensions, recorded honestly on every result

Per-command limits map to the #6 boundary:

| Dimension | Mechanism | Wave-1 enforcement |
|---|---|---|
| `wall-time` | `runCommand` `timeoutMs` (← step `limits.wallTimeMs`) | enforced — #6 SIGTERM→SIGKILL |
| `output-size` | `SandboxPolicy.maxOutputBytes` (← step `limits.maxOutputBytes`) | enforced — #6 kills on flood, sets `truncated` |
| `memory` | `ResourceMonitor` + `AbortController` (D3) | best-effort: enforced only on Linux with a ceiling set |
| `network` | `SandboxPolicy.network` (← step `limits.network`, default `"none"`) | NOT OS-enforced (ADR-0006 D2 Dim. 4) |

Every `VerificationResult.appliedLimits` records all four dimensions, always, with an honest
`enforced` flag. `network` is `enforced:false` with the note "documented; OS-level isolation
deferred to container wave (ADR-0006)". `memory` is `enforced:false` with a platform note whenever
the run is not on Linux or no `maxMemoryBytes` ceiling was requested. `breached:true` is set only
on the single dimension that actually fired for that step (output flood → `output-size`; the
sampler tripped → `memory`; wall-time → `wall-time`). This honesty is required, not optional.

### D3 — Memory monitoring without modifying #6: a SpawnFn wrapper plus a ResourceMonitor seam

The orchestrator owns an `AbortController` and wraps the injected base `SpawnFn`. It never edits
`src/tools/**`: it only supplies `runCommand` with an abort signal it controls and a spawn adapter
that attaches a watcher to the spawned child.

```ts
let abortReason: "harness" | "memory" | undefined;
const ac = new AbortController();
harnessSignal?.addEventListener("abort", () => { abortReason ??= "harness"; ac.abort(); }, { once: true });
let stop: (() => void) | undefined;
const spawn: SpawnFn = (cmd, args, opts) => {
  const child = baseSpawn(cmd, args, opts);
  stop = monitor.watch(child.pid, maxMemoryBytes, () => { abortReason ??= "memory"; ac.abort(); });
  return child;
};
try { const result = await runCommand({ ...input, signal: ac.signal }, { ...deps, spawn }); /* classify */ }
catch (e) { /* classify with abortReason */ }
finally { stop?.(); }
```

`stop?.()` runs in a `finally`, so the monitor interval is cleared on EVERY settle path — resolve,
reject, denied-before-spawn (where `stop` is never set and `stop?.()` is a no-op), and a throwing
classify. There is no path on which the interval leaks.

`ResourceMonitor` is a seam: `interface ResourceMonitor { watch(pid: number | undefined, maxBytes:
number | undefined, onBreach: () => void): () => void }`. `nodeResourceMonitor` polls
`/proc/<pid>/status` (`VmRSS` kB, page-size-independent) on Linux at a 250 ms `unref`'d interval
and calls `onBreach` once when RSS exceeds `maxBytes`. `/proc/<pid>/status` is a system path — NOT
workspace content — so it is read with raw `node:fs` (read-only, bounded, no secrets), not through
`WorkspaceFs`. On non-Linux, or when `maxBytes` is undefined, `watch` returns a documented no-op
unwatch and the dimension is recorded `enforced:false`. Tests inject a fake monitor that fires
`onBreach` deterministically; the real `/proc` sampler has a focused unit test that is skipped when
`process.platform !== "linux"` or `/proc` is absent.

### D4 — Missing scripts become a visible `skipped` step, never a silent omission

`buildVerificationPlan` emits a `VerificationStep` for each requested kind. When no script is
detected for a kind, the step carries a `skipReason` and the orchestrator emits `skipped` WITHOUT
spawning a process. "lint: skipped — no script" is therefore visible in the report and testable,
rather than the kind silently disappearing from the run.

### D5 — Sequential steps with cross-step cancellation

The orchestrator runs steps sequentially. Before each step it checks the harness signal; once
cancelled, the in-flight step classifies `cancelled` and every remaining step is reported
`cancelled` (not `skipped`, because the work was abandoned, not absent). Cancellation is honored
within the #6 termination bound: SIGTERM, then SIGKILL after `SandboxPolicy.terminationGraceMs`
(default 2000 ms). The report's `overallStatus` is `passed` iff every result is in
`{passed, skipped}`; `cancelled` if the run was harness-cancelled; otherwise `failed`.

## Seam table (what downstream issues depend on)

| Seam | Consumer | Contract |
|---|---|---|
| `VerificationPlan` / `VerificationReport` (plain JSON) | #10 audit ledger | Persist verbatim; stable field shapes |
| `summarizeForAudit(report)` | #10 audit ledger | Structured projection EXCLUDING raw `outputSummary` text |
| `ResourceMonitor` | container wave | Replace `nodeResourceMonitor` with a cgroup/container sampler without touching the orchestrator |
| `runVerification(plan, deps)` `deps.spawn` | container wave | Swap the base `SpawnFn` for a container-launching adapter (same swap point as ADR-0006 D7) |
| `buildVerificationSummary` / `renderMarkdownSummary` | CLI, PR bot | Redacted human/structured/Markdown surfaces |

## Consequences

### Positive

- The agent's edits are checked by the project's own gates, and the result carries the exit code,
  duration, a redacted output digest, and the exact resource limits applied — evidence a reviewer
  or an auditor can act on.
- Verification reuses the #6 boundary unchanged: the same deny-by-default allowlist, env isolation,
  no-shell spawn, and output redaction protect verification commands. There is no second, weaker
  execution path to audit.
- The four-dimension `appliedLimits` record is honest about what Wave 1 enforces. A reader can see
  at a glance that network is documented-not-enforced and memory is Linux-only best-effort.
- The `ResourceMonitor` and `SpawnFn` seams let the container wave add real isolation without
  changing the orchestrator or any consumer.
- The plan/report schemas are plain JSON, so the #10 audit ledger persists them without bespoke
  serialisation, and `summarizeForAudit` keeps raw command output out of the audit trail.

### Negative (honest Wave-1 limitations)

- **Memory enforcement is best-effort and Linux-only.** On macOS and Windows, or when no ceiling is
  set, the memory dimension is `enforced:false`. A runaway test process is bounded by wall-time and
  output-size, not by RSS, on those platforms. The `/proc` sampler also samples at 250 ms, so a
  process that allocates and exits within one interval can momentarily exceed the ceiling
  undetected. This is documented, not papered over.
- **Network is not OS-isolated.** Inherited from ADR-0006 D2 Dimension 4: a verification command
  (`node -e`, a test that opens a socket) can make outbound connections. The mitigation is the #6
  env allowlist (no credential reaches the child) and command allowlist, not OS network isolation.
- **Targeted-test resolution is best-effort.** It resolves sibling/mirrored `.test`/`.spec` files
  for vitest and jest; when the framework is `unknown` or no test file is resolvable, no targeted
  step is added rather than guessing an invocation that might run nothing or everything.
- **The Windows grandchild-orphaning limitation of ADR-0006 D2 Dimension 5 applies unchanged** to
  verification commands, since they spawn through the same #6 path.

### Neutral

- Steps run sequentially, not in parallel. Parallel execution would reduce wall-clock time but
  complicate the per-step resource accounting and the cross-step cancellation semantics; it is a
  future option behind the same plan/report contract.
- The synchronous `WorkspaceFs` read path is reused for `package.json` and targeted-test existence
  checks, matching the existing workspace-layer style.

## Alternatives Considered

### Alternative 1: A second command path tuned for verification vs. reusing `runCommand`

Build a verification-specific spawn path that skips the #6 allowlist (since "we know the commands
are safe npm scripts").

- **Pros**: fewer indirections; no need to confirm `npm test` passes `isCommandAllowed`.
- **Cons**: it creates a second, weaker trust boundary that the security auditor must review
  separately, and an `npm run <script>` runs whatever the repository's `package.json` defines —
  which is exactly the model-influenceable content #6 exists to contain.
- **Why rejected**: a regulated environment cannot have two execution boundaries with different
  guarantees. Reusing `runCommand` means one boundary, one audit. A test asserts the concrete
  `npm`/`npx` invocations pass `isCommandAllowed(DEFAULT_COMMAND_RULES, …)`.

### Alternative 2: Enforce memory via an OS mechanism (cgroups / ulimit) now vs. a best-effort sampler

Require cgroup v2 or `setrlimit` to hard-cap child RSS.

- **Pros**: a real, kernel-enforced ceiling that kills the process at the limit.
- **Cons**: cgroups need operator-granted permissions outside a Node library's control; `setrlimit`
  via `RLIMIT_AS` caps address space (not RSS) and breaks many runtimes that reserve large virtual
  ranges; both are platform-specific and one is unavailable without a native addon (a dependency).
- **Why rejected**: kernel-enforced memory limits belong in the container wave, behind the
  `ResourceMonitor` seam. The honest Wave-1 position is a documented best-effort `/proc` sampler
  with `enforced:false` where it cannot run, not an overclaimed guarantee.

### Alternative 3: Modify #6 to expose a memory hook vs. wrapping the injected `SpawnFn`

Add a memory-monitoring callback parameter to `runCommand`.

- **Pros**: the monitor would live next to the spawn it watches.
- **Cons**: it changes the #6 public surface and the trust boundary the security-auditor already
  signed off, for a concern that is purely additive and can be expressed with the existing injection
  points.
- **Why rejected**: the SpawnFn wrapper + the orchestrator-owned `AbortController` achieve memory
  monitoring with zero changes to `src/tools/**`. The wrapper only attaches a watcher to the child
  and the orchestrator only supplies an abort signal — neither bypasses any #6 gate.

## Related

- ADR-0001: Project Foundation and Toolchain — zero-runtime-dependency constraint; `src/verification/`
  module location; strict TypeScript/ESM/LOC limits.
- ADR-0002: CI and Supply-Chain Security Baseline — CodeQL `js/polynomial-redos` is a required merge
  gate; all detection/glob heuristics use linear regexes (single bounded/open quantifier, no nesting).
- ADR-0003: Model Gateway Boundary — `redact()` reused for every composed excerpt/detail/error.
- ADR-0005: Repository Context and Workspace Access Layer — `WorkspaceFs`, `detectWorkspace`, and
  `readWorkspaceFile` reused for script detection and targeted-test resolution; `summarizeForAudit`
  excerpt-exclusion pattern mirrored.
- ADR-0006: Safe Tool Execution and Sandbox Boundary — `runCommand` is the unchanged execution path;
  `SandboxPolicy` (`maxOutputBytes`, `defaultTimeoutMs`, `network`) is the limit mapping; the network
  and container-isolation limitations are inherited verbatim.
- Issue #7: Add verification orchestrator with resource limits, tests, type checks, and command
  evidence.
- Issue #10: Audit ledger — persists `VerificationReport`; `summarizeForAudit` is the output-text-free
  projection it stores.

## Date

2026-05-29
