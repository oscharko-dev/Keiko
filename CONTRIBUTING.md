# Contributing to Keiko

Keiko is built to a production-ready, enterprise quality bar: strict TypeScript (no `any`), tested behavior,
minimal runtime dependencies, and reviewable, evidence-backed changes. The architecture and release constraints
are recorded in the [Architecture Decision Records](docs/adr/); read the current decisions before opening a pull request.
Working, clean, secure, verified code is authoritative. ADRs are architectural guardrails and
memory, not executable truth: if a repair exposes outdated, contradictory, or unsafe ADR text, fix
the code and update the affected ADR sections together. Do not preserve a defect merely because an
ADR recorded it, and do not create a new ADR merely to correct existing text.

## Local development

```bash
npm install                # install all workspaces from the single root lockfile
npm run provision:usearch  # ONCE per checkout — see AGENTS.md §2
npm run build              # compile TypeScript outputs
npm run typecheck          # strict type-checking for src + tests
npm run lint               # ESLint, zero-warning policy
npm run format:check       # Prettier check
npm test                   # run the unit test suite
npm run arch:check         # dependency-cruiser + import-policy + contract-boundaries
npm run arch:check:negative
```

See [AGENTS.md §3](AGENTS.md) for the full local gate loop and the touched-area gate table.

### Activity Log runtime changes

Production runtime behavior extends the existing Activity Log; it never creates a second logger,
event store, analyzer, or incident subsystem. Register every operation through the canonical typed
APIs in `keiko-contracts` and emit only the registration-derived event shape. The checked-in
`docs/observability/op-catalog.generated.json` is generated from those canonical declarations and
emitters. Its typed registry is authoritative; the legacy literal scan is migration input only.
Adapters rebind events with `withActivityLogCorrelation` or `withActivityLogParentCorrelation`,
preserving producer-owned ids and the non-enumerable registration/rejection markers. Test the
forwarded event through the real registered formatter: a buffer alone cannot detect a marker
lost by an object spread.

Each registration owns exact fields, bounds, data classes and vocabularies, causal and lifecycle
semantics, analyzer projection, failure classes, proof ids, and release impact. Unknown or dynamic
operations, arbitrary metadata, nested objects, missing required fields, unbounded strings, and
unknown error/loss states fail closed. Persisted v2 records also require the sink-owned version and
digest dimensions, compatibility/writer state, and complete `(pid, instanceId, seq)` identity.
Tests for changed behavior assert the emitted line and the support-analyzer projection. Regenerate
the catalog with `npm run generate:op-catalog`, then run `npm run check:activity-log`, the Activity
Log implementation gate, which required CI runs unchanged. Every run builds the packages and
evaluates the complete registered inventory by composing `check:op-catalog`,
`test:activity-log-scenarios` (the curated end-to-end scenario matrix), `check:error-observability`,
`arch:check`, `arch:check:negative`, and `check:release-impact`; it takes no changed-file input, so
a narrower change set never narrows what it proves.

`client.citation.activated` records a citation click and its source selection under the
activation correlation. `reason` describes the source fingerprint: `matched` (one root),
`unmatched`, `absent`, `malformed`, or `ambiguous` (several matches). `outcome` records
`opened`, `open-refused`, `picker-opened`, `picker-dismissed`, or `refused`; an opened picker
is not a successfully opened file. `rootCount` and `matchCount` explain the choice without
recording the fingerprint, file path, source label or citation text. The registered server
projection retains these closed fields on the existing Activity Log timeline.

`client.coding-run.restored` records, once per distinct restoration, how the Workbench rebuilt a
settled coding run's conversation from Coding History after a reload, under the run's own id (the
correlation its `coding-runtime.history` lines carry). The timeline carries the newest messages the
safe-activity contract's bounds admit (`timelineCount`, `turnCount`, `feedBytes`); every older
message the feed cannot carry stays in the transcript, whole (`transcriptCount`,
`transcriptChars`), so no message of the run is shown in neither place. The restoration reads the
run's messages from the newest end and only as far as the feed can still hold them; everything
older is named for the transcript by position and never examined. `cutCount` counts timeline
messages cut to the per-message bound and `historyTruncated` says Coding History itself cut the
task's messages: only those two leave text shown nowhere, so only they make the page say "Activity
truncated.". Counts only — never a message, path or run name.

`chat.scope.update` records a serialized source update as `applied` or `conflict` under the
request correlation, with optional `expectedScopeDigest`, required `actualScopeDigest` and
`resultScopeDigest`, and connected/local-knowledge/Git-change source counts. Send and PATCH
validate a supplied `expectedGroundingScopeIdentity` against the current server-issued identity;
a stale identity returns 409 `GROUNDING_SCOPE_CHANGED`. Git-change description authority is
checked separately, and ordinary regeneration refuses connected folder, knowledge and Git-change
scopes with 409 `NOT_APPLIABLE`. See ADR-0057 for the identity and admission boundaries.

Connected-folder retrieval joins `search.connected-context.source-details`, `selection-details`,
`completion-details`, and `answer-details` with the completed operation under the same request
correlation, process, and source/query digests. These typed siblings retain the existing contextual
field cap. Source details describe actual path/reference admission and eligibility; selection
details describe calibrated floors, high/low confidence, addressed-file demotion, reranker
disposition, continuity counts, and worktree/semantic freshness observations. Assembled reads and
final sent evidence are distinct: `answer-details.filesInPrompt` describes what reached synthesis.
Only counts, closed dispositions and digests enter the log, never paths, declarations or answers.
The six-reference intake preserves the primary local trace frame and explicitly named question
paths before secondary frames or conversation referents. Prompt fitting preserves a complete
matching line when it fits the remaining UTF-8 byte grant, rebinding source ranges and stable
identities before citation reconciliation. Physical reads remain actual I/O counts: import
classification and parsing share one complete guarded source read rather than charging another
classification read. Existing final-prompt, range and read observations describe these decisions
without recording source text or paths.
Endpoint definition traversal binds a registration's observed handler reference to its current
lexical AST target. Further calls retain their exact callable owner and complete observed spans;
same-named declarations and uninvoked nested functions do not certify that relationship.
Imported targets retain exact runtime module-export identities. Explicit compiler output mappings
reuse already guarded metadata and can address only admitted sources in the owning package.
Structural AST, import, symbol, endpoint and source/test intake honor the actual caller file
ceiling. A null ceiling uses the finite admitted candidate inventory, including resolver metadata
reservation and request-local current-source metadata capacity. Finite enrichment grants and
bounded complete-text reuse retain their separate limits.
Unreadable or partially observed re-export branches retain uncertainty; missing indexed exports
cannot certify a unique runtime target when a competing branch is unobserved.
A guarded current definition reached through an observed inline-callable reference retains its
definition evidence and a resolved reference edge. Declaration priority does not certify callback
invocation; continuation retains that reference relationship and `source-graph-incomplete`.
Partially overlapping excerpt windows retain uncovered lines and their originating strength;
deduplication removes only lines already covered by a higher-priority window.
Physical excerpt allocation admits complete selected, current definition branches whose additional
observed body bytes fit the connected share. Independent roots and files within each root take
turns; existing query relevance orders targets within each file and sets initial file order, with
stable ties. Shared ancestors reserve bytes once, later same-file targets remain
eligible, and an oversized branch spends no partial reservation. Explicit human selections remain
first, and ordinary ranked evidence retains its share of the existing grant. Reserved definition
windows precede ordinary extras; their actual returned physical-view identities prevent adjacent
windows from introducing uncharged bytes during assembly. Bounded observations do not establish
that an arbitrarily large function was fully read. File and deadline grants, current-source checks,
invocation uncertainty and actual truncation/omission reporting remain authoritative.
Existing query evidence orders endpoint intake; bounded delegation traversal keeps the original
workspace authority and budgets. Pack uncertainty retains closed omission reasons; existing
Activity Log uncertainty, physical-read and final-prompt counts describe the observed result.

`search.connected-context.answer-details` records answer kind, observed citation behaviour,
declaration counts, repair disposition, and actual follow-up trigger, pass/admission counts,
outcome and configuration disposition. Technical failures retain the existing closed error header,
reduced frames and causes. Initial synthesis, marker repair, follow-up and their gateway transport or
context-window retries share at most two physical adapter attempts and the original cumulative
input/output and remaining elapsed grants. Admission occurs before each actual dispatch and spend
reservation. Charged input retains the greater of the canonical sent prompt estimate and reported
usage; measured partial output survives a discarded attempt, while uncertain failed stream output
retains its requested cap. These conservative charges are distinct from provider-measured usage.
Unrelated gateway retries and separately bounded entailment/embedding stages retain their existing
contracts without supplying another synthesis attempt. Normalized output is buffered before
publication; rejected declarations cannot escape through streamed chunks. The existing allocator's
high/exceeded pressure refuses follow-up. `KEIKO_CONNECTED_FOLLOW_UP_PASSES_MAX` defaults to `1`;
explicit `0` disables it, and other explicit values fail closed to zero passes with an invalid
configuration observation. See [ADR-0180](docs/adr/ADR-0180-bounded-connected-folder-follow-up.md).

Support analysis joins these siblings rather than assuming every metric appears on the completed
line. An answered follow-up disposes the initial unread declaration for its original source and
logical turn even if the selection fingerprint changes. Missing historical fields remain unknown.
Healthy lexical answers do not become retrieval misses because semantic search is unconfigured.
Optional live semantic refresh separately requires `KEIKO_REPO_SEMANTIC_REFRESH_FILES_MAX`; its
default is `0`, its enabled cap is eight safe fragments, and it never mutates a persisted pod.

Chat context selection emits `chat.context.selected` before the provider call for buffered,
streaming and regenerated turns. Its request correlation joins the compacted/retained history
counts, estimated removed-prefix and summary costs, savings, final estimated prompt cost,
effective input budget and image reserve. This evidence survives generation timeout or
cancellation; the successful-turn compaction manifest remains separate. These are local estimates,
not provider-measured usage, and no conversation or image content is recorded.

Gateway admission additionally records `imageCount`, the selected `imageAccounting` rule,
`imageReserveTokens`, `localPromptTokens`, `fallbackPromptTokens`, and, when present,
`reportedPromptTokens` plus schema-adjusted `providerPromptTokens`. A positive reported count
replaces the image reserve even when the local text/tool/schema floor determines the final total;
a zero count retains the reserve. The recorded candidates make those decisions distinguishable.

Circuit admission that cannot fit a caller's remaining budget emits `gateway.circuit.wait` with
`budget-refused`, `remainingMs` and `delayMs`; it does not fabricate a provider attempt or retry.
Parallel retryable responses may extend the recovery minimum of the same open outage, while probe
ownership and later circuit generations remain protected. Unchanged admission state does not wake
every waiting caller.

On retries, `reportedPromptTokens` always describes only the current counter response and is
absent when that response has no count. `providerPromptTokens` adds the current response-schema
cost to that raw count; `retainedPromptTokens` separately records the carried measurement floor
plus schema cost. Admission preserves the maximum of local, current-provider and retained
candidates. `counterSource` identifies a winning retained floor as `retained-measurement`, and
`imageAccounting` uses that disposition when only the retained positive measurement replaces the
image reserve. Neither retained value is presented as a new provider observation.

A chat model whose window nobody declared is planned as `contextWindowAssumed` until the provider
states it. `gateway.context-window.probe` records the one-per-deployment window probe (`reported`,
`not-reported`, `failed`, `skipped-spend-budget`) under its own correlation joined by
`parentCorrelationId` to the reading that spawned it. `gateway.context-window.adoption` records the
adopted window with its source (`window-probe`, `provider-overflow`), the previous window and
whether it was assumed, or `stale-deployment` when the stating deployment was replaced.
`gateway.context-window.retry` records the single re-planned retry of an admitted turn, with its
surface and the planned and adopted windows. All three carry a correlation id and a model digest,
never provider text.
`search.prompt.window-fitted` records a Knowledge Pod answer prompt that dropped trailing references
to fit the model (`trimmed`) or could not fit a single one (`refused`), with the reference counts,
the prompt size and the input budget.
`client.knowledge-catalog.unavailable` records the six counts of a Knowledge Pod picker that offered
no usable pod (pods, ready pods, sets, bound, missing, not ready), never a name, path or id.
`search.citations.reconciled` records numeric-reference and file-location reconciliation for
Knowledge Pod, connected-folder, multi-source and hybrid answers under the request correlation.
`citationKind` distinguishes `numeric` from `file`; hybrid answers may emit one line of each kind.
The closed outcome (`cited`, `cited-with-dangling`, `dangling-only`, `uncited`, `refusal`) and
reference, attached and dangling counts describe the actual reconciliation. File lines also carry
ambiguous-marker and dropped-implicit counts. Weak-overlap and grouped-marker counts are optional:
absence means they were not measured on that path, not zero. `gateway.discovery.alias-intersection` carries
the `role` discovery gave each alias (`chat`, `embedding`, `voice`, `rerank`, `unsupported`), and
`gateway.reranker.setup.resolved` records once per committed setup whether a discovered reranker was
`wired`, `kept-existing` or `probe-failed` (at `warn`, with a diagnostic), with candidate and probe
counts. The `inspected` `chat.context.management` line also carries the meter reading's optional
counts: stored and projected history, knowledge-source tokens, the sent and available reference
counts, the last knowledge request (measured and estimated), the system, summary and message shares,
the automatic-compaction trigger, and the assumed-window and pending-probe flags. Grounded
readings also carry the conversation lane budget and unused source capacity separately; a
conversation checkpoint is validated against that lane, not against the entire model window.
`search.entailment.judged` records, per grounded answer the judge read, the judged, unsupported and
undecided claim counts, so the displayed "N unsupported claims" is reconstructable, and
`hiddenProseClaimCount` counts the claims it could not judge because bracketed prose was stripped.
`search.citations.support-settled` records the settled caveat of a Knowledge Pod answer (`none`,
`judge-undecided`, `no-judge`, `unjudged-citation`) with its weak-citation and hidden-claim counts. The multi-source
prompt reports a trim or refusal on `search.prompt.window-fitted` like the Knowledge Pod and hybrid
prompts. `client.answer.copied` records each chat answer copy (`copied` or `failed` at `warn` with
its error kind and frames), whether the answer was grounded, and how many marker groups the copy
removed and kept, never the copied text. `client.answer.speech-prepared` records the same counts
for an answer read aloud in the voice dialogue, under the correlation its synthesis request carries.
`search.answer.assessed` records whether a connected answer carried Keiko's own, labelled
assessment (`none`, `assessment`, `assessment-only`, `neutralized`), under which operator policy
(`allowed`, `disabled`), and the character sizes of the source-backed part and the assessment.
Source-linked observations carry canonical scope/query digests and `phase` (`candidate`,
`accepted-final`); only accepted-final observations describe the delivered answer. Candidate or
unbound historical observations cannot suppress retrieval-miss findings.
A model turn's reasoning share is counts only (#3878): `chat.response.streamed` records the
provider events that carried `reasoning_content` and their bytes (`reasoningEvents`,
`reasoningBytes`); `gateway.chat.completed` and `gateway.stream.completed` record `reasoningBytes`,
the provider-reported `reasoningTokens` (absent when not reported, never estimated) and
`reasoningDisposition` (`none`, `forwarded`, `discarded`); `coding-sidecar.gateway.usage-settled`
records `contentBytes`, `reasoningBytes` and `reasoningTokens` beside `outputBytes`;
`coding-sidecar.gateway.outcome` records the `reasoningFrames` and `forwardedReasoningBytes`
forwarded to the coding runtime, `reasoningWithheld` for a buffered answer delivered without its
oversized reasoning, and on an `output-limit` turn the bound that ended it (`limit`: `answer`,
`reasoning`); and `coding-runtime.history-projection` the `reasoningSignalCount` a history read
prepared for the timeline. OpenCode persists a streamed text or reasoning part only empty and then
complete, so the timeline grows from the runtime's delta events: the same line counts, since its
previous line, the deltas that grew a live part (`liveDeltaCount`), the ones that extended nothing
(`liveDroppedCount`), the parts whose complete text did not extend what was shown
(`liveDivergedCount`) and the events folded into earlier history reads (`mergedEventCount`). The
reasoning text never enters the Activity Log, a support export, run evidence or Coding History.
A model answer that exhausted its output budget, or ended after reasoning, without a tool call or a
final answer gets one steered repair from the gateway on a call that asks for it with the explicit
`answerRepair: "steered"` (the coding sidecar route alone; #3873, F17, F23), and the log records it
in closed words only: `gateway.retry.scheduled` names it with `reason=output-exhausted-repair` or
`reason=empty-answer-repair` (`retryable-error` on every ordinary retry), and
`coding-sidecar.gateway.outcome` and `coding-sidecar.gateway.turn-failed` record `repairAttempted`
and, when a repair ran, `repairOutcome` (`recovered`, `exhausted-again`, `empty-again`, `failed`,
naming how the repaired attempt ended) — a line written before the gateway call settled (a byte cut,
a cancellation) omits both, because it cannot know; a repaired turn that failed the same way again
is final for the coding runtime (`runtimeRetry=refused`). The provider usage of the attempts a call
discarded (a repair's first answer, a rejected tool call) counts against the run's prompt
allowance, and `coding-sidecar.gateway.usage-settled` names it (`discardedAttemptCount`,
`discardedPromptTokens`, `discardedCompletionTokens`). The correction the model receives is one fixed
sentence, and the failed answer's reasoning is never recorded. Prior reasoning is never resent
upstream: the coding sidecar drops the reasoning fields of prior assistant messages and every
assistant message that carries nothing but reasoning, and `coding-sidecar.gateway.request-validated`
records the number dropped as `droppedReasoningMessageCount`. The gateway hands reasoning only to a
call that asks for it with the explicit `reasoningDelivery: "forward"` (the coding sidecar route
alone); the `coding-workbench` latency profile selects timeout floors only.

Commit drafts record model-context bounds, compaction, generation count and reuse as counts and
flags on `git.commit.draft.completed`. The same event carries body-free normalization version/rule and bullet, trailer, continuation and marker counts for generated and reused drafts. Each attempted generation also records its own result and normalization on `git.commit.draft.attempt.completed`, so a later repair cannot erase earlier evidence; stream startup retries use the existing `gateway.retry.*`
events. Neither path records customer diffs or generated text.

Closed failure outcomes and positive failure counters that would otherwise be optional context must
be declared with the owning operation's exact `diagnosticWhen` condition. Regression proofs exercise
the actual producer, registered writer and incident query with zero optional context, alongside
healthy controls; ordinary file eligibility exclusions and budget limits are not failures.

All repository-add lifecycle join ids, including discarded settlements, must pass the canonical Activity Log correlation guard. Browser delivery-loss counts enter the shared ledger once after rate admission and before routine diversion. Rate-limited reports carrying loss return 429 so the browser restores their counters for later admission; their server-owned drop must not be counted again as a failed POST. Final pagehide loss reports have their own bounded server budget, independent of routine/failure traffic. Gateway streams settle circuit/spend state, close provider iterators and emit completion before yielding done, since production consumers need not advance again. Commit-draft refusals retain measured prompt bounds and generated/reused outcomes share a body-free key digest.
Repository-add dialogs report the attempt and its live or discarded settlement using the request's
correlation id. Test effect replay under React StrictMode separately from an actual dismissal:
only the latter may discard a response.

The generated registry also publishes the stable implementation-obligation categories and the
failure-class coverage matrix consumed by permanent quality gates. Its release expectation is
100% complete. Exemptions are not comments or wildcards: the sole registry exemption contract is
limited to one registered operation/failure-class pair and requires the operation's owning package
as owner, a technical reason, a linked tracking issue, an unavoidable platform or durability
boundary, and an expiry at most 180 days ahead. It cannot permit unknown fields, prohibited data,
silent loss, or incomplete evidence.

Keep this contract converged in one change. The writer, segmented store, and reader engine belong to
`@oscharko-dev/keiko-activity-log`, which depends only on contracts and security; server and CLI
compose it while domain packages continue to use injected ports (ADR-0179). A runtime change that
affects Activity Log behavior updates the owning implementation, its failure-first regression,
emitted-line and analyzer/replay proof, ADR-0173, ADR-0179, AGENTS.md, this contributor contract,
and directly affected operator documentation as applicable. Saved support reports remain local artifacts
created by an explicit user action. CLI exports enforce owner-private file permissions. Desktop
exports use the browser's configured download destination and filesystem permissions; the browser
may save directly to Downloads without showing a destination picker. This owner-approved desktop
workflow does not claim the CLI's permission guarantees.
publishing or attaching one to GitHub or another external system requires separate explicit user
authority and is never part of logging or export.

Activity Log storage must remain bounded on every intermediate change. The Activity Log is stored as
immutable segments in `<stateDir>/logs/` (ADR-0173 D14). Each process appends only to its own active
segment, sealed segments are read-only, and retention bounds every segment and legacy file by bytes
and age, so total use stays within the byte budget plus the pin quota. Filesystem mutation is
limited to verified owner-private, non-redirected directories and opened regular owner-matched
targets, and only on names in the closed grammar of `keiko-contracts` `activity-log-files.ts`.
Publication never replaces an existing name; rename is permitted only when the filesystem reports
hard links unsupported. Any successor storage design must replace this bound atomically rather than
remove it first.

## Pull requests

All required status checks must pass on the current pull-request head before a change can merge into
`dev`. The stable app-bound set is the ten checks below:

1. `ci`
2. `workflow hygiene`
3. `Analyze (actions)`
4. `Analyze (javascript-typescript)`
5. `Build, scan, SBOM, smoke`
6. `Review dependency diff (dev/main)`
7. `ui`
8. `SonarCloud Code Analysis`
9. `Socket Security: Project Report`
10. `Socket Security: Pull Request Alerts`

`workflow hygiene` runs actionlint, the pinned-SHA verification, zizmor and the OSV lockfile scan as
one context (ADR-0159); the tools, pinned versions and rule sets are unchanged. It also runs the
repository-owned `check:zizmor-anchors` ahead of zizmor, so a line anchor that drifted out of
`.github/zizmor.yml` reports as itself rather than as the finding it silently stopped suppressing. The hosted contexts
and their bounded zero-cost eligibility are recorded in
[`docs/qa/external-quality-gates.md`](docs/qa/external-quality-gates.md).

The required matrix measures a change once. `dev` is protected with linear history and signed
squash merges of up-to-date heads, so the integration commit carries a new sha and the identical
tree sha as the pull-request head the matrix already proved green. The `dev` run resolves that
before any gate starts and reuses that verdict rather than re-measuring identical bytes
([ADR-0178](docs/adr/ADR-0178-reuse-proven-tree-evidence-on-integration-runs.md)). Reuse requires
the merge commit to be that pull request's exact `merge_commit_sha`, the trees to match, a completed
successful `pull_request` run on that head, and that run to have executed every skipped job; any
other outcome runs the full matrix, and the `ci` aggregate still fails closed. The coverage suites
and the SonarCloud analysis are never reused on `dev`: they run on every push to `dev` so that
SonarCloud's branch history stays current (ADR-0178 D1, amended 2026-09-25). Editing a workflow
changes the tree, so CI changes always measure themselves.

Only the repository owner account `oscharko` may authorize and execute a merge into `dev`, including
enabling GitHub native auto-merge. Agents acting under that account operate within the owner's
explicit authorization. Contributors may prepare PRs and repair findings, but accepting their task
does not grant integration authority. No additional approving review is required, so owner-authored
PRs remain possible. Required checks must succeed on the exact current head and every review
conversation must be resolved before integration. Only `oscharko` may dismiss blocking reviews;
approvals become stale when the reviewed changes change. These restrictions are scoped to `dev`.
CodeRabbit reviews every pull request targeting `dev` and every subsequent push with no
auto-pause. Its status is not required because quota can omit a current-head review. When CodeRabbit
does emit an inline finding, GitHub's required conversation-resolution rule blocks merge until its
conversation is resolved. Policy additionally requires the underlying defect to be repaired; the
quota-tolerant interim topology cannot infer code repair merely from GitHub's resolved bit.

`.github/CODEOWNERS` intentionally stays a single flat `* @oscharko` rule while Keiko has one
maintainer. Required code-owner reviews remain disabled to avoid blocking owner-authored PRs;
the owner-only branch restriction controls who may integrate into `dev`. Revisit
path-scoped rows if/when a second maintainer joins.

The hosted performance dashboard and quota-paced reviewer evaluated in ADR-0169 are retired.
Neither has repository configuration, an installed App, a workflow, or a protected context.
Deterministic bundle, latency, retrieval, and performance gates inside `ci` retain merge authority.
No payment method, finding dismissal, or gate bypass is an accepted repair path.

Keiko for Quality is retired by
[ADR-0176](docs/adr/ADR-0176-retire-keiko-for-quality.md). It has no workflow, review profile,
repository variable, credential consumer, or protected context in this repository. Its product is
being rebuilt inside Keiko itself; until that ships, no model-backed reviewer runs on a pull
request here.

Qodo is retired by
[ADR-0167](docs/adr/ADR-0167-zero-cost-autonomous-quality-gates.md); it is not Sonar evidence.
Sonar remains independently enforced by its native required check and the exact-head validator
inside `ci`. Full mutation runs daily/on demand and reference-machine performance evidence runs
outside the pull-request critical path. Fast semantic-duplication, secret, coverage, static-analysis,
and deterministic performance proxies run in parallel on pull requests. Thresholds and operational details are
in [`docs/qa/autonomous-quality-gates.md`](docs/qa/autonomous-quality-gates.md) and
[`docs/qa/external-quality-gates.md`](docs/qa/external-quality-gates.md).

The rationale for the package architecture, workspace gate, bundled publish model, and 0.2.0 baseline is recorded in
[ADR-0019](docs/adr/ADR-0019-modular-package-architecture.md),
[ADR-0020](docs/adr/ADR-0020-workspace-tooling-and-architecture-gate.md),
[ADR-0021](docs/adr/ADR-0021-publish-strategy-bundled-monorepo-product.md), and
[ADR-0025](docs/adr/ADR-0025-forward-only-0-2-0-modular-baseline.md).

UI-facing features must use the existing i18n API instead of hard-coded user-visible strings, and every UI change
must update both `packages/keiko-ui/src/lib/i18n-messages.en.ts` and
`packages/keiko-ui/src/lib/i18n-messages.de.ts` with matching keys. Pull request CI runs
`npm run check:ui-i18n` to enforce this guard before review and merge.

Published release notes live in GitHub Releases. This repository intentionally does not maintain a root `CHANGELOG.md`.

## Troubleshooting documentation

Operator-facing failure modes live in [`docs/troubleshooting/README.md`](docs/troubleshooting/README.md).
When adding a new entry, copy [`docs/troubleshooting/_template.md`](docs/troubleshooting/_template.md)
and follow the **Symptom**, **Root Cause**, **Diagnostic Steps**, and
**Resolution** structure. Do not include API keys, customer data,
internal endpoints, or unredacted log lines in examples.

## Coding mode availability

The owner decision of 2026-09-27 exposes all three Coding Workbench modes on a normal installation
without extra configuration (ADR-0124 D2, ADR-0163 D7). The default selected mode remains Ask for
approval. Explicit narrower deployment ceilings and every mode-independent denial remain enforced.
Do not propagate Coding's availability default to Memory: its absent-configuration ceiling stays
`governed-assist` for capture, policy projection and maintenance. Regression coverage must exercise
both production composition and these consumers when changing this wiring.

## Support reports

For local defect evidence, use `keiko support export --incident <id>` or a correlation selector.
Manual UI and CLI export remain available when all retained incident slots are occupied: the
canonical exporter can use a transient descriptor without stealing in-flight reservations or
widening retention. Completed candidates may roll over at byte pressure; in-flight reservations
remain protected. Exporting stored server evidence requires an authenticated app session.
Confirming a valid session refreshes its scoped cookies using the same bearer; it neither mints
authority nor extends registry expiry. An unpaired or offline browser can still create and download
a limited report from validated body-free client failure facts, without accessing stored server
evidence.
The canonical owner-private report has embedded integrity, a 10 MiB hard ceiling (`--max-bytes`
may only lower it) and explicit sufficiency. `--out` names a private directory, never a file; the
filename always uses the fixed product/schema/incident/date class. Inclusion flags and raw-log or
legacy bundle input are refused. Validate a manually received file offline with
`keiko support analyze FILE --json` before agents use its machine view. New reports use artifact-local
ordinal references: the UI Support ID is only a local export/query selector. For a received report,
select `incident.correlation.rootCorrelationId` or an exported timeline reference from the unfiltered
analysis before using `--correlation-id`; no original-to-exported mapping is included. Follow
[the support workspace guide](docs/observability/support-workspace.md). Nothing is sent by these
commands. `npm run set-version` regenerates the historical registry snapshots the analyzer selects
from, so a release needs no extra step.

## Files and Editor navigation

Explicit folder selections in the New Window dialog and Editor root picker preserve
the selected root through the existing `coding-repository` presentation binding.
The same behavior applies to Git repositories and ordinary folders. Task-bound
windows retain the active workspace projection and allow navigation within it;
explicit repository Files windows also allow path changes. Back/Forward history is
bounded and clears on task-bound root switches. Files titles reflect their resolved
root; an empty Editor names its project. Navigation and directory reads record
body-free client stage lifecycle evidence on the existing Activity Log.

The ordinary Editor is human-operated. The owner decision of 2026-10-03 retires its agent
presence/history, incoming actions, selection-to-chat handoff and Chat **Apply to editor** command.
Keep the existing manual edit/save/format/history flow and content-free dirty-buffer protection.
Safety-state publication does not grant an agent a live bridge or an executable Editor session.
Chat repository search and the separate Coding Workbench keep their own existing behavior; shared
runtime code still used by those consumers is not part of this retirement. See
[ADR-0061](docs/adr/ADR-0061-browser-editor-agent-bridge.md).
