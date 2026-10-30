# ADR-0182: Keiko for Quality — governed pull request review agent

## Status

Accepted (owner decision, 2026-10-29; Epic #4130, Issue #4131).

This decision records the architecture of a product capability. It does not reintroduce a
model-backed reviewer on `oscharko-dev/Keiko`, does not change that repository's review settlement,
required checks or branch protection, and adds no credential (D11). Each decision is implemented and
proven by the child issue named beside it; until that child merges, the decision is a guardrail for
it, not a claim about shipped behavior.

## Context

The retired repository reviewer (ADR-0170, retired by ADR-0176) failed on signal quality, not on
where it ran: 21.0 % actionable findings (17 of 81) and 31.9 comments per pull request. Its
verification, settlement, fingerprint and measurement design was sound; its volume was not.

PR-Agent v0.49.0 (MIT) contributes a strong reviewer prompt, the `key_issues_to_review` output
shape, a hard limit of three findings and careful diff packaging (five lines of context before and
one after, enclosing-function context of at most ten lines, `large_patch_policy = "clip"`). It is
diff-only and non-agentic, and it ships a Python runtime, its own model client, nine Git provider
integrations and webhook servers, none of which Keiko needs.

Keiko already owns the pieces a governed reviewer needs: the OpenCode coding runtime composition
with its sidecar, tool authority port and runtime authority service (ADR-0124, ADR-0125, ADR-0138),
a bounded read-only child runner (`productionReadOnlyChildRunner.ts`), the hardened Git runner
(`keiko-git`), the governed pull request gateway (ADR-0086), the Model Gateway with budgets and spend
ledger (ADR-0019 trust-1), the Activity Log v2 registry (ADR-0173) and the Git window. The smallest
correct design is therefore a server-defined review agent on the existing runtime composition plus
the existing read-only child runner, not a second runtime, a GitHub App or a webhook service.

Measurement comes first: the agent becomes visible only after it passes an offline gate, and
publication to GitHub comes last, after a live gate (D9).

## Decision

### D1 — Review runtime: a dedicated instance of the existing composition

The Reviewer runs on the existing OpenCode coding runtime composition in a dedicated, server-owned
review runtime instance: its own orchestrator instance, its own sidecar session and a review
authority bound to the review worktree (D3). It never occupies the user's Coding Workbench run slot
(one active run per orchestrator) and never switches the active task workspace. The review agent
and its system prompt are server-defined: the agent is not user-selectable, not part of the
`build | plan` set, and review runs are not listed in Coding Workbench or Coding History. There is no
second runtime implementation, agent loop or direct provider SDK call; every model call passes the
Model Gateway with its existing budgets, spend ledger and readiness. The runtime purpose that
distinguishes a review instance is recorded in ADR-0124/ADR-0125/ADR-0138/ADR-0173 by Issue #4135.

### D2 — Read-only by construction, independent of the autonomy mode

A review run has a closed tool allowlist: `keiko_workspace_read`, `keiko_workspace_discover`,
`keiko_repository_search` and `keiko_review_report`. Edit, write, patch, shell, execute,
verification, web fetch and search, research fetch, skills, questions, model-launched child agents
and every `keiko_git_*` and `keiko_pull_request` tool are absent from the run configuration and
denied by policy whatever autonomy mode is selected. Independent layers enforce this, and each one
fails closed on its own:

1. The generated runtime configuration denies `*` and allows only the four tools (no `question`).
2. The registered tool set is exactly those four tools, pinned by digest.
3. The review authority grants the `workspace-read` action class only, and the tool authority port
   checks it on every call. Its `effectiveMode` is `governed-assist`.
4. The tool facade and the catalog bridge refuse every non-read action of a run that carries review
   authority. (No autonomy mode denies effects today; Ask for approval only asks. Review authority
   therefore denies instead of asking.)

A review run always uses the governed tool profile, on macOS, Linux and Windows alike, so there is
one measured behaviour. The governed profile generates no native policy plugin, so the native policy
hook is not on this path. A startup self-check refuses to start a review instance with the native
profile or with any layer missing. Hard denials stay mode-independent. Proven by Issue #4135.

### D3 — Review target and hardened review worktree

A review target is an exact pair of commits. A pull request target resolves to an immutable base SHA
and head SHA; Keiko fetches `refs/pull/<n>/head` with the hardened Git runner and refuses the run
(`skipped/target-changed`) when the fetched head differs from the head the provider reported. A
local-range target reviews a local branch against its base without a hosting provider.

Keiko creates a dedicated, detached review worktree at the head SHA. The user's own checkout and
branches are never modified. Hooks, filter drivers (including Git LFS smudge), `core.symlinks` and
fsmonitor are neutralized for that worktree, symbolic links are checked out as plain files, and
workspace containment and sensitive-path denials apply unchanged. A fork pull request is treated
exactly like any other: every pull request is hostile input regardless of its author. A head
whose tree exceeds the path or byte budget is refused before checkout (`worktree-failed` with the
closed detail `tree-too-large`), as are case or normalization collisions; a pull request target's
branch names are display data only (Keiko fetches by number and reviews SHAs). The worktree
is removed when the run settles or is abandoned. Private review refs
(`refs/keiko-review/<installation>/<n>/<headSha>`, namespaced per installation) remain only to serve the reviewed diff and are swept when the
pull request closes, when no run references them, or after 30 days. ADR-0086 and ADR-0098 are
amended by Issue #4133.

### D4 — Structured findings only

Findings leave the model only through `keiko_review_report`, whose argument shape is the versioned
`ReviewFindingReport` contract in `keiko-contracts`. Free text in the activity feed is never parsed
into findings. The server validates every evidence location against the reviewed commit, rejects
unverifiable findings, and presents at most three findings per run. The limit of three is a
presentation rule, not a schema limit on a single report, so refuted findings remain measurable.
The review-rules file is read from the base commit object only (configurable per repository;
Keiko uses `docs/qa/review-standards.md`); `AGENTS.md` is not a review input.

### D5 — Two independent passes

Each candidate finding is counter-checked in its own Keiko-started, read-only session with fresh
context and the Counter-checker model, through the existing read-only child runner generalized to
accept the role's model and to return a structured `CounterCheckVerdict`. The counter-check never
sees the Reviewer's reasoning. A finding reaches the person only if the Counter-checker confirms it
with its own code evidence; refuted and undecided findings are retained in the run record for
measurement and are never shown as findings. Proven by Issue #4136.

### D6 — Honest settlement

Every run ends in exactly one settlement with a closed reason. Incomplete work never presents as a
clean review.

| Settlement   | When                                                                                                   | Reasons                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete`   | the diff package was fully processed, the Reviewer run ended normally and every candidate has a verdict | none                                                                                                                                            |
| `incomplete` | review work started and some of it could not finish                                                    | `files-unprocessed`, `budget-exhausted`, `deadline-exceeded`, `model-failed`                                                                    |
| `abandoned`  | the run stopped before settling normally                                                               | `cancelled`, `interrupted`                                                                                                                      |
| `skipped`    | nothing was reviewed because preparation failed                                                        | `target-changed`, `worktree-failed`, `diff-too-large`, `no-reviewable-changes`, `rules-file-invalid`, `policy-invalid`, `model-unavailable` |

A pull request head that moves after preparation marks the run's results `stale` for display; stale
is never a settlement. The vocabulary is `ReviewRunSettlement` in `keiko-contracts`.

### D7 — Finding decisions and the audit trail

A person decides each presented finding: `accepted`, `dismissed` with a closed reason
(`not-a-defect`, `not-caused-by-change`, `already-handled`, `wont-fix`, `duplicate`, `other`) and an
optional private note, or `fixed`. Decisions are server-owned state bound to the repository
identity, pull request number, head SHA, run id and finding fingerprint; the UI renders that state
and is not its authority. Decisions are recorded in an append-only audit trail (German UI:
„Prüfspur“). Its export is body-free by default; including content (finding prose, notes) requires
an explicit opt-in at export time. No surface calls the model an "auditor": the audit is the human
decision record. Proven by Issue #4141.

The finding fingerprint is content-derived and line-independent: a framed digest of the normalized
file path, the category and the normalized code excerpt of the `defect` evidence. It ignores line
numbers and model-written prose such as the title, so an identical finding keeps its identity when
the code moves. Publication (D10) still anchors comments to exact lines of the reviewed commit.

### D8 — Model roles

There are two roles, Reviewer and Counter-checker, each bound to a model the deployment's gateway
offers (`ReviewModelPolicy`). One pure rule, `evaluateReviewRoleEligibility`, decides eligibility
for both roles from the existing gateway capability data: a model must be configured, have verified
and current tool calling, a known context window that fits the review budget, and be coding-safe.
Conversation readiness `false` makes it temporarily unavailable; a busy model stays eligible.
Operators may set defaults and restrict the choice; invalid explicit configuration fails closed.
Each pair has a status (`unmeasured`, `seed-qualified`, `seed-failed`, `collecting`,
`measured-passed`, `measured-failed`); a pair that was never measured is shown as unmeasured, never
as qualified. Keiko's lab default is `qwen3.6-35b-a3b-4bit` (MLX 4-bit, mixture-of-experts, about
19 GB) as Reviewer and `gemma-4-31b-it-4bit` (MLX 4-bit, dense, about 17 GB) as Counter-checker
through the local LiteLLM gateway. Both stay resident together on a 64 GB developer machine, so no
model is reloaded between the Reviewer and Counter-checker passes; the faster mixture-of-experts
model takes the tool-call-heavy Reviewer role and a model of a different family checks it. This
pair replaced an 8-bit pair of the same families (epic #4130 decision, 2026-10-30) because the two
8-bit models (about 69 GB) did not fit together. The lab default is a starting pair, not a
qualification: measurement results belong to the exact pair measured. Proven by Issue #4137.

### D9 — Measurement gates

- **Offline gate (Issue #4138).** On a chronological holdout of historical Keiko pull requests, the
  agent reaches at least 50 % actionable findings, finds every mandatory seeded defect, reports at
  most three findings per pull request and reports its cost. The Pull requests area (Issues #4139
  to #4142) starts only after this gate passed.
- **Live gate (before Issue #4143).** At least 50 % accepted findings over the first 100
  human-decided findings.

Results are always reported with absolute counts, the model pair, the holdout boundary and the
cost. Holdout pull requests are never used to tune prompts. A model that fails is replaced or the
prompt is improved; the threshold is not lowered. The offline holdout, the seed gate and the live
counters are the only sources for quality claims in UI, documentation and release notes. Seed
scoring is one pure function, `scoreReviewSeedRun`, shared by the development seed gate in
`keiko-evaluations` and the shipped pair qualification in the server.

The holdout boundary is the constant `holdoutFromPullRequest` of the review evaluation manifest:
pull request #3066, fixed by Issue #4132 from the recorded baseline
(`docs/qa/review-agent-baseline-2026-10-30.md`); the replay refuses a run that tunes on the holdout.
Definitions and labeling rules are in `docs/qa/review-agent-measurement.md`.

### D10 — Publication boundary

Nothing leaves Keiko without an explicit human action. Publication arrives only in phase 3, after
the live gate. It adds exactly two narrow `gh api` endpoints to the pull request gateway allowlist:
one read of existing review comments (duplicate detection) and the creation of one pull request
review with line comments and `event=COMMENT`. There is still no merge, approve, request-changes,
dismiss, update or delete method. ADR-0086 is amended by Issue #4143.

### D11 — Relationship to ADR-0176 and ADR-0087

This decision adds a product capability that a person starts on their own pull requests. It does
not reintroduce a reviewer on `oscharko-dev/Keiko`, change its review settlement or add a credential;
ADR-0176 remains in force for the repository. A review is advisory: it never gates, approves or
blocks a merge, and the Governed Merge Gateway (ADR-0087) remains the only merge path, unchanged by
this epic.

## Trust analysis

| Threat                                                                                                                   | Mitigation                                                                                                                                                                                                | Proven by |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Prompt injection through pull request title, body, commit messages, comments, code, file names or the review-rules file | All of it is untrusted data, never instructions or grants. The tool allowlist (D2) leaves an injected instruction nothing to act with; findings are structured (D4) and counter-checked (D5); rules come from the base commit only | #4135, #4136 |
| Checkout attacks: hooks, filter drivers, LFS smudge, fsmonitor                                                           | Detached worktree with hooks, filters, LFS smudge and fsmonitor neutralized; the hardened Git runner refuses caller-supplied overrides (D3)                                                               | #4133 |
| Symbolic links escaping the worktree; case-colliding paths; submodules                                                   | Symbolic links checked out as plain files; workspace containment and sensitive-path denials unchanged; submodules are not initialized                                                                     | #4133, #4134 |
| Resource exhaustion: huge diffs, binary files, giant blobs, pathological hunks                                           | The diff package is built from Git objects with byte and file bounds and explicit coverage; oversized input settles `skipped/diff-too-large` or `incomplete/files-unprocessed`, never clean (D6)          | #4134 |
| Spoofed evidence from model output                                                                                       | Every evidence location is validated against the reviewed commit; unverifiable findings are rejected; the Counter-checker must produce its own code evidence (D4, D5)                                    | #4136 |
| Disclosure of code to the configured model provider                                                                      | Models are the deployment's own gateway models assigned by the customer; every call passes the Model Gateway with its budgets and redaction; nothing is sent elsewhere (D1, D8)                          | #4135, #4137 |
| Stale target: the head moves during a run                                                                                | Exact SHAs fixed at preparation; a fetched head that differs refuses the run; a later move marks results `stale` for display only (D3, D6)                                                               | #4133, #4136 |
| Publication of an unconfirmed or stale finding                                                                           | Only confirmed, human-accepted findings at the current head can be selected; publication needs explicit approval and uses `event=COMMENT` only (D10)                                                     | #4143 |
| Decision tampering through the UI                                                                                        | Decisions are server-owned, bound to repository, pull request, head SHA, run id and fingerprint, and appended to the audit trail; the UI is not the authority (D7)                                       | #4141 |

## Activity Log operation families

Each child registers its own operations with `defineActivityLogOperation` next to their emitter; this
ADR fixes only the families, their owners and the body-free field rule. Every field is a count,
closed outcome, digest, SHA or id — never code, finding prose, prompts, model output, paths, pull
request text or user notes (ADR-0173 D4).

| Family                        | Owner issue  |
| ----------------------------- | ------------ |
| `review.target.*`             | #4133        |
| `review.worktree.*`           | #4133        |
| `review.run.*`                | #4135, #4136 |
| `review.counter-check.*`      | #4136        |
| `review.finding.*`            | #4136, #4141 |
| `review.model-policy.*`       | #4137        |
| `review.pair-qualification.*` | #4137        |
| `review.audit-trail.*`        | #4141        |
| `review.counters.*`           | #4141        |
| `review.publication.*`        | #4143        |
| `client.review.*`             | #4140        |

## Consequences

- One contract module (`packages/keiko-contracts/src/pull-request-review.ts`) defines the review
  target, run, finding, counter-check verdict, settlement, finding decision and model-role shapes
  exactly once, with runtime validation, the fingerprint, the eligibility rule and seed scoring.
- The review agent costs model spend on the customer's own gateway; budgets are the existing
  envelope bounds.
- A failed offline gate is a valid outcome that stops the surface work; it is reported with its
  measured counts.
- Adopted PR-Agent text keeps its MIT copyright notice in Keiko's third-party notices.

## References

- Epic #4130; Issues #4131 to #4143
- [ADR-0019](ADR-0019-modular-package-architecture.md), [ADR-0086](ADR-0086-governed-github-pull-request-gateway.md),
  [ADR-0087](ADR-0087-governed-merge-gateway.md), [ADR-0124](ADR-0124-coding-autonomy-modes-and-sidecar-runtime-authority.md),
  [ADR-0125](ADR-0125-governed-agent-docking-and-editor-changesets.md),
  [ADR-0138](ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md),
  [ADR-0173](ADR-0173-server-activity-log-v2-machine-reconstruction-contract.md),
  [ADR-0176](ADR-0176-retire-keiko-for-quality.md)
- PR-Agent v0.49.0 (MIT): `pr_agent/settings/pr_reviewer_prompts.toml`, `pr_agent/settings/configuration.toml`
- Keiko-for-Quality v0.25.0 (retired): `src/publish/marker.ts`, `src/engine/settle.ts`, `corpus/precision-gate-lib.mjs`
