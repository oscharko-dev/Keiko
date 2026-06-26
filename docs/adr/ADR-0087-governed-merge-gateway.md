# ADR-0087: Governed Merge Gateway, Protected-Branch Enforcement, and Guided Recovery

## Status

Accepted

## Context

Epic #470 has built the governed Git delivery stack through seven prior slices:

- ADR-0080 (#471): typed contract surface — action kinds, risk taxonomy, lifecycle envelope, policy evaluator. The `merge` action kind, `GitDeliveryMergeInputs`, `GitDeliveryMergeStrategyHint`, and the `GitDeliveryMergeBlockReason` taxonomy were defined here but never wired into an execution authority.
- ADR-0081 (#472): mutation kernel — single local execution authority, preflight evaluators (`merge` already maps to `preflightNoLocalPrecondition`), narrow local adapter port.
- ADR-0082 (#473): approval and preview presentation layer — content-free action sheet, BFF projection route.
- ADR-0083 (#474): evidence ledger — bounded append-only record for every terminal outcome, audit-export route. Its `buildGitDeliveryEvidenceRecord` is generic over the action kind (the `merge` envelope flows through unchanged).
- ADR-0084 (#475): first end-user-visible local flows — branch / staging / commit with interactive preview and commit-intent composition.
- ADR-0085 (#476): governed publish gateway — dedicated remote push authority with its own allowlist, rejection taxonomy, and policy pack.
- ADR-0086 (#477): governed pull request gateway — dedicated `gh api` PR-orchestration authority (create / update / draft-toggle), readiness model, rejection taxonomy. Explicitly deferred merge execution to this slice.

Issue #478 adds the **governed merge layer**: the highest-risk delivery action. It turns a review-ready pull request into a merged change through an explicit, governed workflow that reasons about merge readiness (required checks, approvals, branch protection, conflicts, merge-queue position), enforces policy and final approval *before* the merge call, supports only repo-and-provider-compatible merge strategies, surfaces precise structured blockers and recovery advice for blocked or failed merges, and records content-free evidence for every terminal outcome. Merge is treated as a governed release decision, never a convenience click.

Seven forces constrain the design:

**Force 1 — Separate merge authority, not a PR-gateway or publish-gateway extension.** The ADR-0086 PR gateway shells `gh api` against the PR create / update / draft-toggle endpoints; its allowlist explicitly excludes merge and delete. The ADR-0085 publish gateway shells `git push`. A merge operation shells a different `gh api` REST call (`PUT /repos/{owner}/{repo}/pulls/{number}/merge`) with a different failure taxonomy (405 not-mergeable, 409 head-modified, 422 required-status-checks). Merging this into either gateway would erode their narrow-port and one-purpose-allowlist invariants. The merge gateway is a third parallel execution authority with its own narrow port, its own dedicated allowlist, and its own GitHub-error classifier.

**Force 2 — Readiness must be evaluated and visible before execution, not discovered by attempting the merge.** AC1 requires that merge cannot execute until required policy, approval, and readiness conditions are satisfied *and visible to the user*. The authoritative source of readiness (which checks are required, which are passing, how many approvals are present, whether the base advanced, whether a merge queue is active) is the provider, not the local worktree. The gateway therefore reads a content-free merge-readiness snapshot from the provider *before* the merge call, derives a structured blocker list the user can see, and refuses to call the merge endpoint when a blocking blocker is present — in addition to the provider's own server-side enforcement, which remains the ultimate authority.

**Force 3 — Allowed merge strategy is data, not a UI default.** AC2 requires the permitted merge strategy to be derived from repo policy and provider capability, never an implicit UI default. The contract layer derives the eligible strategy set as the intersection of the strategies the deployment policy permits and the strategies the provider repository allows, and a requested strategy outside that set is a structured block (`strategy-unavailable`), never a silent substitution.

**Force 4 — Provider neutrality at the contract layer.** The ADR-0080 rule — no provider field names or values in keiko-contracts — must hold. GitHub's `mergeable_state` enumeration (`clean`, `blocked`, `dirty`, `behind`, `unstable`, `draft`, `unknown`), its `merge_method` values, and its HTTP error envelope must not appear in the contracts leaf. The neutral merge-readiness model and rejection taxonomy live in contracts; the GitHub-specific `mergeable_state` mapper and error classifier live in keiko-tools.

**Force 5 — Content-free invariant and evidence reuse.** A merge carries no user-authored free content (no title/body): its content-free inputs are the opaque PR external id, the typed strategy enum, and the delete-branch flag (`GitDeliveryMergeInputs`, already defined in ADR-0080). The gateway produces a kernel-shaped `GitMutationLifecycleResult` so the #474 evidence builder records the merge with no schema change. No new evidence field is required.

**Force 6 — Final approval semantics belong to merge.** ADR-0086 deliberately kept the default PR policy pack `constrained` (not `approval-gated`), noting that the approval gate for *merging* is this slice. The default merge policy pack therefore makes `merge` `approval-gated`: a merge cannot proceed without a satisfied, unexpired approval token. This is the explicit high-risk confirmation AC1 requires; the gateway fully supports the `approval-gated` → `approval-required` path the kernel already implements.

**Force 7 — Guided recovery for blocked and failed merges.** AC3 requires precise blocker and recovery information. Every neutral blocker code and every neutral rejection reason maps (via exhaustive tables reusing the #473/#474 recovery vocabulary) to a recovery disposition (`retryable` / `user-fixable` / `policy-forbidden` / `none`) and, where one fits cleanly, a recovery action hint. Branch deletion after a successful merge is honoured as a guarded, non-fatal best-effort follow-up: a failed deletion never fails the merge, and a protected head branch is never deleted absent the `protected-branch-delete` provider capability.

### Scope boundary (Issue #478)

In scope: a new contracts leaf `git-merge.ts` (merge-readiness model + neutral blocker taxonomy reusing `GitDeliveryMergeBlockReason`, strategy-eligibility derivation, merge recommendation, rejection taxonomy + exhaustive disposition/error-code tables, pure derivations and guards); a dedicated merge gateway in keiko-tools (pure orchestrator + narrow two-method `GitMergeAdapter` port + merge-only `gh api` allowlist + argv builders + GitHub merge-error classifier + `mergeable_state` mapper); a Node merge executor that shells `gh api` to read readiness and execute the merge, with a guarded non-fatal branch-deletion follow-up; server merge preview/execute routes reusing the gateway, the ledger, and a default-safe `approval-gated` merge policy pack; a new sibling UI card `GovernedMergeCard.tsx`.

Out of scope: autonomous or background auto-merge scheduling; merge-queue *submission* (queue *position* is read and surfaced as a blocker, but the gateway does not enqueue); general history-rewrite tooling; non-GitHub provider rollout (provider-neutral seams preserved, not implemented for a second provider); merge-conflict *resolution* tooling (conflicts are surfaced as a blocker with recovery advice, not resolved).

### Cross-branch ADR numbering

The governed-git feat branch uses ADR numbers 0058–0065. An independent voice-digital-twin / editor feat branch independently reused some of these numbers. These are non-conflicting while the branches are un-merged to `dev`; numbers are per-branch-local until a feat-to-dev PR is opened. The merge coordinator must verify global ADR sequencing on `dev` before merging.

## Decision

We will introduce a new contracts leaf, a dedicated merge gateway and Node executor in keiko-tools, two new server routes reusing the kernel machinery and the ledger, a default-safe `approval-gated` merge policy pack, and a new sibling UI card. keiko-contracts existing modules are **not** modified — the `merge` action kind, `GitDeliveryMergeInputs`, `GitDeliveryMergeStrategyHint`, `GitDeliveryMergeBlockReason`, the provider-state interfaces (`GitDeliveryPullRequestState`, `GitDeliveryChecksState`, `GitDeliveryMergeReadiness`, `GitDeliveryBranchProtection`), the execution error codes, and the recovery vocabulary they define are sufficient.

### D1 — The merge gateway is a third parallel execution authority in keiko-tools

`packages/keiko-tools/src/git-merge-gateway.ts` (pure) defines:

- `GitMergeCommand` — `{ kind: "merge", ownerAndRepo, prExternalId, baseBranchName, headBranchName, mergeStrategy: GitDeliveryMergeStrategyHint, deleteBranchAfterMerge, expectedHeadRefHash? }`. The branch names are structured operands the content-free `GitDeliveryMergeInputs` deliberately omits; they are needed for policy targeting (base) and the optional branch deletion (head). The optional `expectedHeadRefHash` is forwarded as the GitHub merge `sha` guard so the merge fails closed if the head advanced after readiness was read.
- `GitMergeAdapter` — the narrow provider port with exactly two typed methods: `readMergeReadiness(req)` (a read of the provider's neutral merge-readiness facts) and `mergePullRequest(req)` (the merge execution). No generic `run(args)` escape hatch and no delete method on the port surface beyond what `mergePullRequest` performs internally as a guarded follow-up.
- `GIT_MERGE_ALLOWED_SUBCOMMANDS = ["api"]` + `GIT_MERGE_COMMAND_RULES` — a dedicated `gh api` allowlist (deny `--input` / `--paginate`), structurally separate from the mutation, publish, and PR allowlists.
- `buildMergeArgv(req)` — pure argv builder for `gh api --method PUT /repos/{owner}/{repo}/pulls/{number}/merge` with `merge_method` derived from the strategy (`squash`→`squash`, `rebase`→`rebase`, `merge-commit`→`merge`, `provider-default`→ omitted) and the optional `sha` guard. `buildMergeReadinessArgv(req)` reads the content-free PR merge facts; `buildDeleteMergedBranchArgv(req)` performs the guarded branch deletion. All builders validate operands (no NUL/control, no whitespace, no leading `-`, owner/repo and PR-number shapes).
- `classifyGitMergeRejection(output)` — an ordered phrase table over the redacted gh output mapping GitHub merge errors to a neutral `GitMergeRejectionReason`. Ordering is load-bearing (rate-limit before permission-denied; head-modified before not-mergeable).
- `evaluateGitMergeEffectivePolicy(decision, base, capabilities)` — preview-predicts-execute, mirroring the PR/publish gateways.
- `runGitMerge(request, deps)` — the merge lifecycle orchestrator. It reuses `evaluateGitPreflight` (`merge` → `preflightNoLocalPrecondition`, unchanged), `evaluateGitPolicy`, and the `GitMutationLifecycleResult` shape. After preflight and the policy/approval gate pass, it reads readiness through the adapter, evaluates the **readiness gate** (block when a blocking blocker is present), and only then calls `mergePullRequest`. It returns a `GitMergeLifecycleResult` wrapping the lifecycle result with the readiness summary and the live rejection descriptor.

The local kernel, the local adapter, the publish gateway, and the PR gateway are **unchanged**.

### D2 — Transport is `gh api` subprocess with a dedicated merge endpoint allowlist; token never handled by Keiko

`packages/keiko-tools/src/git-merge-node.ts` (Node executor) implements `GitMergeAdapter`. It shells `gh api` through the existing no-shell spawn boundary (`runCommand`, `exec.ts`) with `GIT_MERGE_COMMAND_RULES`. `readMergeReadiness` runs `gh api /repos/{o}/{r}/pulls/{n}` (and, when the PR is not cleanly mergeable, a second bounded read of the head commit's combined status) and maps the GitHub `mergeable_state` / `merged` / `draft` / review and check facts to the neutral `GitDeliveryPullRequestState` + `GitDeliveryChecksState`. `mergePullRequest` runs the merge PUT, classifies a non-OK status via `classifyGitMergeRejection`, and — only on merge success with `deleteBranchAfterMerge` — performs a guarded, non-fatal `DELETE` of the head ref. `gh` reads its own token from its keyring or `GH_TOKEN`/`GITHUB_TOKEN`; Keiko never reads the token. Raw stdout/stderr are secret-redacted and never leave the executor.

### D3 — Neutral merge-readiness model and blocker taxonomy in the contracts leaf

`packages/keiko-contracts/src/git-merge.ts` defines `GitMergeReadinessSummary` (`schemaVersion`, `mergeable: boolean`, severity-ranked `blockers: GitMergeReadinessBlocker[]`). The blocker code vocabulary **reuses** `GitDeliveryMergeBlockReason` (`checks-failing` / `approvals-missing` / `conflicts` / `branch-protection` / `merge-queue-position` / `provider-policy`) plus a `pr-not-open` / `pr-already-merged` / `draft-pr` set for lifecycle states, so the #471 seam is the canonical taxonomy. `gitMergeReadinessFor(input)` derives the summary purely from the provider-state facts (`GitDeliveryPullRequestState`, `GitDeliveryChecksState`, `GitDeliveryBranchProtection`) the server gathers and passes in — no IO, no network. Blocking blockers precede advisory blockers by construction.

### D4 — Strategy eligibility is the intersection of policy-permitted and provider-capable strategies

`GitMergeStrategyPolicy` (`allowedStrategies: GitDeliveryMergeStrategyHint[]`) expresses the deployment's permitted strategies; the provider repository advertises its capable strategies. `deriveEligibleMergeStrategies(requested, policy, providerCapable)` returns the eligible set (intersection), a deterministic default selection, and whether the requested strategy is eligible. A requested strategy outside the eligible set yields a `strategy-unavailable` block. The UI strategy selector is populated from the eligible set returned by the preview; it never defaults to a hard-coded strategy (AC2).

### D5 — Provider-failure normalization: neutral rejection enum in contracts, GitHub classifier in keiko-tools

`GitMergeRejectionReason` is a closed union: `not-mergeable | checks-failing | approvals-missing | conflict | head-modified | strategy-unavailable | branch-protection | already-merged | not-found | permission-denied | rate-limited | provider-unavailable | unknown`. Exhaustive `GIT_MERGE_REJECTION_ERROR_CODE` and `GIT_MERGE_REJECTION_DISPOSITION` tables map each reason to a `GitDeliveryExecutionErrorCode` and a `GitDeliveryRecoveryDisposition` (both reused). `classifyGitMergeRejection` (keiko-tools) matches GitHub's English error tokens against an ordered phrase table; the neutral enum and tables (contracts) change slowly and are test-driven in isolation.

### D6 — Default merge policy pack: merge is approval-gated; capability-gated behind KEIKO_GIT_DELIVERY_ENABLED

`KEIKO_DEFAULT_MERGE_POLICY_PACK` (server) authorises `merge` as `approval-gated` (`requiredApprovers: []` — at least one approver of any identity), with `defaultRule: { decision: "blocked" }` so every other action kind is fail-closed. This is the explicit final-approval gate AC1 requires. Base-branch namespace and risk-ceiling enforcement happen in the readiness layer (which is where merge prerequisites live); the policy pack governs *authorization* (may this action proceed, and does it need approval). Governed merge is evaluated only when `KEIKO_GIT_DELIVERY_ENABLED=true` (the existing `isGitDeliveryTrusted` gate); the default is false. A deployment may override with a stricter pack (e.g. naming specific `requiredApprovers`).

### D7 — A new sibling card GovernedMergeCard.tsx, not an extension of GovernedGitFlowCard or GovernedPullRequestCard

`GovernedMergeCard.tsx` is a new sibling card under a new `"governedMerge"` window kind. Rationale mirrors ADR-0086 D7: card scope/size (the merge surface — strategy selector, readiness/blocker panel, final high-risk approval affordance, rejection/recovery display — is independent of the PR metadata editor), lifecycle independence (merge is downstream of review-ready), and test separability. It is launched from the PR card's review-ready state. `globals.css` is **not** modified (ADR-0051 gate); all styling uses inline CSS custom properties.

### D8 — AC5 test strategy: fake-adapter unit/integration tests gate CI; Playwright e2e covers preview/blocked/disabled

Contract tests prove the pure readiness/strategy/rejection derivations. keiko-tools tests inject a deterministic fake `GitMergeAdapter` (no `gh`, no network) and prove: the readiness gate blocks a not-mergeable PR before `mergePullRequest` is called; the policy/approval gate blocks without a token; the argv builders map strategies correctly and reject malformed operands; the classifier's ordering invariant holds; and the gateway never calls anything but the narrow adapter (no-bypass). The Node executor test uses a scripted spawn to prove `mergeable_state` mapping and the guarded non-fatal branch delete. Server integration tests inject the seam and prove policy/approval/readiness blocking, content-free evidence append, and rejection→recovery projection. These run in the required `ci` job with no live GitHub credentials. A non-gating Playwright e2e (`playwright.issue-478-merge-governance.config.ts`) drives the packaged app for the read-only preview, the blocked-merge state, and the disabled (`KEIKO_GIT_DELIVERY_ENABLED` unset → 404) state.

## Consequences

### Positive

- Merge becomes a governed release decision: policy + final approval + readiness gate + provider enforcement + content-free evidence, with no second policy system, no new evidence schema, and no npm dependency.
- The neutral `GitDeliveryMergeBlockReason` seam left by #471 is finally wired into a readiness model and an execution authority.
- The content-free invariant holds by construction: merge inputs carry no free content; readiness facts are counts/enums; the classifier operates only on redacted output.
- The narrow two-method `GitMergeAdapter` port is the seam for a future non-gh transport without touching the orchestrator.

### Negative

- A third `gh api`-shelling executor adds subprocess surface. `gh` must be installed and authenticated; absence is classified at execution time (no pre-flight `gh` probe), consistent with ADR-0085/0086.
- Reading readiness before merge adds one (occasionally two) extra `gh api` reads per merge attempt. This is the cost of making readiness visible and gating on it (AC1) rather than discovering it from a failed merge.
- A new `"governedMerge"` window kind adds two registry entries (descriptor meta + renderer), the same overhead as the PR window.

### Neutral

- `GIT_MERGE_COMMAND_RULES` is structurally independent of the mutation, publish, and PR allowlists. Adding a merge sub-path touches only the merge rules.
- `KEIKO_DEFAULT_MERGE_POLICY_PACK` encodes the approval-gated default; deployments override via injected config. No default behaviour changes until governed git delivery is explicitly enabled.
- Branch deletion after merge is honoured as a guarded, non-fatal follow-up; deployments that prefer GitHub's own auto-delete-head-branch setting can pass `deleteBranchAfterMerge: false`.

## Alternatives Considered

### Alternative 1: Discover readiness by attempting the merge and classifying the rejection

- **Pros**: No extra provider read; one round-trip; the provider is the ultimate authority anyway.
- **Cons**: AC1 requires readiness to be *visible* before execution and the merge to be *blocked* when prerequisites are missing — not attempted-and-rejected. A speculative merge call also risks partial side effects on some providers and produces a worse user experience (a failed attempt instead of a clear pre-merge blocker list).
- **Why rejected**: Force 2. Readiness must be read and shown before the merge call; the provider rejection remains the backstop, not the primary signal.

### Alternative 2: Extend the PR gateway (git-pr-gateway.ts) to add a merge method

- **Pros**: One gateway; reuses the PR `gh api` adapter infrastructure.
- **Cons**: The PR allowlist explicitly excludes merge/delete (ADR-0086 D1); the PR port has create/update methods only; the merge failure taxonomy (405/409/422-required-checks) is distinct. Adding merge would erode the PR gateway's no-merge invariant and widen its allowlist.
- **Why rejected**: Force 1. Merge is a structurally independent operation with its own endpoint, allowlist, and taxonomy.

### Alternative 3: Encode base-branch and strategy constraints in the merge policy pack instead of the readiness layer

- **Pros**: One place (the policy pack) for all gating.
- **Cons**: The policy evaluator selects one decision per action kind; it cannot express "approval-gated AND base-restricted AND strategy-restricted" in a single rule. Merge prerequisites (checks, approvals, conflicts, strategy compatibility) are provider facts that belong in the readiness model, not in a static policy pack.
- **Why rejected**: Force 6 / D6. Policy governs authorization (proceed + approval); readiness governs release conditions. Keeping them separate matches the policy model and keeps the pack simple.

### Alternative 4: Add @octokit/rest as an npm dependency for the merge call

- **Pros**: Type-safe; no subprocess.
- **Cons**: Adds supply-chain surface and makes Keiko the token custodian, breaking the token-isolation invariant.
- **Why rejected**: Force 4 / ADR-0086 Alternative 2. The `gh api` subprocess preserves token isolation at the process boundary.

## Related

- ADR-0080: Governed Git delivery contracts (`merge` action kind, `GitDeliveryMergeInputs`, `GitDeliveryMergeStrategyHint`, `GitDeliveryMergeBlockReason`, provider-state interfaces reused unchanged)
- ADR-0081: Governed Git mutation execution kernel (`merge` → `preflightNoLocalPrecondition` unchanged; lifecycle result shape reused)
- ADR-0082: Governed Git approval and preview surface (read-only BFF preview pattern; `isGitDeliveryTrusted` gate reused)
- ADR-0083: Governed Git mutation evidence ledger (`buildGitDeliveryEvidenceRecord` records the merge envelope unchanged)
- ADR-0085: Governed remote publish gateway (parallel gateway pattern mirrored; publish gateway unchanged)
- ADR-0086: Governed pull request gateway (parallel gateway pattern mirrored; PR gateway unchanged; merge was deferred to this slice)
- ADR-0019: Modular Package Architecture (leaf-package rule; dependency direction; `arch:check`; god-module threshold)
- ADR-0051: Design System visual-regression and acceptance gate (globals.css untouched; inline CSS vars only)
- ADR-0043: Enforced Execution Isolation (sandbox network policy; `gh api` uses `inherit` network, same as push/PR)
- Issue #478: Merge governance, protected-branch enforcement, and guided recovery flows (this ADR)
- Issue #470: Epic — governed end-to-end Git delivery
- ADR-0066: (next on this feat branch)

## Date

2026-06-26
