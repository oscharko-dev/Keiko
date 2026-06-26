# Governed Local Git Flows and Commit-Intent Composition

This document describes the first end-user-visible governed **local** Git write flows introduced in
Issue #475 (Epic #470) and defined by
[ADR-0074](../adr/ADR-0074-governed-local-git-flows-and-commit-intent.md). It is written for engineers
extending the delivery surface and for reviewers verifying that local branch and commit creation
stay governed, content-free, and impossible to perform outside the kernel.

It builds on the contract surface from Issue #471
([ADR-0070](../adr/ADR-0070-governed-git-delivery-contracts.md)), the execution and preflight kernel
from Issue #472 ([ADR-0071](../adr/ADR-0071-governed-git-mutation-execution-kernel.md), see
[governed-git-execution-kernel.md](governed-git-execution-kernel.md)), the approval and preview
surface from Issue #473 ([governed-git-approval-surface.md](governed-git-approval-surface.md)), and the
evidence ledger from Issue #474 ([governed-git-evidence-ledger.md](governed-git-evidence-ledger.md)).

## 1. Overview

Issue #475 turns the abstract mutation platform into a practical daily capability: a user can create or
switch a branch, assemble staged changes, preview a commit with its quality signals, and create the
commit — all through the governed workflow, without leaving Keiko for routine local repository
preparation.

The slice adds no second execution authority. Every local mutation runs through the existing #472
kernel `runGitMutation` (resolve → preflight → preview → policy → approval → execute) over a snapshot
the **server** reads from the live worktree, and every mutation appends a content-free record to the
#474 evidence ledger. The only net-new governance is the **commit-message policy** (a deterministic
contract validator) and the **commit-intent quality analysis** (deterministic warnings) — both pure,
both content-free, neither a Model Gateway call.

## 2. Layers

- **keiko-contracts** (strict leaf, pure, content-free):
  - `git-commit-policy.ts` — `validateGitCommitMessage(message, policy)` returns a closed
    `GitCommitMessageViolationCode` union (`empty-subject`, `missing-conventional-prefix`,
    `disallowed-type`, `subject-too-long`, `missing-issue-key`, `missing-signoff`). Content in, codes
    out; the message is never retained. `KEIKO_DEFAULT_COMMIT_MESSAGE_POLICY` encodes this repository's
    own Conventional Commit style.
  - `git-commit-intent.ts` — `analyzeGitCommitIntent({ summary, message? })` returns deterministic
    `GitCommitQualityWarningCode` warnings (`mixed-scope`, `wip-marker`, `large-change`, `empty-body`,
    `non-conventional-subject`) plus a suggested `type(scope):` subject scaffold.
  - `git-delivery.ts` — `branch-switch` is the 11th governed action kind (`local-mutation` risk class),
    compile-enforced across every exhaustive per-kind table.
- **keiko-tools**:
  - `git-worktree-snapshot-node.ts` (on the `./internal/git-mutation` subpath) — `readGitWorktreeSnapshot`
    builds a trustworthy content-free snapshot from read-only `git status / branch / remote` through the
    no-shell spawn boundary, using its OWN inspection allowlist (structurally separate from the mutation
    allowlist). `readStagedPaths` lists staged paths for scope inference.
  - `git-commit-intent-node.ts` — `summarizeStagedChangeset(paths)` reduces staged paths to the
    content-free `GitCommitChangeSummary` the analyzer consumes.
  - the kernel gains a `switchBranch` adapter method (`git switch <branch>`) and a `switch-target-missing`
    preflight finding.
- **keiko-server** (BFF, capability- and CSRF-gated, content-free, fail-closed):
  - `POST /api/git-delivery/local-branch/create`, `/local-branch/switch`, `/staging/stage`,
    `/staging/unstage` — execute a governed local mutation.
  - `POST /api/git-delivery/commit/preview` — READ-ONLY pre-commit verification context (staged scope,
    intent warnings, message-policy validation of the draft, preflight findings, policy decision).
  - `POST /api/git-delivery/commit/execute` — enforces the message policy FIRST (the kernel only sees a
    byte length), then drives the kernel and appends evidence.
- **keiko-ui** — the `governedGit` desktop window (`GovernedGitFlowCard`) walking branch → staging →
  commit composer with live preview, surfacing warnings and blocks as text + icon (never colour alone).

## 3. Trust and execution model

- **Capability gate.** Every route returns `404` unless `KEIKO_GIT_DELIVERY_ENABLED=true` (default
  false). This is the single, explicit opt-in for the whole governed-git surface.
- **Project authorization.** The request carries a `projectId` (the workspace root path). The server
  resolves it through the UI project store; an unregistered path is rejected. Git runs only inside a
  known project's worktree.
- **Trusted snapshot.** The snapshot is read server-side from the live worktree, so a client cannot
  assert, for example, a staged-file count that would slip a commit past preflight.
- **Default local policy.** When governed git delivery is enabled and no stricter pack is configured,
  `KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK` permits the lowest risk class (`local-mutation`) and fail-closes
  for everything else. Policy is still EVALUATED for every action; operators can supply stricter packs.
- **Message policy gate (AC2).** A policy-violating commit message is blocked with typed violation codes
  BEFORE the kernel runs — the kernel never receives a non-compliant message.
- **No bypass (AC5).** The only path to a commit is the execute route, which always runs the message
  policy then the kernel (preflight + policy + approval). A policy or preflight block executes nothing.
  This is proven by the server route tests and the browser evidence spec.
- **Evidence (AC4).** Successful, blocked, and failed kernel mutations append a content-free record to
  the date-bucketed ledger; recording is best-effort and never blocks the response.

## 4. Content-free invariant

Requests and responses carry counts, structural top-level path tokens, branch names, and typed
warning/violation/finding/outcome codes only — never a commit-message body, diff, raw file path, or
secret. Validators take content as a function argument and return only codes; nothing is persisted.

## 5. Named limitations

- **Remote verification linking.** The commit preview surfaces LOCAL verification context (preflight,
  policy, message validation, intent warnings). Linking to remote test/check runs is out of scope for
  local commits and is deferred to the publish/PR slices (#476/#477).
- **Message-policy rejection auditing.** A message-policy block is reported to the user with typed codes
  but does not append a kernel evidence record (no mutation was attempted); the ledger records kernel-
  governed mutations.
- **In-progress operations.** The snapshot reader does not probe merge/rebase/cherry-pick/bisect state;
  that affects only advisory preflight findings for the local flow.
- **Pathspecs.** Staging pathspecs are validated to be repo-relative and traversal-free; pathspecs
  containing spaces are conservatively rejected by the initial governed flow.
- **Suggestions.** Commit title/body suggestions are deterministic heuristics derived from the staged
  scope, not Model Gateway calls.
