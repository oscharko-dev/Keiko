# Qodo review policy

## Purpose

Qodo (the "Qodo Code Review" GitHub App) is an independent advisory review product for pull requests
targeting `dev`. It is not a branch-protection requirement. Direct deterministic required checks, not
a Qodo review comment, grant native auto-merge authority.

Every pull request targeting `dev` is assumed to be a large, completed-epic integration PR,
regardless of its observed file count. Review scope and acceptance must therefore be safe for
hundreds of changed files by default; a smaller diff may reduce work only after its complete changed
file inventory has been established.

Qodo is comment-only: it posts and updates a single summary review comment and never emits a
check-run. The summary comment must come from bot user ID `151058649` and carry
`performed_via_github_app.id = 484649`; those identities make advisory evidence attributable and
anti-spoofed. Because Qodo posts no check-run, evidence currency is bound to the head SHA embedded in
the comment body (Qodo's blob permalinks reference the reviewed commit), not to a check timestamp.
Missing, wrong-head, wrong-producer, or unparseable review evidence is treated as absent; it does not
turn missing vendor output into a merge-blocking product failure.

## Effective repository and organization settings

| Capability            | Setting                     | Rationale                                                                                          |
| --------------------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| Draft processing      | Skipped                     | Avoids spending review on intermediate agent heads; ready (published) PRs are reviewed.            |
| Ready-PR review       | Automatic on published PRs  | Every ready `dev` PR receives the Qodo review and summary comment.                                 |
| PR summaries          | Enabled                     | Gives the delivery agent an independent change inventory.                                          |
| Persistent comment    | Enabled                     | One review comment is updated in place per head, so the latest comment reflects the current head.  |
| Merge blocking        | Disabled (comment-only)     | Qodo emits no check-run and must not deadlock repository delivery.                                 |
| Auto-approve          | Disabled                    | `approve_pr_on_self_review` and `auto_approve_for_no_suggestions` stay off; Qodo has no authority. |
| Approval / auto-merge | Disabled                    | GitHub native auto-merge is governed only by the direct required checks.                           |
| Compliance rules      | Platform-scoped to the repo | Substantive rules are managed at `app.qodo.ai/rules` for the repository scope.                     |
| Human authors         | All                         | Every human-authored Keiko PR is in scope.                                                         |
| Bot authors           | `dependabot`                | Dependency PRs receive Qodo review in addition to Socket and dependency review.                    |
| External integrations | None                        | Keiko uses GitHub Issues and Projects; external trackers would add unneeded authority and cost.    |

Platform and dashboard configuration mirrors the binding rules in `AGENTS.md`, the ADRs, and the
repository Qodo config. Repository files are the durable, reviewable source; dashboard text must not
diverge from the checked-in policy.

### Platform-scoped capability inventory (Issue #2510)

Exactly two configuration surfaces live outside the repository, and both are mirrors, never
sources:

1. **Repository-scope compliance rules** (`app.qodo.ai/rules`) — mirror the standards in
   `best_practices.md`. Any dashboard rule without a repository counterpart is non-binding by
   definition and must either be added to `best_practices.md` through review or removed.
2. **Organization/repository toggles** (the settings table above) — each row's authoritative
   value is recorded here; the dashboard only reflects it.

The review standard is therefore reconstructable from the repository alone: `.pr_agent.toml`
(methodology + no-authority invariant) plus `best_practices.md` (code standards) re-seed a fresh
Qodo installation — or any replacement reviewer — without dashboard access.

## Dependency risk and fallback

Qodo is a hosted third-party service on a free tier; its plan, quotas, or availability can change
without notice. The posture if it does:

- **Merges never deadlock on Qodo.** Qodo is comment-only and emits no required check. `Keiko for
Quality` (which bridges Qodo findings) is advisory and non-required until the ADR-0135 live
  probes pass, and its evaluator treats absent review evidence as fail-closed _within the
  advisory aggregate only_ — the direct required checks and branch protection gate integration
  natively and are Qodo-independent.
- **Static analysis does not regress.** SonarCloud (OSS tier) and the direct required checks
  carry the deterministic quality bar with or without Qodo.
- **The review standard survives the vendor.** `best_practices.md` and `.pr_agent.toml` are the
  complete, versioned standard; pointing a replacement reviewer (or a future self-hosted one) at
  them restores equivalent review coverage without reconstruction from memory.
- **Exit is a config change, not a migration.** Uninstalling the app and disabling the KFQ Qodo
  bridge changes no required check and requires no code beyond removing the bridge wiring.

## Version-controlled configuration

- `.pr_agent.toml` (repo root) pins the review methodology (`[pr_reviewer]` / `[pr_code_suggestions]`
  `extra_instructions`) and the no-merge-authority invariant (`approve_pr_on_self_review = false`,
  `auto_approve_for_no_suggestions = false`, `persistent_comment = true`).
- `best_practices.md` (repo root) carries the concrete security and architecture code standards Qodo
  checks changed code against, kept under Qodo's 800-line best-practices ceiling.
- Substantive compliance rules are platform-managed for the repository scope; the repository files
  remain the durable, reviewable source and reference `AGENTS.md`, `CONTRIBUTING.md`,
  `docs/qa/keiko-for-quality.md`, and the applicable ADRs.
- `npm run check:qodo-config` validates that both files exist, reference the canonical governance,
  carry the core review instructions, stay under the length ceiling, and never enable auto-approval.
- The required CI job executes that validator; run `npm run check:qodo-config` directly when
  editing these files.

## Review lifecycle

1. Review the complete live issue, `AGENTS.md`, applicable ADRs, and current PR head.
2. Keep the PR draft while intermediate heads are pushed. Mark it ready only after the local pre-PR
   gate passes; publishing a ready PR triggers the Qodo review automatically.
3. If the review must be refreshed on the exact final candidate head, comment `/review` on the pull
   request. The accepted delivery agent performs this; no human handoff is required. A new commit
   supersedes the previous review, whose comment then references a stale head.
4. Inspect the summary comment, its Bugs / Rule violations / Requirement gaps counts, and the inline
   threads together. A processed comment alone is insufficient.
5. Require the summary comment to reference the current head SHA and to report zero blocking findings
   (Bugs + Rule violations + Requirement gaps). Skill insights do not block. A comment bound to a
   superseded head does not settle the current head.
6. Review all changed production files that implement critical behavior and every trust boundary. A
   clean summary is not proof that every high-value file was inspected.
7. The delivery agent fixes confirmed findings at the owning layer, adds a failure-first regression
   or boundary test, reruns local gates, and refreshes the review on the current head after the
   repair push.
8. Direct required checks must pass before native auto-merge; no human review or merge click follows.

## `dev` integration pull-request acceptance

Treat every PR targeting `dev` as a large, completed-epic integration PR. Review all changed
production source, migrations, workflows, manifests, public contracts, and tests for critical
behavior before binary evidence, snapshots, lockfiles, or generated artifacts. The review is not
accepted merely because Qodo posts a summary comment. If service limits prevent complete inspection
of this executable and trust-boundary surface, fail closed and report the unreviewed files instead of
issuing a clean verdict.

Escalate the Qodo integration when any of these conditions occurs:

- no Qodo summary comment appears within a bounded 60-minute observation window after the PR is
  published;
- the comment is not produced by App ID `484649` / bot user `151058649`, or does not reference the
  current head SHA;
- the comment is stale, unparseable, or reports unresolved Bugs, Rule violations, or Requirement
  gaps;
- Qodo issues a clean verdict despite an unreviewed executable or trust-boundary file;
- a risk-based independent review finds a material defect class that Qodo did not inspect;
- automatic processing is paused by a plan, seat, or configuration problem.

Do not poll unchanged state indefinitely. Capture the head SHA, comment timestamp, and finding counts
once per decision point. If the same integration failure persists after one explicit `/review`
rerun, report it as a vendor/configuration incident rather than using the remote PR as an open-ended
test loop.

## Safe interaction commands

The following pull-request comment commands are safe when their stated purpose is authorized:

```text
/review
/describe
/improve
/ask <bounded question>
```

`/improve` suggestions are comment-directed; the repository agent owns local reproduction and
verification of any resulting change. Qodo must never gain merge authority: auto-approval,
self-review approval, and merge blocking remain disabled, and there is no bypass command.

## Boundaries

The repository depends only on Qodo's advisory review and code-suggestion capabilities plus
platform-managed compliance rules. It does not depend on and must not enable any auto-approval,
self-review approval, merge blocking, or required-check behavior for Qodo. Dashboard state is not an
immutable audit log, so durable configuration requirements also land as reviewed repository changes.

Qodo runs in parallel with the outgoing Gitar review product only until it proves green on live pull
requests; Gitar is then retired (app uninstalled, `.gitar/` removed, trial cancelled). The swap
changes no required check.
