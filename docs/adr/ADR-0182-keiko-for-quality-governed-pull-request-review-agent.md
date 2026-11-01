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

Implemented by Issue #4135 (`packages/keiko-server/src/review/runtime/`): one review instance per
repository is composed on demand by the production coding runtime resolver with the `review` tool
profile, its own orchestrator, private in-memory run snapshots, no Coding History store and a state
root under `<stateDir>/review-runtime/`; it serves one review run at a time and stops after five idle
minutes (the idle stop is re-armed whenever a review releases the repository, including a review
that ended before it reached the instance). Its workspace view names only the review worktree of D3 and is never the user's active
task workspace pointer. Its sidecar reaches the server under `/api/review-sidecar/*`, which serves the
same gateway and tool-facade handlers with the instance's own runtime capabilities. The review agent
is `keiko-reviewer` (`review` is reserved and an OpenCode command), defined in the generated
configuration with Keiko's system prompt (`reviewPrompt.ts`, adapted from PR-Agent v0.49.0) and
pinned as server-owned configuration. The review task carries the rules (from the base commit) and
the diff package as nonce-bound, labelled untrusted data within the runtime's 64 KiB first-prompt
bound; a larger task is refused, never truncated.

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

As implemented (#4135): layer 1 is the `review` tool profile's generated configuration (`*: deny`,
then exactly the four tools allowed, for the configuration and for the review agent, written again
as the server-owned `OPENCODE_CONFIG_CONTENT`); layer 2 is the generated plugin set, exactly the
governed-tools plugin (which registers exactly the four tools) and the context plugin, and the
gateway's `hasExactOpenCodeVisibleToolContract(tools, "review")`, which pins their projected schemas
by digest; layer 3 is the review authority (`workspace-read` alone, `governed-assist`, review
purpose), checked by the tool authority port on every call, whose relaxed planning paths now also
require `workspace-write`; layer 4 is `reviewRuntimeGuard.ts`. Its purpose is the composition's own:
a runtime composed with the `review` tool profile hands every run's tool facade, catalog bridge and
tool bridge the review purpose itself (`composedRuntimePurpose`), never copied from the minted
context, so layer 4 still refuses when the authority of layer 3 is absent or wrong. The tool facade
and, independently, the catalog bridge refuse every action but the three reads and the report. The
tool bridge also refuses its own native transports, which it dispatches before the facade sees a
request: a native read invocation, a V2 permission request (refused, never queued for a human), a
native policy ask and a native web search; a review run reads through the governed facade only.
Each refusal is recorded on `review.run.action-refused` with its `layer` (`tool-facade`,
`catalog-bridge`, `tool-bridge`) and `action`.

The startup self-check (`selfCheck.ts`) refuses with `review-profile-invalid`, `native-profile` or
`authority-missing` (`review.run.profile-refused`) unless: the readiness profile is `review`; the
generated configuration deep-equals the canonical review configuration regenerated for the context
geometry it declares (the only geometry-dependent parts are the provider model limits and the
compaction derived from them), so any added, removed or changed key refuses, including plugins,
commands, skills, references, shell, web search, foreign providers and policies; the plugin set is
exactly the two review plugins, each source matching its pinned SHA-256; the authority a run would
be minted with is `workspace-read` only at `governed-assist` with the review purpose; and the
composed resolver's facade purpose (read from the composition, not from the authority probe) is
`review`. The composition re-checks the configuration and plugin set of every review launch with the
same exact comparisons before they are written. Each layer is proven alone with the others disabled
(`readOnlyLayers.test.ts`), and layer 4 is proven with the review purpose removed from the minted
authority (`composition.test.ts`).

Rejections on the review sidecar routes are logged by the shared handlers with
`runtimePurpose: "review"` (`coding-sidecar.gateway.rejected`, `coding-sidecar.tool-facade.rejected`)
and their diagnostics name the `/api/review-sidecar/*` route, so they are distinguishable from the
Coding Workbench's own. The review task's untrusted data neutralises every `review-data` marker
lookalike, matched after NFKC folding, lowercasing and removal of format characters (fullwidth and
compatibility forms, zero-width and other format characters); only the lookalike's `<` is replaced,
and the data is otherwise kept as it was.

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

As implemented (#4135): `keiko_review_report` is a governed tool of the `review` profile only
(catalog id `keiko.review.report`, effect `workspace-read`), whose arguments are exactly the
`ReviewFindingReport` fields (`REVIEW_FINDING_REPORT_ARGUMENT_SCHEMAS`, every field required at the
tool boundary). The run-bound intake (`findingIntake.ts`) validates each call with
`validateReviewFindingReport`, then against the head commit's objects: every cited path must be a
regular file of the head tree outside the sensitive-path deny list (`path-outside-worktree`), every
range must lie within that blob (`range-invalid`), and the report's location must be backed by
`defect` evidence in the same file whose excerpt is not blank (`evidence-mismatch`). It computes the
fingerprint from the head excerpt, accepts at most eight candidates per run (`limit-reached` after;
each report reserves its slot before it is judged, so concurrent reports never exceed the cap),
answers the model a closed acknowledgement so it can correct a report once, and logs
`review.finding.reported` body-free. The rules reader (`rulesFile.ts`) resolves
`<baseSha>:<path>` through the hardened review runner (`readGitReviewPathObject`): a missing file is
`absent`, more than 16 KiB `too-large`, undecodable or NUL-bearing content `not-utf8`, and a configured
path that cannot name a file in the tree `path-invalid` (each logged as `review.run.rules-file`; all
but `loaded` and `absent` settle `skipped/rules-file-invalid`).

### D5 — Two independent passes

Each candidate finding is counter-checked in its own Keiko-started, read-only session with fresh
context and the Counter-checker model, through the existing read-only child runner generalized to
accept the role's model and to return a structured `CounterCheckVerdict`. The counter-check never
sees the Reviewer's reasoning. A finding reaches the person only if the Counter-checker confirms it
with its own code evidence; refuted and undecided findings are retained in the run record for
measurement and are never shown as findings. Proven by Issue #4136.

As implemented (#4136): the read-only child machinery is generalized, not copied.
`runGovernedReadOnlySession` (`readOnlyChildOrchestrator.ts`) owns the governance of any bounded
read-only session (one gate per tool call: stop, one-layer, read-only class, own ceiling, parent
budget; the first denial latches; a wall-clock deadline aborts the runner; authority is re-checked
after it resolves), and `runReadOnlyHarnessSession` (`productionReadOnlyChildRunner.ts`) runs the
bounded harness session over a caller-supplied catalog, reserved profile and tool port with a
configurable wall time. `keiko_child_agent` keeps its reserved `child@1` profile and behaviour on
the same two functions. The counter-check (`review/counter-check/`) uses its own reserved profile,
`review-counter-check@1` (ADR-0175 D2): `keiko_counter_check_read`, `keiko_counter_check_discover`,
`keiko_counter_check_search` (a fixed-string `git grep -F` over the head commit, `grepGitReviewTree`)
and `keiko_counter_check_verdict`. Every read is served from the Git objects of the reviewed head
commit in the run's review worktree (never a working tree), behind the sensitive-path deny list.
Each candidate gets a fresh session with the Counter-checker model whose only input is the candidate
task: location, category, condition, mechanism, consequence and evidence locations as nonce-bound
untrusted data, never the Reviewer's reasoning, transcript, title, remedy, failure-mode prose or any
other candidate. The verdict tool records the first valid `CounterCheckVerdict` (the server binds
the fingerprint) and ends the session; free text is ignored and a missing or invalid verdict is
`undecided/insufficient-context`. Defaults per candidate: 32 tool calls, 300 seconds (raised from
120 seconds on the offline gate's development set, Issue #4138), 200,000 prompt
tokens, and 1,200,000 prompt tokens for all counter-checks of a run; the harness bound, the tool
ceiling or a refused reservation ends a session `undecided/out-of-budget` and the run
`incomplete/budget-exhausted`, the deadline `incomplete/deadline-exceeded`, a failed or unavailable
model `incomplete/model-failed`. Candidates are checked by severity, then in the Reviewer's order;
candidates left when the run's allowance ran out stay unchecked and make the run incomplete.

The presentation rule is one pure function (`review/service/presentation.ts`): a candidate is
presented only when its verdict is `confirmed`, bound to its own fingerprint, every verdict evidence
range names a readable file of the reviewed head and lies inside it, and at least one range overlaps
the reported location or one of the candidate's own evidence ranges; at most three, by severity,
then Reviewer order. An abandoned run presents nothing. Issue #4141's exclusion is an injected
predicate that defaults to none. The measurement switches (counter-check off, role swap) exist only
on `createReviewEvaluationService`; the product route's request shape is closed and refuses them.

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

As implemented (#4136): one pure function, `settleReviewRun` (`review/service/settlement.ts`), maps
the facts a run collected onto this table; an interruption wins over a cancellation, a cancellation
over everything else, a preparation failure skips the run, and of several incomplete reasons the
most consequential names it (`model-failed`, `budget-exhausted`, `deadline-exceeded`,
`files-unprocessed`). The building blocks' closed refusals map as follows (`mapping.ts`): a target
that moved or no longer resolves (`target-changed`, `not-found`, `ref-invalid`) is
`skipped/target-changed`, a target Keiko cannot fetch (no provider access, no GitHub remote, rate
limit, failed fetch) and every worktree refusal but cancellation `skipped/worktree-failed`; the
review runtime's `rules-file-invalid` is `skipped/rules-file-invalid`, `task-too-large`
`skipped/diff-too-large`, `runtime-unavailable` and a Reviewer run the orchestrator refused
`skipped/model-unavailable`, a failed read-only self-check `skipped/policy-invalid`, and a failed
rules read `abandoned/interrupted`. A Reviewer that fails with an exhausted prompt allowance or
authority budget is `incomplete/budget-exhausted`, with an exhausted envelope duration
`incomplete/deadline-exceeded`, otherwise `incomplete/model-failed`; its candidates are still
counter-checked, and findings confirmed before an incomplete settlement are presented. A Reviewer
runtime run that settled `recovery-required` is such a failed Reviewer, with one exception (#4136):
the orchestrator's `succeededTurnReapUnproven` names a run whose turn settled `succeeded` and whose
settlement stop revoked every authority but could not prove the process tree's exit
(`CodingRuntimeManager.succeededStopReapUnproven`). That is every macOS gateway-profile run, whose end
ADR-0140 D3 leaves unproven because the profile has no sandbox member. That Reviewer's work
finished, so the run settles on its coverage, verdicts and findings like any completed Reviewer
(`complete`, or the incomplete reason they name). A crash, a lost stream, a cancellation, an
exhausted budget or deadline, a missing verification, an incomplete revocation, a disposal or
release failure after a proven reap and every other recovery keep `incomplete/model-failed`. The
runtime stays recovery-required and quarantined exactly as before. The cleanup is a warning beside
the settlement, never a settlement reason: the closed `runtimeCleanup` (`proven`, `unproven`; absent
when no Reviewer run started) on `review.run.settled`, which is written at `warn` whenever it is
`unproven`, on the run record (migration 56, `review_runs.runtime_cleanup`) and as the optional
`runtimeCleanup` of `ReviewRunView` for the review UI. An instance whose orchestrator still holds
such a run would refuse the next start, so the next review of the repository does not reuse it: the
instance is set aside untouched (no early release, acknowledgement or shutdown; it stays quarantined
until its own idle stop, and `release` does not end it) and a fresh instance is composed beside it,
recorded as `placement: beside-quarantined` on `review.run.runtime-started`. One review per
repository at a time still holds. At most one quarantined instance per repository: a review that
would need a second one is refused as `runtime-unavailable` and settles `skipped/model-unavailable`.
The
Reviewer's diff budget is sized so the task always fits the 64 KiB first-prompt bound beside the
largest admitted rules file (the gateway estimator counts at least one token per 3.5 bytes); a
larger task is refused, never truncated. A record that cannot be written (a full disk) settles the
run `abandoned/interrupted` with nothing presented; every run a stopped server left unsettled is
settled `abandoned/interrupted` when the review service is composed at the next start, and child 3's
startup sweep removes its worktree. The stale flag compares the reviewed head with the pull
request's current head from the read-only detail (cached 30 seconds), at settlement and on every
read; it never changes the settlement.

The run records live in the server store (migrations 55 and 56): `review_runs` (one row per run; a partial
unique index allows one unsettled run per repository, and the repository id and client request id
are unique, so a repeated start returns the same run), `review_coverage` (path, list, closed reason)
and `review_findings` (fingerprint, report, verdict, verdict evidence, head anchoring, presented
flag and rank). The routes are `POST /api/git-review/runs` (with `dryRun`), `GET
/api/git-review/runs/{runId}`, `GET /api/git-review/runs?repositoryId=…&pullRequestNumber=…`, `GET
/api/git-review/review-states?repositoryId=…`, `GET /api/git-review/runs/{runId}/diff` (from the
Git objects the run's private refs retain; `objects-unavailable` once the sweep removed them, which
keeps refs a recorded run references), `GET /api/git-review/runs/{runId}/events` (SSE through the
shared flow control: phases and counts only, then one `settled` event) and `POST
/api/git-review/runs/{runId}/cancel`. The start route addresses the repository by the Git window's
selected `root` through the registered-project authority, like every Git read; reads address
records by the content-free repository id.

The review diff package (Issue #4134) is the input to that decision. It is built from the Git
objects of the base and head commits through the hardened review runner (ADR-0098 D8), never from a
working tree, and reports every changed path in exactly one coverage list with a closed reason:
`included` (whole or `partial`), `unprocessed` (`budget`, `too-large`, `timeout`), `deletedOnly`,
`filtered` (`generated`, `lockfile`, `vendored`, `minified`, `review-config-excluded`), `binary`,
`submodule` (never recursed), `symlink` (never followed) and `modeOnly`. Paths are reported
verbatim (exact bytes for a name that is not UTF-8) and never enter the Activity Log. One pure rule,
`reviewDiffCoverageSettlement`, maps the coverage to the settlement: any unprocessed or partial file
is `incomplete/files-unprocessed`; nothing reviewable is `skipped/no-reviewable-changes`, or
`skipped/diff-too-large` when reviewable files were left unprocessed; an exceeded time or byte bound
fails the package closed as `skipped/diff-too-large` (`reviewDiffPackageFailureSettlement`). The
packaging ports PR-Agent v0.49.0: five lines of context before and one after each hunk, extension to
the enclosing function or class header within ten lines (detected by Keiko for TypeScript,
JavaScript, Python, Java, Go, C# and Kotlin, since in-tree attributes are neutralized), files of the
base commit's dominant languages first and larger changes first, and `clip`, which in Keiko keeps
whole hunks only. The included content never exceeds the reviewer budget as the gateway's estimator
counts it. PR-Agent applies its extra lines on top of the provider's three default context lines;
Keiko applies the five and one exactly, and child 8 measurement may change these defaults.

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
as qualified. Keiko prescribes no pair. Keiko's reference lab (Apple M4 Max, 128 GB) runs
`gemma-4-31b-it` as Reviewer and `qwen3.6-35b-a3b-8bit` as Counter-checker through the local
LiteLLM gateway; together they need about 69 GB. On a 64 GB machine this delivery measures
`qwen3.6-35b-a3b-4bit` (MLX 4-bit mixture-of-experts, about 19 GB) as Reviewer and
`gemma-4-31b-it-4bit` (MLX 4-bit dense, about 17 GB) as Counter-checker, which stay resident
together: the faster model takes the tool-call-heavy Reviewer role and a model of a different
family checks it. Results belong to the exact pair measured. Proven by Issue #4137.

As implemented (#4137): policy resolution is strictest first. (1) The operator's `review` section of
`keiko.config.json` (`enabled`, `reviewerModelId`, `counterCheckerModelId`, `allowedReviewModelIds`,
`lockModelPolicy`, `rulesFilePath`, `repositories.<repositoryId>.rulesFilePath`), parsed by the gateway
configuration loader (`parseReviewOperatorConfig`) with the `KEIKO_REVIEW_*` environment overrides;
it never fails the gateway load. Every invalid explicit value (a wrong type, an unsafe id or path, a
default outside the allowlist, an unknown key) is a closed issue: the policy then refuses every role
with `invalid-operator-value`, never substitutes another model, and reports each issue at startup by
key and source (`review.model-policy.refused`, stage `startup`). Gateway setup keeps the section
verbatim, invalid values included. (2) The user's per-repository selection in a versioned settings
document (`<stateDir>/review-settings/<repositoryId>.json`, revision + 1 per saved change, published
with `atomicPublishRename`), only inside the allowlist and never while locked. (3) The recommendation:
the eligible model with the largest verified window for the Reviewer, then a different eligible model
for the Counter-checker, else the same model with `singleModel: true`. A lock makes the operator
defaults (or the recommendation) the only admissible pair; the resolved policy stays readable.
Quality Intelligence and review share one role-policy helper (`modelRolePolicy/`: the "different
second model" pick, the role preflight and the atomic document store); Quality Intelligence behaves
as before. The same policy check runs in front of child 6's eligibility at every run start and dry
run (`ReviewModelPort.admit`; a refused dry run answers 422 and a refused run settles `skipped/policy-invalid`), at every pair qualification
and before every settings write, which also preflights both resulting roles. A busy model stays
eligible; the gateway keeps no separate busy flag today, so no `busy` hint is shown yet.

`GET /api/git-review/model-policy?repositoryId=…` is a read view (roles with their sources, lock and
allowlist state, every configured chat model with its capability summary, the pair status);
`GET`/`PUT /api/git-review/settings?repositoryId=…` read and write the settings document, whose
`rulesFilePath` (default `.keiko/review-rules.md`, portable, repository-relative, no `.`/`..`
segment) child 5's rules reader reads through its settings port; while locked, the operator preset
wins. Checking a pair without saving is the run start's `dryRun`. The operator's `enabled` switch
(default `false` until Issue #4142) guards the whole `/api/git-review/*` route group: every route
except `model-policy` answers 404 `REVIEW_DISABLED`, and `model-policy` answers `enabled: false`.

The pair status is in-process state bound to the exact Reviewer model, Counter-checker model and
gateway configuration generation it was recorded under; a different model in either role, a
configuration change that advances the generation, or a server restart reads `unmeasured` until that
pair is qualified again. `POST /api/git-review/pair-qualifications` runs the shipped synthetic corpus
(Issue #4132) through the real review run service: each case becomes a two-commit Git repository
under `<stateDir>/review-qualification/<id>/` (hardened review runner, repository-local identity),
reviewed as a `local-range` target under the qualification's correlation and removed afterwards;
the results are scored with `scoreReviewSeedRun`. `seed-qualified` needs every required seed found;
one missed required seed is `seed-failed` with the missed seed classes; a cancellation, the
three-hour deadline or an unscored case ends `cancelled` or `incomplete` and records no status. One
qualification runs at a time; progress streams over the shared SSE helper; leftovers are swept at
start.

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

The offline gate runs through the root-level evaluation composition `tests/review-quality/`
(`npm run review:quality-gate`), because the server may not import `keiko-evaluations` and
`keiko-evaluations` may not import the server. It starts the real server composition the way the
dev BFF does (`buildUiHandlerDeps` and `createUiServer` on loopback, with the operator's gateway
configuration) and supplies the evaluation family's replay and seed ports, which run one review at
a time through the composed review service. The measurement switches reach that service only
through the `reviewEvaluationSwitches` option of `buildUiHandlerDeps`, which only this composition
passes: no CLI flag, environment variable or configuration key sets it, so a product server always
composes `createReviewRunService`. Each run records its configuration digest over the committed
review code, the counter-check and presentation limits, the variant and the pair, and refuses to
start on uncommitted review code. Cost per role comes from each review's own record: the
counter-checker's tokens from its model calls, the Reviewer's prompt and completion tokens from the
review runtime's effort roll-up, which counts provider-reported counts only (an estimated output size
is never counted). The holdout run needs an explicit confirmation flag. Results and the iteration
log are in `docs/qa/review-agent-offline-gate-<date>.md`.

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
| `review.finding.*`            | #4135, #4136, #4141 |
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
