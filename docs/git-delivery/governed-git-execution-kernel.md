# Governed Git Mutation Execution Kernel

This document describes the governed Git mutation execution kernel introduced in Issue #472
(Epic #470) and defined by
[ADR-0081](../adr/ADR-0081-governed-git-mutation-execution-kernel.md). It is written for engineers
building the later delivery slices (#473 and beyond) on top of the kernel, and for reviewers
verifying that local Git write authority stays narrow and governed.

## 1. Overview

The kernel is the single execution authority for governed **local** Git writes. It consumes the
typed contracts from Issue #471 (ADR-0080) and drives every supported mutation through one repeatable
lifecycle:

```
resolve → preflight → preview → policy → execute → result
```

It is deterministic given its injected dependencies and performs no IO of its own — Git execution
lives behind a narrow adapter, so the orchestrator never opens a parallel `child_process` path. The
read-only terminal inspection baseline (`isTerminalCommandAllowed`) is unchanged: it still denies
every mutating `git` subcommand. Governed write authority lives only behind the typed adapter, never
behind a widened terminal allowlist.

The kernel lives in five modules in `packages/keiko-tools/src/`:

- `git-mutation-taxonomy.ts` — lifecycle phases, failure categories, status union, and total
  error-code → category mappings.
- `git-mutation-preflight.ts` — a content-free repository snapshot and pure per-kind evaluators.
- `git-mutation-adapter.ts` — the narrow adapter port, the closed command table, the dedicated
  allowlist, and the pure argv builders.
- `git-mutation-orchestrator.ts` — the `runGitMutation` lifecycle driver.
- `git-mutation-node.ts` — the Node execution adapter (on the `./internal/git-mutation` subpath).

The pure surface is re-exported from `@oscharko-dev/keiko-tools`; the Node adapter is imported from
`@oscharko-dev/keiko-tools/internal/git-mutation`.

## 2. Lifecycle and outcomes

`runGitMutation(request, deps)` returns a `GitMutationLifecycleResult`:

- `envelope` — the contract `GitDeliveryActionEnvelope`, populated through the policy phase
  (descriptive-complete) and carrying the execution result once execution runs.
- `outcome` — a `GitMutationOutcome` discriminated union (see Section 5).
- `phaseReached` — where enforcement halted (`preflight`, `policy`), or `result` when complete.
- `preflight` — the full preflight report (blocking and advisory findings).

Two enforcement gates decide whether execution proceeds:

1. **Preflight gate** — a blocking finding halts before policy and execution.
2. **Policy gate** — policy must permit, and any required approval must be valid and unexpired.

The orchestrator's command union covers the **local** mutation kinds: `branch-create`, `stage`,
`unstage`, `commit`, `abort`, `recovery`. Remote and provider kinds (`push`, `pr-create`,
`pr-update`, `merge`) are part of the shared contract and are classified by preflight and policy, but
their orchestrated execution is delivered by later slices that register additional executors.

## 3. Preflight

Preflight is a pure function of `(resolvedInputs, GitWorktreeSnapshot)`. The snapshot is content-free
— counts, flags, and branch/remote names only:

| Field                                                          | Meaning                                        |
| -------------------------------------------------------------- | ---------------------------------------------- |
| `headDetached` / `currentBranchName`                           | branch context (name absent when detached)     |
| `stagedFileCount` / `unstagedFileCount` / `untrackedFileCount` | worktree state                                 |
| `hasUpstream` / `aheadCount` / `behindCount`                   | upstream readiness                             |
| `existingLocalBranchNames`                                     | branch existence checks                        |
| `remoteAliases` / `remoteReachable`                            | remote alias + reachability                    |
| `operationInProgress`                                          | merge/rebase/cherry-pick/revert/bisect, if any |

Each finding carries:

- `code` — a closed, specific code (e.g. `branch-already-exists`, `no-upstream-configured`,
  `nothing-staged-to-commit`, `remote-unreachable`).
- `severity` — `blocking` (halts) or `advisory` (informs).
- `remediation` — `user-actionable` (the operator can fix it) or `internal` (a kernel/caller fault).

Because the evaluator is pure, reruns are byte-identical: preflight reruns are idempotent by
construction.

## 4. The narrow adapter (no generic fallback)

`GitLocalMutationAdapter` has one typed method per local kind and **no** method that accepts an
arbitrary argument vector:

```
createBranch · stage · unstage · commit · abort · recover
```

Each method builds a fixed argv plan from the pure builders. Operands are validated — refs and branch
names may not be empty, contain a NUL, or begin with `-` (a flag-injection guard); commit messages
may not be empty or NUL-bearing; file pathspecs are placed after a `--` sentinel so a path can never
be reinterpreted as an option. The governed subcommands are exactly:

```
branch · add · restore · commit · reset · stash · merge · rebase · cherry-pick · revert · bisect
```

The Node adapter runs plans through the keiko-tools no-shell spawn boundary with a **dedicated**
`GIT_MUTATION_COMMAND_RULES` allowlist that permits only those subcommands and denies global config /
cwd-shifting / code-execution flags. This rule set is separate from both the read-only terminal policy
and the harness default. The two surfaces are complementary and machine-checked: every argv the
adapter can produce is denied by `isTerminalCommandAllowed`. No network subcommand (`push`, `fetch`,
`clone`) is in the governed set.

## 5. Failure taxonomy

The kernel categorizes every non-success state as DATA, never inferred from a message:

| Category            | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `policy-block`      | an org/repo policy pack denied or did not permit the action    |
| `preflight-block`   | a deterministic preflight evaluator found a blocking condition |
| `execution-failure` | the adapter ran but failed transiently or internally           |
| `provider-failure`  | a remote/provider rejected the action or was unreachable       |
| `recovery-required` | the repository needs a guided recovery path before a retry     |

The `GitMutationOutcome` union binds a status (`succeeded` / `approval-required` / `blocked` /
`failed` / `recovery-required`) to its category and payload. The contract's closed execution-error
codes map to categories through a total table:

- `provider-rejected`, `network-failure` → `provider-failure`
- `conflict`, `precondition-failed` → `recovery-required`
- `timeout`, `internal-error` → `execution-failure`

A new error code would fail the build rather than fall through to an untyped default. Consumers branch
on category — they never parse a message.

## 6. Idempotency and retry

Preflight, preview, and policy are pure and always safe to rerun. Execution is guarded by an optional
`GitMutationJournal` keyed by an `idempotencyKey`: a re-submitted request that already **succeeded**
returns its recorded result instead of mutating twice. Only successes are journaled — a failed or
blocked action did not apply, so re-running it is the caller's intended retry.

A non-zero git exit at execution time is classified `precondition-failed` (a
time-of-check/time-of-use gap against the live repository), which routes to `recovery-required`. A
partially-applied multi-step plan (for example, `stash-and-reset` where the stash succeeds but the
reset fails) reports `partial` with attempted/succeeded unit counts.

## 7. What this kernel does not do

- It does not execute remote or provider actions (push, PR, merge); those are #476–#478 behind a
  separate gateway.
- It does not provide an approval UI (#473), an evidence ledger or audit export (#474), or
  productized commit-intent composition (#475).
- It does not parse git stderr; finer execution diagnostics are attached by the evidence ledger.
- It does not widen the read-only terminal baseline.
