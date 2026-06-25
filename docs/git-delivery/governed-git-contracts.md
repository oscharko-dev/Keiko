# Governed Git Delivery Contracts

This document describes the governed Git delivery contract surface introduced in Issue #471
(Epic #470) and defined by [ADR-0058](../adr/ADR-0058-governed-git-delivery-contracts.md). It is
written for operators who author policy packs and for engineers who build the later delivery slices
(#472 and beyond) on top of these contracts.

## 1. Overview

Governed Git delivery is a typed contract layer that describes Git mutations — branch creation,
staging, commits, pushes, pull requests, merges, aborts, and recovery — as structured data that
flows through an explicit lifecycle: preview, policy evaluation, approval, execution, evidence.

It is **not** a command runner. The contracts carry no shell strings, no diff content, no file
paths, and no secrets. They describe _what a governed action is_ and _whether policy permits it_;
the actual execution engine, provider adapters, credential handling, and UI are delivered by later
issues. The read-only terminal inspection baseline (`isTerminalCommandAllowed`) is unchanged: it
still denies every mutating `git` subcommand. Governed write authority lives only behind these typed
contracts, never behind a widened terminal allowlist (see Section 6).

The surface lives in three leaf modules in `packages/keiko-contracts/src/`:

- `git-delivery.ts` — the core atom: action kinds, risk taxonomy, the lifecycle envelope, the typed
  constraint union, the policy decision, the provider-capability enum, the branch matchers, and the
  shared parse-result type.
- `git-delivery-policy.ts` — policy packs and the deterministic pure evaluator.
- `git-delivery-provider.ts` — provider-neutral interfaces for branch protection, checks, pull
  requests, and merge readiness.

All three are pure: no IO, no clock, no randomness, no crypto. The policy evaluator is a pure
function — the same inputs always yield the same decision.

## 2. Action model

There are ten action kinds (`GIT_DELIVERY_ACTION_KINDS`). Each carries only the typed inputs that
kind requires; no kind leaks another kind's fields.

| Kind            | What it represents                        | Notable inputs                                                        |
| --------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| `branch-create` | Create a branch from a start point        | `branchName`, `baseBranchName`, `startPointRefHash`                   |
| `stage`         | Stage changes for commit                  | `pathCount`, `includesUntracked`                                      |
| `unstage`       | Remove changes from the index             | `pathCount`                                                           |
| `commit`        | Record a commit                           | `messageByteLength`, `stagedPathCount`, `allowEmptyCommit`            |
| `push`          | Publish a branch to a remote              | `remoteAlias`, `remoteBranchName`, `forcePush`, `setUpstreamTracking` |
| `pr-create`     | Open a pull request                       | `headBranchName`, `baseBranchName`, `isDraft`                         |
| `pr-update`     | Update a pull request                     | `prExternalId`, `convertToDraft`, `convertFromDraft`                  |
| `merge`         | Merge a pull request                      | `prExternalId`, `mergeStrategyHint`, `deleteBranchAfterMerge`         |
| `abort`         | Abort an in-progress operation            | `operationToAbort`, `preserveIndexChanges`                            |
| `recovery`      | Reset / restore / stash-and-reset history | `recoveryStrategyHint`, `targetRefHash`, `affectedPathCount`          |

Inputs that would otherwise carry content (commit messages, PR bodies, file paths) are reduced to
counts and byte lengths. This keeps the contract layer content-free while preserving enough signal
for policy and preview.

### Lifecycle envelope

`GitDeliveryActionEnvelope` composes the six elements an action carries through its lifecycle:
`resolvedInputs`, `policyDecision`, `approvalRequirement`, optional `preview`, optional
`executionResult`, and optional `evidenceRef`. It is a sound discriminated union: each member pairs a
single per-kind input type with a matching `kind`, so `kind === resolvedInputs.kind` holds by
construction. `parseGitDeliveryActionEnvelope` re-checks that invariant at runtime and rejects any
envelope whose discriminant disagrees with its inputs.

The execution result carries a closed `errorCode` (`provider-rejected`, `network-failure`,
`conflict`, `precondition-failed`, `timeout`, `internal-error`) — never a free string — and an
optional `partialDetail` (attempted/succeeded unit counts) for the `partial` outcome. The evidence
reference names align with `evidence.ts` (`sourceGroundedRunId`, `evidenceManifestStableIdHash`).

## 3. Risk taxonomy

There are four risk classes (`GIT_DELIVERY_RISK_CLASSES`), each with an explicit ordinal severity in
the frozen `GIT_DELIVERY_RISK_CLASS_SEVERITY` table:

| Class                 | Ordinal | Default coverage                             |
| --------------------- | ------- | -------------------------------------------- |
| `local-mutation`      | 1       | branch-create, stage, unstage, commit, abort |
| `publish`             | 2       | push                                         |
| `protected-or-merge`  | 3       | pr-create, pr-update, merge                  |
| `recovery-or-rewrite` | 4       | recovery                                     |

**Severity is data, never name-inference.** Compare risk by reading the ordinal from the table; no
code infers severity from an action-kind string or from shell arguments.

- `gitDeliveryDefaultRiskClass(kind)` returns the default class, failing closed to
  `recovery-or-rewrite` (the highest) for any unknown kind.
- `gitDeliveryRiskClassForInputs(inputs)` returns the default class except that a `push` with
  `forcePush: true` escalates to `recovery-or-rewrite`, so a force-push is never under-classified.
- `gitDeliveryRiskClassWithinCeiling(actionKind, ceiling)` returns true when the action's default
  severity is at or below the ceiling's severity.

## 4. Policy packs

Policy is authored as two packs — an org pack and a repo pack — each a list of rules plus an optional
`defaultRule`. A rule binds an `actionKind` to a `decision`:

- `allowed` — the action may proceed.
- `blocked` — the action is denied.
- `approval-gated` — the action is held until approval is recorded; `requiredApprovers` lists opaque
  approver ids (an empty list means "at least one approver of any identity").
- `constrained` — the action may proceed only after the listed typed constraints are satisfied.

Typed constraints (`GitDeliveryConstraint`) have no free-form strings:

- `branch-pattern` — the target branch must match at least one structured pattern. A pattern is
  `{ matchKind: "exact" | "prefix", value }`. Glob is intentionally excluded to keep the leaf
  parse-free; use `gitDeliveryBranchNameMatchesAny` to evaluate.
- `provider-capability` — the active provider must advertise the named capability.
- `risk-class-ceiling` — actions whose default severity exceeds `maxRiskClass` are out of bounds.

**Deny-by-default as data.** Set `defaultRule: { decision: "blocked" }` on a pack so that any action
kind without a specific rule is denied at that level.

### Precedence

`evaluateGitPolicy(orgPack, repoPack, context)` resolves each level to one of
`allowed / blocked / approval-gated / constrained / none` (matching rule first, then `defaultRule`,
then `none`), and combines them by this total matrix (first match wins; O = org, R = repo):

1. `O == blocked` or `R == blocked` → **blocked** (`policy-pack-blocked`).
2. `O == approval-gated` → **approval-gated** with org approvers.
3. `R == approval-gated` → **approval-gated** with repo approvers.
4. `O == constrained` or `R == constrained` → **constrained** (org constraints first, then repo).
5. `O == allowed` or `R == allowed` → **allowed**.
6. else (both `none`) → **blocked** (`no-applicable-rule`) — fail-closed.

Either level can tighten; org tightening dominates a repo loosen; empty packs fail closed. The
fail-closed `no-applicable-rule` is distinct from an explicit `approval-gated` rule with empty
approvers.

### Worked examples

**Allowed.** Org allows `push`; repo has no `push` rule → `{ outcome: "allowed" }`.

**Blocked (org wins over a repo loosen).** Org blocks `recovery`; repo allows `recovery` →
`{ outcome: "blocked", reason: "policy-pack-blocked" }`.

**Approval-gated.** Org gates `push` with `requiredApprovers: ["org-lead"]`; repo allows `push` →
`{ outcome: "approval-gated", requiredApprovers: ["org-lead"] }`.

**Constrained (union).** Org constrains `push` with a `provider-capability` constraint; repo
constrains `push` with a `risk-class-ceiling` constraint → `{ outcome: "constrained", constraints:
[<org>, <repo>] }`.

**Deny-by-default.** Org `defaultRule: { decision: "blocked" }` and no `merge` rule → any `merge`
context resolves to blocked.

Packs are validated with `parseGitRepoPolicyPack` / `parseGitOrgPolicyPack` /
`parseGitPolicyPack`, all returning the shared `GitDeliveryParseResult<T>`.

## 5. Provider neutrality

`git-delivery-provider.ts` describes provider state in neutral terms only:
`GitDeliveryBranchProtection`, `GitDeliveryChecksState`, `GitDeliveryPullRequestState` (with the
orthogonal `isDraft` boolean separate from the `open | closed | merged` status),
`GitDeliveryMergeReadiness`, `GitDeliveryRemoteTargetPolicy`, and `GitDeliveryProviderDescriptor`.

**The rule:** no field name, value, or type from a specific provider's API may appear in these
interfaces. Provider adapters live in keiko-workflows or keiko-server — not in keiko-contracts, which
as a leaf package cannot import a provider SDK. The GitHub adapter is the reference implementation;
ADR-0058 §D6 carries the GitHub-to-neutral mapping table. Adding a second provider (GitLab, Gitea)
means writing another adapter that maps to the same neutral interfaces — no core contract changes.

## 6. Terminal boundary guarantee

The human-facing terminal allowlist (`isTerminalCommandAllowed`, keiko-tools) still permits only
read-only `git` inspection (`status`, `diff`, `log`, `show`, `rev-parse`, `ls-files`, `describe`,
`blame`, `cat-file`, and read-only `branch` / `remote` listings) and denies every mutating
subcommand. Governed write authority is reachable only through the typed contracts above, never by
widening that allowlist.

This is machine-checked. The `AC5 — governed Git delivery boundary (ADR-0058)` block in
`packages/keiko-tools/src/terminal-policy.test.ts` asserts that the real mutating and network
commands each governed action maps to — `commit`, `push`, `push --force`, `merge`, `merge --abort`,
`branch <name>`, `add .` / `add -A`, `restore --staged` / `reset HEAD`, `reset --hard` / `restore`,
`rebase`, `cherry-pick`, `revert`, `stash`, `clean`, `tag`, `switch -c`, `checkout -b`, `fetch`,
`pull` — all stay denied, while `git status` and `git log` stay allowed (a selective boundary, not
deny-everything). It also asserts that `GIT_DELIVERY_ACTION_KINDS` shares no member with any terminal
allowed subcommand, so the governed surface and the terminal allowlist are structurally disjoint.

## 7. Extension model

Later issues (#472 and beyond) add capabilities by extending these typed contracts, not by smuggling
shell semantics:

- A new action kind adds a member to `GIT_DELIVERY_ACTION_KINDS`, a per-kind inputs interface, a
  risk default, an envelope union member, and a resolved-input guard.
- A new constraint adds a member to `GitDeliveryConstraint` with its own guard (and matcher, if it
  needs one) — never an embedded mini-language.
- A new provider capability adds a member to `GIT_DELIVERY_PROVIDER_CAPABILITIES`.
- A new provider adds an adapter that maps to the existing neutral interfaces.

Policy packs are assembled from storage by keiko-server or keiko-workflows before
`evaluateGitPolicy` is called; the leaf evaluator does no IO. This separation is what keeps the
contract layer pure and the boundary auditable.
