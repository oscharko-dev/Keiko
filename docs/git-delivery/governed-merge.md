# Governed Merge (Issue #478)

Epic #470 · ADR-0087 · builds on the #477 governed pull request gateway.

## Purpose

Turn a review-ready pull request into a merged change through an explicit, governed workflow rather than
a casual click. Merge is the highest-risk delivery action in the epic, so it is treated as a governed
release decision: it reasons about merge readiness (required checks, approvals, branch protection,
conflicts, merge-queue position) from authoritative provider facts, enforces policy and a final approval
_before_ the merge call, permits only repo-and-provider-compatible merge strategies, surfaces precise
structured blockers and recovery advice for blocked or failed merges, and records content-free evidence
for every terminal outcome. The provider's own server-side enforcement remains the ultimate backstop; the
gateway's readiness gate makes that enforcement visible and refuses to attempt a merge that would be
rejected.

## Architecture

The merge layer is a **third parallel** execution authority — never an extension of the publish gateway
(#476) or the pull request gateway (#477). A merge shells a different `gh api` REST call
(`PUT /repos/{owner}/{repo}/pulls/{number}/merge`) with a different failure taxonomy (405 not-mergeable,
409 head-modified, 422 required-status-checks) than either sibling. The PR allowlist explicitly excludes
merge and delete; folding merge into it would erode that narrow-port, one-purpose-allowlist invariant. The
merge gateway therefore has its own narrow port, its own dedicated allowlist, and its own GitHub-error
classifier. It reuses the kernel's pure machinery — preflight, policy evaluation, the lifecycle-result
shape, and the evidence builder — so there is no second policy system and no second evidence schema.

| Layer        | Module                                                              | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| contracts    | `keiko-contracts/src/git-merge.ts`                                  | Provider-neutral, content-free leaf: the merge-readiness model (`GitMergeReadinessSummary` with `mergeable` and severity-ranked `blockers`), the neutral blocker taxonomy (reusing `GitDeliveryMergeBlockReason` plus lifecycle states), strategy-eligibility derivation (`deriveEligibleMergeStrategies`), the merge recommendation, and the neutral `GitMergeRejectionReason` taxonomy with exhaustive disposition/error-code tables. Pure: no IO, no clock, no provider field names.                                        |
| tools (pure) | `keiko-tools/src/git-merge-gateway.ts`                              | The pure merge gateway: `GitMergeCommand`, the narrow two-method `GitMergeAdapter` port (`readMergeReadiness` / `mergePullRequest`), the dedicated `gh api` allowlist (`GIT_MERGE_ALLOWED_SUBCOMMANDS = ["api"]`, deny `--input` / `--paginate`), the pure argv builders (`buildMergeArgv` / `buildMergeReadinessArgv` / `buildDeleteMergedBranchArgv`), `classifyGitMergeRejection`, `evaluateGitMergeEffectivePolicy`, and `runGitMerge` returning a `GitMergeLifecycleResult` the #474 evidence builder consumes unchanged. |
| tools (Node) | `keiko-tools/src/git-merge-node.ts` (on `./internal/git-mutation`)  | `createNodeGitMergeAdapter`: shells `gh api` through the shared no-shell spawn boundary to read readiness and execute the merge, then performs the guarded non-fatal branch deletion. Maps GitHub `mergeable_state` to the neutral readiness model. `gh` reads its own token; Keiko never reads the token value. Output is secret-redacted before classification.                                                                                                                                                              |
| server       | `keiko-server/src/gitDelivery/mergeExecution.ts` + `mergeRoutes.ts` | `POST /api/git-delivery/merge/preview` (read-only readiness + eligible strategies + recommendation + policy) and `POST /api/git-delivery/merge/execute` (governed merge + evidence). Reuses the policy/evidence path. Default `KEIKO_DEFAULT_MERGE_POLICY_PACK`.                                                                                                                                                                                                                                                               |
| ui           | `keiko-ui/.../cards/GovernedMergeCard.tsx`                          | The merge command surface: the strategy selector (populated from eligible strategies, never a hard-coded default), the readiness / blocker panel, the final high-risk approval affordance, and the rejection / recovery display. Inline styles via CSS custom properties (globals.css untouched). Outcome conveyed by text + aria-live, never colour alone.                                                                                                                                                                    |

## The three gates in `runGitMerge` (AC1)

`runGitMerge` admits a merge through three sequential gates before it ever calls the merge endpoint, then
relies on provider enforcement as the backstop:

1. **Preflight** — `evaluateGitPreflight` (`merge` → `preflightNoLocalPrecondition`, unchanged from #472).
   Local precondition checks that do not require the network.
2. **Policy + final approval** — `evaluateGitPolicy` against the default pack, which makes `merge`
   `approval-gated`. A merge cannot proceed without a satisfied, unexpired approval token; the kernel's
   `approval-gated` → `approval-required` path is fully supported. This is the explicit high-risk
   confirmation AC1 requires.
3. **The readiness gate** — the gateway reads a content-free merge-readiness snapshot from the provider
   _before_ the merge call, derives a structured blocker list, and refuses to call `mergePullRequest`
   when a blocking blocker is present.

Only when all three gates pass does the gateway call the merge PUT. The provider's own server-side
enforcement (required checks, approvals, branch protection) remains the ultimate authority; the readiness
gate makes that enforcement visible _before_ execution rather than discovering it from a failed attempt.

## Transport and the token boundary (ADR-0087 D2)

The Node adapter shells `gh api` (no `@octokit` npm dependency). The dedicated endpoint allowlist permits
only:

- `PUT /repos/{owner}/{repo}/pulls/{number}/merge` (execute the merge; `merge_method` and the optional
  `sha` head guard are argv-built)
- `GET /repos/{owner}/{repo}/pulls/{number}` and, when the PR is not cleanly mergeable, a second bounded
  read of the head commit's combined status (read readiness)
- `DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}` (the guarded, non-fatal post-merge head deletion)

There is no create, update, draft-toggle, or push endpoint in this allowlist; those belong to the PR and
publish gateways. `gh` authenticates itself from its keyring or `GH_TOKEN` / `GITHUB_TOKEN`; the Keiko
process never reads or stores the GitHub token. Raw stdout / stderr are secret-redacted before they leave
the executor.

## The merge-readiness model and neutral blocker taxonomy (AC3)

`GitMergeReadinessSummary` (`schemaVersion`, `mergeable: boolean`, severity-ranked
`blockers: GitMergeReadinessBlocker[]`) is a **pure derivation** in the contracts leaf.
`gitMergeReadinessFor(input)` computes it from the provider-state facts the server gathers and passes in
(`GitDeliveryPullRequestState`, `GitDeliveryChecksState`, `GitDeliveryBranchProtection`) — no IO, no
network. Blocking blockers precede advisory blockers by construction.

The blocker vocabulary **reuses** `GitDeliveryMergeBlockReason` (`checks-failing`, `approvals-missing`,
`conflicts`, `branch-protection`, `merge-queue-position`, `provider-policy`) plus a lifecycle set
(`pr-not-open`, `pr-already-merged`, `draft-pr`), so the #471 seam stays the canonical taxonomy. The
GitHub `mergeable_state` enumeration never appears in contracts; the Node executor maps it to the neutral
model:

| GitHub `mergeable_state` | Neutral readiness                                            |
| ------------------------ | ------------------------------------------------------------ |
| `clean`                  | ready (mergeable, no blocking blocker)                       |
| `dirty`                  | `conflicts` blocker                                          |
| `blocked` / `behind`     | `branch-protection` blocker                                  |
| `draft`                  | `draft-pr` blocker                                           |
| `unknown`                | readiness-unknown (treated as not-mergeable, advisory probe) |

`unstable` and other non-clean states resolve through the same neutral facts (failing checks →
`checks-failing`, missing approvals → `approvals-missing`).

## Strategy eligibility is policy ∩ provider capability (AC2)

The permitted merge strategy is data, never a UI default. `deriveEligibleMergeStrategies(requested,
policy, providerCapable)` returns the eligible set — the **intersection** of the strategies the deployment
policy permits (`GitMergeStrategyPolicy.allowedStrategies`) and the strategies the provider repository
advertises as capable — plus a deterministic default selection and whether the requested strategy is
eligible. A requested strategy outside the eligible set is a structured `strategy-unavailable` block,
never a silent substitution. The UI strategy selector is populated from the eligible set returned by the
preview; it never defaults to a hard-coded strategy.

## Rejection taxonomy and recovery dispositions (AC3)

`GitMergeRejectionReason` is a closed union: `not-mergeable`, `checks-failing`, `approvals-missing`,
`conflict`, `head-modified`, `strategy-unavailable`, `branch-protection`, `already-merged`, `not-found`,
`permission-denied`, `rate-limited`, `provider-unavailable`, `unknown`. The Node executor classifies a
non-OK merge status via `classifyGitMergeRejection`, an ordered phrase table over the redacted gh output;
the ordering is load-bearing (rate-limit before permission-denied; head-modified before not-mergeable).
Exhaustive `GIT_MERGE_REJECTION_ERROR_CODE` and `GIT_MERGE_REJECTION_DISPOSITION` tables map each reason
to a reused `GitDeliveryExecutionErrorCode` (recorded in evidence) and a reused
`GitDeliveryRecoveryDisposition` (`retryable` / `user-fixable` / `policy-forbidden` / `none`), with a
recovery action hint where one fits cleanly. Raw provider output never crosses the boundary — only the
typed reason, error code, disposition, and hint.

| Reason                 | Error code            | Disposition  | Action hint          |
| ---------------------- | --------------------- | ------------ | -------------------- |
| `not-mergeable`        | `precondition-failed` | user-fixable | resolve-conflicts    |
| `checks-failing`       | `precondition-failed` | user-fixable | (await checks)       |
| `approvals-missing`    | `precondition-failed` | user-fixable | (request review)     |
| `conflict`             | `precondition-failed` | user-fixable | resolve-conflicts    |
| `head-modified`        | `precondition-failed` | user-fixable | re-read-readiness    |
| `strategy-unavailable` | `precondition-failed` | user-fixable | choose-strategy      |
| `branch-protection`    | `provider-rejected`   | user-fixable | adjust-policy-target |
| `already-merged`       | `provider-rejected`   | none         | (terminal-success)   |
| `not-found`            | `provider-rejected`   | user-fixable | (none)               |
| `permission-denied`    | `provider-rejected`   | user-fixable | (none)               |
| `rate-limited`         | `network-failure`     | retryable    | retry                |
| `provider-unavailable` | `network-failure`     | retryable    | retry                |
| `unknown`              | `provider-rejected`   | user-fixable | (none)               |

## The guarded branch deletion

On merge success with `deleteBranchAfterMerge`, the executor performs a guarded, non-fatal `DELETE` of the
head ref. A failed deletion never fails the merge, and a protected head branch is never deleted absent the
`protected-branch-delete` provider capability. Deployments that prefer GitHub's own auto-delete-head-branch
setting pass `deleteBranchAfterMerge: false`.

## Policy and the UI window (AC1 / AC4)

`KEIKO_DEFAULT_MERGE_POLICY_PACK` authorises `merge` as `approval-gated` (`requiredApprovers: []` — at
least one approver of any identity), with `defaultRule: { decision: "blocked" }` so every other action
kind is fail-closed. The pack governs _authorization_ (may this action proceed, and does it need
approval); merge _prerequisites_ (checks, approvals, conflicts, strategy compatibility) live in the
readiness layer, because the policy evaluator selects one decision per action kind and cannot express
"approval-gated AND base-restricted AND strategy-restricted" in a single rule. A deployment may override
with a stricter pack (e.g. naming specific `requiredApprovers`). The merge surface is always registered.
It becomes operational only when the project worktree, `gh` authentication, provider readiness, eligible
strategy, policy, and required approval are all satisfied.

`GovernedMergeCard.tsx` is a new sibling card under a new `"governedMerge"` window kind, launched from the
PR card's review-ready state. It hosts the strategy selector (populated from the eligible set), the
readiness / blocker panel, the final high-risk approval affordance, and the rejection / recovery display.
All status and error signals are conveyed by text and `aria-live`, never by colour alone; `globals.css` is
not modified (ADR-0051 gate); all styling uses inline CSS custom properties.

## Tests and evidence (AC5)

- contracts: `git-merge.test.ts` (readiness derivation and severity ordering, `mergeable_state`-neutral
  mapping at the model level, strategy-eligibility intersection, recommendation, exhaustive rejection
  taxonomy, guards).
- tools: `git-merge-gateway.test.ts` (argv builders with strategy mapping and malformed-operand rejection,
  the GitHub-error classifier ordering invariant, effective policy, and the lifecycle gates with a fake
  adapter — including that the readiness gate blocks a not-mergeable PR _before_ `mergePullRequest` is
  called and that the gateway calls nothing but the narrow adapter).
- tools (Node): `git-merge-node.integration.test.ts` (scripted spawn proving `mergeable_state` mapping and
  the guarded non-fatal branch delete).
- server: `gitDelivery/mergeRoutes.test.ts` (route / CSRF guards, policy / approval / readiness
  blocking, content-free evidence append, rejection → recovery projection — all with a fake adapter, no
  `gh`, no network).
- ui: `GovernedMergeCard.test.tsx` + `.a11y.test.tsx` (eligible-strategy seeding, dispatch payloads,
  blocker panel, outcome banner, readable API failure alert, WCAG 2.2 AA).
- browser evidence (non-gating, coordinator): `tests/e2e/config/playwright.issue-478-merge-governance.config.ts` +
  `tests/e2e/merge-governance-478.spec.ts` drive the real packaged app for the read-only preview, the
  blocked-merge state, and governed error surfacing, proving the UI merge path reaches the governed BFF
  routes with no client-side escape. Run with `npm run test:e2e:merge-governance-478`. Evidence under
  `docs/git-delivery/evidence/478/`.
