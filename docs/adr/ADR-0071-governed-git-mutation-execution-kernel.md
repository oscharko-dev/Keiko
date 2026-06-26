# ADR-0071: Governed Git Mutation Execution Kernel

## Status

Proposed

## Context

Epic #470 turns Keiko's read-only relationship to Git into a governed, end-to-end delivery platform.
Issue #471 (ADR-0070) delivered the typed contract surface: action kinds, a risk taxonomy, the
lifecycle envelope, policy packs with a deterministic `evaluateGitPolicy`, and provider-neutral
interfaces. Those are pure data and validators in the `keiko-contracts` leaf — they describe _what a
governed action is_, not _how it executes_.

Issue #472 is the next child: build the execution and preflight kernel that consumes those contracts
and actually drives governed local Git writes. The product value is not raw Git coverage; it is
**predictable authority and failure behavior** — every mutation must follow one repeatable path with
machine-readable outcomes, and local Git write authority must never widen back into generic shell
access.

Four forces shape the design:

**Force 1 — One repeatable lifecycle.** Every mutation must resolve content-free inputs, run
deterministic preflight, produce a content-free preview, evaluate policy, and only then execute and
emit a structured result. Callers (approval UX, evidence ledger, recovery) must read where the
lifecycle halted and why without parsing strings.

**Force 2 — No generic shell fallback.** ADR-0018 keeps the terminal `git` allowlist read-only:
`isTerminalCommandAllowed` denies every mutating subcommand. The new write surface must not be
reachable by widening that allowlist or by any "run this git command" escape hatch. It must flow
through a narrow, typed adapter whose every invocation is a fixed argv built from typed operands.

**Force 3 — Determinism for preflight.** Preflight must be reproducible: the same repository state
always yields the same findings, so a rerun is idempotent and a caller can distinguish an actionable
user fix from an internal fault.

**Force 4 — Boundary reuse, not a parallel path.** ADR-0019 designates `keiko-tools` as the single
no-shell spawn boundary (env isolation, deny-by-default allowlist, redaction, cancellation). The Git
adapter must execute through that boundary, never open a parallel `child_process` path.

### Scope boundary (Issue #472)

In scope: the orchestrator, deterministic preflight evaluators, the narrow local Git adapter with no
generic fallback, the structured failure taxonomy, and retry/idempotency semantics. Out of scope
(later children): end-user approval UI (#473), the evidence ledger and audit export (#474),
productized branch/commit UX (#475), publish/push orchestration (#476), the PR provider (#477), and
merge governance (#478).

## Decision

We introduce five modules in `packages/keiko-tools/src/`, forming a one-directional dependency DAG
(`taxonomy` and `preflight` depend only on the contract leaf; `adapter` adds the command table;
`orchestrator` composes them; the Node `git-mutation-node` adapter carries the spawn effect on the
`./internal/git-mutation` subpath):

1. **`git-mutation-taxonomy.ts`** — the orchestration vocabulary: the ordered lifecycle phases, the
   five failure categories, the lifecycle status union, and total mappings from the contract's
   execution-error codes to categories.
2. **`git-mutation-preflight.ts`** — a content-free `GitWorktreeSnapshot` and pure per-kind
   evaluators producing typed findings.
3. **`git-mutation-adapter.ts`** — the narrow `GitLocalMutationAdapter` port, the closed governed
   command table, the dedicated allowlist, and the pure argv builders.
4. **`git-mutation-orchestrator.ts`** — the single execution authority that drives the lifecycle.
5. **`git-mutation-node.ts`** — the Node adapter that runs governed plans through the keiko-tools
   spawn boundary (internal subpath).

### D1 — The lifecycle orchestrator (AC1)

`runGitMutation(request, deps)` is the single execution authority. It advances one repeatable path:
**resolve → preflight → preview → policy → execute → result**. The descriptive
`GitDeliveryActionEnvelope` is always populated through the policy phase — it is the contract artifact
preview and evidence consumers read — while two enforcement gates decide whether execution proceeds:

- **Gate 1 (preflight):** a blocking preflight finding halts before policy enforcement and execution.
- **Gate 2 (policy + approval):** policy must permit, and any required approval must be valid and
  unexpired.

The returned `GitMutationLifecycleResult` carries the envelope, a `GitMutationOutcome`, the
`phaseReached` (where enforcement halted, or `result` when complete), and the full preflight report.
The orchestrator is deterministic given its injected dependencies (snapshot, clock, id generator,
adapter) and performs no IO itself: Git execution lives behind the injected adapter, so the
orchestrator is unit-testable with a fake adapter and never opens a parallel `child_process` path
(Force 4).

The orchestrator's command union is the **local mutation kinds** — `branch-create`, `stage`,
`unstage`, `commit`, `abort`, `recovery`. Remote and provider kinds (`push`, `pr-create`,
`pr-update`, `merge`) are part of the shared contract and are classified by preflight and policy, but
their orchestrated execution is delivered by later slices that extend the union and register their
executors. Modeling the union as local-only is a typed scope boundary, not a placeholder: no runtime
"unsupported kind" branch is needed because the type only contains executable kinds.

### D2 — Deterministic preflight (AC2)

Preflight is a pure function over a content-free `GitWorktreeSnapshot` (counts, flags, and
branch/remote names only — no paths, diffs, or command output). Per-kind evaluators cover the
conditions Issue #472 enumerates: worktree state, detached HEAD, branch existence, upstream
readiness, untracked-file impact, commit-policy readiness, remote reachability, and in-progress
operations.

Each finding carries a typed `code`, a contextual `severity` (`blocking` halts; `advisory` informs),
and an intrinsic `remediation` (`user-actionable` vs `internal`). The remediation split is the AC2
distinction: a caller can route "stage a file" or "configure an upstream" differently from a kernel
construction fault, with no message parsing. Because the evaluator is pure over `(inputs, snapshot)`,
reruns are byte-identical — preflight reruns are idempotent by construction (Force 3).

### D3 — The narrow local adapter, no generic fallback (AC3)

`GitLocalMutationAdapter` exposes one typed method per local kind and **no** method that accepts an
arbitrary argument vector. That absence is the AC3 guarantee: there is no path from the kernel to
"run this git command string." Each method builds a fixed argv plan from the pure builders; operands
are validated (no NUL, no flag-injection via a leading `-` on refs) and file pathspecs are placed
after a `--` sentinel so a path can never be reinterpreted as an option.

The Node adapter runs plans through the single keiko-tools spawn boundary (`runCommand`) with a
**dedicated** `GIT_MUTATION_COMMAND_RULES` allowlist that permits only the governed mutation
subcommands and denies global config / cwd-shifting / code-execution flags. This rule set is separate
from both the read-only terminal policy and the harness default. The two surfaces are complementary
and machine-checked: every argv the adapter can produce is denied by `isTerminalCommandAllowed`, and
every governed subcommand is outside the read-only allowlists. No network subcommand (`push`,
`fetch`, `clone`) appears in the governed set — remote execution is a later slice behind a separate
gateway, never this local adapter.

### D4 — Structured failure taxonomy (AC4)

The kernel names five failure categories — `policy-block`, `preflight-block`, `execution-failure`,
`provider-failure`, `recovery-required` — as DATA, never inferred from a message. The
`GitMutationOutcome` discriminated union binds a status (`succeeded` / `approval-required` /
`blocked` / `failed` / `recovery-required`) to its category and payload, and the contract's closed
execution-error codes map to categories through a total table (e.g. `conflict` and
`precondition-failed` → `recovery-required`; `provider-rejected` / `network-failure` →
`provider-failure`; `timeout` / `internal-error` → `execution-failure`). A new error code forces a
compile error in the table rather than falling through to an untyped default. Approval UX, evidence
capture, and recovery logic consume these categories without string parsing.

### D5 — Idempotency and safe retry

Preflight, preview, and policy are pure and always safe to rerun. Execution is guarded by an optional
`GitMutationJournal` keyed by an `idempotencyKey`: a re-submitted request that already **succeeded**
returns its recorded result instead of mutating the repository twice. Only successes are recorded — a
failed or blocked action did not apply, so re-running it is the caller's intended retry, not a
double-apply. A non-zero git exit at execution time is classified `precondition-failed` (a
time-of-check/time-of-use gap against the live repository), which routes to `recovery-required`; a
partially-applied multi-step plan reports `partial` with attempted/succeeded unit counts.

### D6 — Boundary preservation

The read-only terminal baseline is untouched. `isTerminalCommandAllowed` still denies every mutating
`git` subcommand; the governed write surface adds a separate, narrower, typed path rather than
widening that allowlist (Force 2). Execution flows through the existing keiko-tools spawn boundary, so
env isolation, redaction, output capping, and cancellation apply to governed mutations exactly as to
every other tool (Force 4). No new architecture boundary, quality gate, or security control is
weakened.

## Consequences

### Positive

- One execution authority with a uniform, machine-readable lifecycle and outcome model that later
  slices (approval, evidence, recovery) consume without string parsing.
- Local Git write authority is structurally narrow: a closed command table, a dedicated allowlist,
  and a port with no generic exec method, all machine-checked against the read-only baseline.
- Deterministic preflight makes reruns idempotent and lets callers separate user-actionable fixes
  from internal faults.
- The orchestrator is pure over injected dependencies, so the AC5 scenarios (success, policy block,
  preflight block, adapter failure, recovery-required) are unit-testable with fakes, complemented by
  a hermetic real-git integration test of the Node adapter.

### Negative

- The orchestrator executes only the local mutation kinds in #472; remote/provider execution requires
  later slices to register additional executors. This is an intentional scope boundary, but it means
  the kernel is not yet a complete delivery path on its own.
- A non-zero git exit is classified coarsely as `precondition-failed` because the kernel deliberately
  does not parse stderr. Finer-grained execution diagnostics are deferred to the evidence ledger
  (#474), which can attach redacted detail without the kernel re-deriving severity from text.

### Neutral

- The Node adapter runs with inherited network (local mutations never egress), so it needs no
  isolation backend; a caller may tighten the sandbox policy.
- The adapter supplies an empty HOME through the spawn boundary, so commit identity comes from the
  repository's local config; richer commit-intent composition (author/identity) is #475.

## Alternatives Considered

### Alternative 1: A single `runGit(args)` adapter method

Rejected. A generic argv method is exactly the "run this git command" escape hatch Force 2 forbids; a
widened terminal allowlist or a generic exec method would reopen unrestricted command execution. The
typed-method-per-kind port with a closed command table is the structural guarantee.

### Alternative 2: Preflight that reads git directly

Rejected. Embedding git reads in preflight would make it non-deterministic and untestable without a
repository, and would duplicate the spawn boundary. A pure function over an injected snapshot keeps
preflight deterministic and idempotent; the snapshot is produced by a read-only inspection port.

### Alternative 3: Free-form error strings for failures

Rejected. AC4 requires categories consumable without string parsing. A typed category union plus a
total error-code → category table makes classification deterministic and forces explicit handling of
every contract error code at compile time.

### Alternative 4: Execute every contract kind now (including push/PR/merge)

Rejected as out of scope. The epic sequences publish (#476), PR (#477), and merge (#478) after #472,
and they require credentials, remotes, and provider APIs that are explicit non-goals here. Modeling
the orchestrator command union as local-only keeps #472 focused while leaving a clean extension seam.

## Related

- ADR-0070: Governed Git delivery contracts (the contract surface this kernel consumes)
- ADR-0019: Modular Package Architecture (keiko-tools as the single spawn boundary; leaf rules)
- ADR-0018: Terminal allowlist (read-only Git baseline being preserved)
- ADR-0043: Enforced Execution Isolation (the spawn-boundary enforcement model reused here)
- Issue #472: Implement deterministic preflight evaluation and mutation orchestration (this ADR)
- Issue #470: Epic — governed end-to-end Git delivery
- Issues #473–#479: Later children that build on this kernel

## Date

2026-06-25
